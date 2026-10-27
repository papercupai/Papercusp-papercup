/**
 * Tests for the acceptance-grading stall sweep's orchestrator.
 * plan: acceptance-grading-stall-sweep-2026-08-26 (P-002, P-003, extended by P-005)
 *
 * Everything here runs against fakes — the orchestrator takes all its side effects
 * through `AcceptanceGradingSweepDeps`, so no database is involved and the tests can
 * assert on things a live run could not easily prove: that a second tick mints
 * nothing, that a dead creator changes nothing about recovery, and that one
 * unreadable plan does not stop the sweep covering the ones behind it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTANCE_GRADING_SWEEP_MAX_SCAN_PER_TICK,
  acceptanceGradingEscalationBody,
  acceptanceGradingStallConditionKey,
  runAcceptanceGradingSweep,
  type AcceptanceGradingSweepDeps,
  type AcceptanceGradingSweepEvent,
  type ObservedPlanRow,
} from './acceptance-grading-sweep-run';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
afterEach(() => vi.useRealTimers());

it('bounds a never-settling observation and rotates past the attempted row on the next tick', async () => {
  vi.useFakeTimers();
  const gate = vi.fn(() => new Promise<{ satisfied: boolean }>(() => {}));
  const world = fakeDeps([row('slow', 5), row('later', 5)], { evaluateGate: gate });
  const pending = runAcceptanceGradingSweep(world.deps, { timeBudgetMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;
  expect(result.budgetExhausted).toBe(true);
  expect(result.scanned).toBe(1);
  expect(result.nextCursor?.planSlug).toBe('slow');
  expect(result.dispatched).toEqual([]);
  const visited: string[] = [];
  const next = fakeDeps([row('slow', 5), row('later', 5)], {
    evaluateGate: async slug => { visited.push(slug); return { satisfied: true }; },
  });
  await runAcceptanceGradingSweep(next.deps, { after: result.nextCursor });
  expect(visited).toEqual(['later', 'slow']);
});

const row = (slug: string, gradeableHoursAgo: number): ObservedPlanRow => ({
  workspaceId: 'ws',
  planSlug: slug,
  harnessSlug: 'papercusp',
  rubricRef: `acceptance-${slug}`,
  gradeableSinceMs: NOW - gradeableHoursAgo * HOUR,
});

/** A world where every plan is ungraded, no grader is alive, nothing is escalated. */
function fakeDeps(rows: ObservedPlanRow[], over: Partial<AcceptanceGradingSweepDeps> = {}) {
  const minted = new Map<string, string>();
  const deps: AcceptanceGradingSweepDeps = {
    listCandidates: async (limit, after) => {
      const cursor = after ? rows.findIndex(r => r.planSlug === after.planSlug && r.workspaceId === after.workspaceId && r.harnessSlug === after.harnessSlug) : -1;
      return (cursor < 0 ? rows : [...rows.slice(cursor + 1), ...rows.slice(0, cursor + 1)]).slice(0, limit);
    },
    evaluateGate: async () => ({ satisfied: false, code: 'acceptance_ungraded' }),
    observeGrader: async () => ({ live: false, lastDispatchMs: null }),
    escalationExists: async (slug) => minted.has(slug),
    dispatchGrader: async () => ({ ok: true, state: 'assigned' }),
    mintEscalation: async (r) => {
      // Faithful to upsertConditionWorkItem: the unique index means a second mint
      // for the same condition key adopts the incumbent instead of creating.
      const key = acceptanceGradingStallConditionKey(r.planSlug);
      if (minted.has(key)) return { id: minted.get(key)!, created: false };
      const id = `WI-${minted.size + 1000}`;
      minted.set(key, id);
      minted.set(r.planSlug, id);
      return { id, created: true };
    },
    now: () => NOW,
    ...over,
  };
  return { deps, minted };
}

