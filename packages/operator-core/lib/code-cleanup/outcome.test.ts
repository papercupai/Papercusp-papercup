import { describe, expect, it } from 'vitest';
import {
  CLEANUP_BATCH_RECORD_KEY, CLEANUP_LANDED_STATUSES, CLEANUP_OUTCOME_INSTRUMENT_KEYS, CLEANUP_OUTCOME_WINDOW_MS,
  cleanupOutcomeRescore, metricForCleanupInstrument, parseCleanupBatchRecord, rateCleanupOutcome, readLandedCleanupBatches,
  type LandedBatchRow,
} from './outcome';
import { DEFAULT_REGRESSION_THRESHOLD, DEFAULT_REGRESSION_WINDOW_MS } from './throttle';
import { getRegisteredInstrument, platformComputedInstrumentKeys } from '../rubric-instrument-registry';

const row = (workItemId: string, record: unknown, closedTs = 1_700_000_000_000): LandedBatchRow => ({ workItemId, closedTs, record });
const rec = (batchId: string, linesRemoved: number, attributedRedIds: string[] = [], campaign = 'cleanup-a') =>
  ({ campaign, batchId, linesRemoved, attributedRedIds });

describe('cleanup outcome instruments (P-008)', () => {
  it('maps each instrument key to its metric and nothing else', () => {
    expect(metricForCleanupInstrument(CLEANUP_OUTCOME_INSTRUMENT_KEYS.batchesLanded)).toBe('batchesLanded');
    expect(metricForCleanupInstrument(CLEANUP_OUTCOME_INSTRUMENT_KEYS.linesRemoved)).toBe('linesRemoved');
    expect(metricForCleanupInstrument(CLEANUP_OUTCOME_INSTRUMENT_KEYS.regressionRate)).toBe('regressionRate');
    expect(metricForCleanupInstrument('code-cleanup:other')).toBeNull();
  });

  it('registers all three keys as platform instruments with a harness-scoped rescore', () => {
    for (const key of Object.values(CLEANUP_OUTCOME_INSTRUMENT_KEYS)) {
      expect(platformComputedInstrumentKeys()).toContain(key);
      const instrument = getRegisteredInstrument(key);
      expect(instrument?.evaluator).toBe('platform');
      const rescore = instrument && instrument.evaluator === 'platform' ? instrument.rescore : undefined;
      expect(rescore?.scope).toBe('harness');
      expect(rescore?.windowMs).toBe(CLEANUP_OUTCOME_WINDOW_MS);
    }
  });

  it('uses the throttle window so the rubric and the throttle judge the same 7 days', () => {
    expect(CLEANUP_OUTCOME_WINDOW_MS).toBe(DEFAULT_REGRESSION_WINDOW_MS);
  });
});

describe('parseCleanupBatchRecord', () => {
  it('accepts a complete record', () => {
    expect(parseCleanupBatchRecord(rec('core#1', 40, ['r1']))).toEqual({ ok: true, record: rec('core#1', 40, ['r1']) });
  });
  it.each([
    [null, 'record is not an object'],
    [[], 'record is not an object'],
    [{ batchId: 'b', linesRemoved: 1, attributedRedIds: [] }, 'campaign is missing'],
    [{ campaign: 'c', linesRemoved: 1, attributedRedIds: [] }, 'batchId is missing'],
    [{ campaign: 'c', batchId: 'b', linesRemoved: 1.5, attributedRedIds: [] }, 'linesRemoved is not an integer'],
    [{ campaign: 'c', batchId: 'b', linesRemoved: 1, attributedRedIds: [3] }, 'attributedRedIds is not a string array'],
  ])('rejects %j', (raw, reason) => {
    expect(parseCleanupBatchRecord(raw)).toEqual({ ok: false, reason });
  });
});

