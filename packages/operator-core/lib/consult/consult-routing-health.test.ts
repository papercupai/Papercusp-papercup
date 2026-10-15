/**
 * consult-routing-health — unit tests for the P-004 routing-health read
 * (plan review-routing-through-relevance-router-2026-09-26, clause
 * RR-P-004-routing-health-counts): seeded consult attempts with known outcomes
 * and timestamps, in and out of the window, must land in exactly their policy's
 * counts.
 */
import { describe, expect, it } from 'vitest';
import {
  consultPolicyKey,
  expertiseExecutionHealthFromRows,
  readExpertiseExecutionHealth,
  resolveRoutingHealthWindow,
  routingHealthFromRows,
  type RoutingHealthConsultRow,
} from './consult-routing-health';
import { DISPATCH_RECORDS_MAX } from './consult-dispatch';
import { GRADING_CASCADE_FLAVOR } from './grading-cascade';
import { SELECTION_POLICIES } from './selection-policies';

const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const SINCE = T0;
const UNTIL = T0 + 6 * H;
const NOW = T0 + 8 * H;

describe('routing execution cohort', () => {
  const receipt = (durationMs: number, over: object = {}) => ({ metadata_json: {
    schemaVersion: 1, caller: 'fixture-caller', policy: 'consult-default', buildSha: '1234567',
    outcome: 'returned', durationMs, stages: { embedding: { durationMs: durationMs / 2, outcome: 'returned' } }, ...over,
  } });
  it('keeps caller/policy/build populations and observed stage failures separate', () => {
    const result = expertiseExecutionHealthFromRows([
      receipt(10), receipt(40, { outcome: 'threw', stages: { embedding: { durationMs: 20, outcome: 'threw' } } }),
      receipt(20, { caller: 'preview', buildSha: null, outcome: 'degraded', stages: {} }), { metadata_json: null },
    ], true);
    expect(result).toMatchObject({ cohort: 'routing-execution-start', rowsScanned: 4, invalidReceipts: 1, truncatedByLimit: true });
    expect(result.groups[0]).toMatchObject({ calls: 2, outcomes: { returned: 1, degraded: 0, threw: 1 },
      latencyMs: { observed: 2, p50: 10, p95: 40 }, stages: { embedding: { observed: 2, threw: 1, p50: 5, p95: 20 } } });
    expect(result.groups[1].stages.embedding).toBeUndefined();
    expect(result.groups[1].buildSha).toBeNull();
  });
  it('a missing ledger is unavailable rather than a healthy zero', async () => {
    const sql = (async () => { throw new Error('column metadata_json absent'); }) as never;
    const result = await readExpertiseExecutionHealth(sql, 'fixture', iso(SINCE), iso(UNTIL));
    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBe('routing-invocation-ledger-unavailable');
    expect(expertiseExecutionHealthFromRows([]).status).toBe('measured-empty');
  });
});

const launch = (atMs: number, answeringOwnerId: string, extraAttempts: object[] = []) => ({
  at: iso(atMs),
  sourceOwnerId: 'src',
  dispatched: true,
  answeringOwnerId,
  operation: 'fork',
  agent: 'claude',
  model: 'm',
  verified: true,
  detail: 'ok',
  attempts: [
    ...extraAttempts,
    { rank: extraAttempts.length, agent: 'claude', model: 'm', operation: 'fork', outcome: 'dispatched', detail: 'ok' },
  ],
});

const answerFailure = (atMs: number, answeringOwnerId: string | null, reason: string) => ({
  at: iso(atMs),
  sourceOwnerId: 'src',
  dispatched: false,
  answeringOwnerId,
  operation: null,
  agent: null,
  model: null,
  verified: null,
  detail: 'silent',
  answerFailure: { reason, cascadeCursor: 0, stopOutcome: 'stopped task t1' },
  attempts: [{ rank: null, agent: null, model: null, operation: null, outcome: 'failed', reason, detail: 'silent' }],
});

const digest = (ownerId: string, kind: string, atMs: number) => ({ ownerId, kind, at: iso(atMs), excerpt: 'x' });

function row(partial: Partial<RoutingHealthConsultRow> & { conversation_id: string }): RoutingHealthConsultRow {
  return {
    routing: { query: 'q' },
    state: 'active',
    latency_contract: 'proceed',
    closed_at: null,
    cascade_digest: [],
    dispatch_attempts: [],
    ...partial,
  };
}

