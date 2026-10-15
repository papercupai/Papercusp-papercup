/**
 * Flow-metric computation (learning-system-audit-improvements-2026-06-09 P-041)
 * — pure over injected candidate + watchdog-tick rows, no PG. The Learning tab's
 * flow strip ("captured vs resolved 7d", median open age, watchdog liveness)
 * renders exactly these numbers, so window edges + the resolved-time
 * approximation (updated_at on state ∈ resolved/closed) are pinned here.
 */
import { describe, it, expect, vi } from 'vitest';
import { agentReviewRoundComment, computeAgentReviewHistory, computeAgentReviewService, computeAgentReviewTiming, computeQueueWaitingTimes, computeImprovementFlow, readFleetAgentReviewService,
  type AgentReviewServiceRow, type WatchdogFlowTick } from './flow-metrics';
import type { PullLedgerRow } from '../../agent-tools/scheduler/pull_ledger';
import type { ImprovementCandidate } from './policy';
import type { WorkItem } from '../../work-items';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, type ClaimSpec } from '../../scheduler/claim-spec';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-09T12:00:00Z');

function cand(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return { kind: 'bug', scope: 'operator', title: `t ${p.id}`, state: 'open', ...p };
}
const daysAgo = (d: number): string => new Date(NOW - d * DAY_MS).toISOString();
const tick = (d: number, captured = 0): WatchdogFlowTick => ({ tickAtMs: NOW - d * DAY_MS, capturedCount: captured });

describe('P-032 stage clocks', () => {
  const review = (enteredAt: string, round = 2) => ({ status: 'pending', submittedBy: 'su-author',
    ledgerIdeaId: 'idea', round, timing: { round: 2, enteredAt } });
  it('keeps creation age, the resubmitted round wait, admission wait and terminal delay distinct', () => {
    const out = computeQueueWaitingTimes([
      { createdAt: daysAgo(20), payload: { agentReview: review(daysAgo(0.1)) } },
      { createdAt: daysAgo(10), payload: { admissionReview: { state: 'pending', enteredAt: daysAgo(2) } } },
      { createdAt: daysAgo(5), payload: { admissionReview: { state: 'terminal', enteredAt: daysAgo(4), terminalAt: daysAgo(3) } } },
    ], NOW);
    expect(out.reportAge.oldestMs).toBe(20 * DAY_MS);
    expect(out.reviewWait).toMatchObject({ population: 1, oldestMs: 0.1 * DAY_MS, unknown: 0 });
    expect(out.admissionWait.oldestMs).toBe(2 * DAY_MS);
    expect(out.admissionDelay.oldestMs).toBe(DAY_MS);
  });
  it('does not turn undated, future or mismatched rounds into zero/creation age', () => {
    const out = computeQueueWaitingTimes([
      { createdAt: daysAgo(20), payload: { agentReview: review(daysAgo(1)) } },
      { createdAt: null, payload: { agentReview: review(daysAgo(-1)) } },
      { createdAt: daysAgo(10), payload: { agentReview: review(daysAgo(1), 3), admissionReview: { state: 'pending' } } },
    ], NOW);
    expect(out.reviewWait).toEqual({ population: 3, known: 1, unknown: 2, oldestKnownMs: DAY_MS, oldestMs: null });
    expect(out.reportAge.oldestMs).toBeNull();
    expect(out.admissionWait).toMatchObject({ population: 1, unknown: 1, oldestMs: null });
  });
});

