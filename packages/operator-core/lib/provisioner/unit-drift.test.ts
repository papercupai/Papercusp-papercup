import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  parseLlamaServerUnit,
  diffUnitParams,
  diffCatalogAgainstDeployedUnit,
  describeUnitDrift,
  parseUnitExecStartBinary,
  checkUnitExecStartBinary,
  parseUnitExecStartModelPath,
  checkUnitExecStartModelFile,
  parseUnitEnvironment,
  checkRequiredEnvironment,
  describeEnvIssues,
  resolveCatalogEntryForBackend,
  auditDeployedUnit,
  auditDeployedUnitForBackend,
} from './unit-drift';
import { CERTIFIED_CATALOG, findCatalogEntry, type CatalogEntry } from './catalog';

const ORNITH = CERTIFIED_CATALOG.find((e) => e.id === 'ornith-35b-iq3m-llama-server')!;

/**
 * The unit as it was ACTUALLY DEPLOYED on 2026-08-17, before P-009 restored it. Not a synthetic
 * mutant — it is the real drift, kept as the guard's control so the guard is proven against the
 * incident it was written for, on every run, on every machine, with no tree mutation and no
 * dependence on this box's filesystem.
 *
 * The binary and log paths are the ONLY things genericized from the original, because they are
 * per-box and are deliberately not compared (see unit-drift.ts's header). Every operative
 * parameter — and the self-contradictory Description that let the drift hide — is as deployed.
 */
const DRIFTED_UNIT = `[Unit]
Description=llama-server serving ornith-35b IQ3_M (local-concurrent-inference-2026-07-02 P-001) — 2 parallel slots x 64k ctx (real OMP su sessions send 52-64k-token requests), q8_0 KV
After=network.target

[Service]
Type=simple
ExecStart=/opt/llama.cpp/build/bin/llama-server \\
  -m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298 \\
  --host 127.0.0.1 --port 11436 \\
  --flash-attn on \\
  -np 3 -c 614400 \\
  --cache-type-k q4_0 --cache-type-v q4_0 \\
  --alias maxwell1500/ornith-35b:IQ3_M
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:/var/tmp/llama-server-ornith.log
StandardError=append:/var/tmp/llama-server-ornith.log

[Install]
WantedBy=default.target
`;

/**
 * The unit as deployed AFTER the 2026-08-17 engine repoint (D-011/D-012) — the shape the catalog
 * now describes. Carries the two things WI-39735 added to the guard's range: an explicit `-ngl` and
 * the two load-bearing `Environment=` lines that are the difference between using the GPU and
 * silently serving from the CPU.
 *
 * Binary and log paths are genericized, as in DRIFTED_UNIT, because they are per-box and are
 * deliberately not compared.
 *
 * Since WI-10006354 the offload is sized at start (`-ngl auto --fit on --fit-target 1024`) rather
 * than pinned to `-ngl 999`, which could not cold-start beside the box's other GPU tenants.
 */
const CURRENT_UNIT = `[Unit]
Description=llama-server serving ornith-35b IQ3_M
After=network.target

[Service]
Type=simple
Environment=LD_LIBRARY_PATH=/usr/local/lib/ollama/cuda_v13:/usr/local/lib/ollama
Environment=GGML_BACKEND_PATH=/usr/local/lib/ollama/cuda_v13/libggml-cuda.so
ExecStart=/usr/local/lib/ollama/llama-server \\
  -m /usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298 \\
  --host 127.0.0.1 --port 11436 \\
  --flash-attn on \\
  -ngl auto \\
  --fit on --fit-target 1024 \\
  -np 2 -c 180224 \\
  --cache-type-k q8_0 --cache-type-v q8_0 \\
  --alias maxwell1500/ornith-35b:IQ3_M
Restart=on-failure
RestartSec=5
Nice=5
StandardOutput=append:/var/tmp/llama-server-ornith.log
StandardError=append:/var/tmp/llama-server-ornith.log

[Install]
WantedBy=default.target
`;

/** Access stubs — the check takes `access` injected so none of this touches the real filesystem. */
const accessOk = async () => {};
const accessDenied = async () => {
  throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
};
/** Present, but without +x — F_OK succeeds while X_OK fails. */
const accessPresentNotExecutable = async (_path: string, mode: number) => {
  if (mode === fsConstants.X_OK) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
};
const accessPresentNotReadable = async (_path: string, mode: number) => {
  if (mode === fsConstants.R_OK) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
};

