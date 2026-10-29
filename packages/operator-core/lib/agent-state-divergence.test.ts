/**
 * Tests for P-010's intent↔action divergence detector.
 *
 * The seeded positives first, then — at equal length, deliberately — what is
 * NOT a divergence, because every false positive here is a notification sent to
 * an agent that did nothing wrong, and that is how a detector earns being muted.
 *
 * ⚠ This structure was shared with `agent-facts/conflicts.test.ts` (the P-011
 * sibling), which WI-6545 / D-103 deleted along with its detector. Worth knowing
 * WHY, because the shape alone did not save it: every one of its cases SEEDED the
 * contradiction it then detected, so the suite passed identically whether the
 * production corpus held 2,217 assumptions or none — and it held none. These tests
 * are only worth more than those because THIS detector's input (`tool_invocations`)
 * is written by every agent without opting in. Check that property, not the shape.
 */
import { describe, it, expect } from 'vitest';
import {
  detectIntentActionDivergence,
  deliverableKinds,
  digestArgs,
  explainZero,
  isFailureStatus,
  isStructuralZero,
  toolNamespace,
  DIVERGENCE_LIMIT,
  RETRY_THRASH_THRESHOLD,
  CONVERGENCE_SETTLE_MS,
  THRASH_WINDOW_MS,
  type DivergenceCall,
} from './agent-state-divergence';

const T0 = Date.parse('2026-07-27T12:00:00.000Z');

/** A call with sane defaults; every test overrides only what it is about. */
function call(over: Partial<DivergenceCall> & { id: number }): DivergenceCall {
  return {
    ownerId: 'su-a',
    toolName: 'work_items:claim',
    status: 'ok',
    invokedAt: new Date(T0 + over.id * 1000).toISOString(),
    ...over,
  };
}

