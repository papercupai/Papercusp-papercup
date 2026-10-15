import { describe, expect, it } from 'vitest';
import {
  changedFingerprintKeys,
  isCanonicalClosureGateCall,
  judgePlanClosureObservation,
  PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS,
  refreshPlanClosureObservations,
  type PlanClosureFingerprint,
} from './plan-closure-observations';

const FP: PlanClosureFingerprint = {
  planVersion: '36',
  acceptanceBarEpoch: 1,
  itemsWatermark: '1790824986999030',
  auditSeq: '5',
  specBindings: '16057:2',
  rubrics: ['acceptance-p@10'],
  scorecardWatermark: null,
  metaScorecardWatermark: '1790825976942000',
};
const NOW = new Date('2026-10-01T06:00:00.000Z');

function row(overrides: Partial<Parameters<typeof judgePlanClosureObservation>[1][number]> = {}) {
  return {
    matches: 1,
    fingerprint: FP,
    fingerprint_matches: true,
    satisfied: false,
    code: 'acceptance_ungraded',
    skipped: null,
    message: 'needs an independent grade',
    observed_fingerprint: FP,
    observed_at: new Date(NOW.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

describe('judgePlanClosureObservation', () => {
  it('serves a matching, young observation as the gate verdict', () => {
    const read = judgePlanClosureObservation('p', [row()], NOW);
    expect(read).toEqual({
      planSlug: 'p',
      status: 'fresh',
      gate: { satisfied: false, code: 'acceptance_ungraded', message: 'needs an independent grade' },
      observedAt: '2026-10-01T05:59:00.000Z',
    });
  });

  it('carries skipped through, so an already-shipped verdict still closes', () => {
    const read = judgePlanClosureObservation('p', [row({ satisfied: true, code: null, skipped: 'already-shipped', message: null })], NOW);
    expect(read.status).toBe('fresh');
    expect(read.status === 'fresh' && read.gate).toEqual({ satisfied: true, code: null, skipped: 'already-shipped' });
  });

  it('carries the rubric and grader the independent-verification obligation names (D-039)', () => {
    const read = judgePlanClosureObservation('p', [row({
      satisfied: true, code: null, message: null, rubric_id: 'acceptance-p', graded_by: 'su-grader',
    })], NOW);
    expect(read.status === 'fresh' && read.gate).toEqual({
      satisfied: true, code: null, rubricId: 'acceptance-p', gradedBy: 'su-grader',
    });
  });

  it.each(['fresh', 'stale', 'absent'] as const)(
    'retains current lifecycle independently of a %s historical gate', (status) => {
      const read = judgePlanClosureObservation('p', [row({
        plan_status: 'superseded',
        ...(status === 'stale' ? { fingerprint_matches: false } : {}),
        ...(status === 'absent' ? { observed_at: null, satisfied: null } : {}),
      })], NOW);
      expect(read).toMatchObject({ status, planStatus: 'superseded' });
    },
  );

  it('does not assign a lifecycle to an ambiguous cross-harness slug', () => {
    const read = judgePlanClosureObservation('p', [
      row({ matches: 2, plan_status: 'superseded' }), row({ matches: 2, plan_status: 'active' }),
    ], NOW);
    expect(read.status).toBe('ambiguous');
    expect(read.planStatus).toBeUndefined();
  });

  it('reads stale on a fingerprint change and names what changed', () => {
    const current = { ...FP, planVersion: '37', scorecardWatermark: '1790830000000000' };
    const read = judgePlanClosureObservation('p', [row({ fingerprint: current, fingerprint_matches: false })], NOW);
    expect(read.status).toBe('stale');
    expect(read.status !== 'fresh' && read.detail).toContain('planVersion, scorecardWatermark');
  });

  it('reads stale past the age bound even when the fingerprint matches', () => {
    const observedAt = new Date(NOW.getTime() - PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS - 1000).toISOString();
    const read = judgePlanClosureObservation('p', [row({ observed_at: observedAt })], NOW);
    expect(read.status).toBe('stale');
    expect(read.status !== 'fresh' && read.detail).toMatch(/601s old \(max 600s\)/);
  });

  it('serves an observation exactly at the age bound', () => {
    const observedAt = new Date(NOW.getTime() - PLAN_CLOSURE_OBSERVATION_MAX_AGE_MS).toISOString();
    expect(judgePlanClosureObservation('p', [row({ observed_at: observedAt })], NOW).status).toBe('fresh');
  });

  it('reads absent when the plan has no recorded verdict', () => {
    const read = judgePlanClosureObservation('p', [row({ fingerprint_matches: null, satisfied: null, observed_at: null, observed_fingerprint: null })], NOW);
    expect(read).toEqual({ planSlug: 'p', status: 'absent', detail: "no acceptance-gate verdict has been recorded for 'p' yet" });
  });

  it('reads absent when the plan does not resolve at all', () => {
    expect(judgePlanClosureObservation('p', [], NOW).status).toBe('absent');
  });

  it('reads ambiguous when the slug resolves in more than one harness', () => {
    const read = judgePlanClosureObservation('p', [row({ matches: 2 }), row({ matches: 2 })], NOW);
    expect(read).toEqual({ planSlug: 'p', status: 'ambiguous', detail: "plan slug 'p' resolves in 2 harnesses" });
  });

  it('never serves a mismatched verdict, however young', () => {
    const read = judgePlanClosureObservation('p', [row({ fingerprint_matches: false, observed_at: NOW.toISOString() })], NOW);
    expect(read.status).toBe('stale');
  });
});

describe('changedFingerprintKeys', () => {
  it('compares values, including arrays and nulls', () => {
    expect(changedFingerprintKeys(FP, FP)).toEqual([]);
    expect(changedFingerprintKeys(FP, { ...FP, rubrics: ['acceptance-p@11'], auditSeq: null })).toEqual(['auditSeq', 'rubrics']);
    expect(changedFingerprintKeys(null, { planVersion: '1' })).toEqual(['planVersion']);
  });
});

describe('isCanonicalClosureGateCall', () => {
  it('records only calls that answer the closure question', () => {
    expect(isCanonicalClosureGateCall({})).toBe(true);
    expect(isCanonicalClosureGateCall({ harnessSlug: 'papercusp', probeCitationDeployment: true })).toBe(true);
    expect(isCanonicalClosureGateCall({ current: [] })).toBe(true);
    expect(isCanonicalClosureGateCall({ force: { reason: 'x' } })).toBe(false);
    expect(isCanonicalClosureGateCall({ gradingRecruitment: true })).toBe(false);
    expect(isCanonicalClosureGateCall({ current: [{} as never] })).toBe(false);
  });
});

describe('refreshPlanClosureObservations', () => {
  it('refreshes equal slugs independently with their exact harness while de-duplicating each qualified ref', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<[string, string | undefined]> = [];
    const evaluate = async (slug: string, harness?: string) => { calls.push([slug, harness]); await gate; };
    const a = { planSlug: 'qualified-flight', harnessSlug: 'harness-a' };
    const b = { planSlug: 'qualified-flight', harnessSlug: 'harness-b' };
    expect(refreshPlanClosureObservations([a, b, a], evaluate))
      .toEqual(['plan:harness-a/qualified-flight', 'plan:harness-b/qualified-flight']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([['qualified-flight', 'harness-a'], ['qualified-flight', 'harness-b']]);
    expect(refreshPlanClosureObservations([a, b], evaluate)).toEqual([]);
    release();
    await gate;
  });

  it('runs at most one evaluation per plan at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const evaluate = async (slug: string) => { calls.push(slug); await gate; };

    expect(refreshPlanClosureObservations(['single-flight-a', 'single-flight-a', 'single-flight-b'], evaluate))
      .toEqual(['single-flight-a', 'single-flight-b']);
    expect(refreshPlanClosureObservations(['single-flight-a'], evaluate)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['single-flight-a', 'single-flight-b']);

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshPlanClosureObservations(['single-flight-a'], evaluate)).toEqual(['single-flight-a']);
  });

  it('frees the slot after a failed evaluation', async () => {
    const evaluate = async () => { throw new Error('gate timeout'); };
    expect(refreshPlanClosureObservations(['single-flight-fail'], evaluate)).toEqual(['single-flight-fail']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refreshPlanClosureObservations(['single-flight-fail'], evaluate)).toEqual(['single-flight-fail']);
  });
});