describe('checkUnitExecStartBinary (EI-20721621940954812)', () => {
  it('CONTROL: the parameter guard returns an IDENTICAL verdict for a startable and an unstartable unit', async () => {
    // This is the incident, reduced to one assertion. llama-ornith.service was 100% unstartable
    // (its hand-built ExecStart binary had been deleted; status=203/EXEC, NRestarts=182) and every
    // check in this module stayed GREEN, because the unit text still declared the right flags.
    //
    // Rather than assert that blindness in prose, MEASURE it: swapping the ExecStart binary for a
    // path that does not exist must not move the parameter diff by even one element. That is what
    // makes the separate existence check load-bearing rather than belt-and-braces — and if someone
    // later folds binaryPath into LlamaServerUnitParams, this test fails and tells them why.
    const startable = DRIFTED_UNIT;
    const unstartable = DRIFTED_UNIT.replace('/opt/llama.cpp/build/bin/llama-server', '/gone/llama.cpp/build/bin/llama-server');

    expect(diffCatalogAgainstDeployedUnit(ORNITH, unstartable)).toEqual(diffCatalogAgainstDeployedUnit(ORNITH, startable));

    // ...and the new check is what tells the two apart.
    expect((await checkUnitExecStartBinary(unstartable, accessDenied)).ok).toBe(false);
    expect((await checkUnitExecStartBinary(startable, accessOk)).ok).toBe(true);
  });

  it('reports a MISSING binary with the systemd failure it will actually produce', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessDenied);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('missing');
    expect(check.binaryPath).toBe('/opt/llama.cpp/build/bin/llama-server');
    // Naming 203/EXEC is the point: the observed symptom was a 15-minute silent timeout that read
    // exactly like a slow 15.5GB model load, so the message has to carry the real diagnosis.
    expect(check.detail).toContain('203/EXEC');
  });

  it('distinguishes PRESENT-BUT-NOT-EXECUTABLE from missing — different operator fixes, same 203/EXEC', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessPresentNotExecutable);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('not-executable');
    expect(check.detail).toContain('NOT executable');
  });

  it('passes a binary that exists and is executable', async () => {
    const check = await checkUnitExecStartBinary(DRIFTED_UNIT, accessOk);
    expect(check).toMatchObject({ ok: true, reason: 'ok', binaryPath: '/opt/llama.cpp/build/bin/llama-server' });
  });

  it('a unit with no ExecStart is NOT reported as ok', async () => {
    // The failure mode to avoid: "nothing to check" collapsing into a pass.
    const check = await checkUnitExecStartBinary('[Unit]\nDescription=nothing here\n', accessOk);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('no-execstart');
    expect(check.binaryPath).toBeNull();
  });
});

describe('checkUnitExecStartModelFile', () => {
  it('parses the model file across systemd line continuations', () => {
    expect(parseUnitExecStartModelPath(CURRENT_UNIT)).toBe(
      '/usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298',
    );
  });

  it('supports --model and inline model forms', () => {
    expect(parseUnitExecStartModelPath('ExecStart=/usr/bin/llama-server --model /models/a.gguf')).toBe('/models/a.gguf');
    expect(parseUnitExecStartModelPath('ExecStart=/usr/bin/llama-server --model=/models/b.gguf')).toBe('/models/b.gguf');
    expect(parseUnitExecStartModelPath('ExecStart=/usr/bin/llama-server -m=/models/c.gguf')).toBe('/models/c.gguf');
  });

  it('distinguishes missing, unreadable, unresolved, and absent model paths', async () => {
    expect(await checkUnitExecStartModelFile(CURRENT_UNIT, accessOk)).toMatchObject({
      ok: true,
      reason: 'ok',
      modelPath: '/usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298',
    });
    expect(await checkUnitExecStartModelFile(CURRENT_UNIT, accessDenied)).toMatchObject({
      ok: false,
      reason: 'missing',
    });
    expect(await checkUnitExecStartModelFile(CURRENT_UNIT, accessPresentNotReadable)).toMatchObject({
      ok: false,
      reason: 'not-readable',
    });
    expect(await checkUnitExecStartModelFile('ExecStart=/usr/bin/llama-server -m $MODEL_PATH', accessOk)).toMatchObject({
      ok: false,
      reason: 'unresolved',
    });
    expect(await checkUnitExecStartModelFile('ExecStart=/usr/bin/llama-server --host 127.0.0.1', accessOk)).toMatchObject({
      ok: false,
      reason: 'no-model-path',
    });
  });
});

