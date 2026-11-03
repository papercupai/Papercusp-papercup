import { describe, it, expect } from 'vitest';
import { reconcile, summarizeReconcile, scopeUnitOf, type ScannedProcess } from './reconcile';
import { classifyScope } from './scope-class';
import { serviceUnitForTask, type TaskRow, type TaskState } from './types';

const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const OLD = new Date(NOW - 10 * 60_000).toISOString();
const JUST_NOW = new Date(NOW - 2_000).toISOString();

const OUR_SLICE = '/user.slice/user-1000.slice/user@1000.service/papercusp.slice';

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  return {
    workspaceId: 'w',
    rootTaskId: over.taskId,
    class: 'bash-job',
    title: 't',
    argv: ['echo'],
    confined: true,
    state: 'running' as TaskState,
    startedAt: OLD,
    lastSeenAt: OLD,
    launchedBy: 'su-test',
    detail: {},
    ...over,
  };
}

function proc(over: Partial<ScannedProcess> & { pid: number }): ScannedProcess {
  const base = {
    cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope`,
    processIdentity: `linux:boot:${over.pid}`,
    cmdline: 'node something',
    owned: true,
    ...over,
  };
  // Derive the scope discriminant from the SAME classifier production uses, so a
  // fixture can never assert a combination the real scan cannot produce. An
  // explicit `scope`/`exemptReason` in `over` still wins, for the cases that are
  // deliberately testing a mismatch.
  const derived = classifyScope(base.cgroupPath, base.owned);
  return { scope: derived.scope, exemptReason: derived.exemptReason, ...base };
}

describe('scopeUnitOf', () => {
  it('extracts our scope from the leaf segment', () => {
    expect(scopeUnitOf(proc({ pid: 1 }))).toBe('pc-aaa111.scope');
  });

  it('extracts the nearest managed scope ancestor from a nested child cgroup', () => {
    expect(
      scopeUnitOf(
        proc({
          pid: 1,
          cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope/papercusp-deb-build-123.scope`,
        }),
      ),
    ).toBe('pc-aaa111.scope');
  });

  it('is null for a process that is merely inside our slice', () => {
    expect(scopeUnitOf(proc({ pid: 1, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice` }))).toBeNull();
  });

  it('does not treat a VTE window scope as a claimed pc task scope', () => {
    expect(
      scopeUnitOf(
        proc({
          pid: 1,
          cgroupPath: `${OUR_SLICE}/papercusp-agent.slice/papercusp-agent-session.slice/vte-spawn-0e0e-4a4a.scope`,
        }),
      ),
    ).toBeNull();
  });
});

describe('reconcile — alive matching', () => {
  it('matches by scope and counts the whole subtree', () => {
    const r = reconcile(
      [row({ taskId: 'aaa111', scopeUnit: 'pc-aaa111.scope' })],
      [proc({ pid: 100 }), proc({ pid: 231 }), proc({ pid: 232 })],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(1);
    expect(r.alive[0]).toMatchObject({ taskId: 'aaa111', pid: 100, pidsSeen: 3, matchedBy: 'scope' });
    expect(r.stranded).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(0);
  });

  it('keeps release-cut work alive under its task service while build processes are nested', () => {
    const unit = serviceUnitForTask('aaa111');
    const servicePath = `${OUR_SLICE}/papercusp-deploy.slice/${unit}`;
    const nestedBuildPath = `${servicePath}/papercusp-cut-build.scope`;
    const r = reconcile(
      [row({ taskId: 'aaa111', class: 'deploy', scopeUnit: unit })],
      [proc({ pid: 100, cgroupPath: servicePath }), proc({ pid: 231, cgroupPath: nestedBuildPath })],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(1);
    expect(r.alive[0]).toMatchObject({ taskId: 'aaa111', pid: 100, pidsSeen: 2, matchedBy: 'scope' });
    expect(r.stranded).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(0);
  });

  it('keeps descendant cgroups attached to their managed parent scope', () => {
    const r = reconcile(
      [row({ taskId: 'aaa111', scopeUnit: 'pc-aaa111.scope' })],
      [
        proc({ pid: 100 }),
        proc({
          pid: 231,
          cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope/papercusp-deb-build-123.scope`,
        }),
        proc({
          pid: 232,
          cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope/papercusp-deb-build-123.scope/worker`,
        }),
      ],
      { now: NOW },
    );
    expect(r.alive[0]).toMatchObject({ taskId: 'aaa111', pidsSeen: 3, matchedBy: 'scope' });
    expect(r.stranded).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(0);
  });

  it('matches an unconfined row by kernel process identity', () => {
    const r = reconcile(
      [
        row({
          taskId: 'bbb222',
          confined: false,
          scopeUnit: null,
          processIdentity: 'linux:boot:55',
          pid: 55,
        }),
      ],
      [proc({ pid: 55, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice`, processIdentity: 'linux:boot:55' })],
      { now: NOW },
    );
    expect(r.alive[0]).toMatchObject({ taskId: 'bbb222', matchedBy: 'identity' });
    expect(r.unaccounted).toHaveLength(0);
  });

  it('falls back to a bare pid ONLY when the row never captured an identity', () => {
    const r = reconcile(
      [row({ taskId: 'ccc333', confined: false, scopeUnit: null, processIdentity: null, pid: 77 })],
      [proc({ pid: 77, cgroupPath: `${OUR_SLICE}/x`, processIdentity: null })],
      { now: NOW },
    );
    expect(r.alive[0]).toMatchObject({ taskId: 'ccc333', matchedBy: 'pid' });
  });
});

