import { describe, it, expect } from 'vitest';
import { runAbEvaluation, type AbConfig, type AbDeps, type AbStore } from '../ab-runner';
import { runWithRatePause } from '../rate-pause';
import { GYM_JUDGE_RUBRIC_V1 } from '../judge-scoring';
import type { GymScore } from '../judge';
import type { VariantComparisonRow } from '../store';
import { LlmCallError } from '@papercusp/testing-shell/llm';
import type { TurnError } from '../../agent-chat-stream';

const rateLimited = (resetAt?: number): LlmCallError =>
  Object.assign(
    new LlmCallError({ class: 'rate_limited', message: '429 rate limited', provider: 'anthropic', retryable: true, ...(resetAt !== undefined ? { resetAt } : {}) } as TurnError),
    { costUsd: 0 }, // Explicit measured-zero evidence is required before retrying a rate-limited call.
  );

/**
 * P-014 bounded A/B harness: for each (variant × task × repeat) it runs the pipeline →
 * collects+distills → judges → stores, then derives per-task variance (ε/δ/min-n), cost,
 * and the A-vs-B comparison. Pure orchestration with injected effects, so the SEQUENCING +
 * analysis are tested with fakes (no live operator, no real agents, no real judge, no PG).
 */
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function cfg(over: Partial<AbConfig> = {}): AbConfig {
  return {
    variants: [
      { variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } },
      { variantId: 'cand-1', label: 'candidate 1', overlay: { promptOverrides: { worker: '# w2' } } },
    ],
    tasks: [
      { taskId: 'task-a', pool: 'train', repoUrl: '/repos/sub', repoCommit: COMMIT, spec: 'Add /health', intent: 'liveness probe', projectContext: 'a Hono API' },
    ],
    repeats: 2,
    rubric: GYM_JUDGE_RUBRIC_V1,
    harnessCommit: COMMIT,
    workspaceId: 'gym-ws',
    scratchRoot: '/scratch/gym',
    deriveOpts: { sigmaMultiple: 2, targetStandardError: 0.25 },
    maxDistillChars: 60_000,
    ...over,
  };
}

/** Fake store: in-memory; comparison derived from recorded scores (max composite per variant×task). */
function makeStore() {
  const variants: string[] = [];
  const tasks: string[] = [];
  const runs: Array<{ runId: string; variantId: string; taskId: string }> = [];
  const finished: string[] = [];
  const scores = new Map<string, GymScore>(); // runId → score
  const store: AbStore = {
    async upsertVariant(v) { variants.push(v.variantId); },
    async upsertTask(t) { tasks.push(t.taskId); },
    async startRun(r) { runs.push({ runId: r.runId, variantId: r.variantId, taskId: r.taskId }); },
    async finishRun(runId) { finished.push(runId); },
    async recordScore(runId, s) { scores.set(runId, s); },
    async comparison(a, b): Promise<VariantComparisonRow[]> {
      const byTask = new Map<string, { a: number | null; b: number | null }>();
      for (const run of runs) {
        const s = scores.get(run.runId);
        if (!s) continue;
        const row = byTask.get(run.taskId) ?? { a: null, b: null };
        if (run.variantId === a) row.a = Math.max(row.a ?? -Infinity, s.composite);
        if (run.variantId === b) row.b = Math.max(row.b ?? -Infinity, s.composite);
        byTask.set(run.taskId, row);
      }
      return [...byTask.entries()].map(([taskId, r]) => ({
        taskId, aComposite: r.a, bComposite: r.b, delta: r.a !== null && r.b !== null ? r.b - r.a : null,
      })).sort((x, y) => x.taskId.localeCompare(y.taskId));
    },
  };
  return { store, variants, tasks, runs, finished, scores };
}

/** Fake deps: pipeline returns a canned outcome; the judge returns scripted composites per call. */
function makeDeps(opts: { store: AbStore; composites: number[]; pipelineUsd?: number; judgeUsd?: number }) {
  const calls = { pipeline: 0, collect: 0, judge: 0 };
  let scoreIdx = 0;
  const deps: AbDeps = {
    store: opts.store,
    async runPipeline(input) {
      calls.pipeline++;
      const slug = `gym${input.variant.variantId}${input.task.taskId}r${input.repeat}`.replace(/[^a-z0-9]/g, '');
      return { harnessSlug: slug, clonePath: `${input.scratchRoot}/${slug}`, workflowID: `wf:${slug}`, outcome: 'passed', pipelineUsd: opts.pipelineUsd ?? 0.4 };
    },
    async collectAndDistill() {
      calls.collect++;
      return { distilledTrace: '## Diff\n+health()', traceRef: '/t/x.json', rawSignals: { ok: true } };
    },
    llmCall: async () => {
      const composite = opts.composites[Math.min(scoreIdx++, opts.composites.length - 1)];
      // Encode the wanted composite as equal dims so judge-scoring's weighted composite == it.
      calls.judge++;
      return { text: JSON.stringify({ d1: composite, d2: composite, d3: composite, rationale: 'fake' }), costUsd: opts.judgeUsd ?? 2.5, inputTokens: 100, outputTokens: 200 };
    },
    newRunId: (v, t, r) => `${v}:${t}:r${r}`,
    now: () => 0,
  };
  return { deps, calls };
}

