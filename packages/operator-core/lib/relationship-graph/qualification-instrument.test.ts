import { describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: 'authorized-db' }) }));
vi.mock('./people', () => ({ readPersonQualificationEvidence: vi.fn() }));
import { leadSourceObservationsRescore } from './qualification-instrument';
import type { readPersonQualificationEvidence, PersonQualificationEvidence } from './people';
import { retainMeasurementProvenance, measurementProvenanceStatus } from '../measurement-provenance';

const input = { workspaceId: 'workspace-a', subject: { kind: 'person', ref: 'PER-a' },
  windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' };
const available: PersonQualificationEvidence = { status: 'available',
  person: { id: 'PER-survivor', displayName: 'Ada', emails: [], phones: [], organizationId: null,
    title: null, sourceRecordCount: 1 },
  window: { windowStart: input.windowStart, windowEnd: input.windowEnd },
  sources: [{ recordId: 'REC-a', evidenceRef: 'work-item:REC-a', dataSourceId: 'DS-a',
    provider: 'papercusp-signups', observedAt: input.windowStart, title: null, selfReportedUseCase: null }] };

describe('P019 subject source observation instrument', () => {
  it('reads the exact workspace, canonical subject and window, retaining citations and merge survivor', async () => {
    const read = vi.fn<typeof readPersonQualificationEvidence>().mockResolvedValue(available);
    const instrument = leadSourceObservationsRescore(read);
    expect(instrument.scope).toBe('subject');
    const result = await instrument.resolve(input);
    expect(read).toHaveBeenCalledWith('authorized-db', 'workspace-a', 'PER-a',
      { windowStart: input.windowStart, windowEnd: input.windowEnd });
    expect(result).toMatchObject({ verdict: 'pass', value: 1 });
    expect(result).toMatchObject({ detail: 'Source observation count for PER-survivor', evidenceRefs: ['work-item:REC-a'] });
  });
  it('retains multiple citations beyond the detail-string limit as complete measurement diagnostics', async () => {
    const sources = Array.from({ length: 20 }, (_, i) => ({ ...available.sources[0]!,
      recordId: `REC-${i}`, evidenceRef: `work-item:REC-${i}-${'a'.repeat(64)}` }));
    const read = vi.fn<typeof readPersonQualificationEvidence>().mockResolvedValue({ ...available, sources });
    const result = await leadSourceObservationsRescore(read).resolve(input);
    const retained = retainMeasurementProvenance({ procedure: { window: input }, result,
      startedAt: input.windowStart, finishedAt: input.windowEnd });
    expect(measurementProvenanceStatus(retained)).toBe('retained');
    for (const source of sources) expect(retained.diagnostics).toContainEqual(expect.objectContaining({ value: source.evidenceRef }));
  });
  it.each([undefined, { kind: 'email', ref: 'PER-a' }, { kind: 'person', ref: 'ada@example.com' }])(
    'does not read for an unauthoritative subject %j', async subject => {
      const read = vi.fn<typeof readPersonQualificationEvidence>();
      expect(await leadSourceObservationsRescore(read).resolve({ ...input, subject })).toMatchObject({ verdict: 'unknown' });
      expect(read).not.toHaveBeenCalled();
    });
  it('keeps unavailable dates unknown without a numeric zero', async () => {
    const read = vi.fn<typeof readPersonQualificationEvidence>().mockResolvedValue({ status: 'unknown', reason: 'source_dates_unavailable' });
    expect(await leadSourceObservationsRescore(read).resolve(input))
      .toEqual({ verdict: 'unknown', detail: 'source_dates_unavailable' });
  });
  it('records a measured empty window as zero', async () => {
    const read = vi.fn<typeof readPersonQualificationEvidence>().mockResolvedValue({ ...available, sources: [] });
    expect(await leadSourceObservationsRescore(read).resolve(input)).toMatchObject({ verdict: 'fail', value: 0 });
  });
});