describe('reconcile — PID recycling safety', () => {
  it('REFUSES to keep a row alive when its pid was recycled by another process', () => {
    // The single most dangerous case on this box: PID wrap happens ~daily under
    // fleet load. A row that recorded identity A must never be re-bound to a
    // stranger that merely inherited its pid — that is how a kill hits the
    // owner's desktop session.
    const r = reconcile(
      [
        row({
          taskId: 'ddd444',
          confined: false,
          scopeUnit: null,
          pid: 4242,
          processIdentity: 'linux:boot:1111',
        }),
      ],
      [proc({ pid: 4242, cgroupPath: `${OUR_SLICE}/x`, processIdentity: 'linux:boot:9999' })],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0]!.reason).toMatch(/identity linux:boot:1111 is gone/);
    // …and the stranger is reported as residue rather than silently adopted.
    expect(r.unaccounted.flatMap((g) => g.pids)).toContain(4242);
  });
});

// WI-10005782: a wake executor's unconfined `claude -p --resume <id>` turn runs in
// the operator's service cgroup and its argv names no repo path, so the scan's
// foreign display filter never lists it. Before the fix every such row stranded
// one grace period after spawn while the process kept running.
describe('reconcile — unconfined task the scan read but did not list (WI-10005782)', () => {
  const headless = () =>
    row({
      taskId: 'eee555',
      class: 'agent-session',
      confined: false,
      scopeUnit: null,
      pid: 5151,
      processIdentity: 'linux:boot:7777',
    });

  it('keeps the row alive when the scan saw its pid with the SAME identity', () => {
    const r = reconcile([headless()], [], {
      now: NOW,
      unlistedIdentityByPid: new Map([[5151, 'linux:boot:7777']]),
    });
    expect(r.stranded).toHaveLength(0);
    expect(r.alive).toHaveLength(1);
    expect(r.alive[0]).toMatchObject({
      taskId: 'eee555',
      pid: 5151,
      processIdentity: 'linux:boot:7777',
      matchedBy: 'identity',
    });
  });

  it('strands the row when nothing carries the identity (the pre-fix reading, still correct for a dead turn)', () => {
    const r = reconcile([headless()], [], { now: NOW });
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0]!.reason).toMatch(/identity linux:boot:7777 is gone/);
  });

  it('REFUSES a recycled pid: same pid, different start time', () => {
    const r = reconcile([headless()], [], {
      now: NOW,
      unlistedIdentityByPid: new Map([[5151, 'linux:boot:8888']]),
    });
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
  });

  it('REFUSES the identity under a different pid: a match needs pid AND start time', () => {
    const r = reconcile([headless()], [], {
      now: NOW,
      unlistedIdentityByPid: new Map([[6262, 'linux:boot:7777']]),
    });
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
  });
});

