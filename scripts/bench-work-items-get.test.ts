import { describe, expect, it } from 'vitest';
import { judgeSamples, runSummaryCohort, validateSummary, type Sample } from './bench-work-items-get';

function response(ids: string[]) {
  return { ok: true, results: ids.map(id => ({ id, ok: true, availability: 'available',
    workItem: { id, state: 'open' } })), counts: { ok: ids.length, failed: 0 },
    read: { schemaVersion: 'work-items-get-read-v1', mode: 'projected', requested: ids.length,
      available: ids.length, absent: 0, unavailable: 0, elapsedMs: 10,
      outerStageAttribution: 'dispatch/projection/serialization time' } };
}

describe('live work-item summary cohort oracle', () => {
  it('refuses duplicate identities, missing state, unavailable rows and lost top-level disclosure', () => {
    expect(validateSummary(response(['WI-A', 'WI-B']), ['WI-A', 'WI-B'])).toEqual([]);
    const duplicate = response(['WI-A', 'WI-A']);
    expect(validateSummary(duplicate, ['WI-A', 'WI-B'])).not.toEqual([]);
    const missingState = response(['WI-A']);
    missingState.results[0]!.workItem.state = '';
    expect(validateSummary(missingState, ['WI-A'])).not.toEqual([]);
    const unavailable = response(['WI-A']);
    unavailable.results[0]!.availability = 'unavailable';
    expect(validateSummary(unavailable, ['WI-A'])).not.toEqual([]);
    expect(validateSummary({ ...response(['WI-A']), read: undefined }, ['WI-A'])).not.toEqual([]);
  });

  it('refuses an incomplete or duplicated matrix and non-finite latency', () => {
    const sample: Sample = { size: 1, repeat: 1, wallMs: 10, valid: true, failures: [], read: {} };
    expect(judgeSamples([sample], 1, 1).passed).toBe(true);
    expect(judgeSamples([sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([sample, sample], 1, 2).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: NaN }], 1, 1).passed).toBe(false);
    expect(judgeSamples([{ ...sample, wallMs: 2_001 }], 1, 1).passed).toBe(false);
  });

  it('retains failed calls instead of dropping them from the p95 denominator', async () => {
    let ticks = 0;
    let calls = 0;
    const out = await runSummaryCohort({ ids: ['WI-A', 'WI-B'], repeats: 2,
      now: () => ticks++ * 10, call: async ids => {
        if (++calls === 2) throw new Error('opaque private transport detail');
        return response(ids);
      } });
    expect(out.samples).toHaveLength(4);
    expect(out.samples.map(sample => [sample.size, sample.repeat])).toEqual([[1, 1], [2, 1], [1, 2], [2, 2]]);
    expect(out.samples[1]!.valid).toBe(false);
    expect(JSON.stringify(out)).not.toContain('opaque private transport detail');
    expect(out.verdict.complete).toBe(true);
    expect(out.verdict.passed).toBe(false);
  });

  it('validates matrix inputs before making an MCP call', async () => {
    let calls = 0;
    const call = async () => { calls += 1; return {}; };
    await expect(runSummaryCohort({ ids: ['WI-A', 'WI-A'], repeats: 1, call })).rejects.toThrow('distinct');
    await expect(runSummaryCohort({ ids: ['WI-A'], repeats: 0, call })).rejects.toThrow('repeats');
    expect(calls).toBe(0);
  });
});