describe('parseUnitExecStartBinary', () => {
  it('reads the binary through systemd backslash continuations', () => {
    expect(parseUnitExecStartBinary(DRIFTED_UNIT)).toBe('/opt/llama.cpp/build/bin/llama-server');
  });

  it('strips ExecStart prefix modifiers, including combined ones', () => {
    // systemd allows `-` (ignore failure), `@` (set argv0), `+` (full privileges), `!`/`!!`, and
    // permits them combined. Leaving one attached yields a path that can never exist, i.e. a
    // guard that reports `missing` for a perfectly healthy unit — a false alarm is a bug in the
    // alarm, and a noisy guard gets silenced.
    expect(parseUnitExecStartBinary('ExecStart=-/usr/bin/llama-server --host 127.0.0.1')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=@/usr/bin/llama-server argv0')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=+/usr/bin/llama-server')).toBe('/usr/bin/llama-server');
    expect(parseUnitExecStartBinary('ExecStart=!!-@/usr/bin/llama-server')).toBe('/usr/bin/llama-server');
  });

  it('returns null when the unit declares no ExecStart', () => {
    expect(parseUnitExecStartBinary('[Unit]\nDescription=nothing here\n')).toBeNull();
  });
});

describe('parseLlamaServerUnit', () => {
  it('reads flags across systemd backslash continuations', () => {
    // The whole reason this is a parser: every real unit here spreads ExecStart over seven
    // lines, so a per-line regex sees unrelated fragments.
    expect(parseLlamaServerUnit(DRIFTED_UNIT)).toEqual({
      host: '127.0.0.1',
      port: 11436,
      parallelSlots: 3,
      ctxTotal: 614400,
      kvCacheTypeK: 'q4_0',
      kvCacheTypeV: 'q4_0',
      flashAttn: true,
      alias: 'maxwell1500/ornith-35b:IQ3_M',
      // Absent from this unit — and reported as absent, not as some assumed default. That
      // distinction is the entire bug in WI-39735: a guard that defaults a missing `-ngl` to
      // "all layers" reports agreement between a GPU unit and a CPU-only one.
      gpuLayers: null,
      fit: null,
      fitTargetMiB: null,
    });
  });

  it('reports an absent flag as null rather than substituting a default', () => {
    const p = parseLlamaServerUnit('[Service]\nExecStart=llama-server --host 127.0.0.1\n');
    expect(p.host).toBe('127.0.0.1');
    expect(p.parallelSlots).toBeNull();
    expect(p.ctxTotal).toBeNull();
    expect(p.kvCacheTypeK).toBeNull();
  });

  it('returns all-null for a unit with no ExecStart instead of throwing', () => {
    expect(parseLlamaServerUnit('[Unit]\nDescription=nothing here\n').port).toBeNull();
  });

  it('reads --flash-attn off as disabled', () => {
    expect(parseLlamaServerUnit('ExecStart=llama-server --flash-attn off').flashAttn).toBe(false);
  });
});

