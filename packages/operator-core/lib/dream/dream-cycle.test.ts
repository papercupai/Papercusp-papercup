import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { CAPABILITY_PRIOR_KINDS } from './capability-review';
import { dreamCallOwnerId, dreamRunId, estimateDreamCall, runDreamCycle, type DreamCycleDeps, type DreamCycleInput } from './dream-cycle';
import { DreamAdmissionError } from './dream-governor';
import { dreamCapabilityRun, dreamCallTotals, newDreamCapabilityRun } from './dream-run-provenance';
import type { DreamRun } from './dream-run-store';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from './capability-sampler';
import { freezeDreamEvaluationProtocol, dreamComparisonInputHash } from './dream-evaluation';
import { DEFAULT_DREAM_PASS_CONFIG, DEFAULT_DREAM_REVIEW_CONFIG, dreamRunOutcome } from './dream-config';
import { scopeDreamProblems } from './capability-pass';
import { capabilityHash } from './capability-contracts';

type Fixture = Awaited<ReturnType<typeof createDreamCapabilityFixture>>;
let f: Fixture;
beforeEach(async () => {
  f = await createDreamCapabilityFixture('ws-cycle', 'papercusp');
});
afterEach(async () => {
  await rm(f.root, { recursive: true, force: true });
});

function harness() {
  const input: DreamCycleInput = {
    ...f.scope,
    rootPath: f.root,
    manifest: f.manifest,
    mode: 'manual',
    cycleId: 'cycle-1',
    cycle: { maxDreamsPerCycle: 1 },
    pass: { model: 'dreamer' },
    review: { model: 'reviewer' },
  };
  const runs = new Map<string, DreamRun>();
  const charged = new Set<string>();
  const row = (id: string) => {
    const r = runs.get(id);
    if (!r) throw new Error('missing run');
    return r;
  };
  const tally = (run: DreamRun) => Object.assign(run, dreamCallTotals(dreamCapabilityRun(run)!.calls));
  const llm = vi.fn<DreamCycleDeps['llmCall']>().mockResolvedValue({
    text: '',
    json: { schemaVersion: 'dream-capability-result-v1', verdict: 'insight', candidate: f.candidate },
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 10,
  });
  const d: DreamCycleDeps = {
    llmCall: llm,
    estimateCall: () => 0.05,
    preflight: vi.fn(async () => ({
      allow: true as const,
      loopId: 'dream:papercusp',
      cycleRemainingUsd: 1,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 5,
      rollingLoopCount: 0,
    })),
    loadPackets: vi.fn(async () => f.packets),
    loadHistory: vi.fn(async () => []),
    reviewSources: () => ({ ...f.sources, search: async () => ({ scope: f.scope, kinds: CAPABILITY_PRIOR_KINDS, status: 'current', matches: f.review.priorMatches, truncated: false, note: 'Current fixture priors.' }) }),
    sample: vi.fn(() => f.sampling),
    beginRun: vi.fn(async ({ runId, cycleId, capability }) => {
      if (runs.has(runId)) return { created: false, run: structuredClone(row(runId)) };
      const r: DreamRun = {
        ...structuredClone(f.run),
        runId,
        cycleId,
        status: 'running',
        startedAt: new Date().toISOString(),
        review: null,
        routedRef: null,
        costUsd: 0,
        outcome: { capabilityRun: newDreamCapabilityRun(capability) },
      };
      runs.set(runId, r);
      return { created: true, run: structuredClone(r) };
    }),
    recordSelection: vi.fn(async ({ runId, capability }) => {
      const r = row(runId);
      r.outcome!.capabilityRun = { ...dreamCapabilityRun(r)!, sampling: capability };
      return structuredClone(r);
    }),
    beginCall: vi.fn(async ({ runId, call }) => {
      const r = row(runId),
        p = dreamCapabilityRun(r)!;
      const existing = p.calls.find((c) => c.callId === call.callId);
      if (existing) return { started: false, run: structuredClone(r), call: existing };
      const used = [...runs.values()].reduce((n, r) => n + r.costUsd, 0);
      if (used >= (input.cycle?.maxCostUsd ?? 1) || used + call.reservedUsd > (input.cycle?.maxCostUsd ?? 1))
        throw new DreamAdmissionError('cycle-cost-cap');
      const saved = { ...call, status: 'reserved' as const, usage: null, error: null };
      p.calls.push(saved);
      r.outcome!.capabilityRun = p;
      tally(r);
      return { started: true, run: structuredClone(r), call: saved };
    }),
    settleCall: vi.fn(async ({ runId, callId, usage, error }) => {
      const r = row(runId),
        p = dreamCapabilityRun(r)!;
      const c = p.calls.find((c) => c.callId === callId)!;
      Object.assign(c, { usage, error: error ?? null, status: usage ? 'settled' : 'unknown' });
      r.outcome!.capabilityRun = p;
      tally(r);
      return structuredClone(r);
    }),
    recordReview: vi.fn(async ({ runId, outcome, review }) => {
      const r = row(runId);
      r.outcome = { ...outcome, capabilityRun: r.outcome!.capabilityRun };
      r.review = review;
      return structuredClone(r);
    }),
    finalizeRun: vi.fn(async (value) => {
      const r = row(value.runId);
      if (r.status === 'running')
        Object.assign(r, {
          status: value.status,
          error: value.error ?? null,
          review: value.review ?? r.review,
          outcome: value.outcome ? { ...value.outcome, capabilityRun: r.outcome!.capabilityRun } : r.outcome,
        });
      return structuredClone(r);
    }),
    recordSpend: vi.fn(async (r) => {
      if (charged.has(r.runId)) return { recorded: false, costUsd: r.costUsd };
      charged.add(r.runId);
      return { recorded: r.costUsd > 0, costUsd: r.costUsd };
    }),
    sink: vi.fn(async (id) => {
      row(id).routedRef = 'WI-proposal';
      return {
        sunk: true as const,
        ideaId: 'dream:' + id,
        workItemId: 'WI-proposal',
        routedRef: 'WI-proposal',
        sourceRefs: [],
        created: true,
      };
    }),
    review: vi.fn(async (options, deps) => {
      await deps!.rerank('query', f.review.priorMatches, { timeoutMs: options.config?.timeoutMs ?? 180_000 });
      const reviewerModel = options.config?.model ?? 'reviewer';
      const values = await Promise.allSettled(
        (['control-a', 'control-b'] as const).map((p) =>
          options.callForPhase!(p)({
            model: reviewerModel,
            messages: [{ role: 'user', content: p }],
            signal: options.signal,
          }),
        ),
      );
      const failed = values.find((v) => v.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const last = await options.callForPhase!('review')({
        model: reviewerModel,
        messages: [{ role: 'user', content: 'review' }],
        signal: options.signal,
      });
      const usage = [...values.flatMap((v) => (v.status === 'fulfilled' ? [v.value] : [])), last];
      return {
        ...f.review,
        usage: {
          model: reviewerModel,
          costUsd: usage.reduce((n, u) => n + u.costUsd, 0),
          inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0),
          outputTokens: usage.reduce((n, u) => n + u.outputTokens, 0),
        },
      };
    }),
    rerank: vi.fn(async (_q, priors) => ({
      priors,
      outcome: { attempted: true, engine: 'local', scored: priors.length },
    })),
  };
  return { input, d, runs, llm, row };
}

