import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  optionOrderOf,
  questionsSchemaSha256,
  sha256Hex,
  stateSha256,
  toDecisionLedgerEntry,
  type DecisionCallRecord,
  type DecisionOutcome,
  type DecisionRequest,
} from './index.js';

const SECRET_TURN = 'my bank PIN is 4417 and I live at 12 Elm Street';

const request = {
  state: { turn: SECRET_TURN, memory: 'User prefers dark mode' },
  questions: {
    relevant: {
      type: 'choice',
      instructions: 'Is this memory relevant to the turn?',
      options: { relevant: 'Helps answer the turn', irrelevant: null, harmful: 'Would mislead' },
    },
    certainty: { type: 'score', instructions: 'How sure?', levels: ['low', 'mid', 'high'] },
    urgent: { type: 'yesNo', instructions: 'Is it urgent?' },
  },
} as const satisfies DecisionRequest;

const answered: DecisionOutcome = {
  kind: 'answered',
  model: 'jev-1.13.0',
  answers: {
    relevant: {
      type: 'choice',
      choice: 'relevant',
      probabilities: { relevant: 0.9, irrelevant: 0.08, harmful: 0.02 },
      confidence: 0.84,
    },
    certainty: { type: 'score', score: 1.7, probabilities: [0.05, 0.2, 0.75], confidence: 0.7 },
    urgent: { type: 'yesNo', pYes: 0.1 },
  },
  usage: { inputTokens: 300, outputTokens: 20 },
  latencyMs: 212.6,
  attempts: 1,
};

function record(outcome: DecisionOutcome, over: Partial<DecisionCallRecord> = {}): DecisionCallRecord {
  return {
    provider: 'typesafe',
    requestedModel: 'jev-1.13.0',
    request,
    outcome,
    startedAt: new Date('2026-09-30T02:00:00.000Z'),
    consumer: 'memory-injection',
    surface: null,
    subjectIds: ['mem-1', 'mem-2'],
    hostLoad: { busyMs: 37.4, utilization: 0.18 },
    transportLatencyMs: 21.6,
    ...over,
  };
}

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe('{"a":{"c":null,"d":[3,1]},"b":1}');
    expect(canonicalJson({ a: { c: null, d: [3, 1] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [3, 1], c: null } }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members like JSON.stringify, and encodes strings as JSON strings', () => {
    expect(canonicalJson({ a: undefined, b: 'x' })).toBe('{"b":"x"}');
    expect(canonicalJson('he said "hi"')).toBe(JSON.stringify('he said "hi"'));
  });
});

