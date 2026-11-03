/**
 * Pure unit tests for the reproducibility layer (BRIEF 8 / P-010) — the bits that
 * need no DB: canonical JSON, the content-addressed prereg hash, and the
 * deterministic rollout id. DB-backed emit/store/prereg/firewall behaviour is in
 * reproducibility.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { canonicalJson } from './canonical-json';
import { computePreregHash } from './prereg';
import { rolloutIdFor } from './emit';
import { fleetRunIdFor } from './fleet';
import {
  currentBenchmarkProtocolSchema, planCurrentBenchmarkConfirmation, requireCurrentBenchmarkAssignment,
  requireSameSolverComparison, type CurrentBenchmarkProtocol,
} from './schema';
import { allCapabilities, controlledProtocolFixture, currentProtocolFixture } from './_protocol-test-fixture';

type Protocol = CurrentBenchmarkProtocol;
const armOf = (protocol: Protocol, id: string) => protocol.arms.find(arm => arm.id === id)!;
const controlOf = (protocol: Protocol, id: string) => armOf(protocol, id).control!;
const issuesOf = (protocol: unknown) => {
  const parsed = currentBenchmarkProtocolSchema.safeParse(protocol);
  return parsed.success ? [] : parsed.error.issues.map(issue => issue.message);
};
const launch = (protocol: Protocol, armId: string, topology?: string) => requireCurrentBenchmarkAssignment(protocol, {
  runId: 'run-1', armId, taskId: 't1', seed: 1, agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto',
  budget: { maxUsd: 3, maxWallClockMs: 100 }, topology: topology as never,
});
const SAME_SOLVER_TOPOLOGIES = ['solo', 'independent', 'coordinated', 'ensemble', 'repeated-session'] as const;

describe('AUTO-BAR-R-4-P-004: controlled arms freeze one solver across every topology', () => {
  it('accepts the stock reference, solver topologies, an ablation and a sequential fresh-session baseline together', () => {
    const protocol = controlledProtocolFixture();
    expect(issuesOf(protocol)).toEqual([]);
    expect(requireSameSolverComparison(protocol, [...SAME_SOLVER_TOPOLOGIES])).toBe('fixture-solver');
  });

  it('keeps uncontrolled protocols readable but refuses a protocol where only some arms are controlled', () => {
    expect(issuesOf(currentProtocolFixture())).toEqual([]);
    const mixed = controlledProtocolFixture(); delete armOf(mixed, 'solo').control;
    expect(issuesOf(mixed)).toContainEqual(expect.stringMatching(/every arm declares a control block/));
  });

  it('binds the launch to the frozen topology and refuses an undeclared or different one', () => {
    const protocol = controlledProtocolFixture();
    for (const topology of SAME_SOLVER_TOPOLOGIES) expect(launch(protocol, topology, topology)).toEqual(protocol);
    expect(() => launch(protocol, 'solo')).toThrow(/frozen as solo/);
    expect(() => launch(protocol, 'solo', 'coordinated')).toThrow(/frozen as solo/);
    expect(launch(currentProtocolFixture(), 'papercusp')).toBeDefined();
  });

  it('lets topologies differ in coordination prompts and tools while the solver tool surface stays pinned', () => {
    const protocol = controlledProtocolFixture();
    armOf(protocol, 'coordinated').runtime.toolsHash = 'e'.repeat(64);
    armOf(protocol, 'coordinated').runtime.promptHash = 'e'.repeat(64);
    expect(issuesOf(protocol)).toEqual([]);
  });

  it('changes the frozen protocol hash when a capability toggle or topology changes', () => {
    const base = controlledProtocolFixture(); const frozen = computePreregHash(base);
    const toggled = structuredClone(base); controlOf(toggled, 'solo').capabilities.review = 'off';
    const moved = structuredClone(base); controlOf(moved, 'independent').topology = 'solo';
    expect(computePreregHash(toggled)).not.toBe(frozen);
    expect(computePreregHash(moved)).not.toBe(frozen);
  });

  it('freezes matched compaction thresholds into the existing protocol hash and comparison guard', () => {
    const protocol = controlledProtocolFixture(), historicalHash = computePreregHash(protocol);
    for (const arm of protocol.arms) arm.control!.compactionLimit = 20_000;
    expect(issuesOf(protocol)).toEqual([]);
    expect(computePreregHash(protocol)).not.toBe(historicalHash);
    const frozenHash = computePreregHash(protocol);
    controlOf(protocol, 'coordinated-no-locks').compactionLimit = 21_000;
    expect(computePreregHash(protocol)).not.toBe(frozenHash);
    expect(issuesOf(protocol)).toContainEqual(expect.stringMatching(/freeze identical solver settings/));
    expect(() => requireSameSolverComparison(protocol, ['coordinated', 'coordinated-no-locks']))
      .toThrow(/drifts from the frozen solver settings/);
  });

  it.each([0, 19_999, 20_000.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid frozen compaction threshold %s', value => {
    const protocol = controlledProtocolFixture();
    for (const arm of protocol.arms) arm.control!.compactionLimit = value;
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });
});

describe('BM-P-004-equal-solver: one mismatched solver field breaks the same-solver comparison', () => {
  const mutations: Array<[string, (arm: Protocol['arms'][number]) => void]> = [
    ['agent', arm => { arm.agent = 'claude'; }],
    ['model', arm => { arm.model = 'other-model'; }],
    ['effort', arm => { arm.effort = 'low'; }],
    ['account', arm => { arm.account = 'pinned-account'; }],
    ['generationBudget', arm => { arm.generationBudget.maxUsd = 4; }],
    ['sourceRevision', arm => { arm.runtime.sourceRevision = 'other-source'; }],
    ['runtimeRevision', arm => { arm.runtime.runtimeRevision = 'other-runtime'; }],
    ['clientVersion', arm => { arm.runtime.clientVersion = 'other-client'; }],
    ['promptHashMode', arm => { arm.runtime.promptHashMode = 'codex-native-template-v1'; }],
    ['solverToolsHash', arm => { arm.control!.solverToolsHash = 'e'.repeat(64); }],
    ['compactionLimit', arm => { arm.control!.compactionLimit = 20_000; }],
  ];
  const cases = SAME_SOLVER_TOPOLOGIES.flatMap(topology => mutations.map(([field, mutate]) => [topology, field, mutate] as const));

  it.each(cases)('%s arm with a different %s is refused by the schema and by the comparison guard', (topology, _field, mutate) => {
    const protocol = controlledProtocolFixture();
    protocol.priceSchedule.rates.push({ model: 'other-model', inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 2 });
    mutate(armOf(protocol, topology));
    expect(issuesOf(protocol)).toContainEqual(expect.stringMatching(/solver group fixture-solver must freeze identical solver settings/));
    expect(() => requireSameSolverComparison(protocol, [...SAME_SOLVER_TOPOLOGIES])).toThrow(/drifts from the frozen solver settings/);
  });

  it('refuses a comparison across solver groups, unknown arms, uncontrolled arms or a single arm', () => {
    // Regroup a non-baseline arm: the sequential control must stay in fixture-solver.
    const regrouped = controlledProtocolFixture(); controlOf(regrouped, 'independent').solverGroup = 'other-solver';
    expect(issuesOf(regrouped)).toEqual([]);
    expect(() => requireSameSolverComparison(regrouped, [...SAME_SOLVER_TOPOLOGIES])).toThrow(/share one solver group/);
    expect(() => requireSameSolverComparison(controlledProtocolFixture(), ['solo', 'missing'])).toThrow(/not in the frozen protocol/);
    expect(() => requireSameSolverComparison(currentProtocolFixture(), ['papercusp', 'baseline'])).toThrow(/no control block/);
    expect(() => requireSameSolverComparison(controlledProtocolFixture(), ['solo'])).toThrow(/at least two arms/);
  });

  it('refuses at launch when any solver-group peer of the launched arm drifts', () => {
    const protocol = controlledProtocolFixture();
    armOf(protocol, 'independent').runtime.clientVersion = 'drifted';
    expect(() => launch(protocol, 'solo', 'solo')).toThrow(/complete frozen protocol/);
  });
});

describe('BM-P-004-ablation: an ablation switches off exactly one capability of a full control', () => {
  const defects: Array<[string, (protocol: Protocol) => void, RegExp]> = [
    ['missing control arm', p => { controlOf(p, 'coordinated-no-locks').ablation!.of = 'missing'; }, /another declared arm/],
    ['self-referencing ablation', p => { controlOf(p, 'coordinated-no-locks').ablation!.of = 'coordinated-no-locks'; }, /another declared arm/],
    ['ablation of an ablation', p => {
      const nested = structuredClone(armOf(p, 'coordinated-no-locks')); nested.id = 'nested';
      nested.control!.capabilities['review'] = 'off';
      nested.control!.ablation = { of: 'coordinated-no-locks', treatment: 'review' };
      p.arms.push(nested);
    }, /full control, not another ablation/],
    ['different topology', p => { controlOf(p, 'coordinated-no-locks').ablation!.of = 'solo'; }, /solver group, topology and ensemble/],
    ['different solver group', p => { controlOf(p, 'coordinated-no-locks').solverGroup = 'other-solver'; }, /solver group, topology and ensemble/],
    ['two capabilities switched', p => { controlOf(p, 'coordinated-no-locks').capabilities['review'] = 'off'; }, /exactly locks/],
    ['wrong treatment named', p => { controlOf(p, 'coordinated-no-locks').ablation!.treatment = 'review'; }, /exactly review/],
    ['treatment already off in the control', p => {
      controlOf(p, 'coordinated').capabilities.locks = 'off'; controlOf(p, 'coordinated-no-locks').capabilities.locks = 'on';
    }, /exactly locks/],
    ['nothing switched', p => { controlOf(p, 'coordinated-no-locks').capabilities.locks = 'on'; }, /exactly locks/],
    ['stock reference with a capability on', p => { controlOf(p, 'stock').capabilities['memory-recall'] = 'on'; }, /every product capability off/],
    ['stock reference declared as an ablation', p => { controlOf(p, 'stock').ablation = { of: 'solo', treatment: 'locks' }; }, /not an ablation/],
    ['ensemble without its block', p => { delete controlOf(p, 'ensemble').ensemble; }, /exactly when the topology is ensemble/],
    ['ensemble block on a solo arm', p => { controlOf(p, 'solo').ensemble = structuredClone(controlOf(p, 'ensemble').ensemble); }, /exactly when the topology is ensemble/],
    // R-14 / D-037: independent candidate selection cannot substitute for continuing one workspace.
    ['an ensemble without a repeated-session baseline', p => { p.arms = p.arms.filter(arm => arm.id !== 'repeated-session'); }, /repeated-session baseline/],
    ['baseline only in another solver group', p => { controlOf(p, 'repeated-session').solverGroup = 'other-solver'; }, /repeated-session baseline/],
    ['baseline matched to another treatment', p => { controlOf(p, 'repeated-session').repeatedSession!.matchedCostOf = 'solo'; }, /repeated-session baseline/],
    ['baseline that is the ablation\'s own control', p => {
      const ablation = controlOf(p, 'coordinated-no-locks');
      ablation.topology = 'repeated-session'; ablation.repeatedSession = structuredClone(controlOf(p, 'repeated-session').repeatedSession);
      ablation.ablation = { of: 'repeated-session', treatment: 'locks' };
    }, /repeated-session baseline/],
  ];

  it.each(defects)('rejects %s', (_name, mutate, message) => {
    const protocol = controlledProtocolFixture(); mutate(protocol);
    expect(issuesOf(protocol)).toContainEqual(expect.stringMatching(message));
  });

  it.each([
    ['an omitted capability', (p: Protocol) => { delete (controlOf(p, 'solo').capabilities as Record<string, unknown>)['review']; }],
    ['an undeclared capability', (p: Protocol) => { (controlOf(p, 'solo').capabilities as Record<string, unknown>)['telepathy'] = 'on'; }],
    ['a non-binary toggle', (p: Protocol) => { (controlOf(p, 'solo').capabilities as Record<string, unknown>)['locks'] = 'partial'; }],
    ['a single-candidate ensemble', (p: Protocol) => { controlOf(p, 'ensemble').ensemble!.candidates = 1; }],
    ['an uncharged selector', (p: Protocol) => { (controlOf(p, 'ensemble').ensemble!.selector as Record<string, unknown>).charged = false; }],
  ])('rejects %s', (_name, mutate) => {
    const protocol = controlledProtocolFixture(); mutate(protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });

  it('accepts one valid single-capability ablation for each capability', () => {
    for (const treatment of Object.keys(allCapabilities('on')) as Array<keyof ReturnType<typeof allCapabilities>>) {
      const protocol = controlledProtocolFixture();
      const ablation = controlOf(protocol, 'coordinated-no-locks');
      ablation.capabilities = { ...allCapabilities('on'), [treatment]: 'off' };
      ablation.ablation = { of: 'coordinated', treatment };
      expect(issuesOf(protocol)).toEqual([]);
    }
  });
});

describe('P-019 repeated-session protocol', () => {
  const defects: Array<[string, (protocol: Protocol) => void, RegExp]> = [
    ['missing session policy', p => { delete controlOf(p, 'repeated-session').repeatedSession; }, /exactly when the topology is repeated-session/],
    ['session policy on a solo arm', p => { controlOf(p, 'solo').repeatedSession = structuredClone(controlOf(p, 'repeated-session').repeatedSession); }, /exactly when the topology is repeated-session/],
    ['unknown cost target', p => { controlOf(p, 'repeated-session').repeatedSession!.matchedCostOf = 'missing'; }, /existing distinct full treatment/],
    ['self as cost target', p => { controlOf(p, 'repeated-session').repeatedSession!.matchedCostOf = 'repeated-session'; }, /existing distinct full treatment/],
    ['stock reference as cost target', p => { controlOf(p, 'repeated-session').repeatedSession!.matchedCostOf = 'stock'; }, /existing distinct full treatment/],
    ['ablation as cost target', p => { controlOf(p, 'repeated-session').repeatedSession!.matchedCostOf = 'coordinated-no-locks'; }, /existing distinct full treatment/],
    ['product carry on', p => { controlOf(p, 'repeated-session').capabilities['carry-respawn'] = 'on'; }, /every product capability off/],
  ];
  it.each(defects)('rejects %s', (_name, mutate, message) => {
    const protocol = controlledProtocolFixture(); mutate(protocol);
    expect(issuesOf(protocol)).toContainEqual(expect.stringMatching(message));
  });
  it.each([
    ['zero sessions', (p: Protocol) => { controlOf(p, 'repeated-session').repeatedSession!.maxSessions = 0; }],
    ['fractional sessions', (p: Protocol) => { controlOf(p, 'repeated-session').repeatedSession!.maxSessions = 1.5; }],
    ['independent workspaces', (p: Protocol) => { (controlOf(p, 'repeated-session').repeatedSession as Record<string, unknown>).workspace = 'independent'; }],
    ['conversation carry', (p: Protocol) => { (controlOf(p, 'repeated-session').repeatedSession as Record<string, unknown>).sessionContext = 'carry'; }],
    ['winner selection', (p: Protocol) => { (controlOf(p, 'repeated-session').repeatedSession as Record<string, unknown>).submission = 'best-candidate'; }],
  ])('rejects %s', (_name, mutate) => {
    const protocol = controlledProtocolFixture(); mutate(protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });
  it('freezes the actual-cost pairing and session count into preregistration', () => {
    const protocol = controlledProtocolFixture(), frozen = computePreregHash(protocol);
    controlOf(protocol, 'repeated-session').repeatedSession!.maxSessions++;
    expect(computePreregHash(protocol)).not.toBe(frozen);
    controlOf(protocol, 'repeated-session').repeatedSession!.maxSessions--;
    controlOf(protocol, 'repeated-session').repeatedSession!.matchedCostOf = 'solo';
    expect(computePreregHash(protocol)).not.toBe(frozen);
  });
});

describe('current frozen benchmark protocol', () => {
  it('derives withheld power from exact repository counts, never pilot tasks or repeated seeds', () => {
    const protocol = currentProtocolFixture();
    protocol.confirmation.method = 'paired-repository-hoeffding-v1';
    protocol.confirmation.taskIds = ['withheld-1', 'withheld-2'];
    protocol.confirmation.plannedPairedTasks = 2;
    protocol.sampling!.taskRepositories['withheld-2'] = 'another-repo';
    const base = planCurrentBenchmarkConfirmation(protocol);
    expect(base).toMatchObject({ independentRepositories: 2, effectiveRepositories: 2, pairedTasks: 2,
      seedsPerTask: 1, generationAssignments: 4, meetsTarget: false, inferenceAuthorized: false });
    expect(base.repositories).toEqual([{ repository: 'another-repo', pairedTasks: 1 }, { repository: 'withheld-repo', pairedTasks: 1 }]);
    protocol.confirmation.seeds = [2, 3, 4];
    const repeated = planCurrentBenchmarkConfirmation(protocol);
    expect(repeated.generationAssignments).toBe(12);
    expect(repeated.effectiveRepositories).toBe(base.effectiveRepositories);
    expect(repeated.powerLowerBound).toBe(base.powerLowerBound);
    expect(repeated.detectableEffectBound).toBe(base.detectableEffectBound);
    protocol.sampling!.taskRepositories['withheld-2'] = 'withheld-repo';
    expect(planCurrentBenchmarkConfirmation(protocol).independentRepositories).toBe(1);
  });

  it('refuses an unbound method, repository mapping or unspecified confirmation subset', () => {
    const protocol = currentProtocolFixture();
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/rejection rule/);
    protocol.confirmation.method = 'paired-repository-hoeffding-v1';
    delete protocol.sampling;
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/repository mapping/);
    protocol.sampling = currentProtocolFixture().sampling;
    protocol.confirmation.taskIds.push('withheld-2');
    protocol.sampling!.taskRepositories['withheld-2'] = 'withheld-repo';
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/unspecified subset/);
    protocol.confirmation.plannedPairedTasks = 2;
    expect(() => planCurrentBenchmarkConfirmation(protocol)).not.toThrow();
    protocol.confirmation.taskIds[1] = 't1';
    expect(() => planCurrentBenchmarkConfirmation(protocol)).toThrow(/withheld/);
  });

  it('binds a complete declared assignment to the configured launch and equal generation cap', () => {
    const protocol = currentProtocolFixture();
    expect(requireCurrentBenchmarkAssignment(protocol, { runId: 'run-1', armId: 'papercusp', taskId: 't1', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto', budget: { maxUsd: 3, maxWallClockMs: 100 } })).toEqual(protocol);
  });
  it.each(['taskIds', 'seeds', 'arms', 'aggregateBudgetUsd', 'maxInFlightUsd', 'priceSchedule', 'grader', 'context', 'exclusions', 'stopping', 'confirmation'])
    ('refuses omitted frozen protocol component %s', field => {
      const protocol = currentProtocolFixture() as unknown as Record<string, unknown>; delete protocol[field];
      expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    });
  it.each([
    ['duplicate-task', (p: ReturnType<typeof currentProtocolFixture>) => { p.taskIds.push('t1'); }],
    ['duplicate-seed', (p: ReturnType<typeof currentProtocolFixture>) => { p.seeds.push(1); }],
    ['duplicate-arm', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[1].id = p.arms[0].id; }],
    ['unequal-caps', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[1].generationBudget.maxUsd = 4; }],
    ['unbounded-exposure', (p: ReturnType<typeof currentProtocolFixture>) => { p.maxInFlightUsd = 61; }],
    ['unpriced-model', (p: ReturnType<typeof currentProtocolFixture>) => { p.arms[0].model = 'other'; }],
    ['withheld-leak', (p: ReturnType<typeof currentProtocolFixture>) => { p.confirmation.taskIds.push('t1'); }],
    ['underreserved-confirmation', (p: ReturnType<typeof currentProtocolFixture>) => { p.confirmation.plannedPairedTasks = 2; }],
    ['missing-context-pin', (p: ReturnType<typeof currentProtocolFixture>) => { p.context.memoryHash = ''; }],
  ])('rejects protocol defect %s', (_name, mutate) => {
    const protocol = currentProtocolFixture(); mutate(protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });
  it('changes the immutable protocol hash for each meaningful identity or policy drift', () => {
    const base = currentProtocolFixture(); const frozen = computePreregHash(base);
    for (const mutate of [
      (p: typeof base) => { p.arms[0].model = 'changed'; },
      (p: typeof base) => { p.arms[0].runtime.promptHash = 'e'.repeat(64); },
      (p: typeof base) => { p.arms[0].runtime.toolsHash = 'e'.repeat(64); },
      (p: typeof base) => { p.grader.version = 'changed'; },
      (p: typeof base) => { p.taskIds = ['changed']; },
      (p: typeof base) => { p.seeds = [2]; },
      (p: typeof base) => { p.aggregateBudgetUsd = 59; },
      (p: typeof base) => { p.exclusions = ['changed']; },
      (p: typeof base) => { p.stopping.maxAttemptsPerAssignment = 2; },
      (p: typeof base) => { p.sampling!.taskRepositories.t1 = 'other-repository'; },
      (p: typeof base) => { p.sampling!.bootstrapSeed = 17; },
      (p: typeof base) => { p.sampling!.bootstrapIterations = 2000; },
      (p: typeof base) => { p.sampling!.ci = 0.9; },
    ]) { const changed = structuredClone(base); mutate(changed); expect(computePreregHash(changed)).not.toBe(frozen); }
  });

  it('requires frozen repository sampling for new launches while preserving older protocol reads', () => {
    const protocol = currentProtocolFixture(); delete protocol.sampling;
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    expect(() => requireCurrentBenchmarkAssignment(protocol, { runId: 'run-1', armId: 'papercusp', taskId: 't1', seed: 1,
      agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto', budget: { maxUsd: 3, maxWallClockMs: 100 } }))
      .toThrow(/repository sampling/);
  });

  it.each(['missing-pilot', 'missing-confirmation', 'foreign-task', 'blank-repository', 'unknown-unit'])
    ('refuses repository sampling defect %s', defect => {
      const protocol = currentProtocolFixture(); const sampling = protocol.sampling!;
      if (defect === 'missing-pilot') delete sampling.taskRepositories.t1;
      if (defect === 'missing-confirmation') delete sampling.taskRepositories['withheld-1'];
      if (defect === 'foreign-task') sampling.taskRepositories.foreign = 'repo';
      if (defect === 'blank-repository') sampling.taskRepositories.t1 = '';
      if (defect === 'unknown-unit') (sampling as { unit: string }).unit = 'seed';
      expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    });

  // benchmark-coverage-frontierswe-v2-2026-10-10#D-023: a Codex arm may be paid by a
  // ChatGPT subscription, but never compared against an API-key arm, and only with the
  // provider's own frozen input and output limits standing in for max_output_tokens.
  describe('D-023 payer basis', () => {
    const subscription = () => {
      const protocol = currentProtocolFixture();
      const rate = protocol.priceSchedule.rates[0];
      rate.inputTokenCeiling = 1000; rate.inputTokenCeilingSourceSha256 = 'a'.repeat(64); rate.outputTokenCeiling = 128;
      for (const arm of protocol.arms) arm.payer = 'subscription';
      return protocol;
    };
    it('accepts matched Codex subscription arms with frozen provider input and output ceilings', () => {
      expect(issuesOf(subscription())).toEqual([]);
      const apiKey = subscription(); for (const arm of apiKey.arms) delete arm.payer;
      expect(issuesOf(apiKey)).toEqual([]);
    });
    it.each([
      ['mixed', 'Matched arms require one payer basis.'],
      ['claude', 'Only Codex arms support the subscription payer.'],
      ['missing-output', 'A subscription arm needs frozen provider input and output ceilings.'],
      ['output-without-input', 'A provider output ceiling requires the frozen native input ceiling.'],
    ] as const)('refuses %s', (defect, message) => {
      const protocol = subscription(); const rate = protocol.priceSchedule.rates[0];
      if (defect === 'mixed') delete protocol.arms[1].payer;
      if (defect === 'claude') protocol.arms[0].agent = 'claude';
      if (defect === 'missing-output') delete rate.outputTokenCeiling;
      if (defect === 'output-without-input') {
        delete rate.inputTokenCeiling; delete rate.inputTokenCeilingSourceSha256;
        for (const arm of protocol.arms) delete arm.payer;
      }
      expect(issuesOf(protocol)).toContain(message);
    });
  });
});

describe('canonicalJson', () => {
  it('is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys but preserves array order', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"z":{"x":2,"y":1}}');
  });

  it('drops undefined members', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe('computePreregHash', () => {
  it('is stable across key order (content-addressed)', () => {
    const a = computePreregHash({ arms: ['papercusp'], seeds: 3, suite: 'swe-bench-pro' });
    const b = computePreregHash({ suite: 'swe-bench-pro', seeds: 3, arms: ['papercusp'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the config changes (tune-to-test tamper-evidence)', () => {
    const a = computePreregHash({ seeds: 3 });
    const b = computePreregHash({ seeds: 5 });
    expect(a).not.toBe(b);
  });
});

describe('rolloutIdFor', () => {
  it('is deterministic for the same attempt key', () => {
    expect(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0)).toBe(
      rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0),
    );
  });

  it('differs per seed, per arm, and per task (no collisions across the natural key)', () => {
    const base = rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 0);
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'papercusp', 1));
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-1', 'baseline-a-ablation', 0));
    expect(base).not.toBe(rolloutIdFor('run1', 'swe-bench-pro', 'task-2', 'papercusp', 0));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('fleetRunIdFor', () => {
  it('is deterministic and differs per fleet arm, backlog, and seed', () => {
    const base = fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 0);
    expect(base).toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'queen-ablated', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-B', 'hive', 0));
    expect(base).not.toBe(fleetRunIdFor('run1', 'swe-bench-pro', 'backlog-A', 'hive', 1));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
  });
});