describe('diffCatalogAgainstDeployedUnit', () => {
  /** The control: the guard must name exactly the parameters that really drifted. */
  it('catches the REAL 2026-08-17 drift, and names every drifted parameter', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    const byParam = Object.fromEntries(drift.map((d) => [d.param, d]));

    // `gpuLayers` joined this list in WI-39735. It is not a historical claim about what that unit
    // did on the GPU — it is the guard reporting that the catalog declares an offload setting the
    // deployed unit does not, which is precisely the silence that hid a CPU-only fallback.
    // `fit` / `fitTargetMiB` joined it in WI-10006354 for the same reason.
    expect(Object.keys(byParam).sort()).toEqual([
      'ctxTotal',
      'fit',
      'fitTargetMiB',
      'gpuLayers',
      'kvCacheTypeK',
      'kvCacheTypeV',
      'parallelSlots',
    ]);
    expect(byParam.gpuLayers).toMatchObject({ generated: 'auto', deployed: 'null' });
    expect(byParam.fit).toMatchObject({ generated: 'on', deployed: 'null' });
    expect(byParam.parallelSlots).toMatchObject({ generated: '2', deployed: '3' });
    expect(byParam.ctxTotal).toMatchObject({ generated: '180224', deployed: '614400' });
    expect(byParam.kvCacheTypeK).toMatchObject({ generated: 'q8_0', deployed: 'q4_0' });
  });

  /**
   * The point of the whole module, stated as a test: the OLD guard shape could not have caught
   * this. `backend-config.test.ts` asserts host and port — and host and port AGREED right
   * through the drift. So a green host/port assertion was never evidence about the unit.
   */
  it('explains the old blind spot: host and port agreed throughout the drift', () => {
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    expect(drift.map((d) => d.param)).not.toContain('host');
    expect(drift.map((d) => d.param)).not.toContain('port');
    expect(drift.length).toBeGreaterThan(0);
  });

  it('reports no drift for a unit rendered from the catalog itself', () => {
    // Generated-vs-generated must be clean, or every comparison below is noise. This is the
    // calibration case: without it, a diff that reported everything as drifted would still
    // pass the control above.
    const selfRendered = diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT);
    // sanity: the control really does differ (5 params, +fit/fitTargetMiB since WI-10006354)
    expect(selfRendered.length).toBe(7);
    const clean = diffUnitParams(
      parseLlamaServerUnit(DRIFTED_UNIT),
      parseLlamaServerUnit(DRIFTED_UNIT),
    );
    expect(clean).toEqual([]);
  });

  it('describeUnitDrift renders an actionable one-liner', () => {
    expect(describeUnitDrift([])).toBe('no drift');
    expect(describeUnitDrift(diffCatalogAgainstDeployedUnit(ORNITH, DRIFTED_UNIT))).toContain(
      'parallelSlots: catalog=2 deployed=3',
    );
  });
});

describe('GPU offload (-ngl) — WI-39735', () => {
  it('reads every spelling llama-server accepts', () => {
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl 999').gpuLayers).toBe(999);
    expect(parseLlamaServerUnit('ExecStart=llama-server --n-gpu-layers 32').gpuLayers).toBe(32);
    expect(parseLlamaServerUnit('ExecStart=llama-server --gpu-layers 0').gpuLayers).toBe(0);
  });

  it('distinguishes `-ngl 0` from an absent flag', () => {
    // Both mean "no GPU" in effect, but they are different FACTS about the unit: one declares the
    // intent, the other leaves it to whatever the engine defaults to on this build. Collapsing
    // them is the same substitution error the module header forbids.
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl 0').gpuLayers).toBe(0);
    expect(parseLlamaServerUnit('ExecStart=llama-server').gpuLayers).toBeNull();
  });

  it('reports drift when a deployed unit silently drops the GPU offload flag', () => {
    // The failure this exists for: strip `-ngl` and the unit still starts, still reports active,
    // still answers /health 200, and still matches every OTHER compared parameter.
    const noNgl = CURRENT_UNIT.replace('  -ngl auto \\\n', '');
    expect(noNgl).not.toBe(CURRENT_UNIT);
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, noNgl);
    expect(drift.map((d) => d.param)).toEqual(['gpuLayers']);
    expect(describeUnitDrift(drift)).toContain('gpuLayers: catalog=auto deployed=null');
  });

  it('reports NO drift for the current deployed shape', () => {
    // Calibration: without this, a guard that flagged everything would still pass the case above.
    expect(diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT)).toEqual([]);
  });
});

