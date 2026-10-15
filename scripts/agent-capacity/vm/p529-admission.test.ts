import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const VM = __dirname;

describe('vm/p529-admission.sh (faked p005-ramp.sh, real shim installer)', () => {
  let home: string;
  const vmDir = () => path.join(home, 'capacity', 'scripts', 'agent-capacity', 'vm');
  const bin = () => path.join(home, '.cache', 'agent-capacity', 'prepared', 'papercusp', 'node_modules', '.bin');
  const tmp = () => path.join(home, 'p529tmp');

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p529-'));
    mkdirSync(vmDir(), { recursive: true });
    mkdirSync(path.join(home, 'capacity', 'fp'));
    for (const f of ['p529-admission.sh', 'install-heavy-shim.sh', 'heavy-shim.sh']) copyFileSync(path.join(VM, f), path.join(vmDir(), f));
    mkdirSync(path.join(bin(), '..', 'vitest'), { recursive: true });
    mkdirSync(bin());
    writeFileSync(path.join(bin(), '..', 'vitest', 'vitest.mjs'), '#!/usr/bin/env bash\n');
    symlinkSync('../vitest/vitest.mjs', path.join(bin(), 'vitest'));
    // Stand-in pc-heavy in the prepared checkout: creates the pool dir and admits at once.
    const pch = path.join(bin(), '..', '..', 'scripts', 'pc-heavy.sh');
    mkdirSync(path.dirname(pch));
    writeFileSync(pch, '#!/usr/bin/env bash\n[ "$1" = -- ] && shift\nmkdir -p "$PC_HEAVY_DIR"\nPC_HEAVY_BYPASS=1 exec "$@"\n');
    // Fake `codex sandbox -c … -- <cmd>`; FAKE_PRIVATE_TMP simulates a sandbox with its own /tmp.
    mkdirSync(path.join(home, 'bin'));
    writeFileSync(
      path.join(home, 'bin', 'codex'),
      '#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done; shift\n' +
        '[ -n "${FAKE_PRIVATE_TMP:-}" ] && export PC_HEAVY_DIR="$FAKE_PRIVATE_TMP/slots" PC_HEAVY_SHIM_LOG="$FAKE_PRIVATE_TMP/shim.jsonl"\nexec "$@"\n',
    );
    chmodSync(path.join(home, 'bin', 'codex'), 0o755);
    // The P-019 recordings' own tasks.json, placed beside them in the corpus.
    mkdirSync(path.join(home, '.cache', 'agent-capacity', 'corpus'), { recursive: true });
    writeFileSync(path.join(home, '.cache', 'agent-capacity', 'corpus', 'tasks.json'), '{"version":1,"tasks":[]}\n');
    // The fake ramp records, per arm, the tasks file and PC_HEAVY_* env it saw and whether
    // .bin/vitest was the shim; arm B also writes two request/admit pairs (waits 0.5 and 4) into
    // the shim log. FAKE_ARM_A_RC makes arm A exit with that code (3 = the driver could not run).
    const ramp = path.join(vmDir(), 'p005-ramp.sh');
    writeFileSync(
      ramp,
      [
        '#!/usr/bin/env bash',
        `shim=$(grep -c PC_HEAVY_SHIM_V1 "${bin()}/vitest" 2>/dev/null || true)`,
        'echo "ARM $1 sel=$2 steps=$3 dur=$4 shim=${shim:-0} tasks=${TASKS_FILE:-} env=$(env | grep ^PC_HEAVY_ | sort | tr \'\\n\' \' \')" >> "$HOME/ramp.log"',
        '[ "$1" = p529-a ] && [ -n "${FAKE_ARM_A_RC:-}" ] && exit "$FAKE_ARM_A_RC"',
        'if [ -n "${PC_HEAVY_SHIM_LOG:-}" ]; then',
        '  printf \'%s\\n\' \'{"ev":"request","bin":"vitest","id":"a","t":1}\' \'{"ev":"admit","bin":"vitest","id":"a","t":1.5,"waitSec":0.500}\' \\',
        '    \'{"ev":"request","bin":"tsc","id":"b","t":2}\' \'{"ev":"admit","bin":"tsc","id":"b","t":6,"waitSec":4.000}\' \\',
        '    \'{"ev":"request","bin":"tsc","id":"c","t":7}\' >> "$PC_HEAVY_SHIM_LOG"',
        'fi',
      ].join('\n') + '\n',
    );
    chmodSync(ramp, 0o755);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('ramps arm A without the shim or any pc-heavy env, then arm B with the shim and a fixed K pool, and cleans up', () => {
    const out = execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12 18', '300'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), PC_HEAVY_BYPASS: '1', PC_HEAVY_SLOTS: '99' },
    });
    expect(out).toMatch(/^P529_PREFLIGHT_OK pool=\S+\/slots-k3$/m);
    const arms = readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n');
    expect(arms).toHaveLength(2);
    const tasks = path.join(home, '.cache', 'agent-capacity', 'corpus', 'tasks.json');
    expect(arms[0]).toBe(`ARM p529-a sel=all steps=12 18 dur=300 shim=0 tasks=${tasks} env=`);
    expect(arms[1]).toMatch(new RegExp(`^ARM p529-k3 sel=all steps=12 18 dur=300 shim=1 tasks=${tasks.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} env=`));
    for (const kv of [
      'PC_HEAVY_SLOTS=3 ',
      `PC_HEAVY_DIR=${tmp()}/slots-k3 `,
      'PC_HEAVY_MEM_CLAMP=0 ',
      'PC_HEAVY_PSI_ADMISSION=0 ',
      'PC_HEAVY_COALESCE=0 ',
      'PC_HEAVY_TIMEOUT_SEC=7200 ',
      `PC_HEAVY_SHIM_LOG=${tmp()}/shim-k3.jsonl `,
    ])
      expect(`${arms[1]} `).toContain(kv); // the log's trim() ate the last var's trailing space
    expect(arms[1]).not.toContain('PC_HEAVY_BYPASS');

    expect(out).toMatch(/^P529_SHIM requests=3 admitted=2 unadmitted=1 wait_p50=4\.0 wait_p90=4\.0 wait_max=4\.0$/m);
    expect(out).toMatch(/^P529_DONE /m);
    // The shim is gone afterwards: the prepared checkout is back to its original symlink.
    expect(out).toMatch(/^HEAVY_SHIM_REMOVED name=vitest$/m);
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
    expect(readFileSync(path.join(home, 'capacity', 'fp', 'p529-shim-k3.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
  });

  it('P529_ARMS=b with P529_MEM_PER_SLOT_GIB skips arm A and runs a memory-clamped arm under its own label', () => {
    const out = execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '16', '24 32', '600'], {
      encoding: 'utf8',
      cwd: home,
      env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), P529_ARMS: 'b', P529_MEM_PER_SLOT_GIB: '6' },
    });
    expect(out).toMatch(/^P529_START k=16 mem_per_slot_gib=6 arms=b /m);
    expect(out).not.toMatch(/arm=a/);
    expect(out).toMatch(/^P529_PREFLIGHT_OK pool=\S+\/slots-k16m6$/m);
    const arms = readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n');
    expect(arms).toHaveLength(1);
    expect(arms[0]).toMatch(/^ARM p529-k16m6 sel=all steps=24 32 dur=600 shim=1 /);
    for (const kv of ['PC_HEAVY_SLOTS=16 ', 'PC_HEAVY_MEM_CLAMP=1 ', 'PC_HEAVY_MEM_PER_SLOT_GIB=6 ', 'PC_HEAVY_PSI_ADMISSION=0 ', `PC_HEAVY_DIR=${tmp()}/slots-k16m6 `])
      expect(`${arms[0]} `).toContain(kv);
    expect(out).toMatch(/^P529_ARM_END arm=k16m6 rc=0 /m);
    expect(readFileSync(path.join(home, 'capacity', 'fp', 'p529-shim-k16m6.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
  });

  it('P529_MEM_PER_SLOT_GIB=derived keeps the clamp on with no fixed reserve, overlays pc-heavy for the arm only, and reports the D-030 derived reserve (WI-10005184)', () => {
    const pch = path.join(bin(), '..', '..', 'scripts', 'pc-heavy.sh');
    const original = readFileSync(pch, 'utf8');
    const overlay = path.join(home, 'pc-heavy-new.sh');
    writeFileSync(overlay, `${original}# OVERLAY_MARK\n`);
    const seed = path.join(home, 'seed.tsv');
    writeFileSync(seed, 'at=100 anon_mib=1000 rss_mib=1200 samples=5 secs=10 exit=0 label=seed\n');
    // The ramp stands in for pc-heavy's monitor: 11 measured jobs (max 9000 MiB) plus two rows the
    // D-030 rule must ignore (one sample only; a label carrying a decoy samples=/anon_mib= token).
    const rows = [...Array.from({ length: 10 }, (_, i) => 2000 + i * 100), 9000]
      .map((mib, i) => `at=${200 + i} anon_mib=${mib} rss_mib=${mib + 500} samples=4 secs=8 exit=0 label=npx vitest run`)
      .concat([
        'at=300 anon_mib=50000 rss_mib=50000 samples=1 secs=1 exit=0 label=npx tsc',
        'at=301 anon_mib=100 rss_mib=100 samples=2 secs=4 exit=0 label=x samples=99 anon_mib=99999',
      ]);
    writeFileSync(
      path.join(vmDir(), 'p005-ramp.sh'),
      `${readFileSync(path.join(vmDir(), 'p005-ramp.sh'), 'utf8')}echo "OVERLAY=$(grep -c OVERLAY_MARK '${pch}' || true)" >> "$HOME/ramp.log"\n` +
        `[ -n "\${PC_HEAVY_PEAK_LEDGER:-}" ] && printf '%s\\n' ${rows.map((r) => `'${r}'`).join(' ')} >> "$PC_HEAVY_PEAK_LEDGER"\n`,
    );
    const out = execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '16', '32 40', '600'], {
      encoding: 'utf8',
      cwd: home,
      env: {
        ...process.env,
        PATH: `${home}/bin:${process.env.PATH}`,
        HOME: home,
        P529_TMP: tmp(),
        P529_ARMS: 'b',
        P529_MEM_PER_SLOT_GIB: 'derived',
        P529_PC_HEAVY_OVERLAY: overlay,
        P529_PEAK_SEED: seed,
      },
    });
    const pool = `${tmp()}/slots-k16mderived`;
    expect(out).toMatch(new RegExp(`^P529_DERIVED ledger=${pool}/job-peaks\\.tsv min_span_sec=0 seed=${seed}$`, 'm'));
    expect(out).toMatch(/^P529_OVERLAY pc-heavy=\S+ sha256=[0-9a-f]{16}$/m);
    const log = readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n');
    expect(log[0]).toMatch(/^ARM p529-k16mderived sel=all steps=32 40 dur=600 shim=1 /);
    for (const kv of ['PC_HEAVY_MEM_CLAMP=1 ', 'PC_HEAVY_MEM_PER_SLOT_MIN_SPAN_SEC=0 ', `PC_HEAVY_PEAK_LEDGER=${pool}/job-peaks.tsv `])
      expect(`${log[0]} `).toContain(kv);
    expect(log[0]).not.toContain('PC_HEAVY_MEM_PER_SLOT_GIB=');
    expect(log[1]).toBe('OVERLAY=1');
    // seed row + 11 measured rows count; the 1-sample and 2-sample rows do not.
    expect(out).toMatch(/^P529_LEDGER rows_ge3=12 window=12 max_anon_mib=9000 derived_gib=10$/m);
    expect(readFileSync(path.join(home, 'capacity', 'fp', 'p529-peaks-k16mderived.tsv'), 'utf8')).toContain('anon_mib=9000');
    expect(out).toMatch(/^P529_OVERLAY_RESTORED$/m);
    expect(readFileSync(pch, 'utf8')).toBe(original);
  });

  it('restores the prepared pc-heavy even when the arm aborts at the sandbox preflight', () => {
    const pch = path.join(bin(), '..', '..', 'scripts', 'pc-heavy.sh');
    const original = readFileSync(pch, 'utf8');
    const overlay = path.join(home, 'pc-heavy-new.sh');
    writeFileSync(overlay, `${original}# OVERLAY_MARK\n`);
    let err: { status?: number; stdout?: string } = {};
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '16', '32', '600'], {
        encoding: 'utf8',
        cwd: home,
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${home}/bin:${process.env.PATH}`,
          HOME: home,
          P529_TMP: tmp(),
          P529_ARMS: 'b',
          P529_MEM_PER_SLOT_GIB: 'derived',
          P529_PC_HEAVY_OVERLAY: overlay,
          FAKE_PRIVATE_TMP: path.join(home, 'private'),
        },
      });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(4);
    expect(err.stdout).toMatch(/^P529_OVERLAY_RESTORED$/m);
    expect(readFileSync(pch, 'utf8')).toBe(original);
  });

  it.each([
    ['P529_ARMS', 'a'],
    ['P529_PC_HEAVY_OVERLAY', '/nonexistent/pc-heavy.sh'],
    ['P529_MEM_PER_SLOT_GIB', '0'],
    ['P529_MEM_PER_SLOT_GIB', 'x6'],
  ])('refuses %s=%s before touching the prepared checkout', (k, v) => {
    let err: { status?: number; stderr?: string } = {};
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12'], { encoding: 'utf8', env: { ...process.env, HOME: home, P529_TMP: tmp(), [k]: v }, stdio: 'pipe' });
    } catch (e) {
      err = e as typeof err;
    }
    expect(err.status).toBe(2);
    expect(err.stderr).toContain(`P529_ERROR ${k}`);
    expect(() => readFileSync(path.join(home, 'ramp.log'), 'utf8')).toThrow();
  });

  it('aborts before arm B, and removes the shim, when the Codex sandbox cannot reach the shared pool', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12', '300'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), FAKE_PRIVATE_TMP: path.join(home, 'private-tmp') },
      });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(4);
    expect(stderr).toMatch(/P529_ERROR codex sandbox does not share the admission pool: out="pch-ok"/);
    expect(readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n')).toHaveLength(1); // arm A only
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
  });

  it('stops before arm B, with the shim never installed, when arm A’s driver could not run', () => {
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12', '300'], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, PATH: `${home}/bin:${process.env.PATH}`, HOME: home, P529_TMP: tmp(), FAKE_ARM_A_RC: '3' },
      });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(5);
    expect(stderr).toMatch(/P529_ERROR arm=a driver did not run, stopping before arm B/);
    expect(readFileSync(path.join(home, 'ramp.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(bin(), 'vitest'), 'utf8')).not.toContain('PC_HEAVY_SHIM_V1');
  });

  it('refuses to start without the recordings’ tasks file', () => {
    rmSync(path.join(home, '.cache', 'agent-capacity', 'corpus'), { recursive: true, force: true });
    let code = 0;
    let stderr = '';
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12'], { encoding: 'utf8', env: { ...process.env, HOME: home, P529_TMP: tmp() }, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
      stderr = String((e as { stderr: string }).stderr);
    }
    expect(code).toBe(2);
    expect(stderr).toMatch(/P529_ERROR no tasks file at \S+\/corpus\/tasks\.json/);
  });

  it('refuses to start without a prepared checkout', () => {
    rmSync(path.join(home, '.cache'), { recursive: true, force: true });
    let code = 0;
    try {
      execFileSync('bash', [path.join(vmDir(), 'p529-admission.sh'), '3', '12'], { encoding: 'utf8', env: { ...process.env, HOME: home, P529_TMP: tmp() }, stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(2);
  });
});
