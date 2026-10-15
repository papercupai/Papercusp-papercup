/** Regression coverage for serialize-and-slow-kopia-backups-2026-08-20. */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
} from '@papercusp/backup/application-names';

const systemdDir = fileURLToPath(new URL('../../../apps/operator/scripts/systemd/', import.meta.url));
const backupHealthCheckPath = fileURLToPath(
  new URL('../../../apps/operator/scripts/papercup-backup-health-check.sh', import.meta.url),
);
// Defaults to the real script, so every run here and on the gate is unchanged. The
// override exists so falsifiability can be proven WITHOUT mutating the shared tree:
// `scripts/mutation-probe.sh` copies this file out, mutates the copy, and passes its
// path in as `{}` (repo CLAUDE.md, "Proving a guard is falsifiable" — tier 2). Without
// it the only way to test a mutant is an in-tree edit, which git-sync can commit.
const guard = process.env.KOPIA_GUARD_SCRIPT_UNDER_TEST || join(systemdDir, 'kopia-backup-guard.sh');
// A copy-out subject MUST keep this basename. has_live_priority_waiter recognises a
// waiter by `kopia-backup-guard.sh` in its /proc cmdline, so a copy named e.g.
// `base.sh` fails the priority-handoff tests on the UNMUTATED program -- and in a
// mutation probe that reads as a caught mutant. Measured 2026-09-29 (WI-10003884):
// a base copy named base.sh failed 4 of 43. Refuse the run instead of lying.
if (basename(guard) !== 'kopia-backup-guard.sh') {
  throw new Error(
    `KOPIA_GUARD_SCRIPT_UNDER_TEST must be named kopia-backup-guard.sh (got ${basename(guard)}); ` +
      'copy it to <dir>/kopia-backup-guard.sh instead',
  );
}
const hotScriptPath = join(systemdDir, 'kopia-snapshot-all.sh');
const SCHEDULED_DEFER_EXIT = 75;
const tempDirs: string[] = [];

