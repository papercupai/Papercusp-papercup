import { describe, it, expect, vi } from 'vitest';
import { createCandidateVersionVerdict, runOptimizationLoop, type LoopConfig, type LoopDeps, type LoopProposalRecord } from '../loop';
import { decideAccept, type VariantEval } from '../gate-engine';
import type { CandidateProposal } from '../proposer';
import { LlmCallError } from '@papercusp/testing-shell/llm';
import type { TurnError } from '../../agent-chat-stream';
import type { GateResult } from '../gates';

const rateLimited = (resetAt?: number): LlmCallError =>
  Object.assign(new LlmCallError({ class: 'rate_limited', message: '429', provider: 'anthropic', retryable: true, ...(resetAt !== undefined ? { resetAt } : {}) } as TurnError), { costUsd: 0 });

/**
 * Continuous loop driver (P-022): select parent → propose → evaluate → gate →
 * accept(frontier+champion+promote) / reject → changelog → circuit-breaker → repeat,
 * budget/cycle-capped, unattended. All effects injected.
 */
const config: LoopConfig = {
  thresholds: { epsilon: 0.2, delta: 0.3, costCeiling: 2.0 },
  baselineMeanCost: 1.0,
  baselineOfRecord: 7.0,
  dropThreshold: 0.5,
  maxCycles: 3,
  budgetUsd: null,
  proposerModel: 'claude-sonnet-4-6',
};

/**
 * P-003: a deterministic guardrail that WAS collected and passed. These suites are about
 * loop orchestration, so every variant is fully instrumented — the not-measured paths are
 * covered in gates.test.ts and loop-deps.test.ts.
 */
const MEASURED_PASS = {
  status: 'pass' as const,
  coverage: { measured: 1, required: 1, unmeasuredTaskIds: [] },
  artifacts: ['trace://t1'],
};

function evalOf(id: string, agg: number): VariantEval {
  // P-002: the real-anchor is measured and flat across variants here, so it neither
  // blocks nor drives these accepts — the gates under test stay the ones being tested.
  return { variantId: id, trainAgg: agg, trainVector: [agg], devAnchorAgg: agg, realAnchorAgg: 7.0, realAnchorEvidence: MEASURED_PASS, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS };
}

function baseDeps(over: Partial<LoopDeps> = {}): { d: LoopDeps; calls: string[] } {
  const calls: string[] = [];
  let agg = 7.0;
  const d: LoopDeps = {
    baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
    async evaluate(variantId) {
      calls.push(`eval:${variantId}`);
      // each evaluated candidate is strictly better than the last
      if (variantId !== 'baseline') agg += 0.5;
      return { evalResult: evalOf(variantId, variantId === 'baseline' ? 7.0 : agg), worstTraces: [], costUsd: 1.0 };
    },
    async propose() {
      calls.push('propose');
      return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
    },
    async promote() { calls.push('promote'); },
    async revert() { calls.push('revert'); },
    async persistCycle() { calls.push('persist'); },
    newVariantId: (cycle) => `cand-${cycle}`,
    ...over,
  };
  return { d, calls };
}

