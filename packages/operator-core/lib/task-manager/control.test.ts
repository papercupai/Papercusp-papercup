import { describe, it, expect, vi, beforeEach } from 'vitest';
import { onTaskKillRequested } from './kill-notify';
import type { TaskRow, TaskState } from './types';

const store = vi.hoisted(() => ({
  rows: new Map<string, TaskRow>(),
  closed: [] as { taskId: string; state: string; reason: string | null }[],
  reopened: [] as string[],
  limitUpdates: [] as { taskId: string; limits: { memoryMaxBytes?: number; cpuWeight?: number; tasksMax?: number } }[],
  persistLimits: true,
}));

vi.mock('./store', () => ({
  getTask: async (id: string) => store.rows.get(id) ?? null,
  getSubtree: async (rootId: string) => [...store.rows.values()].filter((r) => r.rootTaskId === rootId),
  closeTask: async (id: string, input: { state: string; exitReason?: string | null }) => {
    store.closed.push({ taskId: id, state: input.state, reason: input.exitReason ?? null });
    return true;
  },
  reopenStrandedTask: async (id: string) => {
    const current = store.rows.get(id);
    if (!current || current.state !== 'stranded' || !current.endedAt) return false;
    current.state = 'running';
    current.endedAt = null;
    current.exitCode = null;
    current.exitReason = null;
    store.reopened.push(id);
    return true;
  },
  updateTaskLimits: async (
    id: string,
    limits: { memoryMaxBytes?: number; cpuWeight?: number; tasksMax?: number },
  ) => {
    if (!store.persistLimits) return false;
    const current = store.rows.get(id);
    if (!current || current.endedAt) return false;
    Object.assign(current, limits);
    store.limitUpdates.push({ taskId: id, limits });
    return true;
  },
}));

const { killTask, killScopeUnit, freezeTask, thawTask, limitTask, verifyPidStillOurs } = await import('./control');

/** Where a live Papercusp transient scope sits, as `systemctl show -p ControlGroup` prints it. */
const USER_SCOPE_PREFIX = '/user.slice/user-1000.slice/user@1000.service/papercusp.slice';

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  const r: TaskRow = {
    workspaceId: 'w',
    rootTaskId: over.taskId,
    class: 'bash-job',
    title: 't',
    argv: [],
    confined: true,
    scopeUnit: `pc-${over.taskId}.scope`,
    cgroupPath: `/papercusp.slice/pc-${over.taskId}.scope`,
    state: 'running' as TaskState,
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    launchedBy: 'su-test',
    detail: {},
    ...over,
  };
  store.rows.set(r.taskId, r);
  return r;
}

beforeEach(() => {
  store.rows.clear();
  store.closed.length = 0;
  store.reopened.length = 0;
  store.limitUpdates.length = 0;
  store.persistLimits = true;
});

