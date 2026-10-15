/**
 * The one eval-battery engine (`runBattery`) — the shared per-cell discipline factored
 * out of the gym + apiary loops (reconciliation D-001). All effects injected: a fake
 * Subject + fake judge llmCall + fake clock, zero network/PG.
 */
import { describe, it, expect } from 'vitest';
import { runBattery, type BatteryCell } from './battery';
import type { Subject } from './subject';
import type { JudgeLlmCall } from './judge';
import type { BatteryRubric } from './scoring';
import { LlmCallError } from '@papercusp/testing-shell/llm';

interface Cell {
  variant: string;
  caseId: string;
}
interface Handle {
  label: string;
}

const RUBRIC: BatteryRubric = {
  version: 'v1',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 1000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: { d1: 'a', d2: 'b', d3: 'c' },
};

const cells = (...specs: Array<[string, string]>): BatteryCell<Cell>[] =>
  specs.map(([variant, caseId], i) => ({ runId: `run-${i}`, cell: { variant, caseId } }));

const okJudge: JudgeLlmCall = async () => ({
  text: '',
  json: { d1: 8, d2: 6, d3: 4, rationale: 'ok' },
  costUsd: 0.1,
  inputTokens: 10,
  outputTokens: 5,
});

function fakeSubject(over: Partial<Subject<Cell, Handle>> = {}): Subject<Cell, Handle> {
  return {
    run: async (cell) => ({ label: `${cell.variant}/${cell.caseId}` }),
    collectAndDistill: async ({ cell }) => ({
      distilledTrace: `trace ${cell.caseId}`,
      traceRef: `ref:${cell.caseId}`,
      rawSignals: { ok: true },
    }),
    judgeInput: (cell) => ({ intent: `intent ${cell.caseId}`, projectContext: '' }),
    ...over,
  };
}

function clock() {
  let t = 0;
  return { now: () => (t += 1), sleep: async () => {} };
}

describe('runBattery — happy path', () => {
  it('scores every cell and threads handle + score, sequentially', async () => {
    const seen: string[] = [];
    const subject = fakeSubject({
      run: async (cell) => {
        seen.push(`run:${cell.caseId}`);
        return { label: cell.caseId };
      },
    });
    const results = await runBattery({ cells: cells(['a', 'c1'], ['a', 'c2']), rubric: RUBRIC, maxDistillChars: 100 }, { subject, llmCall: okJudge, ...clock() });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'scored')).toBe(true);
    expect(results[0].score?.d1).toBe(8);
    expect(results[0].handle?.label).toBe('c1');
    expect(seen).toEqual(['run:c1', 'run:c2']); // sequential, in order
  });

  it('calls lifecycle hooks (onStart → onFinish → collectMetrics → onScore) in order', async () => {
    const order: string[] = [];
    const subject = fakeSubject();
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      {
        subject,
        llmCall: okJudge,
        ...clock(),
        hooks: {
          onStart: () => void order.push('start'),
          onFinish: ({ elapsedMs }) => void order.push(`finish:${elapsedMs >= 0}`),
          collectMetrics: async () => {
            order.push('metrics');
            return { tokens: 42 };
          },
          onScore: ({ metrics }) => void order.push(`score:${(metrics as { tokens: number }).tokens}`),
        },
      },
    );
    expect(order).toEqual(['start', 'finish:true', 'metrics', 'score:42']);
    expect(results[0].metrics).toEqual({ tokens: 42 });
  });
});

