import { describe, expect, it } from 'vitest';
import {
  admissionEndpointBlock,
  admissionPairKey,
  applyClaimedReReviewHolds,
  prescreenPromoterWindow,
  type AdmissionMergeSnapshot,
  ADMISSION_REVIEW_ALERT_KEY,
  ADMISSION_REVIEW_RETRY_OWNER,
  DEFAULT_ADMISSION_REVIEW_SLO_MINUTES,
  buildAdmissionReviewMetadata,
  buildPromoterPrompt,
  decideWorkItemAdmissionProducerPressure,
  deriveAdmissionRunOutcome,
  evaluatePromoterLiveness,
  normalizeAdmissionRunState,
  parsePromoterJudgements,
  planPromoterDispositions,
  responsePayload,
  selectAdmissionRecurrenceCanonicals,
  type PromoterItem,
  type PromoterJudgement,
  type PromoterLlmResult,
  type PromoterPair,
} from './work-items-admission-promoter';

const queueHealth = (pending: number, sampleSize = 0, p95Ms: number | null = null) => ({
  pending,
  unreviewed: 0,
  promotedToFirstClaim: { sampleSize, p50Ms: p95Ms, p95Ms },
});

describe('decideWorkItemAdmissionProducerPressure', () => {
  it('preserves the configured Scout budget for a drained/normal queue and treats missing latency as neutral', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0))).toMatchObject({
      level: 'normal',
      pending: 0,
      latencySampleSize: 0,
      p95Ms: null,
      maxIdeators: null,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(20, 4, 90 * 60_000))).toMatchObject({
      level: 'normal',
      maxIdeators: null,
    });
  });

  it('caps at three ideators above one promoter batch or one liveness window', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(21))).toMatchObject({
      level: 'elevated',
      maxIdeators: 3,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0, 10, 90 * 60_000 + 1))).toMatchObject({
      level: 'elevated',
      maxIdeators: 3,
    });
  });

  it('caps at one ideator above two promoter batches or two liveness windows', () => {
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(41))).toMatchObject({
      level: 'deep',
      maxIdeators: 1,
    });
    expect(decideWorkItemAdmissionProducerPressure(queueHealth(0, 10, 180 * 60_000 + 1))).toMatchObject({
      level: 'deep',
      maxIdeators: 1,
    });
  });

  it('uses current capacity instead of terminal backlog and old claim history, while retaining current slow-claim pressure', () => {
    const historical = queueHealth(467, 7500, 10 * 24 * 60 * 60_000);
    const current = { pending: 0, latencyWindowMs: 90 * 60_000, promotedToFirstClaim: queueHealth(0).promotedToFirstClaim };
    expect(decideWorkItemAdmissionProducerPressure({ ...historical, producerPressure: current })).toMatchObject({
      level: 'normal', pending: 0, latencySampleSize: 0, p95Ms: null, maxIdeators: null,
    });
    expect(decideWorkItemAdmissionProducerPressure({
      ...historical, producerPressure: { ...current, promotedToFirstClaim: queueHealth(0, 1, 180 * 60_000 + 1).promotedToFirstClaim },
    })).toMatchObject({ level: 'deep', maxIdeators: 1 });
  });
});

describe('admission review metadata', () => {
  const nowMs = Date.parse('2026-08-26T12:00:00Z');

  it('creates an open pending review debt record with an age SLO and retry owner', () => {
    expect(buildAdmissionReviewMetadata({ state: 'pending', nowMs })).toEqual({
      state: 'pending',
      enteredAt: '2026-08-26T12:00:00.000Z',
      reviewDueAt: new Date(nowMs + DEFAULT_ADMISSION_REVIEW_SLO_MINUTES * 60_000).toISOString(),
      retryOwner: ADMISSION_REVIEW_RETRY_OWNER,
      retryAttempts: 0,
      lastRetryAt: null,
      reviewedAt: null,
      reviewedBy: null,
      terminalAt: null,
      terminalOutcome: null,
      alert: {
        key: ADMISSION_REVIEW_ALERT_KEY,
        state: 'open',
        emittedAt: '2026-08-26T12:00:00.000Z',
        reason: 'pending fail-open admission requires re-review',
      },
    });
  });

  it('closes the alert and records reviewed/terminal outcomes', () => {
    const reviewed = buildAdmissionReviewMetadata({
      state: 'reviewed',
      nowMs,
      enteredAtMs: nowMs - 10_000,
      retryAttempts: 2,
      reviewedBy: 'system:reviewer',
    });
    expect(reviewed).toMatchObject({
      state: 'reviewed',
      enteredAt: '2026-08-26T11:59:50.000Z',
      retryAttempts: 2,
      reviewedAt: '2026-08-26T12:00:00.000Z',
      reviewedBy: 'system:reviewer',
      alert: { state: 'cleared', key: ADMISSION_REVIEW_ALERT_KEY },
    });
    const terminal = buildAdmissionReviewMetadata({
      state: 'terminal',
      nowMs,
      terminalOutcome: 'duplicate-merge',
    });
    expect(terminal).toMatchObject({
      state: 'terminal',
      terminalAt: '2026-08-26T12:00:00.000Z',
      terminalOutcome: 'duplicate-merge',
      alert: { state: 'cleared' },
    });
  });
});