describe('the stamped leg — goal drift inside one intent declaration', () => {
  it('flags two distinct goals under a single intent id', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2' }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('goal-drift-within-intent');
    expect(out.divergences[0].intentEventId).toBe(100);
    expect(out.divergences[0].a.goalRef).toBe('WI-1');
    expect(out.divergences[0].b.goalRef).toBe('WI-2');
    expect(out.structuralZero).toBeNull();
  });

  it('treats a changed successful scheduler claim as an implicit intent boundary', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'facts:list', intentEventId: 100, goalRef: 'WI-old' }),
      call({ id: 2, toolName: 'work_items:release', intentEventId: 100, goalRef: null }),
      call({ id: 3, toolName: 'scheduler:get_next', intentEventId: 100, goalRef: 'WI-new' }),
      call({ id: 4, toolName: 'facts:list', intentEventId: 100, goalRef: 'WI-new' }),
      call({ id: 5, toolName: 'facts:list', intentEventId: 101, goalRef: 'WI-new' }),
    ]);

    expect(out.divergences).toHaveLength(0);
  });

  it('keeps drift when a scheduler pull leaves the goal unchanged', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'facts:list', intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, toolName: 'scheduler:get_next', intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 3, toolName: 'work_items:claim', intentEventId: 100, goalRef: 'WI-2' }),
    ]);

    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0]).toMatchObject({
      kind: 'goal-drift-within-intent',
      a: { goalRef: 'WI-1' },
      b: { goalRef: 'WI-2' },
    });
  });

  it('suppresses an intentional multi-goal declaration when every goal is explicitly covered', () => {
    const declaredGoalRefs = ['WI-1', 'WI-2'];
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1', declaredGoalRefs }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', declaredGoalRefs }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(1);
    expect(out.structuralZero).toBe('agreement');
  });

  it('keeps multi-goal drift positive when the typed declaration covers only one goal', () => {
    const declaredGoalRefs = ['WI-1'];
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1', declaredGoalRefs }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', declaredGoalRefs }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('goal-drift-within-intent');
  });

  it('does not report a covered pair just because a third observed goal is undeclared', () => {
    const declaredGoalRefs = ['WI-1', 'WI-2'];
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1', declaredGoalRefs }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', declaredGoalRefs }),
      call({ id: 3, intentEventId: 100, goalRef: 'WI-3', declaredGoalRefs }),
    ]);

    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0]).toMatchObject({
      kind: 'goal-drift-within-intent',
      a: { goalRef: 'WI-1' },
      b: { goalRef: 'WI-3' },
    });
  });

  it('suppresses shared-goal drift when every declaration copy proves one plan lane', () => {
    const declaredPlanItems = ['P-016'];
    const out = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'WI-1',
        declaredPlanSlug: 'shared-plan',
        declaredPlanItems,
      }),
      call({
        id: 2,
        intentEventId: 100,
        goalRef: 'WI-2',
        declaredPlanSlug: 'shared-plan',
        declaredPlanItems,
      }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(1);
    expect(out.structuralZero).toBe('agreement');
  });

  it('keeps shared-lane drift positive when plan evidence is partial or mismatched', () => {
    const partial = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'WI-1',
        declaredPlanSlug: 'shared-plan',
        declaredPlanItems: ['P-016'],
      }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', declaredPlanSlug: 'shared-plan' }),
    ]);
    const mismatched = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'WI-1',
        declaredPlanSlug: 'shared-plan',
        declaredPlanItems: ['P-016'],
      }),
      call({
        id: 2,
        intentEventId: 100,
        goalRef: 'WI-2',
        declaredPlanSlug: 'other-plan',
        declaredPlanItems: ['P-016'],
      }),
    ]);
    expect(partial.divergences).toHaveLength(1);
    expect(mismatched.divergences).toHaveLength(1);
  });

  it('does not treat a fleet mission as an undeclarable competing goal', () => {
    const out = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'fleet:capless-inference-gateway-ship-2026-08-28',
      }),
      call({
        id: 2,
        intentEventId: 100,
        goalRef: 'WI-474673',
        declaredGoalRefs: ['WI-474673'],
      }),
    ]);

    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(0);
    expect(out.coverage.goalStampedCalls).toBe(2);
  });

  it('still detects divergence between two item-level goals in a fleet', () => {
    const out = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'fleet:capless-inference-gateway-ship-2026-08-28',
      }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 3, intentEventId: 100, goalRef: 'WI-2' }),
    ]);

    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0]).toMatchObject({
      kind: 'goal-drift-within-intent',
      a: { goalRef: 'WI-1' },
      b: { goalRef: 'WI-2' },
    });
    expect(out.coverage.comparableBuckets).toBe(1);
  });

  it('reports THREE goals as two findings against the first, not n squared', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2' }),
      call({ id: 3, intentEventId: 100, goalRef: 'WI-3' }),
    ]);
    expect(out.divergences).toHaveLength(2);
    expect(out.divergences.every((d) => d.a.goalRef === 'WI-1')).toBe(true);
  });

  it('never crosses owners, even on the same intent id', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, ownerId: 'su-a', intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, ownerId: 'su-b', intentEventId: 100, goalRef: 'WI-2' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('uses an explicit primary checkpoint target when the aggregate goal stamp names a held dependency', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'coord:glance', intentEventId: 100, goalRef: 'WI-primary' }),
      call({
        id: 2,
        toolName: 'work_items:checkpoint',
        intentEventId: 100,
        goalRef: 'EI-dependency',
        args: { items: [{ id: 'WI-primary', append: true, checkpoint: 'evidence' }] },
      }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(1);
  });

  it('still flags an explicit checkpoint that actually targets the secondary goal', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'coord:glance', intentEventId: 100, goalRef: 'WI-primary' }),
      call({
        id: 2,
        toolName: 'work_items:checkpoint',
        intentEventId: 100,
        goalRef: 'WI-primary',
        args: { items: [{ id: 'EI-dependency', append: true, checkpoint: 'evidence' }] },
      }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].b.goalRef).toBe('EI-dependency');
  });
});