describe('hashes', () => {
  it('stateSha256 is sha256 of the canonical encoding — key order does not matter, content does', () => {
    expect(stateSha256({ a: 1, b: 2 })).toBe(stateSha256({ b: 2, a: 1 }));
    expect(stateSha256({ a: 1 })).not.toBe(stateSha256({ a: 2 }));
    expect(stateSha256('abc')).toBe(sha256Hex('"abc"'));
    expect(stateSha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('questionsSchemaSha256 ignores option order but not option content', () => {
    const permuted = {
      ...request.questions,
      relevant: {
        ...request.questions.relevant,
        options: { harmful: 'Would mislead', relevant: 'Helps answer the turn', irrelevant: null },
      },
    };
    expect(questionsSchemaSha256(permuted)).toBe(questionsSchemaSha256(request.questions));
    const reworded = {
      ...request.questions,
      relevant: { ...request.questions.relevant, instructions: 'Is this memory about the turn?' },
    };
    expect(questionsSchemaSha256(reworded)).not.toBe(questionsSchemaSha256(request.questions));
  });

  it('optionOrderOf records the SENT order of choice options only', () => {
    expect(optionOrderOf(request.questions)).toEqual({ relevant: ['relevant', 'irrelevant', 'harmful'] });
  });
});

describe('toDecisionLedgerEntry', () => {
  it('maps an answered call: returned model, answers, tokens, rounded latency, subject ids', () => {
    const e = toDecisionLedgerEntry(record(answered));
    expect(e).toMatchObject({
      provider: 'typesafe',
      consumer: 'memory-injection',
      requestedModel: 'jev-1.13.0',
      returnedModel: 'jev-1.13.0',
      outcome: 'answered',
      inconclusiveReason: null,
      inconclusiveDetail: null,
      httpStatus: null,
      questionIds: ['relevant', 'certainty', 'urgent'],
      optionOrder: { relevant: ['relevant', 'irrelevant', 'harmful'] },
      attempts: 1,
      latencyMs: 213,
      inputTokens: 300,
      outputTokens: 20,
      costUsd: null,
      subjectIds: ['mem-1', 'mem-2'],
      stateSha256: stateSha256(request.state),
    });
    expect(e.answers?.relevant).toMatchObject({ choice: 'relevant', confidence: 0.84 });
  });

  it('NEVER carries the judged text: no field of the serialized entry contains it', () => {
    const serialized = JSON.stringify(toDecisionLedgerEntry(record(answered)));
    expect(serialized).not.toContain('4417');
    expect(serialized).not.toContain('Elm Street');
    expect(serialized).not.toContain('dark mode');
    // Positive control: the same check DOES see text that is meant to be there.
    expect(serialized).toContain('memory-injection');
  });

  it('computes cost only when the host supplies rates and both token counts are known', () => {
    const pricing = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 4 };
    expect(toDecisionLedgerEntry(record(answered), { pricing }).costUsd).toBeCloseTo((300 * 1 + 20 * 4) / 1e6, 12);
    const noUsage: DecisionOutcome = { ...answered, usage: { inputTokens: null, outputTokens: 20 } } as DecisionOutcome;
    expect(toDecisionLedgerEntry(record(noUsage), { pricing }).costUsd).toBeNull();
  });

  it('keeps client-written detail but drops a provider error body (it can quote the request)', () => {
    const malformed: DecisionOutcome = {
      kind: 'inconclusive',
      reason: 'malformed-response',
      detail: "answer 'relevant' probabilities do not sum to 1",
      status: 200,
      latencyMs: 90,
      attempts: 1,
    };
    expect(toDecisionLedgerEntry(record(malformed))).toMatchObject({
      outcome: 'inconclusive',
      inconclusiveReason: 'malformed-response',
      inconclusiveDetail: "answer 'relevant' probabilities do not sum to 1",
      httpStatus: 200,
      returnedModel: null,
      answers: null,
      inputTokens: null,
      costUsd: null,
    });

    const rejected: DecisionOutcome = {
      kind: 'inconclusive',
      reason: 'rejected',
      detail: `{"error":"bad state: ${SECRET_TURN}"}`,
      status: 422,
      latencyMs: 40,
      attempts: 1,
    };
    const e = toDecisionLedgerEntry(record(rejected));
    expect(e).toMatchObject({ inconclusiveReason: 'rejected', httpStatus: 422, inconclusiveDetail: null });
    expect(JSON.stringify(e)).not.toContain('4417');
  });

  it('records the host load as rounded busy ms and utilization (P-001: attribute a timeout to host or provider)', () => {
    expect(toDecisionLedgerEntry(record(answered))).toMatchObject({ loopBusyMs: 37, loopUtilization: 0.18 });
    // The worker-measured provider time rides along, rounded; an impossible value is not measured.
    expect(toDecisionLedgerEntry(record(answered)).transportLatencyMs).toBe(22);
    expect(toDecisionLedgerEntry(record(answered, { transportLatencyMs: -3 })).transportLatencyMs).toBeNull();
    expect(toDecisionLedgerEntry(record(answered, { transportLatencyMs: null })).transportLatencyMs).toBeNull();
  });

  it('host load not measured is NULL, never a fake zero', () => {
    expect(toDecisionLedgerEntry(record(answered, { hostLoad: null }))).toMatchObject({
      loopBusyMs: null,
      loopUtilization: null,
    });
  });

  it('an out-of-range host load is stored as not measured, per field', () => {
    const bad = toDecisionLedgerEntry(record(answered, { hostLoad: { busyMs: -5, utilization: 1.4 } }));
    expect(bad).toMatchObject({ loopBusyMs: null, loopUtilization: null });
    const nan = toDecisionLedgerEntry(record(answered, { hostLoad: { busyMs: 12, utilization: Number.NaN } }));
    expect(nan).toMatchObject({ loopBusyMs: 12, loopUtilization: null });
  });

  it('a keyless call is still an auditable entry (no status, no detail invented)', () => {
    const noKey: DecisionOutcome = { kind: 'inconclusive', reason: 'no-key', latencyMs: 0, attempts: 0 };
    expect(toDecisionLedgerEntry(record(noKey, { subjectIds: [] }))).toMatchObject({
      outcome: 'inconclusive',
      inconclusiveReason: 'no-key',
      inconclusiveDetail: null,
      httpStatus: null,
      attempts: 0,
      subjectIds: [],
    });
  });
});
