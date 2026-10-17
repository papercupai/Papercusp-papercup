/**
 * expensive-verification-loops-2026-09-29 R-2: a looping work item cannot start another
 * slow attempt without an audit that names every distinct failure fingerprint.
 */
import { describe, expect, it } from 'vitest';
import { SLOW_ATTEMPT_MIN_MS, type WorkItemAttempt } from './attempt-ledger';
import {
  loopLaunchRefusal,
  nudgeOnNewLoop,
  ATTEMPT_AUDIT_MARKER,
  LOOP_ATTEMPT_BUDGET_MS,
  checkLoopGate,
  evaluateLoop,
  type AttemptAuditNote,
} from './loop-gate';

const T0 = Date.parse('2026-09-29T10:00:00Z');
const min = (m: number) => new Date(T0 + m * 60_000).toISOString();

let seq = 0;
function attempt(
  startMin: number,
  endMin: number | null,
  outcome: WorkItemAttempt['outcome'],
  fingerprint: string | null = null,
): WorkItemAttempt {
  seq += 1;
  return {
    taskId: `t${seq}`,
    taskClass: 'bash-job',
    title: 'drill',
    startedAt: min(startMin),
    endedAt: endMin === null ? null : min(endMin),
    durationMs: endMin === null ? null : (endMin - startMin) * 60_000,
    outcome: endMin === null ? 'running' : outcome,
    fingerprint,
    label: fingerprint ? `label for ${fingerprint}` : null,
    source: fingerprint ? 'log' : null,
    commandFingerprint: 'cmd',
  };
}
const audit = (atMin: number, body: string): AttemptAuditNote => ({ postedAt: min(atMin), body });
const now = T0 + 24 * 60 * 60_000;