describe('runOptimizationLoop', () => {
  it('retains the evaluated candidate, distinct parent and champion, run identities and gate configuration', async () => {
    const recorded: LoopProposalRecord[] = [];
    const evaluations = new Map<string, { evalResult: VariantEval; runIds: string[]; costUsd: number }>();
    const { d } = baseDeps({
      async evaluate(variantId) {
        const agg = variantId === 'baseline' ? 7 : variantId === 'cand-1' ? 7.5 : 8;
        const evaluation = {
          evalResult: { ...evalOf(variantId, agg), trainVector: variantId === 'baseline' ? [7, 7] : [agg + 1, agg - 1] },
          runIds: [`run:${variantId}`], costUsd: agg / 10,
        };
        evaluations.set(variantId, evaluation);
        return { ...evaluation, worstTraces: [] };
      },
      recordProposal: async (record) => { recorded.push(record); },
    });
    await runOptimizationLoop({ ...config, maxCycles: 2 }, d);
    const baseline = evaluations.get('baseline')!;
    const first = evaluations.get('cand-1')!;
    const second = evaluations.get('cand-2')!;
    // Both variants remain on the frontier: the lower-fitness baseline is the
    // second parent, while the accepted first candidate is the champion.
    expect(recorded[1].parentId).toBe('baseline');
    expect(recorded[1].candidateVersion).toMatchObject({
      evaluation: { candidate: second, parent: baseline, champion: first,
        thresholds: config.thresholds, baselineMeanCost: config.baselineMeanCost },
      hashes: { evaluationHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(recorded[1].candidateVersion.gateResults).toEqual(
      decideAccept(second.evalResult, baseline.evalResult, first.evalResult, config.baselineMeanCost, config.thresholds).results,
    );
    const retained = JSON.stringify(recorded[1].candidateVersion);
    second.evalResult.trainVector[0] = -100;
    baseline.runIds.push('later-run');
    first.evalResult.probeEvidence = { ...MEASURED_PASS, status: 'not-measured' };
    expect(JSON.stringify(recorded[1].candidateVersion)).toBe(retained);
  });

  it('runs maxCycles, accepts improving candidates, and promotes the champion', async () => {
    const { d, calls } = baseDeps();
    const res = await runOptimizationLoop(config, d);
    expect(res.cycles).toBe(3);
    expect(res.accepts).toBe(3);
    expect(res.championId).toBe('cand-3'); // last + best
    expect(calls.filter((c) => c === 'promote').length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain('eval:baseline');
  });

  /**
   * P-002 / D-004(3) — the end-to-end statement of the item: a challenger may only be
   * crowned champion if it does not regress the real-anchor pool. Both consequences live
   * behind loop.ts's `if (verdict.accept)`: the EXTERNAL harness write (`deps.promote`)
   * and the INTERNAL champion advance that drives parent selection and what gets
   * federated. A candidate that improves on every optimized signal and only gets worse
   * at real work must move neither.
   */
  it('never crowns a champion that regresses the real-anchor, however much it improves on train', async () => {
    let agg = 7.0;
    const { d, calls } = baseDeps({
      async evaluate(variantId) {
        if (variantId === 'baseline') return { evalResult: evalOf('baseline', 7.0), worstTraces: [], costUsd: 1.0 };
        agg += 0.5; // strictly better train AND dev-anchor each cycle — every other gate holds
        return {
          evalResult: { ...evalOf(variantId, agg), realAnchorAgg: 5.0 }, // vs champion 7.0, δ 0.2
          worstTraces: [],
          costUsd: 1.0,
        };
      },
    });
    const res = await runOptimizationLoop(config, d);

    expect(res.accepts).toBe(0);
    expect(res.championId).toBe('baseline'); // the internal champion never advances
    expect(calls).not.toContain('promote'); // and nothing is written to the harness
  });

  it('stops when the budget is exhausted', async () => {
    const { d } = baseDeps();
    const res = await runOptimizationLoop({ ...config, budgetUsd: 2.0, maxCycles: 99 }, d);
    // baseline eval (1.0) + ~1 candidate cycle (1.0) ≈ budget 2.0
    expect(res.cycles).toBeLessThanOrEqual(2);
    expect(res.spentUsd).toBeGreaterThanOrEqual(2.0);
  });

  it.each([0, -0])('does not dispatch even the baseline with a zero budget (%s)', async (budgetUsd) => {
    const archive: string[] = [];
    const { d, calls } = baseDeps({
      recordArchive: async (record) => { archive.push(record.variantId); },
    });
    const result = await runOptimizationLoop({ ...config, budgetUsd }, d);
    expect(result).toEqual({
      cycles: 0, accepts: 0, championId: 'baseline', spentUsd: 0,
      breakerTripped: false, skipped: 0, skipReasons: [],
    });
    expect(calls).toEqual([]);
    expect(archive).toEqual([]);
  });

  it.each([-1, NaN, Infinity, -Infinity])('rejects an invalid budget before dispatch (%s)', async (budgetUsd) => {
    const { d, calls } = baseDeps();
    await expect(runOptimizationLoop({ ...config, budgetUsd }, d)).rejects.toMatchObject({
      name: 'RangeError', message: 'Gym budgetUsd must be null or a finite nonnegative number', costUsd: 0,
    });
    expect(calls).toEqual([]);
  });

  it('stops before proposing when the baseline consumes the budget', async () => {
    const { d, calls } = baseDeps();
    const result = await runOptimizationLoop({ ...config, budgetUsd: 1 }, d);
    expect(calls).toEqual(['eval:baseline']);
    expect(result).toMatchObject({ cycles: 0, spentUsd: 1, accepts: 0 });
  });

  it.each([1, 1.25])('retains proposer spend and stops before candidate evaluation when the cap is reached ($%s)', async (costUsd) => {
    const archives: string[] = [];
    const { d, calls } = baseDeps({
      async propose() {
        calls.push('propose');
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd };
      },
      recordArchive: async (record) => { archives.push(record.variantId); },
      newVariantId: () => { calls.push('new-id'); return 'candidate'; },
      recordProposal: async () => { calls.push('record-proposal'); },
    });
    const result = await runOptimizationLoop({ ...config, budgetUsd: 2, maxCycles: 99 }, d);
    expect(calls).toEqual(['eval:baseline', 'propose']);
    expect(archives).toEqual(['baseline']);
    expect(result).toMatchObject({
      cycles: 1, accepts: 0, championId: 'baseline', spentUsd: 1 + costUsd,
      breakerTripped: false, skipped: 1,
      skipReasons: ['cycle 1: budget exhausted after proposer; candidate evaluation not dispatched'],
    });
  });

  it('charges proposer spend before a successful evaluation is settled', async () => {
    const { d } = baseDeps({
      async propose() {
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0.25 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    // baseline evaluation ($1) + proposer ($0.25) + candidate evaluation ($1).
    expect(res.spentUsd).toBeCloseTo(2.25, 6);
  });

  it('charges a proposer error that reports burned provider spend', async () => {
    const { d } = baseDeps({
      async propose() {
        throw Object.assign(new Error('proposer failed after dispatch'), { costUsd: 0.35 });
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(1);
    expect(res.spentUsd).toBeCloseTo(1.35, 6);
  });

  it('charges partial evaluator spend when the candidate evaluation throws', async () => {
    const { d } = baseDeps({
      async propose() {
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0.25 };
      },
      async evaluate(variantId) {
        if (variantId !== 'baseline') {
          throw Object.assign(new Error('evaluation failed part-way through'), { costUsd: 0.75 });
        }
        return { evalResult: evalOf(variantId, 7.0), worstTraces: [], costUsd: 1.0 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(1);
    // baseline ($1) + proposer ($0.25) + partial evaluation ($0.75).
    expect(res.spentUsd).toBeCloseTo(2.0, 6);
  });

  it('trips the circuit-breaker and reverts when the champion drifts below baseline-of-record', async () => {
    // baselineOfRecord 9.0 (well above the champion's ~7.5 dev-anchor) ⇒ champion
    // sits below baseline − drop ⇒ breaker trips + reverts after cycle 1.
    const { d, calls } = baseDeps();
    const res = await runOptimizationLoop({ ...config, baselineOfRecord: 9.0, dropThreshold: 0.5 }, d);
    expect(res.breakerTripped).toBe(true);
    expect(calls).toContain('revert');
    expect(res.cycles).toBeLessThan(3); // stopped early
  });

  it('records each candidate as a proposal (gym UI seam); autoPromote:false skips the harness write', async () => {
    const recorded: LoopProposalRecord[] = [];
    const { d, calls } = baseDeps({ recordProposal: async (r) => { recorded.push(r); } });
    const res = await runOptimizationLoop({ ...config, autoPromote: false }, d);
    expect(recorded).toHaveLength(res.cycles); // one record per cycle
    expect(recorded[0].candidateId).toBe('cand-1');
    expect(recorded[0].overlay.promptOverrides.worker).toBe('improved');
    expect(recorded[0].parentOverlay).toBeDefined();
    expect(recorded[0].verdict).toBe('accept'); // improving candidates accept
    expect(recorded[0].candidateVersion.verdict).toBe('accept');
    // Name them rather than count them: `autoDecideRunProposals` promotes only when EVERY
    // gate in this persisted list passed, so which gates are present IS the promotion
    // contract — a silently-absent real-anchor gate (P-002) would re-open the hole.
    expect(recorded[0].candidateVersion.gateResults.map((g) => g.gate).sort()).toEqual(
      [
        'cost',
        'dev-anchor-no-regress',
        'improvement',
        'no-new-regressions',
        'probe-caught',
        'real-anchor-no-regress',
      ].sort(),
    );
    expect(recorded[0].candidateVersion.hashes.variantHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof recorded[0].devAnchorDelta).toBe('number');
    expect(calls).not.toContain('promote'); // human-gated: no external harness write
    expect(res.championId).toBe('cand-3'); // internal champion still advances
  });

  it('builds a reject verdict when any gate fails, regardless of dev-anchor movement', () => {
    const verdict = createCandidateVersionVerdict({
      candidateId: 'cand-1',
      parentId: 'baseline',
      variant: { promptOverrides: { worker: 'candidate' } },
      parent: { promptOverrides: {} },
      gateResults: [{ gate: 'no-new-regressions', pass: false, status: 'fail' as const, detail: 'regression' }],
      recordedAt: 1,
      provenance: { evaluatorHash: 'e', rubricHash: 'r', taskHash: 't', codeHash: 'c' },
    });
    expect(verdict.verdict).toBe('reject');
    expect(verdict).not.toHaveProperty('evaluation');
    expect(verdict.hashes).not.toHaveProperty('evaluationHash');
    expect(verdict.hashes).toEqual({
      variantHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      parentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      evaluatorHash: 'e',
      rubricHash: 'r',
      taskHash: 't',
      codeHash: 'c',
    });
  });

  it('retains the hashed candidate, rollback target and nested gate artifacts after caller mutation', () => {
    const input = {
      candidateId: 'cand-1', parentId: 'baseline', recordedAt: 1,
      variant: { promptOverrides: { worker: 'evaluated' }, models: { worker: 'student' } },
      parent: { promptOverrides: { worker: 'rollback' }, models: { worker: 'parent-model' } },
      gateResults: [{ gate: 'no-new-regressions', pass: true, status: 'pass', detail: 'measured',
        evidence: { status: 'pass', coverage: { required: 1, measured: 1, unmeasuredTaskIds: [] },
          artifacts: ['trace://original'] } }] as GateResult[],
      provenance: { evaluatorHash: 'e', rubricHash: 'r', taskHash: 't', codeHash: 'c' },
    };
    const receipt = createCandidateVersionVerdict(input);
    const original = JSON.stringify(receipt);
    input.variant.promptOverrides.worker = 'unevaluated';
    input.variant.models.worker = 'other-model';
    input.parent.promptOverrides.worker = 'different-rollback';
    input.parent.models.worker = 'other-parent-model';
    input.provenance.codeHash = 'other-code';
    input.gateResults[0].status = 'fail';
    input.gateResults[0].evidence!.coverage.measured = 0;
    (input.gateResults[0].evidence!.coverage.unmeasuredTaskIds as string[]).push('missing-task');
    (input.gateResults[0].evidence!.artifacts as string[]).push('trace://replacement');
    input.gateResults.push({ gate: 'cost', pass: false, status: 'fail', detail: 'late gate' });
    expect(JSON.stringify(receipt)).toBe(original);
    expect(Object.isFrozen(input.variant)).toBe(false);
    expect(Object.isFrozen(input.gateResults[0].evidence!.artifacts)).toBe(false);
  });

  it('refuses to rewrite any nested part of a returned candidate receipt', () => {
    const receipt = createCandidateVersionVerdict({
      candidateId: 'cand-1', parentId: 'baseline', recordedAt: 1,
      variant: { promptOverrides: { worker: 'evaluated' }, models: { worker: 'student' } },
      parent: { promptOverrides: { worker: 'rollback' } },
      gateResults: [{ gate: 'no-new-regressions', pass: true, status: 'pass', detail: 'measured',
        evidence: { status: 'pass', coverage: { required: 1, measured: 1, unmeasuredTaskIds: [] },
          artifacts: ['trace://original'] } }],
    });
    expect(() => { receipt.variant.promptOverrides.worker = 'unevaluated'; }).toThrow(TypeError);
    expect(() => { receipt.variant.models!.worker = 'other-model'; }).toThrow(TypeError);
    expect(() => { receipt.parent.promptOverrides.worker = 'different-rollback'; }).toThrow(TypeError);
    expect(() => { receipt.hashes.variantHash = 'other-hash'; }).toThrow(TypeError);
    expect(() => { receipt.gateResults[0].evidence!.coverage.measured = 0; }).toThrow(TypeError);
    expect(() => { (receipt.gateResults[0].evidence!.artifacts as string[]).push('trace://other'); }).toThrow(TypeError);
    expect(() => { receipt.verdict = 'reject'; }).toThrow(TypeError);
    expect(receipt.hashes.codeHash).toBe('unresolved');
  });

  it('keeps the loop proposal receipt separate from mutable prompt and rollback views', async () => {
    const recorded: LoopProposalRecord[] = [];
    const { d } = baseDeps({ recordProposal: async (record) => { recorded.push(record); } });
    await runOptimizationLoop({ ...config, maxCycles: 1, autoPromote: false }, d);
    const record = recorded[0];
    const original = JSON.stringify(record.candidateVersion);
    record.overlay.promptOverrides.worker = 'later-edit';
    record.parentOverlay.promptOverrides.worker = 'later-parent-edit';
    expect(JSON.stringify(record.candidateVersion)).toBe(original);
    expect(record.candidateVersion.variant.promptOverrides.worker).toBe('improved');
    expect(record.candidateVersion.parent.promptOverrides.worker).toBeUndefined();
  });

  it('still auto-promotes by default (autoPromote undefined) + records when the dep is present', async () => {
    const recorded: LoopProposalRecord[] = [];
    const { d, calls } = baseDeps({ recordProposal: async (r) => { recorded.push(r); } });
    const res = await runOptimizationLoop(config, d);
    expect(recorded).toHaveLength(res.cycles);
    expect(calls.filter((c) => c === 'promote').length).toBeGreaterThanOrEqual(1);
  });

  // RB-006 — a rate-limited (or otherwise failed) propose/evaluate must SKIP the cycle, never
  // crash the loop or lose the progress accrued so far.
  it('skips a cycle whose propose is rate-limited (far reset) and keeps going', async () => {
    let proposeN = 0;
    const { d } = baseDeps({
      now: () => 0, // so resetAt=1e9ms reads as ~11 days out (> maxPause) → skip, not retry
      sleep: async () => {},
      async propose() {
        proposeN++;
        if (proposeN === 2) throw rateLimited(1_000_000_000); // far reset → no pause, skip cycle 2
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
      },
    });
    const res = await runOptimizationLoop(config, d); // maxCycles 3
    expect(res.skipped).toBe(1);
    expect(res.cycles).toBe(3); // loop did NOT abort
    expect(res.accepts).toBe(2); // cycles 1 + 3 (cycle 2 skipped)
  });

  it('PAUSES+RESUMES a near-reset rate-limited evaluate (injected clock), no skip', async () => {
    let clock = 0;
    let candEvalN = 0;
    const { d } = baseDeps({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      async evaluate(variantId) {
        if (variantId !== 'baseline') {
          candEvalN++;
          if (candEvalN === 1) throw rateLimited(5000); // first candidate eval 429s; retry succeeds
        }
        return { evalResult: evalOf(variantId, variantId === 'baseline' ? 7.0 : 7.5), worstTraces: [], costUsd: 1.0 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(0);
    expect(clock).toBe(5000); // waited out the reset
    expect(res.cycles).toBe(1);
  });

  it.each([{}, { costUsd: 0.23 }, { costUsd: 0.23, costUsdMeasurementMissing: true }])(
    'preserves unsafe baseline rate-limit usage rather than replaying the evaluation: %j', async usage => {
      const failure = Object.assign(new LlmCallError({ class: 'rate_limited', message: '429', retryAfterMs: 1 }), usage);
      const sleep = vi.fn(async () => {});
      const evaluate = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({
        evalResult: evalOf('baseline', 7), worstTraces: [], costUsd: 0.02,
      });
      const { d } = baseDeps({ evaluate, sleep, now: () => 0 });
      await expect(runOptimizationLoop({ ...config, maxCycles: 1 }, d)).rejects.toBe(failure);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('charges a failed candidate subtotal without replaying previously completed work', async () => {
    const failure = Object.assign(rateLimited(5000), { costUsd: 0.23 });
    const sleep = vi.fn(async () => {});
    let candidateCalls = 0;
    const { d } = baseDeps({
      now: () => 0, sleep,
      async evaluate(variantId) {
        if (variantId !== 'baseline' && candidateCalls++ === 0) throw failure;
        return { evalResult: evalOf(variantId, 7.5), worstTraces: [], costUsd: 1 };
      },
    });
    const result = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(candidateCalls).toBe(1);
    expect(result).toMatchObject({ spentUsd: 1.23, skipped: 1, accepts: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('skips a cycle on a NON-rate propose error (never crashes)', async () => {
    let proposeN = 0;
    const { d } = baseDeps({
      async propose() {
        proposeN++;
        if (proposeN === 1) throw new Error('proposer boom');
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
      },
    });
    const res = await runOptimizationLoop(config, d);
    expect(res.skipped).toBe(1);
    expect(res.cycles).toBe(3);
    // WI-5674: the swallowed reason is now CAPTURED (not discarded) so the silent-skip
    // failure mode is diagnosable from the run report.
    expect(res.skipReasons).toHaveLength(1);
    expect(res.skipReasons[0]).toContain('proposer boom');
    expect(res.skipReasons[0]).toContain('cycle 1');
  });

  // P-011 (D-008) — quality-diversity parent selection. The novelty signal is only
  // consulted when config.qualityDiversity is set, and when it is, it can steer the
  // pick toward an under-explored (novel) frontier member instead of pure headroom.
  it('does NOT consult noveltyForVariant when qualityDiversity is absent (default path unchanged)', async () => {
    let called = false;
    const { d } = baseDeps({ async noveltyForVariant() { called = true; return 0.9; } });
    await runOptimizationLoop(config, d); // no qualityDiversity ⇒ legacy fitness-only selection
    expect(called).toBe(false);
  });

  it('quality-diversity selects the NOVEL frontier parent where fitness-only selects the under-served one', async () => {
    // Build a 2-member frontier: baseline (trainVector [7,7]) + cand-1 ([9,5]) trade
    // off, so neither Pareto-dominates → both persist on the frontier. baseline has
    // the lower trainAgg (what selectParent picks); cand-1 is flagged the novel one.
    function runWith(qd: LoopConfig['qualityDiversity']): Promise<string[]> {
      const parents: string[] = [];
      const d: LoopDeps = {
        baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
        async evaluate(variantId) {
          if (variantId === 'baseline') {
            return { evalResult: { variantId, trainAgg: 7.0, trainVector: [7, 7], devAnchorAgg: 7.0, realAnchorAgg: 7.0, realAnchorEvidence: MEASURED_PASS, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS }, worstTraces: [], costUsd: 1.0 };
          }
          // higher trainAgg (clears the improvement gate) but a trade-off vector so it
          // does not dominate baseline → the frontier keeps both members.
          return { evalResult: { variantId, trainAgg: 7.5, trainVector: [9, 5], devAnchorAgg: 7.2, realAnchorAgg: 7.0, realAnchorEvidence: MEASURED_PASS, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS }, worstTraces: [], costUsd: 1.0 };
        },
        async propose() { return { overlay: { promptOverrides: { worker: 'v' } }, rationale: 'x', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal; },
        async promote() {},
        async revert() {},
        async persistCycle(rec) { parents.push(rec.parentId); },
        newVariantId: (cycle) => `cand-${cycle}`,
        // baseline = under-served (low trainAgg); cand-1 = the novel/sparse member.
        async noveltyForVariant(variantId) { return variantId === 'baseline' ? 0.0 : 1.0; },
      };
      return runOptimizationLoop({ ...config, maxCycles: 2, qualityDiversity: qd }, d).then(() => parents);
    }
    // Cycle 1 parent is always baseline (sole frontier member); cycle 2 selects over
    // the 2-member frontier [baseline, cand-1].
    const qdParents = await runWith({ noveltyWeight: 1.0 });
    expect(qdParents[1]).toBe('cand-1'); // pure novelty → the sparse member
    const fitnessParents = await runWith(undefined);
    expect(fitnessParents[1]).toBe('baseline'); // fitness-only → the under-served member
  });
});