describe('reconcile — stranding', () => {
  it('keeps a scoped row unresolved when systemd has not confirmed release', () => {
    const r = reconcile([row({ taskId: 'eee555', scopeUnit: 'pc-eee555.scope' })], [], { now: NOW });
    expect(r.stranded).toHaveLength(0);
    expect(r.endedUnobserved).toHaveLength(0);
    expect(r.unresolved).toEqual([
      {
        taskId: 'eee555',
        reason: 'scope pc-eee555.scope holds no processes — systemd has not confirmed scope pc-eee555.scope was released',
      },
    ]);
  });

  it('does NOT strand a row that is younger than the grace window', () => {
    // register -> fork -> visible-in-cgroup is not instantaneous. Stranding a row
    // in that window would kill-report healthy tasks on every tick.
    const r = reconcile(
      [row({ taskId: 'fff666', scopeUnit: 'pc-fff666.scope', startedAt: JUST_NOW, lastSeenAt: JUST_NOW })],
      [],
      { now: NOW },
    );
    expect(r.stranded).toHaveLength(0);
    expect(r.tooYoung).toEqual(['fff666']);
  });

  it('uses the NEWER of startedAt / lastSeenAt for the age test', () => {
    // A long-running task seen 2s ago is not "10 minutes old and absent".
    const r = reconcile(
      [row({ taskId: 'ggg777', scopeUnit: 'pc-ggg777.scope', startedAt: OLD, lastSeenAt: JUST_NOW })],
      [],
      { now: NOW },
    );
    expect(r.stranded).toHaveLength(0);
    expect(r.tooYoung).toEqual(['ggg777']);
  });

  it('ignores rows already in a terminal state', () => {
    const r = reconcile([row({ taskId: 'hhh888', state: 'exited', scopeUnit: 'pc-hhh888.scope' })], [], {
      now: NOW,
    });
    expect(r.stranded).toHaveLength(0);
    expect(r.alive).toHaveLength(0);
  });

  it('never treats residue classifications as ours to signal', () => {
    const r = reconcile(
      [
        row({ taskId: 'iii999', state: 'unaccounted', scopeUnit: 'pc-iii999.scope' }),
        row({ taskId: 'jjj000', state: 'foreign', scopeUnit: null, pid: 5 }),
      ],
      [],
      { now: NOW },
    );
    expect(r.alive).toHaveLength(0);
    expect(r.stranded).toHaveLength(0);
  });
});

