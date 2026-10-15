import { describe, expect, it, vi } from 'vitest';
import {
  planProvision,
  applyProvision,
  stopLocalBackend,
  ensureLocalBackendRunning,
  type BackendLifecycleTarget,
} from './provision';
import type { CatalogEntry } from './catalog';

const nvidia24gbHardwareDeps = {
  exec: async (cmd: string, args: string[]) => {
    if (cmd === 'nvidia-smi') return { stdout: 'NVIDIA GeForce RTX 3090, 24576\n', stderr: '' };
    throw new Error('unexpected command');
  },
  platform: 'linux' as const,
  arch: 'x64',
  totalMemBytes: 64 * 1024 ** 3,
};

const cpuOnlyHardwareDeps = {
  exec: async () => {
    throw new Error('no gpu tooling');
  },
  platform: 'linux' as const,
  arch: 'x64',
  totalMemBytes: 16 * 1024 ** 3,
};

// planProvision() only probes for a container runtime on NVIDIA hardware (D-004: vLLM is
// CUDA-only) — every nvidia24gbHardwareDeps case below hits that probe, so inject a
// deterministic "no runtime" exec rather than letting it shell out to this box's real
// docker/podman (hermetic + fast, matches every other injected-deps test in this file).
const noContainerRuntimeVllmDeps = {
  exec: async () => {
    throw new Error('no container runtime in test env');
  },
};