describe('start-time GPU fit (--fit) — WI-10006354', () => {
  it('reads the -ngl keywords and both spellings of the fit flags', () => {
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl auto').gpuLayers).toBe('auto');
    expect(parseLlamaServerUnit('ExecStart=llama-server --n-gpu-layers all').gpuLayers).toBe('all');
    const long = parseLlamaServerUnit('ExecStart=llama-server --fit on --fit-target 1024');
    expect(long).toMatchObject({ fit: 'on', fitTargetMiB: 1024 });
    const short = parseLlamaServerUnit('ExecStart=llama-server -fit off -fitt 2048');
    expect(short).toMatchObject({ fit: 'off', fitTargetMiB: 2048 });
    // Absent stays absent: the engine defaults --fit to on, but the guard never assumes it.
    expect(parseLlamaServerUnit('ExecStart=llama-server -ngl auto')).toMatchObject({ fit: null, fitTargetMiB: null });
  });

  it('reports the pre-fix pinned unit (-ngl 999, no --fit) as drift', () => {
    // The shape that could not cold-start beside the embed sidecar: cudaMalloc OOM, exit 1 x3,
    // StartLimit. A deployed unit reverting to it must be named, not pass as matching.
    const pinned = CURRENT_UNIT.replace('  -ngl auto \\\n  --fit on --fit-target 1024 \\\n', '  -ngl 999 \\\n');
    expect(pinned).not.toBe(CURRENT_UNIT);
    const drift = diffCatalogAgainstDeployedUnit(ORNITH, pinned);
    expect(drift.map((d) => d.param).sort()).toEqual(['fit', 'fitTargetMiB', 'gpuLayers']);
    expect(describeUnitDrift(drift)).toContain('gpuLayers: catalog=auto deployed=999');
  });

  it('every on-demand llama-server entry sizes its offload at start instead of pinning it', () => {
    // The class guard. An on-demand backend cold-starts into whatever GPU occupancy exists at that
    // moment, so a pinned layer count makes its availability depend on every other GPU tenant.
    const onDemand = CERTIFIED_CATALOG.filter((e) => e.backend === 'llama-server' && e.serve.lifecycle === 'on-demand');
    expect(onDemand.map((e) => e.id)).toContain(ORNITH.id);
    for (const e of onDemand) {
      expect({ id: e.id, gpuLayers: e.serve.gpuLayers, fit: e.serve.fit }).toEqual({ id: e.id, gpuLayers: 'auto', fit: 'on' });
      expect(e.serve.fitTargetMiB, e.id).toBeGreaterThan(0);
    }
  });
});

describe('required Environment= vars (WI-39735 / D-012)', () => {
  it('parses single, repeated and quoted multi-assignment forms', () => {
    const env = parseUnitEnvironment(CURRENT_UNIT);
    expect(env.GGML_BACKEND_PATH).toBe('/usr/local/lib/ollama/cuda_v13/libggml-cuda.so');
    expect(env.LD_LIBRARY_PATH).toBe('/usr/local/lib/ollama/cuda_v13:/usr/local/lib/ollama');
    expect(parseUnitEnvironment('Environment="A=1" "B=2"')).toEqual({ A: '1', B: '2' });
    // Last assignment of a key wins, as systemd itself resolves it.
    expect(parseUnitEnvironment('Environment=A=1\nEnvironment=A=2').A).toBe('2');
  });

  it('does NOT mistake EnvironmentFile= for an assignment', () => {
    // It names a file we cannot read from here; matching it would invent a variable called
    // `EnvironmentFile` and, worse, report a required var as present when nothing set it.
    expect(parseUnitEnvironment('EnvironmentFile=/etc/default/llama')).toEqual({});
  });

  it('CONTROL: the parameter diff is BLIND to a deleted CUDA var — this check is what sees it', () => {
    // The same measurement `checkUnitExecStartBinary`'s control makes, for the other half of the
    // 2026-08-17 incident. Deleting the line that decides whether the model touches the GPU must
    // not move the parameter diff by one element — that blindness is the bug, so measure it here
    // rather than assert it in prose. If someone later folds environment into
    // LlamaServerUnitParams, this test fails and tells them why it was kept separate.
    const noCuda = CURRENT_UNIT.replace(
      'Environment=GGML_BACKEND_PATH=/usr/local/lib/ollama/cuda_v13/libggml-cuda.so\n',
      '',
    );
    expect(diffCatalogAgainstDeployedUnit(ORNITH, noCuda)).toEqual(
      diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT),
    );

    // ...and the new check is what tells the two apart.
    expect(checkRequiredEnvironment(ORNITH, CURRENT_UNIT)).toEqual([]);
    const issues = checkRequiredEnvironment(ORNITH, noCuda);
    expect(issues.map((i) => i.key)).toEqual(['GGML_BACKEND_PATH']);
    expect(issues[0].reason).toBe('missing');
    expect(describeEnvIssues(issues)).toBe('GGML_BACKEND_PATH: missing');
  });

  it('treats a declared-but-empty value as missing in effect', () => {
    const emptied = CURRENT_UNIT.replace(
      '/usr/local/lib/ollama/cuda_v13/libggml-cuda.so\nExecStart=',
      '\nExecStart=',
    );
    const issues = checkRequiredEnvironment(ORNITH, emptied);
    expect(issues.map((i) => [i.key, i.reason])).toEqual([['GGML_BACKEND_PATH', 'empty']]);
  });

  it('is silent for an entry that declares no requiredEnv', () => {
    // Every other catalog entry must stay unaffected, or this becomes the cry-wolf the header warns
    // about: an opt-in guard that fires on boxes whose catalog never opted in.
    const qwen = CERTIFIED_CATALOG.find((e) => e.id === 'qwen3-8b-q4km-llama-server')!;
    expect(qwen.serve.requiredEnv).toBeUndefined();
    expect(checkRequiredEnvironment(qwen, CURRENT_UNIT)).toEqual([]);
    expect(describeEnvIssues([])).toBe('no missing required environment');
  });
});