describe('what is deliberately NOT a divergence', () => {
  it('several intent ids under ONE goal — the normal re-declare-on-wake shape', () => {
    // agent-state-stamp.ts: an agent re-declares intent on every wake via
    // coord:orient while holding the same claim throughout. Flagging this would
    // fire on every long-running agent, every wake.
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 101, goalRef: 'WI-1' }),
      call({ id: 3, intentEventId: 102, goalRef: 'WI-1' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a goal ref going null — that is a deliberate clear on release', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: null }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a ONE-OFF failure the agent then fixed — self-correction, not divergence', () => {
    // 456 of 601 real failure groups in 24h are exactly this shape.
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'invalid-input', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 2 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.failuresSeen).toBe(1);
  });

  it('TWO failures — still inside normal correction', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'invalid-input', args: { a: 1 } }),
      call({ id: 2, status: 'invalid-input', args: { a: 2 } }),
      call({ id: 3, status: 'ok', args: { a: 3 } }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.thrashRuns).toBe(0);
  });

  it('failures spread across DIFFERENT tools are a bad minute, not a flail', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'error' }),
      call({ id: 2, toolName: 'plans:get', status: 'error' }),
      call({ id: 3, toolName: 'facts:assert', status: 'error' }),
    ]);
    expect(out.divergences).toHaveLength(0);
  });

  it('a successful call is never counted as a failure', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'work_items:claim', status: 'ok' }),
      call({ id: 2, toolName: 'work_items:list' }),
    ]);
    expect(out.coverage.failuresSeen).toBe(0);
  });
});

