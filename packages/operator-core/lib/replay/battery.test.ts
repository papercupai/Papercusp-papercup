/**
 * battery.test.ts — runReplayBattery end-to-end with FAKES (P-020 / FB-06):
 * fake runner, fake judge LLM, in-memory store; zero network/PG. Pins the
 * deterministic seams (same inputs ⇒ same result), the zero-cost historical
 * baseline echo, the divergence rawSignals, the store lifecycle, the
 * compareArms ranking, and the high-water budget cutoff.
 */
import { describe, expect, it } from 'vitest';
import { BASELINE_ID, type JudgeLlmCall } from '@papercusp/eval-battery';
import {
  REPLAY_BASELINE_VARIANT,
  buildReplaySystemPrompt,
  contextTextForCase,
  continuationTextForCase,
  runReplayBattery,
  type ReplayBatteryConfig,
} from './battery';
import { parseTranscriptJsonl } from './transcript';
import type { ReplayCase, ReplayRunner, ReplayStore, ReplayVariant } from './types';

const transcript = parseTranscriptJsonl(
  [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the flaky auth test' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Re-running the suite blindly five times.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Still flaky. Giving up and skipping the test.' }] },
    }),
  ].join('\n'),
  'logs/1777-worker.jsonl',
);

const historicalCase: ReplayCase = {
  kind: 'historical',
  caseId: 'case-auth',
  transcript,
  turnIndex: 1,
  projectContext: 'auth service repo',
};

const syntheticCase: ReplayCase = {
  kind: 'synthetic',
  caseId: 'case-syn',
  context: 'You are mid-task: the build is red after a dependency bump.',
  intent: 'Get the build green',
};

const candidate: ReplayVariant = {
  variantId: 'candidate-1',
  label: 'pin the mock clock rule',
  policy: { systemOverlay: 'Always pin time-dependent mocks before retrying flaky tests.' },
};

/** Judge fake: candidate continuations score higher than the baseline. */
const fakeJudge: JudgeLlmCall = async ({ messages }) => {
  const user = messages[0]?.content ?? '';
  const isCandidate = user.includes(`variant: ${candidate.label}`);
  const score = isCandidate ? { d1: 9, d2: 8, d3: 9 } : { d1: 4, d2: 4, d3: 5 };
  return {
    text: JSON.stringify({ ...score, rationale: isCandidate ? 'fixed the root cause' : 'thrash then skip' }),
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 20,
  };
};

function fakeRunner(calls: Array<{ systemPrompt: string; contextText: string }>): ReplayRunner {
  return async (input) => {
    calls.push({ systemPrompt: input.systemPrompt, contextText: input.contextText });
    return {
      outputText: 'Pinning the mock clock, then one re-run: green. Root cause documented.',
      costUsd: 0.05,
      inputTokens: 500,
      outputTokens: 80,
      replayed: true,
    };
  };
}

interface StoreEvent {
  kind: string;
  runId: string;
  payload?: unknown;
}

function memoryStore(events: StoreEvent[]): ReplayStore {
  return {
    async startRun(r) {
      events.push({ kind: 'start', runId: r.runId, payload: { batteryId: r.batteryId, variantId: r.variant.variantId } });
    },
    async finishRun(runId, fields) {
      events.push({ kind: 'finish', runId, payload: fields });
    },
    async recordScore(runId, score) {
      events.push({ kind: 'score', runId, payload: score });
    },
    async markFailed(runId, fields) {
      events.push({ kind: 'failed', runId, payload: fields });
    },
  };
}

function config(overrides: Partial<ReplayBatteryConfig> = {}): ReplayBatteryConfig {
  return {
    batteryId: 'bat-1',
    variants: [REPLAY_BASELINE_VARIANT, candidate],
    cases: [historicalCase],
    repeats: 1,
    ...overrides,
  };
}