describe('runAbEvaluation', () => {
  it.each([false, true])('retains canonical pipeline receipts without calling estimated/incomplete cost measured (complete=%s)', async (complete) => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [8], pipelineUsd: 0.4 });
    const run = deps.runPipeline;
    const receipt = { knownUsd: 0.4, providerUsd: 0, estimatedUsd: 0.4,
      complete, measured: false, coverageBasis: 'retained-run-output-and-usage-samples' as const,
      missingRunIds: complete ? [] : ['validator'], samples: [] };
    deps.runPipeline = async (input) => ({ ...await run(input), pipelineSpend: receipt });
    const result = await runAbEvaluation(oneVariant({ repeats: 1 }), deps);
    expect(result.outcomes[0].pipelineSpend).toEqual(receipt);
    expect(result.cost.costMeasured).toBe(false);
    expect(result.cost.totalUsd).toBeCloseTo(2.9);
    expect(result.comparison).toEqual([]);
  });

  it('stops the next paid run and withholds comparison when a repair charge is unknown', async () => {
    const { store, scores } = makeStore();
    const { deps, calls } = makeDeps({ store, composites: [8], pipelineUsd: 0.4 });
    let judgeCalls = 0;
    deps.llmCall = async () => {
      if (++judgeCalls === 2) throw new Error('charge unavailable');
      return { text: 'invalid judge output', costUsd: 0.02, inputTokens: 10, outputTokens: 5 };
    };
    const result = await runAbEvaluation(oneVariant({ repeats: 2 }), deps);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ judgeUsd: 0.02, judgeCostMeasured: false, status: 'errored' });
    expect(result.cost.costMeasured).toBe(false);
    expect(result.cost.totalUsd).toBeCloseTo(0.42);
    expect(result.comparison).toEqual([]);
    expect(calls.pipeline).toBe(1);
    expect(scores.size).toBe(0);
  });

  it('includes paid failed-judge repairs in the run, variant and total cost', async () => {
    const { store, scores } = makeStore();
    const { deps } = makeDeps({ store, composites: [8], pipelineUsd: 0.4 });
    let calls = 0;
    deps.llmCall = async () => ({
      text: ++calls <= 2 ? 'invalid judge output' : JSON.stringify({ d1: 8, d2: 8, d3: 8, rationale: 'ok' }),
      costUsd: calls <= 2 ? 0.02 : 0.03, inputTokens: 10, outputTokens: 5,
    });
    const result = await runAbEvaluation(oneVariant({ repeats: 2 }), deps);
    expect(result.outcomes.map((o) => o.status)).toEqual(['errored', 'scored']);
    expect(result.outcomes[0].judgeUsd).toBeCloseTo(0.04);
    expect(result.cost.totalUsd).toBeCloseTo(0.87);
    expect(result.cost.perVariant.baseline).toBeCloseTo(0.87);
    expect(scores.size).toBe(1);
  });

  it('runs pipeline+judge once per (variant × task × repeat) and stores each', async () => {
    const { store, runs, finished, scores, variants, tasks } = makeStore();
    const { deps, calls } = makeDeps({ store, composites: [6, 7, 8, 9] }); // baseline:6,7  cand-1:8,9
    const res = await runAbEvaluation(cfg(), deps);

    // 2 variants × 1 task × 2 repeats = 4 runs, each: pipeline → collect → judge → store.
    expect(calls.pipeline).toBe(4);
    expect(calls.collect).toBe(4);
    expect(calls.judge).toBe(4);
    expect(runs).toHaveLength(4);
    expect(finished).toHaveLength(4);
    expect(scores.size).toBe(4);
    expect(new Set(variants)).toEqual(new Set(['baseline', 'cand-1']));
    expect(tasks).toEqual(['task-a']);
    expect(res.outcomes).toHaveLength(4);
  });

  it('derives per-(variant,task) variance + thresholds from the repeat composites', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [6, 8, 8, 8] }); // baseline:{6,8}→mean7 sd1 ; cand-1:{8,8}→mean8 sd0
    const res = await runAbEvaluation(cfg(), deps);

    const base = res.perTaskVariance.find((v) => v.variantId === 'baseline' && v.taskId === 'task-a')!;
    expect(base.mean).toBeCloseTo(7);
    expect(base.sd).toBeCloseTo(1);
    expect(base.n).toBe(2);
    expect(base.epsilon).toBeCloseTo(2); // sigmaMultiple 2 × sd 1
    // minRepeats: ceil((sd/targetSE)^2) = ceil((1/0.25)^2) = 16
    expect(base.minRepeats).toBe(16);

    const cand = res.perTaskVariance.find((v) => v.variantId === 'cand-1' && v.taskId === 'task-a')!;
    expect(cand.sd).toBeCloseTo(0);
    expect(cand.minRepeats).toBe(1); // zero variance → 1 repeat suffices
  });

  it('aggregates cost (pipeline + judge) per run and overall', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [7, 7, 7, 7], pipelineUsd: 0.4, judgeUsd: 2.5 });
    const res = await runAbEvaluation(cfg(), deps);
    // 4 runs × (0.4 + 2.5) = 11.6 total; mean 2.9.
    expect(res.cost.totalUsd).toBeCloseTo(11.6);
    expect(res.cost.meanRunUsd).toBeCloseTo(2.9);
    expect(res.cost.perVariant['baseline']).toBeCloseTo(5.8);
    expect(res.cost.perVariant['cand-1']).toBeCloseTo(5.8);
  });

  it('produces the A-vs-B comparison (baseline vs candidate, signed delta)', async () => {
    const { store } = makeStore();
    const { deps } = makeDeps({ store, composites: [6, 6, 9, 9] }); // baseline max 6, cand-1 max 9
    const res = await runAbEvaluation(cfg(), deps);
    expect(res.comparison).toEqual([{ taskId: 'task-a', aComposite: 6, bComposite: 9, delta: 3 }]);
  });
});