describe('the sampling leg — live without any stamp', () => {
  /** N failures of one tool, `gapMs` apart, with optionally-varying args. */
  function flail(n: number, opts: { gapMs?: number; sameArgs?: boolean } = {}): DivergenceCall[] {
    const gap = opts.gapMs ?? 1000;
    return Array.from({ length: n }, (_, i) =>
      call({
        id: i + 1,
        toolName: 'work_items:claim',
        status: 'invalid-input',
        invokedAt: new Date(T0 + i * gap).toISOString(),
        args: opts.sameArgs ? { a: 1 } : { a: i },
      }),
    );
  }

  it('reconciles timeout and refusal envelopes when the launch transaction opened members', () => {
    const launchOutcome = {
      fleet: 'fleet-a',
      transactionId: 'tx-1',
      state: 'partial',
      openedMemberIds: ['member-1'],
      verifiedMemberIds: [],
      failedOwnerIds: ['member-2'],
    };
    const out = detectIntentActionDivergence([
      call({ id: 1, toolName: 'fleet:launch-on-plan', status: 'timeout', launchOutcome }),
      call({ id: 2, toolName: 'fleet:launch-on-plan', status: 'refused', launchOutcome }),
      call({ id: 3, toolName: 'fleet:launch-on-plan', status: 'refused' }),
      call({ id: 4, toolName: 'fleet:launch-on-plan', status: 'refused' }),
    ]);

    expect(out.divergences).toEqual([]);
    expect(out.coverage.failuresSeen).toBe(4);
    expect(out.coverage.launchOutcomeCalls).toBe(2);
    expect(out.coverage.launchFailuresReconciled).toBe(2);
  });

  it('flags an unconverged run at exactly the threshold', () => {
    const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD));
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('unconverged-retry-loop');
    expect(out.divergences[0].retryLoop?.attempts).toBe(RETRY_THRASH_THRESHOLD);
    expect(out.coverage.thrashRuns).toBe(1);
  });

  it('does NOT flag one attempt below the threshold', () => {
    const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD - 1));
    expect(out.divergences).toHaveLength(0);
  });

  // ── EI-18824142520274965: "without converging" must be OBSERVABLE ──────────
  //
  // The detector used to filter to failures before grouping, which discarded the
  // only rows that could ever disprove its own verdict — so it asserted a
  // negative it structurally could not see, and paged agents whose very next
  // call had succeeded. Live case: 3 rejections for an undocumented 5000-char
  // limit (7884 → 5357 → 5098 chars — each attempt strictly closer), then
  // success. That is textbook self-correction, reported as a flail.
  describe('a run the agent RECOVERED from is not a flail', () => {
    /** A success of the same tool, `afterMs` after T0. */
    const ok = (id: number, afterMs: number): DivergenceCall =>
      call({
        id,
        toolName: 'work_items:claim',
        status: 'ok',
        invokedAt: new Date(T0 + afterMs).toISOString(),
        args: { a: id },
      });

    it('suppresses a threshold run that ends in a success on the same tool', () => {
      const out = detectIntentActionDivergence([...flail(RETRY_THRASH_THRESHOLD), ok(99, 5_000)]);
      expect(out.divergences).toHaveLength(0);
      // Still COUNTED — the suppression is measurable, not invisible.
      expect(out.coverage.thrashRuns).toBe(1);
      expect(out.coverage.convergedRuns).toBe(1);
    });

    it('still flags a run with no success after it', () => {
      const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD));
      expect(out.divergences).toHaveLength(1);
      expect(out.coverage.convergedRuns).toBe(0);
    });

    it('a success SPLITS the timeline instead of merging two episodes into one flail', () => {
      // fail,fail,ok,fail,fail — converged twice, and neither half reaches the
      // threshold. The old code merged all four failures into a single
      // "4× without converging".
      const out = detectIntentActionDivergence([
        ...flail(2),
        ok(50, 3_000),
        call({
          id: 60,
          toolName: 'work_items:claim',
          status: 'invalid-input',
          invokedAt: new Date(T0 + 4_000).toISOString(),
          args: { a: 6 },
        }),
        call({
          id: 61,
          toolName: 'work_items:claim',
          status: 'invalid-input',
          invokedAt: new Date(T0 + 5_000).toISOString(),
          args: { a: 7 },
        }),
      ]);
      expect(out.divergences).toHaveLength(0);
    });

    it("a success on a DIFFERENT tool does not excuse this tool's flail", () => {
      const out = detectIntentActionDivergence([
        ...flail(RETRY_THRASH_THRESHOLD),
        call({ id: 98, toolName: 'plans:get', status: 'ok', invokedAt: new Date(T0 + 5_000).toISOString(), args: {} }),
      ]);
      expect(out.divergences).toHaveLength(1);
    });

    it('an UNKNOWN status neither converges a run nor breaks it — no signal from a gap', () => {
      const out = detectIntentActionDivergence([
        ...flail(RETRY_THRASH_THRESHOLD),
        call({
          id: 97,
          toolName: 'work_items:claim',
          status: null,
          invokedAt: new Date(T0 + 5_000).toISOString(),
          args: {},
        }),
      ]);
      expect(out.divergences).toHaveLength(1);
      expect(out.coverage.convergedRuns).toBe(0);
    });
  });

  describe('the settle window — do not judge a run that may still be mid-correction', () => {
    it('defers a run whose last failure is newer than CONVERGENCE_SETTLE_MS', () => {
      const calls = flail(RETRY_THRASH_THRESHOLD);
      const lastAt = Date.parse(calls[calls.length - 1].invokedAt);
      const out = detectIntentActionDivergence(calls, { now: lastAt + CONVERGENCE_SETTLE_MS - 1 });
      expect(out.divergences).toHaveLength(0);
      expect(out.coverage.unsettledRuns).toBe(1);
    });

    it('reports it once the run has settled', () => {
      const calls = flail(RETRY_THRASH_THRESHOLD);
      const lastAt = Date.parse(calls[calls.length - 1].invokedAt);
      const out = detectIntentActionDivergence(calls, { now: lastAt + CONVERGENCE_SETTLE_MS });
      expect(out.divergences).toHaveLength(1);
      expect(out.coverage.unsettledRuns).toBe(0);
    });

    it('without a clock the settle rule does not apply — the detector reads no hidden time', () => {
      const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD));
      expect(out.divergences).toHaveLength(1);
      expect(out.coverage.unsettledRuns).toBe(0);
    });
  });

  it('fires with a ZERO stamp fill rate — the state of the fleet today', () => {
    const out = detectIntentActionDivergence(flail(3));
    expect(out.coverage.stampFillRate).toBe(0);
    expect(out.divergences).toHaveLength(1);
  });

  it("counts changed-args transitions — P-010's first named trigger, as evidence", () => {
    const out = detectIntentActionDivergence(flail(3));
    expect(out.divergences[0].retryLoop?.argsChangedTransitions).toBe(2);
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(0);
  });

  it('calls out IDENTICAL retries, which cannot succeed for a deterministic refusal', () => {
    const out = detectIntentActionDivergence(flail(3, { sameArgs: true }));
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(2);
    expect(out.divergences[0].detail).toContain('IDENTICAL args');
  });

  it('suppresses explicitly marked dispatch-wrapper failures from retry sampling', () => {
    const out = detectIntentActionDivergence(
      flail(RETRY_THRASH_THRESHOLD).map((c) => ({
        ...c,
        metadataJson: { dispatchWrapper: true, effectiveStatus: 'error', childFailureCount: 1 },
      })),
    );
    expect(out.divergences).toEqual([]);
    expect(out.coverage.failuresSeen).toBe(0);
    expect(out.coverage.thrashRuns).toBe(0);
  });

  it('uses successful code:run wrappers to break an interleaved auth-failure run', () => {
    const authFailure = (id: number, afterMs: number): DivergenceCall =>
      call({
        id,
        toolName: 'code:run',
        status: 'error',
        invokedAt: new Date(T0 + afterMs).toISOString(),
      });
    const successfulWrapper = (id: number, afterMs: number): DivergenceCall =>
      call({
        id,
        toolName: 'code:run',
        status: 'ok',
        invokedAt: new Date(T0 + afterMs).toISOString(),
        metadataJson: { dispatchWrapper: true, effectiveStatus: 'ok', childFailureCount: 0 },
      });

    const firstFailures = [authFailure(1, 1_000), authFailure(2, 2_000), authFailure(3, 3_000)];
    const secondFailures = [authFailure(5, 5_000), authFailure(6, 6_000), authFailure(7, 7_000)];
    const out = detectIntentActionDivergence([
      ...firstFailures,
      successfulWrapper(4, 4_000),
      ...secondFailures,
      successfulWrapper(8, 8_000),
    ]);
    const withoutBoundaries = detectIntentActionDivergence([...firstFailures, ...secondFailures]);

    expect(out.divergences).toEqual([]);
    expect(out.coverage.failuresSeen).toBe(6);
    expect(out.coverage.thrashRuns).toBe(2);
    expect(out.coverage.convergedRuns).toBe(2);
    expect(withoutBoundaries.divergences).toHaveLength(1);
    expect(withoutBoundaries.divergences[0].retryLoop?.attempts).toBe(6);
  });

  it('retains direct invalid-input failures as retry evidence', () => {
    const out = detectIntentActionDivergence(flail(RETRY_THRASH_THRESHOLD));
    expect(out.divergences).toHaveLength(1);
    expect(out.coverage.failuresSeen).toBe(RETRY_THRASH_THRESHOLD);
    expect(out.coverage.thrashRuns).toBe(1);
  });

  it('keeps marked dispatch-wrapper rows in the stamped goal-drift leg', () => {
    const out = detectIntentActionDivergence([
      call({
        id: 1,
        intentEventId: 100,
        goalRef: 'WI-1',
        metadataJson: { dispatchWrapper: true },
      }),
      call({
        id: 2,
        intentEventId: 100,
        goalRef: 'WI-2',
        metadataJson: { dispatchWrapper: true },
      }),
    ]);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].kind).toBe('goal-drift-within-intent');
    expect(out.coverage.stampedCalls).toBe(2);
    expect(out.coverage.goalStampedCalls).toBe(2);
  });

  it('records a same-namespace fallback inside the run — the second named trigger', () => {
    const calls = flail(3);
    calls.splice(
      1,
      0,
      call({ id: 50, toolName: 'work_items:claim_next', invokedAt: new Date(T0 + 500).toISOString() }),
    );
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences[0].retryLoop?.fallbackObserved).toBe(true);
    expect(out.divergences[0].detail).toContain('fallback');
  });

  it('does not treat a different NAMESPACE as a fallback', () => {
    const calls = flail(3);
    calls.splice(1, 0, call({ id: 50, toolName: 'plans:get', invokedAt: new Date(T0 + 500).toISOString() }));
    expect(detectIntentActionDivergence(calls).divergences[0].retryLoop?.fallbackObserved).toBe(false);
  });

  it('splits runs that straddle THRASH_WINDOW_MS rather than merging them', () => {
    // Two failures, a long gap, then two more: neither side reaches 3.
    const calls = [
      ...flail(2),
      call({
        id: 10,
        toolName: 'work_items:claim',
        status: 'invalid-input',
        invokedAt: new Date(T0 + THRASH_WINDOW_MS + 1).toISOString(),
        args: { a: 9 },
      }),
      call({
        id: 11,
        toolName: 'work_items:claim',
        status: 'invalid-input',
        invokedAt: new Date(T0 + THRASH_WINDOW_MS + 2000).toISOString(),
        args: { a: 10 },
      }),
    ];
    expect(detectIntentActionDivergence(calls).divergences).toHaveLength(0);
  });

  it('never merges two owners into one run', () => {
    const calls = [
      ...flail(2),
      call({ id: 20, ownerId: 'su-b', toolName: 'work_items:claim', status: 'invalid-input', args: { a: 7 } }),
    ];
    expect(detectIntentActionDivergence(calls).divergences).toHaveLength(0);
  });

  it('treats each failure status as a failure, including role-not-allowed', () => {
    for (const s of ['error', 'invalid-input', 'timeout', 'refused', 'denied', 'role-not-allowed']) {
      expect(isFailureStatus(s)).toBe(true);
    }
    expect(isFailureStatus('ok')).toBe(false);
    expect(isFailureStatus(null)).toBe(false);
  });

  it('does not invent changed-args evidence when args were never supplied', () => {
    const calls = Array.from({ length: 3 }, (_, i) =>
      call({
        id: i + 1,
        toolName: 'work_items:claim',
        status: 'error',
        invokedAt: new Date(T0 + i * 1000).toISOString(),
      }),
    );
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences).toHaveLength(1);
    expect(out.divergences[0].retryLoop?.argsChangedTransitions).toBe(0);
    expect(out.divergences[0].retryLoop?.identicalRetries).toBe(0);
  });
});

