import { describe, expect, it, vi } from 'vitest';
import { resolveScorecardInstrumentSnapshots, evaluateScorecardInstrumentContract } from './scorecards';
import { getRegisteredInstrument } from './rubric-instrument-registry';
import { WORK_OVERHEAD_INSTRUMENT_KEYS, WORK_OVERHEAD_VERSION, summarizeWorkOverhead, type WorkOverheadEvent } from './agent-work-overhead-metrics';
import * as workOverheadModule from './agent-work-overhead-metrics';
import type { Rubric } from './rubrics';

const keys = WORK_OVERHEAD_INSTRUMENT_KEYS;
const rubric = { workspaceId: 'ws', subjectHarnessSlug: 'papercusp', subjectPlan: 'paperwork',
  criteria: Object.entries(keys).map(([key, instrumentKey]) => ({ key, check: { kind: 'instrument', instrumentKey } })) } as unknown as Rubric;
const subject = { kind: 'plan' as const, ref: 'paperwork',
  windowStart: '2026-10-15T10:00:00Z', windowEnd: '2026-10-15T12:00:00Z' };
const now = () => Date.parse('2026-10-15T13:00:00Z');
const window = { workspaceId: 'ws', harnessSlug: 'papercusp', windowStart: subject.windowStart, windowEnd: subject.windowEnd };
const rows = Array.from({ length: 31 }, (_, i): WorkOverheadEvent => ({
  source_kind: 'codex', session_id: 'native-context', owner: 'owner', part_idx: i,
  ts: new Date(Date.parse(subject.windowStart) + i * 120_000).toISOString(),
  tool_name: 'capability:read', payload: '{}', payload_truncated: false,
  first_at: subject.windowStart, last_at: '2026-10-15T11:00:00Z', missing_timestamps: 0, closed: false,
}));

describe('ledger-owned work overhead instruments', () => {
  it('uses the same frozen measurement and verdict for scheduled ledger checks', async () => {
    const measure = vi.spyOn(workOverheadModule, 'measureWorkOverheadWindow')
      .mockResolvedValue(summarizeWorkOverhead(window, rows));
    try {
      for (const key of Object.values(keys)) {
        const instrument = getRegisteredInstrument(key);
        if (instrument?.evaluator !== 'platform' || !instrument.rescore) throw new Error('missing scheduled resolver');
        expect(instrument.rescore.scope).toBe('harness');
        expect(await instrument.rescore.resolve(window)).toMatchObject({ verdict: 'pass' });
        const result = await instrument.rescore.resolve(window);
        expect(JSON.parse(result.detail)).toMatchObject({ metrics: { window, population: { sessions: 1 } } });
        expect(await instrument.rescore.resolve({ ...window, harnessSlug: undefined })).toMatchObject({ verdict: 'unknown' });
      }
      expect(measure).toHaveBeenCalledTimes(4);
      expect(measure).toHaveBeenCalledWith(window);
    } finally { measure.mockRestore(); }
  });

  it('registers both keys and measures their common cohort once', async () => {
    Object.values(keys).forEach(key => expect(getRegisteredInstrument(key)?.evaluator).toBe('platform'));
    const workOverhead = vi.fn(async () => summarizeWorkOverhead(window, rows));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, workOverhead });
    expect(workOverhead).toHaveBeenCalledExactlyOnceWith(window);
    for (const key of Object.values(keys)) expect(snapshots?.[key]).toMatchObject({ verdict: 'pass', provenance: 'platform-computed',
      value: { resolverVersion: WORK_OVERHEAD_VERSION, metrics: { population: { sessions: 1 }, medianObservedSessionMinutes: 60 } } });
  });
  it('replaces supplied passes with an actual unknown and rejects claimed passing ratings', async () => {
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key,
      { verdict: 'pass' as const, measuredAt: new Date(now()).toISOString(), provenance: 'platform-computed' as const }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject, supplied },
      { now, workOverhead: async () => summarizeWorkOverhead(window, []) });
    for (const key of Object.values(keys)) expect(snapshots?.[key]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
    expect(evaluateScorecardInstrumentContract({ rubric,
      ratings: Object.fromEntries(Object.keys(keys).map(key => [key, { rating: 'pass', evidence: 'claimed' }])),
      instrumentSnapshots: snapshots }).valid).toBe(false);
  });
  it.each([
    { ...subject, ref: 'foreign-plan' }, { ...subject, windowEnd: subject.windowStart },
    { ...subject, windowEnd: '2026-10-15T14:00:00Z' },
  ])('does not query a foreign, empty or unfinished window', async badSubject => {
    const workOverhead = vi.fn(async () => summarizeWorkOverhead(window, rows));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject: badSubject }, { now, workOverhead });
    expect(workOverhead).not.toHaveBeenCalled();
    Object.values(keys).forEach(key => expect(snapshots?.[key]?.verdict).toBe('unknown'));
  });
  it('preserves read failures as unknown for both criteria', async () => {
    const workOverhead = vi.fn(async () => { throw new Error('database unavailable'); });
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric, subject }, { now, workOverhead });
    expect(workOverhead).toHaveBeenCalledOnce();
    Object.values(keys).forEach(key => expect(snapshots?.[key]?.verdict).toBe('unknown'));
  });
});