describe('Dream capability cycle governance — AUTO-REQ-M-002-P-005', () => {
  it('DREAM-PROBLEM-GROUNDING: persists only attributable same-pot context and preserves an explicit open comparison', async () => {
    const h = harness();
    const text = 'Input state is missing from reproduced failures.';
    const p = { ...f.scope, ref: 'observation:EI-problem', kind: 'observation' as const, attributedTo: 'reporter', capturedAt: '2026-09-27T00:00:00Z', text, contentHash: capabilityHash(text) };
    const { repositoryId: _repositoryId, ...evidence } = p;
    h.d.loadProblems = vi.fn(async () => scopeDreamProblems([evidence], h.input));
    const candidate = { ...f.candidate, problemFit: { refs: [p.ref], beneficiary: 'Debugging engineers', proposedImprovement: 'Restore inputs before replaying the failure.' } };
    h.llm.mockResolvedValue({ text: '', json: { schemaVersion: 'dream-capability-result-v1', verdict: 'insight', candidate }, costUsd: 0.01, inputTokens: 100, outputTokens: 10 });
    await runDreamCycle(h.input, h.d);
    expect(h.row('cycle-1:dream:1').outcome).toMatchObject({ problemContext: { mode: 'observed-problems', evidence: [evidence] } });
    expect(JSON.parse(h.llm.mock.calls[0]![0].messages[0]!.content as string).problemContext.evidence).toEqual([evidence]);
    expect(vi.mocked(h.d.review!).mock.calls[0]![0].problemContext?.evidence).toEqual([evidence]);
    const open = harness(); open.input.problemMode = 'open-exploration'; open.d.loadProblems = h.d.loadProblems;
    vi.mocked(h.d.loadProblems).mockClear();
    await runDreamCycle(open.input, open.d);
    expect(h.d.loadProblems).not.toHaveBeenCalled();
    expect(open.row('cycle-1:dream:1').outcome).toMatchObject({ problemContext: { mode: 'open-exploration', evidence: [] } });
  });
  it.each(['retrieval', 'rerank'] as const)('DREAM-REVIEW-PREFLIGHT: refuses unavailable %s before paid generation', async (dependency) => {
    const h = harness();
    h.input.cycle = { maxDreamsPerCycle: 3 };
    if (dependency === 'retrieval') h.d.reviewSources = () => ({ ...f.sources, search: async () => { throw new Error('Source reader offline'); } });
    if (dependency === 'rerank') h.d.rerank = vi.fn(async (_q, priors) => ({ priors, outcome: { attempted: false, reason: 'offline' } }));
    const result = await runDreamCycle(h.input, h.d);
    const run = h.row(dreamRunId(h.input.cycleId, 0));
    expect(result).toMatchObject({ reason: 'review-unavailable', attempts: 1, accepted: 0, costUsd: 0 });
    expect(run.outcome).toMatchObject({ generationSkipped: true });
    expect(run.review).toMatchObject({ verdict: 'unverified', nextCheck: { kind: 'dependency', maxSourceQueries: 2 } });
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.d.review).not.toHaveBeenCalled();
    expect(h.d.sink).not.toHaveBeenCalled();
    expect(dreamCapabilityRun(run)!.calls.every(c => c.reservedUsd === 0)).toBe(true);
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ reason: 'review-unavailable', attempts: 1, costUsd: 0 });
    expect(h.runs.size).toBe(1);
  });
  it('uses the observed packet verifier at production readiness before any paid generation', async () => {
    const h = await harness();
    h.d.verifyPacket = vi.fn(async () => ({ fresh: false, reason: 'Compiler graph differs from current cited source' }));
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ reason: 'review-unavailable', attempts: 1, costUsd: 0 });
    expect(h.d.verifyPacket).toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
    const run = [...h.runs.values()][0]!;
    expect(run.review).toMatchObject({ ready: false, reason: 'source-unavailable',
      note: 'Compiler graph differs from current cited source' });
  });
  it('marks an unpriced-model admission refusal as generation skipped', async () => {
    const h = harness();
    h.input.pass = { model: 'unpriced-provider' };
    h.d.estimateCall = estimateDreamCall;

    await runDreamCycle(h.input, h.d);

    const run = h.row(dreamRunId(h.input.cycleId, 0));
    expect(run.status).toBe('error');
    expect(run.error).toContain('Dream cannot admit an unpriced model');
    expect(run.outcome).toMatchObject({ generationSkipped: true });
    expect(dreamCapabilityRun(run)!.calls.some((call) => call.phase === 'generation')).toBe(false);
    expect(h.llm).not.toHaveBeenCalled();
  });
  it('runs the uniform-model defaults with separately governed review evidence', async () => {
    const h = harness();
    h.input.pass = DEFAULT_DREAM_PASS_CONFIG;
    h.input.review = DEFAULT_DREAM_REVIEW_CONFIG;
    expect(h.input.pass.model).toBe(h.input.review.model);
    h.d.estimateCall = estimateDreamCall;

    await runDreamCycle(h.input, h.d);

    const run = h.row('cycle-1:dream:1');
    const provenance = dreamCapabilityRun(run)!;
    expect(run.status).toBe('accepted');
    expect(provenance).toMatchObject({
      dreamerModel: DEFAULT_DREAM_PASS_CONFIG.model,
      reviewerModel: DEFAULT_DREAM_REVIEW_CONFIG.model,
    });
    expect(provenance.dreamPromptVersion).not.toBe(provenance.reviewPromptVersion);
    const reviewedPhases = provenance.calls.filter((call) =>
      ['generation', 'control-a', 'control-b', 'review'].includes(call.phase),
    );
    expect(reviewedPhases).toHaveLength(4);
    expect(reviewedPhases.every((call) => call.model === DEFAULT_DREAM_PASS_CONFIG.model)).toBe(true);
    expect(h.llm).toHaveBeenCalledTimes(4);
    expect(h.d.sink).toHaveBeenCalledTimes(1);
  });
  it('rechecks dependencies after readiness rather than treating preflight as proposal approval', async () => {
    const h = harness();
    h.d.review = vi.fn<NonNullable<DreamCycleDeps['review']>>(async () => ({ ...f.review, verdict: 'unverified', reason: 'source-changed-during-review' }));
    const result = await runDreamCycle(h.input, h.d);
    expect(result).toMatchObject({ accepted: 0, costUsd: 0.01 });
    expect(h.d.rerank).toHaveBeenCalledTimes(1);
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.d.sink).not.toHaveBeenCalled();
  });
  it('retains an unresolved review for honest display and never routes it', async () => {
    const h = harness();
    h.d.review = vi.fn<NonNullable<DreamCycleDeps['review']>>(async () => ({ ...f.review, verdict: 'unverified', reason: 'counterfactual-unknown' }));
    await runDreamCycle(h.input, h.d);
    const run = h.row(dreamRunId(h.input.cycleId, 0));
    expect(run.review?.verdict).toBe('unverified');
    expect(dreamRunOutcome(run.status, run.review)).toBe('insufficient evidence');
    expect(h.d.sink).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'refinement'] as const)('DREAM-REDISCOVERY: retains %s evidence without routing duplicate work on replay', async reason => {
    const h = harness();
    h.d.review = vi.fn<NonNullable<DreamCycleDeps['review']>>(async () => ({ ...f.review, verdict: 'reject', reason }));
    await runDreamCycle(h.input, h.d);
    const run = h.row(dreamRunId(h.input.cycleId, 0));
    expect(run.review).toMatchObject({ verdict: 'reject', reason, priorMatches: f.review.priorMatches });
    expect(run.status).toBe(reason === 'duplicate' ? 'duplicate' : 'rejected');
    await runDreamCycle(h.input, h.d);
    expect(h.d.sink).not.toHaveBeenCalled();
    expect(h.llm).toHaveBeenCalledTimes(1);
  });
  async function pilot(h: ReturnType<typeof harness>) {
    const snapshot = await buildCapabilitySamplingSnapshot({
      rootPath: f.root,
      scope: f.scope,
      manifest: f.manifest,
      packets: f.packets,
    });
    const bound = freezeDreamEvaluationProtocol({
      sourceSnapshot: snapshot.fingerprint,
      benchmarkHash: 'a'.repeat(64),
      oracleHash: 'b'.repeat(64),
      independentLabelsRef: 'fixture:independent-labels',
      seed: 'frozen-seed',
      models: { generator: 'dreamer', reviewer: 'reviewer' },
    });
    h.input.pilot = { ...bound, arm: 'structured-pair' };
    return bound;
  }

  it('blocks missing/changed pilot protocols before any adapter or paid call', async () => {
    const h = harness();
    await pilot(h);
    h.input.pilot!.protocol = null;
    await expect(runDreamCycle(h.input, h.d)).rejects.toThrow();
    expect(h.d.preflight).not.toHaveBeenCalled();
    const valid = await pilot(h);
    h.input.pilot!.protocol = { ...valid.protocol, seed: 'unregistered-change' };
    await expect(runDreamCycle(h.input, h.d)).rejects.toThrow('changed');
    expect(h.d.beginRun).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
  });
  it('DREAM-COMPARABLE: supplies frozen problem input to a new pilot and records its shared hash', async () => {
    const h = harness();
    const original = await pilot(h);
    const text = 'Replay should reproduce an observed failure.';
    const common = { manifestRevision: f.manifest.revision,
      scope: { workspaceId: h.input.workspaceId, potSlug: h.input.potSlug },
      problemContext: { mode: 'observed-problems' as const, note: 'Frozen comparison input.', evidence: [{
        ref: 'observation:EI-1', kind: 'observation' as const, workspaceId: h.input.workspaceId, potSlug: h.input.potSlug,
        attributedTo: 'reporter', capturedAt: '2026-09-27T00:00:00Z', text, contentHash: capabilityHash(text),
      }] } };
    const comparison = { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: original.protocol.sourceSnapshot }) };
    h.input.pilot = { ...freezeDreamEvaluationProtocol({ ...original.protocol, comparison }), arm: 'structured-pair' };
    h.d.dream = vi.fn(async () => ({ verdict: 'none' as const, usage: { model: 'dreamer', costUsd: 0, inputTokens: 0, outputTokens: 0 } }));
    await runDreamCycle(h.input, h.d);
    expect(h.d.dream).toHaveBeenCalledWith(expect.objectContaining({ problemContext: common.problemContext }));
    const run = h.row(dreamRunId(h.input.cycleId, 0));
    expect(dreamCapabilityRun(run)?.evaluation?.inputHash).toBe(comparison.inputHash);
    expect(run.outcome?.problemContext).toEqual(common.problemContext);
  });

  it.each([{ maxCostUsd: 10 }, { rolling24hCostUsd: 200 }])(
    'refuses monetary drift from the frozen pilot before admission or source work: %o',
    async (cycle) => {
      const h = harness();
      await pilot(h);
      h.input.cycle = { ...h.input.cycle, ...cycle };
      await expect(runDreamCycle(h.input, h.d)).rejects.toThrow('monetary');
      expect(h.d.preflight).not.toHaveBeenCalled();
      expect(h.d.beginRun).not.toHaveBeenCalled();
      expect(h.d.loadPackets).not.toHaveBeenCalled();
      expect(h.llm).not.toHaveBeenCalled();
    },
  );

  it('admits matching raised pilot ceilings and preserves shared-governor refusals', async () => {
    const h = harness();
    const original = await pilot(h);
    h.input.pilot = {
      ...freezeDreamEvaluationProtocol({ ...original.protocol, cycleUsd: 10, rollingDayUsd: 200 }),
      arm: 'structured-pair',
    };
    h.input.cycle = { ...h.input.cycle, maxCostUsd: 10, rolling24hCostUsd: 200 };
    h.d.preflight = vi.fn(async () => ({
      allow: false as const,
      loopId: 'dream:papercusp',
      reason: 'disabled' as const,
      cycleRemainingUsd: 10,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 200,
      rollingLoopCount: 0,
    }));
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ fired: false, reason: 'governor-refused' });
    expect(h.d.preflight).toHaveBeenCalledOnce();
    expect(h.llm).not.toHaveBeenCalled();
    h.d.preflight = vi.fn(async () => ({
      allow: true as const,
      loopId: 'dream:papercusp',
      cycleRemainingUsd: 10,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 200,
      rollingLoopCount: 0,
    }));
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ accepted: 1 });
    expect(h.llm).toHaveBeenCalled();
  });

  it('NATIVE-GRAPH-COMPARISON: refuses a missing measured treatment before generation and records the assigned treatment', async () => {
    const h = harness(), original = await pilot(h);
    const common = { manifestRevision: f.manifest.revision,
      scope: { workspaceId: h.input.workspaceId, potSlug: h.input.potSlug },
      problemContext: { mode: 'open-exploration' as const, evidence: [], note: 'Frozen unit comparison.' } };
    const comparison = { ...common, inputHash: dreamComparisonInputHash({ ...common, sourceSnapshot: original.protocol.sourceSnapshot }),
      graphAblation: { treatments: ['graph', 'control'] as ['graph', 'control'], populationIds: f.packets.map(p => p.unit.id),
        samplerHash: capabilityHash(JSON.stringify(h.input.sampler ?? {})), attemptsPerTreatment: 2, usdPerTreatment: 2,
        outcomeAssessment: 'blinded-independent-executed-benefit' as const } };
    h.input.pilot = { ...freezeDreamEvaluationProtocol({ ...original.protocol, comparison }),
      arm: 'structured-pair', matchedPairIndex: 0, graphTreatment: 'control' };
    await runDreamCycle(h.input, h.d);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.d.sample).not.toHaveBeenCalled();
    const saved = h.row('cycle-1:dream:1');
    expect(saved.status).toBe('error');
    expect(saved.error).toContain('no measured graph treatment');
    expect(dreamCapabilityRun(saved)?.evaluation).toMatchObject({
      protocolPin: h.input.pilot.pin, inputHash: comparison.inputHash, graphTreatment: 'control', matchedPairIndex: 0,
    });
  });

  it('rechecks the actual source snapshot before generation, preserving a rejected run', async () => {
    const h = harness();
    const valid = await pilot(h);
    h.input.pilot = {
      ...freezeDreamEvaluationProtocol({ ...valid.protocol, sourceSnapshot: 'c'.repeat(64) }),
      arm: 'structured-pair',
    };
    const result = await runDreamCycle(h.input, h.d);
    expect(result.runs[0]?.status).toBe('error');
    expect(h.row('cycle-1:dream:1').error).toContain('snapshot changed');
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.d.sample).not.toHaveBeenCalled();
  });

  it('admits a valid frozen manual pilot through the same governor and persists its pin and reproducible seed', async () => {
    const h = harness();
    const valid = await pilot(h);
    const result = await runDreamCycle(h.input, h.d);
    expect(result.accepted).toBe(1);
    expect(h.d.preflight).toHaveBeenCalledOnce();
    expect(h.d.sample).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ seed: 'frozen-seed:structured-pair:cycle-1:dream:1' }),
    );
    expect(dreamCapabilityRun(h.row('cycle-1:dream:1'))?.evaluation).toEqual({
      protocolPin: valid.pin,
      arm: 'structured-pair',
    });
    expect(h.llm).toHaveBeenCalled();
  });

  it('forwards the reviewer budget through the local accounting wrapper into the production scorer seam', async () => {
    const h = harness();
    h.input.review = { model: 'reviewer', timeoutMs: 45_000 };
    const result = await runDreamCycle(h.input, h.d);
    expect(result.accepted).toBe(1);
    expect(h.d.rerank).toHaveBeenCalledWith('query', f.review.priorMatches, { timeoutMs: 45_000 });
    expect(dreamCapabilityRun(h.row('cycle-1:dream:1'))!.calls.some(call => call.phase === 'rerank' && call.status === 'settled')).toBe(true);
  });

  it('holds actual A/B selection fixed across separate pair/triple cycles and changed live history', async () => {
    await rm(f.root, { recursive: true, force: true });
    f = await createDreamCapabilityFixture('ws-cycle', 'papercusp', true);
    const pair = harness(), triple = harness();
    const bound = await pilot(pair);
    const snapshot = await buildCapabilitySamplingSnapshot({ rootPath: f.root, scope: f.scope, manifest: f.manifest, packets: f.packets });
    const thirdRoles = snapshot.eligible.flatMap(a => snapshot.eligible.filter(b => b !== a).map(b => {
      const c = snapshot.eligible.find(e => e !== a && e !== b)!;
      return { aId: a.packet.unit.id, aVersion: a.contentVersion, bId: b.packet.unit.id, bVersion: b.contentVersion,
        cId: c.packet.unit.id, cVersion: c.contentVersion, role: 'constraint' as const,
        contribution: 'Constrain fixture output.', removalEffect: 'The fixture constraint is absent.', evidenceIds: ['code', 'test'] };
    }));
    pair.input.pilot = { ...bound, arm: 'structured-pair', matchedPairIndex: 3 };
    triple.input.pilot = { ...bound, arm: 'structured-triple', matchedPairIndex: 3 };
    triple.input.cycleId = 'different-cycle';
    for (const [h, arity] of [[pair, 2], [triple, 3]] as const) {
      h.input.sampler = { mode: 'structured', arity, thirdRoles };
      h.d.sample = vi.fn(sampleCapabilityCombination);
      h.d.dream = vi.fn(async () => ({ verdict: 'none' as const, usage: { model: 'dreamer', costUsd: 0, inputTokens: 0, outputTokens: 0 } }));
    }
    await runDreamCycle(pair.input, pair.d);
    triple.d.loadHistory = vi.fn(async () => [pair.row('cycle-1:dream:1')]);
    await runDreamCycle(triple.input, triple.d);
    const a = dreamCapabilityRun(pair.row('cycle-1:dream:1'))!;
    const b = dreamCapabilityRun(triple.row('different-cycle:dream:1'))!;
    if (a.sampling?.status !== 'selected' || b.sampling?.status !== 'selected') throw new Error('Missing real matched draw');
    expect(b.sampling.selection.pairKey).toBe(a.sampling.selection.pairKey);
    expect(b.sampling.selection.a.packet.unit.id).toBe(a.sampling.selection.a.packet.unit.id);
    expect(b.sampling.selection.c).not.toBeNull();
    expect(a.sampling.selection.c).toBeNull();
    expect(b.sampling.log.seed).toBe(a.sampling.log.seed);
    expect(b.sampling.log.exposures).toEqual(a.sampling.log.exposures);
    expect(b.evaluation).toMatchObject({ protocolPin: bound.pin, arm: 'structured-triple', matchedPairIndex: 3 });
    expect(triple.d.dream).toHaveBeenCalledOnce();
    expect(triple.d.preflight).toHaveBeenCalledOnce();
  });

  it('refuses an unmatched control arm or overflowing matched assignment before admission', async () => {
    const h = harness(); await pilot(h);
    h.input.pilot!.matchedPairIndex = 0; h.input.pilot!.arm = 'uniform-pair';
    await expect(runDreamCycle(h.input, h.d)).rejects.toThrow(/structured arm/);
    h.input.pilot!.arm = 'structured-pair'; h.input.pilot!.matchedPairIndex = 49;
    h.input.cycle = { maxDreamsPerCycle: 2 };
    await expect(runDreamCycle(h.input, h.d)).rejects.toThrow(/assignment window/);
    expect(h.d.preflight).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('does not count a pair fallback as a structured-triple experiment', async () => {
    const h = harness();
    await pilot(h);
    h.input.pilot!.arm = 'structured-triple';
    h.input.sampler = { mode: 'structured', arity: 3 };
    const result = await runDreamCycle(h.input, h.d);
    expect(result.runs[0]?.status).toBe('error');
    expect(h.row('cycle-1:dream:1').error).toContain('role-labeled C');
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('derives stable attempt identities and refuses invalid ones', () => {
    expect(dreamRunId('cycle', 2)).toBe('cycle:dream:3');
    expect(() => dreamRunId('', 0)).toThrow();
    expect(() => dreamRunId('cycle', -1)).toThrow();
  });

  it('estimates known models and refuses to treat unknown prices as free', () => {
    expect(
      estimateDreamCall({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'source' }] }),
    ).toBeGreaterThan(0);
    expect(() => estimateDreamCall({ model: 'unpriced-provider', messages: [] })).toThrow('unpriced');
  });

  it.each([DEFAULT_DREAM_PASS_CONFIG.model, 'gpt-6-astra:xhigh', 'gpt-5.4:medium'])(
    'admits a priced tiered model %s using the actual request estimate', (model) => {
      const estimate = estimateDreamCall({
        model, messages: [{ role: 'user', content: 'A bounded Dream source packet' }], maxTokens: 1024,
      });
      expect(Number.isFinite(estimate)).toBe(true);
      expect(estimate).toBeGreaterThan(0);
    },
  );

  it('reserves the long-context tier and reasoning output for a large Dream request', () => {
    const estimate = estimateDreamCall({
      model: DEFAULT_DREAM_PASS_CONFIG.model,
      system: 'x'.repeat(272_001), messages: [], maxTokens: 1024, thinkingBudgetTokens: 2048,
    });
    // The maintained Sol rate above 272k input is $4/M input and $15/M output.
    // This lower bound excludes envelope bytes; ordinary-tier admission is unsafe.
    expect(estimate).toBeGreaterThanOrEqual((272_001 * 4 + 3072 * 15) / 1_000_000);
  });

  it('refused admission reads no source and sends no model call', async () => {
    const h = harness();
    h.d.preflight = async () => ({
      allow: false,
      loopId: 'dream:papercusp',
      reason: 'governor-dark',
      cycleRemainingUsd: null,
      rollingSpentUsd: 0,
      rollingRemainingUsd: 5,
      rollingLoopCount: 0,
    });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ fired: false, reason: 'governor-refused' });
    expect(h.d.loadPackets).not.toHaveBeenCalled();
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('a pre-aborted cycle performs no admission or source work', async () => {
    const h = harness(),
      ctrl = new AbortController();
    ctrl.abort();
    expect(await runDreamCycle({ ...h.input, signal: ctrl.signal }, h.d)).toMatchObject({
      reason: 'aborted',
      attempts: 0,
    });
    expect(h.d.preflight).not.toHaveBeenCalled();
  });

  it('AUTO-REQ-M-002-P-005-replay: generation, both controls, review and sink use the existing ledger once', async () => {
    const h = harness();
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ accepted: 1, attempts: 1, costUsd: 0.04 });
    const saved = h.row(dreamRunId('cycle-1', 0));
    expect(saved.review?.verdict).toBe('accept');
    const calls = dreamCapabilityRun(saved)!.calls;
    expect(calls.map((c) => c.callId)).toEqual([
      'packet:catalogue',
      'retrieval:history',
      'retrieval:snapshot',
      'retrieval:review-preflight',
      'rerank:preflight',
      'generation',
      'retrieval:review',
      'rerank',
      'control-a',
      'control-b',
      'review',
    ]);
    expect(calls.every((c) => c.status === 'settled')).toBe(true);
    expect(dreamCallTotals(calls).costUsd).toBeCloseTo(0.04);
    const replay = await runDreamCycle(h.input, h.d);
    expect(replay).toMatchObject({ accepted: 1, newSpendUsd: 0, runs: [{ replayed: true }] });
    expect(h.llm).toHaveBeenCalledTimes(4);
    expect(h.d.loadPackets).toHaveBeenCalledTimes(1);
    expect(h.d.sink).toHaveBeenCalledTimes(1);
  });

  it('attributes every paid phase to a bounded scope/run identity without losing replay safety', async () => {
    const h = harness();
    h.input.cycleId = 'long-cycle-'.repeat(30);
    await runDreamCycle(h.input, h.d);
    const owners = h.llm.mock.calls.map(([call]) => call.ownerId);
    expect(owners).toHaveLength(4);
    for (const [index, phase] of ['generation', 'control-a', 'control-b', 'review'].entries()) {
      expect(owners[index]).toMatch(new RegExp(`^system:dream:[a-f0-9]{64}:${phase}$`));
      expect(owners[index]!.length).toBeLessThanOrEqual(120);
    }
    expect(new Set(owners).size).toBe(4);
    expect(new Set(owners.map((owner) => owner!.split(':')[2])).size).toBe(1);
    await runDreamCycle(h.input, h.d);
    expect(h.llm).toHaveBeenCalledTimes(4);
  });

  it('does not merge gateway attribution across workspaces, pots, or long run ids', async () => {
    const owners: string[] = [];
    for (const [workspaceId, potSlug, suffix] of [
      ['ws-a', 'pot-a', 'one'],
      ['ws-b', 'pot-a', 'one'],
      ['ws-a', 'pot-b', 'one'],
      ['ws-a', 'pot-a', 'two'],
      ['ws-a', 'pot-a', 'one'],
    ]) {
      owners.push(dreamCallOwnerId({ workspaceId: workspaceId!, potSlug: potSlug! }, 'shared-prefix-'.repeat(30) + suffix, 'review'));
    }
    expect(owners.every(Boolean)).toBe(true);
    expect(new Set(owners.slice(0, 4)).size).toBe(4);
    expect(owners[4]).toBe(owners[0]);
  });

  it('runs the real skeptical reviewer with governed phase identities', async () => {
    const h = harness();
    delete h.d.review;
    const judgment = structuredClone(f.review.judgment)!;
    judgment.observations[1]!.evidence = f.review.controls.bOnly!.evidence;
    judgment.relation.evidence = [...f.review.controls.aOnly!.evidence, ...f.review.controls.bOnly!.evidence];
    const prior = f.review.priorMatches[0]!;
    h.d.reviewSources = () => ({
      readCurrent: async () => prior,
      search: async (request) => ({
        scope: request.scope,
        kinds: CAPABILITY_PRIOR_KINDS,
        status: 'current',
        matches: [prior],
        truncated: false,
        note: 'fixture scope',
      }),
    });
    h.llm
      .mockReset()
      .mockResolvedValueOnce({
        text: '',
        json: { schemaVersion: 'dream-capability-result-v1', verdict: 'insight', candidate: f.candidate },
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 10,
      })
      .mockResolvedValueOnce({
        text: '',
        json: f.review.controls.aOnly,
        costUsd: 0.02,
        inputTokens: 100,
        outputTokens: 10,
      })
      .mockResolvedValueOnce({
        text: '',
        json: f.review.controls.bOnly,
        costUsd: 0.03,
        inputTokens: 100,
        outputTokens: 10,
      })
      .mockResolvedValueOnce({ text: '', json: judgment, costUsd: 0.04, inputTokens: 100, outputTokens: 10 });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ accepted: 1, costUsd: 0.1 });
    expect(h.d.sink).toHaveBeenCalledTimes(1);
  });

  it('source scope refusal produces no pair before any model dispatch', async () => {
    const h = harness();
    delete h.d.sample;
    h.d.loadPackets = async () => f.packets.map((p) => ({ ...p, scope: { ...p.scope, workspaceId: 'foreign' } }));
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({
      reason: 'no-pair',
      accepted: 0,
      sources: { eligible: 0 },
    });
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('samples current packets using persisted exposure and cooldown history', async () => {
    const h = harness();
    h.d.loadHistory = async () => [f.run];
    await runDreamCycle(h.input, h.d);
    expect(h.d.sample).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        seed: 'cycle-1:dream:1',
        exposures: { 'capability:A': 1, 'capability:B': 1 },
        history: [{ pairKey: f.selection.pairKey, selectedAt: Date.parse(f.run.startedAt) }],
      }),
    );
  });

  it.each(['none', 'malformed'] as const)('records %s generation with its bill and no review', async (verdict) => {
    const h = harness();
    h.llm.mockResolvedValue({
      text: verdict === 'malformed' ? 'not-json' : '',
      ...(verdict === 'none' ? { json: { schemaVersion: 'dream-capability-result-v1', verdict: 'none' } } : {}),
      costUsd: 0.03,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({
      accepted: 0,
      costUsd: 0.03,
      runs: [{ status: verdict === 'none' ? 'abstained' : 'malformed' }],
    });
    expect(h.d.review).not.toHaveBeenCalled();
    expect(h.d.sink).not.toHaveBeenCalled();
  });

  it('an actual generation overrun is fully charged and prevents the next phase', async () => {
    const h = harness();
    h.llm.mockResolvedValue({
      text: '',
      json: { schemaVersion: 'dream-capability-result-v1', verdict: 'insight', candidate: f.candidate },
      costUsd: 1.05,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ reason: 'cycle-cost-cap', costUsd: 1.05, accepted: 0 });
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.d.review).not.toHaveBeenCalled();
  });

  it('AUTO-REQ-M-002-P-005-counterexamples: failed controls retain successful sibling cost and unknown reservations', async () => {
    const h = harness();
    h.llm.mockImplementation(async (input) => {
      if (input.model === 'dreamer')
        return {
          text: '',
          json: { schemaVersion: 'dream-capability-result-v1', verdict: 'insight', candidate: f.candidate },
          costUsd: 0.01,
          inputTokens: 100,
          outputTokens: 10,
        };
      if (input.messages[0]?.content === 'control-b') throw new Error('provider disconnected');
      return { text: '', costUsd: 0.07, inputTokens: 100, outputTokens: 10 };
    });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({
      accepted: 0,
      costUsd: 0.13,
      runs: [{ status: 'error' }],
    });
    const calls = dreamCapabilityRun(h.row(dreamRunId('cycle-1', 0)))!.calls;
    expect(calls.find((c) => c.phase === 'control-b')).toMatchObject({ status: 'unknown', reservedUsd: 0.05 });
    expect(calls.some((c) => c.phase === 'review')).toBe(false);
    expect(h.d.sink).not.toHaveBeenCalled();
  });

  it('a pause between generation and review retains the generation bill', async () => {
    const h = harness();
    h.d.canContinue = async () => h.llm.mock.calls.length === 0;
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ reason: 'aborted', costUsd: 0.01 });
    expect(h.d.review).not.toHaveBeenCalled();
    expect(h.d.sink).not.toHaveBeenCalled();
  });

  it('abort reaches transport and settles unknown cost even if the provider ignores cancellation', async () => {
    const h = harness(),
      ctrl = new AbortController();
    h.llm.mockImplementation(async (input) => {
      expect(input.signal).toBeDefined();
      ctrl.abort(new Error('owner cancelled'));
      return await new Promise<never>(() => {});
    });
    expect(await runDreamCycle({ ...h.input, signal: ctrl.signal }, h.d)).toMatchObject({
      reason: 'aborted',
      costUsd: 0.05,
      runs: [{ status: 'error' }],
    });
    expect(h.d.sink).not.toHaveBeenCalled();
  });

  it('does not steal a recent in-flight run or dispatch its calls again', async () => {
    const h = harness();
    h.runs.set(dreamRunId('cycle-1', 0), { ...f.run, startedAt: new Date().toISOString() });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ reason: 'in-progress', attempts: 0 });
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.d.finalizeRun).not.toHaveBeenCalled();
  });

  it('an expired interrupted run preserves uncertain spend without repeating the call', async () => {
    const h = harness();
    const r = structuredClone(f.run);
    r.runId = dreamRunId('cycle-1', 0);
    r.review = null;
    const p = dreamCapabilityRun(r)!;
    p.calls = [
      {
        callId: 'generation',
        phase: 'generation',
        model: 'dreamer',
        reservedUsd: 0.2,
        status: 'reserved',
        usage: null,
        error: null,
      },
    ];
    r.outcome = { capabilityRun: p };
    r.costUsd = 0.2;
    h.runs.set(r.runId, r);
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({
      costUsd: 0.2,
      runs: [{ status: 'error', replayed: true }],
    });
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('an exclusive durable-workflow replay recovers immediately instead of stranding a recent interrupted row', async () => {
    const h = harness();
    h.d.exclusiveReplay = true;
    h.runs.set(dreamRunId('cycle-1', 0), {
      ...f.run,
      runId: dreamRunId('cycle-1', 0),
      review: null,
      startedAt: new Date().toISOString(),
    });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ runs: [{ status: 'error', replayed: true }] });
    expect(h.llm).not.toHaveBeenCalled();
  });

  it('frozen accepted review recovers its sink without generation or re-review', async () => {
    const h = harness();
    h.runs.set(dreamRunId('cycle-1', 0), { ...f.run, runId: dreamRunId('cycle-1', 0) });
    expect(await runDreamCycle(h.input, h.d)).toMatchObject({ accepted: 1, runs: [{ replayed: true }] });
    expect(h.d.sink).toHaveBeenCalledTimes(1);
    expect(h.llm).not.toHaveBeenCalled();
  });
});
