/**
 * R-9 (green-main-ratchet-convergence-2026-10-17 P-010, owner R7): the ratchet metrics and alarm.
 *
 * FAIL if any is observed: (1) the metric omits downgraded-failing tests; (2) it omits downgrades
 * per day; (3) no alarm when downgrade debt grows; (4) no alarm when introductions exceed fixes over
 * 24h; (5) the result is not recorded to the results ledger.
 */
import { describe, expect, it } from 'vitest';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import {
  checkpointRootPattern,
  computeRatchetMetrics,
  measureRatchetMetrics,
  RATCHET_METRICS_INSTRUMENT_KEY,
  RATCHET_METRICS_WINDOW_MS,
  recordRatchetMetrics,
  repoRelativeTestPath,
  type RatchetDowngradeRow,
  type RatchetTestRun,
} from './ratchet-metrics';

const H = 60 * 60_000;
const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const START = NOW - RATCHET_METRICS_WINDOW_MS;

const run = (file: string, hoursAgo: number, pass: boolean): RatchetTestRun => ({ file, atMs: NOW - hoursAgo * H, pass });
const dg = (testFile: string, createdHoursAgo: number, revokedHoursAgo: number | null = null, kind: RatchetDowngradeRow['kind'] = 'downgrade'): RatchetDowngradeRow => ({
  kind,
  testFile,
  createdAtMs: NOW - createdHoursAgo * H,
  revokedAtMs: revokedHoursAgo === null ? null : NOW - revokedHoursAgo * H,
});

describe('computeRatchetMetrics', () => {
  it('falsifier (1): counts active downgrades whose test is red now, at both window ends', () => {
    const m = computeRatchetMetrics({
      nowMs: NOW,
      runs: [run('a.test.ts', 30, false), run('a.test.ts', 2, false), run('b.test.ts', 30, true), run('b.test.ts', 2, false)],
      downgrades: [dg('a.test.ts', 40), dg('b.test.ts', 10)],
    });
    expect(m.downgradedFailing).toBe(2);
    expect(m.downgradedFailingAtStart).toBe(1);
    expect(m.alarms).toContain('downgraded-failing-grew');
  });

  it('falsifier (2): reports downgrades and quarantines created in the window, per day', () => {
    const m = computeRatchetMetrics({
      nowMs: NOW,
      runs: [run('a.test.ts', 1, true)],
      downgrades: [dg('a.test.ts', 30), dg('b.test.ts', 5), dg('c.test.ts', 4, null, 'flaky-quarantine'), dg('d.test.ts', 3, 1)],
    });
    expect(m.downgradesInWindow).toBe(2);
    expect(m.quarantinesInWindow).toBe(1);
    expect(m.downgradesPerDay).toBe(3);
    // A 12h window scales to a per-day rate.
    const half = computeRatchetMetrics({ nowMs: NOW, windowMs: 12 * H, runs: [run('a.test.ts', 1, true)], downgrades: [dg('b.test.ts', 5)] });
    expect(half.downgradesPerDay).toBe(2);
  });

  it('falsifier (3): alarms when the active downgrade count grows over the window', () => {
    const grew = computeRatchetMetrics({ nowMs: NOW, runs: [run('x.test.ts', 1, true)], downgrades: [dg('a.test.ts', 30), dg('b.test.ts', 5)] });
    expect(grew.activeDowngradesAtStart).toBe(1);
    expect(grew.activeDowngrades).toBe(2);
    expect(grew.alarms).toContain('downgrade-debt-grew');
    expect(grew.verdict).toBe('fail');
    // Replacing one downgrade with another keeps the debt flat: no alarm.
    const flat = computeRatchetMetrics({ nowMs: NOW, runs: [run('x.test.ts', 1, true)], downgrades: [dg('a.test.ts', 30, 6), dg('b.test.ts', 5)] });
    expect(flat.alarms).not.toContain('downgrade-debt-grew');
  });

  it('falsifier (4): alarms when introductions exceed fixes over 24h', () => {
    const m = computeRatchetMetrics({
      nowMs: NOW,
      runs: [
        run('fixed.test.ts', 30, false), run('fixed.test.ts', 3, true),
        run('new1.test.ts', 30, true), run('new1.test.ts', 3, false),
        run('new2.test.ts', 2, false), // absent before the window, red now: introduced
      ],
      downgrades: [],
    });
    expect(m.introduced).toEqual(['new1.test.ts', 'new2.test.ts']);
    expect(m.fixed).toEqual(['fixed.test.ts']);
    expect(m.alarms).toEqual(['introductions-exceed-fixes']);
    expect(m.verdict).toBe('fail');
  });

  it('passes when fixes keep pace and debt is flat; a flap inside the window counts once', () => {
    const m = computeRatchetMetrics({
      nowMs: NOW,
      runs: [
        run('a.test.ts', 30, false), run('a.test.ts', 4, true),
        run('b.test.ts', 30, true), run('b.test.ts', 10, false), run('b.test.ts', 3, true), run('b.test.ts', 2, false),
      ],
      downgrades: [],
    });
    expect(m.introduced).toEqual(['b.test.ts']);
    expect(m.fixed).toEqual(['a.test.ts']);
    expect(m.alarms).toEqual([]);
    expect(m.verdict).toBe('pass');
  });

  it('runs after the window end are ignored, and an empty population is unknown, not a pass', () => {
    const later = computeRatchetMetrics({ nowMs: NOW, runs: [run('a.test.ts', -1, false)], downgrades: [] });
    expect(later.verdict).toBe('unknown');
    expect(later.measuredFiles).toBe(0);
  });
});