describe('planProvision', () => {
  it('produces a ready-to-apply plan when weights are already present (real ornith shape)', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
      home: '/home/testuser',
    });
    expect(plan.blocked).toBeNull();
    expect(plan.recommendation.entry?.id).toBe('ornith-35b-iq3m-llama-server');
    expect(plan.weights?.needsDownload).toBe(false);
    expect(plan.unitFileContent).toContain('ExecStart=llama-server');
    expect(plan.unitFilePath).toBe('/home/testuser/.config/systemd/user/provisioner-ornith-35b-iq3m-llama-server.service');
    expect(plan.gatewayRegisterInput).toEqual({
      id: 'provisioner-ornith-35b-iq3m-llama-server',
      kind: 'llama-server',
      baseUrl: 'http://127.0.0.1:11436',
      models: ['maxwell1500/ornith-35b:IQ3_M'],
      maxConcurrent: 2,
      // The catalog entry marks this combo on-demand (it occupies a whole 24GB card), and the
      // plan must carry that into the REGISTRY, which is what the reaper and gateway read — the
      // catalog itself is only a recommendation source (D-005).
      lifecycle: 'on-demand',
      idleTtlSec: 1800,
      // Captured here rather than inferred from baseUrl later: for a backend fronted by a proxy
      // those are different processes, and guessing stops the wrong one (D-005).
      unitName: 'provisioner-ornith-35b-iq3m-llama-server.service',
    });
  });

  it('is blocked with a pull hint when weights are not present locally', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: { exists: () => false, readFile: async () => '' },
    });
    expect(plan.blocked).toMatch(/ollama pull/);
    expect(plan.unitFileContent).toBeNull();
    expect(plan.gatewayRegisterInput).toBeNull();
  });

  it('is blocked with a cloud-fallback reason on cpu-only hardware — never calls the weights resolver', async () => {
    const ollamaDeps = { exists: vi.fn(() => false), readFile: vi.fn(async () => '') };
    const plan = await planProvision({ hardwareDeps: cpuOnlyHardwareDeps, ollamaDeps });
    expect(plan.blocked).toMatch(/cloud gateway/);
    expect(ollamaDeps.exists).not.toHaveBeenCalled();
  });

  // A synthetic vllm catalog entry — no real one exists yet (P-008, still `todo`, is what
  // grounds a certified/provisional AWQ entry). This proves provision.ts's vllm branch
  // (D-009 #3/P-013) end-to-end without waiting on that cert battery.
  const vllmCatalog: CatalogEntry[] = [
    {
      id: 'ornith-35b-awq-vllm',
      displayName: 'ornith-35b (AWQ) via vLLM',
      backend: 'vllm',
      model: { ollamaRef: 'ornith-35b-awq', quant: 'AWQ', sizeGB: 19, hfRepo: 'maxwell1500/ornith-35b-AWQ', quantization: 'awq' },
      hardwareTier: 'nvidia-24gb-plus',
      minVramGB: 24,
      serve: { host: '127.0.0.1', portDefault: 8000, parallelSlots: 4, ctxTotal: 65536, kvCacheType: 'n/a', flashAttn: false, gpuMemoryUtilization: 0.9 },
      status: 'provisional',
      sourceRef: 'test fixture — no real vLLM catalog entry exists yet',
    },
  ];

  it('produces a vllm container plan when a working container runtime is detected and the image is cached', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: vllmCatalog,
      vllmDeps: {
        exec: async (cmd: string, args: string[]) => {
          if (cmd === 'docker' && args[0] === 'info') return { stdout: '"29.4.0"', stderr: '' };
          if (cmd === 'docker' && args[0] === 'image') return { stdout: 'sha256:abc', stderr: '' };
          throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
        },
      },
      home: '/home/testuser',
    });
    expect(plan.blocked).toBeNull();
    expect(plan.containerRuntime?.runtime).toBe('docker');
    expect(plan.recommendation.entry?.id).toBe('ornith-35b-awq-vllm');
    expect(plan.unitFileContent).toContain('ExecStart=docker run --rm --name provisioner-ornith-35b-awq-vllm');
    expect(plan.unitFileContent).toContain('--model maxwell1500/ornith-35b-AWQ');
    expect(plan.unitFileContent).toContain('--quantization awq');
    expect(plan.gatewayRegisterInput).toEqual({
      id: 'provisioner-ornith-35b-awq-vllm',
      kind: 'vllm',
      baseUrl: 'http://127.0.0.1:8000',
      models: ['ornith-35b-awq'],
      maxConcurrent: 4,
      // This fixture's catalog entry says nothing about lifecycle, and the default is the whole
      // safety argument for the field: an entry that is silent — including any third-party
      // catalog written before 843 existed — stays always-on and never becomes reapable.
      lifecycle: 'always-on',
      idleTtlSec: null,
      unitName: 'provisioner-ornith-35b-awq-vllm.service',
    });
  });

  it('is blocked with a pullHint (never renders a unit) when the image is not cached yet', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: vllmCatalog,
      vllmDeps: {
        exec: async (cmd: string, args: string[]) => {
          if (cmd === 'docker' && args[0] === 'info') return { stdout: '"29.4.0"', stderr: '' };
          throw new Error('no such image');
        },
      },
    });
    expect(plan.blocked).toMatch(/docker pull/);
    expect(plan.unitFileContent).toBeNull();
    expect(plan.gatewayRegisterInput).toBeNull();
  });

  it('downgrades to the llama-server candidate when no working container runtime is found, for a tier with both', async () => {
    const mixedCatalog: CatalogEntry[] = [
      ...vllmCatalog,
      {
        id: 'ornith-35b-iq3m-llama-server',
        displayName: 'ornith-35b (IQ3_M) via llama-server',
        backend: 'llama-server',
        model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M', quant: 'IQ3_M', sizeGB: 15.5 },
        hardwareTier: 'nvidia-24gb-plus',
        minVramGB: 24,
        serve: { host: '127.0.0.1', portDefault: 11436, parallelSlots: 2, ctxTotal: 180224, kvCacheType: 'q8_0', flashAttn: true },
        status: 'provisional',
        sourceRef: 'test fixture',
      },
    ];
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      catalog: mixedCatalog,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    // vllm's sizeGB (19) < llama-server's (15.5)? No — 19 > 15.5, so vllm would normally win on
    // size; the container-runtime gate is what forces the llama-server fallback here.
    expect(plan.recommendation.entry?.backend).toBe('llama-server');
    expect(plan.recommendation.reason).toMatch(/vLLM candidate was skipped/);
    expect(plan.blocked).toBeNull();
  });
});