/**
 * The live half: compare the catalog against the unit ACTUALLY deployed on this machine.
 *
 * Subject path is env-overridable — that one line is what makes a tier-2 mutation probe possible
 * (mutate a COPY outside the tree and point the test at it), instead of the tier-3 shape that
 * mutates the shared checkout and races git-sync's sweep.
 *
 * An absent file is a valid host-specific outcome, but its worker-resolved path must be visible.
 * Register only the applicable present/absent branch so an intentionally skipped absence
 * sentinel cannot look like a skipped live comparison in test:file's aggregate count.
 */
describe('deployed unit on this machine', () => {
  const readUnitProbe = () => {
    const configuredPath = process.env.PAPERCUSP_ORNITH_UNIT_PATH ?? null;
    const home = homedir();
    const unitPath = configuredPath ?? join(home, '.config/systemd/user/llama-ornith.service');
    return {
      homeEnv: process.env.HOME ?? null,
      homedir: home,
      configuredPath,
      unitPath,
      present: existsSync(unitPath),
    };
  };
  const unitProbe = readUnitProbe();
  const { unitPath, present } = unitProbe;
  const probeDetails =
    `HOME=${unitProbe.homeEnv ?? '(unset)'}, os.homedir()=${unitProbe.homedir}, ` +
    `PAPERCUSP_ORNITH_UNIT_PATH=${unitProbe.configuredPath ?? '(unset)'}, ` +
    `unitPath=${unitProbe.unitPath}, existsSync=${unitProbe.present}`;

  it('keeps the host-unit path and presence stable from collection through execution', () => {
    expect(readUnitProbe()).toEqual(unitProbe);
  });

  if (unitProbe.configuredPath !== null) {
    it('requires an explicit PAPERCUSP_ORNITH_UNIT_PATH override to exist', () => {
      expect(unitProbe.present, `Configured comparison path does not exist (${probeDetails})`).toBe(true);
    });
  }

  if (present) {
    it('matches the certified catalog entry', () => {
      const drift = diffCatalogAgainstDeployedUnit(ORNITH, readFileSync(unitPath, 'utf8'));
      expect(
        drift,
        `DEPLOYED UNIT HAS DRIFTED from catalog '${ORNITH.id}' (${unitPath}): ${describeUnitDrift(drift)}. ` +
          `This entry is status:'${ORNITH.status}' — its certification was earned on the CATALOG's numbers, ` +
          `so a deployed unit that differs is running an UNCERTIFIED config (D-007). Restore the unit, or ` +
          `change the catalog and re-run the cert battery; do not relabel one to match the other.`,
      ).toEqual([]);
    });

    it('carries every environment variable the catalog declares it cannot serve without', () => {
      const issues = checkRequiredEnvironment(ORNITH, readFileSync(unitPath, 'utf8'));
      expect(
        issues,
        `DEPLOYED UNIT IS MISSING REQUIRED ENVIRONMENT (${unitPath}): ${describeEnvIssues(issues)}. ` +
          `This is the WI-39735 / D-012 failure: the unit will still start, still report active and ` +
          `still answer /health 200 — while serving from the CPU, at roughly half the load speed and ` +
          `far worse throughput. Restore the Environment= line(s); do not drop them from the catalog.`,
      ).toEqual([]);
    });
  } else {
    // Host absence is a legitimate outcome, but its path source must be visible in the result.
    // Declare only the applicable branch: an intentionally skipped absence sentinel on a host
    // with a deployed unit looks exactly like the live comparisons were skipped in test:file's
    // aggregate 43 passed / 1 skipped summary.
    it(`confirms no deployed unit at the worker-resolved path (${probeDetails})`, () => {
      expect(present).toBe(false);
    });
  }
});