describe('reconcile — residue (the no-escape signal)', () => {
  it('flags a process inside our slice with no ledger row', () => {
    const r = reconcile([], [proc({ pid: 900 }), proc({ pid: 901 })], { now: NOW });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({
      scopeUnit: 'pc-aaa111.scope',
      pids: [900, 901],
    });
    expect(r.foreign).toHaveLength(0);
  });

  it('attributes unmanaged residue in a nested child cgroup to its managed parent scope', () => {
    const nested = proc({
      pid: 902,
      cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice/pc-aaa111.scope/papercusp-deb-build-123.scope`,
    });
    const r = reconcile([], [nested], { now: NOW });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({ scopeUnit: 'pc-aaa111.scope', pids: [902] });
  });

  it('flags a bypass that is in our slice but NOT in any pc- scope', () => {
    // The literal "someone escaped the chokepoint" shape: it inherited our slice
    // (so the kernel still holds it) but no managedSpawn ever named it.
    const r = reconcile([], [proc({ pid: 902, cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice` })], {
      now: NOW,
    });
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]!.scopeUnit).toBeNull();
  });

  // ── EI-20185455308799001: the enrolment race ────────────────────────────────
  //
  // A managed `pc-*.scope` is minted BEFORE its fire-and-forget enrolment insert
  // commits. A tick landing inside that window sees a scope no live row claims.
  // Reporting it alarms on a process that is enrolling perfectly normally, which
  // is what made the alert recur after every "unaccounted=0" verification.
  //
  // These four cases are deliberately paired: the first says the grace WORKS, and
  // the other three say it is a grace and not a mute. Without the teeth cases,
  // this change would be indistinguishable from silencing the alarm.
  describe('enrolment-window grace', () => {
    const GRACE = 60_000;

    it('does NOT report a managed scope whose process is younger than the grace', () => {
      const young = proc({ pid: 910, startedAtMs: NOW - 5_000 });
      const r = reconcile([], [young], { now: NOW, graceMs: GRACE });
      expect(r.unaccounted).toHaveLength(0);
      // Recorded rather than dropped — "we saw it and it is too new to judge" is a
      // different statement from "we saw nothing".
      expect(r.tooYoung).toContain('aaa111');
    });

    it('TEETH: reports the SAME residue once it ages past the grace', () => {
      const old = proc({ pid: 910, startedAtMs: NOW - (GRACE + 1_000) });
      const r = reconcile([], [old], { now: NOW, graceMs: GRACE });
      expect(r.unaccounted).toHaveLength(1);
      expect(r.unaccounted[0]).toMatchObject({ scopeUnit: 'pc-aaa111.scope', pids: [910] });
      expect(r.tooYoung).not.toContain('aaa111');
    });

    it('TEETH: reports residue whose age is UNKNOWN — an alarm that cannot measure must not assume innocence', () => {
      const ageless = proc({ pid: 911, startedAtMs: null });
      const r = reconcile([], [ageless], { now: NOW, graceMs: GRACE });
      expect(r.unaccounted).toHaveLength(1);
      expect(r.unaccounted[0]!.pids).toEqual([911]);
    });

    it('TEETH: the grace covers the enrolment race ONLY — a brand-new escape with no managed scope still reports at once', () => {
      // No `pc-*` scope anywhere in the path: nothing ever minted a scope for this,
      // so there is no pending insert it could be waiting on. Youth is irrelevant.
      const escapee = proc({
        pid: 912,
        cgroupPath: `${OUR_SLICE}/papercusp-bash-job.slice`,
        startedAtMs: NOW - 1_000,
      });
      const r = reconcile([], [escapee], { now: NOW, graceMs: GRACE });
      expect(r.unaccounted).toHaveLength(1);
      expect(r.unaccounted[0]!.scopeUnit).toBeNull();
    });
  });

  it('separates FOREIGN (outside our slice) from unaccounted — visibility, not control', () => {
    const r = reconcile(
      [],
      [
        proc({
          pid: 903,
          owned: false,
          cgroupPath: '/user.slice/user-1000.slice/session-3.scope',
          cmdline: 'npm run dev',
        }),
      ],
      { now: NOW },
    );
    expect(r.unaccounted).toHaveLength(0);
    expect(r.foreign).toHaveLength(1);
    expect(r.foreign[0]!.sampleCmdline).toBe('npm run dev');
  });

  it('routes a dead-window process to abandonedWindow, NOT foreign (D-018)', () => {
    // The regression this guards: the residue split is an owned/scopeUnit
    // heuristic that never read `p.scope`. A `vte-spawn-*` process is neither
    // owned nor in a `pc-*.scope`, so the classifier's `abandoned-window` verdict
    // was silently overruled and the process filed as "someone else's, merely
    // displayed" — never persisted, never counted. Fixing only the scan's cmdline
    // filter would have left this second gap wide open.
    const vte =
      '/user.slice/user-1000.slice/user@1000.service/app.slice/app-org.gnome.Terminal.slice/vte-spawn-aaaa.scope';
    const r = reconcile(
      [],
      [
        proc({
          pid: 904,
          owned: false,
          cgroupPath: vte,
          scope: 'abandoned-window',
          exemptReason: null,
          cmdline: 'node stranded-eval.js',
        }),
      ],
      { now: NOW },
    );

    expect(r.abandonedWindow).toHaveLength(1);
    expect(r.abandonedWindow[0]!.sampleCmdline).toBe('node stranded-eval.js');
    expect(r.foreign).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(0);

    const s = summarizeReconcile(r);
    expect(s.abandonedWindow).toBe(1);
    expect(s.abandonedWindowPids).toBe(1);
    // It must NOT be laundered into the neighbouring counts.
    expect(s.foreign).toBe(0);
    expect(s.unaccounted).toBe(0);
  });

  it('still files an ordinary exempt/foreign process as foreign', () => {
    const r = reconcile(
      [],
      [
        proc({
          pid: 905,
          owned: false,
          cgroupPath: '/user.slice/user-1000.slice/session-9.scope',
          cmdline: 'vim',
        }),
      ],
      { now: NOW },
    );
    expect(r.abandonedWindow).toHaveLength(0);
    expect(r.foreign).toHaveLength(1);
  });

  it('does not report a claimed scope as residue', () => {
    const r = reconcile(
      [row({ taskId: 'aaa111', scopeUnit: 'pc-aaa111.scope' })],
      [proc({ pid: 100 })],
      { now: NOW },
    );
    expect(r.unaccounted).toHaveLength(0);
  });

  it('groups residue by cgroup path so one runaway subtree is ONE alarm', () => {
    const r = reconcile(
      [],
      [
        proc({ pid: 1, cgroupPath: `${OUR_SLICE}/a` }),
        proc({ pid: 2, cgroupPath: `${OUR_SLICE}/a` }),
        proc({ pid: 3, cgroupPath: `${OUR_SLICE}/b` }),
      ],
      { now: NOW },
    );
    expect(r.unaccounted.map((g) => g.pids)).toEqual([[1, 2], [3]]);
  });
});

