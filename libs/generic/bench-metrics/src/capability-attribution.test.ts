import { describe, it, expect } from 'vitest';
import {
  buildCapabilityAttribution,
  buildCrossSuiteAttribution,
  formatAttributionLines,
  DEFAULT_CONTROL_ARM,
  ATTRIBUTION_CAVEATS,
} from './capability-attribution';
import type { TaskRunResult, ArmId, BenchSuite, GraderStatus } from './schema';

let seq = 0;
function mk(over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    modality: 'diff',
    taskId: 't1',
    arm: 'vanilla',
    seed: seq++,
    resolved: false,
    graderStatus: 'failed',
    graderFamily: 'swe-bench-pro',
    graderVersion: 'v1',
    tokensIn: 0,
    tokensOut: 0,
    tokensTotal: 0,
    costUsd: 0,
    priceTableVersion: 'price-table-v1',
    wallClockMs: 1000,
    turns: 1,
    budgetTokens: 2_000_000,
    capped: false,
    generationStatus: 'completed',
    modelId: 'claude-opus-4-8',
    harnessVersion: 'bp@sha',
    preregHash: 'h',
    rolloutId: 'ro1',
    createdAt: '2026-06-15T00:00:00Z',
    ...over,
  };
}

/** One scored boolean attempt: task, arm, resolved, tokens (1M Opus input ≈ $5). */
function attempt(taskId: string, arm: ArmId, resolved: boolean, tokensIn: number, suite: BenchSuite = 'swe-bench-pro'): TaskRunResult {
  return mk({
    taskId,
    arm,
    suite,
    resolved,
    graderStatus: (resolved ? 'passed' : 'failed') as GraderStatus,
    tokensIn,
    tokensTotal: tokensIn,
  });
}

/** One scored CONTINUOUS attempt: resolved=null, a numeric score ∈ [0,1] (SwarmBench / rubric suites). */
function scoreAttempt(taskId: string, arm: ArmId, score: number, suite: BenchSuite = 'swarmbench'): TaskRunResult {
  return mk({ taskId, arm, suite, resolved: null, score, graderStatus: 'passed', tokensIn: 1_000_000, tokensTotal: 1_000_000 });
}

/** N tasks for one arm, each a single seed of the given resolved value + token cost. */
function tasks(arm: ArmId, ids: string[], resolved: boolean, tokensIn: number, suite: BenchSuite = 'swe-bench-pro'): TaskRunResult[] {
  return ids.map((id) => attempt(id, arm, resolved, tokensIn, suite));
}