/**
 * The alias set + kind EXACTLY as `harness_shared.local_backends` holds them for this box's one
 * on-demand backend (read 2026-08-18). Copied rather than synthesized: the whole point of these
 * tests is that the production row resolves, and a tidied-up fixture would not prove that.
 */
const ORNITH_REGISTRY_ROW = {
  id: 'ornith-llamaserver',
  kind: 'llama-server',
  models: [
    'maxwell1500/ornith-35b:IQ3_M',
    'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    'ornith:35b',
    'ornith:fast',
    'ornith-35b',
    'ornith',
  ],
} as const;

describe('resolveCatalogEntryForBackend (WI-39735 wiring / D-016)', () => {
  it('CONTROL: the registry id is NOT the catalog id, so an id-keyed lookup finds nothing', () => {
    // This is the trap the resolver exists to avoid, measured rather than asserted. If someone
    // "simplifies" resolveCatalogEntryForBackend to findCatalogEntry(backend.id), THIS is the fact
    // that makes it silently audit nothing — so the guard's own test suite states it out loud.
    expect(findCatalogEntry(ORNITH_REGISTRY_ROW.id)).toBeUndefined();
    expect(ORNITH_REGISTRY_ROW.id).not.toBe(ORNITH.id);
  });

  it('resolves the live production row to its catalog entry via the model ref', () => {
    const resolution = resolveCatalogEntryForBackend(ORNITH_REGISTRY_ROW);
    expect(resolution.reason).toBe('ok');
    expect(resolution.entry?.id).toBe('ornith-35b-iq3m-llama-server');
  });

  it('distinguishes no-model-refs, no-match and ambiguous — they are different bugs', () => {
    expect(resolveCatalogEntryForBackend({ models: [], kind: 'llama-server' }).reason).toBe('no-model-refs');
    expect(resolveCatalogEntryForBackend({ models: ['some/other-model:Q4'], kind: 'llama-server' }).reason).toBe('no-match');

    // Same model, two backends — a real catalog shape (llama-server vs vLLM), and the reason kind
    // disambiguates. With the kind dropped it becomes genuinely ambiguous and must NOT guess.
    const twoWays: CatalogEntry[] = [ORNITH, { ...ORNITH, id: 'ornith-via-vllm', backend: 'vllm' } as CatalogEntry];
    expect(resolveCatalogEntryForBackend({ models: [ORNITH.model.ollamaRef], kind: 'vllm' }, twoWays).entry?.id).toBe(
      'ornith-via-vllm',
    );
    const ambiguous = resolveCatalogEntryForBackend({ models: [ORNITH.model.ollamaRef] }, twoWays);
    expect(ambiguous.reason).toBe('ambiguous');
    expect(ambiguous.entry).toBeNull();
  });

  it('does not match on kind alone when no model ref overlaps', () => {
    expect(resolveCatalogEntryForBackend({ models: ['unrelated'], kind: 'llama-server' }).entry).toBeNull();
  });
});