describe('P-030 canonical fleet service population', () => {
  const input = { workspaceId: 'ws', harness: 'h', fleet: 'reviewers' };
  const spec: ClaimSpec = { ...DEFAULT_CLAIM_SPEC, specId: 'verify', lane: 'verification',
    view: { filter: { field: 'kind', op: '=', value: 'change' } } };
  const resolved = { ok: true, scope: { window: { startAt: daysAgo(1), endAt: daysAgo(0) }, stock: { revision: 2 } },
    claimSpec: { current: spec }, populationLifecycle: { currentRunnableRoster: { ownerIds: ['su-live'] } } };
  const fixture = (scope: unknown = resolved) => ({
    resolveScope: vi.fn(async () => scope),
    listItems: vi.fn(async () => [...Array.from({ length: 2001 }, (_, n) => ({ id: `change-${n}`, kind: 'change', payload: {} })),
      { id: 'unrelated', kind: 'bug', payload: {} }] as WorkItem[]),
    selectItems: (_scope: unknown, items: readonly WorkItem[]) => items.filter(item => matchesWorkItemClaimSpec(item, spec)),
    readService: vi.fn(async () => ({ status: 'known' })),
  });
  it('selects the full >2000-row current-spec cohort with the canonical matcher and runnable verifier roster', async () => {
    expect(validateClaimSpec(spec).ok, 'Service fixture must use the canonical claim-spec grammar').toBe(true);
    const deps = fixture();
    const out = await readFleetAgentReviewService(input, deps as never);
    expect(out).toMatchObject({ status: 'known', population: { matchedItems: 2001, censusItems: 2002,
      limitApplied: false, selection: 'canonical-claim-spec-matcher', roster: 'current-runnable-roster' } });
    expect(deps.listItems).toHaveBeenCalledWith({ harness: 'h', includeObservations: false });
    const [scope, options] = deps.readService.mock.calls[0] as unknown as [Record<string, unknown>, { itemIds: string[] }];
    expect(scope).toMatchObject({ sinceMs: NOW - DAY_MS, nowMs: NOW, verifierIds: ['su-live'],
      verificationSpecs: [{ specId: 'verify', revision: 2 }] });
    expect(options.itemIds).toHaveLength(2001);
    expect(options.itemIds).not.toContain('unrelated');
  });
  it('keeps an unread scope unknown and never calls a service reader for an implementation fleet', async () => {
    const failed = fixture({ ok: false, reason: 'roster unread', recoverVia: 'fleet:status' });
    expect(await readFleetAgentReviewService(input, failed as never)).toMatchObject({ status: 'unknown', detail: 'roster unread' });
    expect(failed.listItems).not.toHaveBeenCalled();
    const implementation = fixture({ ...resolved, claimSpec: { current: { ...spec, lane: 'implementation' } } });
    expect(await readFleetAgentReviewService(input, implementation as never)).toMatchObject({ status: 'not-applicable' });
    expect(implementation.readService).not.toHaveBeenCalled();
  });
  it('preserves census-read failure as unknown rather than healthy zero service', async () => {
    const deps = fixture(); deps.listItems.mockRejectedValueOnce(new Error('census unavailable'));
    expect(await readFleetAgentReviewService(input, deps as never)).toMatchObject({ status: 'unknown', detail: 'census unavailable' });
    expect(deps.readService).not.toHaveBeenCalled();
  });
});