const item = (id: string, overrides: Partial<PromoterItem> = {}): PromoterItem => ({
  id,
  title: 'vitest duplicate failure',
  summary: 'The same test failure with the same retry remedy.',
  state: 'open',
  kind: 'bug',
  admission: 'pending',
  conditionKey: null,
  createdAtMs: Number(id.replace(/\D/g, '')) || 1,
  ...overrides,
});

const pair = (a: PromoterItem, b: PromoterItem, pendingIds = [a.id, b.id]): PromoterPair => ({
  pairKey: admissionPairKey(a.id, b.id),
  a: a.id < b.id ? a : b,
  b: a.id < b.id ? b : a,
  pendingIds,
  signals: ['title-key', 'cosine'],
  cosine: 0.99,
});

const judgement = (p: PromoterPair, verdict: PromoterJudgement['verdict']): PromoterJudgement => ({
  pairKey: p.pairKey,
  verdict,
  reason: `test ${verdict}`,
});

describe('planPromoterDispositions', () => {
  it('replays six vitest clones as one promoted canonical plus five merges without cycles', () => {
    const pending = Array.from({ length: 6 }, (_, i) => item(`WI-${i + 1}`));
    const pairs = pending.slice(1).map((candidate) => pair(pending[0]!, candidate));
    const plan = planPromoterDispositions(
      pending,
      pairs,
      pairs.map((p) => judgement(p, 'r-finding-merge')),
    );

    expect(plan.dispositions).toContainEqual({ itemId: 'WI-1', action: 'promote' });
    expect(plan.dispositions.filter((d) => d.action === 'merge')).toHaveLength(5);
    expect(plan.dispositions.filter((d) => d.action === 'merge')).toEqual(
      expect.arrayContaining(pending.slice(1).map((p) => ({ itemId: p.id, action: 'merge', canonicalId: 'WI-1' }))),
    );
    expect(new Set(plan.adjudications.map((a) => a.canonical))).toEqual(new Set(['WI-1']));
  });

  it('keeps a live endpoint canonical when a terminal near-neighbour has a different title identity', () => {
    const live = item('EI-live', {
      title: 'evaluator omits the excluded population count',
      summary: 'The current evaluator result omits one measured population.',
      createdAtMs: 2,
    });
    const terminalNearNeighbour = item('WI-closed', {
      title: 'evaluator rates bundled clauses as structurally atomic',
      summary: 'A completed finding about bundled evaluator clauses.',
      state: 'done',
      admission: 'admitted',
      createdAtMs: 1,
    });
    const p = pair(live, terminalNearNeighbour, [live.id]);
    const plan = planPromoterDispositions([live], [p], [judgement(p, 'r-finding-merge')]);

    expect(plan.dispositions).toEqual([{ itemId: live.id, action: 'promote' }]);
    expect(plan.adjudications[0]).toMatchObject({ canonical: live.id });
  });

  it('retains a completed canonical for an exact title identity match', () => {
    const terminal = item('WI-closed', { state: 'done', admission: 'admitted', createdAtMs: 1 });
    const repeat = item('EI-repeat', { createdAtMs: 2 });
    const p = pair(repeat, terminal, [repeat.id]);
    const plan = planPromoterDispositions([repeat], [p], [judgement(p, 'r-finding-merge')]);

    expect(plan.dispositions).toEqual([{ itemId: repeat.id, action: 'merge', canonicalId: terminal.id }]);
    expect(plan.adjudications[0]).toMatchObject({ canonical: terminal.id });
  });

  it('adds live non-pending losers from a transitive merge component', () => {
    const canonical = item('WI-canonical', { admission: 'admitted', createdAtMs: 1 });
    const legacyLoser = item('WI-legacy-loser', { admission: null, createdAtMs: 2 });
    const pendingBridge = item('WI-pending-bridge', { admission: 'pending', createdAtMs: 3 });
    const pairs = [
      pair(pendingBridge, legacyLoser, [pendingBridge.id]),
      pair(pendingBridge, canonical, [pendingBridge.id]),
    ];
    const plan = planPromoterDispositions(
      [pendingBridge],
      pairs,
      pairs.map((p) => judgement(p, 'r-finding-merge')),
    );

    expect(plan.dispositions).toEqual([
      { itemId: 'WI-legacy-loser', action: 'merge', canonicalId: 'WI-canonical' },
      { itemId: 'WI-pending-bridge', action: 'merge', canonicalId: 'WI-canonical' },
    ]);
  });

  it('preserves and links an R-remedy pair while admitting both items', () => {
    const a = item('WI-1', { summary: 'Fix with an intake lease.' });
    const b = item('WI-2', { summary: 'Fix with a refractory window.' });
    const p = pair(a, b);
    const plan = planPromoterDispositions([a, b], [p], [judgement(p, 'r-remedy-keep')]);

    expect(plan.dispositions).toEqual([
      { itemId: 'WI-1', action: 'promote' },
      { itemId: 'WI-2', action: 'promote' },
    ]);
    expect(plan.relatedPairs).toEqual([{ a: 'WI-1', b: 'WI-2' }]);
    expect(plan.adjudications[0]).toMatchObject({ verdict: 'r-remedy-keep', canonical: null });
  });

  it('holds every pending endpoint when the model omits its pair', () => {
    const a = item('WI-1');
    const b = item('WI-2');
    const p = pair(a, b);
    const plan = planPromoterDispositions([a, b], [p], []);
    expect(plan.dispositions).toEqual([
      { itemId: 'WI-1', action: 'hold', reason: `model omitted ${p.pairKey}` },
      { itemId: 'WI-2', action: 'hold', reason: `model omitted ${p.pairKey}` },
    ]);
  });
});

