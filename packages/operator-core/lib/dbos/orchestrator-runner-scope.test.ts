/**
 * orchestrator-runner-scope.test.ts — WI-1499 (bg-host-agent-spawn-scope-isolation-
 * 2026-07-02): every bee/queen turn spawns inside its own transient systemd user
 * SCOPE (`buildIsolatedScopeArgv`, `runChild` in orchestrator-runner.ts) so a
 * bg-host restart/OOM no longer reclaims in-flight agent turns along with it
 * (KillMode=control-group only touches bg-host's OWN cgroup, not the scope's).
 *
 * `orchestrator-runner-spawn.test.ts` covers spawnInvokeOnce end-to-end with a
 * REAL subprocess (no child_process mock) — useful for the actual SIGTERM-kill /
 * output-capture behavior, but it can't assert WHICH argv reached spawn() without
 * shelling out to inspect systemd-run's own child. This file mocks
 * `node:child_process` (mirroring release-actions.test.ts's identical pattern for
 * the green-checkpoint scope) so the exact spawn() call — command, scope flags,
 * memory cap, retry-once-on-launch-failure — is directly assertable, deterministic,
 * and needs no real systemd user bus.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.hoisted(() => {
  process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = '5000';
});

// --- mocks (hoisted) ---------------------------------------------------------
const spawnMock = vi.fn();
// Partial mock: only spawn is intercepted. A full replacement broke at import
// time once a transitive import (seed-provider-git.ts) started promisify()ing
// execFile — keep the real surface for everything this test doesn't stub.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

// The scope wrapper is no longer built inline here — it moved behind the task
// manager's enrolment seam (task-manager-no-escape-2026-07-27 P-009), which confines
// only when a CACHED systemd-scope support probe has landed and said yes. Production
// warms that probe at module load (orchestrator-runner.ts); a test process cannot
// rely on it, for two independent reasons: the probe resolves asynchronously (so it
// races the assertions), and its own probe spawn goes through the SAME mocked
// `spawn`, which would shift every `spawnMock.mock.calls[N]` index this file reads.
// So pin the answer and neuter the warm-up. The subject of this file is the argv that
// reaches spawn() on a host that CAN make scopes — not the probe's own plumbing,
// which managed-spawn's tests own.
const S = vi.hoisted(() => ({ probe: { ok: true } as { ok: boolean; reason?: string } | null }));
vi.mock('../task-manager/managed-spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../task-manager/managed-spawn')>()),
  warmScopeProbe: () => {},
  scopeSupportKnown: () => S.probe,
}));

const H = vi.hoisted(() => ({
  cmd: null as null | { command: string; args: string[]; env: NodeJS.ProcessEnv },
}));
vi.mock('../harness-invoke-once', () => ({
  buildInvokeOnce: () => H.cmd,
  resolveSpawnBackendModel: () => ({ backend: 'omp', model: '' }),
}));

const E = vi.hoisted(() => ({
  completeCalls: [] as unknown[][],
  finishCalls: [] as unknown[][],
}));
vi.mock('../task-manager/enroll-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../task-manager/enroll-sync')>();
  return {
    ...actual,
    completeSyncEnrolment: (...args: unknown[]) => {
      E.completeCalls.push(args);
      return actual.completeSyncEnrolment(
        args[0] as Parameters<typeof actual.completeSyncEnrolment>[0],
        args[1] as Parameters<typeof actual.completeSyncEnrolment>[1],
        args[2] as Parameters<typeof actual.completeSyncEnrolment>[2],
        args[3] as Parameters<typeof actual.completeSyncEnrolment>[3],
      );
    },
    finishSyncEnrolment: (...args: unknown[]) => {
      E.finishCalls.push(args);
      return actual.finishSyncEnrolment(
        args[0] as Parameters<typeof actual.finishSyncEnrolment>[0],
        args[1] as Parameters<typeof actual.finishSyncEnrolment>[1],
        args[2] as Parameters<typeof actual.finishSyncEnrolment>[2],
      );
    },
  };
});

import { spawnInvokeOnce } from './orchestrator-runner';
import { setTaskManagerEnabledForTest } from '../task-manager/enabled';

/** The per-agent-turn cap (`agentSpawnScopeMemoryMaxG`, default 6 GiB) as the two
 *  builders spell it. `buildIsolatedScopeArgv` uses systemd's `6G` shorthand;
 *  `buildTaskScopeArgv` (the NAMED task-manager scope) uses the byte integer. */