/**
 * RB-006 — a rate-limited (or otherwise failed) turn must PAUSE+RESUME (near reset) or be
 * RECORDED + skipped (far reset / non-rate error), never abort the whole A/B run. Fake clock +
 * fake llmCall that throws `LlmCallError` on chosen judge calls.
 */
function makeFailingDeps(opts: {
  store: AbStore;
  composite?: number;
  throwOnCall?: (call: number) => Error | null; // 1-based judge-call index → Error to throw, or null
}) {
  const calls = { pipeline: 0, collect: 0, judge: 0, sleep: 0 };
  const clock = { t: 0 };
  const composite = opts.composite ?? 7;
  const deps: AbDeps = {
    store: opts.store,
    async runPipeline(input) {
      calls.pipeline++;
      const slug = `gym${input.variant.variantId}${input.task.taskId}r${input.repeat}`.replace(/[^a-z0-9]/g, '');
      return { harnessSlug: slug, clonePath: `${input.scratchRoot}/${slug}`, workflowID: `wf:${slug}`, outcome: 'passed', pipelineUsd: 0.4 };
    },
    async collectAndDistill() {
      calls.collect++;
      return { distilledTrace: '## Diff\n+health()', traceRef: '/t/x.json', rawSignals: { ok: true } };
    },
    llmCall: async () => {
      calls.judge++;
      const err = opts.throwOnCall?.(calls.judge);
      if (err) throw Object.assign(err, { costUsd: 0 }); // this fixture models a known, uncharged failure
      return { text: JSON.stringify({ d1: composite, d2: composite, d3: composite, rationale: 'ok' }), costUsd: 2.5, inputTokens: 100, outputTokens: 200 };
    },
    newRunId: (v, t, r) => `${v}:${t}:r${r}`,
    now: () => clock.t,
    sleep: async (ms) => { calls.sleep++; clock.t += ms; },
  };
  return { deps, calls, clock };
}

const oneVariant = (over: Partial<AbConfig> = {}): AbConfig =>
  cfg({ variants: [{ variantId: 'baseline', label: 'baseline', overlay: { promptOverrides: {} } }], ...over });