describe('evaluateLoop — the three triggers', () => {
  it('trips on two failures with distinct fingerprints', () => {
    const v = evaluateLoop([attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')], [], { now });
    expect(v.tripped).toBe(true);
    expect(v.triggers).toEqual(['distinct-failures']);
    expect(v.fingerprints.sort()).toEqual(['log:aaa', 'log:bbb']);
  });

  it('does not trip on two failures with the SAME fingerprint, and trips on the third', () => {
    const two = [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:aaa')];
    expect(evaluateLoop(two, [], { now }).tripped).toBe(false);
    const three = [...two, attempt(40, 50, 'fail', 'log:aaa')];
    expect(evaluateLoop(three, [], { now }).triggers).toEqual(['repeated-failure']);
  });

  it('trips when attempt time in the window reaches the budget, counting a running attempt', () => {
    const budgetMs = 60 * 60_000;
    const v = evaluateLoop([attempt(0, 50, 'cancelled'), attempt(60, null, 'running')], [], {
      now: T0 + 75 * 60_000,
      budgetMs,
    });
    expect(v.windowMs).toBe(65 * 60_000);
    expect(v.triggers).toEqual(['over-budget']);
    expect(v.windowFailures).toBe(0);
  });

  it('a passing attempt resets the window', () => {
    const v = evaluateLoop(
      [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'pass'), attempt(40, 50, 'fail', 'log:bbb')],
      [],
      { now },
    );
    expect(v.tripped).toBe(false);
    expect(v.windowStartedAt).toBe(min(30));
    expect(v.fingerprints).toEqual(['log:bbb']);
  });

  it('does not count a passing attempt with an error-log fingerprint as a failure', () => {
    const v = evaluateLoop(
      [attempt(0, 10, 'pass', 'log:permission-denied'), attempt(20, 30, 'fail', 'log:aaa')],
      [],
      { now },
    );
    expect(v.windowFailures).toBe(1);
    expect(v.fingerprints).toEqual(['log:aaa']);
    expect(v.tripped).toBe(false);
  });

  it('counts a failed attempt with no fingerprint under one explicit key', () => {
    const v = evaluateLoop([attempt(0, 10, 'fail'), attempt(20, 30, 'fail', 'log:aaa')], [], { now });
    expect(v.fingerprints.sort()).toEqual(['log:aaa', 'unfingerprinted']);
    expect(v.tripped).toBe(true);
  });

  it('does not count an unobserved attempt as a failure, even with an exit fingerprint', () => {
    const v = evaluateLoop(
      [attempt(0, 10, 'unknown', 'exit:66382fe07f8b'), attempt(20, 30, 'fail', 'log:aaa')],
      [],
      { now },
    );
    expect(v.windowFailures).toBe(1);
    expect(v.fingerprints).toEqual(['log:aaa']);
    expect(v.tripped).toBe(false);
  });

  it('uses a four-hour default budget', () => {
    expect(evaluateLoop([], [], { now }).budgetMs).toBe(LOOP_ATTEMPT_BUDGET_MS);
    expect(LOOP_ATTEMPT_BUDGET_MS).toBe(4 * 60 * 60_000);
  });
});

describe('evaluateLoop — the audit note', () => {
  const looping = () => [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')];

  it('a marked note naming every fingerprint clears the loop', () => {
    const v = evaluateLoop(looping(), [audit(35, `${ATTEMPT_AUDIT_MARKER} log:aaa is X; log:bbb is Y`)], { now });
    expect(v.tripped).toBe(false);
    expect(v.windowStartedAt).toBe(min(35));
    expect(v.incompleteAudit).toBeNull();
  });

  it('an audit that omits a fingerprint does not clear it, and says what it missed', () => {
    const v = evaluateLoop(looping(), [audit(35, `${ATTEMPT_AUDIT_MARKER} log:aaa is X`)], { now });
    expect(v.tripped).toBe(true);
    expect(v.incompleteAudit).toEqual({ postedAt: min(35), missing: ['log:bbb'] });
  });

  it('an unmarked comment naming every fingerprint is not an audit', () => {
    const v = evaluateLoop(looping(), [audit(35, 'log:aaa and log:bbb are both flakes')], { now });
    expect(v.tripped).toBe(true);
  });

  it('failures after a qualifying audit start a fresh count', () => {
    const v = evaluateLoop(
      [...looping(), attempt(40, 50, 'fail', 'log:ccc')],
      [audit(35, `${ATTEMPT_AUDIT_MARKER} log:aaa log:bbb`)],
      { now },
    );
    expect(v.tripped).toBe(false);
    expect(v.fingerprints).toEqual(['log:ccc']);
  });

  it('an audit posted before a failure does not cover it', () => {
    const v = evaluateLoop(looping(), [audit(15, `${ATTEMPT_AUDIT_MARKER} log:aaa log:bbb`)], { now });
    // The note at 15 cleared log:aaa; log:bbb ended at 30, after it. One failure left.
    expect(v.tripped).toBe(false);
    expect(v.fingerprints).toEqual(['log:bbb']);
  });
});

describe('checkLoopGate', () => {
  const looping = () => [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')];

  it('refuses the next slow attempt on a looping item, naming the fix', async () => {
    const d = await checkLoopGate(
      { workspaceId: 'ws', workItemId: 'WI-1' },
      { listAttempts: async () => looping(), readNotes: async () => [], now: () => now },
    );
    expect(d.allowed).toBe(false);
    if (d.allowed) return;
    expect(d.reason).toMatch(/^loop_audit_required — WI-1 is grinding/);
    expect(d.reason).toContain('log:aaa');
    expect(d.reason).toContain('log:bbb');
    expect(d.reason).toContain(ATTEMPT_AUDIT_MARKER);
  });

  it('allows once a qualifying audit is on the item', async () => {
    const d = await checkLoopGate(
      { workspaceId: 'ws', workItemId: 'WI-1' },
      {
        listAttempts: async () => looping(),
        readNotes: async () => [audit(35, `${ATTEMPT_AUDIT_MARKER} log:aaa log:bbb`)],
        now: () => now,
      },
    );
    expect(d.allowed).toBe(true);
  });

  it('fails open when the comments cannot be read, or there is no work item', async () => {
    const unreadable = await checkLoopGate(
      { workspaceId: 'ws', workItemId: 'WI-1' },
      { listAttempts: async () => looping(), readNotes: async () => null, now: () => now },
    );
    expect(unreadable).toMatchObject({ allowed: true, notesReadable: false });
    expect(await checkLoopGate({ workspaceId: 'ws', workItemId: null })).toMatchObject({ allowed: true });
  });

  it('fails open when the attempt ledger read throws', async () => {
    const d = await checkLoopGate(
      { workspaceId: 'ws', workItemId: 'WI-1' },
      {
        listAttempts: async () => {
          throw new Error('pg down');
        },
      },
    );
    expect(d.allowed).toBe(true);
  });
});

describe('nudgeOnNewLoop — tell the launcher once', () => {
  const setup = (attempts: WorkItemAttempt[], notes: AttemptAuditNote[] | null = []) => {
    const sent: Array<{ to: string; summary: string; body: string }> = [];
    return {
      sent,
      deps: {
        listAttempts: async () => attempts,
        readNotes: async () => notes,
        now: () => now,
        send: async (m: { to: string; summary: string; body: string }) => {
          sent.push(m);
        },
      },
    };
  };
  const base = { workspaceId: 'ws', workItemId: 'WI-1', ownerId: 'su-abc' };

  it('nudges when THIS attempt is the one that trips the rule', async () => {
    const first = attempt(0, 10, 'fail', 'log:aaa');
    const second = attempt(20, 30, 'fail', 'log:bbb');
    const s = setup([first, second]);
    expect(await nudgeOnNewLoop({ ...base, taskId: second.taskId }, s.deps)).toBe(true);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].to).toBe('su-abc');
    expect(s.sent[0].summary).toContain('WI-1 is grinding (distinct-failures)');
    expect(s.sent[0].body).toMatch(/^loop_audit_required — WI-1/);
  });

  it('stays silent when the loop had already tripped before this attempt', async () => {
    const a = [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')];
    const third = attempt(40, 50, 'fail', 'log:ccc');
    const s = setup([...a, third]);
    expect(await nudgeOnNewLoop({ ...base, taskId: third.taskId }, s.deps)).toBe(false);
    expect(s.sent).toHaveLength(0);
  });

  it('stays silent below the rule, for a non-agent owner, or when notes are unreadable', async () => {
    const first = attempt(0, 10, 'fail', 'log:aaa');
    expect(await nudgeOnNewLoop({ ...base, taskId: first.taskId }, setup([first]).deps)).toBe(false);
    const pair = [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')];
    const last = pair[1].taskId;
    for (const ownerId of ['capability:bash', 'unknown', null]) {
      const s = setup(pair);
      expect(await nudgeOnNewLoop({ ...base, ownerId, taskId: last }, s.deps)).toBe(false);
      expect(s.sent).toHaveLength(0);
    }
    const unreadable = setup(pair, null);
    expect(await nudgeOnNewLoop({ ...base, taskId: last }, unreadable.deps)).toBe(false);
  });
});

describe('loopLaunchRefusal — the launcher seam', () => {
  const looping = () => [attempt(0, 10, 'fail', 'log:aaa'), attempt(20, 30, 'fail', 'log:bbb')];
  const deps = () => {
    let reads = 0;
    return {
      reads: () => reads,
      deps: {
        listAttempts: async () => {
          reads += 1;
          return looping();
        },
        readNotes: async () => [],
        now: () => now,
      },
    };
  };

  it('refuses a background launch on a looping item with a JSON-ready payload', async () => {
    const d = deps();
    const r = await loopLaunchRefusal(
      { workspaceId: 'ws', workItemId: 'WI-1', background: true, timeoutMs: 1_000 },
      d.deps,
    );
    expect(r).toMatchObject({ ok: false, reason: 'loop_audit_required', work_item_id: 'WI-1' });
    expect(r?.fingerprints.sort()).toEqual(['log:aaa', 'log:bbb']);
    expect(r?.message).toMatch(/^loop_audit_required — WI-1/);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it('gates a foreground call only when its timeout lets it run past the slow threshold', async () => {
    const quick = deps();
    expect(
      await loopLaunchRefusal(
        { workspaceId: 'ws', workItemId: 'WI-1', background: false, timeoutMs: SLOW_ATTEMPT_MIN_MS },
        quick.deps,
      ),
    ).toBeNull();
    // A quick check is not even measured against the ledger.
    expect(quick.reads()).toBe(0);
    const long = deps();
    expect(
      await loopLaunchRefusal(
        { workspaceId: 'ws', workItemId: 'WI-1', background: false, timeoutMs: SLOW_ATTEMPT_MIN_MS + 1 },
        long.deps,
      ),
    ).not.toBeNull();
  });

  it('proceeds without a workspace or work item, without reading the ledger', async () => {
    const d = deps();
    expect(
      await loopLaunchRefusal({ workspaceId: 'ws', workItemId: null, background: true, timeoutMs: 1 }, d.deps),
    ).toBeNull();
    expect(
      await loopLaunchRefusal({ workspaceId: undefined, workItemId: 'WI-1', background: true, timeoutMs: 1 }, d.deps),
    ).toBeNull();
    expect(d.reads()).toBe(0);
  });
});