describe('applyProvision', () => {
  it('refuses to apply a blocked plan without writing/registering anything', async () => {
    const plan = await planProvision({ hardwareDeps: cpuOnlyHardwareDeps });
    const writeFile = vi.fn();
    const registerBackend = vi.fn();
    const result = await applyProvision(plan, { writeFile, registerBackend });
    expect(result.ok).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
    expect(registerBackend).not.toHaveBeenCalled();
  });

  it('writes the unit + registers the backend, and NEVER touches systemd/GPU when start is omitted', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    const writeFile = vi.fn(async () => {});
    const mkdir = vi.fn(async () => {});
    const registerBackend = vi.fn(async (input) => ({ ...input, createdAt: 'now', updatedAt: 'now', enabled: true }));
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);

    const result = await applyProvision(plan, { writeFile, mkdir, registerBackend, runSystemctl, healthCheck });

    expect(result).toEqual({ ok: true, wroteUnit: true, registered: true, started: false });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(registerBackend).toHaveBeenCalledTimes(1);
    expect(runSystemctl).not.toHaveBeenCalled();
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('only touches systemd/GPU when start:true is explicitly passed', async () => {
    const plan = await planProvision({
      hardwareDeps: nvidia24gbHardwareDeps,
      vllmDeps: noContainerRuntimeVllmDeps,
      ollamaDeps: {
        exists: () => true,
        readFile: async () =>
          JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:abc123' }] }),
      },
    });
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);
    const result = await applyProvision(plan, {
      writeFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      registerBackend: vi.fn(async (input) => ({ ...input, createdAt: 'now', updatedAt: 'now', enabled: true })),
      runSystemctl,
      healthCheck,
      start: true,
    });
    expect(result.started).toBe(true);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'daemon-reload']);
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'enable', '--now', 'provisioner-ornith-35b-iq3m-llama-server.service']);
    expect(healthCheck).toHaveBeenCalledWith('http://127.0.0.1:11436');
  });
});

/* ── Runtime lifecycle seam (P-006) ───────────────────────────────────────────────────────
 *
 * The shape under test is the REAL, MEASURED ornith topology, because it is the one that
 * makes the bug possible: baseUrl points at the always-on proxy (:11435) while the unit that
 * actually holds the GPU is `llama-ornith.service` (:11436). A "stop whatever serves baseUrl"
 * implementation passes any test whose fixture has those agreeing — so they must not agree
 * here (D-005). */
const ORNITH: BackendLifecycleTarget = {
  id: 'ornith-llamaserver',
  unitName: 'llama-ornith.service',
  baseUrl: 'http://127.0.0.1:11435',
};

/** Deterministic clock: `sleep` advances it, so a 10-minute timeout costs no wall-clock. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('stopLocalBackend', () => {
  it('stops the RECORDED unit, never one derived from baseUrl', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await stopLocalBackend(ORNITH, { runSystemctl });

    expect(result).toMatchObject({ ok: true, stopped: true, unitName: 'llama-ornith.service' });
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'stop', 'llama-ornith.service']);
    // The port that is NOT the unit's must never appear in an argv — that is the exact
    // mistake (stopping the proxy, leaving 19.8GB resident) this asserts against.
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('11435');
  });

  it('REFUSES a backend with no recorded unit, without touching systemd', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await stopLocalBackend({ ...ORNITH, unitName: null }, { runSystemctl });

    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(false);
    expect(result.error).toMatch(/no unitName recorded/);
    expect(runSystemctl).not.toHaveBeenCalled();
  });

  it('never issues `disable` — boot policy is not an idle sweep\'s to change', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await stopLocalBackend(ORNITH, { runSystemctl });
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('disable');
  });

  /** CONTROL — the plausible-but-wrong implementation D-005 exists to forbid, kept
   *  permanently so the two assertions above are known to have teeth. A "stop whatever serves
   *  baseUrl" stop is the natural thing to write and passes any fixture whose baseUrl port and
   *  unit agree; it must FAIL here. If this test ever goes green, the assertions above have
   *  stopped testing anything. */
  async function stopByDerivedUnit(
    target: BackendLifecycleTarget,
    opts: { runSystemctl: (args: string[]) => Promise<{ stdout: string; stderr: string }> },
  ) {
    const port = new URL(target.baseUrl).port;
    await opts.runSystemctl(['--user', 'stop', `llama-server-${port}.service`]);
  }

  it('control: a baseUrl-derived stop fails the assertions the real one passes', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    await stopByDerivedUnit(ORNITH, { runSystemctl });

    expect(() =>
      expect(runSystemctl).toHaveBeenCalledWith(['--user', 'stop', 'llama-ornith.service']),
    ).toThrow();
    expect(() => expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('11435')).toThrow();
  });

  it('reports a systemctl failure instead of claiming the backend stopped', async () => {
    const result = await stopLocalBackend(ORNITH, {
      runSystemctl: async () => {
        throw new Error('Unit llama-ornith.service not loaded.');
      },
    });
    expect(result).toMatchObject({ ok: false, stopped: false });
    expect(result.error).toMatch(/not loaded/);
  });
});