describe('buildCapabilityAttribution (pass@1)', () => {
  it('holds the control fixed and reports each capability arm lift over it (D-011 inverse view)', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    const rows = [
      ...tasks('vanilla', ids, false, 1_000_000), // control: 0/4
      ...tasks('+memory', ids, true, 1_000_000), //  +memory: 4/4
      ...tasks('+coord', ['t1', 't2'], true, 1_000_000), // +coord on a subset: 2/2 of t1,t2
      ...tasks('+coord', ['t3', 't4'], false, 1_000_000),
    ];
    const rep = buildCapabilityAttribution(rows);
    expect(rep.control).toBe('vanilla');
    expect(rep.metric).toBe('passAt1');
    expect(rep.suite).toBe('swe-bench-pro');
    expect(rep.capabilities.map((c) => c.capability)).toEqual(['+memory', '+coord']);

    const mem = rep.capabilities.find((c) => c.capability === '+memory')!;
    expect(mem.controlValue).toBeCloseTo(0, 6);
    expect(mem.capabilityValue).toBeCloseTo(1, 6);
    expect(mem.valueDelta).toBeCloseTo(1, 6);
    expect(mem.unlockedTasks).toEqual(['t1', 't2', 't3', 't4']);
    expect(mem.regressedTasks).toEqual([]);
    expect(mem.tasksCompared).toBe(4);

    const coord = rep.capabilities.find((c) => c.capability === '+coord')!;
    expect(coord.capabilityValue).toBeCloseTo(0.5, 6);
    expect(coord.valueDelta).toBeCloseTo(0.5, 6);
    expect(coord.unlockedTasks).toEqual(['t1', 't2']);
    expect(coord.neutralTasks).toEqual(['t3', 't4']); // both fail t3/t4 → neutral
  });

  it('matches buildSuiteReport pass@1 numbers (delegates to aggregateArm)', () => {
    const ids = ['t1', 't2', 't3'];
    const rows = [
      ...tasks('vanilla', ids, false, 1_000_000),
      // +memory resolves t1,t2 but not t3 → pass@1 = 2/3
      attempt('t1', '+memory', true, 1_000_000),
      attempt('t2', '+memory', true, 1_000_000),
      attempt('t3', '+memory', false, 1_000_000),
    ];
    const c = buildCapabilityAttribution(rows).capabilities[0];
    expect(c.capabilityValue).toBeCloseTo(2 / 3, 6);
  });

  it('flags significance via CI non-overlap on the value (conservative)', () => {
    const ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const sig = buildCapabilityAttribution([...tasks('vanilla', ids, false, 1_000_000), ...tasks('+memory', ids, true, 1_000_000)]).capabilities[0];
    expect(sig.significant).toBe(true);

    const half = (arm: ArmId): TaskRunResult[] =>
      ids.flatMap((id) => [attempt(id, arm, true, 1_000_000), attempt(id, arm, false, 1_000_000)]);
    const overlap = buildCapabilityAttribution([...half('vanilla'), ...half('+memory')]).capabilities[0];
    expect(overlap.significant).toBe(false);
    expect(overlap.valueDelta).toBeCloseTo(0, 6);
  });

  it('cost-normalizes the lift (D-008): paretoDominates only when better AND no costlier', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    const cheaperBetter = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 100_000),
    ]).capabilities[0];
    expect(cheaperBetter.paretoDominates).toBe(true);
    expect(cheaperBetter.costFraction).toBeCloseTo(0.1, 6);

    const pricierBetter = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 100_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(pricierBetter.valueDelta).toBeGreaterThan(0);
    expect(pricierBetter.paretoDominates).toBe(false);
  });

  it('costRatio is costPerResolved(cap)/control, null when the control resolves nothing', () => {
    const ids = ['t1', 't2', 't3', 't4'];
    const noCtrlResolved = buildCapabilityAttribution([
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(noCtrlResolved.costRatio).toBeNull();

    const ratio = buildCapabilityAttribution([
      ...tasks('vanilla', ['t1', 't2'], true, 1_000_000),
      ...tasks('vanilla', ['t3', 't4'], false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
    ]).capabilities[0];
    expect(ratio.costRatio).toBeCloseTo(0.5, 6);
  });

  it('classifies per-task unlocked / regressed / neutral; same-denominator counts an absent control task as false (C1)', () => {
    const rows = [
      attempt('t1', 'vanilla', true, 1_000_000),
      attempt('t2', 'vanilla', false, 1_000_000),
      attempt('t3', 'vanilla', true, 1_000_000),
      attempt('t1', '+coord', false, 1_000_000), // regressed
      attempt('t2', '+coord', true, 1_000_000), // unlocked
      attempt('t3', '+coord', true, 1_000_000), // neutral
      attempt('t4', '+coord', true, 1_000_000), // no control row → control scores false (absent), so unlocked
    ];
    // DEFAULT = same-denominator (C1): t4 is in the union, control absent → false → +coord unlocked it.
    const c = buildCapabilityAttribution(rows).capabilities[0];
    expect(c.sameDenominator).toBe(true);
    expect(c.unlockedTasks).toEqual(['t2', 't4']);
    expect(c.regressedTasks).toEqual(['t1']);
    expect(c.neutralTasks).toEqual(['t3']);
    expect(c.tasksCompared).toBe(4);

    // SECONDARY exclude-infra view: t4 (no control scored row) is dropped — flatters coverage, labelled.
    const ex = buildCapabilityAttribution(rows, { sameDenominator: false }).capabilities[0];
    expect(ex.unlockedTasks).toEqual(['t2']);
    expect(ex.tasksCompared).toBe(3);
  });

  it('respects an explicit capabilityArms allow-list and default control', () => {
    const ids = ['t1', 't2'];
    const rows = [
      ...tasks('vanilla', ids, false, 1_000_000),
      ...tasks('+memory', ids, true, 1_000_000),
      ...tasks('ours', ids, true, 1_000_000),
    ];
    const only = buildCapabilityAttribution(rows, { capabilityArms: ['+memory'] });
    expect(only.capabilities.map((c) => c.capability)).toEqual(['+memory']);
    expect(DEFAULT_CONTROL_ARM).toBe('vanilla');
  });

  it('supports a non-default control arm', () => {
    const ids = ['t1', 't2'];
    const rows = [...tasks('baseline-b-native', ids, false, 1_000_000), ...tasks('+memory', ids, true, 1_000_000)];
    const rep = buildCapabilityAttribution(rows, { control: 'baseline-b-native' });
    expect(rep.control).toBe('baseline-b-native');
    expect(rep.capabilities[0].valueDelta).toBeCloseTo(1, 6);
  });

  it('throws on empty rows and on a missing control arm', () => {
    expect(() => buildCapabilityAttribution([])).toThrow(/no rows/);
    const noControl = tasks('+memory', ['t1'], true, 1_000_000);
    expect(() => buildCapabilityAttribution(noControl)).toThrow(/control arm "vanilla" has no rows/);
  });

  it('always carries the honest-framing caveats', () => {
    const rows = [attempt('t1', 'vanilla', false, 1_000_000), attempt('t1', '+memory', true, 1_000_000)];
    expect(buildCapabilityAttribution(rows).caveats).toEqual(ATTRIBUTION_CAVEATS);
    expect(ATTRIBUTION_CAVEATS.length).toBeGreaterThanOrEqual(3);
  });
});

describe('buildCapabilityAttribution — fairness same-denominator (C1/C6)', () => {
  it('includes a frozen task absent from both arms without shrinking the population', () => {
    const rows = [attempt('a', 'vanilla', true, 1), attempt('a', '+memory', true, 1)];
    const result = buildCapabilityAttribution(rows, { assignedTaskIds: ['a', 'b'], assignedSeeds: [rows[0].seed, rows[1].seed] });
    expect(result.capabilities[0]).toMatchObject({ tasksCompared: 2, controlValue: 0.25, capabilityValue: 0.25 });
    expect(result.capabilities[0].controlCoverage.absent).toBe(1);
  });

  it('records grader outages as missing measurements and suppresses advantage claims', () => {
    const rows = [attempt('a', 'vanilla', true, 1),
      mk({ taskId: 'a', arm: '+memory', graderStatus: 'timeout', resolved: null })];
    const result = buildCapabilityAttribution(rows);
    expect(result.capabilities).toEqual([]);
    expect(result.missingMeasurements).toEqual([{ arm: '+memory', taskId: 'a', seed: rows[1].seed }]);
    expect(result.caveats.at(-1)).toContain('inconclusive');
  });

  it('counts an arm infra-failure as false in the shared denominator (C1) and tracks coverage (C6)', () => {
    const rows = [
      // both arms attempt t1,t2,t3. control resolves all 3. +memory resolves t1,t2 but INFRA-FAILS t3.
      attempt('t1', 'vanilla', true, 1_000_000),
      attempt('t2', 'vanilla', true, 1_000_000),
      attempt('t3', 'vanilla', true, 1_000_000),
      attempt('t1', '+memory', true, 1_000_000),
      attempt('t2', '+memory', true, 1_000_000),
      mk({ taskId: 't3', arm: '+memory', generationStatus: 'error', resolved: null, tokensIn: 1_000_000, tokensTotal: 1_000_000 }),
    ];
    // SAME-DENOMINATOR (default): t3 counts as false for +memory → +memory 2/3 vs control 3/3 → regressed on t3.
    const fair = buildCapabilityAttribution(rows).capabilities[0];
    expect(fair.controlValue).toBeCloseTo(1, 6);
    expect(fair.capabilityValue).toBeCloseTo(2 / 3, 6);
    expect(fair.valueDelta).toBeCloseTo(-1 / 3, 6);
    expect(fair.regressedTasks).toEqual(['t3']);
    expect(fair.capabilityCoverage.produced).toBe(2);
    expect(fair.capabilityCoverage.infraOnly).toBe(1); // t3 all-infra → counted false, disclosed
    expect(fair.capabilityCoverage.absent).toBe(0);
    expect(fair.controlCoverage.produced).toBe(3);

    // EXCLUDE-INFRA (secondary): t3 is DROPPED for +memory → it looks tied 2/2 vs 2/2 (flattered).
    const ex = buildCapabilityAttribution(rows, { sameDenominator: false }).capabilities[0];
    expect(ex.capabilityValue).toBeCloseTo(1, 6); // 2/2 on its scored set — the C1 trap the standard warns of
    expect(ex.tasksCompared).toBe(2); // t3 dropped
    expect(ex.regressedTasks).toEqual([]);
  });

  it('counts an absent task (one arm never ran it) as false under same-denominator', () => {
    const rows = [
      attempt('t1', 'vanilla', true, 1_000_000),
      attempt('t2', 'vanilla', true, 1_000_000),
      attempt('t1', '+memory', true, 1_000_000),
      // +memory never ran t2 (absent) → false under same-denominator
    ];
    const c = buildCapabilityAttribution(rows).capabilities[0];
    expect(c.capabilityValue).toBeCloseTo(0.5, 6); // t1=1, t2=absent=0
    expect(c.capabilityCoverage.absent).toBe(1);
    expect(c.regressedTasks).toEqual(['t2']); // control 1 > capability 0
  });
});

describe('buildCapabilityAttribution (meanScore — continuous / partial-credit suites)', () => {
  it('attributes on the continuous score when metric=meanScore (resolved=null rows)', () => {
    const rows = [
      // vanilla: scores 0.2, 0.4 → meanScore 0.3
      scoreAttempt('s1', 'vanilla', 0.2),
      scoreAttempt('s2', 'vanilla', 0.4),
      // +coord: scores 0.6, 0.8 → meanScore 0.7
      scoreAttempt('s1', '+coord', 0.6),
      scoreAttempt('s2', '+coord', 0.8),
    ];
    const rep = buildCapabilityAttribution(rows, { metric: 'meanScore' });
    expect(rep.metric).toBe('meanScore');
    const c = rep.capabilities[0];
    expect(c.controlValue).toBeCloseTo(0.3, 6);
    expect(c.capabilityValue).toBeCloseTo(0.7, 6);
    expect(c.valueDelta).toBeCloseTo(0.4, 6);
    // per-task: +coord scores strictly higher on both → both unlocked
    expect(c.unlockedTasks).toEqual(['s1', 's2']);
    expect(c.regressedTasks).toEqual([]);
  });

  it('pass@1 (default) would read continuous rows as fails — meanScore is the right metric', () => {
    const rows = [scoreAttempt('s1', 'vanilla', 0.2), scoreAttempt('s1', '+coord', 0.9)];
    // default metric=passAt1: resolved=null → 0 for both → no lift seen (the degeneracy meanScore fixes)
    const passAt1 = buildCapabilityAttribution(rows).capabilities[0];
    expect(passAt1.valueDelta).toBeCloseTo(0, 6);
    // meanScore: the real lift surfaces
    const meanScore = buildCapabilityAttribution(rows, { metric: 'meanScore' }).capabilities[0];
    expect(meanScore.valueDelta).toBeCloseTo(0.7, 6);
    expect(meanScore.unlockedTasks).toEqual(['s1']);
  });

  it('a continuous regression is bucketed as regressed', () => {
    const rows = [
      scoreAttempt('s1', 'vanilla', 0.8),
      scoreAttempt('s1', '+coord', 0.3), // lower → regressed
    ];
    const c = buildCapabilityAttribution(rows, { metric: 'meanScore' }).capabilities[0];
    expect(c.valueDelta).toBeLessThan(0);
    expect(c.regressedTasks).toEqual(['s1']);
  });
});

describe('buildCrossSuiteAttribution', () => {
  it('folds boolean + continuous suite reports into one matrix + per-capability roll-up', () => {
    const swe = buildCapabilityAttribution([
      ...tasks('vanilla', ['a1', 'a2', 'a3', 'a4'], false, 1_000_000, 'swe-bench-pro'),
      ...tasks('+memory', ['a1', 'a2', 'a3', 'a4'], true, 100_000, 'swe-bench-pro'), // sig + cheaper + better (pass@1)
    ]);
    const swarm = buildCapabilityAttribution(
      [
        scoreAttempt('s1', 'vanilla', 0.1),
        scoreAttempt('s2', 'vanilla', 0.1),
        scoreAttempt('s1', '+memory', 0.9),
        scoreAttempt('s2', '+memory', 0.9),
      ],
      { metric: 'meanScore' },
    );
    const cross = buildCrossSuiteAttribution([swe, swarm]);

    expect(cross.cells).toHaveLength(2);
    expect(cross.cells.map((c) => c.suite)).toEqual(['swe-bench-pro', 'swarmbench']);
    expect(cross.cells.map((c) => c.metric)).toEqual(['passAt1', 'meanScore']);

    const roll = cross.rollup.find((r) => r.capability === '+memory')!;
    expect(roll.suites).toBe(2);
    expect(roll.suitesSignificant).toBe(2);
    expect(roll.totalUnlocked).toBe(6); // 4 on swe + 2 on swarm
    expect(roll.totalRegressed).toBe(0);
    expect(cross.caveats).toEqual(ATTRIBUTION_CAVEATS);
  });

  it('rolls a capability up over only the suites it appeared on', () => {
    const swe = buildCapabilityAttribution([
      ...tasks('vanilla', ['a1', 'a2'], false, 1_000_000, 'swe-bench-pro'),
      ...tasks('+coord', ['a1', 'a2'], true, 1_000_000, 'swe-bench-pro'),
    ]);
    const term = buildCapabilityAttribution([
      ...tasks('vanilla', ['b1', 'b2'], false, 1_000_000, 'terminal-bench'),
      ...tasks('+memory', ['b1', 'b2'], true, 1_000_000, 'terminal-bench'),
    ]);
    const cross = buildCrossSuiteAttribution([swe, term]);
    expect(cross.rollup.find((r) => r.capability === '+coord')!.suites).toBe(1);
    expect(cross.rollup.find((r) => r.capability === '+memory')!.suites).toBe(1);
  });
});

describe('formatAttributionLines', () => {
  it('marks a significant Pareto-better pass@1 lift ✓, a no-lift ·', () => {
    const rep = buildCapabilityAttribution([
      ...tasks('vanilla', ['t1', 't2', 't3', 't4'], false, 1_000_000),
      ...tasks('+memory', ['t1', 't2', 't3', 't4'], true, 100_000),
      ...tasks('+coord', ['t1', 't2', 't3', 't4'], false, 1_000_000),
    ]);
    const lines = formatAttributionLines(rep);
    expect(lines[0]).toMatch(/^✓ \+memory vs vanilla on swe-bench-pro: \+100\.0pp pass@1 \(sig\)/);
    expect(lines[0]).toContain('cost n/a');
    expect(lines[1].startsWith('·')).toBe(true);
  });

  it('formats a meanScore lift with the score delta (not pp)', () => {
    const rep = buildCapabilityAttribution(
      [scoreAttempt('s1', 'vanilla', 0.2), scoreAttempt('s2', 'vanilla', 0.2), scoreAttempt('s1', '+coord', 0.7), scoreAttempt('s2', '+coord', 0.7)],
      { metric: 'meanScore' },
    );
    const line = formatAttributionLines(rep)[0];
    expect(line).toContain('+0.500 meanScore');
    expect(line).not.toContain('pp');
  });
});