describe('P-030 scoped current-round service', () => {
  const scope = { workspaceId: 'ws', harnessSlug: 'h', sinceMs: NOW - DAY_MS, nowMs: NOW,
    verifierIds: ['su-verifier'], verificationSpecs: [{ specId: 'verify', revision: 2 }] };
  const row = (id: string, status = 'pending', age = 0.5): AgentReviewServiceRow => ({
    id, workspaceId: 'ws', harnessSlug: 'h', state: 'open', createdBy: 'su-filer', terminalOwner: null,
    createdAt: daysAgo(20), reviewRoutedAtMs: NOW - 10 * DAY_MS,
    payload: { agentReview: { status, submittedBy: 'su-author', ledgerIdeaId: id, round: 2,
      timing: { round: 2, enteredAt: daysAgo(age), ...(status === 'pending' ? {} : { decidedAt: daysAgo(0.1) }) } } },
    ledger: { ideaId: id, routedRef: `wi:${id}`, grade: status === 'approved' ? 5 : 2, gradedBy: 'su-verifier' },
  });
  const pull = (overrides: Partial<PullLedgerRow> = {}): PullLedgerRow & { workspaceId: string } => ({
    workspaceId: 'ws', at: daysAgo(0.1), bee: 'su-verifier', harness: 'h', disposition: 'no-claim', item: null,
    specId: 'verify', revision: 2, specRef: 'verify@2', reason: 'no-eligible-work', status: 'ok', durationMs: 20,
    lateSettlement: null, ...overrides,
  });
  it('measures one scope/window, exposes older rounds and keeps an unknown oldest wait unknown', () => {
    const undated = row('legacy');
    undated.payload = { agentReview: { status: 'pending', submittedBy: 'su-author', ledgerIdeaId: 'legacy', round: 1 } };
    const out = computeAgentReviewService(scope, [row('approved', 'approved'), row('revision', 'revision-requested'),
      row('overdue', 'pending', 2), undated, { ...row('other'), harnessSlug: 'other' },
      { ...row('foreign'), workspaceId: 'foreign' }], []);
    expect(out).toMatchObject({ currentRounds: 4, arrivals: 2, arrivalsUnknown: 1, priorRoundsUnmeasured: 3,
      pending: 2, pendingTimingUnknown: 1, overdueKnown: 1, oldestKnownPendingWaitMs: 2 * DAY_MS,
      oldestPendingWaitMs: null, outcomes: { approved: 1, revisionRequested: 1 } });
  });
  it('refuses human/manual, mismatched-ledger and self-review grades as worker service', () => {
    const human = row('human', 'approved'); human.ledger!.gradedBy = 'owner';
    const unrelated = row('manual', 'approved'); unrelated.ledger!.routedRef = 'plan:manual';
    const self = row('self', 'approved');
    self.payload = { agentReview: { status: 'approved', submittedBy: 'su-verifier', ledgerIdeaId: 'self', round: 1,
      timing: { round: 1, enteredAt: daysAgo(0.5), decidedAt: daysAgo(0.1) } } };
    expect(computeAgentReviewService(scope, [human, unrelated, self], [])).toMatchObject({
      outcomes: { approved: 0, revisionRequested: 0 }, outcomesUnknown: 3,
    });
    expect(computeAgentReviewService({ ...scope, verifierIds: [] }, [], []).outcomes).toBeNull();
  });
  it('counts exact verification-spec pickups and lets late claims supersede timeout misses', () => {
    const out = computeAgentReviewService(scope, [], [pull(),
      pull({ status: 'timeout', lateSettlement: { kind: 'claimed', workItemId: 'WI-A', settledAt: daysAgo(0.05) } }),
      pull({ disposition: 'unrecorded' }), pull({ specId: 'implementation' }),
      pull({ bee: 'unrelated' }), pull({ revision: 1 }), pull({ at: daysAgo(2) }),
      pull({ specId: null, revision: null }),
      pull({ lateSettlement: { kind: 'rejected-unknown', settledAt: daysAgo(0.05) } })]);
    expect(out).toMatchObject({ pickups: { attempts: 4, claimed: 1, noClaim: 1, unknown: 2,
      noClaimReasons: { 'no-eligible-work': 1 } }, unscopedPickupAttempts: 1 });
  });
  it.each(['createdBy', 'terminalOwner'] as const)('refuses a reviewer recorded as %s outside the payload', party => {
    const conflicting = { ...row('conflicting', 'approved'), [party]: 'su-verifier' };
    expect(computeAgentReviewService(scope, [conflicting, row('independent', 'approved')], []))
      .toMatchObject({ outcomes: { approved: 1, revisionRequested: 0 }, outcomesUnknown: 1 });
  });
  it('recovers a replaced round once from dated history while keeping legacy and conflicting receipts unknown', () => {
    const item = row('history');
    const review = { status: 'revision-requested' as const, submittedBy: 'su-author', ledgerIdeaId: item.id,
      round: 1, timing: { round: 1, enteredAt: daysAgo(0.8), decidedAt: daysAgo(0.6) } };
    const post = { id: item.id, harnessSlug: 'h', author: 'su-verifier',
      body: agentReviewRoundComment('Revision', { ...item, harness: 'h', payload: { agentReview: review } },
        review, 2, 'su-verifier') };
    expect(computeAgentReviewService(scope, [item], [], [post, post])).toMatchObject({
      priorRoundsUnmeasured: 0, history: { priorRounds: 1, recordedRounds: 1, arrivals: 1,
        outcomes: { approved: 0, revisionRequested: 1 }, invalidReceipts: 0 } });
    expect(computeAgentReviewHistory(scope, [item], [{ ...post, body: 'Agent review round 1: approved' }]))
      .toMatchObject({ recordedRounds: 0, unmeasuredRounds: 1 });
    expect(computeAgentReviewHistory(scope, [item], [post, { ...post, author: 'owner' }]))
      .toMatchObject({ recordedRounds: 0, unmeasuredRounds: 1, invalidReceipts: 1 });
  });
  it('keeps wrong-scope, malformed timing, manual and self-review historical outcomes out of worker service', () => {
    const item = row('history');
    const review = { status: 'approved' as const, submittedBy: 'su-author', ledgerIdeaId: item.id,
      round: 1, timing: { round: 1, enteredAt: daysAgo(0.8), decidedAt: daysAgo(0.6) } };
    const post = (reviewer: string, enteredAt = review.timing.enteredAt) => ({ id: item.id, harnessSlug: 'h', author: reviewer,
      body: agentReviewRoundComment('Approved', { ...item, harness: 'h', payload: { agentReview: review } },
        { ...review, timing: { ...review.timing, enteredAt } }, 5, reviewer) });
    for (const reviewer of ['owner', 'su-author']) expect(computeAgentReviewHistory(scope, [item], [post(reviewer)]))
      .toMatchObject({ outcomes: { approved: 0, revisionRequested: 0 }, outcomesUnknown: 1 });
    expect(computeAgentReviewHistory(scope, [item], [post('su-verifier', 'invalid')]))
      .toMatchObject({ recordedRounds: 0, invalidReceipts: 1, unmeasuredRounds: 1 });
    expect(computeAgentReviewHistory(scope, [item], [{ ...post('su-verifier'), harnessSlug: 'other' }]))
      .toMatchObject({ recordedRounds: 0, outcomesUnknown: 0 });
  });
});