describe('coverage says WHICH zero it is', () => {
  it('no calls at all', () => {
    const out = detectIntentActionDivergence([]);
    expect(out.structuralZero).toBe('no-calls');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
  });

  it('calls exist but nothing stamped and nothing failed — nothing was compared', () => {
    const out = detectIntentActionDivergence([call({ id: 1 }), call({ id: 2 })]);
    expect(out.structuralZero).toBe('nothing-comparable');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    expect(out.coverage.stampFillRate).toBe(0);
  });

  it('sampling ran, stamped legs could not — a PARTIAL answer, not a clean bill', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 1 } }),
    ]);
    expect(out.structuralZero).toBe('stamped-legs-empty');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    expect(explainZero('stamped-legs-empty')).toContain('stampFillRate is 0');
  });

  it('a healthy single-goal agent reports REAL agreement, not a structural zero', () => {
    // The regression this guards: counting only DIVERGENT buckets as comparable
    // would report a clean agent as "nothing examined".
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-1' }),
    ]);
    expect(out.divergences).toHaveLength(0);
    expect(out.coverage.comparableBuckets).toBe(1);
    expect(out.structuralZero).toBe('agreement');
    expect(isStructuralZero(out.structuralZero)).toBe(false);
  });

  it('reports the stamp fill rate as the P-015 measurement', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2 }),
      call({ id: 3 }),
      call({ id: 4 }),
    ]);
    expect(out.coverage.stampFillRate).toBe(0.25);
    expect(out.coverage.stampedCalls).toBe(1);
    expect(out.coverage.callsExamined).toBe(4);
  });

  it('every zero reason has an explanation', () => {
    for (const r of ['no-calls', 'nothing-comparable', 'stamped-legs-empty', 'agreement'] as const) {
      expect(explainZero(r).length).toBeGreaterThan(20);
    }
  });
});

