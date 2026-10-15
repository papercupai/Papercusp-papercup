/**
 * The frozen LLM judge runner. The LLM call is injected so build → call → parse →
 * composite is unit-tested without the network. Ported from the gym (source moved into
 * the shared eval-battery engine, reconciliation D-001).
 */
import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, judgeBatteryRun, JudgeOutputContractError, type JudgeLlmCall, type JudgeInput } from './judge';
import { rubricHash, composite, type BatteryRubric } from './scoring';

const RUBRIC: BatteryRubric = {
  version: 'v1',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1: 'Intent & spec fidelity (PRIMARY).',
    d2: 'Code quality (subjective).',
    d3: 'Process correctness.',
  },
};

const input: JudgeInput = {
  intent: 'Operators need a liveness probe',
  projectContext: 'A small Hono service.',
  distilledTrace: 'scoper chunked... worker added GET /health returning 200... validator passed.',
  rubric: RUBRIC,
};

describe('judgeBatteryRun spend evidence', () => {
  const reply = { text: '{"d1":5,"d2":5,"d3":5,"rationale":"measured"}',
    costUsd: 0.2, inputTokens: 10, outputTokens: 5 };

  it.each([
    { costUsdMeasurementMissing: true },
    { unreportedFrames: 2 },
    { costUsdMeasurementMissing: 'false' },
    { unreportedFrames: NaN },
  ])('retains incomplete successful usage %j', async evidence => {
    const score = await judgeBatteryRun(input, { llmCall: async () => ({ ...reply, ...evidence }) as never });
    expect(score).toMatchObject({ costUsd: 0.2, costUsdMeasurementMissing: true });
    if (evidence.unreportedFrames === 2) expect(score).toMatchObject({ unreportedFrames: 2 });
  });

  it.each([undefined, -1, NaN, Infinity])('does not invent complete usage from cost %s', async costUsd => {
    const score = await judgeBatteryRun(input, { llmCall: async () => ({ ...reply, costUsd }) as never });
    expect(score).toMatchObject({ costUsd: 0, costUsdMeasurementMissing: true });
  });

  it('retains earlier incompleteness through a successful repair', async () => {
    let calls = 0;
    const score = await judgeBatteryRun(input, { llmCall: async () => ++calls === 1
      ? { ...reply, text: 'malformed', costUsdMeasurementMissing: true, unreportedFrames: 2 }
      : reply });
    expect(calls).toBe(2);
    expect(score).toMatchObject({ costUsd: 0.4, costUsdMeasurementMissing: true, unreportedFrames: 2 });
  });

  it.each([true, false])('retains spent repair attempts on final contract failure (incomplete=%s)', async incomplete => {
    let error: unknown;
    try {
      await judgeBatteryRun(input, { llmCall: async () => ({ ...reply, text: 'malformed',
        ...(incomplete ? { costUsdMeasurementMissing: true, unreportedFrames: 1 } : {}) }) });
    } catch (e) { error = e; }
    expect(error).toBeInstanceOf(JudgeOutputContractError);
    expect(error).toMatchObject({ costUsd: 0.4, inputTokens: 20, outputTokens: 10,
      ...(incomplete ? { costUsdMeasurementMissing: true, unreportedFrames: 2 } : {}) });
    if (!incomplete) expect(error).not.toHaveProperty('costUsdMeasurementMissing');
  });

  it.each([
    { costUsd: 0.07, expected: 0.27, missing: false },
    { costUsd: 0, expected: 0.2, missing: false },
    { costUsd: 0.07, costUsdMeasurementMissing: true, expected: 0.27, missing: true },
    { expected: 0.2, missing: true },
  ])('retains the earlier repair charge when a later call throws %j', async evidence => {
    let calls = 0;
    const failure = Object.assign(new Error('repair transport failed'), evidence);
    let error: unknown;
    try {
      await judgeBatteryRun(input, { llmCall: async () => {
        if (++calls === 1) return { ...reply, text: 'malformed' };
        throw failure;
      } });
    } catch (e) { error = e; }
    expect(error).toBe(failure);
    expect(error).toMatchObject({ costUsd: evidence.expected });
    if (evidence.missing) expect(error).toHaveProperty('costUsdMeasurementMissing', true);
    else expect(error).not.toHaveProperty('costUsdMeasurementMissing');
  });
});

