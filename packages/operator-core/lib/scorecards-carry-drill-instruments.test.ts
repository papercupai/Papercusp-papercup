import { describe, expect, it, vi } from 'vitest';
import { CARRY_DRILL_LIFECYCLE_INSTRUMENT_KEY as key } from './cold-boot-drill';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import type { CarryShipmentMeasurement } from './carry-drill-shipment';
import type { Rubric } from './rubrics';

const rubric = { workspaceId: 'workspace', subjectHarnessSlug: 'papercusp', subjectPlan: 'carry-plan',
  criteria: [{ key: 'r-7', check: { kind: 'instrument', instrumentKey: key } }] } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: 'carry-plan', windowStart: '2026-10-22T00:00:00Z', windowEnd: '2026-10-22T01:00:00Z' };
const now = () => Date.parse('2026-10-22T02:00:00Z');
const supplied = { [key]: { verdict: 'pass' as const, provenance: 'platform-computed' as const,
  measuredAt: new Date(now()).toISOString(), window: { ownerId: 'su-subject', drillId: 'selected', deploymentId: '42', reportId: 'report', deployedSha: 'forged' } } };
const measurement = (verdict: CarryShipmentMeasurement['verdict']): CarryShipmentMeasurement => ({ verdict,
  scope: 'managed-carry-objective-shipment', reason: 'native measurement' });

describe('carry-drill instrument at the maintained scorecard seam', () => {
  it('registers the existing lifecycle measurement', () => {
    expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', resolvedBy: 'scorecards:instrument-snapshots' });
  });
  it.each(['pass', 'fail', 'unknown'] as const)('replaces a forged supplied pass with measured %s', async verdict => {
    const carryDrill = vi.fn(async () => measurement(verdict));
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied }, { now, carryDrill });
    expect(carryDrill).toHaveBeenCalledWith({ ownerId: 'su-subject', drillId: 'selected', deploymentId: '42', reportId: 'report',
      workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: subject.ref, windowStart: subject.windowStart, windowEnd: subject.windowEnd });
    expect(result?.[key]).toMatchObject({ verdict, provenance: 'platform-computed', value: { scope: 'managed-carry-objective-shipment', unresolved: expect.any(Array) } });
    expect(result?.[key]?.window).not.toHaveProperty('deployedSha');
  });
  it.each(['missing-selection', 'foreign-plan', 'future', 'empty-window'] as const)('does not measure %s', async defect => {
    const carryDrill = vi.fn(async () => measurement('pass'));
    const changed = defect === 'foreign-plan' ? { ...subject, ref: 'foreign' }
      : defect === 'future' ? { ...subject, windowEnd: '2026-10-23T00:00:00Z' }
      : defect === 'empty-window' ? { ...subject, windowEnd: subject.windowStart } : subject;
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject: changed,
      supplied: defect === 'missing-selection' ? undefined : supplied }, { now, carryDrill });
    expect(result?.[key]?.verdict).toBe('unknown');
    expect(carryDrill).not.toHaveBeenCalled();
  });
  it('keeps unreadable native evidence unknown', async () => {
    const result = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied }, { now,
      carryDrill: async () => { throw new Error('unreadable'); } });
    expect(result?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
  });
});