const capG = (g: number) => `--property=MemoryMax=${g}G`;
const capBytes = (g: number) => `--property=MemoryMax=${g * 1024 ** 3}`;

type FakeStream = EventEmitter & { encoding: BufferEncoding | null; setEncoding: (e: BufferEncoding) => FakeStream };
type FakeChild = EventEmitter & { pid: number; stdout: FakeStream; stderr: FakeStream; kill: () => void };
/** A fake readable honouring setEncoding: the runner decodes at the stream boundary
 *  (orchestrator-runner.ts runChild), so a decoded stream emits strings, as a real one does. */
function fakeStream(): FakeStream {
  const s = new EventEmitter() as FakeStream;
  s.encoding = null;
  s.setEncoding = (e) => { s.encoding = e; return s; };
  return s;
}
const emitChunk = (s: FakeStream, text: string) => s.emit('data', s.encoding ? text : Buffer.from(text));
let nextPid = 1000;

/** fakeSpawn: emits `stdout`/`stderr` then closes with `code` on the next tick —
 *  mirrors release-actions.test.ts's fakeSpawn/fakeSpawnFail helpers. */
function fakeSpawn(opts: { stdout?: string; stderr?: string; code?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = nextPid++;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  child.kill = () => {};
  process.nextTick(() => {
    if (opts.stdout) emitChunk(child.stdout, opts.stdout);
    if (opts.stderr) emitChunk(child.stderr, opts.stderr);
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

const savedScopeEnv = process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
const savedMemEnv = process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G;

beforeEach(() => {
  S.probe = { ok: true }; // default: a host that CAN make user scopes
  E.completeCalls = [];
  E.finishCalls = [];
  // PIN the task-manager flag rather than inheriting it. `taskManagerEnabledSync()`
  // reads a module-level cache that fails open (`cached !== false`), so an unpinned
  // test silently tracks whatever the ambient default happens to be — and when
  // TASK_MANAGER graduated to default-ON (WI-6844, 2026-08-02) that flipped this
  // file from the unnamed WI-1499 builder to the NAMED task-manager one, changing
  // only the cap's NOTATION and reading as a lost memory cap. Each test below
  // declares the branch it means to exercise.
  setTaskManagerEnabledForTest(true); // the shipped default since WI-6844
  H.cmd = { command: '/x/invoke-once', args: ['--role', 'cup'], env: process.env };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  setTaskManagerEnabledForTest(null);
  spawnMock.mockReset();
  if (savedScopeEnv === undefined) delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
  else process.env.PAPERCUSP_AGENT_SPAWN_SCOPE = savedScopeEnv;
  if (savedMemEnv === undefined) delete process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G;
  else process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G = savedMemEnv;
});

describe('agent-turn spawn scope isolation (WI-1499)', () => {
  it('wraps the agent turn in a memory-capped transient user SCOPE by default (linux)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, spawnOpts] = spawnMock.mock.calls[0] as [string, string[], { detached?: boolean }];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    // --scope (never --service): the payload stays OUR child, so piped stdio, env
    // inheritance and the pgid tree-kill all keep working. It is additionally NAMED
    // (`--unit=papercusp-task-<id>.scope`) when the task-manager flag is ON — that
    // name is the ledger key that makes the subtree addressable, and naming a scope
    // does not change its child-of-us semantics.
    expect(args).toContain('--scope'); // child stays OUR pgid
    // P-012: task-manager scopes retain FAILED units only until the ledger writer
    // snapshots Result/MemoryPeak/InvocationID, then reset-failed releases them.
    expect(args).not.toContain('--collect');
    expect(args).not.toContain('--property=CollectMode=inactive-or-failed');
    /* Flag ON + a landed probe ⇒ the NAMED task-manager scope (`buildTaskScopeArgv`),
       which spells the cap as a BYTE INTEGER. The `6G` shorthand belongs to the
       unnamed WI-1499 builder (`buildIsolatedScopeArgv`), pinned by the flag-OFF and
       probe-not-landed cases below.

       Both spellings mean the same cap, so assert the branch this test DECLARES
       (see the pin in beforeEach) rather than whichever the ambient default gives:
       a notation-only difference must never be readable as a lost memory cap. */
    expect(args).toContain(capBytes(6));
    // WI-41206: an agent turn is a WORKER — nothing waits on its event loop — so it must be
    // allowed to PAGE at the cap rather than be OOM-killed. This asserted the opposite until
    // 2026-08-24. The CAP above is unchanged and still pinned; only the at-the-cap behaviour
    // moved. 'deny' remains available per-callsite (see ScopeSwapPolicy) and is still used by
    // the substrate sidecar, whose leak is what earned the swap-0 policy.
    expect(args).not.toContain('--property=MemorySwapMax=0');
    // Named: the ledger key that makes the subtree addressable.
    expect(args.some((a) => a.startsWith('--unit='))).toBe(true);
    // The wrapped payload (command + its own args) is appended verbatim at the tail.
    expect(args.slice(-3)).toEqual(['/x/invoke-once', '--role', 'cup']);
    expect(args.join(' ')).toContain('/x/invoke-once --role cup');
    expect(spawnOpts.detached).toBe(true); // pgid tree-kill still covers the scope wrapper
  });

  it('passes the named scope cgroup path when closing enrollment (EI-21045581515656760)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));

    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});

    expect(r.exitCode).toBe(0);
    expect(E.finishCalls).toHaveLength(1);
    const scopeCgroupPath = (E.finishCalls[0]?.[2] as { scopeCgroupPath?: string } | undefined)?.scopeCgroupPath;
    expect(scopeCgroupPath).toMatch(/\/papercusp-agent-session\.slice\/[^/]+\.scope$/);
  });

  it('records the spawn-row correlation on the named agent-session task', async () => {
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));

    await spawnInvokeOnce(
      process.cwd(),
      'release-fixer',
      [],
      {},
      {
        taskSpawnId: 's-frozen-repair-2',
      },
    );

    expect(E.completeCalls).toHaveLength(1);
    const spec = E.completeCalls[0]?.[1] as { detail?: Record<string, unknown> };
    expect(spec.detail).toMatchObject({
      role: 'release-fixer',
      scopeRequested: true,
      spawnRecordId: 's-frozen-repair-2',
    });
  });

  // EI-22174354183651399 regression guard: this seam used to write agent-session
  // ledger rows with NO coordOwnerId at all (launched_by holds the SPAWNER, a
  // different agent for any fleet member) — a coordOwnerId-keyed filter then
  // silently returned zero rows for ~28-30% of live agent sessions. The value
  // is threaded to the child as PAPERCUSP_SPAWN_ID (same derivation as
  // libs/papercusp/packages/orchestrator/src/invoke.ts:3509, which the CHILD
  // reads from its own process.env); this seam is the PARENT and must read it
  // off the constructed child `env` it is about to spawn with.
  it('records coordOwnerId on the agent-session ledger row from the child env PAPERCUSP_SPAWN_ID (EI-22174354183651399)', async () => {
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    H.cmd = {
      command: '/x/invoke-once',
      args: ['--role', 'cup'],
      env: { ...process.env, PAPERCUSP_SPAWN_ID: 's-1788-abc123' },
    };

    await spawnInvokeOnce(process.cwd(), 'cup', [], {});

    expect(E.completeCalls).toHaveLength(1);
    const spec = E.completeCalls[0]?.[1] as { detail?: Record<string, unknown> };
    expect(spec.detail).toMatchObject({ coordOwnerId: 's-1788-abc123' });
  });

  it('omits coordOwnerId (never writes an empty string) when the child env has no PAPERCUSP_SPAWN_ID', async () => {
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const envWithoutSpawnId = { ...process.env };
    delete envWithoutSpawnId.PAPERCUSP_SPAWN_ID;
    H.cmd = { command: '/x/invoke-once', args: ['--role', 'cup'], env: envWithoutSpawnId };

    await spawnInvokeOnce(process.cwd(), 'cup', [], {});

    expect(E.completeCalls).toHaveLength(1);
    const spec = E.completeCalls[0]?.[1] as { detail?: Record<string, unknown> };
    expect(spec.detail).not.toHaveProperty('coordOwnerId');
  });

  // The other half of the enrolment contract (task-manager-no-escape P-009). Confinement
  // is gated on a CACHED probe, so there are two legitimate ways to get an UNCONFINED
  // spawn — the probe has not landed yet (first turn after boot), or this host cannot
  // make user scopes at all. Both must still run the turn: "a task manager that is still
  // warming up must never be the reason a command does not run."
  //
  // This is the regression guard the gate needed and did not have. When the wrapper moved
  // behind this seam, the confined path silently stopped being exercised and the suite's
  // only signal was three assertions failing in a way that read like a lost feature. Pin
  // BOTH branches, so a future refactor that drops confinement fails loudly and
  // specifically instead of looking like a stale test.
  it('spawns DIRECT when the host CANNOT make user scopes at all', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    S.probe = { ok: false, reason: 'no user bus' };
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    // One spawn, not two: an unconfined spawn is the FIRST choice here, not a retry
    // after a failed wrapper — nothing was wrapped, so there is nothing to fall back from.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/x/invoke-once');
    expect(args).toEqual(['--role', 'cup']);
  });

  /* An un-landed probe used to take the same DIRECT branch as a known-unsupported
     host. That conflates two different things, and for THIS seam it is the unsafe
     reading: the task manager may skip NAMING a scope while it warms up, but an
     agent turn must not run with no memory cap merely because a probe has not
     come back yet — that is precisely the uncapped-child condition WI-1499 exists
     to prevent (the 2026-07-01 40G OOM crash-loop). Attempting costs nothing,
     because a genuine launch failure still degrades to DIRECT on the retry below. */
  it('still scope-confines (unnamed) when the probe has NOT LANDED yet — WI-1499 is not probe-gated', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    S.probe = null;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--property=MemoryMax=6G');
    // Unnamed: the ledger key is the part the flag/probe gates, not the cap.
    expect(args.some((a) => a.startsWith('--unit='))).toBe(false);
    expect(args.slice(-3)).toEqual(['/x/invoke-once', '--role', 'cup']);
  });

  it('honors PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G to size the scope cap', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    process.env.PAPERCUSP_AGENT_SPAWN_MEMORY_MAX_G = '12';
    spawnMock.mockImplementationOnce(() => fakeSpawn({ code: 0 }));
    await spawnInvokeOnce(process.cwd(), 'mug', [], {});
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    // Byte integer, for the same reason as the default-cap assertion above: the
    // pinned flag-ON path is the NAMED task-manager scope builder.
    expect(args).toContain(capBytes(12));
  });

  /* The WI-6499 regression guard, stated as its own case (it used to be tested only
     by accident, while the flag's default happened to be OFF). Flag-OFF governs the
     LEDGER and the NAMED unit — it must NOT drop the memory cap, because the
     pre-task-manager behaviour of this seam was already scope-confined by WI-1499.
     Flag-OFF silently un-capping every agent turn is the 2026-07-01 40G OOM
     crash-loop condition returning. */
  it('still applies the memory cap (unnamed WI-1499 scope) when the task-manager flag is OFF', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    setTaskManagerEnabledForTest(false);
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('systemd-run'); // still confined, just not ledgered
    expect(args).toContain(capG(6)); // the unnamed builder's shorthand
    // WI-41206: same inversion as the named-scope case above — the unnamed WI-1499 builder
    // must agree, or the swap policy would depend on whether the task-manager flag is on.
    expect(args).not.toContain('--property=MemorySwapMax=0');
    expect(args.some((a) => a.startsWith('--unit='))).toBe(false); // the flag DOES gate naming
    expect(args.slice(-3)).toEqual(['/x/invoke-once', '--role', 'cup']);
  });

  it('falls back to a DIRECT spawn once when the scope cannot launch (no user bus) — the turn never fails on infra', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock
      .mockImplementationOnce(() =>
        fakeSpawn({ stderr: 'Failed to connect to bus: No such file or directory', code: 1 }),
      )
      .mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd1] = spawnMock.mock.calls[0] as [string, string[]];
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd1).toBe('systemd-run');
    expect(cmd2).toBe('/x/invoke-once'); // direct payload, no wrapper
    expect(args2).toEqual(['--role', 'cup']);
  });

  it('a PAYLOAD failure inside a healthy scope does NOT retry (a real agent-turn error, not a launch failure)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock.mockImplementationOnce(() => fakeSpawn({ stderr: 'agent crashed: out of memory in tool call', code: 1 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('out of memory in tool call');
    expect(spawnMock).toHaveBeenCalledTimes(1); // no scope-launch-failure retry
  });

  it('PAPERCUSP_AGENT_SPAWN_SCOPE=0 kill-switch runs the pre-hardening direct spawn (ops escape hatch)', async () => {
    process.env.PAPERCUSP_AGENT_SPAWN_SCOPE = '0';
    spawnMock.mockImplementationOnce(() => fakeSpawn({ code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('/x/invoke-once');
    expect(args).toEqual(['--role', 'cup']);
  });

  it('a scope-launch failure on the direct retry itself still surfaces (no infinite retry loop)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    // First call: scope-launch failure → retries direct (useScope:false). The
    // direct retry failing for a genuinely unrelated reason must NOT re-retry
    // (isScopeLaunchFailure requires useScope, which is false on the retry).
    spawnMock
      .mockImplementationOnce(() =>
        fakeSpawn({ stderr: 'Failed to connect to bus: No such file or directory', code: 1 }),
      )
      .mockImplementationOnce(() => fakeSpawn({ stderr: 'command not found', code: 127 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(127);
    expect(spawnMock).toHaveBeenCalledTimes(2); // exactly one retry, never a third call
  });

  // WI-5601: exit 127 in ~21ms with BOTH stdout and stderr completely empty —
  // 40/344 (11.6%) of measured spawns, distinct from the scope-launch-failure
  // class above (which requires a real launch-shaped stderr message). One
  // bounded retry turns a transient host-pressure blip into a success instead
  // of a permanently lost agent turn.
  it('retries once on an exec-shaped failure (empty stdout+stderr, fast non-zero exit) and succeeds', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock
      .mockImplementationOnce(() => fakeSpawn({ code: 127 })) // no stdout, no stderr
      .mockImplementationOnce(() => fakeSpawn({ stdout: 'ok', code: 0 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('an exec-shaped failure that recurs on the retry still surfaces (bounded to exactly one retry)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    spawnMock
      .mockImplementationOnce(() => fakeSpawn({ code: 127 }))
      .mockImplementationOnce(() => fakeSpawn({ code: 127 }));
    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {});
    expect(r.exitCode).toBe(127);
    expect(spawnMock).toHaveBeenCalledTimes(2); // exactly one retry, never a third call
  });

  it('does NOT retry an empty-stream failure that is not fast (looks like a real hung/killed turn, not a launch blip)', async () => {
    delete process.env.PAPERCUSP_AGENT_SPAWN_SCOPE;
    vi.useFakeTimers();
    try {
      spawnMock.mockImplementationOnce(() => {
        const child = new EventEmitter() as FakeChild;
        child.pid = nextPid++;
        child.stdout = fakeStream();
        child.stderr = fakeStream();
        child.kill = () => {};
        // Close with empty streams + non-zero code, but AFTER the 5s exec-shaped
        // window — must not be mistaken for the fast launch-blip signature.
        setTimeout(() => child.emit('close', 127), 6_000);
        return child;
      });
      const p = spawnInvokeOnce(process.cwd(), 'cup', [], {});
      await vi.advanceTimersByTimeAsync(6_100);
      const r = await p;
      expect(r.exitCode).toBe(127);
      expect(spawnMock).toHaveBeenCalledTimes(1); // no retry — outside the 5s window
    } finally {
      vi.useRealTimers();
    }
  });
});
