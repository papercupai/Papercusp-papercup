import { describe, it, expect } from 'vitest';
import {
  admitCapabilityLift,
  classifyExercise,
  mergeCapabilityEvidence,
  readCapabilityEvidence,
  withCapabilityEvidence,
  CAPABILITY_EVIDENCE_META_KEY,
  type CapabilityExerciseEvidence,
} from './capability-exercise';
import { buildCapabilityAttribution } from './capability-attribution';
import { buildFairnessAudit } from './fairness-audit';
import type { TaskRunResult } from './schema';

let seq = 0;
function row(taskId: string, arm: string, resolved: boolean, evidence?: CapabilityExerciseEvidence[], over: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    runId: 'run1', suite: 'swe-bench-pro', modality: 'diff', taskId, arm, seed: seq++,
    resolved, graderStatus: resolved ? 'passed' : 'failed', graderFamily: 'g', graderVersion: 'v1',
    tokensIn: 100, tokensOut: 10, tokensTotal: 110, costUsd: 0.01, priceTableVersion: 'price-table-v1', wallClockMs: 1,
    turns: 1, budgetTokens: 1000, capped: false, generationStatus: 'completed', modelId: 'claude-opus-4-8', harnessVersion: 'h',
    preregHash: 'ph', rolloutId: 'ro', createdAt: '2026-10-12T00:00:00Z',
    armMeta: evidence ? withCapabilityEvidence({ coordCalls: 0 }, evidence) : null,
    ...over,
  };
}
const coord = (delivered: number | null, used: number | null, available: boolean | null = true): CapabilityExerciseEvidence =>
  ({ capability: 'fleet-leader', available, delivered, used });

/** Coordinated treatment resolves everything; the solo control resolves nothing — a large raw delta. */
function lift(treatment: CapabilityExerciseEvidence[] | undefined, control: CapabilityExerciseEvidence[] | null = [coord(0, 0, false)]) {
  return [
    row('t1', 'solo', false, control ?? undefined), row('t2', 'solo', false, control ?? undefined),
    row('t1', 'coordinated', true, treatment), row('t2', 'coordinated', true, treatment),
  ];
}

/** The repeated-session baseline arm on t1/t2: same solver re-run, no capability claim. */
function repeated(resolved: [boolean, boolean], cheaper = false) {
  const over: Partial<TaskRunResult> = cheaper ? { costUsd: 0.005, tokensIn: 50, tokensOut: 5, tokensTotal: 55 } : {};
  return [row('t1', 'repeated', resolved[0], undefined, over), row('t2', 'repeated', resolved[1], undefined, over)];
}