describe('runReplayBattery — historical case with baseline anchor', () => {
  it('echoes the baseline at zero cost, replays the candidate, scores both, ranks the winner', async () => {
    const runnerCalls: Array<{ systemPrompt: string; contextText: string }> = [];
    const events: StoreEvent[] = [];
    const result = await runReplayBattery(config(), {
      runner: fakeRunner(runnerCalls),
      llmCall: fakeJudge,
      store: memoryStore(events),
      now: () => 1000,
    });

    // Baseline: no runner invocation, zero run cost, not replayed.
    expect(runnerCalls).toHaveLength(1); // candidate only
    const baseline = result.outcomes.find((o) => o.variantId === BASELINE_ID)!;
    expect(baseline).toMatchObject({ status: 'scored', runUsd: 0, replayed: false });
    expect(baseline.composite).toBeCloseTo(4.2, 5); // 0.5*4 + 0.3*4 + 0.2*5

    // Candidate: replayed, run cost recorded, divergence computed.
    const cand = result.outcomes.find((o) => o.variantId === 'candidate-1')!;
    expect(cand).toMatchObject({ status: 'scored', runUsd: 0.05, replayed: true });
    expect(cand.divergence).not.toBeNull();
    expect(cand.divergence!.divergent).toBe(true);
    // Baseline echo diverges from itself not at all.
    expect(baseline.divergence!.tokenJaccard).toBe(1);

    // The runner saw the variant's policy and the context BEFORE the cut.
    expect(runnerCalls[0].systemPrompt).toContain('Always pin time-dependent mocks');
    expect(runnerCalls[0].contextText).toContain('Fix the flaky auth test');
    expect(runnerCalls[0].contextText).not.toContain('Giving up');

    // Aggregates + comparison: candidate beats baseline on the judge composite.
    expect(result.perVariant.map((v) => v.variantId)).toEqual([BASELINE_ID, 'candidate-1']);
    expect(result.comparison?.selected).toBe('candidate-1');
    expect(result.comparison?.candidates[0]?.primaryImprovement).toBeCloseTo(4.5, 5);

    // Store lifecycle: start + finish + score per cell, no failures.
    expect(events.filter((e) => e.kind === 'start')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'finish')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'score')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'failed')).toHaveLength(0);

    // Spend: candidate run 0.05 + 2 judge calls at 0.01.
    expect(result.totalCostUsd).toBeCloseTo(0.07, 10);
    expect(result.budgetExhausted).toBe(false);
  });

  it('is deterministic: same inputs ⇒ same result object', async () => {
    const run = () =>
      runReplayBattery(config(), {
        runner: fakeRunner([]),
        llmCall: fakeJudge,
        now: () => 1000,
      });
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Default run ids are deterministic too (resume-friendly).
    expect(a.outcomes.map((o) => o.runId)).toEqual(['bat-1:baseline:case-auth:r0', 'bat-1:candidate-1:case-auth:r0']);
  });

  it('matched historical comparisons run both arms on the same student/context and charge both', async () => {
    const runnerCalls: Array<{ systemPrompt: string; contextText: string }> = [];
    const events: StoreEvent[] = [];
    const result = await runReplayBattery(config({ baselineMode: 'matched' }), {
      runner: fakeRunner(runnerCalls), llmCall: fakeJudge, store: memoryStore(events), now: () => 1000,
    });
    expect(runnerCalls).toHaveLength(2);
    expect(runnerCalls[0].contextText).toBe(runnerCalls[1].contextText);
    expect(runnerCalls[0].systemPrompt).toBe(buildReplaySystemPrompt(REPLAY_BASELINE_VARIANT));
    expect(runnerCalls[1].systemPrompt).toBe(buildReplaySystemPrompt(candidate));
    expect(result.outcomes.map((outcome) => [outcome.variantId, outcome.status, outcome.replayed]))
      .toEqual([[BASELINE_ID, 'scored', true], ['candidate-1', 'scored', true]]);
    expect(result.totalCostUsd).toBeCloseTo(0.12);
    expect(events.filter((event) => event.kind === 'score')).toHaveLength(2);
    expect(result.comparison?.selected).toBe(candidate.variantId);
  });

  it('matched baseline spending respects the existing cap and leaves a refused challenger unscored', async () => {
    const runnerCalls: Array<{ systemPrompt: string; contextText: string }> = [];
    const result = await runReplayBattery(config({ baselineMode: 'matched', maxSpendUsd: 0.06 }), {
      runner: fakeRunner(runnerCalls), llmCall: fakeJudge, now: () => 1000,
    });
    expect(runnerCalls).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ variantId: BASELINE_ID, status: 'scored', replayed: true });
    expect(result.outcomes[1]).toMatchObject({ variantId: candidate.variantId, status: 'errored' });
    expect(result.budgetExhausted).toBe(true);
    expect(result.perVariant.find((variant) => variant.variantId === candidate.variantId)?.scored).toBe(0);
    expect(result.comparison?.selected).toBeUndefined();
  });
});