/** The seeded population: one consult per outcome, spread across policies. */
const SEEDED: RoutingHealthConsultRow[] = [
  // consult-default: answered in window; an answered launch BEFORE the window must not count.
  row({
    conversation_id: 'A',
    dispatch_attempts: [launch(T0 - 1 * H, 'fork-a0'), launch(T0 + 1 * H, 'fork-a1')],
    cascade_digest: [digest('fork-a0', 'answer', T0 - 0.5 * H), digest('fork-a1', 'answer', T0 + 1.5 * H)],
  }),
  // rubric-vetting (hard-blocked): a failed launch rank, then a launched session the sweep
  // stopped for not posting (P-003 answer-window failure).
  row({
    conversation_id: 'B',
    routing: { policy: 'rubric-vetting' },
    latency_contract: 'hard-blocked',
    dispatch_attempts: [
      launch(T0 + 2 * H, 'fork-b1', [
        { rank: 0, agent: 'codex', model: 'm', operation: 'fork', outcome: 'failed', reason: 'launch-failed', detail: 'x' },
      ]),
      answerFailure(T0 + 2.5 * H, 'fork-b1', 'answer-window-expired'),
    ],
  }),
  // acceptance-grading: one launch silent past its 4 h window (hung), one still inside it
  // (pending), and one launched AFTER the window ends (must not count).
  row({
    conversation_id: 'C',
    routing: { cascade: { flavor: GRADING_CASCADE_FLAVOR } },
    dispatch_attempts: [launch(T0 + 3 * H, 'fork-c1'), launch(T0 + 5 * H, 'fork-c2'), launch(T0 + 7 * H, 'fork-c3')],
  }),
  // grading-integrity-audit: a skipped rank, then a convert that closed the consult answered.
  row({
    conversation_id: 'D',
    routing: { cascade: { flavor: 'grading-integrity' } },
    state: 'closed_answered',
    closed_at: new Date(T0 + 4.2 * H),
    dispatch_attempts: [
      launch(T0 + 4 * H, 'src-d', [
        { rank: 0, agent: 'codex', model: 'm', operation: null, outcome: 'skipped', reason: 'account-walled', detail: 'x' },
      ]),
    ],
  }),
  // consult-default: routed before the recorder shipped — no dispatch record at all.
  row({ conversation_id: 'E', cascade_digest: [digest('someone', 'dispatch_failed', T0 + 1 * H)] }),
  // consult-default: the launched session declined.
  row({
    conversation_id: 'F',
    dispatch_attempts: [launch(T0 + 1 * H, 'fork-f1')],
    cascade_digest: [digest('fork-f1', 'decline', T0 + 1.2 * H)],
  }),
];

const byPolicy = (result: ReturnType<typeof routingHealthFromRows>) =>
  Object.fromEntries(result.policies.map((p) => [p.policy, p]));