describe('BM-P-004-exercise-evidence: a capability lift claim requires observed delivery and use', () => {
  it('admits a lift only with measured delivery AND use in treatment and measured absence in control', () => {
    const a = admitCapabilityLift(lift([coord(3, 2)]), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(a.admitted).toBe(true);
    expect(a.refusals).toEqual([]);
    expect(a.treatment).toEqual({ rows: 2, exercised: 2, unexercised: 0, unknown: 0 });
    expect(a.control).toEqual({ rows: 2, clean: 2, leaked: 0, unknown: 0 });
  });

  it('refuses missing delivery: actions without any delivered coordination input are not use', () => {
    const a = admitCapabilityLift(lift([coord(0, 5)]), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(a.admitted).toBe(false);
    expect(a.refusals).toContain('treatment-never-exercised');
  });

  it('refuses missing action: delivered input the agent never acted on supports no attribution', () => {
    const a = admitCapabilityLift(lift([coord(4, 0)]), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(a.refusals).toEqual(['treatment-never-exercised']);
  });

  it('refuses parallel unrelated runs with no traces at all (a label is not evidence)', () => {
    const a = admitCapabilityLift(lift(undefined), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(a.refusals).toEqual(['treatment-evidence-unknown']);
  });

  it('treats an unmeasured counter as unknown, never as zero', () => {
    expect(classifyExercise(coord(null, 2))).toBe('unknown');
    expect(classifyExercise(coord(1, 1, null))).toBe('unknown');
    const a = admitCapabilityLift(lift([coord(3, null)]), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(a.refusals).toContain('treatment-evidence-unknown');
  });

  it('refuses a control that leaked the capability or did not measure its absence', () => {
    const leak = admitCapabilityLift(lift([coord(3, 2)], [coord(1, 0, false)]), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(leak.refusals).toEqual(['control-leak']);
    const blind = admitCapabilityLift(lift([coord(3, 2)], null), { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' });
    expect(blind.refusals).toEqual(['control-evidence-unknown']);
  });

  it('ignores generation-infra rows (nothing ran, so nothing was delivered)', () => {
    const rows = [...lift([coord(3, 2)]), row('t3', 'coordinated', false, undefined, { generationStatus: 'error' })];
    expect(admitCapabilityLift(rows, { capability: 'fleet-leader', treatmentArm: 'coordinated', controlArm: 'solo' }).admitted).toBe(true);
  });

  it('attribution withholds the lift (liftAdmitted=false + caveat) when evidence is missing, and admits it when present', () => {
    const refused = buildCapabilityAttribution(lift([coord(0, 0)]), { control: 'solo', capabilityExercise: { coordinated: 'fleet-leader' } });
    const c = refused.capabilities[0];
    expect(c.valueDelta).toBe(1); // the raw delta is still MEASURED and reported
    expect(c.liftAdmitted).toBe(false);
    expect(c.liftAdmissions[0].refusals).toEqual(['treatment-never-exercised']);
    expect(refused.caveats.some((line) => line.includes('Capability lift NOT admitted for coordinated'))).toBe(true);

    const admitted = buildCapabilityAttribution([...lift([coord(2, 2)]), ...repeated([true, false])],
      { control: 'solo', capabilityArms: ['coordinated'], capabilityExercise: { coordinated: 'fleet-leader' }, repeatedSessionBaseline: 'repeated' });
    expect(admitted.capabilities[0].liftAdmitted).toBe(true);
    expect(admitted.capabilities[0].repeatedSessionBaseline).toMatchObject({ arm: 'repeated', value: 0.5, valueDelta: 0.5, beaten: true });
    expect(admitted.caveats.some((line) => line.includes('NOT admitted'))).toBe(false);
  });

  // AUTO-BAR-R-14-P-011: a lift is never claimed without beating a matched-cost repeated-session baseline.
  describe('matched-cost repeated-session baseline (R-14)', () => {
    const claim = { control: 'solo', capabilityArms: ['coordinated'], capabilityExercise: { coordinated: 'fleet-leader' } };
    it('admits nothing when no baseline is declared, and says so', () => {
      const rep = buildCapabilityAttribution(lift([coord(2, 2)]), claim);
      expect(rep.capabilities[0].liftAdmitted).toBe(false);
      expect(rep.capabilities[0].repeatedSessionBaseline).toBeNull();
      expect(rep.caveats.some((line) => line.includes('No matched-cost repeated-session baseline was declared'))).toBe(true);
    });
    it('refuses a declared baseline that has no rows', () => {
      const rep = buildCapabilityAttribution(lift([coord(2, 2)]), { ...claim, repeatedSessionBaseline: 'repeated' });
      expect(rep.capabilities[0].liftAdmitted).toBe(false);
      expect(rep.caveats.some((line) => line.includes('(repeated) was measured'))).toBe(true);
    });
    it('refuses a treatment that only ties the baseline', () => {
      const rep = buildCapabilityAttribution([...lift([coord(2, 2)]), ...repeated([true, true])], { ...claim, repeatedSessionBaseline: 'repeated' });
      expect(rep.capabilities[0].repeatedSessionBaseline).toMatchObject({ valueDelta: 0, beaten: false });
      expect(rep.capabilities[0].liftAdmitted).toBe(false);
    });
    it('refuses a treatment that wins only by spending more than the baseline', () => {
      const rep = buildCapabilityAttribution([...lift([coord(2, 2)]), ...repeated([false, false], true)], { ...claim, repeatedSessionBaseline: 'repeated' });
      const versus = rep.capabilities[0].repeatedSessionBaseline!;
      expect(versus).toMatchObject({ valueDelta: 1, beaten: false });
      expect(versus.costFraction).toBeGreaterThan(1);
      expect(rep.capabilities[0].liftAdmitted).toBe(false);
    });
  });

  it('an arm that declares no claimed capability is never admitted', () => {
    const rep = buildCapabilityAttribution(lift([coord(2, 2)]), { control: 'solo' });
    expect(rep.capabilities[0].liftAdmissions).toEqual([]);
    expect(rep.capabilities[0].liftAdmitted).toBe(false);
  });

  it('fairness C4 is derived from evidence: FAIL when never exercised, PASS when admitted, manual when undeclared', () => {
    const c4 = (rows: TaskRunResult[], declared: boolean) => buildFairnessAudit(rows, declared
      ? { capabilityExercise: { control: 'solo', arms: { coordinated: 'fleet-leader' } } } : {}).criteria.find((c) => c.id === 'C4')!;
    expect(c4(lift([coord(0, 0)]), true).status).toBe('FAIL');
    expect(c4(lift([coord(2, 1)]), true).status).toBe('PASS');
    expect(c4(lift([coord(2, null)]), true).status).toBe('NEEDS-EVIDENCE');
    expect(c4(lift([coord(2, 1)]), false).status).toBe('NEEDS-EVIDENCE');
  });
});

describe('capability evidence persistence + merge', () => {
  it('round-trips through armMeta and drops malformed entries (they read as unmeasured)', () => {
    const r = row('t1', 'a', true, [coord(1, 2)]);
    r.armMeta = { ...r.armMeta, [CAPABILITY_EVIDENCE_META_KEY]: [...(r.armMeta![CAPABILITY_EVIDENCE_META_KEY] as unknown[]), { capability: 'x', available: true, delivered: -1, used: 0 }] };
    expect(readCapabilityEvidence(r)).toEqual([coord(1, 2)]);
    expect(r.armMeta!.coordCalls).toBe(0);
  });

  it('merges per-agent evidence; one unmeasured contributor makes the total unknown', () => {
    expect(mergeCapabilityEvidence([[coord(1, 2)], [coord(3, 4)]])).toEqual([coord(4, 6)]);
    expect(mergeCapabilityEvidence([[coord(1, 2)], [coord(null, 4, false)]])).toEqual([coord(null, 6, true)]);
  });

  it('never reads a partial sum as complete when a contributor reported nothing or omitted the capability', () => {
    expect(mergeCapabilityEvidence([[coord(1, 2)], [coord(3, 4)], undefined])).toEqual([coord(null, null, true)]);
    expect(mergeCapabilityEvidence([[coord(0, 0, false)], null])).toEqual([coord(null, null, null)]);
    const memory = (used: number): CapabilityExerciseEvidence => ({ capability: 'memory-recall', available: true, delivered: 1, used });
    expect(mergeCapabilityEvidence([[coord(1, 2), memory(1)], [coord(3, 4)]])).toEqual([
      coord(4, 6), { capability: 'memory-recall', available: true, delivered: null, used: null },
    ]);
    expect(mergeCapabilityEvidence([undefined, null])).toEqual([]);
  });
});