describe('selectAdmissionRecurrenceCanonicals', () => {
  it.each(['conditionKey', 'watchdogKey'] as const)(
    'holds the complete conflicting %s component while retaining independent work',
    (identityField) => {
      const first = item('WI-1', { [identityField]: 'producer:first' });
      const bridge = item('WI-2');
      const second = item('WI-3', { [identityField]: 'producer:second' });
      const historical = item('WI-4', { admission: 'admitted' });
      const keyed = item('WI-5', { watchdogKey: 'producer:compatible' });
      const independent = item('WI-6');
      const pending = [first, bridge, second, keyed, independent];
      const conflictPairs = [pair(first, bridge), pair(bridge, second)];
      const compatiblePair = pair(historical, keyed, [keyed.id]);
      const relatedPair = pair(first, independent);
      const plan = planPromoterDispositions(
        pending,
        [...conflictPairs, compatiblePair, relatedPair],
        [
          ...conflictPairs.map((candidate) => judgement(candidate, 'r-finding-merge')),
          judgement(compatiblePair, 'r-finding-merge'),
          judgement(relatedPair, 'r-related'),
        ],
      );
      const items = new Map([...pending, historical].map((candidate) => [candidate.id, candidate]));

      expect(() => selectAdmissionRecurrenceCanonicals(plan, items)).toThrow('conflicting stable producer identities');
      const guarded = selectAdmissionRecurrenceCanonicals(plan, items, { onConflict: 'hold' });

      for (const conflicting of [first, bridge, second]) {
        expect(guarded.dispositions).toContainEqual({
          itemId: conflicting.id,
          action: 'hold',
          reason: expect.stringContaining('conflicting stable producer identities'),
        });
      }
      expect(guarded.dispositions).toContainEqual({ itemId: independent.id, action: 'promote' });
      expect(guarded.dispositions).toContainEqual({ itemId: historical.id, action: 'merge', canonicalId: keyed.id });
      expect(guarded.dispositions).toContainEqual({ itemId: keyed.id, action: 'promote' });
      expect(guarded.adjudications).toEqual([
        expect.objectContaining({ pairKey: compatiblePair.pairKey, canonical: keyed.id }),
      ]);
      expect(guarded.relatedPairs).toEqual([]);
      expect(plan.adjudications).toHaveLength(4);
    },
  );

  it('does not turn a missing endpoint into a tolerated conflict', () => {
    const first = item('WI-1');
    const second = item('WI-2');
    const candidatePair = pair(first, second);
    const plan = planPromoterDispositions(
      [first, second],
      [candidatePair],
      [judgement(candidatePair, 'r-finding-merge')],
    );

    expect(() =>
      selectAdmissionRecurrenceCanonicals(plan, new Map([[first.id, first]]), { onConflict: 'hold' }),
    ).toThrow('missing endpoint(s)');
  });
});

describe('model contract', () => {
  it('states the duplication-only charter and the remedy/template traps', () => {
    const p = pair(item('WI-1'), item('WI-2'));
    const prompt = buildPromoterPrompt([p]);
    expect(prompt.system).toContain('DUPLICATION ONLY');
    expect(prompt.system).toContain('never an automatic merge licence');
    expect(prompt.system).toContain('r-remedy-keep');
    expect(prompt.user).toContain(p.pairKey);
  });

  it('accepts strict complete-shaped judgements and rejects duplicate pair keys', () => {
    expect(
      parsePromoterJudgements({ judgements: [{ pairKey: 'a::b', verdict: 'distinct', reason: 'different' }] }),
    ).toEqual([{ pairKey: 'a::b', verdict: 'distinct', reason: 'different' }]);
    expect(() =>
      parsePromoterJudgements({
        judgements: [
          { pairKey: 'a::b', verdict: 'distinct', reason: 'one' },
          { pairKey: 'a::b', verdict: 'r-related', reason: 'two' },
        ],
      }),
    ).toThrow(/duplicate judgement/);
  });
});