describe('ensureLocalBackendRunning', () => {
  it('costs one health probe and no subprocess when the backend is already up', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const healthCheck = vi.fn(async () => true);

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      runSystemctl,
      healthCheck,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, alreadyRunning: true, started: false, healthy: true, waitedMs: 0 });
    expect(runSystemctl).not.toHaveBeenCalled();
    expect(healthCheck).toHaveBeenCalledTimes(1);
    // Health is judged at the ROUTABLE address, not the unit's own port.
    expect(healthCheck).toHaveBeenCalledWith('http://127.0.0.1:11435');
  });

  it('starts the recorded unit and waits out a cold load', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    let probes = 0;
    const healthCheck = vi.fn(async () => ++probes > 4); // unhealthy for the first 4 probes

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, alreadyRunning: false, started: true, healthy: true });
    expect(result.waitedMs).toBe(4000); // 1 pre-probe + 4 polls at 1s
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'start', 'llama-ornith.service']);
  });

  it('gives up at readyTimeoutMs and leaves the unit RUNNING', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));

    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 30_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck: async () => false,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: false, started: true, healthy: false });
    expect(result.waitedMs).toBe(30_000);
    expect(result.error).toMatch(/did not answer/);
    // A part-loaded model is worth more than a clean slate — no stop on the way out.
    expect(JSON.stringify(runSystemctl.mock.calls)).not.toContain('stop');
  });

  it('REFUSES to start a backend with no recorded unit (after finding it unhealthy)', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const result = await ensureLocalBackendRunning(
      { ...ORNITH, unitName: null },
      { readyTimeoutMs: 600_000, runSystemctl, healthCheck: async () => false, ...fakeClock() },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no unitName recorded/);
    expect(runSystemctl).not.toHaveBeenCalled();
  });

  it('propagates a start failure rather than waiting out the full timeout', async () => {
    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      runSystemctl: async () => {
        throw new Error('Failed to start llama-ornith.service: Unit not found.');
      },
      healthCheck: async () => false,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: false, started: false, healthy: false });
    expect(result.error).toMatch(/Unit not found/);
    expect(result.waitedMs).toBe(0);
  });
});

/**
 * The same backend as ORNITH above, but carrying the registry fields the cold-start audit needs
 * (D-016). Kept SEPARATE from ORNITH on purpose: the tests above construct a target without them
 * and must keep working, because every pre-D-016 call site does.
 */
const ORNITH_AUDITABLE: BackendLifecycleTarget = {
  ...ORNITH,
  kind: 'llama-server',
  models: ['maxwell1500/ornith-35b:IQ3_M', 'ornith'],
};

/** A unit matching the ornith catalog entry on every audited dimension. */
const HEALTHY_UNIT = `[Service]
Environment=LD_LIBRARY_PATH=/usr/local/lib/ollama/cuda_v13:/usr/local/lib/ollama
Environment=GGML_BACKEND_PATH=/usr/local/lib/ollama/cuda_v13/libggml-cuda.so
ExecStart=/usr/local/lib/ollama/llama-server \\
  -m /blobs/sha256-deadbeef \\
  --host 127.0.0.1 --port 11436 \\
  --flash-attn on \\
  -ngl auto \\
  --fit on --fit-target 1024 \\
  -np 2 -c 180224 \\
  --cache-type-k q8_0 --cache-type-v q8_0 \\
  --alias maxwell1500/ornith-35b:IQ3_M
`;

/** The D-012 failure: identical on every compared PARAM, but silently CPU-only. */
const CPU_FALLBACK_UNIT = HEALTHY_UNIT.split('\n')
  .filter((l) => !l.startsWith('Environment=GGML_BACKEND_PATH'))
  .join('\n');

const accessOk = async () => {};

