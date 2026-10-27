/**
 * spawner-sidecar-cgroup-confinement.test.ts — EI-19479764372783341.
 *
 * THE PROPERTY: the spawner sidecar must be born into its OWN transient systemd
 * scope, which is a SIBLING of `papercup-bg-host.service`, not a child of it.
 *
 * Before this, the site was a raw `spawn(cmd, args, { detached: false })`, which
 * inherits the caller's cgroup. That put the sidecar — and the five desktop-app
 * `serve.mjs` processes it goes on to parent — inside bg-host's control group, so
 * `systemctl restart papercup-bg-host` (the documented way to activate ANY
 * routines code change) killed all of them, plus an in-flight `pg_dump`: ~208
 * tasks measured 2026-08-04. All three restart triggers hit it, including
 * `bghost-watchdog.mjs` firing UNATTENDED, which alerts nobody on a single
 * successful restart.
 *
 * WHY THIS FILE EXISTS RATHER THAN A LINT RULE: `lint:no-unenrolled-spawn` keys on
 * `detached: true`, and this site is `detached: false` — it was invisible to that
 * guard BY CONSTRUCTION, never even reaching its allowlist (EI-19483245448673321).
 * Detachment is the wrong property; the hazard is CGROUP LIFETIME COUPLING, which
 * a long-lived `detached: false` child has in full. So the property is asserted
 * here, against the argv that actually reaches `spawn()`.
 *
 * FALSIFIABILITY: `legacyRawSpawnArgv()` below is a PERMANENT control — the exact
 * pre-fix launch shape, kept in this file and asserted to FAIL the same predicate
 * the real subject must pass. A guard that has never failed is a guard nobody has
 * tested; keeping the wrong implementation here means the predicate is proven
 * discriminating on every run, without ever mutating the shared tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();

// The cross-process adoption probe. Stubbed because the real one opens a unix
// socket, and this file must stay hermetic — but note the DEFAULT below is
// `false` (nothing is serving), so every pre-existing test in this file keeps its
// original spawn-a-child behavior and only the adoption cases opt in.
const probeAliveMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../sidecar-socket/pid-keyed-socket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sidecar-socket/pid-keyed-socket')>()),
  probeUnixSocketAlive: (...a: unknown[]) => probeAliveMock(...(a as [])),
}));
/** Captures the `systemctl --user kill …` the shutdown paths issue against the
 *  sidecar's OWN scope (EI-20200233989444731). Stubbed so a unit test never
 *  signals a real cgroup on the developer's box.
 *
 *  The parameters are TYPED on purpose: an untyped `vi.fn(() => …)` gives
 *  `mock.calls` an empty-tuple element type, so every `calls[n][0]` read below
 *  fails typecheck with TS2493 while the test itself passes. */
const execFileMock = vi.hoisted(() => vi.fn());

// Partial mock — keep the real surface for everything this file does not stub
// (a full replacement breaks at import time on transitive promisify(execFile)).
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
  execFile: (...a: unknown[]) => execFileMock(...(a as [string, readonly string[], unknown, (...args: unknown[]) => void])),
}));

// Hermetic ledger. The real store needs Postgres, and this file is about the
// ARGV, not the database — but it also lets us drive the two ledger failure
// modes deliberately, which is the point of the fail-soft cases below.
const L = vi.hoisted(() => ({
  registerThrows: null as Error | null,
  markThrows: null as Error | null,
  marked: [] as unknown[],
}));
// The task-manager flag. `setTaskManagerEnabledForTest` is NOT enough here: it
// only sets the cache the SYNC reader consults, while `managedSpawn` takes the
// ASYNC `isTaskManagerEnabled()`, which unconditionally awaits `getFlag(...)`.
// With no flag backend in a unit test that promise simply stays pending, so the
// spawn never happens and every assertion below reads "called 0 times" — a
// hang wearing the costume of a missing call.
vi.mock('../task-manager/enabled', () => ({
  isTaskManagerEnabled: async () => true,
  taskManagerEnabledSync: () => true,
  warmTaskManagerFlag: () => {},
  setTaskManagerEnabledForTest: () => {},
}));

vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId?: string }) => {
    if (L.registerThrows) throw L.registerThrows;
    return { taskId: opts?.taskId ?? 'task-test', state: 'pending' };
  },
  markSpawned: async (_id: string, v: unknown) => {
    if (L.markThrows) throw L.markThrows;
    L.marked.push(v);
  },
  closeTask: async () => {},
}));

import {
  _resetSpawnerSidecarSpawnStateForTests,
  hasAdoptedSpawnerSidecar,
  spawnSpawnerSidecar,
  stopSpawnerSidecar,
  stopSpawnerSidecarAtHostExit,
  isSpawnerSidecarRunning,
} from './spawner-sidecar-spawn';
import { SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket';
import { probeScopeSupport, resetScopeProbe } from '../task-manager/managed-spawn';
import type { CgroupFs } from '../task-manager/cgroup-read';
import { setTaskManagerEnabledForTest } from '../task-manager/enabled';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.killed = false;
  child.stdout = makeReplayableStdout();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
  });
  return child;
}

/** Buffer an early handshake until spawnSpawnerSidecar has attached its listener. */
function makeReplayableStdout(): EventEmitter {
  const stdout = new EventEmitter();
  const emit = stdout.emit.bind(stdout);
  const pending: unknown[][] = [];
  stdout.emit = ((event: string, ...args: unknown[]) => {
    if (event === 'data' && stdout.listenerCount('data') === 0) {
      pending.push(args);
      return false;
    }
    return emit(event, ...args);
  }) as typeof stdout.emit;
  stdout.on('newListener', (event) => {
    if (event !== 'data' || pending.length === 0) return;
    const buffered = pending.splice(0);
    process.nextTick(() => buffered.forEach((args) => emit('data', ...args)));
  });
  return stdout;
}

/** Let the promise chain inside managedSpawn (probe → ledger → spawn) settle.
 *  managedSpawn is async, so unlike the old synchronous spawn() the child does
 *  not exist on the tick the caller returns. */
async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/**
 * THE PREDICATE. "Was this launch confined into its own transient scope?"
 *
 * `--scope` (not `--service`/`--unit=…service`) is load-bearing twice over: the
 * payload stays OUR child, so piped stdio survives and the PAPERCUSP_SPAWNER_READY
 * handshake still arrives; and the transient scope is a SIBLING of the calling
 * service, so KillMode=control-group on that service cannot reach it.
 */
function isConfinedToSiblingScope(cmd: string, args: string[]): boolean {
  return (
    cmd === 'systemd-run' &&
    args.includes('--user') &&
    args.includes('--scope') &&
    args.some((a) => a.startsWith('--unit='))
  );
}

/** THE PERMANENT CONTROL — the pre-fix launch shape, verbatim in spirit:
 *  `spawn(cmd, args, { detached: false })`, no wrapper, inherits the caller's
 *  cgroup. Kept forever so `isConfinedToSiblingScope` is proven able to FAIL. */
function legacyRawSpawnArgv(): [string, string[]] {
  return ['npx', ['tsx', '/repo/apps/operator/bin/spawner-sidecar.ts']];
}

/** A /proc that places this process in NO task scope. Without it the probe reads
 *  the runner's REAL cgroup: under a managed runner (capability:bash, testing:run,
 *  the green-checkpoint) that is a `pc-*.scope`, so the probe takes the
 *  attest-existing-scope branch, spawns `systemctl` through the fake below and
 *  waits for a `close` it never emits, until the 10s attest timeout. That
 *  exceeds the hook timeout on every case. */
const NO_TASK_SCOPE_FS: CgroupFs = { readFile: () => null, readDir: () => [], isDir: () => false };

