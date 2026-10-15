import { describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots } from './scorecards';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { PG_TABLE_GROWTH_INSTRUMENT_KEY } from './storage/pg-table-growth';
import type { Rubric } from './rubrics';

const key = PG_TABLE_GROWTH_INSTRUMENT_KEY;
const rubric = { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subjectPlan: 'growth-plan',
  criteria: [{ key: 'r-5', check: { kind: 'instrument', instrumentKey: key } }] } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: 'growth-plan', windowStart: '2026-10-14T00:00:00Z', windowEnd: '2026-10-15T00:00:00Z' };
const measurement = (verdict: 'pass' | 'unknown') => ({ verdict, measurementVerdict: verdict,
  reason: 'native catalog', sampleIds: ['a', 'b'], tables: [], topLargest: [], topGrowers: [], unresolved: [], dropped: [] });

describe('native PostgreSQL table-growth instrument', () => {
  it('is registered on the existing platform instrument seam', () => {
    expect(getRegisteredInstrument(key)).toMatchObject({ evaluator: 'platform', resolvedBy: 'scorecards:instrument-snapshots' });
  });

  it.each(['pass', 'unknown'] as const)('uses native %s measurement instead of supplied provenance', async verdict => {
    const pgTableGrowth = vi.fn(async () => measurement(verdict));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject,
      supplied: { [key]: { verdict: 'pass', measuredAt: subject.windowEnd, provenance: 'platform-computed' } } }, { now: () => Date.parse('2026-10-16T00:00:00Z'), pgTableGrowth });
    expect(pgTableGrowth).toHaveBeenCalledWith({ workspaceId: 'ws', windowStart: subject.windowStart, windowEnd: subject.windowEnd });
    expect(snapshots?.[key]).toMatchObject({ verdict, provenance: 'platform-computed', value: { resolver: key, reason: 'native catalog' } });
  });

  it('returns unknown without invoking the native resolver for an unfinished or foreign subject', async () => {
    const pgTableGrowth = vi.fn(async () => measurement('pass'));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject: { ...subject, ref: 'other' } }, { now: () => Date.parse('2026-10-16T00:00:00Z'), pgTableGrowth });
    expect(snapshots?.[key]?.verdict).toBe('unknown');
    expect(pgTableGrowth).not.toHaveBeenCalled();
  });
});
