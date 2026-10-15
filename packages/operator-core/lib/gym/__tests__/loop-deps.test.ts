/**
 * Unit tests for buildLoopDeps (loop-deps.ts) — the real LoopDeps builder for the
 * autonomous loop's runner service (P-022 / D-020). The per-run engine, the judge, and
 * the proposer are all injected fakes, so the POOL→VariantEval aggregation, the worst-trace
 * selection, and the persist/record seams are verified with zero LLM / no PG / no operator.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import { buildLoopDeps, type LoopTask } from '../loop-deps';
import { composite, GYM_JUDGE_RUBRIC_V1, rubricHash } from '../judge-scoring';
import type { AbDeps } from '../ab-runner';
import type { JudgeLlmCall } from '../judge';
import type { GymLlmCall } from '../task-generator';
import { createCandidateVersionVerdict, type LoopProposalRecord } from '../loop';

const PIPELINE_USD = 0.5;
const JUDGE_USD = 0.1;
const expComposite = (v: number): number => composite({ d1: v, d2: v, d3: v }, GYM_JUDGE_RUBRIC_V1.weights);

/** A fake per-run engine: deterministic handle + injectable per-task signals. */
function fakeAbDeps(signalsByTask: Record<string, unknown>): AbDeps {
  return {
    store: {
      upsertVariant: async () => {},
      upsertTask: async () => {},
      startRun: async () => {},
      finishRun: async () => {},
      recordScore: async () => {},
      comparison: async () => [],
    },
    runPipeline: async (input) => ({
      harnessSlug: `h${input.task.taskId.replace(/[^a-z0-9]/g, '')}`,
      clonePath: `/tmp/${input.task.taskId}`,
      workflowID: `wf-${input.task.taskId}`,
      outcome: 'completed',
      pipelineUsd: PIPELINE_USD,
    }),
    collectAndDistill: async ({ task }) => ({
      distilledTrace: `distilled trace for ${task.taskId}`,
      traceRef: `ref-${task.taskId}`,
      rawSignals: signalsByTask[task.taskId] ?? {},
    }),
    llmCall: (async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 })) as JudgeLlmCall,
    newRunId: (v, t, r) => `${v}::${t}::${r}`,
    now: () => 0,
  };
}

/** A fake judge: reads `score:N` out of the task intent (carried in the prompt) → d1=d2=d3=N. */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const content = opts.messages.map((m) => m.content).join('\n');
  const m = /score:(\d+)/.exec(content);
  const v = m ? Number(m[1]) : 5;
  return { text: JSON.stringify({ d1: v, d2: v, d3: v, rationale: `rationale-${v}` }), costUsd: JUDGE_USD, inputTokens: 1, outputTokens: 1 };
};