describe('deliverableKinds — the per-leg notification gate', () => {
  it('offers nothing when neither leg ran', () => {
    const out = detectIntentActionDivergence([call({ id: 1 })]);
    expect(deliverableKinds(out.coverage)).toEqual([]);
  });

  it('offers ONLY the sampling kind while the stamp is undeployed', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, status: 'error', args: { a: 1 } }),
      call({ id: 2, status: 'ok', args: { a: 2 } }),
    ]);
    expect(deliverableKinds(out.coverage)).toEqual(['unconverged-retry-loop']);
  });

  it('adds the stamped kind once stamped calls appear', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1', status: 'error', args: { a: 1 } }),
      call({ id: 2, intentEventId: 100, goalRef: 'WI-2', status: 'ok', args: { a: 2 } }),
    ]);
    expect(deliverableKinds(out.coverage)).toContain('goal-drift-within-intent');
  });
});

describe('helpers', () => {
  it('toolNamespace splits on the first colon only', () => {
    expect(toolNamespace('work_items:claim')).toBe('work_items');
    expect(toolNamespace('gitnexus.query')).toBe('');
    expect(toolNamespace(':leading')).toBe('');
  });

  it('digestArgs returns null for absent, and is stable for objects', () => {
    expect(digestArgs(undefined)).toBeNull();
    expect(digestArgs({ a: 1, b: 2 })).toBe(digestArgs({ b: 2, a: 1 }));
    expect(digestArgs({ a: 1 })).not.toBe(digestArgs({ a: 2 }));
  });

  it('digestArgs survives a cycle instead of throwing inside a detector', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(digestArgs(cyclic)).toBeNull();
  });
});