function pressureFile(path: string, fullAvg10: number): void {
  writeFileSync(
    path,
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${fullAvg10.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`,
  );
}

function fixture(memory = 0, io = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'kopia-guard-'));
  tempDirs.push(dir);
  const memoryPath = join(dir, 'memory.pressure');
  const ioPath = join(dir, 'io.pressure');
  pressureFile(memoryPath, memory);
  pressureFile(ioPath, io);
  return {
    dir,
    env: {
      ...process.env,
      GUARD: guard,
      KOPIA_BACKUP_LOCK_PATH: join(dir, 'global.lock'),
      // Per-fixture, and NOT optional. The guard's staleness floor keeps its
      // bookkeeping under $XDG_STATE_HOME/$HOME by default, so without this every
      // test would read and write the REAL host's backup state: tests would
      // pollute production bookkeeping, and — worse — become order-dependent on
      // it, since a stale baseline left by the host makes a deferral test admit.
      KOPIA_BACKUP_STATE_DIR: join(dir, 'state'),
      KOPIA_BACKUP_MEM_PSI_PATH: memoryPath,
      KOPIA_BACKUP_IO_PSI_PATH: ioPath,
      KOPIA_BACKUP_MEM_FULL_AVG10_MAX: '5',
      KOPIA_BACKUP_IO_FULL_AVG10_MAX: '10',
      KOPIA_BACKUP_MONITOR_INTERVAL_SEC: '0.05',
      // The guard's OWN production default (20s), not a shortened test value. This was '2',
      // which made the runtime-pressure test a bet on host scheduling latency: the grace is
      // how long a TERM'd child has to run its trap, and on a loaded box (this one carries
      // ~76 agents) a bash child is not always scheduled within 2s. Past the deadline the
      // guard escalates to `kill -KILL`, and bash then writes its own job-control notice —
      // `kopia-backup-guard.sh: line NNN: <pid> Killed "$@"` — to the script's stderr, which
      // `expect(stderr).toBe('')` reads as a failure. Measured on the gate: 8 CI failures
      // across candidates 8e567cf5 and 8b151666 (2026-09-02), passing locally every time.
      // Raising it costs NOTHING in the happy path: `stop_grace` is a DEADLINE, not a sleep —
      // the guard polls `kill -0` every 0.1s and breaks the moment the child exits. No test
      // asserts the `killing-after-grace` escalation, so nothing depends on the short value.
      KOPIA_BACKUP_STOP_GRACE_SEC: '20',
    },
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [guard, ...args], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

function readLog(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '(no log)';
}

async function waitForPath(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForOutput(read: () => string, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!read().includes(text)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for "${text}" in:\n${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProgressPhase(path: string, phase: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      last = readFileSync(path, 'utf8');
      const marker = JSON.parse(last) as Record<string, unknown>;
      if (marker.phase === phase) return marker;
    } catch {
      // The atomic rename can leave the previous marker visible for one turn.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for progress phase ${phase} in ${path}: ${last}`);
}

async function waitForKernelFlockBlock(pidPath: string, timeoutMs = 10_000): Promise<void> {
  await waitForPath(pidPath, timeoutMs);
  const pid = Number(readFileSync(pidPath, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('flock witness wrote an invalid pid: ' + readFileSync(pidPath, 'utf8'));
  }

  const procPath = '/proc/' + pid;
  const wchanPath = procPath + '/wchan';
  const deadline = Date.now() + timeoutMs;
  let lastWchan = 'unreadable';
  while (Date.now() < deadline) {
    if (!existsSync(procPath)) {
      throw new Error('flock process ' + pid + ' exited before entering the kernel lock wait');
    }
    try {
      lastWchan = readFileSync(wchanPath, 'utf8').trim();
    } catch {
      lastWchan = 'unreadable';
    }
    if (lastWchan === 'locks_lock_inode_wait') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    'timed out waiting for flock process ' + pid +
      ' to block in /proc wchan; last value was ' + JSON.stringify(lastWchan),
  );
}

// The guard logs its waiting result before it calls flock. The wrapper records
// the exec'd PID; waitForKernelFlockBlock verifies that the kernel has actually
// blocked it before a test releases the holder or starts measuring a long wait.
function witnessBlockingFlock(dir: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const pidPath = join(dir, 'contender-flock.pid');
  writeFileSync(join(bin, 'flock'), [
    '#!/bin/bash',
    'if [ "$#" = 1 ] && [ "$1" = 9 ]; then echo "$$" >"$CONTENDER_FLOCK_PID"; fi',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    pidPath,
    env: { PATH: `${bin}:${process.env.PATH}`, CONTENDER_FLOCK_PID: pidPath },
  };
}

async function stopFixtureGroup(child: ReturnType<typeof spawn>, closed: Promise<number | null>) {
  // These detached children own only their fixture process groups.
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  await closed;
}

async function contendWithFixtureHolder(fx: ReturnType<typeof fixture>, args: string[], waitReason?: string) {
  const { dir, env } = fx;
  const ready = join(dir, 'holder-ready');
  const release = join(dir, 'release-holder');
  const marker = join(dir, 'contender');
  const witness = witnessBlockingFlock(dir);
  const holder = spawn('bash', ['-c',
    'exec 9>>"$KOPIA_BACKUP_LOCK_PATH"; /usr/bin/flock 9; touch "$READY"; while [ ! -e "$RELEASE" ]; do sleep 0.01; done',
  ], { env: { ...env, READY: ready, RELEASE: release }, stdio: 'ignore', detached: true });
  const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let output = '';
  try {
    await waitForPath(ready);
    child = spawn('bash', [guard, ...args, '--', 'touch', marker],
      { env: { ...env, ...witness.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    closed = new Promise<number | null>((resolve) => child!.once('close', resolve));
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    if (waitReason) {
      await waitForKernelFlockBlock(witness.pidPath);
      await waitForOutput(() => output, `result=waiting reason=${waitReason}`);
      expect(existsSync(marker), output).toBe(false);
      expect(child.exitCode, output).toBeNull();
      writeFileSync(release, 'released after contender blocked');
    }
    const status = await closed;
    return { status, output, ran: existsSync(marker) };
  } finally {
    // A non-waiting contender must finish BEFORE this releases the holder too.
    writeFileSync(release, 'cleanup');
    if (child && closed) await stopFixtureGroup(child, closed);
    await stopFixtureGroup(holder, holderClosed);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Kopia global backup guard', () => {
  it('publishes a live db-dump marker while queued, advances it after lock acquisition, then removes it', async () => {
    const { dir, env } = fixture();
    const ready = join(dir, 'holder-ready');
    const release = join(dir, 'release-holder');
    const holder = spawn('bash', ['-c',
      'exec 9>>"$KOPIA_BACKUP_LOCK_PATH"; /usr/bin/flock 9; touch "$READY"; while [ ! -e "$RELEASE" ]; do sleep 0.01; done',
    ], { env: { ...env, READY: ready, RELEASE: release }, stdio: 'ignore', detached: true });
    const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    let output = '';
    try {
      await waitForPath(ready);
      child = spawn('bash', [
        guard,
        '--mode', 'scheduled',
        '--label', 'db-dump',
        '--no-restart-safe',
        '--priority-on-contention',
        '--',
        'bash', '-c', 'sleep 0.5',
      ], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      closed = new Promise<number | null>((resolve) => child!.once('close', resolve));
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });

      const markerPath = `${env.KOPIA_BACKUP_LOCK_PATH}.db-dump.${child.pid}.run`;
      await waitForPath(markerPath);
      const queued = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      expect(queued).toMatchObject({ pid: child.pid, phase: 'guard-queued' });
      expect(queued.processStartTicks).toMatch(/^\d+$/);
      expect(queued.startedAtEpoch).toBeTypeOf('number');
      await waitForOutput(() => output, 'result=waiting reason=priority-on-contention');
      expect(readFileSync(markerPath, 'utf8')).toContain('"phase":"guard-queued"');

      writeFileSync(release, 'release lock for db-dump');
      const running = await waitForProgressPhase(markerPath, 'guard-running');
      expect(running.pid).toBe(child.pid);
      expect(await closed).toBe(0);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      writeFileSync(release, 'cleanup');
      if (child && closed) await stopFixtureGroup(child, closed);
      await stopFixtureGroup(holder, holderClosed);
    }
  }, 20_000);

  it('does not publish a db-dump progress marker for another label', () => {
    const { dir, env } = fixture();
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'hot', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(dir).some((entry) => entry.includes('.db-dump.') && entry.endsWith('.run'))).toBe(false);
  });

  it('keeps the default staleness override below the primary freshness alarm', () => {
    const guardSource = readFileSync(guard, 'utf8');
    const healthCheckSource = readFileSync(backupHealthCheckPath, 'utf8');
    const maxDefer = guardSource.match(/KOPIA_BACKUP_MAX_DEFER_SEC:-([0-9]+)/)?.[1];
    const maxAgeHours = healthCheckSource.match(/BACKUP_MAX_AGE_H:-([0-9]+)/)?.[1];

    expect(maxDefer).toBeDefined();
    expect(maxAgeHours).toBeDefined();
    expect(Number(maxDefer)).toBeLessThan(Number(maxAgeHours) * 60 * 60);
  });

  it('uses one host-global default lock namespace instead of an effective-UID runtime', () => {
    const source = readFileSync(guard, 'utf8');

    expect(source).toContain(
      'lock_path="${KOPIA_BACKUP_LOCK_PATH:-/run/lock/papercusp/kopia-global.lock}"',
    );
    expect(source).not.toContain('runtime_dir=');
  });

  it('is valid shell and executes scheduled work under safe pressure', () => {
    expect(spawnSync('bash', ['-n', guard], { timeout: 10_000, killSignal: 'SIGKILL' }).status).toBe(0);
    const { dir, env } = fixture();
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'test', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(result.stdout).toContain('result=started mode=scheduled');
  });

  // Measured 2026-09-05: /proc/pressure/memory on this host swung 0.02 -> 41.91 and
  // sat at or above the limit of 5 for 52.4% of samples with ZERO kopia processes
  // running (79 agents, load average 162). The mid-run gate aborts on the FIRST
  // sample at or above the limit, so a run survives only on an unbroken sub-limit
  // streak lasting its whole duration -- 1024s and 2332s for the two runs that ever
  // completed, against a longest observed sub-limit window of 40 SECONDS. 19 of 19
  // ordinary cycles died that day; the only successes were staleness-override-armed.
  // The host-wide files do not measure this backup, so they must not cancel it.
  it('admits on the HOST-wide signal, because a fresh oneshot cgroup cannot answer the admission question', () => {
    // This asserts the OPPOSITE of what it did before 2026-09-05, deliberately.
    // The per-cgroup PSI files are real and isolated -- verified directly: inside
    // a fresh `systemd-run --user -p MemoryAccounting=yes` unit its own
    // memory.pressure reads `full avg10=0.00 total=0` at the same instant
    // /proc/pressure/memory reads `full avg10=9.72 total=33935905616`. That
    // isolation is exactly why they are USELESS at admission: kopia-snapshots is
    // Type=oneshot, so its cgroup is seconds old when this check runs and reads
    // 0.00 every single time. A cgroup-scoped admission gate would therefore
    // never defer anything while still LOOKING like a gate, which is worse than
    // having none. Admission asks "is the box already in trouble before we add
    // load"; only /proc/pressure answers that.
    const { dir, env } = fixture();
    const { KOPIA_BACKUP_MEM_PSI_PATH: _memory, KOPIA_BACKUP_IO_PSI_PATH: _io, ...noOverride } = env;
    const result = run(['--mode', 'scheduled', '--label', 'scope', '--', 'touch', join(dir, 'ran')], noOverride);

    // Emitted before the admission decision, so this holds whether the cycle is
    // admitted or deferred by whatever real pressure the test host happens to have.
    const line = result.stdout.split('\n').find((entry) => entry.includes('result=psi-scope'));
    expect(line, result.stdout).toBeDefined();

    expect(/scope=(\S+)/.exec(line!)?.[1]).toBe('host');
    expect(/memory_path=(\S+)/.exec(line!)?.[1]).toBe('/proc/pressure/memory');
    expect(/io_path=(\S+)/.exec(line!)?.[1]).toBe('/proc/pressure/io');
  });

  it('lets an explicit pressure-path override win, and reports the scope it actually read', () => {
    const { dir, env } = fixture();
    const result = run(['--mode', 'scheduled', '--label', 'override', '--', 'touch', join(dir, 'ran')], env);

    const line = result.stdout.split('\n').find((entry) => entry.includes('result=psi-scope'));
    expect(line, result.stdout).toBeDefined();
    // An override is neither this cgroup's reading nor the host's. Labelling it
    // 'cgroup' would be a field that does not mean what its name says.
    expect(line).toContain('scope=override');
    expect(line).toContain(`memory_path=${join(dir, 'memory.pressure')}`);
  });

  it('parses the complete guard before starting work so a live source update cannot tear it', async () => {
    const { dir, env } = fixture();
    const canonicalGuard = join(dir, 'canonical-guard.sh');
    const installedGuard = join(dir, 'installed-guard.sh');
    const ready = join(dir, 'ready');
    const source = readFileSync(guard, 'utf8');
    const commandTail = '"$@" 9>&- &';
    expect(source).toContain(commandTail);

    // Make the still-unparsed tail much larger than Bash's read buffer. A
    // top-level implementation starts the child before this tail is parsed;
    // the parse-sealed main() implementation must parse it before any child
    // can create READY.
    const padding = Array.from(
      { length: 8_192 },
      (_, index) => `: # LIVE_SOURCE_PAD_${index.toString().padStart(5, '0')}\n`,
    ).join('');
    const paddedSource = source.replace(commandTail, `"$@" 9>&- &\n${padding}child_pid=$!`);
    const mutationOffset = paddedSource.lastIndexOf(': # LIVE_SOURCE_PAD_');
    expect(mutationOffset).toBeGreaterThan(0);

    writeFileSync(canonicalGuard, paddedSource, { mode: 0o755 });
    symlinkSync(canonicalGuard, installedGuard);

    const child = spawn(
      'bash',
      [
        installedGuard,
        '--mode',
        'wait',
        '--label',
        'live-source-update',
        '--',
        'bash',
        '-c',
        'touch "$1"; sleep 0.4',
        '_',
        ready,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

    await waitForPath(ready);
    const fd = openSync(canonicalGuard, 'r+');
    try {
      const brokenTail = Buffer.from('broken="');
      writeSync(fd, brokenTail, 0, brokenTail.length, mutationOffset);
      ftruncateSync(fd, mutationOffset + brokenTail.length);
    } finally {
      closeSync(fd);
    }

    const status = await closed;
    expect(status, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('result=finished mode=wait rc=0');
  });

  it.each([
    ['memory', 5, 0, 'memory-pressure'],
    ['io', 0, 10, 'io-pressure'],
  ])('defers scheduled work at unsafe %s full PSI', (_signal, memory, io, reason) => {
    const { dir, env } = fixture(memory, io);
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(result.stdout).toContain(`result=deferred reason=${reason}`);
    expect(spawnSync('test', ['-e', marker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
  });

  it('fails safe when scheduled pressure telemetry is unavailable', () => {
    const { dir, env } = fixture();
    env.KOPIA_BACKUP_MEM_PSI_PATH = join(dir, 'missing-pressure-file');
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(result.stdout).toContain('result=deferred reason=pressure-unavailable signal=memory');
    expect(spawnSync('test', ['-e', marker], { timeout: 5_000, killSignal: 'SIGKILL' }).status).not.toBe(0);
  });

  it('does NOT cancel a running backup when memory pressure rises mid-run', async () => {
    // Inverted 2026-09-05 after measuring what the mid-run signal actually says.
    // Neither candidate reading describes a harm this backup can relieve:
    //   HOST-wide is fleet-driven -- 0.02-41.91 sampled at 2s with ZERO kopia
    //   processes running, at or above the limit of 5 in 52.4% of 82 samples. The
    //   check aborts on the FIRST crossing, so a run needs an unbroken sub-limit
    //   streak for its whole duration: 1024-2332s required vs 40s longest
    //   observed => 20 of 20 ordinary cycles killed, zero coverage.
    //   PER-CGROUP is real and isolated but measures the backup's OWN page-cache
    //   reclaim, which is what reading the filesystem IS. Live on the 23:00 cycle
    //   it went full avg10 1.71 -> 2.47 -> 5.36 in 25s at 1.4G RSS (cap 8G) while
    //   the host fell 19.50 -> 9.93. A threshold of 5 there fires on "this job is
    //   doing I/O".
    // The backup stays bounded by what actually bounds it (MemoryHigh=8G /
    // MemoryMax=12G / MemorySwapMax=0, Nice=10, ionice best-effort 7,
    // --parallel=1); admission still defers on the host-wide signal, and the
    // priority-waiter handoff below still preempts a hot sweep.
    const { dir, env } = fixture();
    const ready = join(dir, 'ready');
    const stopped = join(dir, 'stopped');
    const child = spawn(
      'bash',
      [
        guard,
        '--mode',
        'scheduled',
        '--label',
        'runtime-pressure',
        '--',
        'bash',
        '-c',
        // Records a TERM it must never receive, then exits on its own well after
        // several 0.05s monitor iterations have observed the raised pressure.
        'trap \'touch "$2"; exit 143\' TERM; touch "$1"; sleep 1; exit 0',
        '_',
        ready,
        stopped,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

    await waitForPath(ready);
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH!, 6);

    await expect(closed).resolves.toBe(0);
    expect(stderr).toBe('');
    // The child was never signalled: it ran to its own completion under pressure
    // that would previously have retired it 0.05s in.
    expect(existsSync(stopped)).toBe(false);
    expect(stdout).not.toContain('stopping-during-run');
    expect(stdout).not.toContain('deferred-during-run');
    expect(stdout).toContain('result=finished mode=scheduled rc=0');
    // The grace must actually be HONOURED, not just configured. Asserting the absence of the
    // escalation is what pins that: the guard computed its stop deadline with a bare awk
    // `print`, whose default OFMT (%.6g) truncated the epoch to 1.78836e+09 — ~3700s in the
    // past — so the grace loop exited on its first evaluation and every TERM'd child was
    // SIGKILLed within ~50ms regardless of KOPIA_BACKUP_STOP_GRACE_SEC. The stderr assertion
    // above only caught it as a side effect (bash's job-control notice) and read as a flake;
    // this asserts the behaviour directly.
    expect(stdout).not.toContain('result=killing-after-grace');
    // 30s, deliberately WIDER than the fixture's 20s KOPIA_BACKUP_STOP_GRACE_SEC. There is no
    // testTimeout in either vitest config, so the default is 5s — narrower than the grace the
    // guard is configured to honour. A child slow to be scheduled would then blow the test
    // timeout before the guard ever reached its deadline, and the grace could never actually
    // be exercised. Costs nothing normally: this test completes in well under a second when
    // the child handles TERM promptly.
  }, 30_000);

  it('defers a scheduled contender while a backup holds the lock', async () => {
    const result = await contendWithFixtureHolder(fixture(), ['--mode', 'scheduled', '--label', 'contender']);
    expect(result.status, result.output).toBe(SCHEDULED_DEFER_EXIT);
    expect(result.ran, result.output).toBe(false);
    expect(result.output).toContain('result=deferred reason=lock-held');
  }, 30_000);

  it('signals lock readiness only after acquisition and keeps guard logs off dump stdout', async () => {
    const { dir, env } = fixture();
    const holderReady = join(dir, 'holder-ready');
    const releaseHolder = join(dir, 'release-holder');
    const holder = spawn(
      'bash',
      ['-c', 'exec 9>>"$KOPIA_BACKUP_LOCK_PATH"; flock 9; touch "$READY"; while [ ! -e "$RELEASE" ]; do sleep 0.01; done'],
      { env: { ...env, READY: holderReady, RELEASE: releaseHolder }, stdio: 'ignore' },
    );
    const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));
    let child: ReturnType<typeof spawn> | null = null;
    let stdout = '';
    let stderr = '';
    let readiness = '';

    try {
      await waitForPath(holderReady);
      child = spawn(
        'bash',
        [guard, '--mode', 'wait', '--label', 'dump-stream', '--', 'bash', '-c', 'printf "SELECT 1;\\n"'],
        {
          env: {
            ...env,
            KOPIA_BACKUP_GUARD_READY_FD: '3',
            KOPIA_BACKUP_GUARD_LOG_STDERR: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        },
      );
      const childClosed = new Promise<number | null>((resolve) => child!.once('close', resolve));
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      (child.stdio[3] as import('node:stream').Readable)
        .setEncoding('utf8')
        .on('data', (chunk: string) => { readiness += chunk; });

      await waitForOutput(() => stderr, 'result=waiting reason=lock');
      expect(readiness).toBe('');
      writeFileSync(releaseHolder, 'released');

      expect(await childClosed).toBe(0);
      expect(await holderClosed).toBe(0);
      expect(stdout).toBe('SELECT 1;\n');
      expect(stderr).toContain('result=started mode=wait');
      expect(readiness).toBe('KOPIA_BACKUP_GUARD_READY\n');
    } finally {
      writeFileSync(releaseHolder, 'released');
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
    }
  });

  it('bounds wait-mode lock acquisition with a distinct lock-timeout result', async () => {
    const { dir, env } = fixture();
    const holderReady = join(dir, 'timeout-holder-ready');
    const releaseHolder = join(dir, 'timeout-release-holder');
    const marker = join(dir, 'must-not-run-after-lock-timeout');
    const holder = spawn(
      'bash',
      ['-c', 'exec 9>>"$KOPIA_BACKUP_LOCK_PATH"; flock 9; touch "$READY"; while [ ! -e "$RELEASE" ]; do sleep 0.01; done'],
      { env: { ...env, READY: holderReady, RELEASE: releaseHolder }, stdio: 'ignore' },
    );
    const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));

    try {
      await waitForPath(holderReady);
      const result = run(
        ['--mode', 'wait', '--label', 'timeout', '--', 'touch', marker],
        { ...env, KOPIA_BACKUP_GUARD_LOCK_WAIT_TIMEOUT_SEC: '1' },
      );
      expect(result.status).toBe(75);
      expect(result.stdout).toContain('result=failed mode=wait reason=lock-timeout timeout_sec=1');
      expect(existsSync(marker)).toBe(false);
    } finally {
      writeFileSync(releaseHolder, 'released');
      if (holder.exitCode === null && holder.signalCode === null) {
        const cleanupTimeout = setTimeout(() => holder.kill('SIGKILL'), 1_000);
        try { await holderClosed; } finally { clearTimeout(cleanupTimeout); }
      }
    }
    expect(await holderClosed).toBe(0);
  });

  // WI-10003884. The deferral above is right for a producer whose cadence is far shorter
  // than its recovery-point deadline, and wrong for the hourly db-dump: a successful run
  // leaves the next tick ~2300-2500s after that success, below the 3600s staleness floor,
  // so ANY contention at that tick discarded the whole hour. Measured 2026-09-29: 'backup
  // OK' only at even hours for 16h, each odd-hour tick logging deferred reason=lock-held.
  // This is the A/B twin of the test above: identical holder and contender, one flag.
  it('waits out a held lock instead of deferring when the producer asks for --priority-on-contention', async () => {
    const result = await contendWithFixtureHolder(fixture(),
      ['--mode', 'scheduled', '--label', 'contender', '--priority-on-contention'], 'priority-on-contention');
    expect(result.status, result.output).toBe(0);
    expect(result.ran, result.output).toBe(true);
    expect(result.output).not.toContain('result=deferred reason=lock-held');
  }, 30_000);

  // The wait must also REGISTER as a priority request, or a hot sweep that never pauses
  // would hold the lock through the whole hour and the wait would be a deferral with
  // extra steps. A scheduled-mode marker is honoured by the handoff (has_live_priority_waiter).
  it('makes a restart-safe hot sweep yield to a --priority-on-contention producer', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; while :; do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe --priority-on-contention -- bash -c 'touch "$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1
        db_rc=$?
        wait "$hot"
        hot_rc=$?
        [ "$db_rc" -eq 0 ] &&
          [ -e "$DB_RAN" ] &&
          grep -q 'result=waiting reason=priority-on-contention' "$DB_LOG" &&
          [ "$hot_rc" -eq ${SCHEDULED_DEFER_EXIT} ] &&
          grep -q 'result=stopping-during-run reason=priority-waiter' "$HOT_LOG"
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_READY: join(dir, 'hot-ready'),
          HOT_LOG: join(dir, 'hot.log'),
          DB_RAN: join(dir, 'db-ran'),
          DB_LOG: join(dir, 'db.log'),
        },
        timeout: 10_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
  });

  it('hands the lock to a wait-mode producer instead of starving behind a hot sweep', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; while :; do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode wait --label protected-manual -- bash -c 'touch "$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1 &
        db=$!
        wait "$db"
        wait "$hot"
        hot_rc=$?
        [ -e "$DB_RAN" ] &&
          [ "$hot_rc" -eq ${SCHEDULED_DEFER_EXIT} ] &&
          grep -q 'result=stopping-during-run reason=priority-waiter' "$HOT_LOG"
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_READY: join(dir, 'hot-ready'),
          HOT_LOG: join(dir, 'hot.log'),
          DB_RAN: join(dir, 'db-ran'),
          DB_LOG: join(dir, 'db.log'),
        },
        timeout: 10_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
  });

  // WI-10001467. The handoff above TERMINATES the running scheduled child, which is a
  // cheap trade for a content-addressed Kopia snapshot and a ruinous one for the hourly
  // `pg_dump -Fd`: it has no resume, and its ONLY success record — the `backup OK in Ns`
  // line and the STATUS.json write — lands at the very end, so preemption discards the
  // entire cycle and records nothing. Worse, a killed run still leaves its dump
  // directories behind, so every artifact-mtime health check reads FRESH on exactly the
  // runs that were lost. Measured on this host 2026-09-16: hourly cadence had collapsed
  // to 4-17h gaps, and the 00:00 cycle was killed 21 minutes in, after dumping ~100GB.
  // The staleness override closed the loop — it admits a cycle PRECISELY BECAUSE the
  // backup is dangerously stale, and the handoff could still kill it 5s later.
  it('does NOT preempt a --no-restart-safe child for a priority waiter, and says so exactly once', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe -- bash -c 'touch "$1"; for _ in $(seq 1 500); do [ -e "$2" ] && break; sleep 0.01; done; touch "$3"' _ "$HOT_READY" "$HOT_GO" "$HOT_DONE" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode wait --label protected-manual -- bash -c 'touch "$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1 &
        db=$!
        # Release the child only once the guard has SEEN the waiter and declined to yield.
        # Polling the log instead of sleeping keeps this a contract assertion rather than a
        # bet on scheduling latency: if the guard preempts instead, the line never appears,
        # the child is already dead when the poll gives up, and every assertion below fails.
        for _ in $(seq 1 500); do grep -q 'holding-against-priority-waiter' "$HOT_LOG" && break; sleep 0.01; done
        touch "$HOT_GO"
        wait "$hot"
        hot_rc=$?
        wait "$db"
        [ "$hot_rc" -eq 0 ] &&
          [ -e "$HOT_DONE" ] &&
          [ "$(grep -c 'result=holding-against-priority-waiter reason=child-not-restart-safe' "$HOT_LOG")" -eq 1 ] &&
          ! grep -q 'result=stopping-during-run reason=priority-waiter' "$HOT_LOG" &&
          [ -e "$DB_RAN" ]
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_READY: join(dir, 'hot-ready'),
          HOT_GO: join(dir, 'hot-go'),
          HOT_DONE: join(dir, 'hot-done'),
          HOT_LOG: join(dir, 'hot.log'),
          DB_RAN: join(dir, 'db-ran'),
          DB_LOG: join(dir, 'db.log'),
        },
        timeout: 20_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
  });

  it('hands the lock back early when the child asks, and still waits for the child (WI-10004870)', () => {
    // The hourly db-dump writes its last ~25 min into a tier that .kopiaignore keeps
    // out of every snapshot, so it asks the guard to drop the shared lock first. The
    // contract: once asked, a contender gets the lock WHILE the child is still running,
    // the guard still reports the child's own exit status, and the request file does
    // not outlive the run (a later guard must never inherit it).
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe -- bash -c ': >"$KOPIA_BACKUP_GUARD_RELEASE_PATH"; for _ in $(seq 1 1000); do [ -e "$1" ] && break; sleep 0.01; done; [ -e "$1" ] && touch "$2"' _ "$CHILD_GO" "$CHILD_DONE" >"$HOLDER_LOG" 2>&1 &
        holder=$!
        for _ in $(seq 1 500); do grep -q 'result=released-early' "$HOLDER_LOG" && break; sleep 0.01; done
        grep -q 'result=released-early' "$HOLDER_LOG" || exit 91
        "$GUARD" --mode scheduled --label hot -- touch "$CONTENDER_RAN" >"$CONTENDER_LOG" 2>&1
        contender_rc=$?
        # The first child must still be running: it only finishes once released below.
        [ -e "$CHILD_DONE" ] && exit 92
        touch "$CHILD_GO"
        wait "$holder"
        holder_rc=$?
        leftovers=$(ls "$DIR"/global.lock.release.* 2>/dev/null | wc -l)
        [ "$contender_rc" -eq 0 ] || exit 93
        [ -e "$CONTENDER_RAN" ] || exit 94
        [ "$holder_rc" -eq 0 ] && [ -e "$CHILD_DONE" ] || exit 95
        [ "$(grep -c 'result=released-early' "$HOLDER_LOG")" -eq 1 ] || exit 96
        grep -q 'result=finished mode=scheduled rc=0' "$HOLDER_LOG" || exit 97
        [ "$leftovers" -eq 0 ] || exit 98
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          DIR: dir,
          CHILD_GO: join(dir, 'child-go'),
          CHILD_DONE: join(dir, 'child-done'),
          HOLDER_LOG: join(dir, 'holder.log'),
          CONTENDER_RAN: join(dir, 'contender-ran'),
          CONTENDER_LOG: join(dir, 'contender.log'),
        },
        timeout: 20_000,
      },
    );

    expect(
      scenario.status,
      `${scenario.stdout}\n${scenario.stderr}\nholder:\n${readLog(join(dir, 'holder.log'))}\ncontender:\n${readLog(join(dir, 'contender.log'))}`,
    ).toBe(0);
  });

  it('keeps the whole-lifetime hold for a child that never asks for early release', () => {
    // Calibration for the case above: the request channel is exported to EVERY
    // scheduled child, so a child that ignores it (the hot sweep) must still block a
    // contender until it exits. Without this, a guard that unlocked unconditionally
    // would pass the early-release case too.
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe -- bash -c '[ -n "$KOPIA_BACKUP_GUARD_RELEASE_PATH" ] || exit 7; touch "$1"; for _ in $(seq 1 1000); do [ -e "$2" ] && break; sleep 0.01; done' _ "$READY" "$GO" >"$HOLDER_LOG" 2>&1 &
        holder=$!
        for _ in $(seq 1 500); do [ -e "$READY" ] && break; sleep 0.01; done
        [ -e "$READY" ] || exit 91
        sleep 0.3
        "$GUARD" --mode scheduled --label hot -- touch "$CONTENDER_RAN" >/dev/null 2>&1
        contender_rc=$?
        touch "$GO"
        wait "$holder"
        holder_rc=$?
        [ "$contender_rc" -eq ${SCHEDULED_DEFER_EXIT} ] || exit 92
        [ ! -e "$CONTENDER_RAN" ] || exit 93
        [ "$holder_rc" -eq 0 ] || exit 94
        ! grep -q 'result=released-early' "$HOLDER_LOG" || exit 95
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          READY: join(dir, 'ready'),
          GO: join(dir, 'go'),
          HOLDER_LOG: join(dir, 'holder.log'),
          CONTENDER_RAN: join(dir, 'contender-ran'),
        },
        timeout: 20_000,
      },
    );

    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\n${readLog(join(dir, 'holder.log'))}`).toBe(0);
  });

  it('waits for the current holder and releases the lock after failure', () => {
    const { dir, env } = fixture();
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode wait --label holder -- bash -c 'touch "$1"; sleep 0.3' _ "$READY" &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$READY" ] && break; sleep 0.01; done
        [ -e "$READY" ] || exit 91
        "$GUARD" --mode wait --label waiter -- touch "$WAITER"
        wait "$holder"
        [ -e "$WAITER" ]
      `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, READY: join(dir, 'ready'), WAITER: join(dir, 'waiter') },
        timeout: 10_000,
      },
    );
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);

    expect(run(['--mode', 'wait', '--', 'bash', '-c', 'exit 42'], env).status).toBe(42);
    const marker = join(dir, 'after-failure');
    const next = run(['--mode', 'scheduled', '--', 'touch', marker], env);
    expect(next.status, next.stderr).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('');
  });

  it('releases the flock if a wait-mode guard is SIGKILLed while its child survives', async () => {
    const { dir, env } = fixture();
    const childPidPath = join(dir, 'child.pid');
    const afterOrphan = join(dir, 'after-orphan');
    const holder = spawn(
      'bash',
      [
        guard,
        '--mode',
        'wait',
        '--label',
        'kill-boundary',
        '--',
        'bash',
        '-c',
        'printf "%s\\n" "$$" >"$1"; exec sleep 300',
        '_',
        childPidPath,
      ],
      // The child is supposed to outlive the guard in this reproduction. Keep
      // it off the guard's pipes, otherwise Node's `close` event correctly
      // waits for the still-live descendant to close those descriptors too.
      { env, stdio: 'ignore' },
    );

    await waitForPath(childPidPath);
    const childPid = Number(readFileSync(childPidPath, 'utf8').trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);

    try {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));

      // SIGKILL cannot be trapped or forwarded. The child deliberately stays
      // alive, reproducing the production orphan, but must not retain FD 9's
      // open file description and therefore cannot retain the global flock.
      expect(() => process.kill(childPid, 0)).not.toThrow();
      const next = run(
        ['--mode', 'scheduled', '--label', 'after-orphan', '--', 'touch', afterOrphan],
        env,
      );
      expect(next.status, `${next.stdout}\n${next.stderr}`).toBe(0);
      expect(existsSync(afterOrphan)).toBe(true);
      expect(next.stdout).toContain('result=started mode=scheduled');
    } finally {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
      try { holder.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 20_000);

  const canRunMixedUid =
    typeof process.getuid === 'function' && process.getuid() !== 0
      ? spawnSync('sudo', ['-n', '-u', 'root', 'true'], {
          stdio: 'ignore',
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }).status === 0
      : false;

  it.skipIf(!canRunMixedUid)('serializes user and root guards in both directions', () => {
    const userHolder = fixture();
    const userReady = join(userHolder.dir, 'user-ready');
    const rootMarker = join(userHolder.dir, 'root-marker');
    const userScenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode wait --label user-holder -- bash -c 'test "$(id -u)" -ne 0 && touch "$1"; sleep 0.35' _ "$USER_READY" >"$USER_READY.user.log" 2>&1 &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$USER_READY" ] && break; sleep 0.01; done
        [ -e "$USER_READY" ] || exit 91
        started=$(date +%s%3N)
        sudo -n -u root env -u XDG_RUNTIME_DIR KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label root-waiter -- bash -c 'test "$(id -u)" -eq 0 && touch "$1"' _ "$ROOT_MARKER" >"$ROOT_MARKER.root.log" 2>&1
        root_rc=$?
        elapsed=$(( $(date +%s%3N) - started ))
        wait "$holder"
        [ "$root_rc" -eq 0 ] && [ -e "$ROOT_MARKER" ] && [ "$elapsed" -ge 250 ]
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...userHolder.env,
          GUARD: guard,
          LOCK_PATH: join(userHolder.dir, 'global.lock'),
          MEMORY_PATH: join(userHolder.dir, 'memory.pressure'),
          IO_PATH: join(userHolder.dir, 'io.pressure'),
          USER_READY: userReady,
          ROOT_MARKER: rootMarker,
        },
        timeout: 10_000,
      },
    );
    expect(userScenario.status, `${userScenario.stdout}\n${userScenario.stderr}`).toBe(0);

    const rootHolder = fixture();
    const rootReady = join(rootHolder.dir, 'root-ready');
    const userMarker = join(rootHolder.dir, 'user-marker');
    const rootScenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        sudo -n -u root env -u XDG_RUNTIME_DIR KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label root-holder -- bash -c 'test "$(id -u)" -eq 0 && touch "$1"; sleep 0.35' _ "$ROOT_READY" >"$ROOT_READY.root.log" 2>&1 &
        holder=$!
        for _ in $(seq 1 100); do [ -e "$ROOT_READY" ] && break; sleep 0.01; done
        [ -e "$ROOT_READY" ] || exit 91
        started=$(date +%s%3N)
        env XDG_RUNTIME_DIR="$USER_RUNTIME" KOPIA_BACKUP_LOCK_PATH="$LOCK_PATH" KOPIA_BACKUP_MEM_PSI_PATH="$MEMORY_PATH" KOPIA_BACKUP_IO_PSI_PATH="$IO_PATH" KOPIA_BACKUP_MEM_FULL_AVG10_MAX=5 KOPIA_BACKUP_IO_FULL_AVG10_MAX=10 bash "$GUARD" --mode wait --label user-waiter -- bash -c 'test "$(id -u)" -ne 0 && touch "$1"' _ "$USER_MARKER" >"$USER_MARKER.user.log" 2>&1
        user_rc=$?
        elapsed=$(( $(date +%s%3N) - started ))
        wait "$holder"
        [ "$user_rc" -eq 0 ] && [ -e "$USER_MARKER" ] && [ "$elapsed" -ge 250 ]
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...rootHolder.env,
          GUARD: guard,
          LOCK_PATH: join(rootHolder.dir, 'global.lock'),
          USER_RUNTIME: join(rootHolder.dir, 'user-runtime'),
          MEMORY_PATH: join(rootHolder.dir, 'memory.pressure'),
          IO_PATH: join(rootHolder.dir, 'io.pressure'),
          ROOT_READY: rootReady,
          USER_MARKER: userMarker,
        },
        timeout: 10_000,
      },
    );
    expect(rootScenario.status, `${rootScenario.stdout}\n${rootScenario.stderr}`).toBe(0);
  });
});