describe('R1 — a stalled plan recovers with no human and no creator', () => {
  it('re-dispatches a grader for a plan stuck past the window', async () => {
    const { deps } = fakeDeps([row('stalled-plan', 5)]);
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual(['stalled-plan']);
    expect(out.failures).toEqual([]);
  });

  it('the creator being dead is not an input — recovery does not consult it', async () => {
    // The whole motivating case. The sweep has no dependency that could observe the
    // creator, so there is no code path by which a dead one prevents recovery. The
    // interface itself is the guarantee; this test pins that it stays that way.
    const { deps } = fakeDeps([row('creator-died', 5)]);
    expect(Object.keys(deps)).not.toContain('observeCreator');
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual(['creator-died']);
  });

  it('does nothing at all when nothing is stuck', async () => {
    const { deps } = fakeDeps([row('fine', 5)], {
      evaluateGate: async () => ({ satisfied: true }),
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual([]);
    expect(out.escalated).toEqual([]);
  });
});

describe('R2 — repeated ticks are safe', () => {
  it('does not dispatch while a grader is alive', async () => {
    const dispatchGrader = vi.fn(async () => ({ ok: true }));
    const { deps } = fakeDeps([row('busy', 50)], {
      observeGrader: async () => ({ live: true, lastDispatchMs: NOW - 40 * HOUR }),
      dispatchGrader,
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(dispatchGrader).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
  });

  it('ten consecutive ticks against a live grader dispatch nothing at all', async () => {
    const dispatchGrader = vi.fn(async () => ({ ok: true }));
    const { deps } = fakeDeps([row('busy', 50)], {
      observeGrader: async () => ({ live: true, lastDispatchMs: NOW - 40 * HOUR }),
      dispatchGrader,
    });
    for (let i = 0; i < 10; i++) await runAcceptanceGradingSweep(deps);
    expect(dispatchGrader).toHaveBeenCalledTimes(0);
  });
});

describe('R3 — a long stall reaches exactly one owner, once', () => {
  it('mints an escalation past the escalation window', async () => {
    const { deps } = fakeDeps([row('long-stall', 50)]);
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.escalated).toEqual(['long-stall']);
    expect(out.escalationsAlreadyOwned).toEqual([]);
  });

  it('THE SECOND TICK MINTS NOTHING — still exactly one owner', async () => {
    const { deps, minted } = fakeDeps([row('long-stall', 50)]);
    const first = await runAcceptanceGradingSweep(deps);
    expect(first.escalated).toEqual(['long-stall']);

    const second = await runAcceptanceGradingSweep(deps);
    // The decision core short-circuits on escalationExists, so the second tick does
    // not even reach the mint — the strongest form of the guarantee.
    expect(second.escalated).toEqual([]);
    expect(second.decisions[0]!.action).toBe('skip');
    expect(second.decisions[0]!.reason).toBe('already-escalated');

    const ids = [...minted.values()];
    expect(new Set(ids).size).toBe(1);
  });

  it('twenty ticks still leave exactly one work-item', async () => {
    const { deps, minted } = fakeDeps([row('long-stall', 50)]);
    for (let i = 0; i < 20; i++) await runAcceptanceGradingSweep(deps);
    expect(new Set([...minted.values()]).size).toBe(1);
  });

  it('even if the decision core were bypassed, the condition key still refuses a second mint', async () => {
    // Belt and braces: R3 must not rest solely on the in-memory guard. This drives
    // mintEscalation directly, the way a racing second host would.
    const { deps } = fakeDeps([row('p', 50)]);
    const r = row('p', 50);
    const a = await deps.mintEscalation(r, { planSlug: 'p', action: 'escalate', reason: 'stalled-past-escalation', stuckForMs: 50 * HOUR });
    const b = await deps.mintEscalation(r, { planSlug: 'p', action: 'escalate', reason: 'stalled-past-escalation', stuckForMs: 50 * HOUR });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it('the escalation body tells an owner what to actually do', async () => {
    const body = acceptanceGradingEscalationBody(row('p', 50), {
      planSlug: 'p',
      action: 'escalate',
      reason: 'stalled-past-escalation',
      stuckForMs: 50 * HOUR,
    });
    expect(body).toContain('NON-IMPLEMENTER');
    expect(body).toContain('50.0h');
    expect(body).toContain('condition-keyed');
  });

  it('condition keys are per-plan, so two stuck plans get their own owners', () => {
    expect(acceptanceGradingStallConditionKey('a')).not.toBe(acceptanceGradingStallConditionKey('b'));
    expect(acceptanceGradingStallConditionKey('a')).toBe('acceptance-grading-stall:a');
  });
});

describe('R4 — the sweep can only re-dispatch and escalate', () => {
  it('exposes no capability that could grade, score, or record a verdict', async () => {
    const { deps } = fakeDeps([row('p', 50)]);
    // The absence is the guarantee: a future edit cannot quietly start grading
    // without first widening this interface, which this assertion makes visible.
    for (const forbidden of ['emitScorecard', 'recordVerdict', 'grade', 'setPlanStatus', 'shipPlan']) {
      expect(Object.keys(deps)).not.toContain(forbidden);
    }
  });

  it('never touches a refusal it is not responsible for', async () => {
    const dispatchGrader = vi.fn(async () => ({ ok: true }));
    const mintEscalation = vi.fn(async () => ({ id: 'WI-1', created: true }));
    const { deps } = fakeDeps([row('unaudited', 99)], {
      evaluateGate: async () => ({ satisfied: false, code: 'acceptance_unaudited' }),
      dispatchGrader,
      mintEscalation,
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(dispatchGrader).not.toHaveBeenCalled();
    expect(mintEscalation).not.toHaveBeenCalled();
    expect(out.decisions[0]!.reason).toBe('not-a-grader-gap');
  });
});

describe('R5 — one tick is bounded', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`p-${String(i).padStart(3, '0')}`, 5 + i));

  it('caps the ACTIONS taken in a tick', async () => {
    const { deps } = fakeDeps(many(40));
    const out = await runAcceptanceGradingSweep(deps, { maxPerTick: 5 });
    expect(out.dispatched.length + out.escalated.length).toBe(5);
    expect(out.deferredByCap).toBe(35);
  });

  it('caps the SCAN as well, and says so', async () => {
    const { deps } = fakeDeps(many(300));
    const out = await runAcceptanceGradingSweep(deps, { maxScanPerTick: 10, maxPerTick: 100 });
    expect(out.scanned).toBe(10);
    expect(out.scanCapped).toBe(true);
  });

  it('does not report scanCapped when the corpus fits exactly', async () => {
    const { deps } = fakeDeps(many(10));
    const out = await runAcceptanceGradingSweep(deps, { maxScanPerTick: 10 });
    expect(out.scanned).toBe(10);
    expect(out.scanCapped).toBe(false);
  });

  it('eventually observes the entire population beyond the first page and wraps', async () => {
    const population = many(250);
    const visited: string[] = [];
    const { deps } = fakeDeps(population, {
      evaluateGate: async slug => { visited.push(slug); return { satisfied: true }; },
    });
    let after: ObservedPlanRow | null = null;
    for (let tick = 0; tick < 3; tick++) {
      const out = await runAcceptanceGradingSweep(deps, { maxScanPerTick: 100, after });
      expect(out.scanned).toBe(100);
      after = out.nextCursor;
    }
    expect(new Set(visited)).toEqual(new Set(population.map(r => r.planSlug)));
    expect(visited.slice(250)).toEqual(population.slice(0, 50).map(r => r.planSlug));
  });

  it('a zero scan budget observes nothing and asks the database for nothing', async () => {
    const listCandidates = vi.fn(async () => []);
    const { deps } = fakeDeps([], { listCandidates });
    const out = await runAcceptanceGradingSweep(deps, { maxScanPerTick: 0 });
    expect(listCandidates).not.toHaveBeenCalled();
    expect(out.scanned).toBe(0);
  });

  it('has a sane default scan ceiling', () => {
    expect(ACCEPTANCE_GRADING_SWEEP_MAX_SCAN_PER_TICK).toBeGreaterThan(0);
    expect(Number.isInteger(ACCEPTANCE_GRADING_SWEEP_MAX_SCAN_PER_TICK)).toBe(true);
  });
});

describe('partial failure never strands the plans behind it', () => {
  it('identifies a pending gate without releasing the tick or dispatching another grader', async () => {
    let finishGate!: (value: { satisfied: boolean; code: string }) => void;
    let now = NOW;
    const events: AcceptanceGradingSweepEvent[] = [];
    const dispatchGrader = vi.fn(async () => ({ ok: true }));
    const { deps } = fakeDeps([row('waiting', 5)], {
      evaluateGate: () => new Promise(resolve => { finishGate = resolve; }),
      dispatchGrader,
      now: () => now,
      onEvent: event => events.push(event),
    });
    const running = runAcceptanceGradingSweep(deps);
    await vi.waitFor(() => expect(events).toContainEqual({
      kind: 'observe-settled', planSlug: 'waiting', operation: 'grader', outcome: 'completed', durationMs: 0,
    }));
    expect(events).toContainEqual({ kind: 'observe-started', planSlug: 'waiting', operation: 'gate' });
    expect(events.some(event => event.kind === 'observe-settled' && event.operation === 'gate')).toBe(false);
    expect(dispatchGrader).not.toHaveBeenCalled();
    now += 90_000;
    finishGate({ satisfied: false, code: 'acceptance_ungraded' });
    expect((await running).dispatched).toEqual(['waiting']);
    expect(events).toContainEqual({
      kind: 'observe-settled', planSlug: 'waiting', operation: 'gate', outcome: 'completed', durationMs: 90_000,
    });
  });

  it('one unreadable plan is recorded and the rest still recover', async () => {
    const events: AcceptanceGradingSweepEvent[] = [];
    const { deps } = fakeDeps([row('bad', 5), row('good', 6)], {
      onEvent: event => events.push(event),
      evaluateGate: async (slug) => {
        if (slug === 'bad') throw new Error('gate read blew up');
        return { satisfied: false, code: 'acceptance_ungraded' };
      },
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual(['good']);
    expect(out.failures).toEqual([{ planSlug: 'bad', stage: 'observe', error: 'gate read blew up' }]);
    expect(events).toContainEqual({
      kind: 'observe-settled', planSlug: 'bad', operation: 'gate', outcome: 'failed', durationMs: 0,
    });
  });

  it('a failed dispatch is recorded, not swallowed, and not counted as success', async () => {
    const { deps } = fakeDeps([row('p', 5)], {
      dispatchGrader: async () => ({ ok: false, error: 'no grader could be resolved' }),
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual([]);
    expect(out.failures).toEqual([{ planSlug: 'p', stage: 'dispatch', error: 'no grader could be resolved' }]);
  });

  it('a throwing dispatch is caught and the tick still completes', async () => {
    const { deps } = fakeDeps([row('boom', 5), row('fine', 6)], {
      dispatchGrader: async (r) => {
        if (r.planSlug === 'boom') throw new Error('launch exploded');
        return { ok: true };
      },
    });
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.dispatched).toEqual(['fine']);
    expect(out.failures.map((f) => f.stage)).toEqual(['dispatch']);
  });

  it('a dispatch reporting not-ok without an error still records something legible', async () => {
    const { deps } = fakeDeps([row('p', 5)], { dispatchGrader: async () => ({ ok: false }) });
    const out = await runAcceptanceGradingSweep(deps);
    expect(out.failures[0]!.error).toMatch(/without an error/);
  });

  it('emits events a routine can log without re-deriving them', async () => {
    const events: unknown[] = [];
    const { deps } = fakeDeps([row('d', 5), row('e', 50)], { onEvent: (ev) => events.push(ev) });
    await runAcceptanceGradingSweep(deps);
    expect(events).toContainEqual({ kind: 'dispatched', planSlug: 'd', state: 'assigned' });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'escalated', planSlug: 'e', created: true }));
  });
});