/** Seed the module-level scope probe without letting its own `systemd-run` spawn
 *  reach `spawnMock` — that leak shifts every `spawnMock.mock.calls[N]` index a
 *  test reads (WI-7377). */
async function seedScopeProbe(ok: boolean): Promise<void> {
  resetScopeProbe();
  await probeScopeSupport(((): unknown => {
    const c = makeChild();
    process.nextTick(() => c.emit('exit', ok ? 0 : 1));
    return c;
  }) as never, NO_TASK_SCOPE_FS);
}

const SOCK = '/tmp/papercusp-test-spawner.sock';

/** Timers the startup-timeout cases fake. `setImmediate` stays REAL: `flush()` and
 *  the timeout's own poll-phase hand-off both depend on it. `Date` must be faked
 *  alongside `setTimeout` because the deadline guard compares against `Date.now()`. */
const STARTUP_TIMEOUT_FAKES: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>['toFake'] = [
  'setTimeout',
  'clearTimeout',
  'Date',
];

describe('spawner sidecar cgroup confinement (EI-19479764372783341)', () => {
  beforeEach(async () => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(null, Buffer.alloc(0), Buffer.alloc(0)));
    });
    // Reset the ADOPTION probe to "nothing is serving" so a leftover
    // mockResolvedValueOnce from a prior test cannot make an unrelated case adopt
    // (and thus assert "spawn called 0 times" for the wrong reason).
    probeAliveMock.mockReset();
    probeAliveMock.mockResolvedValue(false);
    L.registerThrows = null;
    L.markThrows = null;
    L.marked = [];
    _resetSpawnerSidecarSpawnStateForTests();
    setTaskManagerEnabledForTest(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await seedScopeProbe(true);
  });

  afterEach(() => {
    _resetSpawnerSidecarSpawnStateForTests();
    setTaskManagerEnabledForTest(null);
    resetScopeProbe();
    vi.restoreAllMocks();
  });

  it('EI-20200233989444731: the startup TIMEOUT signals the owned SCOPE, not just the systemd-run client', async () => {
    // The timeout path then drops the only reference we hold (`sidecarProcess = null`),
    // so a payload that survived a client-only signal is orphaned with nothing left to
    // stop it — a live process in a scope no ledger row claims, which is precisely the
    // "unaccounted cgroup" the task-manager alarm reports. `systemd-run --scope` forks
    // the payload, so `child` here is the CLIENT and killing it proves nothing about
    // the payload.
    // `Date` is faked too: the timeout callback re-checks `Date.now() < deadlineAt`
    // before rejecting, so advancing only the fake setTimeout clock leaves real Date
    // behind the deadline and the guard reschedules forever (a 60s test timeout).
    vi.useFakeTimers({ toFake: STARTUP_TIMEOUT_FAKES });
    try {
      const child = makeChild();
      spawnMock.mockImplementationOnce(() => child);
      let complete: ((...args: unknown[]) => void) | undefined;
      execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
        complete = callback;
      });

      const p = spawnSpawnerSidecar(SOCK);
      await flush();
      execFileMock.mockClear();

      // Never emit PAPERCUSP_SPAWNER_READY -> the 10s startup timeout fires.
      vi.advanceTimersByTime(10_001);
      await expect(p).rejects.toThrow(/startup timeout/i);
      expect(isSpawnerSidecarRunning()).toBe(false);

      expect(execFileMock).toHaveBeenCalledTimes(1);
      const [file, argv, options] = execFileMock.mock.calls[0] as [
        string,
        string[],
        { timeout?: number; killSignal?: string },
      ];
      expect(file).toBe('systemctl');
      expect(argv).toEqual(expect.arrayContaining(['--user', 'kill', '--signal=SIGTERM']));
      expect(options).toMatchObject({ timeout: 1500, killSignal: 'SIGKILL' });
      expect(
        argv.some((a: string) => /^pc-.+\.scope$/.test(a)),
        'must address the pc-<taskId>.scope unit, never a bare pid',
      ).toBe(true);

      // The timeout rejects promptly while systemctl is still pending; cleanup then
      // signals the owned scope before the systemd-run client.
      expect(child.kill).not.toHaveBeenCalled();
      complete?.(null, Buffer.alloc(0), Buffer.alloc(0));
      await flush();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('CALIBRATION: an UNCONFINED sidecar has no scope to signal, so the timeout must NOT call systemctl', async () => {
    // Proves the assertion above is DISCRIMINATING rather than vacuously true: the
    // same code path, with no scope unit, must produce no systemctl call at all. If
    // this ever passes at the same time as a broken positive case, the positive case
    // is asserting nothing.
    await seedScopeProbe(false);
    vi.useFakeTimers({ toFake: STARTUP_TIMEOUT_FAKES });
    try {
      const child = makeChild();
      spawnMock.mockImplementationOnce(() => child);

      const p = spawnSpawnerSidecar(SOCK);
      await flush();
      execFileMock.mockClear();

      vi.advanceTimersByTime(10_001);
      await expect(p).rejects.toThrow(/startup timeout/i);

      expect(execFileMock, 'no scope exists, so there is nothing to signal').not.toHaveBeenCalled();
      // ...and the client kill is then the ONLY thing standing between us and a leak.
      await flush();
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('launches the sidecar into a NAMED transient --user --scope (a sibling of bg-host), not bg-host\'s own cgroup', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];

    expect(isConfinedToSiblingScope(cmd, args)).toBe(true);
    // Into the SIDECAR class slice — that grouping is what makes the subtree
    // enumerable no matter how the child goes on to fork.
    expect(args).toContain('--slice=papercusp-sidecar.slice');
    // The real payload is appended verbatim at the tail (buildTaskScopeArgv
    // pushes `...base` last; there is deliberately no `--` separator).
    expect(args[args.length - 1]).toContain('spawner-sidecar');

    // ...and the handshake still arrives THROUGH the scope wrapper. This is the
    // property that made the change safe to make: `--scope` execs in the caller's
    // context, so stdout is still a pipe we own (verified against a real
    // systemd-run in isolation before the change; asserted structurally here).
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('CONTROL: the pre-fix raw spawn shape FAILS the same predicate (proves it can fail)', () => {
    const [cmd, args] = legacyRawSpawnArgv();
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false);
  });

  it('CALIBRATION: the predicate rejects a --service wrapper too — only --scope keeps piped stdio and sibling lifetime', () => {
    expect(isConfinedToSiblingScope('systemd-run', ['--user', '--unit=x.service', '--', 'node', 'x'])).toBe(false);
    expect(isConfinedToSiblingScope('systemd-run', ['--scope', '--unit=x.scope', '--', 'node', 'x'])).toBe(false); // no --user
  });

  // ── fail-soft: the ledger must never be able to take down agent-spawn ───────
  //
  // managed-spawn's header promises "FAILS SOFT, ALWAYS ... refusing to spawn
  // because the task manager is unavailable would make an observability feature
  // into an outage." That covered the systemd leg but NOT the ledger leg, whose
  // INSERT was unguarded — so before this, a PG blip threw straight out of the
  // chokepoint and the fleet's agent-spawn path simply did not come up.

  it('still spawns — and still CONFINES — when the ledger register fails (PG down)', async () => {
    L.registerThrows = new Error('connection refused');
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    // Confinement does not depend on the database: the scope name is derived
    // locally, so a ledger outage costs accounting, never isolation.
    expect(isConfinedToSiblingScope(cmd, args)).toBe(true);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('does not abandon a LIVE child when markSpawned fails after the fork', async () => {
    L.markThrows = new Error('write timeout');
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    // The child is already running by the time markSpawned runs; a throw there
    // would report a failed spawn while leaking the process.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('degrades to an UNCONFINED plain spawn on a box with no working user scopes (never refuses to spawn)', async () => {
    await seedScopeProbe(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false); // unconfined, by design
    expect(cmd).not.toBe('systemd-run'); // the payload itself, no wrapper

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  // EI-20006410617437313. The UNCONFINED notice is an OPERATOR-RUNTIME diagnostic:
  // it tells a human that a bg-host restart will take the sidecar with it. Under a
  // test runner it is never the subject — confinement there depends on ambient host
  // state the test neither sets up nor asserts on (the task manager is disabled on
  // most boxes), so the SAME COMMIT warns or stays quiet depending on the machine.
  // `vitest-fail-on-console` then converts that ambient condition into a red on
  // whichever test is executing, and because `warnedUnconfined` is a MODULE-SCOPED
  // latch the victim is simply the first file in the worker to touch this path —
  // measured landing on `scout/observation-consumption-wiring.test.ts`, which has
  // nothing to do with sidecar confinement.
  //
  // Note this file could never have caught that: its own `beforeEach` installs a
  // blanket `vi.spyOn(console, 'warn')`, so the one suite that most exercises the
  // unconfined path is precisely the one that cannot see the warn. Hence an
  // explicit assertion rather than reliance on fail-on-console.
  it('does NOT emit the UNCONFINED diagnostic through console.warn under a test runner', async () => {
    await seedScopeProbe(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    // The spawn really did go out unconfined — otherwise this asserts nothing.
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(isConfinedToSiblingScope(cmd, args)).toBe(false);

    const warned = warn.mock.calls.map((c) => String(c[0] ?? ''));
    expect(warned.filter((m) => m.includes('UNCONFINED'))).toEqual([]);

    // CALIBRATION: prove the assertion above is live rather than vacuously true.
    // A spy that records nothing would satisfy it even if the diagnostic were
    // still being emitted, so demonstrate this spy does capture a real warn.
    console.warn('[calibration] UNCONFINED — this control MUST be captured');
    expect(warn.mock.calls.map((c) => String(c[0] ?? '')).filter((m) => m.includes('UNCONFINED'))).toHaveLength(1);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  // ── the re-entrancy window the async chokepoint opened ─────────────────────

  it('two concurrent callers spawn exactly ONE sidecar (managedSpawn is async — the old raw spawn was not)', async () => {
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const a = spawnSpawnerSidecar(SOCK);
    const b = spawnSpawnerSidecar(SOCK);
    await flush();

    // Without the in-flight guard both callers sail past the `sidecarProcess`
    // null-check (it is no longer in the same tick as the assignment) and race
    // for the pid-keyed socket.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(Promise.all([a, b])).resolves.toEqual([undefined, undefined]);
  });

  // ── the CROSS-PROCESS fan-out (spawner-sidecar-cluster-fanout-2026-08-12) ──
  //
  // The guard above is about two callers in ONE process. This is the sibling
  // property one scope up, and the one that actually cost 8GB: two callers in
  // DIFFERENT processes. Under `node:cluster` every worker has its own fresh
  // module state, so no in-process latch can see a sibling's sidecar — only a
  // probe of the shared socket can. Measured 2026-08-12 at PAPERCUSP_CLUSTER=16:
  // 16 sidecars, 9.5GB, 0.004 cores each.

  it('ADOPTS a sibling worker sidecar already serving the shared socket (spawns nothing)', async () => {
    probeAliveMock.mockResolvedValueOnce(true);

    await expect(spawnSpawnerSidecar(SOCK)).resolves.toBeUndefined();

    // The whole point: no second ~450MB hono-host for this worker.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(hasAdoptedSpawnerSidecar()).toBe(true);
  });

  it('spawns normally when nothing is serving the socket (adoption must not suppress the FIRST sidecar)', async () => {
    // CONTROL for the test above: if the probe were stuck returning true, or the
    // adoption branch swallowed every spawn, the assertion there would pass while
    // the cluster ended up with ZERO sidecars — strictly worse than sixteen. This
    // proves the adoption branch is conditional on the probe, not unconditional.
    probeAliveMock.mockResolvedValueOnce(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(hasAdoptedSpawnerSidecar()).toBe(false);

    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await expect(p).resolves.toBeUndefined();
  });

  it('a bind-race loser adopts instead of crash-respawning (EI-19982828461130670)', async () => {
    // The probe cannot close the window between "found nothing" and "our child
    // bound", so two workers can both spawn; exactly one wins. The loser's child
    // dies EADDRINUSE — a SUCCESS for the cluster (a sidecar now serves the shared
    // path), so it must neither warn as a crash nor burn the respawn budget
    // re-losing the same race, and must settle rather than hang to the 10s timeout.
    probeAliveMock.mockResolvedValueOnce(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    child.stderr.emit('data', Buffer.from('listen EADDRINUSE: address already in use ' + SOCK + '\n'));
    child.emit('exit', 1);

    // Settles promptly as success — not a 10s "startup timeout" rejection.
    await expect(p).resolves.toBeUndefined();
    expect(hasAdoptedSpawnerSidecar()).toBe(true);

    // And no respawn was scheduled: re-losing the race would just repeat this.
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('adopts on the in-use EXIT CODE alone, when exit arrives before any stderr (host-memory-reduction P-005)', async () => {
    // The child now refuses to take a live sidecar's path (listenUnixSocketExclusive)
    // and exits SIDECAR_EXIT_SOCKET_IN_USE. Node can deliver `exit` before the last
    // stderr chunk, so the exit code alone must settle this as adoption. A crash exit
    // (137 etc.) still respawns; spawner-sidecar-spawn.test.ts covers that half.
    probeAliveMock.mockResolvedValueOnce(false);
    const child = makeChild();
    spawnMock.mockImplementationOnce(() => child);

    const p = spawnSpawnerSidecar(SOCK);
    await flush();

    child.emit('exit', SIDECAR_EXIT_SOCKET_IN_USE);

    await expect(p).resolves.toBeUndefined();
    expect(hasAdoptedSpawnerSidecar()).toBe(true);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('graceful stop waits for the async owned-scope signal before stopping the client', async () => {
    const child = makeChild();
    child.kill.mockImplementation((signal?: string) => {
      child.killed = true;
      child.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal ?? null);
    });
    spawnMock.mockImplementationOnce(() => child);

    const ready = spawnSpawnerSidecar(SOCK);
    await flush();
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;
    execFileMock.mockClear();

    let complete: ((...args: unknown[]) => void) | undefined;
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      complete = callback;
    });
    const stopping = stopSpawnerSidecar();
    await flush();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    complete?.(null, Buffer.alloc(0), Buffer.alloc(0));
    await stopping;
    expect(child.kill).toHaveBeenCalled();
  });

  it('host-exit hook starts scope cleanup before the client signal', async () => {
    const child = makeChild();
    const order: string[] = [];
    child.kill.mockImplementation((signal?: string) => {
      order.push('client');
      child.killed = true;
      child.emit('exit', signal === 'SIGKILL' ? 137 : 0, signal ?? null);
    });
    spawnMock.mockImplementationOnce(() => child);

    const ready = spawnSpawnerSidecar(SOCK);
    await flush();
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;
    execFileMock.mockClear();

    let complete: ((...args: unknown[]) => void) | undefined;
    execFileMock.mockImplementationOnce((_file, _args, _options, callback) => {
      order.push('scope');
      complete = callback;
    });
    stopSpawnerSidecarAtHostExit();

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['scope', 'client']);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    complete?.(null, Buffer.alloc(0), Buffer.alloc(0));
    await flush();
    expect(order).toEqual(['scope', 'client']);
  });
});