describe('runReplayBattery — synthetic case', () => {
  it('runs every variant through the runner (no anchor echo), divergence null', async () => {
    const runnerCalls: Array<{ systemPrompt: string; contextText: string }> = [];
    const result = await runReplayBattery(config({ cases: [syntheticCase], variants: [REPLAY_BASELINE_VARIANT, candidate] }), {
      runner: fakeRunner(runnerCalls),
      llmCall: fakeJudge,
      now: () => 1000,
    });
    expect(runnerCalls).toHaveLength(2); // baseline has no historical continuation to echo
    for (const o of result.outcomes) expect(o.divergence).toBeNull();
    expect(result.comparison).not.toBeNull();
  });

  it('persists the runner cost and measured replay elapsed time at the finish writer seam', async () => {
    const events: StoreEvent[] = [];
    const clock = [1000, 1125, 1125, 1125];
    const result = await runReplayBattery(config({ cases: [syntheticCase], variants: [candidate] }), {
      runner: fakeRunner([]),
      llmCall: fakeJudge,
      store: memoryStore(events),
      now: () => clock.shift() ?? 1125,
    });

    expect(result.outcomes[0]).toMatchObject({ status: 'scored', runUsd: 0.05 });
    const finish = events.find((e) => e.kind === 'finish');
    expect(finish?.payload).toMatchObject({ costUsd: 0.05, elapsedMs: 125 });
    // A zero-cost/zero-duration writer would hide a real replay's measured spend or latency.
    expect((finish?.payload as { costUsd: number }).costUsd).toBeGreaterThan(0);
    expect((finish?.payload as { elapsedMs: number }).elapsedMs).toBeGreaterThan(0);
  });
});

describe('runReplayBattery — budget cutoff', () => {
  it('counts failed judge repairs against the next cell budget', async () => {
    const calls: Array<{ systemPrompt: string; contextText: string }> = [];
    const result = await runReplayBattery(config({ variants: [candidate], cases: [syntheticCase], repeats: 2, maxSpendUsd: 0.06 }), {
      runner: fakeRunner(calls), now: () => 1000,
      llmCall: async () => ({ text: 'invalid', costUsd: 0.01, inputTokens: 1, outputTokens: 1 }),
    });
    expect(calls).toHaveLength(1);
    expect(result.totalCostUsd).toBeCloseTo(0.07);
    expect(result.costMeasured).toBe(true);
    expect(result.outcomes[1].error).toContain('replay budget cap reached');
  });

  it('refuses further spending after an unmeasured judge charge', async () => {
    const calls: Array<{ systemPrompt: string; contextText: string }> = [];
    const result = await runReplayBattery(config({ variants: [candidate], cases: [syntheticCase], repeats: 2 }), {
      runner: fakeRunner(calls), now: () => 1000,
      llmCall: async () => { throw new Error('unknown transport charge'); },
    });
    expect(calls).toHaveLength(1);
    expect(result.totalCostUsd).toBe(0.05);
    expect(result.costMeasured).toBe(false);
    expect(result.outcomes[1].error).toContain('remaining cells refused before spending');
  });

  it('refuses cells past the high-water cap before spending, records them errored', async () => {
    const runnerCalls: Array<{ systemPrompt: string; contextText: string }> = [];
    const events: StoreEvent[] = [];
    // Two repeats: baseline echo r0+r1 (judge 0.01 each ⇒ spent 0.02), candidate r0
    // (run 0.05 + judge 0.01 ⇒ spent 0.08 ≥ cap 0.06) ⇒ candidate r1 refused.
    const result = await runReplayBattery(config({ repeats: 2, maxSpendUsd: 0.06 }), {
      runner: fakeRunner(runnerCalls),
      llmCall: fakeJudge,
      store: memoryStore(events),
      now: () => 1000,
    });

    expect(runnerCalls).toHaveLength(1); // the refused cell never reached the runner
    const refused = result.outcomes.filter((o) => o.status === 'errored');
    expect(refused).toHaveLength(1);
    expect(refused[0].variantId).toBe('candidate-1');
    expect(refused[0].error).toMatch(/replay budget cap reached/);
    expect(result.budgetExhausted).toBe(true);
    // The refusal is persisted (markFailed), never silently dropped.
    expect(events.filter((e) => e.kind === 'failed')).toHaveLength(1);
    // Scored cells still aggregate normally.
    expect(result.perVariant.find((v) => v.variantId === 'candidate-1')?.scored).toBe(1);
  });
});

describe('prompt/context helpers', () => {
  it('buildReplaySystemPrompt: overlay appends, replace wins', () => {
    expect(buildReplaySystemPrompt(candidate)).toContain('## Policy under test');
    expect(
      buildReplaySystemPrompt({ variantId: 'x', label: 'x', policy: { systemReplace: 'ONLY THIS' } }),
    ).toBe('ONLY THIS');
    expect(buildReplaySystemPrompt(REPLAY_BASELINE_VARIANT)).not.toContain('## Policy under test');
  });

  it('contextTextForCase/continuationTextForCase split at the cut', () => {
    const ctx = contextTextForCase(historicalCase, 10_000);
    const cont = continuationTextForCase(historicalCase, 10_000)!;
    expect(ctx).toContain('Fix the flaky auth test');
    expect(cont).toContain('Re-running the suite blindly');
    expect(ctx).not.toContain('Re-running the suite blindly');
    expect(continuationTextForCase(syntheticCase, 10_000)).toBeNull();
  });
});