describe('reconcile — endedUnobserved (D-018)', () => {
  it('routes an absent row to endedUnobserved when systemd confirms its scope was released', () => {
    const r = reconcile(
      [row({ taskId: 'nnn444', scopeUnit: 'pc-nnn444.scope' })],
      [],
      { now: NOW, releasedScopes: new Set(['pc-nnn444.scope']) },
    );
    expect(r.stranded).toHaveLength(0);
    expect(r.endedUnobserved).toHaveLength(1);
    expect(r.endedUnobserved[0]).toMatchObject({ taskId: 'nnn444' });
    expect(r.endedUnobserved[0]!.reason).toMatch(/systemd confirms scope pc-nnn444\.scope was released/);
  });

  it('keeps a scoped row unresolved when systemd has not confirmed release', () => {
    const r = reconcile(
      [row({ taskId: 'ooo555', scopeUnit: 'pc-ooo555.scope' })],
      [],
      { now: NOW, releasedScopes: new Set(['pc-someone-else.scope']) },
    );
    expect(r.endedUnobserved).toHaveLength(0);
    expect(r.stranded).toHaveLength(0);
    expect(r.unresolved).toEqual([{
      taskId: 'ooo555',
      reason: 'scope pc-ooo555.scope holds no processes — systemd has not confirmed scope pc-ooo555.scope was released',
    }]);
  });

  it('keeps a scoped row unresolved when the release probe is unavailable', () => {
    const r = reconcile([row({ taskId: 'ppp666', scopeUnit: 'pc-ppp666.scope' })], [], { now: NOW });
    expect(r.endedUnobserved).toHaveLength(0);
    expect(r.stranded).toHaveLength(0);
    expect(r.unresolved).toHaveLength(1);
  });

  it('a row with no scopeUnit at all always strands — releasedScopes cannot apply to it', () => {
    const r = reconcile(
      [row({ taskId: 'qqq777', confined: false, scopeUnit: null, processIdentity: null, pid: 88 })],
      [],
      // A scope-keyed set can never match a row that has no scope unit, so even a
      // maximally-generous releasedScopes must not divert it.
      { now: NOW, releasedScopes: new Set(['pc-qqq777.scope']) },
    );
    expect(r.endedUnobserved).toHaveLength(0);
    expect(r.stranded).toHaveLength(1);
    expect(r.stranded[0]!.taskId).toBe('qqq777');
  });

  it('summarizeReconcile counts unconfirmed scoped rows separately from terminal verdicts', () => {
    const r = reconcile(
      [
        row({ taskId: 'rrr888', scopeUnit: 'pc-rrr888.scope' }),
        row({ taskId: 'sss999', scopeUnit: 'pc-sss999.scope' }),
      ],
      [],
      { now: NOW, releasedScopes: new Set(['pc-rrr888.scope']) },
    );
    expect(summarizeReconcile(r)).toMatchObject({ stranded: 0, unresolved: 1, endedUnobserved: 1 });
  });
});