describe('runBattery — never abort', () => {
  it.each(['throw', 'reply'] as const)('governed callers stop attempts, scores and cells on an unmeasured %s', async (mode) => {
    let runs = 0;
    let calls = 0;
    let scores = 0;
    const results = await runBattery(
      { cells: cells(['a', 'c1'], ['a', 'c2']), rubric: RUBRIC, maxDistillChars: 100, stopOnUnmeasuredJudgeCost: true },
      { subject: fakeSubject({ run: async () => ({ label: String(++runs) }) }), ...clock(),
        llmCall: async (opts) => { calls++; if (mode === 'throw') throw new Error('unknown charge'); return { ...await okJudge(opts), costUsd: NaN }; },
        hooks: { onScore: () => { scores++; } },
      },
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'errored', judgeCostMeasured: false, judgeCostUsd: 0 });
    expect({ runs, calls, scores }).toEqual({ runs: 1, calls: 1, scores: 0 });
  });

  it('continues governed cells after a measured failure and retains its charge', async () => {
    let calls = 0;
    const results = await runBattery(
      { cells: cells(['a', 'c1'], ['a', 'c2']), rubric: RUBRIC, maxDistillChars: 100, stopOnUnmeasuredJudgeCost: true },
      { subject: fakeSubject(), ...clock(), llmCall: async (opts) => {
        if (++calls === 1) throw Object.assign(new Error('charged failure'), { costUsd: 0.03 });
        return okJudge(opts);
      } },
    );
    expect(results.map((r) => r.status)).toEqual(['errored', 'scored']);
    expect(results.map((r) => r.judgeCostUsd)).toEqual([0.03, 0.1]);
  });

  it('preserves measured charges when judge repair replies never satisfy the output contract', async () => {
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      { subject: fakeSubject(), ...clock(), llmCall: async () => ({
        text: 'invalid fixture reply', costUsd: 0.02, inputTokens: 1, outputTokens: 1,
      }) },
    );
    expect(results[0]).toMatchObject({ status: 'errored', judgeCostUsd: 0.04, judgeCostMeasured: true });
  });

  it.each([undefined, 0.03])('preserves the distinction between unknown and measured thrown charges (%s)', async (costUsd) => {
    const error = Object.assign(new Error('judge transport failed'), costUsd === undefined ? {} : { costUsd });
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      { subject: fakeSubject(), ...clock(), llmCall: async () => { throw error; } },
    );
    expect(results[0]).toMatchObject({ status: 'errored', judgeCostUsd: costUsd ?? 0, judgeCostMeasured: costUsd !== undefined });
  });

  it.each([0, 0.02])('preserves a prior measured charge of %s when deciding whether to restart a rate-limited judgment', async (priorCost) => {
    let calls = 0;
    const slept: number[] = [];
    const scored: string[] = [];
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      { subject: fakeSubject(), now: () => 1, sleep: async (ms) => { slept.push(ms); }, llmCall: async (opts) => {
        if (++calls === 1) return { text: 'invalid reply', costUsd: priorCost, inputTokens: 1, outputTokens: 1 };
        if (calls === 2) throw Object.assign(new LlmCallError({ class: 'rate_limited', message: 'limited', retryAfterMs: 1 }), { costUsd: 0 });
        return { ...await okJudge(opts), costUsd: 0.03 };
      }, hooks: { onScore: ({ runId }) => { scored.push(runId); } } },
    );
    expect(results).toHaveLength(1);
    if (priorCost === 0) {
      expect(calls).toBe(3);
      expect(slept).toEqual([1]);
      expect(scored).toEqual(['run-0']);
      expect(results[0]).toMatchObject({ status: 'scored', judgeCostUsd: 0.03, judgeCostMeasured: true,
        score: { costUsd: 0.03 } });
    } else {
      expect(calls).toBe(2);
      expect(slept).toEqual([]);
      expect(scored).toEqual([]);
      expect(results[0]).toMatchObject({ status: 'rate_limited', judgeCostUsd: priorCost, judgeCostMeasured: true });
      expect(results[0].score).toBeUndefined();
    }
  });

  it('records a run error as `errored` and continues to the next cell', async () => {
    // Ordinary subject errors still use the engine's independent-cell policy.
    const subject = fakeSubject({
      run: async (cell) => {
        if (cell.caseId === 'c1') throw new Error('boom on c1');
        return { label: cell.caseId };
      },
    });
    const results = await runBattery({ cells: cells(['a', 'c1'], ['a', 'c2']), rubric: RUBRIC, maxDistillChars: 100 }, { subject, llmCall: okJudge, ...clock() });
    expect(results[0].status).toBe('errored');
    expect(results[0].error).toContain('boom on c1');
    expect(results[1].status).toBe('scored'); // continued
  });

  it('classifies a persistent judge rate-limit as `rate_limited` (default classifier)', async () => {
    const subject = fakeSubject();
    const rlJudge: JudgeLlmCall = async () => {
      throw new LlmCallError({ class: 'rate_limited', message: 'limited', retryAfterMs: 1 });
    };
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      { subject, llmCall: rlJudge, now: () => 1, sleep: async () => {} },
    );
    expect(results[0].status).toBe('rate_limited');
  });

  it('honors an injected classifyRateLimited (string-matcher) for a plain Error', async () => {
    const subject = fakeSubject({
      run: async () => {
        throw new Error('429 rate_limit exceeded');
      },
    });
    const results = await runBattery(
      { cells: cells(['a', 'c1']), rubric: RUBRIC, maxDistillChars: 100 },
      {
        subject,
        llmCall: okJudge,
        ...clock(),
        classifyRateLimited: (e) => e instanceof Error && e.message.includes('rate_limit'),
      },
    );
    expect(results[0].status).toBe('rate_limited');
  });
});