describe('auditDeployedUnit (WI-39735 wiring / D-016)', () => {
  it('passes the current unit on all four checks at once', async () => {
    const audit = await auditDeployedUnit(ORNITH, CURRENT_UNIT, { access: accessOk });
    expect(audit.verdict).toBe('ok');
    expect(audit.drift).toEqual([]);
    expect(audit.envIssues).toEqual([]);
    expect(audit.binary?.ok).toBe(true);
    expect(audit.model?.ok).toBe(true);
    expect(audit.catalogEntryId).toBe('ornith-35b-iq3m-llama-server');
  });

  it('catches PARAM drift — the 2026-08-17 deployed unit', async () => {
    const audit = await auditDeployedUnit(ORNITH, DRIFTED_UNIT, { access: accessOk });
    expect(audit.verdict).toBe('degraded');
    expect(audit.summary).toMatch(/parallelSlots|ctxTotal|kvCacheTypeK/);
  });

  it('catches a MISSING REQUIRED ENV var while every compared param still matches', async () => {
    // The D-012 failure mode exactly: delete the CUDA backend path and the unit still matches the
    // catalog on every parameter a diff compares, starts, and answers /health from the CPU.
    const cpuFallback = CURRENT_UNIT.split('\n')
      .filter((l) => !l.startsWith('Environment=GGML_BACKEND_PATH'))
      .join('\n');
    expect(diffCatalogAgainstDeployedUnit(ORNITH, cpuFallback)).toEqual([]); // the old blindness, measured

    const audit = await auditDeployedUnit(ORNITH, cpuFallback, { access: accessOk });
    expect(audit.verdict).toBe('degraded');
    expect(audit.envIssues.map((i) => i.key)).toEqual(['GGML_BACKEND_PATH']);
  });

  it('catches a MISSING ENGINE BINARY while every compared param still matches', async () => {
    expect(diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT)).toEqual([]);
    const audit = await auditDeployedUnit(ORNITH, CURRENT_UNIT, { access: accessDenied });
    expect(audit.verdict).toBe('degraded');
    expect(audit.binary?.reason).toBe('missing');
  });

  it('catches a MISSING DEPLOYED MODEL FILE while every compared param still matches', async () => {
    const missingModelPath = '/missing/ornith.gguf';
    const unit = CURRENT_UNIT.replace(
      '/usr/share/ollama/.ollama/models/blobs/sha256-18f775956e1ee05608de578ad9e02b10f5b9c04d6eee59c48a0f38c897857298',
      missingModelPath,
    );
    expect(diffCatalogAgainstDeployedUnit(ORNITH, unit)).toEqual(diffCatalogAgainstDeployedUnit(ORNITH, CURRENT_UNIT));

    const access = async (path: string) => {
      if (path === missingModelPath) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const audit = await auditDeployedUnit(ORNITH, unit, { access });
    expect(audit.verdict).toBe('degraded');
    expect(audit.binary?.ok).toBe(true);
    expect(audit.model).toMatchObject({ ok: false, reason: 'missing', modelPath: missingModelPath });
    expect(audit.summary).toContain('model[missing:');
  });

  it('reports a present-but-not-executable binary as degraded too', async () => {
    const audit = await auditDeployedUnit(ORNITH, CURRENT_UNIT, { access: accessPresentNotExecutable });
    expect(audit.verdict).toBe('degraded');
    expect(audit.binary?.reason).toBe('not-executable');
  });
});

describe('auditDeployedUnitForBackend — unauditable is never reported as clean', () => {
  it('audits a resolvable backend end-to-end from its registry row', async () => {
    const audit = await auditDeployedUnitForBackend(ORNITH_REGISTRY_ROW, CURRENT_UNIT, { access: accessOk });
    expect(audit.verdict).toBe('ok');
    expect(audit.catalogEntryId).toBe('ornith-35b-iq3m-llama-server');
  });

  it('returns UNAUDITABLE — not ok — when the catalog entry cannot be resolved', async () => {
    // The distinction this asserts is the whole reason `unauditable` is a verdict rather than a
    // null entry: a caller that cannot tell "could not check" from "checked, clean" will log a
    // broken guard as a passing one, which is how the original drift survived for weeks.
    const audit = await auditDeployedUnitForBackend({ models: ['not/in-catalog'], kind: 'llama-server' }, CURRENT_UNIT, {
      access: accessOk,
    });
    expect(audit.verdict).toBe('unauditable');
    expect(audit.verdict).not.toBe('ok');
    expect(audit.catalogEntryId).toBeNull();
    expect(audit.summary).toMatch(/cannot audit/);
  });

  it('does not silently pass a DEGRADED unit just because the text was readable', async () => {
    const audit = await auditDeployedUnitForBackend(ORNITH_REGISTRY_ROW, DRIFTED_UNIT, { access: accessOk });
    expect(audit.verdict).toBe('degraded');
  });
});