describe('Kopia managed entrypoint contract', () => {
  const hotService = readFileSync(join(systemdDir, 'kopia-snapshots.service'), 'utf8');
  const homeService = readFileSync(join(systemdDir, 'kopia-home-snapshot.service'), 'utf8');
  const hotScript = readFileSync(join(systemdDir, 'kopia-snapshot-all.sh'), 'utf8');
  const homeScript = readFileSync(join(systemdDir, 'kopia-home-snapshot.sh'), 'utf8');
  const protectedScript = readFileSync(join(systemdDir, 'kopia-protected-snapshot.sh'), 'utf8');
  const dbService = readFileSync(join(systemdDir, 'papercusp-db-backup.service'), 'utf8');
  const dbScript = readFileSync(join(systemdDir, 'papercusp-db-backup.sh'), 'utf8');
  const timer = readFileSync(join(systemdDir, 'kopia-snapshots.timer'), 'utf8');
  const dbTimer = readFileSync(join(systemdDir, 'papercusp-db-backup.timer'), 'utf8');
  const nonblockingTrigger = readFileSync(
    join(systemdDir, 'papercusp-nonblocking-trigger@.service'),
    'utf8',
  );
  const systemdReadme = readFileSync(join(systemdDir, 'README.md'), 'utf8');
  const healthcheck = readFileSync(join(systemdDir, 'kopia-healthcheck.sh'), 'utf8');

  it('routes every managed path through the same guard', () => {
    expect(hotService).toContain('kopia-backup-guard.sh --mode scheduled --label hot');
    expect(homeService).toContain('kopia-backup-guard.sh --mode scheduled --label daily-home-vm --priority-on-contention');
    expect(hotScript).toContain('--mode scheduled --label hot');
    expect(homeScript).toContain('--mode scheduled --label daily-home-vm --priority-on-contention');
    expect(homeService).not.toContain('kopia-backup-guard.sh --mode wait --label daily-home-vm');
    expect(protectedScript).toContain('--mode wait --label protected-manual');
    expect(dbService).toContain('kopia-backup-guard.sh --mode scheduled --label db-dump');
    expect(dbService).not.toContain('kopia-backup-guard.sh --mode wait --label db-dump');
    expect(dbService).toContain('-- %h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-db-backup.sh');
    expect(dbService).toContain('Environment=PC_BACKUP_JOBS=1');
    expect(hotService).toContain('SuccessExitStatus=75');
    expect(dbService).toContain('SuccessExitStatus=75');
    expect(hotScript).not.toContain('snapshot-all.lock');
    expect(homeScript).not.toContain('home-snapshot.lock');
    expect(hotService).toContain('ExecStopPost=%h/.config/kopia/snapshot-all.sh --cleanup');
  });

  it('keeps long-running calendar backup workers behind a nonblocking dispatcher', () => {
    expect(timer).toContain('OnCalendar=*:0/30');
    expect(timer).toContain('Unit=papercusp-nonblocking-trigger@kopia-snapshots.service');
    expect(timer).not.toContain('Unit=kopia-snapshots.service');
    // D-007: the :10 dump preserves a measured source-first window after the
    // :00 hot run, while the required dump source remains first in each sweep.
    expect(dbTimer).toMatch(/^OnCalendar=\*-\*-\* \*:10:00$/m);
    const requiredSourceBlock = hotScript.match(/REQUIRED_SOURCES=\(\n([\s\S]*?)\n  \)/)?.[1] ?? '';
    const firstRequiredSource = requiredSourceBlock
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim();
    expect(firstRequiredSource).toBe('"${PAPERCUSP_HOST_PG_DUMP_DIR:-/mnt/cold-a/Backup/db-dumps}"');
    expect(dbTimer).toContain('Unit=papercusp-nonblocking-trigger@papercusp-db-backup.service');
    expect(dbTimer).not.toContain('Unit=papercusp-db-backup.service');
    expect(nonblockingTrigger).toContain('Type=oneshot');
    expect(nonblockingTrigger).toContain(
      'ExecStart=/usr/bin/systemctl --user start --no-block %i.service',
    );
    expect(systemdReadme).toContain('papercusp-nonblocking-trigger@.service');

    const installStart = systemdReadme.indexOf('## Install (one-time, on a fresh machine)');
    const installEnd = systemdReadme.indexOf('\nYou must still recreate', installStart);
    const install = systemdReadme.slice(installStart, installEnd);
    const reloadAt = install.indexOf('systemctl --user daemon-reload');
    const rearmAt = install.indexOf(
      'systemctl --user try-restart papercusp-db-backup.timer kopia-snapshots.timer',
    );
    const enableAt = install.indexOf('systemctl --user enable --now papercusp-db-backup.timer');
    expect(reloadAt).toBeGreaterThanOrEqual(0);
    expect(rearmAt).toBeGreaterThan(reloadAt);
    expect(enableAt).toBeGreaterThan(rearmAt);
    expect(install).not.toMatch(/systemctl --user (?:try-)?restart (?:papercusp-db-backup|kopia-snapshots)\.service/);
  });

  it('bounds the hot snapshot with the proven daily parallelism and memory envelope', () => {
    expect(hotScript).toContain('"--parallel=1" "$@"');
    expect(hotService).toContain('MemoryAccounting=yes');
    expect(hotService).toContain('MemoryHigh=8G');
    expect(hotService).toContain('MemoryMax=12G');
    expect(hotService).toContain('MemorySwapMax=0');
    expect(hotService).toContain('TimeoutStopSec=180s');
  });

  it('bounds the hourly database dump after a serialized run breached host PSI', () => {
    expect(dbService).toContain('MemoryAccounting=yes');
    expect(dbService).toContain('MemoryHigh=32G');
    expect(dbService).toContain('MemoryMax=40G');
    expect(dbService).toContain('MemorySwapMax=0');
    expect(dbService).toContain('OOMPolicy=kill');
    expect(dbService).toContain('kopia-backup-guard.sh --mode scheduled --label db-dump');
    expect(dbService).not.toContain('kopia-backup-guard.sh --mode wait --label db-dump');
    expect(dbService).toContain('Environment=PC_BACKUP_JOBS=1');
  });

  // WI-10001467. The guard's no-preemption branch is inert unless the unit ASKS for it,
  // and the flag defaults to restart-safe precisely so Kopia stays byte-identical — which
  // means a unit-file rewrite that drops this word silently restores the killing. Pin the
  // activation, not just the capability. The negative half is the other direction of the
  // same contract: a Kopia snapshot IS restart-safe, so making it hold the lock would
  // starve the waiter this handoff exists to unblock.
  it('activates no-preemption for the db dump only, leaving Kopia snapshots preemptible', () => {
    expect(dbService).toContain('--label db-dump --no-restart-safe');
    expect(hotService).not.toContain('--no-restart-safe');
    expect(homeService).not.toContain('--no-restart-safe');
  });

  // WI-10003884. Same activation-vs-capability rule as the test above: the priority-wait
  // branch is inert unless the entrypoint asks for it, so dropping the word silently
  // restores the every-other-hour skip. The hourly dump and daily home walk register
  // priority waits; the periodic hot sweep stays preemptible and must not wait here.
  it('enables priority-on-contention for the db dump and daily home snapshot only', () => {
    expect(dbService).toContain('--label db-dump --no-restart-safe --priority-on-contention -- ');
    expect(homeService).toContain('--label daily-home-vm --priority-on-contention -- ');
    expect(homeScript).toContain('--mode scheduled --label daily-home-vm --priority-on-contention');
    expect(hotService).not.toContain('--priority-on-contention');
    expect(hotScript).not.toContain('--priority-on-contention');
  });

  it('reaps only host-owned database dumps, never the concurrent workspace dump', () => {
    expect(HOST_BACKUP_APPLICATION_NAME).not.toBe(WORKSPACE_BACKUP_APPLICATION_NAME);
    expect(dbScript).toContain(
      `readonly HOST_BACKUP_APPLICATION_NAME=${HOST_BACKUP_APPLICATION_NAME}`,
    );
    expect(dbScript).toContain(
      "WHERE application_name = '$HOST_BACKUP_APPLICATION_NAME' AND pid <> pg_backend_pid();",
    );
    expect(dbScript).not.toContain(
      `WHERE application_name = '${WORKSPACE_BACKUP_APPLICATION_NAME}'`,
    );
  });

  it('hot cleanup kills only the exact recorded root Kopia child', () => {
    const { dir } = fixture();
    const stateDir = join(dir, 'state');
    const procRoot = join(dir, 'proc');
    const exactPid = '4242';
    const reusedPid = '4343';
    const fakeKopia = join(dir, 'kopia');
    const fakeOther = join(dir, 'other');
    const sudoStub = join(dir, 'sudo-stub.sh');
    const killLog = join(dir, 'kill.log');
    const pidFile = join(stateDir, 'snapshot-all.kopia.pid');

    mkdirSync(stateDir);
    mkdirSync(join(procRoot, exactPid), { recursive: true });
    mkdirSync(join(procRoot, reusedPid), { recursive: true });
    writeFileSync(fakeKopia, 'fixture');
    writeFileSync(fakeOther, 'fixture');
    symlinkSync(fakeKopia, join(procRoot, exactPid, 'exe'));
    symlinkSync(fakeOther, join(procRoot, reusedPid, 'exe'));
    writeFileSync(join(procRoot, exactPid, 'cmdline'), Buffer.from(`${fakeKopia}\0snapshot\0create\0/source\0`));
    writeFileSync(join(procRoot, reusedPid, 'cmdline'), Buffer.from(`${fakeOther}\0sleep\0`));
    writeFileSync(sudoStub, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"\n');
    chmodSync(sudoStub, 0o755);

    const env = {
      ...process.env,
      KOPIA_SNAPSHOT_LOG_DIR: stateDir,
      KOPIA_SNAPSHOT_PROC_ROOT: procRoot,
      KOPIA_SNAPSHOT_SUDO: sudoStub,
      KOPIA_SNAPSHOT_BIN: fakeKopia,
      KOPIA_TEST_KILL_LOG: killLog,
    };

    writeFileSync(pidFile, `${exactPid}\n`);
    const killed = spawnSync('bash', [hotScriptPath, '--cleanup'], {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(killed.status).toBe(0);
    expect(readFileSync(killLog, 'utf8')).toContain(`-KILL ${exactPid}`);
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, `${reusedPid}\n`);
    const refused = spawnSync('bash', [hotScriptPath, '--cleanup'], {
      encoding: 'utf8',
      env,
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(refused.status).toBe(0);
    expect(readFileSync(killLog, 'utf8')).not.toContain(`-KILL ${reusedPid}`);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('hot cleanup kills a ROOT-owned Kopia child whose /proc exe link the user unit cannot read', () => {
    // WI-10002636: the Kopia child runs as root (via sudo), and /proc/<pid>/exe of a root
    // process is unreadable to the user unit, so an unprivileged readlink returns nothing.
    // The match therefore never succeeded for the child this cleanup exists to kill: two
    // orphaned snapshot creates ran for 3.5h while every cleanup logged "refusing to kill".
    // The fixture models that view: the user-visible proc dir has a readable cmdline but NO
    // readable exe, and only the sudo path (a root-view mirror) resolves the link.
    const { dir } = fixture();
    const stateDir = join(dir, 'state');
    const procRoot = join(dir, 'proc');
    const rootViewProcRoot = join(dir, 'proc-as-root');
    const rootPid = '5252';
    const reusedRootPid = '5353';
    const fakeKopia = join(dir, 'kopia');
    const fakeOther = join(dir, 'other');
    const sudoStub = join(dir, 'sudo-stub.sh');
    const killLog = join(dir, 'kill.log');
    const pidFile = join(stateDir, 'snapshot-all.kopia.pid');

    mkdirSync(stateDir);
    writeFileSync(fakeKopia, 'fixture');
    writeFileSync(fakeOther, 'fixture');
    for (const [pid, target, argv] of [
      [rootPid, fakeKopia, `${fakeKopia}\0snapshot\0create\0/source\0`],
      [reusedRootPid, fakeOther, `${fakeOther}\0sleep\0`],
    ] as const) {
      mkdirSync(join(procRoot, pid), { recursive: true });
      mkdirSync(join(rootViewProcRoot, pid), { recursive: true });
      writeFileSync(join(procRoot, pid, 'cmdline'), Buffer.from(argv));
      symlinkSync(target, join(rootViewProcRoot, pid, 'exe'));
    }
    // Models `sudo -n`: strips its flags, resolves readlink against the root view of /proc,
    // and logs every other command (the kill) instead of running it.
    writeFileSync(
      sudoStub,
      [
        '#!/usr/bin/env bash',
        '[ "$1" = -n ] && shift',
        '[ "$1" = -- ] && shift',
        'if [ "$1" = readlink ]; then',
        '  shift',
        '  args=()',
        '  for a in "$@"; do args+=("${a/#"$KOPIA_TEST_PROC_ROOT"/"$KOPIA_TEST_ROOT_VIEW"}"); done',
        '  exec readlink "${args[@]}"',
        'fi',
        'printf \'%s\\n\' "$*" >>"$KOPIA_TEST_KILL_LOG"',
        '',
      ].join('\n'),
    );
    chmodSync(sudoStub, 0o755);

    const env = {
      ...process.env,
      KOPIA_SNAPSHOT_LOG_DIR: stateDir,
      KOPIA_SNAPSHOT_PROC_ROOT: procRoot,
      KOPIA_SNAPSHOT_SUDO: sudoStub,
      KOPIA_SNAPSHOT_BIN: fakeKopia,
      KOPIA_TEST_KILL_LOG: killLog,
      KOPIA_TEST_PROC_ROOT: procRoot,
      KOPIA_TEST_ROOT_VIEW: rootViewProcRoot,
    };
    const cleanup = () =>
      spawnSync('bash', [hotScriptPath, '--cleanup'], {
        encoding: 'utf8',
        env,
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });

    writeFileSync(pidFile, `${rootPid}\n`);
    expect(cleanup().status).toBe(0);
    expect(existsSync(killLog) ? readFileSync(killLog, 'utf8') : '').toContain(`-KILL ${rootPid}`);
    expect(existsSync(pidFile)).toBe(false);

    writeFileSync(pidFile, `${reusedRootPid}\n`);
    expect(cleanup().status).toBe(0);
    expect(existsSync(killLog) ? readFileSync(killLog, 'utf8') : '').not.toContain(`-KILL ${reusedRootPid}`);
    expect(existsSync(pidFile)).toBe(false);
  });

  it('pins the 30-minute cadence and matching 60-minute stale threshold', () => {
    expect(timer).toMatch(/^OnCalendar=\*:0\/30$/m);
    expect(healthcheck).toContain('MAX_SNAP_AGE_S="${MAX_SNAP_AGE_S:-3600}"');
  });

  it('keeps the hourly database writer canonical and dedupe-friendly', () => {
    const executableDbScript = dbScript
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(dbService).toContain(
      '-- %h/papercupai-workspace/papercusp/apps/operator/scripts/systemd/papercusp-db-backup.sh',
    );
    expect(dbService).not.toContain('%h/.config/kopia/db-backup.sh');
    expect(executableDbScript.match(/--compress=none/g)).toHaveLength(2);
    expect(executableDbScript).not.toMatch(/(?:^|\s)-Z1(?:\s|$)/m);
    expect(dbScript).toContain('pg_restore -l');
  });

  // WI-2146225 defect B. The pressure gate had no floor, so on a host whose
  // memory PSI sits permanently above the budget it did not DELAY the backup, it
  // CANCELLED it — every cycle deferred for the same reason while the service
  // still reported healthy. Measured 2026-09-05: full avg10=23.84 against a
  // limit of 5, no snapshot for 6h43m, newest recoverable dump 19h old. These
  // tests exist so that floor cannot be quietly removed again; the failure it
  // guards against is SILENT, which is exactly why it needs a test rather than a
  // comment.
  function seedDeadlineBase(dir: string, label: string, ageSec: number): string {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, `${label}.deadline-base`);
    writeFileSync(path, `${Math.floor(Date.now() / 1000) - ageSec}\n`);
    return path;
  }

  it('seeds the staleness clock rather than admitting on the very first evaluation', () => {
    const { dir, env } = fixture(23.84);
    const marker = join(dir, 'must-not-run');
    const result = run(['--mode', 'scheduled', '--label', 'seed', '--', 'touch', marker], env);

    // Enabling the floor must not make every label on the host ignore pressure
    // at once on its first tick, so an unknown baseline still defers.
    expect(result.status, result.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(result.stdout).toContain('result=deferred reason=memory-pressure');
    expect(result.stdout).toContain('staleness_sec=unknown-seeded');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'state', 'seed.deadline-base'))).toBe(true);
  });

  it('admits a scheduled cycle once pressure has deferred it past the staleness deadline', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'stale', 3_700);
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'stale', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=admitted-despite-pressure reason=memory-pressure');
    expect(result.stdout).toContain('max_defer_sec=3600');
    expect(result.stdout).toContain('result=finished mode=scheduled rc=0');
    expect(existsSync(marker)).toBe(true);
  });

  it('escalates past unreadable pressure telemetry too, so a host that stops publishing PSI still backs up', () => {
    const { dir, env } = fixture();
    env.KOPIA_BACKUP_MEM_PSI_PATH = join(dir, 'missing-pressure-file');
    seedDeadlineBase(dir, 'nopsi', 25_200);
    const marker = join(dir, 'ran');
    const result = run(['--mode', 'scheduled', '--label', 'nopsi', '--', 'touch', marker], env);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('result=admitted-despite-pressure reason=pressure-unavailable');
    expect(existsSync(marker)).toBe(true);
  });

  it('hands the lock to a stale scheduled dump before starving behind a hot sweep', () => {
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'db-dump', 25_200);
    const hotReady = join(dir, 'hot-ready');
    const dbRan = join(dir, 'db-ran');
    const hotLog = join(dir, 'hot.log');
    const dbLog = join(dir, 'db.log');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -uo pipefail',
          '"$GUARD" --mode scheduled --label hot -- bash -c \'touch "$1"; for _ in $(seq 1 500); do [ -e "$2" ] && break; sleep 0.01; done\' _ "$HOT_READY" "$DB_RAN" >"$HOT_LOG" 2>&1 &',
          'hot=$!',
          'for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done',
          '[ -e "$HOT_READY" ] || exit 91',
          '"$GUARD" --mode scheduled --label db-dump --no-restart-safe -- touch "$DB_RAN" >"$DB_LOG" 2>&1 &',
          'db=$!',
          'wait "$db"',
          'db_rc=$?',
          'wait "$hot"',
          'hot_rc=$?',
          '[ "$db_rc" -eq 0 ] && [ -e "$DB_RAN" ] && [ "$hot_rc" -eq 75 ] && grep -q \'result=stopping-during-run reason=priority-waiter\' "$HOT_LOG" && grep -q \'result=waiting reason=staleness-override-lock\' "$DB_LOG"',
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: { ...env, HOT_READY: hotReady, DB_RAN: dbRan, HOT_LOG: hotLog, DB_LOG: dbLog },
        timeout: 10_000,
      },
    );

    const evidence =
      scenario.stdout +
      '\n' +
      scenario.stderr +
      '\nhot guard:\n' +
      (existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing') +
      '\ndb guard:\n' +
      (existsSync(dbLog) ? readFileSync(dbLog, 'utf8') : 'missing');
    expect(scenario.status, evidence).toBe(0);
  });

  it('does not ignore pressure again on the very next tick after an escalation', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'retry', 25_200);
    expect(run(['--mode', 'scheduled', '--label', 'retry', '--', 'true'], env).stdout).toContain(
      'result=admitted-despite-pressure',
    );

    // A backup failing for a NON-pressure reason would otherwise override
    // pressure on every 5-minute tick forever, so re-staleness alone is not
    // enough to escalate twice in a row.
    seedDeadlineBase(dir, 'retry', 25_200);
    const marker = join(dir, 'must-not-run');
    const second = run(['--mode', 'scheduled', '--label', 'retry', '--', 'touch', marker], env);

    expect(second.status, second.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(second.stdout).toContain('result=deferred reason=memory-pressure');
    expect(second.stdout).toMatch(/escalation_retry_in_sec=\d+/);
    expect(second.stdout).not.toContain('result=admitted-despite-pressure');
    expect(existsSync(marker)).toBe(false);
  });

  it('refunds the escalation of an override cycle that yielded to a priority waiter', () => {
    // Measured 2026-09-29 (WI-10003884): once the hourly db-dump became a
    // --priority-on-contention waiter, it preempted the overdue hot sweep at every
    // :00 tick. Each preempted cycle had spent the once-per-hour escalation, so the
    // :30 tick deferred on pressure with escalation_retry_in_sec and label=hot went
    // 18,958s without a finish. A yield is not the "fails for a non-pressure reason"
    // case the retry exists for, so the next tick must be free to override again.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'hot', 25_200);
    // The dump is overdue too, and its deadline passed BEFORE the sweep's, so under
    // earliest-deadline-first (WI-10004861) the overdue sweep yields at once. A dump
    // that is not yet due, or due after the sweep, is held: see 'keeps an overdue hot
    // sweep running until a waiting dump is itself due' and the EDF tests below.
    seedDeadlineBase(dir, 'db-dump', 25_300);
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; while :; do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe --priority-on-contention -- true >"$DB_LOG" 2>&1 || exit 92
        wait "$hot"
        [ "$?" -eq ${SCHEDULED_DEFER_EXIT} ] || exit 93
        grep -q 'result=staleness-override-armed' "$HOT_LOG" || exit 94
        grep -q 'result=escalation-refunded reason=priority-waiter shared-guard handoff' "$HOT_LOG" || exit 95
        ! grep -q 'reason=holder-overdue' "$HOT_LOG" || exit 96
        ! grep -q 'reason=holder-earlier-deadline' "$HOT_LOG" || exit 97
        `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, HOT_READY: join(dir, 'hot-ready'), HOT_LOG: join(dir, 'hot.log'), DB_LOG: join(dir, 'db.log') },
        timeout: 10_000,
      },
    );
    const hotLog = existsSync(join(dir, 'hot.log')) ? readFileSync(join(dir, 'hot.log'), 'utf8') : 'missing';
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\nhot guard:\n${hotLog}`).toBe(0);

    // The next tick lands on a pressured host with the sweep still overdue.
    pressureFile(join(dir, 'memory.pressure'), 23.84);
    const marker = join(dir, 'ran');
    const next = run(['--mode', 'scheduled', '--label', 'hot', '--', 'touch', marker], env);

    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toContain('result=admitted-despite-pressure reason=memory-pressure');
    expect(next.stdout).not.toContain('escalation_retry_in_sec');
    expect(existsSync(marker)).toBe(true);
  });

  // WI-10004741 defect 2. Measured 2026-10-01: an hours-overdue hot sweep yielded at
  // once to every hourly dump, none of which was itself late, and no hot sweep
  // finished from 23:50Z until past 09:30Z. An overdue holder now keeps the lock until
  // the waiter's own floor arms (its published .due), and yields then.
  it('keeps an overdue hot sweep running until a waiting dump is itself due, then yields', () => {
    const fx = fixture();
    const { dir } = fx;
    // Extension 0 pins the WI-10004741 half on its own: the sweep yields the moment the
    // dump is due. The EDF extension past that point is covered by the tests below.
    const env = { ...fx.env, KOPIA_BACKUP_MAX_DEFER_SEC: '10', KOPIA_BACKUP_PRIORITY_HOLD_EXTENSION_SEC: '0' };
    seedDeadlineBase(dir, 'hot', 25_200);
    const dumpBase = Number(readFileSync(seedDeadlineBase(dir, 'db-dump', 3), 'utf8').trim());
    const dueEpoch = dumpBase + 10;
    const hotLog = join(dir, 'hot.log');
    const dbLog = join(dir, 'db.log');
    const dbRan = join(dir, 'db-ran');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; for _ in $(seq 1 400); do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe --priority-on-contention -- bash -c 'date +%s.%N >"$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1
        db_rc=$?
        wait "$hot"
        hot_rc=$?
        echo "db_rc=$db_rc hot_rc=$hot_rc"
        `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, HOT_READY: join(dir, 'hot-ready'), HOT_LOG: hotLog, DB_LOG: dbLog, DB_RAN: dbRan },
        timeout: 30_000,
      },
    );
    const hotOut = existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing';
    const dbOut = existsSync(dbLog) ? readFileSync(dbLog, 'utf8') : 'missing';
    const evidence = `${scenario.stdout}\n${scenario.stderr}\nhot guard:\n${hotOut}\ndb guard:\n${dbOut}`;

    expect(scenario.stdout, evidence).toContain(`db_rc=0 hot_rc=${SCHEDULED_DEFER_EXIT}`);
    // The sweep is overdue and the dump is not: the dump queues without arming its floor.
    expect(hotOut, evidence).toContain('result=staleness-override-armed');
    expect(dbOut, evidence).toContain('result=waiting reason=priority-on-contention');
    expect(dbOut, evidence).not.toContain('result=staleness-override-armed');
    // The sweep declines exactly once, naming the waiter and how long until it is due.
    const declined = hotOut.match(
      /result=holding-against-priority-waiter reason=holder-overdue waiter=global\.lock\.db-dump\.\d+\.wait waiter_due_in_sec=(\d+) /g,
    );
    expect(declined, evidence).toHaveLength(1);
    // ...then yields once the dump is due, not before and not at its own end.
    expect(hotOut, evidence).toContain('result=stopping-during-run reason=priority-waiter');
    // ...naming the waiter it honored, so the preemption is attributable afterwards.
    expect(hotOut, evidence).toMatch(
      /result=honoring-priority-waiter reason=waiter-due waiter_overdue_sec=-?\d+ waiter=global\.lock\.db-dump\.\d+\.wait waiter_pid=\d+ waiter_mode=scheduled\b/,
    );
    expect(hotOut, evidence).toContain('result=escalation-refunded');
    expect(Number(readFileSync(dbRan, 'utf8').trim()), evidence).toBeGreaterThanOrEqual(dueEpoch);
    expect(
      readdirSync(dir).filter((name) => /\.(wait|due)$/.test(name)),
      evidence,
    ).toEqual([]);
  });

  it('yields an overdue hot sweep at once to a waiter that publishes no deadline', () => {
    // Calibration for the hold above: a protected/manual wait-mode producer,
    // a waiter with no baseline, and a guard from before WI-10004741 all write a marker
    // with no .due. Each counts as due now, so even an overdue sweep yields at once.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'hot', 25_200);
    const hotLog = join(dir, 'hot.log');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; for _ in $(seq 1 400); do sleep 0.05; done' _ "$HOT_READY" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode wait --label protected-manual -- touch "$WAIT_RAN" >/dev/null 2>&1 || exit 92
        wait "$hot"
        [ "$?" -eq ${SCHEDULED_DEFER_EXIT} ] || exit 93
        `,
      ],
      {
        encoding: 'utf8',
        env: { ...env, HOT_READY: join(dir, 'hot-ready'), HOT_LOG: hotLog, WAIT_RAN: join(dir, 'wait-ran') },
        timeout: 10_000,
      },
    );
    const hotOut = existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing';
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\nhot guard:\n${hotOut}`).toBe(0);
    expect(hotOut).toContain('result=staleness-override-armed');
    expect(hotOut).toContain('result=stopping-during-run reason=priority-waiter');
    expect(hotOut).not.toContain('reason=holder-overdue');
    // A marker with no .due is honored as due now -- and the log says so, with its pid.
    expect(hotOut).toMatch(/result=honoring-priority-waiter reason=waiter-due-now waiter=\S+\.wait waiter_pid=\d+ waiter_mode=wait\b/);
    expect(existsSync(join(dir, 'wait-ran'))).toBe(true);
  });

  // WI-10004861. Measured 2026-10-01: the hourly dump holds the shared lock 23-62 min
  // (mostly 42-56) and a sweep must re-hash the ~93 GB it rewrote, so yielding the
  // moment the dump is due (above) still stopped every sweep: 12 of 14 preemptions
  // since 2026-09-30 23:50Z were the dump, and the dumps went 18h without an off-host
  // copy. Between two OVERDUE producers the one whose deadline passed first goes first.
  // The "keeps holding while making progress" cases. The guard stamps progress in
  // whole seconds and the child forks `sleep` per loop, so on a loaded host the
  // child itself goes unscheduled: measured 2026-10-06, gaps between two progress
  // writes of 1-3s at load ~150 and 8s at load ~230, against a 1s limit, yielded a
  // progressing sweep as stalled. A 10s limit absorbs that; 80 loops of 0.25s
  // (~20s nominal, fewer forks) keep the sweep longer than the limit, so a guard that
  // stopped tracking progress still yields mid-sweep and fails the test. The 300s
  // extension keeps the EDF hold window from ending before a slow sweep does.
  const HOLD_PROGRESS_STALL_SEC = 10;
  const HOLD_PROGRESS_LOOPS = 80;
  const HOLD_PROGRESS_SLEEP = '0.25';
  const HOLD_PROGRESS_EXTENSION_SEC = 300;
  const HOLD_PROGRESS_TEST_TIMEOUT_MS = 180_000;

  function edfScenario(opts: {
    extensionSec: number;
    dumpAgeSec: number;
    hotLoops: number;
    // Point the guard's progress counter at a fixture file (an io.stat stand-in).
    // `hotWritesProgress` makes the sweep's child advance it on every loop.
    progressStallSec?: number;
    hotWritesProgress?: boolean;
    hotSleep?: string;
  }) {
    const fx = fixture();
    const { dir } = fx;
    const progressPath = join(dir, 'io.stat');
    const env: NodeJS.ProcessEnv = {
      ...fx.env,
      KOPIA_BACKUP_MAX_DEFER_SEC: '10',
      KOPIA_BACKUP_PRIORITY_HOLD_EXTENSION_SEC: String(opts.extensionSec),
      HOT_PROGRESS: '',
      HOT_SLEEP: opts.hotSleep ?? '0.05',
    };
    if (opts.progressStallSec !== undefined) {
      writeFileSync(progressPath, '8:0 rbytes=0 wbytes=0 rios=0 wios=0\n');
      env.KOPIA_BACKUP_PROGRESS_PATH = progressPath;
      env.KOPIA_BACKUP_PROGRESS_STALL_SEC = String(opts.progressStallSec);
      if (opts.hotWritesProgress) env.HOT_PROGRESS = progressPath;
    }
    seedDeadlineBase(dir, 'hot', 25_200);
    const dumpBase = Number(readFileSync(seedDeadlineBase(dir, 'db-dump', opts.dumpAgeSec), 'utf8').trim());
    const hotLog = join(dir, 'hot.log');
    const dbLog = join(dir, 'db.log');
    const dbRan = join(dir, 'db-ran');
    const hotDone = join(dir, 'hot-done');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; for i in $(seq 1 "$3"); do [ -z "$4" ] || printf "8:0 rbytes=%s wbytes=0\\n" "$i" >"$4"; sleep "$5"; done; date +%s.%N >"$2"' _ "$HOT_READY" "$HOT_DONE" "$HOT_LOOPS" "$HOT_PROGRESS" "$HOT_SLEEP" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe --priority-on-contention -- bash -c 'date +%s.%N >"$1"' _ "$DB_RAN" >"$DB_LOG" 2>&1
        db_rc=$?
        wait "$hot"
        hot_rc=$?
        echo "db_rc=$db_rc hot_rc=$hot_rc"
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_READY: join(dir, 'hot-ready'),
          HOT_DONE: hotDone,
          HOT_LOOPS: String(opts.hotLoops),
          HOT_LOG: hotLog,
          DB_LOG: dbLog,
          DB_RAN: dbRan,
        },
        timeout: 170_000,
      },
    );
    const hotOut = existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing';
    const dbOut = existsSync(dbLog) ? readFileSync(dbLog, 'utf8') : 'missing';
    return {
      dir,
      scenario,
      hotOut,
      dbOut,
      dumpDue: dumpBase + 10,
      dbRanAt: existsSync(dbRan) ? Number(readFileSync(dbRan, 'utf8').trim()) : Number.NaN,
      hotDoneAt: existsSync(hotDone) ? Number(readFileSync(hotDone, 'utf8').trim()) : Number.NaN,
      evidence: `${scenario.stdout}\n${scenario.stderr}\nhot guard:\n${hotOut}\ndb guard:\n${dbOut}`,
    };
  }

  it('lets an overdue sweep whose deadline passed FIRST finish before an overdue dump', () => {
    // The dump is overdue (due 2s ago) and has armed its own floor, but the sweep has
    // been overdue for hours: the sweep runs to its end, then the dump gets the lock.
    const r = edfScenario({ extensionSec: 60, dumpAgeSec: 12, hotLoops: 40 });

    expect(r.scenario.stdout, r.evidence).toContain('db_rc=0 hot_rc=0');
    expect(r.dbOut, r.evidence).toContain('result=waiting reason=staleness-override-lock');
    const held = r.hotOut.match(
      /result=holding-against-priority-waiter reason=holder-earlier-deadline waiter=global\.lock\.db-dump\.\d+\.wait waiter_overdue_sec=\d+ holder_overdue_sec=\d+ hold_ends_in_sec=\d+ /g,
    );
    expect(held, r.evidence).toHaveLength(1);
    expect(r.hotOut, r.evidence).not.toContain('result=stopping-during-run');
    expect(r.hotOut, r.evidence).toContain('result=finished mode=scheduled rc=0');
    expect(r.dbRanAt, r.evidence).toBeGreaterThanOrEqual(r.hotDoneAt);
    expect(
      readdirSync(r.dir).filter((name) => /\.(wait|due)$/.test(name)),
      r.evidence,
    ).toEqual([]);
  });

  it('bounds the earliest-deadline hold: the sweep still yields once the dump is overdue by the extension', () => {
    // A sweep that never finishes must not starve the dump: past its due + extension
    // the dump preempts even a sweep whose own deadline passed hours earlier.
    const r = edfScenario({ extensionSec: 3, dumpAgeSec: 11, hotLoops: 400 });

    expect(r.scenario.stdout, r.evidence).toContain(`db_rc=0 hot_rc=${SCHEDULED_DEFER_EXIT}`);
    const held = r.hotOut.match(/result=holding-against-priority-waiter reason=holder-earlier-deadline /g);
    expect(held, r.evidence).toHaveLength(1);
    expect(r.hotOut, r.evidence).toContain('result=stopping-during-run reason=priority-waiter');
    expect(r.hotOut, r.evidence).toContain('result=escalation-refunded');
    expect(Number.isNaN(r.hotDoneAt), r.evidence).toBe(true);
    expect(r.dbRanAt, r.evidence).toBeGreaterThanOrEqual(r.dumpDue + 3);
  });

  // EI-25211496463956189. A dump whose previous runs FAILED arrives already overdue by
  // more than the extension. Measured 2026-10-06 (EDT): it arrived 4.4h and 6.4h late
  // at the 10:10 and 12:11 ticks and stopped a sweep 11-13h overdue after 5s and after
  // 52 min, because the hold window was anchored at the dump's deadline, which had
  // already passed by more than the extension. The window now starts at its arrival.
  it('still protects an earlier-deadline sweep from a dump that arrives overdue by more than the extension', () => {
    const r = edfScenario({ extensionSec: 60, dumpAgeSec: 3_600, hotLoops: 40 });

    expect(r.scenario.stdout, r.evidence).toContain('db_rc=0 hot_rc=0');
    const held = r.hotOut.match(
      /result=holding-against-priority-waiter reason=holder-earlier-deadline waiter=global\.lock\.db-dump\.\d+\.wait waiter_overdue_sec=(\d+) holder_overdue_sec=\d+ hold_ends_in_sec=(\d+) /,
    );
    expect(held, r.evidence).not.toBeNull();
    // Overdue by ~3590s, yet the hold still has (almost) the whole extension left.
    expect(Number(held![1]), r.evidence).toBeGreaterThan(3_000);
    expect(Number(held![2]), r.evidence).toBeGreaterThan(50);
    expect(r.hotOut, r.evidence).not.toContain('result=stopping-during-run');
    expect(r.dbRanAt, r.evidence).toBeGreaterThanOrEqual(r.hotDoneAt);
  });

  it('keeps holding while the sweep is making I/O progress', () => {
    // The hot child advances the progress counter on every loop, so a stall limit
    // shorter than its runtime never trips. HOLD_PROGRESS_* keeps the sweep ~2x the
    // limit (a guard that stopped tracking progress would still yield mid-sweep)
    // while tolerating multi-second scheduling gaps on a loaded host.
    const r = edfScenario({
      extensionSec: HOLD_PROGRESS_EXTENSION_SEC,
      dumpAgeSec: 12,
      hotLoops: HOLD_PROGRESS_LOOPS,
      progressStallSec: HOLD_PROGRESS_STALL_SEC,
      hotWritesProgress: true,
      hotSleep: HOLD_PROGRESS_SLEEP,
    });

    expect(r.scenario.stdout, r.evidence).toContain('db_rc=0 hot_rc=0');
    expect(r.hotOut, r.evidence).toContain('reason=holder-earlier-deadline');
    expect(r.hotOut, r.evidence).not.toContain('reason=holder-stalled');
    expect(r.hotOut, r.evidence).not.toContain('result=stopping-during-run');
    expect(r.dbRanAt, r.evidence).toBeGreaterThanOrEqual(r.hotDoneAt);
  }, HOLD_PROGRESS_TEST_TIMEOUT_MS);

  it('yields a sweep whose I/O has stalled instead of holding a due dump for the whole extension', () => {
    // Same overdue sweep and waiter, but the progress counter never moves: past the
    // stall limit the sweep is stuck, and keeping the dump waiting buys nothing.
    const r = edfScenario({ extensionSec: 60, dumpAgeSec: 12, hotLoops: 400, progressStallSec: 1 });

    expect(r.scenario.stdout, r.evidence).toContain(`db_rc=0 hot_rc=${SCHEDULED_DEFER_EXIT}`);
    expect(r.hotOut, r.evidence).toMatch(
      /result=yielding-to-priority-waiter reason=holder-stalled waiter=global\.lock\.db-dump\.\d+\.wait would_hold=holder-earlier-deadline stalled_sec=\d+ stall_limit_sec=1 /,
    );
    expect(r.hotOut, r.evidence).toContain('result=stopping-during-run reason=priority-waiter');
    expect(Number.isNaN(r.hotDoneAt), r.evidence).toBe(true);
    // Well inside the 60s extension: the stall, not the extension, ended the hold.
    expect(r.dbRanAt - r.dumpDue, r.evidence).toBeLessThan(30);
  });

  // EI-25211496463956189. A wait-mode marker publishes no deadline, so it stops even an
  // overdue sweep at once (calibration above). Measured 2026-10-06 09:57 EDT: the
  // per-workspace DB hook's dump stopped the overdue hot sweep 3s after it began
  // waiting, then was killed at its own 900s budget. --deadline-at-arrival gives such a
  // waiter its arrival as its deadline, so the earliest-deadline hold and the progress
  // check apply to it.
  function arrivalWaiterScenario(opts: {
    hotLoops: number;
    hotWritesProgress: boolean;
    progressStallSec?: number;
    hotSleep?: string;
    extensionSec?: number;
  }) {
    const fx = fixture();
    const { dir } = fx;
    const progressPath = join(dir, 'io.stat');
    writeFileSync(progressPath, '8:0 rbytes=0 wbytes=0 rios=0 wios=0\n');
    seedDeadlineBase(dir, 'hot', 25_200);
    const hotLog = join(dir, 'hot.log');
    const waitLog = join(dir, 'wait.log');
    const waitRan = join(dir, 'wait-ran');
    const hotDone = join(dir, 'hot-done');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash -c 'touch "$1"; for i in $(seq 1 "$3"); do [ -z "$4" ] || printf "8:0 rbytes=%s wbytes=0\\n" "$i" >"$4"; sleep "$5"; done; date +%s.%N >"$2"' _ "$HOT_READY" "$HOT_DONE" "$HOT_LOOPS" "$HOT_PROGRESS" "$HOT_SLEEP" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode wait --label workspace-db-dump --deadline-at-arrival -- bash -c 'date +%s.%N >"$1"' _ "$WAIT_RAN" >"$WAIT_LOG" 2>&1
        wait_rc=$?
        wait "$hot"
        hot_rc=$?
        echo "wait_rc=$wait_rc hot_rc=$hot_rc"
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...fx.env,
          KOPIA_BACKUP_MAX_DEFER_SEC: '10',
          KOPIA_BACKUP_PRIORITY_HOLD_EXTENSION_SEC: String(opts.extensionSec ?? 60),
          KOPIA_BACKUP_PROGRESS_PATH: progressPath,
          KOPIA_BACKUP_PROGRESS_STALL_SEC: String(opts.progressStallSec ?? 1),
          HOT_PROGRESS: opts.hotWritesProgress ? progressPath : '',
          HOT_SLEEP: opts.hotSleep ?? '0.05',
          HOT_READY: join(dir, 'hot-ready'),
          HOT_DONE: hotDone,
          HOT_LOOPS: String(opts.hotLoops),
          HOT_LOG: hotLog,
          WAIT_LOG: waitLog,
          WAIT_RAN: waitRan,
        },
        timeout: 170_000,
      },
    );
    const hotOut = existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing';
    const waitOut = existsSync(waitLog) ? readFileSync(waitLog, 'utf8') : 'missing';
    return {
      scenario,
      hotOut,
      waitRanAt: existsSync(waitRan) ? Number(readFileSync(waitRan, 'utf8').trim()) : Number.NaN,
      hotDoneAt: existsSync(hotDone) ? Number(readFileSync(hotDone, 'utf8').trim()) : Number.NaN,
      evidence: `${scenario.stdout}\n${scenario.stderr}\nhot guard:\n${hotOut}\nwait guard:\n${waitOut}`,
    };
  }

  it('lets an overdue sweep that is making progress finish before a --deadline-at-arrival waiter', () => {
    const r = arrivalWaiterScenario({
      hotLoops: HOLD_PROGRESS_LOOPS,
      hotWritesProgress: true,
      progressStallSec: HOLD_PROGRESS_STALL_SEC,
      hotSleep: HOLD_PROGRESS_SLEEP,
      extensionSec: HOLD_PROGRESS_EXTENSION_SEC,
    });

    expect(r.scenario.stdout, r.evidence).toContain('wait_rc=0 hot_rc=0');
    expect(r.hotOut, r.evidence).toContain('result=staleness-override-armed');
    expect(r.hotOut, r.evidence).toContain('result=holding-against-priority-waiter reason=holder-earlier-deadline');
    expect(r.hotOut, r.evidence).not.toContain('result=stopping-during-run');
    expect(r.waitRanAt, r.evidence).toBeGreaterThanOrEqual(r.hotDoneAt);
  }, HOLD_PROGRESS_TEST_TIMEOUT_MS);

  it('still yields to a --deadline-at-arrival waiter once the sweep has stalled', () => {
    const r = arrivalWaiterScenario({ hotLoops: 400, hotWritesProgress: false });

    expect(r.scenario.stdout, r.evidence).toContain(`wait_rc=0 hot_rc=${SCHEDULED_DEFER_EXIT}`);
    expect(r.hotOut, r.evidence).toMatch(
      /result=yielding-to-priority-waiter reason=holder-stalled waiter=\S+\.wait would_hold=holder-earlier-deadline /,
    );
    expect(r.hotOut, r.evidence).toContain('result=stopping-during-run reason=priority-waiter');
    expect(Number.isNaN(r.hotDoneAt), r.evidence).toBe(true);
    expect(Number.isNaN(r.waitRanAt), r.evidence).toBe(false);
  });

  it('rejects --deadline-at-arrival outside wait mode', () => {
    const { env } = fixture();
    const r = spawnSync('bash', ['-c', '"$GUARD" --mode scheduled --label hot --deadline-at-arrival -- true'], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(64);
    expect(r.stderr).toContain('usage:');
  });

  it('keeps the escalation spent when an override cycle ends on its own', () => {
    // Calibration for the refund above: only a handoff refunds. A cycle that ran to
    // its own exit -- here a failing child -- keeps the retry window, exactly as
    // 'does not ignore pressure again on the very next tick after an escalation'.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'hot', 25_200);
    const first = run(['--mode', 'scheduled', '--label', 'hot', '--', 'false'], env);
    expect(first.stdout).toContain('result=staleness-override-armed');
    expect(first.stdout).not.toContain('escalation-refunded');

    pressureFile(join(dir, 'memory.pressure'), 23.84);
    const next = run(['--mode', 'scheduled', '--label', 'hot', '--', 'true'], env);
    expect(next.status, next.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(next.stdout).toMatch(/escalation_retry_in_sec=\d+/);
  });

  it('waits for the lock when a scheduled cycle is already past its staleness deadline', async () => {
    const fx = fixture();
    seedDeadlineBase(fx.dir, 'stale-lock', 25_200);
    const result = await contendWithFixtureHolder(fx, ['--mode', 'scheduled', '--label', 'stale-lock'],
      'staleness-override-lock');
    expect(result.status, result.output).toBe(0);
    expect(result.ran, result.output).toBe(true);
  }, 30_000);

  // WI-10003884, second half. The --priority-on-contention lock wait went live and the
  // very first tick after it (13:00 EDT 2026-09-29) waited out the lock for 5s, then
  // logged result=deferred reason=io-pressure full_avg10=15.40 staleness_sec=2003: the
  // same hour, lost to the OTHER obstacle. Cadence == deadline means ANY deferral at the
  // post-success tick halves the cadence, so admission pressure must be a bounded wait
  // too. A/B on identical pressure and staleness, one flag apart.
  it('waits out admission pressure, without holding the lock, when the producer asks for --priority-on-contention', async () => {
    const { dir, env } = fixture(0, 15.4);

    // A: no flag. Every other scheduled label keeps today's contract.
    seedDeadlineBase(dir, 'plain', 2_003);
    const plainMarker = join(dir, 'plain-must-not-run');
    const plain = run(['--mode', 'scheduled', '--label', 'plain', '--', 'touch', plainMarker], env);
    expect(plain.status, plain.stderr).toBe(SCHEDULED_DEFER_EXIT);
    expect(plain.stdout).toContain('result=deferred reason=io-pressure full_avg10=15.40');
    expect(plain.stdout).not.toContain('priority-on-pressure');
    expect(existsSync(plainMarker)).toBe(false);

    // B: the flag, as the db-dump unit passes it.
    seedDeadlineBase(dir, 'db-dump', 2_003);
    const dbRan = join(dir, 'db-ran');
    const child = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'db-dump', '--no-restart-safe', '--priority-on-contention', '--', 'touch', dbRan],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const closed = new Promise<number | null>((resolve) => child.once('close', resolve));

    try {
      await waitForOutput(() => stdout, 'result=waiting reason=priority-on-pressure io-pressure full_avg10=15.40');
      // The shared lock is RELEASED for the wait. Wait-mode producers ignore pressure by
      // design; holding the lock here would park them behind someone else's PSI for up to
      // the whole wait. If the lock were held, this blocks until run()'s 10s timeout.
      const holderRan = join(dir, 'holder-ran');
      const holder = run(['--mode', 'wait', '--label', 'protected-manual', '--', 'touch', holderRan], env);
      expect(holder.status, `${holder.stdout}\n${holder.stderr}`).toBe(0);
      expect(existsSync(holderRan)).toBe(true);
      expect(existsSync(dbRan)).toBe(false);

      pressureFile(env.KOPIA_BACKUP_IO_PSI_PATH!, 3);
      await expect(closed).resolves.toBe(0);
    } finally {
      // A failed assertion above must not strand a guard that is still waiting on
      // pressure: it would sit out its whole budget (an hour by default) after the test
      // is gone -- the leaked-fixture class of WI-10002887.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    expect(stderr).toBe('');
    expect(stdout).toMatch(/result=pressure-cleared waited_sec=\d+/);
    expect(stdout).toContain('result=finished mode=scheduled rc=0');
    expect(stdout).not.toContain('result=deferred');
    // Pressure cleared on its own, so the floor never had to override it.
    expect(stdout).not.toContain('result=admitted-despite-pressure');
    expect(existsSync(dbRan)).toBe(true);
  }, 30_000);

  it('admits a --priority-on-contention producer once its pressure wait reaches the staleness deadline', () => {
    const { dir, env } = fixture(0, 15.4);
    // ~2s short of max_defer=3600, under pressure that never lifts.
    seedDeadlineBase(dir, 'db-dump', 3_598);
    const marker = join(dir, 'ran');
    const result = run(
      ['--mode', 'scheduled', '--label', 'db-dump', '--no-restart-safe', '--priority-on-contention', '--', 'touch', marker],
      env,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const out = result.stdout;
    const waiting = out.indexOf('result=waiting reason=priority-on-pressure');
    const armed = out.indexOf('result=staleness-override-armed');
    const admitted = out.indexOf('result=admitted-despite-pressure reason=io-pressure');
    const finished = out.indexOf('result=finished mode=scheduled rc=0');
    // The same admission the NEXT tick would have made an hour later, made in-cycle.
    expect(waiting, out).toBeGreaterThanOrEqual(0);
    expect(armed, out).toBeGreaterThan(waiting);
    expect(admitted, out).toBeGreaterThan(armed);
    expect(finished, out).toBeGreaterThan(admitted);
    expect(out).not.toContain('result=deferred');
    expect(existsSync(marker)).toBe(true);
  });

  it('defers after the priority pressure wait spends its budget, and says how long it waited', () => {
    const fx = fixture(0, 15.4);
    const { dir } = fx;
    const env = { ...fx.env, KOPIA_BACKUP_PRIORITY_PRESSURE_WAIT_MAX_SEC: '1' };
    // Far from max_defer, so only the budget can end this wait.
    seedDeadlineBase(dir, 'db-dump', 2_003);
    const marker = join(dir, 'must-not-run');
    const result = run(
      ['--mode', 'scheduled', '--label', 'db-dump', '--no-restart-safe', '--priority-on-contention', '--', 'touch', marker],
      env,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(SCHEDULED_DEFER_EXIT);
    expect(result.stdout).toContain('result=waiting reason=priority-on-pressure');
    expect(result.stdout).toMatch(
      /result=deferred reason=io-pressure full_avg10=15\.40 limit=10 staleness_sec=\d+ max_defer_sec=3600 waited_sec=[1-9]\d*/,
    );
    expect(result.stdout).not.toContain('result=started');
    expect(existsSync(marker)).toBe(false);
  });

  // WI-10004666. Measured 2026-10-01: the 07:10Z db-dump tick contended for the lock
  // FIRST, which registered the priority marker and stopped a hot sweep 36 min in
  // (154.5G read); only then did it check its own admission, log priority-on-pressure
  // io full_avg10=24.08, and wait. The sweep was stopped for a cycle that did not run.
  // A priority producer must wait out its own pressure before it asks anyone to yield.
  it('does not stop a running hot sweep while the priority producer is itself pressure-blocked', async () => {
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'db-dump', 2_003);
    const hotReady = join(dir, 'hot-ready');
    const dbRan = join(dir, 'db-ran');
    const collect = (child: ReturnType<typeof spawn>) => {
      const out = { text: '' };
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        out.text += chunk;
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        out.text += chunk;
      });
      return out;
    };
    const hot = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'hot', '--', 'bash', '-c', 'touch "$1"; while :; do sleep 0.05; done', '_', hotReady],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const hotOut = collect(hot);
    const hotClosed = new Promise<number | null>((resolve) => hot.once('close', resolve));
    let db: ReturnType<typeof spawn> | undefined;
    let dbOut = { text: '' };
    try {
      await waitForPath(hotReady);
      // The sweep was admitted on a quiet host; pressure rises while it runs.
      pressureFile(env.KOPIA_BACKUP_IO_PSI_PATH!, 15.4);
      db = spawn(
        'bash',
        [guard, '--mode', 'scheduled', '--label', 'db-dump', '--no-restart-safe', '--priority-on-contention', '--', 'touch', dbRan],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      dbOut = collect(db);
      const dbClosed = new Promise<number | null>((resolve) => db!.once('close', resolve));

      await waitForOutput(() => dbOut.text, 'result=waiting reason=priority-on-pressure io-pressure full_avg10=15.40');
      // ~20 of the sweep's 0.05s handoff polls: a registered marker would have stopped it.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(hotOut.text, hotOut.text).not.toContain('result=stopping-during-run');
      expect(hot.exitCode).toBeNull();
      expect(dbOut.text).not.toContain('reason=priority-on-contention');
      expect(existsSync(dbRan)).toBe(false);

      // Once the producer's own admission clears, it contends and the sweep yields.
      pressureFile(env.KOPIA_BACKUP_IO_PSI_PATH!, 3);
      await expect(dbClosed).resolves.toBe(0);
      await expect(hotClosed).resolves.toBe(SCHEDULED_DEFER_EXIT);
    } finally {
      for (const child of [hot, db]) {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    const out = dbOut.text;
    const waited = out.indexOf('result=waiting reason=priority-on-pressure');
    const cleared = out.indexOf('result=pressure-cleared');
    const contended = out.indexOf('result=waiting reason=priority-on-contention');
    const started = out.indexOf('result=started mode=scheduled');
    expect(waited, out).toBeGreaterThanOrEqual(0);
    expect(cleared, out).toBeGreaterThan(waited);
    expect(contended, out).toBeGreaterThan(cleared);
    expect(started, out).toBeGreaterThan(contended);
    expect(hotOut.text).toContain('result=stopping-during-run reason=priority-waiter');
    // A holder that is not overdue honors every waiter at once; the log names which.
    expect(hotOut.text).toMatch(
      /result=honoring-priority-waiter reason=holder-not-overdue waiter=\S+\.wait waiter_pid=\d+ waiter_mode=scheduled\b/,
    );
    expect(existsSync(dbRan)).toBe(true);
  }, 30_000);

  // WI-10004666, second half. A sweep that yielded to this cycle has already lost its
  // work, so releasing the lock to re-wait on pressure that returned during the
  // seconds-long handoff throws that work away for nothing. The sweep's child here
  // raises io pressure as it is stopped; the producer must keep the lock and run.
  it('keeps a lock won through a fresh handoff even if pressure returns during it', () => {
    const fx = fixture();
    const { dir } = fx;
    // A 1s pressure budget: re-waiting instead of keeping the lock would defer (75).
    const env = { ...fx.env, KOPIA_BACKUP_PRIORITY_PRESSURE_WAIT_MAX_SEC: '1' };
    seedDeadlineBase(dir, 'db-dump', 2_003);
    const ioHigh = join(dir, 'io.high');
    pressureFile(ioHigh, 15.4);
    const hotChild = join(dir, 'hot-child.sh');
    writeFileSync(hotChild, '#!/usr/bin/env bash\ntrap \'cp "$2" "$3"; exit 0\' TERM\ntouch "$1"\nwhile :; do sleep 0.05; done\n');
    chmodSync(hotChild, 0o755);
    const hotLog = join(dir, 'hot.log');
    const dbLog = join(dir, 'db.log');
    const scenario = spawnSync(
      'bash',
      [
        '-c',
        `
        set -uo pipefail
        "$GUARD" --mode scheduled --label hot -- bash "$HOT_CHILD" "$HOT_READY" "$IO_HIGH" "$KOPIA_BACKUP_IO_PSI_PATH" >"$HOT_LOG" 2>&1 &
        hot=$!
        for _ in $(seq 1 100); do [ -e "$HOT_READY" ] && break; sleep 0.01; done
        [ -e "$HOT_READY" ] || exit 91
        "$GUARD" --mode scheduled --label db-dump --no-restart-safe --priority-on-contention -- touch "$DB_RAN" >"$DB_LOG" 2>&1
        db_rc=$?
        wait "$hot"
        hot_rc=$?
        [ "$db_rc" -eq 0 ] || exit 92
        [ -e "$DB_RAN" ] || exit 93
        [ "$hot_rc" -eq ${SCHEDULED_DEFER_EXIT} ] || exit 94
        grep -q 'result=stopping-during-run reason=priority-waiter' "$HOT_LOG" || exit 95
        `,
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          HOT_CHILD: hotChild,
          HOT_READY: join(dir, 'hot-ready'),
          IO_HIGH: ioHigh,
          HOT_LOG: hotLog,
          DB_RAN: join(dir, 'db-ran'),
          DB_LOG: dbLog,
        },
        timeout: 10_000,
      },
    );
    const dbOut = existsSync(dbLog) ? readFileSync(dbLog, 'utf8') : 'missing';
    const hotOut = existsSync(hotLog) ? readFileSync(hotLog, 'utf8') : 'missing';
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\ndb guard:\n${dbOut}\nhot guard:\n${hotOut}`).toBe(0);
    // The pressure the stopped sweep left behind is real and still visible...
    expect(dbOut).toMatch(/result=admitted-after-handoff reason=io-pressure full_avg10=15\.40 limit=10 lock_waited_sec=\d+/);
    // ...but it did not send the producer back to wait.
    expect(dbOut).not.toContain('result=waiting reason=priority-on-pressure');
    expect(dbOut).toContain('result=finished mode=scheduled rc=0');
    // WI-10004741: the yielding sweep stamped a handoff note and the producer consumed it.
    expect(dbOut).toMatch(/result=admitted-after-handoff .* handoff_note_age_sec=\d+ /);
    expect(existsSync(`${env.KOPIA_BACKUP_LOCK_PATH}.handoff`)).toBe(false);
  });

  // WI-10004741. Measured 2026-10-01 09:05Z: the db-dump waited 1154s behind the daily
  // home snapshot (a holder that never yields), then received the lock from the hot sweep
  // that had been stopped for it 5s earlier, and still released the lock to re-wait on
  // pressure. A long TOTAL wait must not make that handoff look stale: the releasing
  // holder's note decides. Without a note the reading really is stale, and the producer
  // re-waits as before (the control below).
  async function longWaitBehindHolder(withNote: boolean) {
    const fx = fixture();
    const { dir } = fx;
    // handoff_fresh_sec = monitor 0.05 + grace 1 + 5 = 6s. No child is TERM'd here,
    // so the shortened grace cannot race a trap (see the fixture's grace note).
    const env = {
      ...fx.env,
      KOPIA_BACKUP_STOP_GRACE_SEC: '1',
      KOPIA_BACKUP_PRIORITY_PRESSURE_WAIT_MAX_SEC: '1',
    };
    seedDeadlineBase(dir, 'db-dump', 2_003);
    const ioHigh = join(dir, 'io.high');
    pressureFile(ioHigh, 15.4);
    const dbLog = join(dir, 'db.log');
    const dbRan = join(dir, 'db-ran');
    const ready = join(dir, 'holder-ready');
    const release = join(dir, 'release-holder');
    const witness = witnessBlockingFlock(dir);
    const holder = spawn('bash', ['-c', `
      exec 9>>"$KOPIA_BACKUP_LOCK_PATH"
      /usr/bin/flock 9
      touch "$HOLDER_READY"
      while [ ! -e "$RELEASE" ]; do sleep 0.01; done
      cp "$IO_HIGH" "$KOPIA_BACKUP_IO_PSI_PATH"
      if [ "$WITH_NOTE" = 1 ]; then date +%s >"$KOPIA_BACKUP_LOCK_PATH.handoff"; fi
    `], { env: { ...env, HOLDER_READY: ready, RELEASE: release, IO_HIGH: ioHigh, WITH_NOTE: withNote ? '1' : '0' },
      stdio: 'ignore', detached: true });
    const holderClosed = new Promise<number | null>((resolve) => holder.once('close', resolve));
    let child: ReturnType<typeof spawn> | undefined;
    let closed: Promise<number | null> | undefined;
    let dbOut = '';
    try {
      await waitForPath(ready);
      child = spawn('bash', [guard, '--mode', 'scheduled', '--label', 'db-dump', '--no-restart-safe', '--priority-on-contention', '--', 'touch', dbRan],
        { env: { ...env, ...witness.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      closed = new Promise<number | null>((resolve) => child!.once('close', resolve));
      child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { dbOut += chunk; });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { dbOut += chunk; });
      await waitForKernelFlockBlock(witness.pidPath);
      await waitForOutput(() => dbOut, 'result=waiting reason=priority-on-contention');
      // This duration starts AFTER the guard entered its blocking flock call,
      // rather than after holder startup. It must exceed the 6s freshness window.
      await new Promise((resolve) => setTimeout(resolve, 7_500));
      expect(existsSync(dbRan), dbOut).toBe(false);
      writeFileSync(release, 'release after measured long contention');
      const status = await closed;
      await holderClosed;
      writeFileSync(dbLog, dbOut);
      return { scenario: { status, stdout: '', stderr: '' }, dbOut, ran: existsSync(dbRan), notePath: `${env.KOPIA_BACKUP_LOCK_PATH}.handoff` };
    } finally {
      writeFileSync(release, 'cleanup');
      if (child && closed) await stopFixtureGroup(child, closed);
      await stopFixtureGroup(holder, holderClosed);
    }
  }

  it('keeps a lock handed over after a long wait behind a non-yielding holder when the handoff note is fresh', async () => {
    const { scenario, dbOut, ran, notePath } = await longWaitBehindHolder(true);
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\ndb guard:\n${dbOut}`).toBe(0);
    const admitted = dbOut.match(
      /result=admitted-after-handoff reason=io-pressure full_avg10=15\.40 limit=10 lock_waited_sec=(\d+) handoff_note_age_sec=(\d+) /,
    );
    expect(admitted, dbOut).not.toBeNull();
    // The total wait really was past the freshness window; only the note kept the lock.
    expect(Number(admitted![1])).toBeGreaterThan(6);
    expect(Number(admitted![2])).toBeLessThanOrEqual(6);
    expect(dbOut).not.toContain('result=waiting reason=priority-on-pressure');
    expect(ran).toBe(true);
    expect(existsSync(notePath)).toBe(false);
  }, 30_000);

  it('re-waits on pressure after a long wait when the holder left no handoff note', async () => {
    const { scenario, dbOut, ran } = await longWaitBehindHolder(false);
    expect(scenario.status, `${scenario.stdout}\n${scenario.stderr}\ndb guard:\n${dbOut}`).toBe(SCHEDULED_DEFER_EXIT);
    expect(dbOut).not.toContain('result=admitted-after-handoff');
    expect(dbOut).toContain('result=waiting reason=priority-on-pressure io-pressure full_avg10=15.40');
    expect(ran).toBe(false);
  }, 30_000);

  it('does not retire an escalated run on the same pressure that admitted it', () => {
    const { dir, env } = fixture(23.84);
    seedDeadlineBase(dir, 'armed', 25_200);
    const done = join(dir, 'done');
    // Leaving the runtime abort armed would kill this child within one monitor
    // interval on the very pressure admission just overrode, making the whole
    // floor inert: the log would say admitted, then deferred, and still produce
    // no snapshot. The unit's cgroup limits remain the brake for such a run.
    const result = run(
      ['--mode', 'scheduled', '--label', 'armed', '--', 'bash', '-c', `sleep 0.6; touch "${done}"`],
      env,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('deferred-during-run');
    expect(result.stdout).toContain('result=finished mode=scheduled rc=0');
    expect(existsSync(done)).toBe(true);
  });

  it('resets the staleness clock only for a run that actually completed', () => {
    const { dir, env } = fixture();
    const basePath = seedDeadlineBase(dir, 'failing', 25_200);
    const before = readFileSync(basePath, 'utf8');
    const result = run(['--mode', 'scheduled', '--label', 'failing', '--', 'false'], env);

    // A non-zero child must not look like coverage, or a permanently broken
    // backup would keep pushing its own deadline forward and never escalate —
    // the deadline would then measure "how recently we tried", which is exactly
    // the reassuring-but-empty signal this whole floor exists to replace.
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('result=finished mode=scheduled');
    expect(readFileSync(basePath, 'utf8')).toBe(before);
  });

  it('does not classify a scheduled child EX_TEMPFAIL as an intentional guard deferral', () => {
    const { env } = fixture();
    const result = run(['--mode', 'scheduled', '--label', 'child-tempfail', '--', 'bash', '-c', 'exit 75'], env);

    // The scheduled systemd units accept 75 for the guard's own retryable
    // deferral. A child returning the same code is a real failure, so the guard
    // preserves it in the log and maps the process status to another failure
    // code instead of allowing SuccessExitStatus=75 to hide it.
    expect(result.status).toBe(74);
    expect(result.stdout).toContain('result=finished mode=scheduled rc=75 normalized_rc=74');
    expect(result.stdout).not.toContain('result=deferred');
  });

  it('lets a stale cycle finish even when it passed admission and pressure rose mid-run', async () => {
    // THE DOMINANT REAL FAILURE, and the one an admission-only floor misses
    // entirely: 46 of 51 cycles in the 48h sample passed admission during a lull
    // and were then retired seconds in by a transient crossing. If the override
    // only covered admission, every one of those would still die and coverage
    // would still never complete.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'midrun', 25_200);
    const ready = join(dir, 'ready');
    const finished = join(dir, 'finished');
    const child = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'midrun', '--', 'bash', '-c', `touch "$1"; sleep 1; touch "$2"`, '_', ready, finished],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });

    await waitForPath(ready);
    // Admission already passed under safe pressure; now cross both budgets hard.
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH as string, 23.84);
    pressureFile(env.KOPIA_BACKUP_IO_PSI_PATH as string, 40);
    const status: number = await new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    expect(stdout).toContain('result=staleness-override-armed');
    expect(stdout).not.toContain('stopping-during-run');
    expect(stdout).not.toContain('deferred-during-run');
    expect(status).toBe(0);
    expect(existsSync(finished)).toBe(true);
  });

  it('lets a FRESH-baseline cycle finish under mid-run pressure too, without arming the override', async () => {
    // Was 'still retires a mid-run pressure crossing when coverage is NOT stale',
    // guarding the staleness override against becoming an always-on bypass. The
    // override is not what changed: mid-run pressure cancellation was removed
    // outright (see the run-mid-pressure test above), so a fresh baseline now
    // completes for the same reason a stale one does. The half still worth
    // pinning is that finishing here is NOT the override firing -- the override
    // must stay reachable only past the staleness deadline, so its absence in a
    // fresh-baseline run is the assertion that matters.
    const { dir, env } = fixture();
    seedDeadlineBase(dir, 'fresh', 0);
    const ready = join(dir, 'ready');
    const child = spawn(
      'bash',
      [guard, '--mode', 'scheduled', '--label', 'fresh', '--', 'bash', '-c', `touch "$1"; sleep 1; exit 0`, '_', ready],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });

    await waitForPath(ready);
    pressureFile(env.KOPIA_BACKUP_MEM_PSI_PATH as string, 23.84);
    await new Promise((resolve) => child.on('close', resolve));

    expect(stdout).not.toContain('result=staleness-override-armed');
    expect(stdout).not.toContain('deferred-during-run');
    expect(stdout).toContain('result=finished mode=scheduled rc=0');
  });
});