describe('buildJudgePrompt', () => {
  it('instructs JSON-only output over a 0..10 scale with all three dimensions', () => {
    const { system } = buildJudgePrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toContain('0');
    expect(system).toContain('10');
    expect(system).toContain(RUBRIC.dimensions.d1);
    expect(system).toContain(RUBRIC.dimensions.d2);
    expect(system).toContain(RUBRIC.dimensions.d3);
  });

  it('puts the intent, project context, and distilled trace in the user message', () => {
    const { user } = buildJudgePrompt(input);
    expect(user).toContain(input.intent);
    expect(user).toContain(input.projectContext);
    expect(user).toContain(input.distilledTrace);
  });
});

function fakeLlm(result: { json?: unknown; text?: string }): { call: JudgeLlmCall; calls: Parameters<JudgeLlmCall>[0][] } {
  const calls: Parameters<JudgeLlmCall>[0][] = [];
  const call: JudgeLlmCall = async (opts) => {
    calls.push(opts);
    return { text: result.text ?? '', json: result.json, costUsd: 0.42, inputTokens: 1000, outputTokens: 200 };
  };
  return { call, calls };
}

describe('judgeBatteryRun', () => {
  it('parses the judge JSON, computes composite, and stamps the frozen run-params', async () => {
    const { call } = fakeLlm({ json: { d1: 8, d2: 6, d3: 4, rationale: 'solid intent, minor debt' } });
    const score = await judgeBatteryRun(input, { llmCall: call });

    expect(score).toMatchObject({
      d1: 8,
      d2: 6,
      d3: 4,
      rationale: 'solid intent, minor debt',
      judgeModel: 'claude-opus-4-8',
      judgeTemp: RUBRIC.temperature,
      rubricHash: rubricHash(RUBRIC),
      costUsd: 0.42,
    });
    expect(score.composite).toBeCloseTo(composite({ d1: 8, d2: 6, d3: 4 }, RUBRIC.weights), 6);
    expect(score.weights).toEqual(RUBRIC.weights);
  });

  it('calls the LLM with the frozen model, thinking budget, and JSON format', async () => {
    const { call, calls } = fakeLlm({ json: { d1: 5, d2: 5, d3: 5, rationale: 'r' } });
    await judgeBatteryRun(input, { llmCall: call });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].thinkingBudgetTokens).toBe(RUBRIC.thinkingBudgetTokens);
    expect(calls[0].responseFormat).toBe('json');
  });

  it('falls back to extracting JSON from the text when structured json is absent', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'Here is my verdict:\n{"d1":9,"d2":8,"d3":7,"rationale":"ok"}' });
    const score = await judgeBatteryRun(input, { llmCall: call });
    expect(score.d1).toBe(9);
  });

  it('throws when the judge produced no parseable scores', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'I was unable to evaluate this run.' });
    await expect(judgeBatteryRun(input, { llmCall: call })).rejects.toThrow();
  });
});

/** A fake that returns a DIFFERENT reply per call, so the repair path is observable. */
function sequencedLlm(replies: Array<{ json?: unknown; text?: string }>): {
  call: JudgeLlmCall;
  calls: Parameters<JudgeLlmCall>[0][];
} {
  const calls: Parameters<JudgeLlmCall>[0][] = [];
  const call: JudgeLlmCall = async (opts) => {
    const r = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(opts);
    return { text: r.text ?? '', json: r.json, costUsd: 0.25, inputTokens: 100, outputTokens: 20 };
  };
  return { call, calls };
}