describe('evaluatePromoterLiveness', () => {
  const now = Date.parse('2026-08-26T12:00:00Z');

  it('alarms on a missing or inactive routine', () => {
    expect(
      evaluatePromoterLiveness({
        routineExists: false,
        active: null,
        createdAtMs: null,
        lastSuccessAtMs: null,
        nowMs: now,
      }),
    ).toMatchObject({ stale: true, reason: 'promoter routine row is missing' });
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: false,
        createdAtMs: now,
        lastSuccessAtMs: now,
        nowMs: now,
      }),
    ).toMatchObject({ stale: true, reason: 'promoter routine is inactive' });
  });

  it('holds the 90-minute successful-run boundary from both sides', () => {
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: true,
        createdAtMs: now - 200 * 60_000,
        lastSuccessAtMs: now - 90 * 60_000,
        nowMs: now,
      }).stale,
    ).toBe(false);
    expect(
      evaluatePromoterLiveness({
        routineExists: true,
        active: true,
        createdAtMs: now - 200 * 60_000,
        lastSuccessAtMs: now - 90 * 60_000 - 1,
        nowMs: now,
      }).stale,
    ).toBe(true);
  });
});

describe('admission run reporting semantics', () => {
  it('does not infer success from a finish timestamp when an explicit status is unknown', () => {
    expect(normalizeAdmissionRunState('mystery', '2026-08-26T15:00:00Z')).toBe('failed');
    expect(normalizeAdmissionRunState(null, '2026-08-26T15:00:00Z')).toBe('complete');
    expect(normalizeAdmissionRunState(null, null)).toBe('running');
  });

  it('keeps failed and blocked counters unknown/zero instead of inventing work', () => {
    expect(
      deriveAdmissionRunOutcome({
        state: 'failed',
        runKind: 'bulk-stage',
        detail: { status: 'failed', error: 'transport failed' },
        batchSize: 1500,
        promoted: null,
        merged: null,
        held: null,
        autoPromotedUnreviewed: null,
      }),
    ).toMatchObject({ unit: 'pairs', attempted: null, successful: null, failureReason: 'transport failed' });
    expect(
      deriveAdmissionRunOutcome({
        state: 'blocked',
        runKind: 'daily-digest',
        detail: { status: 'blocked', blockedReason: 'awaiting-bulk' },
        batchSize: 0,
        promoted: 0,
        merged: 0,
        held: 0,
        autoPromotedUnreviewed: 0,
      }),
    ).toMatchObject({ unit: 'links', attempted: 0, successful: 0, blockedReason: 'awaiting-bulk' });
  });

  it('derives promoter item outcomes and preserves explicit writer outcomes', () => {
    expect(
      deriveAdmissionRunOutcome({
        state: 'complete',
        runKind: 'promoter-tick',
        detail: { status: 'complete', mode: 'promoter' },
        batchSize: 4,
        promoted: 2,
        merged: 1,
        held: 1,
        autoPromotedUnreviewed: 0,
      }),
    ).toMatchObject({ unit: 'items', attempted: 4, successful: 3, unchanged: 1, uniqueRowsChanged: 3 });
    expect(
      deriveAdmissionRunOutcome({
        state: 'complete',
        runKind: 'promoter-tick',
        detail: {
          status: 'complete',
          outcome: {
            unit: 'items',
            attempted: 9,
            successful: 7,
            rolledBack: 1,
            unchanged: 1,
            uniqueRowsChanged: 6,
            failureReason: null,
            blockedReason: null,
          },
        },
        batchSize: 2,
        promoted: 2,
        merged: 0,
        held: 0,
        autoPromotedUnreviewed: 0,
      }),
    ).toMatchObject({ attempted: 9, successful: 7, rolledBack: 1, uniqueRowsChanged: 6 });
  });
});