describe('rateCleanupOutcome', () => {
  it('is unknown on every metric when no batch landed', () => {
    for (const metric of ['batchesLanded', 'linesRemoved', 'regressionRate'] as const) {
      const r = rateCleanupOutcome([], metric);
      expect(r.verdict).toBe('unknown');
      expect(r.value).toBeUndefined();
    }
  });

  it('fails every metric when a landed record breaks the contract, naming the work-item', () => {
    const rows = [row('WI-1', rec('core#1', 10)), row('WI-2', { campaign: 'cleanup-a', batchId: 'core#2' })];
    for (const metric of ['batchesLanded', 'linesRemoved', 'regressionRate'] as const) {
      const r = rateCleanupOutcome(rows, metric);
      expect(r.verdict).toBe('fail');
      expect(r.detail).toContain('WI-2');
      expect(r.detail).toContain(CLEANUP_BATCH_RECORD_KEY);
    }
  });

  it('counts landed batches', () => {
    const r = rateCleanupOutcome([row('WI-1', rec('core#1', 10)), row('WI-2', rec('core#2', 5, [], 'cleanup-b'))], 'batchesLanded');
    expect(r).toMatchObject({ verdict: 'pass', value: 2 });
    expect(r.detail).toContain('2 campaign(s): cleanup-a, cleanup-b');
  });

  it('sums net lines removed and fails when the batches removed nothing net', () => {
    expect(rateCleanupOutcome([row('WI-1', rec('core#1', 30)), row('WI-2', rec('core#2', -10))], 'linesRemoved'))
      .toMatchObject({ verdict: 'pass', value: 20 });
    expect(rateCleanupOutcome([row('WI-1', rec('core#1', 5)), row('WI-2', rec('core#2', -5))], 'linesRemoved'))
      .toMatchObject({ verdict: 'fail', value: 0 });
  });

  it('passes the regression rate at the throttle threshold and fails above it', () => {
    const atThreshold = [row('WI-1', rec('core#1', 9, ['r1'])), row('WI-2', rec('core#2', 9, ['r2']))];
    expect(DEFAULT_REGRESSION_THRESHOLD).toBe(2);
    expect(rateCleanupOutcome(atThreshold, 'regressionRate')).toMatchObject({ verdict: 'pass', value: 1 });
    const above = [...atThreshold, row('WI-3', rec('core#3', 9, ['r3']))];
    expect(rateCleanupOutcome(above, 'regressionRate')).toMatchObject({ verdict: 'fail', value: 1 });
  });

  it('counts a red attributed to several batches once', () => {
    const rows = [row('WI-1', rec('core#1', 9, ['r1', 'r2'])), row('WI-2', rec('core#2', 9, ['r1', 'r2'])), row('WI-3', rec('core#3', 9, ['r2']))];
    const r = rateCleanupOutcome(rows, 'regressionRate');
    expect(r.verdict).toBe('pass');
    expect(r.value).toBeCloseTo(2 / 3);
    expect(r.detail).toContain('2 attributed red(s)');
  });

  it('honours an explicit threshold', () => {
    const rows = [row('WI-1', rec('core#1', 9, ['r1']))];
    expect(rateCleanupOutcome(rows, 'regressionRate', { threshold: 0 }).verdict).toBe('fail');
  });
});

describe('readLandedCleanupBatches', () => {
  it('scopes to workspace, harness, landed statuses and the window, in epoch ms', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const sql = { unsafe: async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return [{ feature_id: 'WI-9', closed_ts: '1793000000000', record: rec('core#1', 3) }];
    } };
    const rows = await readLandedCleanupBatches(sql, {
      workspaceId: 'ws', harnessSlug: 'papercusp', windowStart: '2026-10-20T00:00:00.000Z', windowEnd: '2026-10-27T00:00:00.000Z',
    });
    expect(rows).toEqual([{ workItemId: 'WI-9', closedTs: 1793000000000, record: rec('core#1', 3) }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain(`payload ? '${CLEANUP_BATCH_RECORD_KEY}'`);
    expect(calls[0].query).toContain('workspace_id = $1 AND harness_slug = $2');
    expect(calls[0].params).toEqual(['ws', 'papercusp', [...CLEANUP_LANDED_STATUSES],
      Date.parse('2026-10-20T00:00:00.000Z'), Date.parse('2026-10-27T00:00:00.000Z')]);
  });
});

describe('cleanupOutcomeRescore', () => {
  it('is unknown without an exact harness or a valid window, before touching the database', async () => {
    const rescore = cleanupOutcomeRescore('batchesLanded');
    await expect(rescore.resolve({ workspaceId: 'ws', windowStart: '2026-10-20T00:00:00Z', windowEnd: '2026-10-27T00:00:00Z' }))
      .resolves.toMatchObject({ verdict: 'unknown' });
    await expect(rescore.resolve({ workspaceId: 'ws', harnessSlug: 'papercusp', windowStart: 'nope', windowEnd: '2026-10-27T00:00:00Z' }))
      .resolves.toMatchObject({ verdict: 'unknown' });
  });
});