describe('ensureLocalBackendRunning — cold-start unit audit (WI-39735 / D-016)', () => {
  it('WARNS about a degraded unit and STARTS IT ANYWAY', async () => {
    // The load-bearing assertion of the whole wiring: a degraded backend still serves, so refusing
    // to start one converts every false positive in the guard into an outage. If someone later
    // makes the audit fatal, this test is what says no.
    const runSystemctl = vi.fn(async () => ({ stdout: CPU_FALLBACK_UNIT, stderr: '' }));
    const onUnitAudit = vi.fn();

    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      onUnitAudit,
      access: accessOk,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, started: true, healthy: true });
    expect(runSystemctl).toHaveBeenCalledWith(['--user', 'start', 'llama-ornith.service']);
    expect(onUnitAudit).toHaveBeenCalledTimes(1);
    expect(onUnitAudit.mock.calls[0][0]).toMatchObject({ verdict: 'degraded' });
    expect(result.unitAudit?.envIssues.map((i) => i.key)).toEqual(['GGML_BACKEND_PATH']);
  });

  it('reads the DEPLOYED unit with `systemctl cat`, BEFORE issuing the start', async () => {
    // Ordering is not cosmetic: the binary check explains a 203/EXEC start failure, and the start
    // failure path returns early — so an audit sequenced after the start would never be emitted in
    // exactly the case it diagnoses.
    const calls: string[][] = [];
    const runSystemctl = vi.fn(async (args: string[]) => {
      calls.push(args);
      return { stdout: HEALTHY_UNIT, stderr: '' };
    });

    await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl,
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      access: accessOk,
      ...fakeClock(),
    });

    expect(calls[0]).toEqual(['--user', 'cat', 'llama-ornith.service']);
    expect(calls[1]).toEqual(['--user', 'start', 'llama-ornith.service']);
  });

  it('does NOT audit on the warm path — no subprocess when the backend is already up', async () => {
    const runSystemctl = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const onUnitAudit = vi.fn();

    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      runSystemctl,
      healthCheck: async () => true,
      onUnitAudit,
      ...fakeClock(),
    });

    expect(result.alreadyRunning).toBe(true);
    expect(runSystemctl).not.toHaveBeenCalled();
    expect(onUnitAudit).not.toHaveBeenCalled();
    // `undefined` here means NOT CHECKED. It must never be read as "checked and clean" — which is
    // why the audit's own "checked, could not conclude" is the explicit `unauditable` verdict.
    expect(result.unitAudit).toBeUndefined();
  });

  it('reports a clean unit too, so a passing guard is distinguishable from an absent one', async () => {
    const onUnitAudit = vi.fn();
    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl: async () => ({ stdout: HEALTHY_UNIT, stderr: '' }),
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      onUnitAudit,
      access: accessOk,
      ...fakeClock(),
    });

    expect(onUnitAudit).toHaveBeenCalledTimes(1);
    expect(result.unitAudit?.verdict).toBe('ok');
  });

  it('a broken audit CANNOT break the start — unreadable unit', async () => {
    // A guard that can take down the thing it guards is worse than no guard.
    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl: async () => ({ stdout: '', stderr: '' }),
      readUnitText: async () => {
        throw new Error('systemctl: command not found');
      },
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, started: true, healthy: true });
    expect(result.unitAudit).toMatchObject({ verdict: 'unauditable' });
    expect(result.unitAudit?.summary).toMatch(/could not run/);
  });

  it('a throwing REPORTER cannot break the start either', async () => {
    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl: async () => ({ stdout: HEALTHY_UNIT, stderr: '' }),
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      onUnitAudit: () => {
        throw new Error('log sink exploded');
      },
      access: accessOk,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: true, started: true, healthy: true });
  });

  it('a backend with no model refs is UNAUDITABLE, not silently clean', async () => {
    // ORNITH (no models/kind) is every pre-D-016 call site. It must keep working — and must not
    // report a pass it never performed.
    const result = await ensureLocalBackendRunning(ORNITH, {
      readyTimeoutMs: 600_000,
      pollIntervalMs: 1000,
      runSystemctl: async () => ({ stdout: HEALTHY_UNIT, stderr: '' }),
      healthCheck: (() => {
        let probes = 0;
        return async () => ++probes > 1;
      })(),
      ...fakeClock(),
    });

    expect(result.ok).toBe(true);
    expect(result.unitAudit?.verdict).toBe('unauditable');
  });

  it('names the audit verdict in the TIMEOUT error — the two failures look identical from outside', async () => {
    const result = await ensureLocalBackendRunning(ORNITH_AUDITABLE, {
      readyTimeoutMs: 30_000,
      pollIntervalMs: 1000,
      runSystemctl: async () => ({ stdout: CPU_FALLBACK_UNIT, stderr: '' }),
      healthCheck: async () => false,
      access: accessOk,
      ...fakeClock(),
    });

    expect(result).toMatchObject({ ok: false, started: true, healthy: false });
    expect(result.error).toMatch(/did not answer/);
    expect(result.error).toMatch(/unit audit:/);
    expect(result.error).toMatch(/GGML_BACKEND_PATH/);
  });
});
