import { describe, expect, it } from 'vitest';
import {
  admissionPairKey,
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