describe('reconcile — deadlines', () => {
  it('reports a live row past its deadline', () => {
    const r = reconcile(
      [
        row({
          taskId: 'kkk111',
          scopeUnit: 'pc-kkk111.scope',
          deadlineAt: new Date(NOW - 5_000).toISOString(),
        }),
      ],
      [proc({ pid: 10, cgroupPath: `${OUR_SLICE}/x/pc-kkk111.scope` })],
      { now: NOW },
    );
    expect(r.overdue).toEqual([
      { taskId: 'kkk111', deadlineAt: new Date(NOW - 5_000).toISOString(), overdueMs: 5_000 },
    ]);
  });

  it('does not report a deadline still in the future', () => {
    const r = reconcile(
      [
        row({
          taskId: 'lll222',
          scopeUnit: 'pc-lll222.scope',
          deadlineAt: new Date(NOW + 60_000).toISOString(),
        }),
      ],
      [proc({ pid: 10, cgroupPath: `${OUR_SLICE}/x/pc-lll222.scope` })],
      { now: NOW },
    );
    expect(r.overdue).toHaveLength(0);
  });
});

describe('summarizeReconcile', () => {
  it('counts residue by group AND by pid', () => {
    const r = reconcile(
      [row({ taskId: 'mmm333', scopeUnit: 'pc-mmm333.scope' })],
      [proc({ pid: 1, cgroupPath: `${OUR_SLICE}/a` }), proc({ pid: 2, cgroupPath: `${OUR_SLICE}/a` })],
      { now: NOW },
    );
    expect(summarizeReconcile(r)).toMatchObject({
      alive: 0,
      stranded: 0,
      unresolved: 1,
      unaccounted: 1,
      unaccountedPids: 2,
      foreign: 0,
    });
  });
});

/**
 * EI-20106565311448967 — a console scope can NEVER acquire a ledger row
 * (`spawnConsole` hardcodes `taskScope: null`), so counting it as `unaccounted`
 * produced an alarm that could never clear: 7 scopes / 14 processes on this box,
 * re-notified every 30 minutes.
 *
 * The falsifier that matters is the SECOND test, not the first. Reclassifying
 * consoles is only correct if it does not also silence `papercup-headless-*`,
 * which comes out of the same builder one argument apart and IS the real
 * un-enrolled gap the residue census exists to raise.
 */