describe('runAbEvaluation — RB-006 never-crash + pause/resume', () => {
  it('PAUSES then RESUMES a near-reset rate-limited judge → run is scored normally', async () => {
    const { store } = makeStore();
    // First judge call rate-limited with a reset 1s out; retry succeeds.
    const { deps, calls } = makeFailingDeps({ store, composite: 8, throwOnCall: (n) => (n === 1 ? rateLimited(1000) : null) });
    const res = await runAbEvaluation(oneVariant({ repeats: 1 }), deps);

    expect(calls.judge).toBe(2); // initial (429) + 1 resumed retry
    expect(calls.sleep).toBe(1); // waited out the reset
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0].status).toBe('scored');
    expect(res.outcomes[0].composite).toBeCloseTo(8);
  });

  it('records a FAR-off-reset rate-limit as rate_limited and CONTINUES the A/B (no abort)', async () => {
    const { store } = makeStore();
    // Run #1 (judge call 1) rate-limited with a reset ~11 days out (> maxPause) → recorded; run #2 scored.
    const { deps, calls } = makeFailingDeps({ store, composite: 6, throwOnCall: (n) => (n === 1 ? rateLimited(1_000_000_000) : null) });
    const res = await runAbEvaluation(oneVariant({ repeats: 2 }), deps);

    expect(calls.judge).toBe(2); // far reset → no retry on run #1; run #2 succeeds
    expect(calls.sleep).toBe(0);
    expect(res.outcomes).toHaveLength(2);
    expect(res.outcomes[0].status).toBe('rate_limited');
    expect(res.outcomes[1].status).toBe('scored');
    // Non-scored run is EXCLUDED from variance (only the 1 scored run counts).
    const v = res.perTaskVariance.find((x) => x.variantId === 'baseline' && x.taskId === 'task-a')!;
    expect(v.n).toBe(1);
  });

  it('records a NON-rate judge error as errored and continues (never crashes the run)', async () => {
    const { store } = makeStore();
    const { deps, calls } = makeFailingDeps({ store, composite: 5, throwOnCall: (n) => (n === 1 ? new Error('judge boom') : null) });
    const res = await runAbEvaluation(oneVariant({ repeats: 2 }), deps);

    expect(calls.judge).toBe(2); // non-rate → immediate rethrow, no retry; run #2 ok
    expect(res.outcomes[0].status).toBe('errored');
    expect(res.outcomes[0].error).toBe('judge boom');
    expect(res.outcomes[1].status).toBe('scored');
  });

  it('a pipeline failure (not the judge) is also recorded, not thrown', async () => {
    const { store } = makeStore();
    const { deps } = makeFailingDeps({ store });
    deps.runPipeline = async () => { throw new Error('clone failed'); };
    const res = await runAbEvaluation(oneVariant({ repeats: 1 }), deps);
    expect(res.outcomes).toHaveLength(1);
    expect(res.outcomes[0].status).toBe('errored');
    expect(res.outcomes[0].error).toBe('clone failed');
  });
});

describe('runWithRatePause', () => {
  const okScore: GymScore = {
    d1: 7, d2: 7, d3: 7, composite: 7, rationale: 'x', judgeModel: 'm', rubricHash: 'h', judgeTemp: 0,
    weights: { d1: 1, d2: 1, d3: 1 }, costUsd: 0, inputTokens: 0, outputTokens: 0,
  };

  it('returns immediately on success (no sleep)', async () => {
    let slept = 0;
    const r = await runWithRatePause(async () => okScore, { now: () => 0, sleep: async (ms) => { slept += ms; } });
    expect(r.composite).toBe(7);
    expect(slept).toBe(0);
  });

  it('waits out a near reset then resumes', async () => {
    let clock = 0;
    let n = 0;
    const r = await runWithRatePause(
      async () => { if (n++ === 0) throw rateLimited(5000); return okScore; },
      { now: () => clock, sleep: async (ms) => { clock += ms; } },
    );
    expect(r.composite).toBe(7);
    expect(clock).toBe(5000);
  });

  it('rethrows a far-off reset WITHOUT retrying (caller records rate_limited)', async () => {
    let n = 0;
    await expect(
      runWithRatePause(async () => { n++; throw rateLimited(1_000_000_000); }, { now: () => 0, sleep: async () => {}, maxPauseMs: 60_000 }),
    ).rejects.toThrow(LlmCallError);
    expect(n).toBe(1); // no retry
  });

  it('rethrows a non-rate error immediately', async () => {
    let n = 0;
    await expect(
      runWithRatePause(async () => { n++; throw new Error('permanent'); }, { now: () => 0, sleep: async () => {} }),
    ).rejects.toThrow('permanent');
    expect(n).toBe(1);
  });

  it('gives up after maxRetries of persistent near-reset rate limits', async () => {
    let n = 0;
    let clock = 0;
    await expect(
      runWithRatePause(async () => { n++; throw rateLimited(clock + 100); }, { now: () => clock, sleep: async (ms) => { clock += ms; }, maxRetries: 3 }),
    ).rejects.toThrow(LlmCallError);
    expect(n).toBe(4); // initial + 3 retries
  });

  it('fires onPause/onReset around each pause; a hook throw never breaks the pause (await-event P-010)', async () => {
    let n = 0;
    let clock = 0;
    const pauses: Array<{ waitMs: number; attempt: number }> = [];
    const resets: Array<{ waitedMs: number; attempt: number }> = [];
    const r = await runWithRatePause(
      async () => { if (n++ === 0) throw rateLimited(3000); return okScore; },
      {
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        onPause: (i) => { pauses.push(i); throw new Error('hook boom'); },
        onReset: (i) => { resets.push(i); },
      },
    );
    expect(r.composite).toBe(7);
    expect(pauses).toEqual([{ waitMs: 3000, attempt: 0 }]);
    expect(resets).toEqual([{ waitedMs: 3000, attempt: 0 }]);
  });
});