describe('checkpoint-tree scoping', () => {
  it('matches the install checkpoint tree and its sub-roots, not other installs', () => {
    const re = new RegExp(checkpointRootPattern('papercusp'));
    expect(re.test('/home/u/ws/papercusp-checkpoint')).toBe(true);
    expect(re.test('/home/u/ws/papercusp-checkpoint/libs/papercusp')).toBe(true);
    expect(re.test('/home/u/ws/papercusp')).toBe(false);
    expect(re.test('/home/u/ws/papercusp-slack-asana-bug-drill-checkpoint')).toBe(false);
    expect(new RegExp(checkpointRootPattern('slack-asana-bug-drill')).test('/home/u/ws/papercusp-slack-asana-bug-drill-checkpoint')).toBe(true);
  });

  it('rebuilds repo-relative paths from a submodule sub-root', () => {
    expect(repoRelativeTestPath('/w/papercusp-checkpoint', 'apps/x.test.ts', 'papercusp')).toBe('apps/x.test.ts');
    expect(repoRelativeTestPath('/w/papercusp-checkpoint/libs/papercusp', 'libs/db/a.test.ts', 'papercusp')).toBe('libs/papercusp/libs/db/a.test.ts');
  });
});

describe('measureRatchetMetrics (fake SQL)', () => {
  it('reads gate rows and downgrade rows for the install and computes over the window', async () => {
    const queries: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      queries.push(text);
      if (text.includes('test_runs')) {
        return [
          { root: '/w/papercusp-checkpoint', file_path: 'a.test.ts', status: 'pass', finished_at: new Date(START - H) },
          { root: '/w/papercusp-checkpoint', file_path: 'a.test.ts', status: 'error', finished_at: new Date(NOW - H) },
        ];
      }
      return [{ kind: 'downgrade', test_file: 'a.test.ts', created_at: new Date(NOW - 2 * H), revoked_at: null }];
    }) as unknown as Parameters<typeof measureRatchetMetrics>[0];
    const m = await measureRatchetMetrics(sql, {
      workspaceId: 'ws', harnessSlug: 'papercusp',
      windowStart: new Date(START).toISOString(), windowEnd: new Date(NOW).toISOString(),
    });
    expect(queries[0]).toContain("source = 'ci'");
    expect(queries[0]).toContain('worktree_dirty = false');
    expect(m.introduced).toEqual(['a.test.ts']);
    expect(m.downgradedFailing).toBe(1);
    expect(m.alarms).toEqual(['introductions-exceed-fixes', 'downgrade-debt-grew', 'downgraded-failing-grew']);
  });
});

describe('falsifier (5): the result is recorded to the results ledger', () => {
  it('is a registered scheduled platform instrument (rubric-rescore writes its verdict to the ledger)', () => {
    const instrument = getRegisteredInstrument(RATCHET_METRICS_INSTRUMENT_KEY);
    expect(instrument?.evaluator).toBe('platform');
    if (instrument?.evaluator !== 'platform') throw new Error('expected platform instrument');
    expect(instrument.rescore?.windowMs).toBe(RATCHET_METRICS_WINDOW_MS);
    expect(instrument.rescore?.scope).toBe('harness');
  });

  it('recordRatchetMetrics writes one ledger row: fail with an alarm, pass without', async () => {
    const written: Array<{ status: string; value: unknown }> = [];
    const record = async (results: ReadonlyArray<{ verdict: string; check: { value?: unknown } }>) => {
      for (const r of results) written.push({ status: r.verdict, value: r.check.value });
      return results.map((_, i) => i + 1);
    };
    const alarm = computeRatchetMetrics({ nowMs: NOW, runs: [run('n.test.ts', 1, false)], downgrades: [] });
    const quiet = computeRatchetMetrics({ nowMs: NOW, runs: [run('n.test.ts', 1, true)], downgrades: [] });
    const scope = { workspaceId: 'ws', harnessSlug: 'papercusp' };
    const ids1 = await recordRatchetMetrics({ rubricRef: 'acceptance-x', criterionKey: 'r-9', metrics: alarm, scope, record: record as never });
    const ids2 = await recordRatchetMetrics({ rubricRef: 'acceptance-x', criterionKey: 'r-9', metrics: quiet, scope, record: record as never });
    expect(ids1).toEqual([1]);
    expect(ids2).toEqual([1]);
    expect(written).toEqual([{ status: 'fail', value: 1 }, { status: 'pass', value: 0 }]);
  });

  it('builds a ledger row the strict reader accepts', async () => {
    const { buildRubricCheckLedgerRow } = await import('../check-results-ledger');
    let row: unknown = null;
    const metrics = computeRatchetMetrics({ nowMs: NOW, runs: [run('n.test.ts', 1, false)], downgrades: [] });
    await recordRatchetMetrics({
      rubricRef: 'acceptance-x', criterionKey: 'r-9', metrics, scope: { workspaceId: 'ws', harnessSlug: 'papercusp', root: '/w' },
      record: async (results, scope) => { row = buildRubricCheckLedgerRow(results[0]!, scope); return [7]; },
    });
    expect(row).toMatchObject({ filePath: 'rubric-check/acceptance-x/r-9:instrument', status: 'fail' });
  });
});