describe('bounds and determinism', () => {
  it('caps findings at DIVERGENCE_LIMIT but keeps counts complete', () => {
    const runs = DIVERGENCE_LIMIT + 10;
    const calls: DivergenceCall[] = [];
    for (let i = 0; i < runs; i += 1) {
      for (let k = 0; k < RETRY_THRASH_THRESHOLD; k += 1) {
        calls.push(
          call({
            id: i * 10 + k,
            ownerId: `su-${i}`,
            toolName: 'work_items:claim',
            status: 'error',
            invokedAt: new Date(T0 + k * 1000).toISOString(),
            args: { a: k },
          }),
        );
      }
    }
    const out = detectIntentActionDivergence(calls);
    expect(out.divergences).toHaveLength(DIVERGENCE_LIMIT);
    expect(out.truncated).toBe(true);
    // Counts stay COMPLETE even though the list was cut.
    expect(out.coverage.thrashRuns).toBe(runs);
    expect(out.coverage.failuresSeen).toBe(runs * RETRY_THRASH_THRESHOLD);
  });

  it('is deterministic and order-independent', () => {
    const calls = [
      call({ id: 3, intentEventId: 100, goalRef: 'WI-2' }),
      call({ id: 1, intentEventId: 100, goalRef: 'WI-1' }),
      call({ id: 2, toolName: 'work_items:claim', status: 'error' }),
    ];
    const a = detectIntentActionDivergence(calls);
    const b = detectIntentActionDivergence([...calls].reverse());
    expect(a).toEqual(b);
  });

  it('tolerates an unparseable timestamp without throwing', () => {
    const out = detectIntentActionDivergence([
      call({ id: 1, invokedAt: 'not-a-date', status: 'error' }),
      call({ id: 2, invokedAt: 'also-not-a-date' }),
    ]);
    expect(out.coverage.callsExamined).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P-010 — the TERMINAL-GOAL filter (EI-18830083673617307)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The live defect this filter exists for, reproduced from the real report.
 *
 * `intent-divergence-detector` paged an agent that its "declared intent spans two
 * goals (EI-18822892068318552 and EI-18828567391761902)" — and BOTH were already
 * `done` with committed completion authority when the alert fired (re-verified
 * against `harness_shared.work_items` on 2026-07-27: status `done` for each). The
 * verdict was not wrong about the goal refs; it was computed against work that no
 * longer existed, so there was no re-declaration the recipient could make that
 * would reconcile it. Unactionable by construction.
 *
 * ⚠ ORDERED PROVE-CAPABLE FIRST. "No finding" is the output of a working filter AND
 * of a detector that stopped detecting, so the live pair is asserted to FIRE before
 * any silence is asserted. Every case below reuses the same two calls and varies
 * only the terminal set — so a leg that quietly stopped comparing reddens the first
 * case instead of passing all the rest.
 */
describe('P-010 — goals that are already terminal are not compared', () => {
  const DONE_A = 'EI-18822892068318552';
  const DONE_B = 'EI-18828567391761902';
  const drifting: DivergenceCall[] = [
    call({ id: 1, intentEventId: 77, goalRef: DONE_A }),
    call({ id: 2, intentEventId: 77, goalRef: DONE_B }),
  ];

  it('CAPABILITY: the same pair DOES fire when both goals are live', () => {
    const out = detectIntentActionDivergence(drifting, { terminalGoalRefs: new Set() });
    expect(out.divergences.map((d) => d.kind)).toEqual(['goal-drift-within-intent']);
    expect(out.coverage.comparableBuckets).toBe(1);
    expect(out.coverage.terminalFilterApplied).toBe(true);
    expect(out.coverage.terminalGoalCallsExcluded).toBe(0);
  });

  it('the real case: both goals terminal ⇒ no finding', () => {
    const out = detectIntentActionDivergence(drifting, {
      terminalGoalRefs: new Set([DONE_A, DONE_B]),
    });
    expect(out.divergences).toEqual([]);
    expect(out.coverage.terminalGoalCallsExcluded).toBe(2);
    expect(out.coverage.bucketsCollapsedByTerminal).toBe(1);
  });

  it('...and reports it as a STRUCTURAL zero naming the real cause, not agreement', () => {
    const out = detectIntentActionDivergence(drifting, {
      terminalGoalRefs: new Set([DONE_A, DONE_B]),
    });
    expect(out.structuralZero).toBe('all-goals-terminal');
    expect(isStructuralZero(out.structuralZero)).toBe(true);
    // The two wrong answers this reason exists to displace: `agreement` would claim
    // a live pair was compared and agreed; `stamped-legs-empty` would blame a
    // missing stamp and send the reader to fix P-009 instead of looking at goal
    // state. Both are confidently wrong rather than merely unhelpful.
    expect(out.structuralZero).not.toBe('agreement');
    expect(out.structuralZero).not.toBe('stamped-legs-empty');
    expect(explainZero(out.structuralZero!)).toMatch(/already CLOSED/);
  });

  it('one terminal + one live collapses the bucket — a pair needs two LIVE goals', () => {
    const out = detectIntentActionDivergence(drifting, { terminalGoalRefs: new Set([DONE_A]) });
    expect(out.divergences).toEqual([]);
    expect(out.coverage.terminalGoalCallsExcluded).toBe(1);
    expect(out.coverage.bucketsCollapsedByTerminal).toBe(1);
  });

  it('a live pair still fires even when OTHER goals in the window are terminal', () => {
    const out = detectIntentActionDivergence(
      [
        ...drifting,
        call({ id: 3, ownerId: 'su-b', intentEventId: 88, goalRef: 'WI-live-1' }),
        call({ id: 4, ownerId: 'su-b', intentEventId: 88, goalRef: 'WI-live-2' }),
      ],
      { terminalGoalRefs: new Set([DONE_A, DONE_B]) },
    );
    expect(out.divergences.map((d) => d.ownerId)).toEqual(['su-b']);
    expect(out.coverage.bucketsCollapsedByTerminal).toBe(1);
    expect(out.coverage.comparableBuckets).toBe(1);
  });

  /**
   * ⚠ OMITTED ≠ EMPTY, and this is the assertion that keeps the fix honest.
   * `terminalGoalCallsExcluded: 0` is produced BOTH by "the filter ran and every
   * goal was live" and by "no filter ran at all" — opposite states, one clean and
   * one the bug. Only `terminalFilterApplied` separates them, so a caller that
   * forgets to pass the set stays visible in coverage rather than silently
   * reverting to the pre-P-010 behaviour.
   */
  it('records that NO filter ran when the set is omitted — not that nothing was excluded', () => {
    const unfiltered = detectIntentActionDivergence(drifting);
    expect(unfiltered.coverage.terminalFilterApplied).toBe(false);
    expect(unfiltered.coverage.terminalGoalCallsExcluded).toBe(0);
    // Back-compat: omitting the set preserves the old behaviour exactly.
    expect(unfiltered.divergences.map((d) => d.kind)).toEqual(['goal-drift-within-intent']);

    const filtered = detectIntentActionDivergence(drifting, { terminalGoalRefs: new Set() });
    expect(filtered.coverage.terminalFilterApplied).toBe(true);
    // Identical counter, opposite meaning — which is exactly why the boolean exists.
    expect(filtered.coverage.terminalGoalCallsExcluded).toBe(
      unfiltered.coverage.terminalGoalCallsExcluded,
    );
  });

  it('the goal leg is not deliverable once every bucket collapsed', () => {
    const out = detectIntentActionDivergence(drifting, {
      terminalGoalRefs: new Set([DONE_A, DONE_B]),
    });
    expect(deliverableKinds(out.coverage)).not.toContain('goal-drift-within-intent');
  });
});