describe('reconcile — console windows are accounted by the window, not the ledger', () => {
  const CONSOLE = `${OUR_SLICE}/papercusp-agent.slice/papercusp-agent-session.slice/papercup-console-gnome-terminal-665488-1786388175428.scope`;
  const OWNED_VTE =
    OUR_SLICE + '/papercusp-agent.slice/papercusp-agent-session.slice/vte-spawn-0e0e-4a4a.scope';

  it('files a papercup-console scope as consoleWindow, never as unaccounted', () => {
    const r = reconcile([], [proc({ pid: 1, cgroupPath: CONSOLE }), proc({ pid: 2, cgroupPath: CONSOLE })], {
      now: NOW,
    });

    expect(r.unaccounted).toHaveLength(0);
    expect(r.consoleWindow).toHaveLength(1);
    expect(r.consoleWindow[0]).toMatchObject({ cgroupPath: CONSOLE, pids: [1, 2] });
    // The count the 30-minute notifier fires on is zero, while the class stays visible.
    expect(summarizeReconcile(r)).toMatchObject({
      unaccounted: 0,
      unaccountedPids: 0,
      consoleWindow: 1,
      consoleWindowPids: 2,
    });
  });

  it('still reports an un-enrolled papercup-headless scope as unaccounted', () => {
    const headless = `${OUR_SLICE}/papercusp-bash.slice/papercup-headless-some-job-1786388175428.scope`;
    const r = reconcile([], [proc({ pid: 3, cgroupPath: headless })], { now: NOW });

    expect(r.consoleWindow).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({ scopeUnit: null });
    expect(summarizeReconcile(r)).toMatchObject({ unaccounted: 1, unaccountedPids: 1, consoleWindow: 0 });
  });

  it('files a live owned VTE window as consoleWindow', () => {
    const r = reconcile(
      [],
      [proc({ pid: 6, cgroupPath: OWNED_VTE, terminalWindowAlive: true })],
      { now: NOW },
    );

    expect(r.unaccounted).toHaveLength(0);
    expect(r.consoleWindow).toHaveLength(1);
    expect(r.consoleWindow[0]).toMatchObject({ cgroupPath: OWNED_VTE, pids: [6] });
  });

  it('files a closed owned VTE window as abandonedWindow', () => {
    const r = reconcile(
      [],
      [proc({ pid: 7, cgroupPath: OWNED_VTE, terminalWindowAlive: false })],
      { now: NOW },
    );

    expect(r.unaccounted).toHaveLength(0);
    expect(r.abandonedWindow).toHaveLength(1);
    expect(r.abandonedWindow[0]).toMatchObject({ cgroupPath: OWNED_VTE, pids: [7] });
  });

  it('keeps an owned VTE window unaccounted when terminal liveness is unknown', () => {
    const r = reconcile(
      [],
      [proc({ pid: 8, cgroupPath: OWNED_VTE, terminalWindowAlive: null })],
      { now: NOW },
    );

    expect(r.unaccounted).toHaveLength(1);
    expect(r.unaccounted[0]).toMatchObject({
      cgroupPath: OWNED_VTE,
      scopeUnit: 'vte-spawn-0e0e-4a4a.scope',
    });
    expect(r.consoleWindow).toHaveLength(0);
    expect(r.abandonedWindow).toHaveLength(0);
  });

  it('leaves a genuine in-slice escape in unaccounted', () => {
    const r = reconcile([], [proc({ pid: 4, cgroupPath: `${OUR_SLICE}/stray` })], { now: NOW });

    expect(r.consoleWindow).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(1);
  });
});

describe('reconcile — verifier scopes are systemd-supervised, not bypass residue', () => {
  const VERIFIER =
    `${OUR_SLICE}/papercusp-agent.slice/papercusp-agent-session.slice/` +
    'papercup-tauri-verify-90-3416089-tauri-1.scope';

  it('files the named verifier scope as verifierScope, never as unaccounted', () => {
    const r = reconcile(
      [],
      [proc({ pid: 10, cgroupPath: VERIFIER }), proc({ pid: 11, cgroupPath: VERIFIER })],
      { now: NOW },
    );

    expect(r.unaccounted).toHaveLength(0);
    expect(r.verifierScope).toHaveLength(1);
    expect(r.verifierScope[0]).toMatchObject({ cgroupPath: VERIFIER, pids: [10, 11] });
    expect(summarizeReconcile(r)).toMatchObject({
      unaccounted: 0,
      unaccountedPids: 0,
      verifierScope: 1,
      verifierScopePids: 2,
    });
  });

  it('keeps lookalike verifier scopes in unaccounted', () => {
    const lookalike = VERIFIER.replace('tauri-1.scope', 'shell.scope');
    const r = reconcile([], [proc({ pid: 12, cgroupPath: lookalike })], { now: NOW });

    expect(r.verifierScope).toHaveLength(0);
    expect(r.unaccounted).toHaveLength(1);
  });
});
