import { describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { DISK_HEADROOM_SOAK_INSTRUMENT_KEY } from './storage/retention-interval-evidence';
import type { Rubric } from './rubrics';

const key = DISK_HEADROOM_SOAK_INSTRUMENT_KEY;
const rubric = { workspaceId: 'workspace', subjectHarnessSlug: 'install', subjectPlan: 'disk-plan',
  criteria: [{ key: 'r-7', check: { kind: 'instrument', instrumentKey: key } }] } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: 'disk-plan', windowStart: '2026-10-10T00:00:00Z',
  windowEnd: '2026-10-13T00:00:00Z' };
const now = () => Date.parse('2026-10-13T01:00:00Z');
const supplied = { [key]: { verdict: 'pass' as const, measuredAt: new Date(now()).toISOString(),
  provenance: 'platform-computed' as const, window: { deploymentId: '42', host: 'host',
    artifactRef: 'fabricated', shippedAt: '1900-01-01T00:00:00Z', maxSampleGapMs: Infinity },
  value: { soakStatus: 'pass' } } };

const measurement = (verdict: 'pass' | 'fail' | 'unknown') => ({
  verdict, reason: 'native measurement',
  shipment: { id: '42', host: 'host:3070#1', artifactRef: 'a'.repeat(40), shippedAt: subject.windowStart },
  requirements: { host: 'host', artifactRef: 'a'.repeat(40), shippedAt: subject.windowStart,
    startAt: subject.windowStart, measuredAt: new Date(now()).toISOString(),
    maxSampleGapMs: 7 * 3_600_000, maxAlarmGapMs: 6 * 3_600_000 },
  assessment: { schemaVersion: 1 as const, kind: 'disk-headroom-soak-assessment' as const,
    soakStatus: verdict, checks: [], scope: 'controlled resolver stub',
    coverage: { population: [], checked: [], notChecked: [], notApplicable: [], residue: [] } },
});

describe('ledger-backed disk headroom scorecard instrument', () => {
  it('is registered on the existing platform snapshot seam', () => {
    expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', resolvedBy: 'scorecards:instrument-snapshots' });
  });

  it.each(['pass', 'fail', 'unknown'] as const)('uses native %s instead of supplied pass/provenance/window claims', async verdict => {
    const diskHeadroomSoak = vi.fn(async () => measurement(verdict));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied }, { now, diskHeadroomSoak });
    expect(diskHeadroomSoak).toHaveBeenCalledWith({ workspaceId: 'workspace', installSlug: 'install',
      host: 'host', deploymentId: '42', windowStart: subject.windowStart, windowEnd: subject.windowEnd,
      measuredAt: new Date(now()).toISOString() });
    expect(snapshots?.[key]).toMatchObject({ verdict, provenance: 'platform-computed',
      window: { host: 'host', deploymentId: '42' }, value: { resolver: key, verdict, reason: 'native measurement' } });
    expect(snapshots?.[key]?.window).not.toHaveProperty('artifactRef');
    expect(snapshots?.[key]?.window).not.toHaveProperty('maxSampleGapMs');
  });

  it.each([{ ...subject, ref: 'foreign' }, { ...subject, kind: 'work-item' as const },
    { ...subject, windowEnd: '2026-10-12T00:00:00Z' }, { ...subject, windowEnd: '2026-10-14T00:00:00Z' }])(
    'rejects a foreign subject or an incorrect/unfinished window', async badSubject => {
      const diskHeadroomSoak = vi.fn(async () => measurement('pass'));
      const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject: badSubject, supplied }, { now, diskHeadroomSoak });
      expect(snapshots?.[key]?.verdict).toBe('unknown');
      expect(diskHeadroomSoak).not.toHaveBeenCalled();
    });

  it('rejects a missing native receipt selection and keeps ledger failure unknown', async () => {
    const diskHeadroomSoak = vi.fn(async () => { throw new Error('ledger unavailable'); });
    const missing = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, diskHeadroomSoak });
    expect(missing?.[key]?.verdict).toBe('unknown');
    expect(diskHeadroomSoak).not.toHaveBeenCalled();
    const failed = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied }, { now, diskHeadroomSoak });
    expect(failed?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed',
      value: { reason: 'Soak ledger unavailable: ledger unavailable' } });
  });
});
