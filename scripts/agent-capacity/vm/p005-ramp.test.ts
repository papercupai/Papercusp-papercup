import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the test at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'p005-ramp.sh');

describe('vm/p005-ramp.sh (faked systemd-run/systemctl/npx and the sampler)', () => {
  let home: string;
  const bin = () => path.join(home, 'bin');
  const slice = () => path.join(home, 'slice');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin(), name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(bin(), name), 0o755);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'p005-ramp-'));
    mkdirSync(bin());
    mkdirSync(slice());
    mkdirSync(path.join(home, 'capacity'));
    writeFileSync(path.join(slice(), 'memory.events'), 'oom 0\noom_kill 0\n');
    stub('systemd-run', `echo "$@" >> "${home}/systemd-run.log"`);
    stub('systemctl', `echo "$@" >> "${home}/systemctl.log"`);
    // The sampler would run for the whole window; the verdict step needs the real python3.
    stub('python3', `case "$1" in *sample-footprint.py) exec sleep 120 ;; *) exec /usr/bin/python3 "$@" ;; esac`);
    // load-driver: `--check` (the preflight) is logged to check.log and passes unless FAKE_CHECK_FAIL
    // is set; a step writes summary.json for the run (every slot held, so not UNDERDRIVEN);
    // FAKE_SLOW_AT / FAKE_OOM_AT pick the bad step.
    stub(
      'npx',
      `case " $* " in *" --check "*)
  echo "$@" >> "${home}/check.log"
  # The shape tsx really prints (measured, WI-10005355): a source excerpt naming Error comes FIRST.
  [ -n "\${FAKE_CHECK_FAIL:-}" ] && { printf '%s\\n' 'node:internal/modules/cjs/loader:1475' '  const err = new Error(message);' '              ^' '' "Error: Cannot find module '@papercusp/operator-core/lib/child-output'" >&2; exit 1; }
  echo "DRIVER_CHECK_OK sessions=6 corpus=x tasks=6"; exit 0 ;;
esac
echo "$@" >> "${home}/npx.log"
[ -n "\${FAKE_DRIVER_SLEEP:-}" ] && sleep "\${FAKE_DRIVER_SLEEP}"
n=""; run=""
while [ $# -gt 0 ]; do case "$1" in --agents) n=$2; shift;; --run-id) run=$2; shift;; esac; shift; done
slow=1.05; clean=$n
[ -n "\${FAKE_SLOW_AT:-}" ] && [ "$n" -ge "$FAKE_SLOW_AT" ] && slow=2.4
# load-driver's real shape when every run diverged (shared tree): no clean run, wallSlowdown null.
[ -n "\${FAKE_UNMEASURED_AT:-}" ] && [ "$n" -ge "$FAKE_UNMEASURED_AT" ] && { slow=null; clean=0; }
[ -n "\${FAKE_OOM_AT:-}" ] && [ "$n" -ge "$FAKE_OOM_AT" ] && printf 'oom 1\\noom_kill 1\\n' > "${slice()}/memory.events"
d="$HOME/.cache/agent-capacity/runs/$run"; mkdir -p "$d"
printf '{"runs":%s,"clean":%s,"failed":0,"diverged":0,"toolDiverged":0,"wallSlowdown":%s,"achievedConcurrency":{"mean":%s,"target":%s,"fraction":1}}' "$n" "$clean" "$slow" "$n" "$n" > "$d/summary.json"`,
    );
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, HOME: home, PATH: `${bin()}:${process.env.PATH}`, CAPDRV_SLICE_DIR: slice(), ...env },
    });

  it('runs every step with N agents for the window and the selection, when nothing saturates', () => {
    const r = run({}, 'claude-normal', 'cli=claude,profile=light', '1 2 4', '300');
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(path.join(home, 'npx.log'), 'utf8').trim().split('\n');
    expect(calls).toEqual(
      [1, 2, 4].map(
        (n) =>
          `tsx scripts/agent-capacity/load-driver.ts --agents ${n} --duration-sec 300 --stagger-ms 1000 --select cli=claude,profile=light --run-id p005-claude-normal-n${n} --isolation systemd --workdir overlay`,
      ),
    );
    // One preflight, with the same selection, before the first step.
    expect(readFileSync(path.join(home, 'check.log'), 'utf8').trim().split('\n')).toEqual([
      'tsx scripts/agent-capacity/load-driver.ts --check --select cli=claude,profile=light --workdir overlay',
    ]);
    expect(r.stdout).toMatch(/RAMP_PREFLIGHT_OK claude-normal DRIVER_CHECK_OK sessions=6/);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-claude-normal-n4 n=4 rc=0 OK runs=4 clean=4 wallSlowdown=1.05/);
    expect(r.stdout).not.toMatch(/RAMP_SATURATED/);
    expect(r.stdout).toMatch(/RAMP_DONE claude-normal/);
  });

  it('"all" passes no --select, and the ramp stops at the first step past the slowdown limit', () => {
    const r = run({ FAKE_SLOW_AT: '4' }, 'mixed', 'all', '1 2 4 8 16');
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(path.join(home, 'npx.log'), 'utf8').trim().split('\n');
    expect(calls).toHaveLength(3);
    expect(calls[0]).not.toMatch(/--select/);
    expect(calls[0]).toMatch(/--duration-sec 600 /);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n4 n=4 rc=0 SATURATED reason=wallSlowdown=2.40/);
    expect(r.stdout).toMatch(/RAMP_SATURATED mixed n=4/);
  });

  it('an unmeasured wallSlowdown (null: no clean, non-diverged run) prints as na with clean=0, never as 0.00', () => {
    // WI-10005448: `or 0` used to print null as wallSlowdown=0.00, which reads as "no slowdown".
    const r = run({ FAKE_UNMEASURED_AT: '2' }, 'shared', 'all', '1 2 4');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-shared-n1 n=1 rc=0 OK runs=1 clean=1 wallSlowdown=1.05 /);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-shared-n2 n=2 rc=0 OK runs=2 clean=0 wallSlowdown=na /);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-shared-n4 n=4 rc=0 OK runs=4 clean=0 wallSlowdown=na /);
    expect(r.stdout).not.toMatch(/wallSlowdown=0\.00/);
    // The other saturation criteria still decide; an unmeasured slowdown alone neither saturates nor stops the ramp.
    expect(r.stdout).toMatch(/RAMP_DONE shared/);
  });

  it('an unmeasured wallSlowdown does not mask another saturation criterion', () => {
    const r = run({ FAKE_UNMEASURED_AT: '2', FAKE_OOM_AT: '2' }, 'shared', 'all', '1 2 4');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-shared-n2 n=2 rc=0 SATURATED reason=oom_kill=1 runs=2 clean=0 wallSlowdown=na /);
    expect(r.stdout).toMatch(/RAMP_SATURATED shared n=2/);
  });

  it('an OOM kill in the slice during a step saturates it', () => {
    const r = run({ FAKE_OOM_AT: '2' }, 'codex-heavy', 'cli=codex,profile=heavy', '1 2 4');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-codex-heavy-n1 n=1 rc=0 OK/);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-codex-heavy-n2 n=2 rc=0 SATURATED reason=oom_kill=1/);
    expect(r.stdout).toMatch(/RAMP_SATURATED codex-heavy n=2/);
  });

  it('a driver that dies late with no summary saturates the step, not silently passed', () => {
    stub('npx', `case " $* " in *" --check "*) echo DRIVER_CHECK_OK; exit 0 ;; esac; exit 7`);
    const r = run({ RAMP_ERROR_SEC: '0' }, 'mixed', 'all', '1 2');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n1 n=1 rc=7 SATURATED reason=no-summary,driver-rc=7/);
    expect(r.stdout).toMatch(/RAMP_SATURATED mixed n=1/);
    expect(r.stdout).not.toMatch(/p005-mixed-n2/);
  });

  it('a driver that dies at once with no summary is a DRIVER_ERROR, not a saturation, and fails the ramp', () => {
    // P-529, 2026-10-01: a missing module ended both arms at n=12 in one second as "SATURATED".
    stub('npx', `case " $* " in *" --check "*) echo DRIVER_CHECK_OK; exit 0 ;; esac; exit 1`);
    const r = run({}, 'mixed', 'all', '1 2');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/RAMP_STEP_END p005-mixed-n1 n=1 rc=1 DRIVER_ERROR reason=no-summary,driver-rc=1,elapsed=\d+s/);
    expect(r.stdout).toMatch(/RAMP_DRIVER_ERROR mixed n=1/);
    expect(r.stdout).not.toMatch(/RAMP_SATURATED/);
    expect(r.stdout).not.toMatch(/p005-mixed-n2/);
  });

  it('a driver that fails its preflight stops the ramp before any step, with the real error', () => {
    const r = run({ FAKE_CHECK_FAIL: '1' }, 'mixed', 'all', '1 2');
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/RAMP_PREFLIGHT_FAILED mixed Error: Cannot find module '@papercusp\/operator-core\/lib\/child-output'/);
    expect(r.stdout).not.toMatch(/RAMP_STEP_START/);
    expect(() => readFileSync(path.join(home, 'npx.log'), 'utf8')).toThrow();
  });

  it('AGENT_ENV reaches every step as --agent-env, and a shared tree reports its drift per step', () => {
    const r = run({ AGENT_ENV: 'PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE=papercusp-tsc-service', WORKDIR: 'shared' }, 'p529-b', 'all', '12');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(home, 'npx.log'), 'utf8')).toContain(
      '--run-id p005-p529-b-n12 --isolation systemd --workdir shared --agent-env PAPERCUSP_TSC_SERVICE_UNIT_TEMPLATE=papercusp-tsc-service',
    );
    expect(r.stdout).toMatch(/^RAMP_SHARED_TREE run=p005-p529-b-n12 dirty=\d+ lock_reaps=0$/m);
  });

  // EI-24863025873375990: a shared tree runs no git-sync, so a stale index.lock must be reaped by the ramp.
  describe('shared tree: stale index.lock reaper', () => {
    const tree = () => path.join(home, '.cache', 'agent-capacity', 'prepared', 'papercusp');
    const lock = () => path.join(tree(), '.git', 'index.lock');
    const plantLock = (ageSec: number) => {
      mkdirSync(path.join(tree(), '.git'), { recursive: true });
      writeFileSync(lock(), '');
      const t = Date.now() / 1000 - ageSec;
      utimesSync(lock(), t, t);
    };
    const reapEnv = { WORKDIR: 'shared', LOCK_REAP_SEC: '1', FAKE_DRIVER_SLEEP: '2' };

    it('reaps a lock older than STALE_LOCK_SEC with no git inside the tree, and counts it on the step line', () => {
      plantLock(200);
      const r = run(reapEnv, 'p529-b', 'all', '12');
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(lock())).toBe(false);
      expect(r.stdout).toMatch(/^RAMP_SHARED_TREE run=p005-p529-b-n12 dirty=\d+ lock_reaps=1$/m);
      expect(readFileSync(path.join(home, 'capacity', 'fp', 'p005-p529-b-n12.lock-reaps.log'), 'utf8')).toMatch(
        /reaped .*index\.lock age=\d+s/,
      );
    });

    it('keeps a lock younger than STALE_LOCK_SEC (a live writer may hold it)', () => {
      plantLock(5);
      const r = run(reapEnv, 'p529-b', 'all', '12');
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(lock())).toBe(true);
      expect(r.stdout).toMatch(/lock_reaps=0$/m);
    });

    it('keeps an old lock while a git process runs inside the tree', () => {
      plantLock(200);
      // A process whose comm is exactly "git" (a #!/bin/bash script named git) with its cwd in the tree.
      const holderDir = path.join(home, 'holder');
      mkdirSync(holderDir);
      writeFileSync(path.join(holderDir, 'git'), '#!/bin/bash\nsleep 30\n');
      chmodSync(path.join(holderDir, 'git'), 0o755);
      const holder = spawn(path.join(holderDir, 'git'), [], { cwd: tree(), stdio: 'ignore' });
      try {
        const r = run(reapEnv, 'p529-b', 'all', '12');
        expect(r.status, r.stderr).toBe(0);
        expect(existsSync(lock())).toBe(true);
        expect(r.stdout).toMatch(/lock_reaps=0$/m);
      } finally {
        holder.kill('SIGKILL');
      }
    });

    it('a private workdir runs no reaper, even with a stale lock in the prepared tree', () => {
      plantLock(200);
      const r = run({ LOCK_REAP_SEC: '1', FAKE_DRIVER_SLEEP: '2' }, 'p529-a', 'all', '12');
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(lock())).toBe(true);
    });
  });

  it('without AGENT_ENV no --agent-env is passed, and a private workdir prints no shared-tree line', () => {
    const r = run({}, 'p529-a', 'all', '12');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(home, 'npx.log'), 'utf8')).not.toContain('--agent-env');
    expect(r.stdout).not.toContain('RAMP_SHARED_TREE');
  });

  it('TASKS_FILE reaches the preflight and every step as --tasks-file', () => {
    const r = run({ TASKS_FILE: '/corpus/tasks.json' }, 'p529-a', 'all', '12');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(path.join(home, 'check.log'), 'utf8')).toContain('--check --tasks-file /corpus/tasks.json --workdir overlay');
    expect(readFileSync(path.join(home, 'npx.log'), 'utf8')).toContain('--duration-sec 600 --stagger-ms 1000 --tasks-file /corpus/tasks.json --run-id p005-p529-a-n12');
  });

  const parkedArgs = () =>
    readFileSync(path.join(home, 'npx.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.match(/--parked (\S+) --park-at-request (\S+) --release-at-sec (\S+)/)?.slice(1) ?? null);

  it('a fixed PARKED reaches every step as --parked, released at 60% of the step by default', () => {
    const r = run({ PARKED: '16' }, 'p015-none', 'all', '12 24', '600');
    expect(r.status, r.stderr).toBe(0);
    expect(parkedArgs()).toEqual([
      ['16', '4', '360'],
      ['16', '4', '360'],
    ]);
    expect(r.stdout).toMatch(/^RAMP_STEP_PARKED p005-p015-none-n24 parked=16 release_at_sec=360$/m);
  });

  it('PARKED_PER_ACTIVE scales the parked sessions with each step (rounded) and overrides PARKED', () => {
    const r = run({ PARKED: '16', PARKED_PER_ACTIVE: '1.9', PARK_RELEASE_SEC: '570' }, 'p016-mix', 'all', '1 2 4 10', '600');
    expect(r.status, r.stderr).toBe(0);
    // 1.9 x n rounded: 1.9 -> 2, 3.8 -> 4, 7.6 -> 8, 19 -> 19.
    expect(parkedArgs().map((a) => a?.[0])).toEqual(['2', '4', '8', '19']);
    expect(parkedArgs().every((a) => a?.[2] === '570')).toBe(true);
    expect(r.stdout).toMatch(/^RAMP_STEP_PARKED p005-p016-mix-n10 parked=19 release_at_sec=570$/m);
  });

  it('a ratio that rounds to zero parks nothing for that step', () => {
    const r = run({ PARKED_PER_ACTIVE: '0.3' }, 'p016-low', 'all', '1 4');
    expect(r.status, r.stderr).toBe(0);
    // 0.3 -> 0 (no --parked at all), 1.2 -> 1.
    expect(parkedArgs().map((a) => a?.[0] ?? null)).toEqual([null, '1']);
    expect(r.stdout).not.toMatch(/RAMP_STEP_PARKED p005-p016-low-n1 /);
  });

  it('a non-numeric PARKED_PER_ACTIVE is refused before the preflight or any step', () => {
    const r = run({ PARKED_PER_ACTIVE: 'two' }, 'p016-bad', 'all', '4');
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("RAMP_ERROR PARKED_PER_ACTIVE must be a non-negative number, got 'two'");
    expect(() => readFileSync(path.join(home, 'check.log'), 'utf8')).toThrow();
    expect(() => readFileSync(path.join(home, 'npx.log'), 'utf8')).toThrow();
  });
});