describe('P-030 round-aware review timing', () => {
  const review = { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-A', round: 2 };
  const measure = (agentReview: unknown, extra: Record<string, unknown> = {}) => computeAgentReviewTiming({
    payload: { agentReview, ...extra }, createdAt: daysAgo(20), reviewRoutedAtMs: NOW - 10 * DAY_MS, nowMs: NOW,
  });

  it('separates report age, first ledger routing, current-round wait and admission delay', () => {
    expect(measure({ ...review, timing: { round: 2, enteredAt: daysAgo(0.5) } }, {
      admissionReview: { enteredAt: daysAgo(2), terminalAt: daysAgo(1.5) },
    })).toMatchObject({ reportAgeMs: 20 * DAY_MS, ledgerRouteAgeMs: 10 * DAY_MS,
      reviewWaitMs: 0.5 * DAY_MS, revisionAgeMs: null, admissionDelayMs: 0.5 * DAY_MS, reviewTimeUnknown: null });
  });

  it('never substitutes an old routing time for absent or mismatched review-round timing', () => {
    expect(measure(review)).toMatchObject({ reviewWaitMs: null, reviewTimeUnknown: 'missing-round-time' });
    expect(measure({ ...review, timing: { round: 1, enteredAt: daysAgo(10) } }))
      .toMatchObject({ reviewWaitMs: null, reviewTimeUnknown: 'round-mismatch' });
    expect(measure({ ...review, round: 1 })).toMatchObject({ reviewWaitMs: null });
  });

  it.each(['invalid', '', daysAgo(-1)])('keeps malformed or future entry %s unknown', enteredAt => {
    expect(measure({ ...review, timing: { round: 2, enteredAt } }))
      .toMatchObject({ reviewWaitMs: null, reviewTimeUnknown: 'invalid-round-time' });
  });

  it('measures decision latency separately from time spent revising and refuses reversed dates', () => {
    const decided = { ...review, status: 'revision-requested', timing: {
      round: 2, enteredAt: daysAgo(2), decidedAt: daysAgo(1),
    } };
    expect(measure(decided)).toMatchObject({ reviewWaitMs: DAY_MS, revisionAgeMs: DAY_MS });
    expect(measure({ ...decided, timing: { ...decided.timing, decidedAt: daysAgo(3) } }))
      .toMatchObject({ reviewWaitMs: null, revisionAgeMs: null, reviewTimeUnknown: 'invalid-round-time' });
  });
});

describe('computeImprovementFlow — captured/resolved 7d windows', () => {
  it('counts creates inside the trailing 7 days; older ones fall out', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(0.5) }),
        cand({ id: 'b', createdAt: daysAgo(6.9) }),
        cand({ id: 'c', createdAt: daysAgo(7.1) }), // outside the window
        cand({ id: 'd' }), // no createdAt → uncounted
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.captured7d).toBe(2);
  });

  it('counts resolved/closed transitions by updatedAt (the resolution-time approximation)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', state: 'resolved', createdAt: daysAgo(20), updatedAt: daysAgo(1) }),
        cand({ id: 'b', state: 'closed', createdAt: daysAgo(30), updatedAt: daysAgo(3) }),
        cand({ id: 'c', state: 'resolved', createdAt: daysAgo(30), updatedAt: daysAgo(10) }), // resolved too long ago
        cand({ id: 'd', state: 'open', createdAt: daysAgo(1), updatedAt: daysAgo(0.1) }), // open never counts as out-flow
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.resolved7d).toBe(2);
    // a + d created in-window? a=20d ago no, d=1d ago yes → captured7d = 1
    expect(flow.captured7d).toBe(1);
    expect(flow.net7d).toBe(1 - 2);
  });

  it('net7d is captured − resolved (positive = backlog grew)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(1) }),
        cand({ id: 'b', createdAt: daysAgo(2) }),
        cand({ id: 'c', state: 'resolved', createdAt: daysAgo(9), updatedAt: daysAgo(2) }),
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow).toMatchObject({ captured7d: 2, resolved7d: 1, net7d: 1 });
  });
});