const TASKS: LoopTask[] = [
  { taskId: 't-train-lo', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:2', projectContext: 'p' },
  { taskId: 't-train-hi', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:8', projectContext: 'p' },
  { taskId: 't-dev', pool: 'dev-anchor', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:6', projectContext: 'p' },
  { taskId: 't-probe', pool: 'probe', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:5', projectContext: 'p' },
];

/**
 * Signals for a FULLY INSTRUMENTED run: every task reports `regressions`, and the probe
 * task reports `planted_bug_caught`. P-003 made this explicit — under three-state
 * evidence an absent key is `not-measured`, so a fixture that omits a signal is
 * asserting "this run never reported it", which is a different scenario from a clean run.
 */
const ALL_MEASURED: Record<string, unknown> = {
  't-train-lo': { regressions: false },
  't-train-hi': { regressions: false },
  't-dev': { regressions: false },
  't-probe': { regressions: false, planted_bug_caught: true },
};

/** A tagged-template Sql stub recording the statements persistCycle issues,
 *  and (WI-5799) their interpolated values so id-shape can be asserted. */
function fakeSql(sink: string[], valueSink?: unknown[][]): Sql {
  return ((strings: TemplateStringsArray, ...values: unknown[]) => {
    sink.push(strings.join('?'));
    valueSink?.push(values);
    return Promise.resolve([]);
  }) as unknown as Sql;
}

function makeDeps(over: Partial<Parameters<typeof buildLoopDeps>[0]> = {}, signals: Record<string, unknown> = {}) {
  const sqlSink: string[] = [];
  const sqlValues: unknown[][] = [];
  const proposals: LoopProposalRecord[] = [];
  const proposerCalls: Array<{ system: string; user: string }> = [];
  const proposerCall: GymLlmCall = async (opts) => {
    proposerCalls.push({ system: opts.system ?? '', user: opts.messages.map((m) => m.content).join('\n') });
    return {
      text: JSON.stringify({ promptOverrides: { worker: '# Worker\nre-read acceptance' }, rationale: 'targets the low-score train task' }),
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  };
  const config: Parameters<typeof buildLoopDeps>[0] = {
    gymSql: fakeSql(sqlSink, sqlValues),
    ports: {} as never,
    judgeCall: fakeJudge,
    proposerCall,
    proposerModel: 'claude-sonnet-4-6',
    tasks: TASKS,
    baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
    harnessCommit: 'abc',
    workspaceId: 'gym-ws',
    scratchRoot: '/tmp/scratch',
    timeoutMs: 1000,
    pollIntervalMs: 10,
    maxDistillChars: 10_000,
    abDeps: fakeAbDeps(signals),
    recordProposal: async (rec) => {
      proposals.push(rec);
    },
    ...over,
  };
  const deps = buildLoopDeps(config);
  return { deps, sqlSink, sqlValues, proposals, proposerCalls, config };
}

describe('buildLoopDeps.evaluate — pool → VariantEval aggregation', () => {
  it.each([
    { costUsdMeasurementMissing: true },
    { unreportedFrames: 2 },
  ])('stops after an incomplete judge receipt and retains the known subtotal %j', async evidence => {
    const ab = fakeAbDeps(ALL_MEASURED);
    const runPipeline = ab.runPipeline;
    let pipelines = 0;
    let scored = 0;
    ab.runPipeline = async input => { pipelines++; return runPipeline(input); };
    ab.store.recordScore = async () => { scored++; };
    const { deps } = makeDeps({ abDeps: ab, judgeCall: async opts => ({ ...await fakeJudge(opts), ...evidence }) });
    await expect(deps.evaluate('baseline', { promptOverrides: {} })).rejects.toMatchObject({
      costUsd: PIPELINE_USD + JUDGE_USD, costUsdMeasurementMissing: true,
      ...(evidence.unreportedFrames ? { unreportedFrames: 2 } : {}),
    });
    expect(pipelines).toBe(1);
    expect(scored).toBe(0);
  });

  it('retains every judge repair charge in a partial evaluation failure', async () => {
    const { deps } = makeDeps({ judgeCall: async () => ({ text: 'malformed', costUsd: JUDGE_USD,
      inputTokens: 1, outputTokens: 1 }) });
    await expect(deps.evaluate('baseline', { promptOverrides: {} })).rejects.toMatchObject({
      costUsd: PIPELINE_USD + 2 * JUDGE_USD,
    });
  });

  it('stops before judging incomplete pipeline usage while retaining its priced subtotal and receipt', async () => {
    const ab = fakeAbDeps(ALL_MEASURED);
    const run = ab.runPipeline;
    const receipt = { knownUsd: 0.3, providerUsd: 0.3, estimatedUsd: 0,
      complete: false, measured: false, coverageBasis: 'retained-run-output-and-usage-samples' as const,
      missingRunIds: ['validator'], samples: [] };
    ab.runPipeline = async (input) => ({ ...await run(input), pipelineUsd: 0.3, pipelineSpend: receipt });
    let judged = false;
    const { deps } = makeDeps({ abDeps: ab, tasks: [TASKS[0]], judgeCall: async () => {
      judged = true; throw new Error('must not judge unknown pipeline spend');
    } });
    await expect(deps.evaluate('candidate', { promptOverrides: {} })).rejects.toMatchObject({
      message: 'Gym pipeline usage evidence is incomplete', costUsd: 0.3,
      costUsdMeasurementMissing: true, pipelineSpend: receipt,
    });
    expect(judged).toBe(false);
  });

  it('records declared run parameters before judging, including when the judge fails', async () => {
    const ab = fakeAbDeps(ALL_MEASURED);
    const started: unknown[] = [];
    ab.store.startRun = async (run) => { started.push(run); };
    const task = { ...TASKS[0], repoCommit: 'declared-task-commit' };
    const rubric = { ...GYM_JUDGE_RUBRIC_V1, version: 'fixture-rubric' };
    const { deps } = makeDeps({ runId: 'params-loop', abDeps: ab, tasks: [task], rubric,
      harnessCommit: 'declared-harness-commit', judgeCall: async () => {
        expect(started).toEqual([expect.objectContaining({
          runId: 'params-loop::baseline::t-train-lo::c0::r0',
          params: { harnessCommit: 'declared-harness-commit', substrateCommit: 'declared-task-commit',
            judgeModel: rubric.model, judgeTemp: rubric.temperature, weights: rubric.weights, rubricHash: rubricHash(rubric) },
        })]);
        throw new Error('controlled judge failure');
      } });
    await expect(deps.evaluate('baseline', { promptOverrides: {} })).rejects.toThrow('controlled judge failure');
    expect(started).toHaveLength(1);
  });

  it('keeps independent baseline evaluations distinct through start, finish and score persistence', async () => {
    const evaluateBaseline = async (runId: string) => {
      const ab = fakeAbDeps(ALL_MEASURED);
      const started: string[] = [];
      const finished: string[] = [];
      const scored: string[] = [];
      ab.store.startRun = async (run) => { started.push(run.runId); };
      ab.store.finishRun = async (id) => { finished.push(id); };
      ab.store.recordScore = async (id) => { scored.push(id); };
      const { deps } = makeDeps({ runId, abDeps: ab, repeats: 2 });
      const evaluated = await deps.evaluate('baseline', { promptOverrides: {} });
      expect(finished).toEqual(started);
      expect(scored).toEqual(started);
      expect(evaluated).toMatchObject({ runIds: started });
      expect(new Set(started).size).toBe(TASKS.length * 2);
      return started;
    };
    const first = await evaluateBaseline('independent-first');
    const second = await evaluateBaseline('independent-second');
    // The durable copy upserts by this identity. A collision would replace the
    // earlier run's oracle signals and recorded parameters with the later run.
    expect(first.filter((id) => second.includes(id))).toEqual([]);
  });

  it('rolls per-pool composites into trainAgg/devAnchorAgg/trainVector + meanCost', async () => {
    const { deps } = makeDeps({}, { ...ALL_MEASURED, 't-train-lo': { regressions: true } });
    const { evalResult, worstTraces, costUsd } = await deps.evaluate('baseline', { promptOverrides: {} });

    // trainVector is in task order (lo, hi); trainAgg is their mean.
    expect(evalResult.trainVector).toEqual([expComposite(2), expComposite(8)]);
    expect(evalResult.trainAgg).toBeCloseTo((expComposite(2) + expComposite(8)) / 2, 6);
    expect(evalResult.devAnchorAgg).toBeCloseTo(expComposite(6), 6);

    // Each run costs pipeline + judge; meanCost is the per-run mean across all 4 pools.
    expect(evalResult.meanCost).toBeCloseTo(PIPELINE_USD + JUDGE_USD, 6);
    expect(costUsd).toBeCloseTo(4 * (PIPELINE_USD + JUDGE_USD), 6);

    // un-gameable signals from the injected per-task signals, as typed evidence.
    expect(evalResult.regressionEvidence.status).toBe('fail');
    expect(evalResult.probeEvidence.status).toBe('pass');

    // worst train trace first (lowest composite), carries the judge rationale.
    expect(worstTraces[0].taskId).toBe('t-train-lo');
    expect(worstTraces[0].rationale).toBe('rationale-2');
    expect(worstTraces.map((w) => w.taskId)).toEqual(['t-train-lo', 't-train-hi']);
  });

  /**
   * P-002 — the real-anchor pool was RUN and SCORED here long before this test existed;
   * what it was not, was aggregated. Its composites were computed per task and then
   * dropped, so `decideAccept` never saw them and a candidate could be crowned champion
   * while getting worse at real work. These two lock the aggregate and its coverage.
   */
  it('rolls the real-anchor pool into realAnchorAgg with measured coverage', async () => {
    const withReal: LoopTask[] = [
      ...TASKS,
      { taskId: 't-real', pool: 'real-anchor', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'score:7', projectContext: 'p' },
    ];
    const { deps } = makeDeps({ tasks: withReal }, { ...ALL_MEASURED, 't-real': { regressions: false } });
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });

    expect(evalResult.realAnchorAgg).toBeCloseTo(expComposite(7), 6);
    expect(evalResult.realAnchorEvidence.status).toBe('pass');
    expect(evalResult.realAnchorEvidence.coverage).toEqual({ measured: 1, required: 1, unmeasuredTaskIds: [] });
    // The real-anchor is scored but NEVER optimized (D-014): it must not leak into the
    // reward or the frontier vector.
    expect(evalResult.trainVector).toEqual([expComposite(2), expComposite(8)]);
  });

  it('reports a cycle that ran NO real-anchor task as not-measured, never a vacuous 0-vs-0 pass', async () => {
    const { deps } = makeDeps({}, ALL_MEASURED); // TASKS carries train/dev-anchor/probe only
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });

    // mean([]) is 0, which on its own would compare as a catastrophic regression against
    // any scored champion — the coverage is what stops that being read as a verdict.
    expect(evalResult.realAnchorAgg).toBe(0);
    expect(evalResult.realAnchorEvidence.status).toBe('not-measured');
    expect(evalResult.realAnchorEvidence.coverage.required).toBe(0);
  });

  it('attaches all known pipeline and judge spend to a partial evaluation error', async () => {
    let judgeCalls = 0;
    const judgeCall: JudgeLlmCall = async (opts) => {
      judgeCalls++;
      if (judgeCalls === 2) {
        throw Object.assign(new Error('judge failed after dispatch'), { costUsd: 0.07 });
      }
      return fakeJudge(opts);
    };
    const { deps } = makeDeps({ judgeCall });

    await expect(deps.evaluate('baseline', { promptOverrides: {} })).rejects.toMatchObject({
      // First task completed ($0.50 pipeline + $0.10 judge), then the second
      // task's pipeline ran ($0.50) before its $0.07 judge failure.
      costUsd: PIPELINE_USD + JUDGE_USD + PIPELINE_USD + 0.07,
    });
  });

  it('probe evidence FAILS when a probe task does not catch its planted bug', async () => {
    const { deps } = makeDeps({}, { ...ALL_MEASURED, 't-probe': { regressions: false, planted_bug_caught: false } });
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.probeEvidence.status).toBe('fail');
  });

  /**
   * P-003 — this case used to assert `allProbesCaught === true`. That was the bug: with
   * no probe tasks the loop reported an affirmative "all planted bugs caught" for a pool
   * that never ran, and a candidate could clear the guardrail on evidence nobody gathered.
   */
  it('probe evidence is NOT-MEASURED when there are no probe tasks (never a vacuous pass)', async () => {
    const { deps } = makeDeps({ tasks: TASKS.filter((t) => t.pool !== 'probe') }, ALL_MEASURED);
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.probeEvidence.status).toBe('not-measured');
    expect(evalResult.probeEvidence.coverage).toEqual({ measured: 0, required: 0, unmeasuredTaskIds: [] });
  });

  it('regression evidence is NOT-MEASURED when a run never reports the signal at all', async () => {
    // No injected signals ⇒ rawSignals is `{}` ⇒ the key is ABSENT, which a boolean
    // could not distinguish from a reported `false`.
    const { deps } = makeDeps({}, {});
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.regressionEvidence.status).toBe('not-measured');
    expect(evalResult.regressionEvidence.coverage.measured).toBe(0);
    expect(evalResult.regressionEvidence.coverage.required).toBe(4);
    expect(evalResult.regressionEvidence.coverage.unmeasuredTaskIds).toEqual([
      't-train-lo',
      't-train-hi',
      't-dev',
      't-probe',
    ]);
  });

  it('a reported `regressions: false` is a measured PASS, distinct from the absent key', async () => {
    const { deps } = makeDeps({}, ALL_MEASURED);
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.regressionEvidence.status).toBe('pass');
    expect(evalResult.regressionEvidence.coverage).toEqual({ measured: 4, required: 4, unmeasuredTaskIds: [] });
  });

  it('names only the tasks that went unreported when coverage is partial', async () => {
    const { deps } = makeDeps({}, { 't-train-lo': { regressions: false }, 't-dev': { regressions: false } });
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.regressionEvidence.status).toBe('not-measured');
    expect(evalResult.regressionEvidence.coverage.unmeasuredTaskIds).toEqual(['t-train-hi', 't-probe']);
  });

  it('carries each contributing run trace ref as an artifact reference', async () => {
    const { deps } = makeDeps({}, ALL_MEASURED);
    const { evalResult } = await deps.evaluate('baseline', { promptOverrides: {} });
    expect(evalResult.regressionEvidence.artifacts).toEqual([
      'ref-t-train-lo',
      'ref-t-train-hi',
      'ref-t-dev',
      'ref-t-probe',
    ]);
    expect(evalResult.probeEvidence.artifacts).toEqual(['ref-t-probe']);
  });

  it('P-025: per-task composite is the MEAN over repeats, cost is summed, worst rationale kept', async () => {
    // A judge that returns a different score on each call (5,7,3,...) so repeats average ≠ a single run.
    let call = 0;
    const seq = [5, 7, 3]; // mean of 3 = 5
    const varyingJudge: JudgeLlmCall = async () => {
      const v = seq[call % seq.length];
      call++;
      return { text: JSON.stringify({ d1: v, d2: v, d3: v, rationale: `r-${v}` }), costUsd: JUDGE_USD, inputTokens: 1, outputTokens: 1 };
    };
    const oneTrain: LoopTask[] = [{ taskId: 't', pool: 'train', repoUrl: 'r', repoCommit: 'c', spec: 's', intent: 'x', projectContext: 'p' }];
    const { deps } = makeDeps({ tasks: oneTrain, repeats: 3, judgeCall: varyingJudge });
    const { evalResult, worstTraces, costUsd } = await deps.evaluate('baseline', { promptOverrides: {} });
    // composite = mean(composite(5),composite(7),composite(3)) = composite(5) since linear in d.
    expect(evalResult.trainAgg).toBeCloseTo((expComposite(5) + expComposite(7) + expComposite(3)) / 3, 6);
    // meanCost is per-run: 3 runs each (pipeline + judge).
    expect(evalResult.meanCost).toBeCloseTo(PIPELINE_USD + JUDGE_USD, 6);
    expect(costUsd).toBeCloseTo(3 * (PIPELINE_USD + JUDGE_USD), 6);
    // worst repeat's rationale (lowest composite = score 3) is fed to the proposer.
    expect(worstTraces[0].rationale).toBe('r-3');
  });

  it('respects worstK when selecting the worst train traces', async () => {
    const manyTrain: LoopTask[] = [2, 9, 4, 7, 1].map((n, i) => ({
      taskId: `t${i}`,
      pool: 'train',
      repoUrl: 'r',
      repoCommit: 'c',
      spec: 's',
      intent: `score:${n}`,
      projectContext: 'p',
    }));
    const { deps } = makeDeps({ tasks: manyTrain, worstK: 2 });
    const { worstTraces } = await deps.evaluate('baseline', { promptOverrides: {} });
    // lowest two composites: score 1 then score 2.
    expect(worstTraces.map((w) => w.rationale)).toEqual(['rationale-1', 'rationale-2']);
  });
});

