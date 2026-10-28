import { describe, expect, it } from 'vitest';
import { selectQualificationWindow, type PersonQualificationEvidence } from './people';

const window = { windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' };
function evidence(dates: Array<string | null>): PersonQualificationEvidence {
  return { status: 'available', person: { id: 'PER-a', displayName: 'Ada', emails: [], phones: [], organizationId: null,
    title: null, sourceRecordCount: dates.length }, sources: dates.map((observedAt, index) => ({
    recordId: `REC-${index}`, evidenceRef: `work-item:REC-${index}`, dataSourceId: 'DS-a', provider: 'papercusp-signups',
    observedAt, title: null, selfReportedUseCase: 'Evaluate CRM',
  })) };
}

describe('P019 canonical qualification observation window', () => {
  it('retains citations at the start, excludes the end and historical records, without changing identity', () => {
    const input = evidence(['2026-09-30T23:59:59Z', window.windowStart, window.windowEnd]);
    const result = selectQualificationWindow(input, window);
    expect(result).toMatchObject({ status: 'available', person: { id: 'PER-a', sourceRecordCount: 3 },
      window: { windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-02T00:00:00.000Z' },
      sources: [{ recordId: 'REC-1', evidenceRef: 'work-item:REC-1', selfReportedUseCase: 'Evaluate CRM' }] });
    if (input.status === 'available') expect(input.sources).toHaveLength(3);
  });
  it.each([null, 'not-a-date'])('preserves unknown for an undated source (%s)', date => {
    expect(selectQualificationWindow(evidence([window.windowStart, date]), window))
      .toEqual({ status: 'unknown', reason: 'source_dates_unavailable' });
  });
  it('distinguishes an empty measured window from unavailable source records', () => {
    expect(selectQualificationWindow(evidence(['2026-09-01T00:00:00Z']), window)).toMatchObject({ status: 'available', sources: [] });
    expect(selectQualificationWindow({ status: 'unknown', reason: 'source_records_unavailable' }, window))
      .toEqual({ status: 'unknown', reason: 'source_records_unavailable' });
  });
  it.each([
    { windowStart: 'bad', windowEnd: window.windowEnd },
    { windowStart: window.windowEnd, windowEnd: window.windowStart },
    { windowStart: window.windowStart, windowEnd: window.windowStart },
  ])('rejects invalid measurement windows before interpreting evidence', invalid => {
    expect(selectQualificationWindow(evidence([window.windowStart]), invalid)).toEqual({ status: 'unknown', reason: 'invalid_window' });
  });
});