describe('judgeBatteryRun — output-contract failure is diagnosable + repairable (WI-35902)', () => {
  // REGRESSION ANCHOR: the papercusp gym-cycle sat wedged from 2026-07-27 on the message
  // "battery judge produced no parseable JSON output" — which discarded the reply, so
  // nothing downstream could tell WHY. Every assertion here is about evidence surviving.
  it('repairs a malformed first reply with one strict re-ask, without inventing a score', async () => {
    const { call, calls } = sequencedLlm([
      { text: 'I reviewed the run carefully but will describe it in prose instead.' },
      { text: '{"d1":9,"d2":7,"d3":5,"rationale":"repaired"}' },
    ]);
    const score = await judgeBatteryRun(input, { llmCall: call });

    expect(calls).toHaveLength(2);
    expect(score).toMatchObject({ d1: 9, d2: 7, d3: 5, rationale: 'repaired' });
    // The re-ask shows the model its own rejected reply and demands the bare object.
    expect(calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(calls[1].messages[1].content).toContain('prose instead');
    expect(calls[1].messages[2].content).toMatch(/SINGLE JSON object/i);
  });

  it('accumulates cost + tokens across the repair (a retried judgement really spent both calls)', async () => {
    const { call } = sequencedLlm([{ text: 'nope' }, { text: '{"d1":1,"d2":1,"d3":1,"rationale":"r"}' }]);
    const score = await judgeBatteryRun(input, { llmCall: call });
    expect(score.costUsd).toBeCloseTo(0.5, 6);
    expect(score.inputTokens).toBe(200);
    expect(score.outputTokens).toBe(40);
  });

  it('repairs a reply that PARSES but has the wrong shape (missing rationale)', async () => {
    const { call, calls } = sequencedLlm([
      { json: { d1: 8, d2: 8, d3: 8 } },
      { json: { d1: 8, d2: 8, d3: 8, rationale: 'now complete' } },
    ]);
    const score = await judgeBatteryRun(input, { llmCall: call });
    expect(calls).toHaveLength(2);
    expect(score.rationale).toBe('now complete');
  });

  it('honours repairAttempts:0 — one call, no re-ask', async () => {
    const { call, calls } = sequencedLlm([{ text: 'still prose' }]);
    await expect(judgeBatteryRun(input, { llmCall: call, repairAttempts: 0 })).rejects.toThrow(
      JudgeOutputContractError,
    );
    expect(calls).toHaveLength(1);
  });

  it('carries the raw reply, its length, and the attempt count on the thrown error', async () => {
    const bad = 'I am unable to evaluate this run because the trace was empty.';
    const { call } = sequencedLlm([{ text: bad }]);
    const err = await judgeBatteryRun(input, { llmCall: call }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(JudgeOutputContractError);
    const e = err as JudgeOutputContractError;
    expect(e.rawText).toBe(bad);
    expect(e.textLength).toBe(bad.length);
    expect(e.attempts).toBe(2); // the first call + one repair
    expect(e.reason).toBe('unparseable');
    expect(e.hadStructuredJson).toBe(false);
    expect(e.judgeModel).toBe(RUBRIC.model);
  });

  it('inlines the fixed-shape facts BEFORE the excerpt so a truncated last_status stays diagnosable', async () => {
    const { call } = sequencedLlm([{ text: 'refusal text' }]);
    const err = (await judgeBatteryRun(input, { llmCall: call }).catch((e: unknown) => e)) as Error;
    // The first ~160 chars are what an escalation surface records verbatim.
    const head = err.message.slice(0, 160);
    expect(head).toContain('battery judge produced');
    expect(head).toContain(`model=${RUBRIC.model}`);
    expect(head).toContain('chars=12');
    expect(err.message).toContain('refusal text');
  });

  it('flags a maxTokens-truncated object as truncated=likely (vs. a refusal, which is not)', async () => {
    const { call } = sequencedLlm([{ text: '{"d1":8,"d2":6,"d3":4,"rationale":"it started well but then' }]);
    const err = (await judgeBatteryRun(input, { llmCall: call }).catch((e: unknown) => e)) as JudgeOutputContractError;
    expect(err.looksTruncated).toBe(true);
    expect(err.message).toContain('truncated=likely');

    const { call: refusal } = sequencedLlm([{ text: 'I cannot score this.' }]);
    const err2 = (await judgeBatteryRun(input, { llmCall: refusal }).catch(
      (e: unknown) => e,
    )) as JudgeOutputContractError;
    expect(err2.looksTruncated).toBe(false);
  });

  it('reports an unrepairable WRONG SHAPE with the validator’s own complaint', async () => {
    const { call } = sequencedLlm([{ json: { d1: 'high', d2: 2, d3: 3, rationale: 'r' } }]);
    const err = (await judgeBatteryRun(input, { llmCall: call }).catch((e: unknown) => e)) as JudgeOutputContractError;
    expect(err.reason).toBe('invalid-shape');
    expect(err.validationError).toMatch(/d1/);
    expect(err.message).toMatch(/invalid shape/);
  });
});