describe('verifyPidStillOurs — the recycled-pid rail', () => {
  const d = (identity: string | null) =>
    ({ readIdentity: () => identity }) as unknown as Parameters<typeof verifyPidStillOurs>[1];

  it('accepts a pid whose kernel identity still matches', () => {
    const r = row({ taskId: 'a1', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    expect(verifyPidStillOurs(r, d('linux:b:1'))).toEqual({ ok: true, pid: 10, weak: false });
  });

  it('REFUSES a pid that now belongs to a different process', () => {
    const r = row({ taskId: 'a2', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    const v = verifyPidStillOurs(r, d('linux:b:999'));
    expect(v).toMatchObject({ ok: false, error: 'identity_mismatch' });
    expect((v as { detail: string }).detail).toMatch(/refusing to signal a recycled pid/);
  });

  it('reports a gone pid as a mismatch rather than signalling into the void', () => {
    const r = row({ taskId: 'a3', confined: false, scopeUnit: null, pid: 10, processIdentity: 'linux:b:1' });
    expect(verifyPidStillOurs(r, d(null))).toMatchObject({ ok: false, error: 'identity_mismatch' });
  });

  it('allows a row that never captured an identity, but marks it WEAK', () => {
    const r = row({ taskId: 'a4', confined: false, scopeUnit: null, pid: 10, processIdentity: null });
    expect(verifyPidStillOurs(r, d('linux:b:7'))).toEqual({ ok: true, pid: 10, weak: true });
  });

  it('has no target when the row has no pid at all', () => {
    const r = row({ taskId: 'a5', confined: false, scopeUnit: null, pid: null });
    expect(verifyPidStillOurs(r, d('x'))).toMatchObject({ ok: false, error: 'no_target' });
  });
});

describe('killTask — confined path', () => {
  it('kills by SCOPE, never by pid', async () => {
    row({ taskId: 'b1', pid: 4242 });
    const calls: string[][] = [];
    const kill = vi.fn();
    const out = await killTask('b1', {
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
      kill,
    });
    expect(out.ok).toBe(true);
    expect(calls[0]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-b1.scope']);
    // The pid path must not be touched for a confined task — that is the whole
    // point of addressing the cgroup.
    expect(kill).not.toHaveBeenCalled();
    expect(store.closed).toEqual([{ taskId: 'b1', state: 'killed', reason: 'scope kill SIGTERM' }]);
  });

  // EI-21905196224862433: a confined job's Node-side watcher is the
  // `systemd-run --pipe --wait` client, not the payload — that client exits 0
  // once the unit is gone regardless of whether it was killed. capability:bash
  // (bash-jobs.ts) subscribes to this notice to flip its own job status
  // BEFORE trusting the client's untrustworthy exit code; these tests only
  // verify killTask actually sends the notice, and sends it before the signal.
  it('announces kill-intent BEFORE the confined SIGTERM is signalled (EI-21905196224862433)', async () => {
    row({ taskId: 'b1-notify', pid: 4242 });
    const notified: Array<[string, NodeJS.Signals]> = [];
    const unsubscribe = onTaskKillRequested((taskId, signal) => notified.push([taskId, signal]));
    try {
      const out = await killTask('b1-notify', {
        execFileAsync: (async (_f: string, args: string[]) => {
          // The notice must already be visible by the time systemctl is invoked.
          expect(notified).toEqual([['b1-notify', 'SIGTERM']]);
          return { stdout: '', stderr: '' };
        }) as never,
        kill: vi.fn(),
      });
      expect(out.ok).toBe(true);
      expect(notified).toEqual([['b1-notify', 'SIGTERM']]);
    } finally {
      unsubscribe();
    }
  });

  it('announces the SIGKILL escalation too, in order', async () => {
    row({ taskId: 'b1-notify-escalate' });
    const notified: Array<[string, NodeJS.Signals]> = [];
    const unsubscribe = onTaskKillRequested((taskId, signal) => notified.push([taskId, signal]));
    try {
      await killTask('b1-notify-escalate', {
        escalateAfterMs: 1,
        sleep: async () => {},
        fs: { readFile: () => '999\n', readDir: () => [], isDir: () => true },
        execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
      });
      expect(notified).toEqual([
        ['b1-notify-escalate', 'SIGTERM'],
        ['b1-notify-escalate', 'SIGKILL'],
      ]);
    } finally {
      unsubscribe();
    }
  });

  it('reports SIGKILL-delivered teardown as pending instead of advising a retry', async () => {
    row({ taskId: 'b2' });
    const calls: string[][] = [];
    const out = await killTask('b2', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '999\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.map((c) => c[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);
    // EI-20130774106283501: SIGKILL delivery is terminal even when cgroup
    // teardown/reaping outlives the bounded response window. The row remains
    // live for reconciliation, but the caller must not retry a successful kill.
    expect(out).toMatchObject({ ok: true, taskId: 'b2' });
    expect((out as { detail: string }).detail).toMatch(/termination pending/);
    expect((out as { detail: string }).detail).toMatch(/no retry is required/);
    expect(store.closed).toHaveLength(0);
  });

  it('handles a slow SIGTERM trap that exits after the SIGKILL response window', async () => {
    row({ taskId: 'b2-slow' });
    const scopePath = '/sys/fs/cgroup/papercusp.slice/pc-b2-slow.scope';
    const calls: string[][] = [];
    let sigkillDelivered = false;
    let postKillReads = 0;
    const fs = {
      readFile: (path: string) => {
        if (path !== `${scopePath}/cgroup.procs`) return '';
        if (!sigkillDelivered) return '999\n';
        postKillReads++;
        return postKillReads <= 6 ? '999\n' : '';
      },
      readDir: () => [],
      isDir: () => true,
    };
    const out = await killTask('b2-slow', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs,
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[2] === '--signal=SIGKILL') sigkillDelivered = true;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.map((c) => c[2])).toEqual(['--signal=SIGTERM', '--signal=SIGKILL']);
    expect(out).toMatchObject({ ok: true, taskId: 'b2-slow' });
    expect((out as { detail: string }).detail).toMatch(/termination pending/);
    // The simulated trap has now completed, just after the bounded response
    // window; the kill result did not misclassify it as a retryable failure.
    expect(fs.readFile(`${scopePath}/cgroup.procs`)).toBe('');
    expect(store.closed).toHaveLength(0);
  });

  it('reports failed SIGKILL escalation instead of claiming delivery or closing the task', async () => {
    row({ taskId: 'failedkill' });
    const calls: string[][] = [];
    const out = await killTask('failedkill', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args.includes('--signal=SIGKILL')) throw new Error('systemd bus disconnected during escalation');
        // systemd still knows the unit: this failure is not a collected scope.
        return { stdout: args[1] === 'show' ? `${USER_SCOPE_PREFIX}/pc-failedkill.scope\n` : '', stderr: '' };
      }) as never,
    });
    expect(calls).toEqual([
      ['--user', 'kill', '--signal=SIGTERM', 'pc-failedkill.scope'],
      ['--user', 'kill', '--signal=SIGKILL', 'pc-failedkill.scope'],
      ['--user', 'show', '-p', 'ControlGroup', '--value', 'pc-failedkill.scope'],
    ]);
    expect(out).toMatchObject({ ok: false, error: 'command_failed', detail: expect.stringContaining('systemd bus disconnected') });
    expect(out.detail).not.toContain('no retry is required');
    expect(store.closed).toHaveLength(0);
  });

  // WI-10004447: su-session-stdio-peer close() waited 5 s, the real omp engine
  // exited just after, systemd collected its scope, and the SIGKILL failed with
  // `Unit … not loaded`, which surfaced as a teardown failure.
  const notLoaded = (unit: string) => new Error(
    `Command failed: systemctl --user kill --signal=SIGKILL ${unit}\nFailed to kill unit ${unit}: Unit ${unit} not loaded.`);

  it('WI-10004447: a scope collected before the signal is already_gone, not command_failed, and the row stays open', async () => {
    row({ taskId: 'raced' });
    const calls: string[][] = [];
    const out = await killTask('raced', {
      signal: 'SIGKILL',
      sleep: async () => {},
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'kill') throw notLoaded('pc-raced.scope');
        return { stdout: args[1] === 'show' ? '\n' : '', stderr: '' };
      }) as never,
    });
    expect(calls.map((a) => a[1])).toEqual(['kill', 'show']);
    expect(out).toMatchObject({ ok: false, error: 'already_gone', detail: expect.stringContaining('no longer known to systemd') });
    // The exit watcher records the payload's own exit; killTask did not kill it.
    expect(store.closed).toHaveLength(0);
  });

  it('WI-10004447: a failed signal on a unit systemd still knows stays command_failed', async () => {
    row({ taskId: 'stillknown' });
    const out = await killTask('stillknown', {
      signal: 'SIGKILL',
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'kill') throw new Error('Access denied');
        return { stdout: args[1] === 'show' ? `${USER_SCOPE_PREFIX}/pc-stillknown.scope\n` : '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'command_failed', detail: expect.stringContaining('Access denied') });
    expect(store.closed).toHaveLength(0);
  });

  it('WI-10004447: a scope collected between SIGTERM and the SIGKILL escalation verifies empty instead of failing', async () => {
    row({ taskId: 'racedescalation' });
    // Alive when the escalation is decided; it exits and systemd collects the
    // scope just before the SIGKILL lands.
    let alive = true;
    const out = await killTask('racedescalation', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => (alive ? '4242\n' : ''), readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args.includes('--signal=SIGKILL')) { alive = false; throw notLoaded('pc-racedescalation.scope'); }
        return { stdout: args[1] === 'show' ? (alive ? `${USER_SCOPE_PREFIX}/pc-racedescalation.scope\n` : '\n') : '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'racedescalation' });
    expect((out as { detail: string }).detail).not.toContain('escalated to SIGKILL');
  });

  it('WI-10004447: killScopeUnit treats a scope collected before its signal as already_gone', async () => {
    let showCalls = 0;
    const out = await killScopeUnit('pc-racedunit.scope', {
      fs: { readFile: () => '777\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'kill') throw notLoaded('pc-racedunit.scope');
        // First `show` resolves the live scope; the re-ask after the failed kill finds it collected.
        return { stdout: args[1] === 'show' ? (showCalls++ === 0 ? `${USER_SCOPE_PREFIX}/pc-racedunit.scope\n` : '\n') : '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'already_gone' });
  });

  it('EI-22074929140199832: verifies the SCOPE, not the stored cgroup_path — a mismatched path never becomes a phantom survivor', async () => {
    // The measured production shape: `task_ledger.cgroup_path` holds the OPERATOR'S
    // own cgroup rather than this task's scope (522 of 726 confined rows started in
    // 24h did not end in their own scope_unit). Walking it answers a question about
    // the operator, and it is permanently non-empty — so a scope that is completely
    // dead reported "15 process(es) remained" and got a pointless SIGKILL.
    const operatorCgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service';
    const trueScopeCgroup = '/papercusp.slice/papercusp-bash.slice/pc-mismatch.scope';
    row({ taskId: 'mismatch', scopeUnit: 'pc-mismatch.scope', cgroupPath: operatorCgroup });

    const reads: string[] = [];
    const fs = {
      // The operator's own cgroup is BUSY; the task's real scope is EMPTY (dead).
      readFile: (path: string) => {
        reads.push(path);
        return path.startsWith(`/sys/fs/cgroup${operatorCgroup}`) ? '101\n102\n103\n' : '';
      },
      readDir: () => [],
      isDir: () => true,
    };
    const signals: string[] = [];
    let resolvedScope = 0;
    const out = await killTask('mismatch', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs,
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'show') {
          resolvedScope++;
          expect(args).toContain('pc-mismatch.scope');
          return { stdout: `${trueScopeCgroup}\n`, stderr: '' };
        }
        signals.push(args[2]!);
        return { stdout: '', stderr: '' };
      }) as never,
    });

    // It asked systemd for the scope's real cgroup instead of trusting the row.
    expect(resolvedScope).toBeGreaterThan(0);
    // The dead scope reads as dead: no phantom survivors, no residue breakdown.
    expect(out).toMatchObject({ ok: true, taskId: 'mismatch' });
    expect((out as { detail: string }).detail).toMatch(/verified empty/);
    expect((out as { detail: string }).detail).not.toMatch(/remained during the verification window/);
    // ...and therefore no pointless escalation: SIGTERM already worked.
    expect(signals).toEqual(['--signal=SIGTERM']);
    // CONTROL — the bug was not that the operator cgroup is empty in this fixture.
    // It is populated, and the OLD code (which walked `row.cgroupPath`) would have
    // read these three pids as survivors of a scope that holds nothing.
    expect(fs.readFile(`/sys/fs/cgroup${operatorCgroup}/cgroup.procs`)).toBe('101\n102\n103\n');
    expect(reads.some((p) => p.startsWith(`/sys/fs/cgroup${trueScopeCgroup}`))).toBe(true);
  });

  it('EI-22074929140199832: an UNRESOLVABLE scope never reads as "verified empty" — a failed instrument is not a clean kill', async () => {
    // The dangerous direction of the same fix. Resolving through systemd introduces
    // a call that can FAIL, and a failure rendered as `null` would walk no cgroup at
    // all and report the kill verified. That is worse than the bug being fixed: it
    // invents a clean verdict. A resolution failure must fall back, not fabricate.
    const operatorCgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service';
    row({ taskId: 'unresolvable', scopeUnit: 'pc-unresolvable.scope', cgroupPath: operatorCgroup });
    const out = await killTask('unresolvable', {
      sleep: async () => {},
      // The stored (mismatched) cgroup still holds processes.
      fs: { readFile: () => '777\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'show') throw new Error('systemctl unreachable');
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect((out as { detail?: string }).detail ?? '').not.toMatch(/verified empty/);
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
  });

  it('EI-22074929140199832: a COLLECTED transient scope is positively empty, not unknown', async () => {
    // systemd exits 0 with an empty ControlGroup for a unit it has already
    // collected. No cgroup means no processes — this one really is empty, and must
    // not be dragged back to the stored path's phantom survivors.
    const operatorCgroup = '/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service';
    row({ taskId: 'collected', scopeUnit: 'pc-collected.scope', cgroupPath: operatorCgroup });
    const out = await killTask('collected', {
      sleep: async () => {},
      fs: { readFile: () => '888\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => ({
        stdout: args[1] === 'show' ? '\n' : '',
        stderr: '',
      })) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'collected' });
    expect((out as { detail: string }).detail).toMatch(/verified empty/);
  });

  it('EI-22074929140199832: a stored cgroup_path that DOES belong to the scope is still trusted (no extra systemd round-trip)', async () => {
    // The 204-of-726 good case must not regress into an unnecessary `systemctl show`
    // on every probe — the stored path is authoritative exactly when it validates.
    row({ taskId: 'matching' });
    let shows = 0;
    const out = await killTask('matching', {
      sleep: async () => {},
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'show') shows++;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'matching' });
    expect(shows).toBe(0);
  });

  it('EI-19478780721557822 recurrence guard: never reports ok:true while the subtree survives, and leaves the row LIVE for a retry', async () => {
    // No escalateAfterMs at all — the plain SIGTERM path. Before this fix, the
    // code returned ok:true immediately after `systemctl kill` exited 0, with
    // zero verification that anything actually died.
    row({ taskId: 'b2b' });
    const out = await killTask('b2b', {
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    // The dangerous half of the bug: a false success ALSO closed the row as
    // 'killed', which then made every subsequent taskId-mode kill attempt fail
    // with `not_live` — the reported "escape hatch closed too". A row that is
    // NOT actually dead must stay live so a retry (or processes:list) can find it.
    expect(store.closed).toHaveLength(0);
    // EI-21895340816653497: the message must not promise a retry that a
    // subsequent state transition (e.g. to `timed_out`) silently invalidates —
    // it names the actual unlock (reapTerminalResidue) up front.
    expect((out as { detail: string }).detail).toMatch(/reapTerminalResidue: true/);
  });

  it('falls back to a bounded unit stop when non-escalated SIGTERM leaves a survivor', async () => {
    row({ taskId: 'b2-stop' });
    const scopePath = '/sys/fs/cgroup/papercusp.slice/pc-b2-stop.scope';
    const calls: string[][] = [];
    let alive = true;
    const out = await killTask('b2-stop', {
      sleep: async () => {},
      fs: {
        readFile: (path: string) => (path === `${scopePath}/cgroup.procs` && alive ? '4242\n' : ''),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'stop') alive = false;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls).toEqual([
      ['--user', 'kill', '--signal=SIGTERM', 'pc-b2-stop.scope'],
      ['--user', 'stop', 'pc-b2-stop.scope'],
    ]);
    expect(out).toMatchObject({ ok: true, taskId: 'b2-stop' });
    expect((out as { detail: string }).detail).toMatch(/verified empty/);
    expect(store.closed).toEqual([{ taskId: 'b2-stop', state: 'killed', reason: 'scope kill SIGTERM' }]);
  });

  it('does not use the stop fallback for an explicit SIGKILL', async () => {
    row({ taskId: 'b2-sigkill' });
    const calls: string[][] = [];
    const out = await killTask('b2-sigkill', {
      signal: 'SIGKILL',
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls).toEqual([['--user', 'kill', '--signal=SIGKILL', 'pc-b2-sigkill.scope']]);
    expect(out).toMatchObject({ ok: false, taskId: 'b2-sigkill', error: 'incomplete' });
    expect(store.closed).toHaveLength(0);
  });

  it('deep-walks nested cgroups when verifying — a descendant delegated into a sub-cgroup is not invisible', async () => {
    // Top-level cgroup.procs is EMPTY (the leader exited), but a descendant left
    // a process behind in a nested child directory — the shape a bare, single-
    // directory `cgroup.procs` read cannot see (readCgroupProcs deliberately
    // reads ONE directory only; walkCgroupTree recurses).
    row({ taskId: 'b2c' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-b2c.scope';
    const out = await killTask('b2c', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => (p.endsWith('/child/cgroup.procs') ? '5555\n' : ''),
        readDir: (p: string) => (p === scopeDir ? ['child'] : []),
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete', detail: expect.stringContaining('1 process') });
    expect(store.closed).toHaveLength(0);
  });

  it('does NOT escalate when the scope emptied after SIGTERM', async () => {
    row({ taskId: 'b3' });
    const calls: string[][] = [];
    await killTask('b3', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls).toHaveLength(1);
  });

  it('surfaces a systemctl failure instead of claiming success', async () => {
    row({ taskId: 'b4' });
    const out = await killTask('b4', {
      execFileAsync: (async () => {
        throw new Error('Unit pc-b4.scope not loaded.');
      }) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'command_failed' });
    expect(store.closed).toHaveLength(0);
  });
});

describe('killTask — reapTerminalResidue (WI-37521)', () => {
  it('refuses a terminal row exactly as before when the flag is absent — no behaviour change', async () => {
    row({ taskId: 'r1', state: 'killed' });
    const kill = vi.fn();
    const out = await killTask('r1', {
      kill,
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
    });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect(kill).not.toHaveBeenCalled();
    expect(store.closed).toHaveLength(0);
    // EI-21895340816653497: the exact refusal a caller hits after their prior
    // `incomplete` reply's row aged into terminal must name the unlock here —
    // this is the only place they land, and reapTerminalResidue's existence is
    // otherwise undiscoverable from the refusal alone.
    expect((out as { detail: string }).detail).toMatch(/reapTerminalResidue: true/);
  });

  it('reaps a terminal row whose scope is POSITIVELY re-verified to still hold processes', async () => {
    row({ taskId: 'r2', state: 'killed' });
    const calls: string[][] = [];
    let signalled = false;
    const out = await killTask('r2', {
      reapTerminalResidue: true,
      // Before the signal: the scope holds a live pid (the whole premise of the
      // reap). After: it's gone — the signal actually worked.
      fs: { readFile: () => (signalled ? '' : '4242\n'), readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        signalled = true;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'r2' });
    expect((out as { detail: string }).detail).toMatch(/TERMINAL-ROW REAP/);
    expect(calls[0]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-r2.scope']);
    // The row's OWN state must NOT be rewritten — closeTask no-ops on an
    // already-ended row by design, and this must never fight that.
    expect(store.closed).toHaveLength(0);
  });

  it('still refuses when the flag is set but the scope is actually empty — nothing to reap', async () => {
    row({ taskId: 'r3', state: 'exited' });
    const out = await killTask('r3', {
      reapTerminalResidue: true,
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
    });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect((out as { detail: string }).detail).toMatch(/nothing to reap/);
  });

  it('still refuses an UNCONFINED terminal row even with the flag — pid re-verification is not trustworthy here', async () => {
    row({ taskId: 'r4', state: 'exited', confined: false, scopeUnit: null, pid: 999, processIdentity: 'linux:b:1' });
    const kill = vi.fn();
    const out = await killTask('r4', { reapTerminalResidue: true, kill, readIdentity: () => 'linux:b:1' });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect((out as { detail: string }).detail).toMatch(/unconfined/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('an INCOMPLETE reap (survivors after the verification window) is reported honestly, not as success', async () => {
    row({ taskId: 'r5', state: 'killed' });
    const out = await killTask('r5', {
      reapTerminalResidue: true,
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    expect(store.closed).toHaveLength(0);
  });
});

describe('killTask — residue diagnostics on an incomplete kill (EI-21065795494500135)', () => {
  it('reports WHICH kernel state the survivors are stuck in, not a bare unexplained count — all zombie', async () => {
    row({ taskId: 'residue1' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue1.scope';
    const out = await killTask('residue1', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => {
          if (p === `${scopeDir}/cgroup.procs`) return '101\n102\n103\n';
          const m = /^\/proc\/(\d+)\/stat$/.exec(p);
          return m ? `${m[1]} (node) Z 1` : null;
        },
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    const detail = (out as { detail: string }).detail;
    // The base "N process(es) still alive" phrasing existing callers assert on
    // must survive unchanged — the diagnostics are an ADDITION, not a rewrite.
    expect(detail).toMatch(/3 process\(es\) still alive/);
    expect(detail).toMatch(/3 zombie/);
    expect(detail).toMatch(/ALL zombie/);
    expect(detail).toMatch(/re-escalating will not help/);
  });

  it('buckets a MIXED survivor population and only warns "uninterruptible" — never "all zombie" — when they are not all zombies', async () => {
    row({ taskId: 'residue2' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue2.scope';
    const states: Record<string, string> = { '201': 'Z', '202': 'D', '203': 'R' };
    const out = await killTask('residue2', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => {
          if (p === `${scopeDir}/cgroup.procs`) return '201\n202\n203\n';
          const m = /^\/proc\/(\d+)\/stat$/.exec(p);
          return m ? `${m[1]} (node) ${states[m[1]]} 1` : null;
        },
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    const detail = (out as { detail: string }).detail;
    expect(detail).toMatch(/1 zombie/);
    expect(detail).toMatch(/1 uninterruptible-sleep/);
    expect(detail).toMatch(/1 running/);
    expect(detail).not.toMatch(/ALL zombie/);
    expect(detail).toMatch(/blocked inside the kernel/);
  });

  it('degrades to "unknown" instead of crashing when a survivor pid\'s /proc/<pid>/stat is unreadable', async () => {
    row({ taskId: 'residue3' });
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-residue3.scope';
    const out = await killTask('residue3', {
      sleep: async () => {},
      fs: {
        readFile: (p: string) => (p === `${scopeDir}/cgroup.procs` ? '301\n' : null),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
    expect((out as { detail: string }).detail).toMatch(/1 unknown/);
  });
});

describe('killScopeUnit — explicit orphan-scope teardown', () => {
  it.each([false, true])('distinguishes SIGKILL delivery from failed escalation (failure=%s)', async (failure) => {
    const calls: string[][] = [];
    const out = await killScopeUnit('pc-orphan123.scope', {
      escalateAfterMs: 1,
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') return { stdout: '/papercusp.slice/pc-orphan123.scope\n', stderr: '' };
        if (failure && args.includes('--signal=SIGKILL')) throw new Error('systemd bus disconnected during escalation');
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(calls.slice(1)).toEqual([
      ['--user', 'kill', '--signal=SIGTERM', 'pc-orphan123.scope'],
      ['--user', 'kill', '--signal=SIGKILL', 'pc-orphan123.scope'],
      // A failed escalation re-asks systemd whether the scope was collected (WI-10004447).
      ...(failure ? [['--user', 'show', '-p', 'ControlGroup', '--value', 'pc-orphan123.scope']] : []),
    ]);
    if (failure) {
      expect(out).toMatchObject({ ok: false, error: 'command_failed', detail: expect.stringContaining('systemd bus disconnected') });
      expect(out.detail).not.toContain('no retry is required');
    } else {
      expect(out).toMatchObject({ ok: true, detail: expect.stringContaining('termination pending') });
    }
    expect(store.closed).toHaveLength(0);
  });

  it('resolves a validated Papercusp scope, requires a live cgroup, and verifies it empty', async () => {
    let alive = true;
    const calls: string[][] = [];
    const out = await killScopeUnit('pc-orphan123.scope', {
      fs: {
        readFile: () => (alive ? '4242\n' : ''),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') {
          return {
            stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
            stderr: '',
          };
        }
        alive = false;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, scopeUnit: 'pc-orphan123.scope' });
    expect(calls[0]).toEqual([
      '--user',
      'show',
      '-p',
      'ControlGroup',
      '--value',
      'pc-orphan123.scope',
    ]);
    expect(calls[1]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-orphan123.scope']);
  });

  it('refuses an invalid or empty scope without issuing a kill', async () => {
    const exec = vi.fn(async () => ({
      stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
      stderr: '',
    }));
    expect(await killScopeUnit('other-service.scope', { execFileAsync: exec as never })).toMatchObject({
      ok: false,
      error: 'no_target',
    });
    expect(exec).not.toHaveBeenCalled();

    const empty = await killScopeUnit('pc-orphan123.scope', {
      fs: { readFile: () => '', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({
        stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
        stderr: '',
      })) as never,
    });
    // An existing-but-empty scope is `already_gone`, not `not_live`: nothing is wrong,
    // there is simply nothing left to signal (WI-1199802).
    expect(empty).toMatchObject({ ok: false, error: 'already_gone' });
  });

  // WI-1199802. "systemd has no cgroup for this unit" and "this unit's cgroup is foreign"
  // both used to come back as `no_target`, so a caller could not tell an ordinary
  // completed teardown from a lookalike-unit refusal without matching on a detail string.
  // The first is the goal state; only the second deserves a warning.
  it('distinguishes a COLLECTED scope from a LOOKALIKE one', async () => {
    // `systemctl show` exits 0 with an EMPTY value for a unit it does not know — which for
    // a transient scope is its ordinary end of life: the payload exited and systemd
    // collected the unit. No cgroup means no cgroup to hold processes.
    const collected = await killScopeUnit('pc-orphan123.scope', {
      execFileAsync: (async () => ({ stdout: '\n', stderr: '' })) as never,
    });
    expect(collected).toMatchObject({ ok: false, error: 'already_gone' });
    expect((collected as { detail: string }).detail).toMatch(/no longer known to systemd/);

    // A cgroup path that IS present but resolves outside papercusp.slice is the refusal
    // this guard exists for. It must stay `no_target`, and stay loud.
    const lookalike = await killScopeUnit('pc-orphan123.scope', {
      execFileAsync: (async () => ({
        stdout: '/user.slice/user-1000.slice/user@1000.service/somebody-else.slice/pc-orphan123.scope\n',
        stderr: '',
      })) as never,
    });
    expect(lookalike).toMatchObject({ ok: false, error: 'no_target' });
  });

  it('accepts a validated Papercusp transient service unit', async () => {
    let alive = true;
    const calls: string[][] = [];
    const out = await killScopeUnit('pc-service123.service', {
      fs: {
        readFile: () => (alive ? '4242\n' : ''),
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        if (args[1] === 'show') {
          return {
            stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-service123.service\n',
            stderr: '',
          };
        }
        alive = false;
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, scopeUnit: 'pc-service123.service' });
    expect(calls[1]).toEqual(['--user', 'kill', '--signal=SIGTERM', 'pc-service123.service']);
  });

  it('never reports success while an orphan scope survives the verification window', async () => {
    const out = await killScopeUnit('pc-orphan123.scope', {
      sleep: async () => {},
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async () => ({
        stdout: '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/pc-orphan123.scope\n',
        stderr: '',
      })) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'incomplete' });
  });
});

describe('killTask — refusals', () => {
  it('refuses a row that is not live-owned', async () => {
    row({ taskId: 'c1', state: 'unaccounted' });
    // Residue is REPORT-ONLY (D-010): the whole point is that we do not act on a
    // classification we may have got wrong.
    expect(await killTask('c1')).toMatchObject({ ok: false, error: 'not_live' });
  });

  it('refuses an already-ended row', async () => {
    row({ taskId: 'c2', state: 'exited' });
    expect(await killTask('c2')).toMatchObject({ ok: false, error: 'not_live' });
  });

  it('refuses an unconfined row whose pid was recycled — and does NOT signal', async () => {
    row({ taskId: 'c3', confined: false, scopeUnit: null, pid: 77, processIdentity: 'linux:b:1' });
    const kill = vi.fn();
    const out = await killTask('c3', { kill, readIdentity: () => 'linux:b:2' });
    expect(out).toMatchObject({ ok: false, error: 'identity_mismatch' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('closes the row as stranded when the pid is simply gone', async () => {
    row({ taskId: 'c4', confined: false, scopeUnit: null, pid: 77, processIdentity: 'linux:b:1' });
    const out = await killTask('c4', { kill: vi.fn(), readIdentity: () => null });
    expect(out.ok).toBe(false);
    expect(store.closed).toEqual([
      { taskId: 'c4', state: 'stranded', reason: 'process gone at kill time' },
    ]);
  });

  it('is a clean not-found for an unknown id', async () => {
    expect(await killTask('nope')).toMatchObject({ ok: false, error: 'task_not_found' });
  });
});

describe('killTask — external kill-intent notice, unconfined pid path (EI-21905196224862433)', () => {
  it('announces kill-intent BEFORE the pid is signalled', async () => {
    row({ taskId: 'c5-notify', confined: false, scopeUnit: null, pid: 88, processIdentity: 'linux:b:1' });
    const notified: Array<[string, NodeJS.Signals]> = [];
    const unsubscribe = onTaskKillRequested((taskId, signal) => notified.push([taskId, signal]));
    try {
      const out = await killTask('c5-notify', {
        readIdentity: () => 'linux:b:1',
        readProcessGroup: () => null,
        kill: (_pid: number, _signal: NodeJS.Signals) => {
          expect(notified).toEqual([['c5-notify', 'SIGTERM']]);
        },
      });
      expect(out.ok).toBe(true);
      expect(notified).toEqual([['c5-notify', 'SIGTERM']]);
    } finally {
      unsubscribe();
    }
  });

  it('does NOT announce kill-intent when the pid identity check refuses the kill (recycled pid)', async () => {
    row({ taskId: 'c6-notify', confined: false, scopeUnit: null, pid: 88, processIdentity: 'linux:b:1' });
    const notified: Array<[string, NodeJS.Signals]> = [];
    const unsubscribe = onTaskKillRequested((taskId, signal) => notified.push([taskId, signal]));
    try {
      const out = await killTask('c6-notify', { readIdentity: () => 'linux:b:999', kill: vi.fn() });
      expect(out).toMatchObject({ ok: false, error: 'identity_mismatch' });
      expect(notified).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

describe('killTask — unconfined process group (EI-24635523980082322)', () => {
  it('signals the whole group when the verified pid leads it (a detached launch)', async () => {
    row({ taskId: 'g1', confined: false, scopeUnit: null, pid: 68752, processIdentity: 'darwin:t0' });
    const kill = vi.fn();
    const out = await killTask('g1', { kill, readIdentity: () => 'darwin:t0', readProcessGroup: () => 68752 });
    expect(out).toMatchObject({ ok: true, detail: 'process group 68752 signalled SIGTERM' });
    expect(kill.mock.calls).toEqual([[-68752, 'SIGTERM']]);
    expect(store.closed).toEqual([{ taskId: 'g1', state: 'killed', reason: 'group kill SIGTERM' }]);
  });

  it('keeps the single-pid signal when the pid sits in someone else\'s group', async () => {
    row({ taskId: 'g2', confined: false, scopeUnit: null, pid: 68752, processIdentity: 'darwin:t0' });
    const kill = vi.fn();
    const out = await killTask('g2', { kill, readIdentity: () => 'darwin:t0', readProcessGroup: () => 1 });
    expect(out).toMatchObject({ ok: true, detail: 'pid 68752 signalled SIGTERM' });
    expect(kill.mock.calls).toEqual([[68752, 'SIGTERM']]);
  });

  it('escalates to SIGKILL on the group when the leader is still ours after the grace period', async () => {
    row({ taskId: 'g3', confined: false, scopeUnit: null, pid: 68752, processIdentity: 'darwin:t0' });
    const kill = vi.fn();
    const sleep = vi.fn(async () => {});
    const out = await killTask('g3', {
      kill,
      sleep,
      escalateAfterMs: 5_000,
      readIdentity: () => 'darwin:t0',
      readProcessGroup: () => 68752,
    });
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(kill.mock.calls).toEqual([
      [-68752, 'SIGTERM'],
      [-68752, 'SIGKILL'],
    ]);
    expect(out).toMatchObject({ ok: true, detail: 'process group 68752 signalled SIGTERM (escalated to SIGKILL)' });
  });

  it('does not escalate once the leader is gone (its group id could be recycled)', async () => {
    row({ taskId: 'g4', confined: false, scopeUnit: null, pid: 68752, processIdentity: 'darwin:t0' });
    const kill = vi.fn();
    const identities = ['darwin:t0', null];
    const out = await killTask('g4', {
      kill,
      sleep: async () => {},
      escalateAfterMs: 5_000,
      readIdentity: () => identities.shift() ?? null,
      readProcessGroup: () => 68752,
    });
    expect(kill.mock.calls).toEqual([[-68752, 'SIGTERM']]);
    expect(out).toMatchObject({ ok: true, detail: 'process group 68752 signalled SIGTERM' });
  });
});

describe('killTask — subtree', () => {
  it('reaps an API child even when its terminal parent scope is already empty', async () => {
    row({ taskId: 'parent', state: 'exited' });
    row({ taskId: 'api-child', rootTaskId: 'parent', parentTaskId: 'parent' });
    const signalled: string[] = [];
    const result = await killTask('parent', { includeSubtree: true, reapTerminalResidue: true,
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args.includes('kill')) signalled.push(args.at(-1)!);
        return { stdout: '', stderr: '' };
      }) as never });
    expect(signalled).toEqual(['pc-api-child.scope']);
    expect(store.closed).toContainEqual(expect.objectContaining({ taskId: 'api-child', state: 'killed' }));
    expect(result).toMatchObject({ error: 'not_live', detail: expect.stringContaining('holds no live process') });
  });

  it('does not certify an empty parent when a descendant cannot be cleaned up', async () => {
    row({ taskId: 'parent', state: 'exited' });
    row({ taskId: 'api-child', rootTaskId: 'parent', parentTaskId: 'parent' });
    const result = await killTask('parent', { includeSubtree: true, reapTerminalResidue: true,
      execFileAsync: (async () => { throw new Error('signal refused'); }) as never });
    expect(result).toMatchObject({ ok: false, error: 'incomplete',
      detail: expect.stringContaining('Descendant cleanup failed for api-child') });
    expect(store.closed).toEqual([]);
  });

  it('never signals ancestors or siblings when reaping a nested task', async () => {
    row({ taskId: 'parent' });
    row({ taskId: 'child', rootTaskId: 'parent', parentTaskId: 'parent' });
    row({ taskId: 'sibling', rootTaskId: 'parent', parentTaskId: 'parent' });
    // Deliberately insert the grandchild out of ancestry order.
    row({ taskId: 'great-grandchild', rootTaskId: 'parent', parentTaskId: 'grandchild' });
    row({ taskId: 'grandchild', rootTaskId: 'parent', parentTaskId: 'child' });
    const units: string[] = [];
    await killTask('child', {
      includeSubtree: true,
      execFileAsync: (async (_f: string, args: string[]) => {
        units.push(args[args.length - 1]!);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(units.sort()).toEqual(['pc-child.scope', 'pc-grandchild.scope', 'pc-great-grandchild.scope']);
    expect(store.closed.map((entry) => entry.taskId)).not.toContain('parent');
    expect(store.closed.map((entry) => entry.taskId)).not.toContain('sibling');
  });

  it('signals logically-nested tasks that got their own scopes', async () => {
    row({ taskId: 'd1' });
    row({ taskId: 'd2', rootTaskId: 'd1', parentTaskId: 'd1' });
    row({ taskId: 'd3', rootTaskId: 'd1', parentTaskId: 'd2' });
    const units: string[] = [];
    await killTask('d1', {
      includeSubtree: true,
      execFileAsync: (async (_f: string, args: string[]) => {
        units.push(args[args.length - 1]!);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(units.sort()).toEqual(['pc-d1.scope', 'pc-d2.scope', 'pc-d3.scope']);
  });
});

describe('freeze / thaw', () => {
  it('freezes and thaws a confined scope', async () => {
    row({ taskId: 'e1' });
    const calls: string[][] = [];
    const exec = (async (_f: string, args: string[]) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    }) as never;
    expect((await freezeTask('e1', { execFileAsync: exec })).ok).toBe(true);
    expect((await thawTask('e1', { execFileAsync: exec })).ok).toBe(true);
    expect(calls).toEqual([
      ['--user', 'freeze', 'pc-e1.scope'],
      ['--user', 'thaw', 'pc-e1.scope'],
    ]);
  });

  it('refuses to fake a freeze on an unconfined task', async () => {
    // SIGSTOP on the leader would leave every child running — a half-frozen
    // subtree is worse than an honest refusal.
    row({ taskId: 'e2', confined: false, scopeUnit: null, pid: 5 });
    expect(await freezeTask('e2')).toMatchObject({ ok: false, error: 'unsupported' });
  });

  it('recovers a stranded task only when its managed scope is non-empty and frozen', async () => {
    const scopeDir = '/sys/fs/cgroup/papercusp.slice/pc-e3.scope';
    const calls: string[][] = [];
    row({ taskId: 'e3', state: 'stranded', endedAt: new Date().toISOString(), exitReason: 'member recovery' });
    const out = await thawTask('e3', {
      fs: {
        readFile: (path: string) => {
          if (path === `${scopeDir}/cgroup.procs`) return '4242\n';
          if (path === `${scopeDir}/cgroup.freeze`) return '1\n';
          return '';
        },
        readDir: () => [],
        isDir: () => true,
      },
      execFileAsync: (async (_f: string, args: string[]) => {
        calls.push(args);
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: true, taskId: 'e3', action: 'thaw' });
    expect(calls).toEqual([['--user', 'thaw', 'pc-e3.scope']]);
    expect(store.reopened).toEqual(['e3']);
    expect(store.rows.get('e3')).toMatchObject({ state: 'running', endedAt: null, exitReason: null });
  });

  it('refuses an ordinary stranded row whose scope is empty or already thawed', async () => {
    for (const [taskId, freezeValue] of [
      ['e4-empty', '1'],
      ['e5-thawed', '0'],
    ] as const) {
      row({ taskId, state: 'stranded', endedAt: new Date().toISOString() });
      const scopeDir = `/sys/fs/cgroup/papercusp.slice/pc-${taskId}.scope`;
      const out = await thawTask(taskId, {
        fs: {
          readFile: (path: string) => {
            if (path === `${scopeDir}/cgroup.procs` && taskId === 'e5-thawed') return '4242\n';
            if (path === `${scopeDir}/cgroup.freeze`) return freezeValue;
            return '';
          },
          readDir: () => [],
          isDir: () => true,
        },
        execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
      });
      expect(out).toMatchObject({ ok: false, error: 'not_live' });
      expect(store.reopened).not.toContain(taskId);
    }
  });

  it('does not recover a stranded row from an unvalidated stored cgroup path', async () => {
    row({
      taskId: 'e6-unvalidated',
      state: 'stranded',
      endedAt: new Date().toISOString(),
      cgroupPath: '/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service',
    });
    const out = await thawTask('e6-unvalidated', {
      fs: { readFile: () => '4242\n', readDir: () => [], isDir: () => true },
      execFileAsync: (async (_f: string, args: string[]) => {
        if (args[1] === 'show') throw new Error('systemctl unreachable');
        return { stdout: '', stderr: '' };
      }) as never,
    });
    expect(out).toMatchObject({ ok: false, error: 'not_live' });
    expect(store.reopened).not.toContain('e6-unvalidated');
  });
});

describe('freeze / thaw — wall-clock deadlines keep running (EI-24796665684871321)', () => {
  const NOW = Date.parse('2026-10-01T18:00:00.000Z');
  const okExec = (async () => ({ stdout: '', stderr: '' })) as never;

  it('a freeze of a task with a ledger deadline reports it and warns the clock keeps running', async () => {
    row({ taskId: 'g1', deadlineAt: new Date(NOW + 50_000).toISOString() });
    const out = await freezeTask('g1', { execFileAsync: okExec, now: () => NOW });
    expect(out).toMatchObject({
      ok: true,
      action: 'freeze',
      deadline: { remainingSec: 50, expired: false },
    });
    // Narrow on the ok branch (the union's failure arm has no `warnings`).
    expect(out.ok && out.warnings?.[0]).toContain('KEEPS RUNNING');
  });

  it('a freeze of the incident command flags the inner GNU timeout (ledger has no deadline)', async () => {
    row({ taskId: 'g2', argv: ['bash', '-o', 'pipefail', '-c', 'timeout -k 30 1800 gitnexus analyze'] });
    const out = await freezeTask('g2', { execFileAsync: okExec, now: () => NOW });
    expect(out).toMatchObject({
      ok: true,
      innerTimeouts: [{ seconds: 1800, matched: 'timeout -k 30 1800' }],
    });
    expect(out.ok && out.deadline).toBeUndefined();
    expect(out.ok && out.warnings?.[0]).toContain('HEURISTIC');
  });

  it('a thaw with the budget nearly spent warns the task is about to be terminated', async () => {
    // The incident's own numbers: 29:10 of a 30:00 budget used while frozen → 50s left.
    row({ taskId: 'g3', deadlineAt: new Date(NOW + 50_000).toISOString() });
    const out = await thawTask('g3', { execFileAsync: okExec, now: () => NOW });
    expect(out).toMatchObject({ ok: true, action: 'thaw', deadline: { remainingSec: 50 } });
    expect(out.ok && out.warnings?.[0]).toContain('frozen time counted against it');
  });

  it('a task with no wall-clock deadline of either kind carries NO deadline fields at all', async () => {
    row({ taskId: 'g4', argv: ['bash', '-c', 'npm test'] });
    const out = await freezeTask('g4', { execFileAsync: okExec, now: () => NOW });
    expect(out.ok).toBe(true);
    // The success shape is unchanged for a plain task — callers that destructure only
    // { ok, taskId, action, detail } see exactly what they saw before.
    expect(out).toEqual({ ok: true, taskId: 'g4', action: 'freeze', detail: 'scope pc-g4.scope frozen' });
  });

  it('a FAILED freeze carries no deadline report (nothing was frozen, so nothing to warn about)', async () => {
    row({ taskId: 'g5', deadlineAt: new Date(NOW + 50_000).toISOString() });
    const failing = (async () => {
      throw new Error('systemctl exploded');
    }) as never;
    const out = await freezeTask('g5', { execFileAsync: failing, now: () => NOW });
    expect(out).toMatchObject({ ok: false, error: 'command_failed' });
    expect(out).not.toHaveProperty('warnings');
    expect(out).not.toHaveProperty('deadline');
  });
});

describe('limitTask', () => {
  it('applies budgets at runtime', async () => {
    row({ taskId: 'f1' });
    const calls: string[][] = [];
    const out = await limitTask(
      'f1',
      { memoryMaxBytes: 2_147_483_648, cpuWeight: 20, tasksMax: 512 },
      {
        execFileAsync: (async (_f: string, args: string[]) => {
          calls.push(args);
          return { stdout: '', stderr: '' };
        }) as never,
      },
    );
    expect(out.ok).toBe(true);
    expect(calls[0]).toEqual([
      '--user',
      'set-property',
      '--runtime',
      'pc-f1.scope',
      'MemoryMax=2147483648',
      'CPUWeight=20',
      'TasksMax=512',
    ]);
    expect(store.limitUpdates).toEqual([
      {
        taskId: 'f1',
        limits: { memoryMaxBytes: 2_147_483_648, cpuWeight: 20, tasksMax: 512 },
      },
    ]);
    expect(store.rows.get('f1')).toMatchObject({
      memoryMaxBytes: 2_147_483_648,
      cpuWeight: 20,
      tasksMax: 512,
    });
  });

  it('reports a persistence failure instead of claiming success after systemd changed the scope', async () => {
    row({ taskId: 'f1-ledger-failure' });
    store.persistLimits = false;
    const out = await limitTask('f1-ledger-failure', { memoryMaxBytes: 2_147_483_648 }, {
      execFileAsync: (async () => ({ stdout: '', stderr: '' })) as never,
    });
    expect(out).toMatchObject({ ok: false, taskId: 'f1-ledger-failure', error: 'persistence_failed' });
    expect((out as { detail: string }).detail).toMatch(/systemd accepted MemoryMax=2147483648/);
  });

  it('rejects an empty budget rather than issuing a no-op command', async () => {
    row({ taskId: 'f2' });
    expect(await limitTask('f2', {})).toMatchObject({ ok: false, error: 'no_target' });
  });
});