describe('computeImprovementFlow — median open age', () => {
  it('takes the median over OPEN items only (odd count)', () => {
    const flow = computeImprovementFlow(
      [
        cand({ id: 'a', createdAt: daysAgo(2) }),
        cand({ id: 'b', createdAt: daysAgo(10) }),
        cand({ id: 'c', createdAt: daysAgo(40) }),
        cand({ id: 'r', state: 'resolved', createdAt: daysAgo(100), updatedAt: daysAgo(90) }), // excluded
      ],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBe(10);
  });

  it('averages the middle pair for an even count, at 0.1-day precision', () => {
    const flow = computeImprovementFlow(
      [cand({ id: 'a', createdAt: daysAgo(2) }), cand({ id: 'b', createdAt: daysAgo(5) })],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBe(3.5);
  });

  it('is null when nothing is open', () => {
    const flow = computeImprovementFlow(
      [cand({ id: 'r', state: 'closed', createdAt: daysAgo(3), updatedAt: daysAgo(1) })],
      [],
      { nowMs: NOW },
    );
    expect(flow.medianOpenAgeDays).toBeNull();
  });
});

describe('computeImprovementFlow — watchdog liveness rollup', () => {
  it('reports the newest tick + counts/captures inside 24h', () => {
    const flow = computeImprovementFlow(
      [],
      [tick(0.01, 2), tick(0.5, 1), tick(0.9, 0), tick(1.5, 5)], // last one outside 24h
      { nowMs: NOW },
    );
    expect(flow.watchdog.lastTickAt).toBe(new Date(NOW - 0.01 * DAY_MS).toISOString());
    expect(flow.watchdog.ticks24h).toBe(3);
    expect(flow.watchdog.captured24h).toBe(3);
  });

  it('keeps the last tick even when it is older than 24h (ticks24h = 0)', () => {
    const flow = computeImprovementFlow([], [tick(3, 1)], { nowMs: NOW });
    expect(flow.watchdog.lastTickAt).toBe(new Date(NOW - 3 * DAY_MS).toISOString());
    expect(flow.watchdog.ticks24h).toBe(0);
    expect(flow.watchdog.captured24h).toBe(0);
  });

  it('is null/zero when the watchdog never ticked', () => {
    const flow = computeImprovementFlow([], [], { nowMs: NOW });
    expect(flow.watchdog).toEqual({ lastTickAt: null, ticks24h: 0, captured24h: 0 });
  });
});

describe('computeImprovementFlow — recurrence pass-through (reused from the digest, never re-derived)', () => {
  it('carries the injected digest count', () => {
    const flow = computeImprovementFlow([], [], { nowMs: NOW, recurringSignatureCount: 4 });
    expect(flow.recurringSignatureCount).toBe(4);
  });
  it('defaults to 0', () => {
    expect(computeImprovementFlow([], [], { nowMs: NOW }).recurringSignatureCount).toBe(0);
  });
});