describe('routingHealthFromRows — seeded attempts in and out of the window', () => {
  const result = routingHealthFromRows(SEEDED, { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
  const p = byPolicy(result);

  it('counts the default policy: one answered and one declined launch; the pre-window answer is excluded', () => {
    expect(p['consult-default']).toMatchObject({
      consults: 3,
      consultsWithoutDispatchRecords: 1,
      launched: 2,
      answered: 1,
      declined: 1,
      failed: 0,
      hung: 0,
      pending: 0,
    });
  });

  it('counts rubric vetting: a failed launch rank and a launched session stopped for silence, by reason', () => {
    expect(p['rubric-vetting']).toMatchObject({ consults: 1, launched: 1, answered: 0, failed: 2, hung: 0, pending: 0 });
    expect(p['rubric-vetting']!.failedReasons).toEqual({ 'launch-failed': 1, 'answer-window-expired': 1 });
  });

  it('counts acceptance grading: hung past its window, pending inside it, the post-window launch excluded', () => {
    expect(p['acceptance-grading']).toMatchObject({ consults: 1, launched: 2, hung: 1, pending: 1, answered: 0, failed: 0 });
  });

  it('counts grading-integrity audits: a close on the current launch is an answer; skips are reported by reason', () => {
    expect(p['grading-integrity-audit']).toMatchObject({ launched: 1, answered: 1, skipped: 1 });
    expect(p['grading-integrity-audit']!.skippedReasons).toEqual({ 'account-walled': 1 });
  });

  it('totals are the sum over policies and the window is labelled a launch cohort', () => {
    expect(result.totals).toMatchObject({ launched: 6, answered: 2, declined: 1, failed: 2, hung: 1, pending: 1, skipped: 1 });
    expect(result.window).toEqual({ since: iso(SINCE), until: iso(UNTIL), cohort: 'launch-time' });
    expect(result.bounded).toMatchObject({ truncatedByLimit: false, consultsScanned: SEEDED.length, dispatchLogCapped: 0 });
  });

  it('moving the window moves the counts: only the pre-window launch is counted when the window covers it', () => {
    const early = byPolicy(routingHealthFromRows(SEEDED, { sinceMs: T0 - 2 * H, untilMs: T0, nowMs: NOW }));
    expect(early['consult-default']).toMatchObject({ launched: 1, answered: 1, declined: 0 });
    expect(early['acceptance-grading']).toMatchObject({ launched: 0, hung: 0, pending: 0 });
  });

  it('judges hung against now: the same launch is pending before its window elapses', () => {
    const before = byPolicy(routingHealthFromRows(SEEDED, { sinceMs: SINCE, untilMs: UNTIL, nowMs: T0 + 6.5 * H }));
    expect(before['acceptance-grading']).toMatchObject({ hung: 0, pending: 2 });
  });
});

describe('routingHealthFromRows request cohort', () => {
  it('counts accepted preparation as pending while preserving legacy and terminal unknown controls', () => {
    const make = (id: string, partial: Partial<RoutingHealthConsultRow>) => row({
      conversation_id: id, created_at: iso(T0 + H), routing: { deliveryIntent: 'dispatch' }, ...partial,
    });
    const health = routingHealthFromRows([
      make('accepted', { state: 'routing', routing: { deliveryIntent: 'dispatch', request: { version: 1 } } }),
      make('legacy-routing', { state: 'routing' }),
      make('recorded-result', { state: 'routing', routing: {
        deliveryIntent: 'dispatch', request: { version: 1, result: { verdict: 'relevance_unmeasured' } },
      } }),
      make('terminal', { state: 'no_qualified_responder' }),
    ], { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
    expect(health.requestCohort.totals).toMatchObject({ requests: 4, dispatchRequested: 4,
      legacyIntentUnknown: 0, outcomes: { pending: 1, unavailable: 1, unmeasured: 2 } });
    expect(health.totals.launched).toBe(0);
  });

  it('partitions explicit intents and terminal receipts without confusing lifecycle or launch attempts', () => {
    const make = (id: string, partial: Partial<RoutingHealthConsultRow> = {}) => row({
      conversation_id: id, created_at: iso(T0 + H), routing: { deliveryIntent: 'dispatch' }, ...partial,
    });
    const population = [
      make('retrieval', { routing: { deliveryIntent: 'retrieval-only' }, state: 'expired' }),
      make('legacy', { routing: {} }),
      make('expired-answer', { state: 'expired', has_feedback: true }),
      make('recovered-answer', { has_feedback: true, dispatch_attempts: [launch(T0 + H, 'answerer', [{ outcome: 'failed', reason: 'launch-failed' }])] }),
      make('decline', { state: 'closed_cant_help' }),
      make('pending', { state: 'awaiting_responder', expires_at: iso(NOW + H) }),
      make('capacity', { state: 'no_available_responder', dispatch_attempts: [{ at: iso(T0 + H), dispatched: false, attempts: [{ outcome: 'skipped', reason: 'account-walled' }] }] }),
      make('failure', { state: 'expired', dispatch_attempts: [answerFailure(T0 + H, 'answerer', 'answer-window-expired')] }),
      // Experts were selected but none could be launched: its own bucket, not 'unavailable' (R-2).
      make('unlaunchable', { state: 'no_launchable_responder', dispatch_attempts: [launch(T0 + H, 'answerer', [{ outcome: 'failed', reason: 'launch-failed' }])] }),
      make('unknown-result'),
      make('old', { created_at: iso(T0 - H), has_feedback: true }),
      make('future', { created_at: iso(UNTIL), has_feedback: true }),
    ];
    const health = routingHealthFromRows(population, { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
    const counts = health.requestCohort.totals;
    expect(counts).toEqual({
      requests: 10, dispatchRequested: 8, retrievalOnly: 1, legacyIntentUnknown: 1,
      outcomes: { received: 2, declined: 1, pending: 1, unavailable: 1, unlaunchable: 1, failed: 1, unmeasured: 1 },
      followThrough: {
        applicable: 10, notApplicable: 0, applicabilityUnknown: 0,
        recorded: { confirmed: 0, rescoped: 0, reversed: 0, moot: 0 },
        unknown: 10, invalid: 0, recordedWithFeedback: 0, recordedWithoutFeedback: 0,
      },
    });
    expect(counts.dispatchRequested + counts.retrievalOnly + counts.legacyIntentUnknown).toBe(counts.requests);
    expect(Object.values(counts.outcomes).reduce((sum, value) => sum + value, 0)).toBe(counts.dispatchRequested);
    expect(health.totals.failed).toBe(3); // The distinct launch-attempt population is preserved (incl. the unlaunchable row's failed launch).
    expect(health.requestCohort.window.cohort).toBe('request-time');
  });

  it('requires recorded answer content rather than a closed_answered label and respects scan bounds', () => {
    const result = routingHealthFromRows([
      row({ conversation_id: 'label-only', created_at: iso(T0), routing: { deliveryIntent: 'dispatch' }, state: 'closed_answered' }),
      row({ conversation_id: 'archive', created_at: iso(T0), routing: { deliveryIntent: 'dispatch' }, outcome: { source: 'archive', answer: { answer: 'grounded response' } } }),
    ], { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW, truncatedByLimit: true });
    expect(result.requestCohort.totals.outcomes).toMatchObject({ received: 1, unmeasured: 1 });
    expect(result.bounded.truncatedByLimit).toBe(true);
  });

  it('reports only requester-authored dispositions and keeps missing reconciliation unknown', () => {
    const make = (id: string, partial: Partial<RoutingHealthConsultRow> = {}) => row({
      conversation_id: id, requester_id: 'requester', created_at: iso(T0), ...partial,
    });
    const reconciliation = (disposition: string, by = 'requester') => ({
      disposition, by, at: iso(T0 + H), note: 'Checked the advice against the source.',
    });
    const population = [
      ...['confirmed', 'rescoped', 'reversed', 'moot'].map((disposition) => make(disposition, {
        has_feedback: disposition !== 'moot', outcome: { reconciliation: reconciliation(disposition) },
      })),
      make('silence', { has_feedback: true }),
      make('provider-impression', { outcome: { reconciliation: reconciliation('confirmed', 'reviewer') } }),
      make('hard-blocked', { latency_contract: 'hard-blocked' }),
      make('legacy-applicability', { latency_contract: null }),
    ];
    const follow = routingHealthFromRows(population, { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW }).requestCohort.totals.followThrough;
    expect(follow).toEqual({
      applicable: 6, notApplicable: 1, applicabilityUnknown: 1,
      recorded: { confirmed: 1, rescoped: 1, reversed: 1, moot: 1 },
      unknown: 1, invalid: 1, recordedWithFeedback: 3, recordedWithoutFeedback: 1,
    });
  });

  it.each(['active', 'closed_answered', 'closed_cant_help', 'graduated', 'declined', 'expired'])(
    'reads retained requester history after %s without inferring a disposition from the lifecycle', (state) => {
      const population = ['confirmed', 'rescoped', 'reversed', 'moot'].map(disposition => {
        const historical = Object.freeze({ disposition, by: 'requester', at: iso(T0 + H),
          note: 'Previously recorded project decision', decision_ref: 'project#D-001' });
        return Object.freeze(row({ conversation_id: disposition, requester_id: 'requester',
          state, created_at: iso(T0), has_feedback: true,
          outcome: Object.freeze({ reconciliation: historical, reason: 'Subsequent lifecycle transition' }) }));
      });
      const silence = Object.freeze(row({ conversation_id: 'no-history', requester_id: 'requester',
        state, created_at: iso(T0), has_feedback: true, outcome: Object.freeze({ answer: 'Delivered advice' }) }));
      const before = JSON.stringify(population);
      const follow = routingHealthFromRows([...population, silence], {
        sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW,
      }).requestCohort.totals.followThrough;
      expect(follow.recorded).toEqual({ confirmed: 1, rescoped: 1, reversed: 1, moot: 1 });
      expect(follow.unknown).toBe(1);
      expect(follow.invalid).toBe(0);
      expect(JSON.stringify(population)).toBe(before);
    },
  );
});

describe('routingHealthFromRows — honesty markers', () => {
  it('reports every known policy even with no consults, so a zero is measured, not omitted', () => {
    const result = routingHealthFromRows([], { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
    expect(result.policies.map((p) => p.policy).sort()).toEqual(Object.keys(SELECTION_POLICIES).sort());
    expect(result.policies.every((p) => p.launched === 0 && p.consults === 0)).toBe(true);
  });

  it('carries truncation and a capped dispatch log on the result', () => {
    const capped = row({
      conversation_id: 'G',
      dispatch_attempts: Array.from({ length: DISPATCH_RECORDS_MAX }, (_, i) => launch(T0 + i * 60_000, `f${i}`)),
    });
    const result = routingHealthFromRows([capped], {
      sinceMs: SINCE,
      untilMs: UNTIL,
      nowMs: NOW,
      truncatedByLimit: true,
      consultLimit: 1,
    });
    expect(result.bounded).toEqual({ truncatedByLimit: true, consultsScanned: 1, consultLimit: 1, dispatchLogCapped: 1 });
  });

  it('counts a failure record with no launch to resolve by its own time', () => {
    const orphan = row({
      conversation_id: 'H',
      routing: { policy: 'rubric-vetting' },
      dispatch_attempts: [
        answerFailure(T0 + 1 * H, null, 'answer-pickup-stalled'),
        answerFailure(T0 - 1 * H, null, 'answer-pickup-stalled'),
      ],
    });
    const p = byPolicy(routingHealthFromRows([orphan], { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW }));
    expect(p['rubric-vetting']).toMatchObject({ launched: 0, failed: 1, failedReasons: { 'answer-pickup-stalled': 1 } });
  });

  it('reads JSON-string columns the same as parsed ones', () => {
    const asStrings = SEEDED.map((r) => ({
      ...r,
      routing: JSON.stringify(r.routing),
      dispatch_attempts: JSON.stringify(r.dispatch_attempts),
      cascade_digest: JSON.stringify(r.cascade_digest),
    }));
    const a = routingHealthFromRows(SEEDED, { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
    const b = routingHealthFromRows(asStrings, { sinceMs: SINCE, untilMs: UNTIL, nowMs: NOW });
    expect(b.policies).toEqual(a.policies);
  });
});

describe('consultPolicyKey', () => {
  it('maps a routing snapshot to its selection policy', () => {
    expect(consultPolicyKey({ policy: 'rubric-vetting' })).toBe('rubric-vetting');
    expect(consultPolicyKey({ cascade: { flavor: GRADING_CASCADE_FLAVOR } })).toBe('acceptance-grading');
    expect(consultPolicyKey({ cascade: { flavor: 'grading-integrity' } })).toBe('grading-integrity-audit');
    expect(consultPolicyKey({ query: 'q' })).toBe('consult-default');
    expect(consultPolicyKey(null)).toBe('consult-default');
    expect(consultPolicyKey('not json')).toBe('consult-default');
  });
});

describe('resolveRoutingHealthWindow', () => {
  it('defaults to the last 24 h ending now', () => {
    expect(resolveRoutingHealthWindow({}, NOW)).toEqual({ sinceMs: NOW - 24 * H, untilMs: NOW });
  });
  it('honours since/until and hours', () => {
    expect(resolveRoutingHealthWindow({ since: iso(SINCE), until: iso(UNTIL) }, NOW)).toEqual({ sinceMs: SINCE, untilMs: UNTIL });
    expect(resolveRoutingHealthWindow({ hours: 2, until: iso(UNTIL) }, NOW)).toEqual({ sinceMs: UNTIL - 2 * H, untilMs: UNTIL });
  });
  it('refuses an empty, unparseable, or over-long window', () => {
    expect(resolveRoutingHealthWindow({ since: iso(UNTIL), until: iso(SINCE) }, NOW)).toHaveProperty('error');
    expect(resolveRoutingHealthWindow({ since: 'yesterday' }, NOW)).toHaveProperty('error');
    expect(resolveRoutingHealthWindow({ since: iso(NOW - 15 * 24 * H) }, NOW)).toHaveProperty('error');
  });
});