describe('responsePayload', () => {
  const reply = (over: Partial<PromoterLlmResult>): PromoterLlmResult => ({
    text: '',
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  });

  it('returns an already-parsed payload untouched', () => {
    expect(responsePayload(reply({ json: { judgements: [] }, text: 'ignored' }))).toEqual({
      judgements: [],
    });
  });

  // The defect this block pins: tryParseJson (libs/testing-shell/src/llm/llm-client.ts)
  // returns null — not undefined — when a reply is unrecoverable, and llmCall assigns
  // `json` straight from it on every responseFormat:'json' call. A bare `!== undefined`
  // guard forwards that FAILURE sentinel on as if it were a payload, so the caller
  // reports `expected object, received null` and the reply text is discarded unread.
  // Null must mean "not parsed", never "the payload is null".
  it('does NOT forward tryParseJson null sentinel as a payload', () => {
    expect(() => responsePayload(reply({ json: null, text: '{"judgements": [' }))).toThrow(
      /not parseable JSON/,
    );
  });

  it('recovers from the text when json is null but the text is valid JSON', () => {
    expect(responsePayload(reply({ json: null, text: '{"judgements": []}' }))).toEqual({
      judgements: [],
    });
  });

  it('reports a truncated reply as unterminated, with its token count and both ends', () => {
    let message = '';
    try {
      responsePayload(
        reply({ json: null, text: '{"judgements": [{"pairKey": "a|b"', outputTokens: 8000 }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/unterminated/);
    expect(message).toMatch(/signature of hitting the output cap/);
    expect(message).toMatch(/outputTokens=8000/);
    expect(message).toMatch(/head=/);
    expect(message).toMatch(/tail=/);
  });

  it('distinguishes a prose refusal from a truncation', () => {
    let message = '';
    try {
      responsePayload(reply({ json: null, text: 'I cannot complete this request.' }));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/no-json-delimiters/);
    expect(message).not.toMatch(/unterminated/);
  });

  it('still reports genuinely empty output as empty, with its token count', () => {
    expect(() => responsePayload(reply({ json: null, text: '   ', outputTokens: 0 }))).toThrow(
      /returned empty output \(outputTokens=0\)/,
    );
  });

  // CONTROL — a deliberately-wrong implementation kept permanently, per the repo's
  // falsifiability rule for a subject reached by import (mutation-probe historical mode
  // cannot help here: the assertions import the module by path, so a frozen snapshot is
  // never the code under test). This is the exact pre-fix body. It proves the assertions
  // above discriminate: if this control ever stops exhibiting the bug, they are vacuous.
  const preFixResponsePayload = (response: PromoterLlmResult): unknown => {
    if (response.json !== undefined) return response.json;
    const text = response.text.trim();
    if (!text) throw new Error('promoter model returned empty output');
    return JSON.parse(text);
  };

  it('control: the pre-fix body silently returned the null sentinel as a payload', () => {
    const truncated = reply({ json: null, text: '{"judgements": [' });
    // The pre-fix body hands null onward — which is what surfaced downstream as the
    // opaque `expected object, received null`, with the reply text discarded unread.
    expect(preFixResponsePayload(truncated)).toBeNull();
    // The fixed body refuses to, and says why instead.
    expect(() => responsePayload(truncated)).toThrow(/unterminated/);
  });
});

// WI-6554700010018134: a TERMINAL twin's open-work gates (agent review, claim, claim-hold)
// are residue no later tick can lift. Measured live on 2026-10-20: EI-26282407214531658 sat
// `deferred: review-gated` behind dropped EI-24515847775093700, whose agentReview was still
// `pending`, on every promoter tick — the pending row could never be judged or admitted.
describe('admission endpoint protection — terminal twins', () => {
  const pendingReview = { status: 'pending', submittedBy: 'su-test', ledgerIdeaId: 'idea-1', round: 1 };
  const executionBlocker = {
    kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit',
    ref: 'runtime:completed-work', summary: 'Execution dependency', status: 'active',
    createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z', createdBy: 'su-test',
  };
  const snapshot = (id: string, overrides: Partial<AdmissionMergeSnapshot> = {}): AdmissionMergeSnapshot => ({
    id,
    workspaceId: 'ws',
    harnessSlug: 'h',
    title: `${id} title`,
    summary: `${id} summary`,
    state: 'open',
    kind: 'change',
    admission: 'admitted',
    admittedAt: null,
    admittedBy: null,
    conditionKey: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    origin: 'local',
    assignee: null,
    payload: {},
    completionRef: null,
    terminalCompletionRef: null,
    terminalOwner: null,
    terminalReason: null,
    closedAtMs: null,
    completionAuthority: null,
    sourcePlanSlug: null,
    sourcePlanItemIds: [],
    seeAlso: [],
    incomingSeeAlso: [],
    dependencies: [],
    fingerprint: id,
    ...overrides,
  });

  it('keeps an OPEN twin with a pending agent review as a transient review gate', () => {
    expect(admissionEndpointBlock(snapshot('EI-1', { payload: { agentReview: pendingReview } }))).toMatchObject({
      reason: 'review-gated',
      permanent: false,
    });
  });

  describe('authenticated audited agent park comparison', () => {
    const actor = 'su-f376159c-ff71-45aa-b34c-cded72705429';
    const pending = item('EI-original');
    const twin = item('EI-parked', { admission: 'admitted' });
    const comparison = pair(pending, twin, [pending.id]);
    const parkPayload = { _claimHold: true, _ei: { source: 'su', created_by: actor },
      claim_hold_by: actor, claim_hold_reason: 'future independent source work',
      claim_hold_at: new Date(1000).toISOString() };
    const parked = snapshot(twin.id, { payload: parkPayload, agentParkAudit: {
      id: 'audit-park', atMs: 1008, actor, action: 'work_items:claim_hold:set',
      details: { mode: 'claim_hold', by: actor, reason: parkPayload.claim_hold_reason },
    } });
    const select = (overrides: Partial<AdmissionMergeSnapshot> = {}, authenticated = true,
      original: Partial<AdmissionMergeSnapshot> = {}) => prescreenPromoterWindow({
      window: [pending, twin], pairs: [comparison], snapshots: new Map([
        [pending.id, snapshot(pending.id, { admission: 'pending', ...original })],
        [twin.id, { ...parked, ...overrides }],
      ]), batchSize: 2, nowMs: 2000,
      ...(authenticated ? { componentScreeningItemIds: [pending.id] } : {}),
    });

    it('judges only the eligible authenticated original and keeps the held neighbour self-blocked', () => {
      expect(select().batch).toEqual([pending]);
      expect(select().pairs).toEqual([comparison]);
      expect(select({}, false).batch).toEqual([]);
      expect(select({}, true, { assignee: actor }).batch).toEqual([]);
      expect(select({}, true, { payload: { _claimHold: true } }).batch).toEqual([]);
      expect(admissionEndpointBlock(parked)).toMatchObject({ reason: 'claim-held' });
    });

    it.each([
      { agentParkAudit: undefined },
      { agentParkAudit: { ...parked.agentParkAudit!, actor: 'owner' } },
      { agentParkAudit: { ...parked.agentParkAudit!, action: 'work_items:claim_hold:clear' } },
      { agentParkAudit: { ...parked.agentParkAudit!, atMs: 70_000 } },
      { agentParkAudit: { ...parked.agentParkAudit!, details: { mode: 'held_open', by: actor, reason: parkPayload.claim_hold_reason } } },
      { payload: { ...parkPayload, claim_hold_reason: 'different hold' } },
      { payload: { ...parkPayload, claim_hold_by: 'system:resource-governor' } },
      { payload: { ...parkPayload, _ei: { source: 'su', created_by: 'owner' } } },
      { payload: { ...parkPayload, held_open_by: actor } },
      { payload: { ...parkPayload, claim_hold_reason: 'policy-tier independent approval' } },
      { payload: { ...parkPayload, claim_hold_release: { condition: 'changed' } } },
      { assignee: actor }, { state: 'blocked' }, { state: 'needs-human' }, { state: 'done' },
      { origin: 'remote', ownNode: true }, { workspaceId: 'other' }, { harnessSlug: 'other' },
      { payload: { ...parkPayload, needsOwnerAction: true } },
      { payload: { ...parkPayload, agentReview: pendingReview } },
      { payload: { ...parkPayload, externalBlockers: [executionBlocker] } },
      { dependencies: [{ id: 'dep', blockedKind: 'issue', blockedRef: twin.id, blockerKind: 'issue',
        blockerRef: 'EI-dependency', depType: 'blocks', satisfaction: 'success', createdBy: actor, active: true }] },
    ] satisfies Partial<AdmissionMergeSnapshot>[])('refuses forged provenance and every coexisting protection %j', protection => {
      expect(select(protection).pairs).toEqual([]);
    });
  });

  describe('authenticated claimed comparison', () => {
    const pending = item('EI-original');
    const twin = item('EI-claimed', { admission: 'admitted' });
    const comparison = pair(pending, twin, [pending.id]);
    const snapshots = new Map([
      [pending.id, snapshot(pending.id, { admission: 'pending' })],
      [twin.id, snapshot(twin.id, { assignee: 'su-holder' })],
    ]);
    const select = (authenticated: boolean, current = snapshots) => prescreenPromoterWindow({
      window: [pending], pairs: [comparison], snapshots: current, batchSize: 1, nowMs: 1,
      ...(authenticated ? { componentScreeningItemIds: [pending.id] } : {}),
    });

    it('judges the claimed comparison only for an authenticated eligible original', () => {
      expect(select(false).batch).toEqual([]);
      expect(select(true).batch).toEqual([pending]);
      expect(select(true).pairs).toEqual([comparison]);
      expect(select(true).forcedHolds.size).toBe(0);
      const claimedOriginal = new Map(snapshots);
      claimedOriginal.set(pending.id, snapshot(pending.id, { admission: 'pending', assignee: 'su-other' }));
      expect(select(true, claimedOriginal).batch).toEqual([]);
    });

    it.each([
      { state: 'blocked' }, { state: 'needs-human' }, { payload: { _claimHold: true } },
      { payload: { agentReview: pendingReview } },
      { payload: { externalBlockers: [executionBlocker] } },
      { payload: { externalBlockers: [{ ...executionBlocker, kind: 'human', capability: 'credential' }] } },
      { dependencies: [{ id: 'dep-1', blockedKind: 'issue', blockedRef: 'EI-claimed', blockerKind: 'issue',
        blockerRef: 'EI-dependency', depType: 'blocks', satisfaction: 'success', createdBy: 'su-test', active: true }] },
    ] satisfies Partial<AdmissionMergeSnapshot>[])('keeps the comparison protection %j', (protection) => {
      const current = new Map(snapshots);
      current.set(twin.id, snapshot(twin.id, { assignee: 'su-holder', ...protection }));
      expect(select(true, current).batch).toEqual([]);
    });

    it('keeps remote comparisons outside the model and preserves their permanent classification', () => {
      const current = new Map(snapshots);
      current.set(twin.id, snapshot(twin.id, { assignee: 'su-holder', origin: 'remote' }));
      expect(select(true, current).pairs).toEqual([]);
      expect(select(true, current).prescreen).toMatchObject({ unresolvablePairs: 1 });
      expect(admissionEndpointBlock(current.get(twin.id))).toMatchObject({ reason: 'remote-owned', permanent: true });
    });

    it.each([true, false])('holds a duplicate in either canonical direction (claimed canonical=%s)', (claimedCanonical) => {
      const current = new Map(snapshots);
      current.set(twin.id, snapshot(twin.id, { assignee: 'su-holder', admission: claimedCanonical ? 'admitted' : 'pending', createdAtMs: 2 }));
      const candidate = { ...twin, admission: claimedCanonical ? 'admitted' : 'pending', createdAtMs: 2 };
      const candidatePair = pair(pending, candidate, [pending.id]);
      const plan = planPromoterDispositions([pending], [candidatePair], [{
        pairKey: candidatePair.pairKey, verdict: 'r-finding-merge', reason: 'same finding',
      }]);
      const protectedPlan = applyClaimedReReviewHolds(plan, current, new Set([pending.id]), 1, [pending.id]);
      expect(protectedPlan.dispositions).toEqual([
        { itemId: pending.id, action: 'hold', reason: expect.stringContaining(twin.id) },
      ]);
      expect(protectedPlan.adjudications).toEqual([]);
      expect(current.get(twin.id)?.assignee).toBe('su-holder');
    });
  });

  it('classifies a dropped twin with a stale pending review as permanently unresolvable, not review-gated', () => {
    const dropped = snapshot('EI-2', { state: 'dropped', payload: { agentReview: pendingReview } });
    expect(admissionEndpointBlock(dropped)).toMatchObject({
      reason: 'terminal-canonical-without-completion',
      permanent: true,
    });
  });

  it('treats a completed twin with stale review, claim and claim-hold residue as an ordinary judgeable twin', () => {
    const done = snapshot('EI-3', {
      state: 'done',
      assignee: 'su-gone',
      completionAuthority: 'committed',
      payload: { agentReview: { ...pendingReview, status: 'revision-requested' }, _claimHold: true },
    });
    expect(admissionEndpointBlock(done)).toBeNull();
  });

  it.each(['runtime', 'event', 'gate'])('does not let a completed twin retain a transient %s execution blocker', (kind) => {
    const done = snapshot('EI-completed-blocker', {
      state: 'done',
      completionAuthority: 'committed',
      payload: { externalBlockers: [{ ...executionBlocker, kind }] },
    });
    expect(admissionEndpointBlock(done)).toBeNull();
    expect(done.payload).toMatchObject({ externalBlockers: [{ status: 'active' }] });
  });

  it('keeps execution blockers on open twins and classifies terminal twins without completion permanently', () => {
    const payload = { externalBlockers: [executionBlocker] };
    expect(admissionEndpointBlock(snapshot('EI-open-blocker', { payload }))).toMatchObject({
      reason: 'external-blocked', permanent: false,
    });
    expect(admissionEndpointBlock(snapshot('EI-dropped-blocker', { state: 'dropped', payload }))).toMatchObject({
      reason: 'terminal-canonical-without-completion', permanent: true,
    });
  });

  describe('overdue review with its own runtime debt (EI-26720509885145560)', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const ownDebt = {
      ...executionBlocker, ref: ADMISSION_REVIEW_ALERT_KEY,
      summary: 'This item is waiting for its own admission review',
    };
    const reviewSnapshot = (ref = ADMISSION_REVIEW_ALERT_KEY) => ({
      ...snapshot('EI-self-review', { state: 'blocked', admission: 'unreviewed', assignee: 'su-reviewer' }),
      payload: {
        admissionReview: { state: 'pending', reviewDueAt: '2026-10-21T11:00:00Z' },
        externalBlockers: [{ ...ownDebt, ref }],
      },
    });

    it.each([ADMISSION_REVIEW_ALERT_KEY, `${ADMISSION_REVIEW_ALERT_KEY}:EI-self-review`])(
      'allows ordinary overdue review past its own debt %s without removing the blocker', ref => {
        const current = reviewSnapshot(ref);
        expect(admissionEndpointBlock(current, now)).toBeNull();
        expect(current).toMatchObject({ state: 'blocked', assignee: 'su-reviewer',
          payload: { externalBlockers: [{ ref, status: 'active' }] } });
      },
    );

    it.each([
      { name: 'another runtime dependency', ref: 'runtime:other', kind: 'runtime', capability: 'live-dependency', reason: 'external-blocked' },
      { name: 'another item review debt', ref: `${ADMISSION_REVIEW_ALERT_KEY}:EI-other`, kind: 'runtime', capability: 'live-dependency', reason: 'external-blocked' },
      { name: 'a human product decision', ref: ADMISSION_REVIEW_ALERT_KEY, kind: 'human', capability: 'product-decision', reason: 'external-blocked' },
      { name: 'an owner credential', ref: ADMISSION_REVIEW_ALERT_KEY, kind: 'human', capability: 'credential', reason: 'owner-blocked' },
      { name: 'a runtime product decision', ref: ADMISSION_REVIEW_ALERT_KEY, kind: 'runtime', capability: 'product-decision', reason: 'external-blocked' },
      { name: 'a malformed runtime capability', ref: ADMISSION_REVIEW_ALERT_KEY, kind: 'runtime', capability: 'unsupported', reason: 'external-blocked' },
    ])('preserves $name even while reviewing its own overdue debt', ({ ref, kind, capability, reason }) => {
      const current = reviewSnapshot();
      current.payload = { ...current.payload, externalBlockers: [ownDebt, { ...ownDebt, ref, kind, capability }] };
      expect(admissionEndpointBlock(current, now)).toMatchObject({ reason });
    });

    it('keeps the exception confined to an overdue claimed pending review', () => {
      const current = reviewSnapshot();
      expect(admissionEndpointBlock(current)).toMatchObject({ reason: 'claimed' });
      expect(admissionEndpointBlock({ ...current, assignee: null }, now)).toMatchObject({ reason: 'blocked-state' });
      for (const admissionReview of [
        { state: 'reviewed', reviewDueAt: '2026-10-21T11:00:00Z' },
        { state: 'pending', reviewDueAt: '2026-10-21T13:00:00Z' },
        { state: 'pending', reviewDueAt: 'invalid' },
      ]) {
        expect(admissionEndpointBlock({ ...current, payload: { ...current.payload, admissionReview } }, now))
          .toMatchObject({ reason: 'claimed' });
      }
      expect(admissionEndpointBlock({ ...current, origin: 'remote' }, now)).toMatchObject({ reason: 'remote-owned' });
      expect(admissionEndpointBlock({ ...current, payload: { ...current.payload, _claimHold: true } }, now))
        .toMatchObject({ reason: 'claim-held' });
      expect(admissionEndpointBlock({ ...current, payload: { ...current.payload,
        externalBlockers: [{ ...ownDebt, capabilitySource: 'legacy-inferred' }] } }, now))
        .toMatchObject({ reason: 'external-blocked' });
    });
  });

  it('preserves owner capability protection on completed twins with execution residue', () => {
    const done = snapshot('EI-owner-blocker', {
      state: 'done',
      completionAuthority: 'committed',
      payload: { externalBlockers: [executionBlocker, { ...executionBlocker, kind: 'human', capability: 'credential' }] },
    });
    expect(admissionEndpointBlock(done)).toMatchObject({ reason: 'owner-blocked', permanent: false });
  });

  it('selects a pending row for real judgement when its completed twin retains an execution blocker', () => {
    const pending = item('EI-10');
    const twin = item('EI-4', { state: 'done', admission: 'admitted' });
    const result = prescreenPromoterWindow({
      window: [pending],
      pairs: [pair(pending, twin, [pending.id])],
      snapshots: new Map([
        ['EI-10', snapshot('EI-10', { admission: 'pending', kind: 'bug' })],
        ['EI-4', snapshot('EI-4', { state: 'done', completionAuthority: 'committed', payload: { externalBlockers: [executionBlocker] } })],
      ]),
      batchSize: 5,
      nowMs: 1,
    });
    expect(result.batch.map((entry) => entry.id)).toEqual(['EI-10']);
    expect(result.pairs).toHaveLength(1);
    expect(result.forcedHolds.has('EI-10')).toBe(false);
  });

  it('does not defer a pending row whose only twin is terminal with a stale review', () => {
    const pending = item('EI-10');
    const twin = item('EI-4', { state: 'dropped', admission: 'admitted' });
    const snapshots = new Map<string, AdmissionMergeSnapshot>([
      ['EI-10', snapshot('EI-10', { admission: 'pending', kind: 'bug' })],
      ['EI-4', snapshot('EI-4', { state: 'dropped', payload: { agentReview: pendingReview } })],
    ]);
    const result = prescreenPromoterWindow({
      window: [pending],
      pairs: [pair(pending, twin, [pending.id])],
      snapshots,
      batchSize: 5,
      nowMs: 1,
    });
    expect(result.batch.map((entry) => entry.id)).toEqual(['EI-10']);
    expect(result.prescreen.samples.filter((s) => s.class === 'deferred')).toEqual([]);
    expect(result.forcedHolds.has('EI-10')).toBe(false);
  });
});