describe('buildLoopDeps — propose / persistCycle / recordProposal seams', () => {
  it('carries the supplied proposer bound through the real native binding after config mutation', async () => {
    const { bindNativeGymLlmCalls } = await import('../proposer');
    const requests: Parameters<GymLlmCall>[0][] = [];
    const native = bindNativeGymLlmCalls(async request => {
      requests.push(request); return { text: '', json: { promptOverrides: { worker: 'x' }, rationale: 'r' },
        costUsd: 0, inputTokens: 0, outputTokens: 0 };
    }, 'native-harness', { log: () => {} });
    const { deps, config } = makeDeps({ proposerCall: native.proposer, proposerMaxTokens: 257 });
    config.proposerMaxTokens = 1;
    await deps.propose({ promptOverrides: {} }, [], '');
    expect(requests[0]).toMatchObject({ model: 'claude-sonnet-4-6', maxTokens: 257,
      requireOutputTokenLimit: true, priority: 'gym', harnessSlug: 'native-harness' });
  });

  it('refuses a native proposer with no supplied bound before the real transport', async () => {
    const { bindNativeGymLlmCalls } = await import('../proposer');
    const call = vi.fn(async () => ({ text: '{}', costUsd: 0, inputTokens: 0, outputTokens: 0 }));
    const { proposer } = bindNativeGymLlmCalls(call, 'native-harness', { log: () => {} });
    const { deps } = makeDeps({ proposerCall: proposer });
    await expect(deps.propose({ promptOverrides: {} }, [], '')).rejects.toMatchObject({ costUsd: 0 });
    expect(call).not.toHaveBeenCalled();
  });
  it('propose feeds worst traces + changelog to the proposer and returns a merged overlay', async () => {
    const { deps, proposerCalls } = makeDeps();
    const parentOverlay = { promptOverrides: { validator: '# Validator\nbe strict' } };
    const candidate = await deps.propose(
      parentOverlay,
      [{ taskId: 't-train-lo', composite: 2, rationale: 'missed the spec gap' }],
      'cycle 1: baseline established',
    );
    expect(proposerCalls).toHaveLength(1);
    expect(proposerCalls[0].user).toContain('missed the spec gap');
    expect(proposerCalls[0].user).toContain('cycle 1: baseline established');
    // no candidateDirections configured ⇒ no routed-ideas section (P-032 additive).
    expect(proposerCalls[0].user).not.toMatch(/Candidate directions/i);
    // merged overlay = parent ⊕ proposed (prompts-only).
    expect(candidate.overlay.promptOverrides.validator).toBe('# Validator\nbe strict');
    expect(candidate.overlay.promptOverrides.worker).toContain('re-read acceptance');
    expect(candidate.diffFromParent).toBe('worker');
  });

  it('P-032: configured candidateDirections reach the proposer prompt every cycle', async () => {
    const { deps, proposerCalls } = makeDeps({
      candidateDirections: ['Validator rubber-stamps — tighten the validator prompt'],
    });
    await deps.propose({ promptOverrides: {} }, [{ taskId: 't', composite: 2, rationale: 'r' }], '');
    expect(proposerCalls).toHaveLength(1);
    expect(proposerCalls[0].user).toMatch(/Candidate directions/i);
    expect(proposerCalls[0].user).toContain('- Validator rubber-stamps — tighten the validator prompt');
  });

  it('persistCycle writes a gym_cycles row keyed by cycle', async () => {
    const { deps, sqlSink } = makeDeps();
    await deps.persistCycle({ cycle: 3, parentId: 'baseline', candidateId: 'cand-c3', decision: 'accept', gateResults: { ok: true } });
    expect(sqlSink.join('\n')).toMatch(/gym_cycles/);
  });

  it('WI-5799: persistCycle mints a RUN-SCOPED cycle_id, so a later run cannot overwrite an earlier run cycle row', async () => {
    // The durable copy upserts ON CONFLICT (workspace_id, harness_slug, cycle_id).
    // Autoloop runs are maxCycles=1, so a bare `cyc-${cycle}` was ALWAYS 'cyc-1'
    // and every run silently overwrote the last — the gym's entire durable
    // history collapsed to one row (owner report: "no recent runs in the gym tab").
    const rec = {
      cycle: 1,
      parentId: 'baseline',
      candidateId: 'cand-c1',
      decision: 'accept' as const,
      gateResults: { ok: true },
    };
    const runA = makeDeps({ runId: 'runaaa' });
    const runB = makeDeps({ runId: 'runbbb' });
    await runA.deps.persistCycle(rec);
    await runB.deps.persistCycle(rec);

    const cycleIdOf = (values: unknown[][]): unknown => values.at(-1)?.[0];
    expect(cycleIdOf(runA.sqlValues)).toBe('cyc-runaaa-c1');
    expect(cycleIdOf(runB.sqlValues)).toBe('cyc-runbbb-c1');
    // The property that matters: SAME cycle number, DIFFERENT runs ⇒ distinct rows.
    expect(cycleIdOf(runA.sqlValues)).not.toBe(cycleIdOf(runB.sqlValues));

    // ...while staying deterministic WITHIN a run, so a rate-limited retry of the
    // same cycle still upserts its own row rather than minting a duplicate (RB-006).
    await runA.deps.persistCycle(rec);
    expect(cycleIdOf(runA.sqlValues)).toBe('cyc-runaaa-c1');
  });

  it('newVariantId is deterministic per cycle WITHIN a run (intra-run retry idempotency, RB-006), and recordProposal is wired through', async () => {
    const { deps, proposals } = makeDeps({ runId: 'fixedrun' });
    expect(deps.newVariantId(5)).toBe('cand-fixedrun-c5');
    // Same run, same cycle → same id every time (a retried cycle must not mint a second id).
    expect(deps.newVariantId(5)).toBe(deps.newVariantId(5));
    expect(typeof deps.recordProposal).toBe('function');
    await deps.recordProposal!({
      cycle: 1,
      candidateId: deps.newVariantId(1),
      parentId: 'baseline',
      overlay: { promptOverrides: { worker: 'new' } },
      parentOverlay: { promptOverrides: {} },
      rationale: 'r',
      devAnchorDelta: 0.1,
      costDelta: 0,
      probeStatus: 'pass',
      verdict: 'accept',
      candidateVersion: createCandidateVersionVerdict({
        candidateId: deps.newVariantId(1),
        parentId: 'baseline',
        variant: { promptOverrides: { worker: 'new' } },
        parent: { promptOverrides: {} },
        // ONE measured, passing gate — not an empty list. Under P-003 an empty
        // gate set derives 'inconclusive' (nothing was measured), which would
        // contradict this record's own verdict:'accept'.
        gateResults: [{ gate: 'dev-anchor', pass: true, status: 'pass', detail: 'fixture' }],
        recordedAt: 0,
      }),
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].candidateId).toBe('cand-fixedrun-c1');
  });

  it('WI-5697: newVariantId is UNIQUE ACROSS runs by default (no runId passed) — the root cause of "cycles no longer mint proposals" was this id collapsing to the same "cand-c<cycle>" across every run of a harness (almost always maxCycles=1 ⇒ always "cand-c1"), so a later run\'s recordProposal silently no-op\'d against the already-decided row from an earlier run', () => {
    const { deps: run1 } = makeDeps();
    const { deps: run2 } = makeDeps();
    expect(run1.newVariantId(1)).not.toBe(run2.newVariantId(1));
  });

  it('promote and revert are no-ops unless wired (human-gated default, D-020)', async () => {
    const promoted: unknown[] = [];
    const { deps } = makeDeps({ promote: async (o) => { promoted.push(o); } });
    await deps.promote({ promptOverrides: { worker: 'x' } });
    await deps.revert(); // no revert wired → must not throw
    expect(promoted).toHaveLength(1);
  });
});
