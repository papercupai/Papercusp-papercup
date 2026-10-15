import { describe, expect, it } from 'vitest';
import {
  evaluateWriteDelta,
  FLEET_WRITER_PROBES,
  LIVE_DATA_MAP,
  parseProbeResult,
  parsePgStatUserTables,
  runWriteDelta,
  writeDelta,
  type DataMapLookup,
  type WriteSnapshot,
} from './customer-data-map-write-delta';

const c = (ins: number, upd = 0, del = 0) => ({ ins, upd, del });

const FAKE_MAP: DataMapLookup = {
  names: (q) => ['papercusp_auth.hosted_users', 'papercusp_auth.organizations', 'harness_shared.workspace_hosts'].includes(q),
  isCustomerTable: (q) => q.startsWith('papercusp_auth.'),
  customerSchemas: ['papercusp_auth'],
};

describe('customer data map write delta (SPEC-P-001 instrument)', () => {
  it('parses pg_stat_user_tables tab-separated rows and rejects malformed ones', () => {
    const snap = parsePgStatUserTables('papercusp_auth\thosted_users\t3\t1\t0\nharness_shared\ttest_runs\t10\t0\t2\n');
    expect(snap).toEqual({
      'papercusp_auth.hosted_users': c(3, 1, 0),
      'harness_shared.test_runs': c(10, 0, 2),
    });
    expect(() => parsePgStatUserTables('papercusp_auth\thosted_users\t3\t1\n')).toThrow(/columns/);
    expect(() => parsePgStatUserTables('a\tb\tx\t1\t0\n')).toThrow(/non-numeric/);
  });

  it('keeps only tables whose counters moved, counting a new table from zero', () => {
    const before: WriteSnapshot = { 'a.x': c(1), 'a.y': c(5, 2, 1) };
    const after: WriteSnapshot = { 'a.x': c(1), 'a.y': c(6, 2, 3), 'a.z': c(0, 4) };
    expect(writeDelta(before, after)).toEqual({ 'a.y': c(1, 0, 2), 'a.z': c(0, 4, 0) });
  });

  it('passes when every journey write is named or is fleet noise outside the customer schema', () => {
    const v = evaluateWriteDelta({
      baselineWindows: [{ 'harness_shared.test_runs': c(4) }],
      signup: { 'papercusp_auth.hosted_users': c(1), 'harness_shared.test_runs': c(2) },
      cleanup: { 'papercusp_auth.organizations': c(0, 0, 1) },
      map: FAKE_MAP,
    });
    expect(v.passed).toBe(true);
    expect(v.falsifyingTables).toEqual([]);
    expect(v.excusedAsNoise).toEqual(['harness_shared.test_runs']);
    expect(v.customerSchemaTablesWritten).toEqual(['papercusp_auth.hosted_users', 'papercusp_auth.organizations']);
  });

  it('fails on the falsifier: an unnamed table written only during the journey', () => {
    const v = evaluateWriteDelta({
      baselineWindows: [{ 'harness_shared.test_runs': c(4) }],
      signup: { 'papercusp_auth.hosted_users': c(1), 'harness_shared.new_customer_side_table': c(1) },
      cleanup: {},
      map: FAKE_MAP,
    });
    expect(v.passed).toBe(false);
    expect(v.falsifyingTables).toEqual(['harness_shared.new_customer_side_table']);
  });

  it('never excuses an unnamed customer-schema table as noise, even if a baseline window wrote it', () => {
    const v = evaluateWriteDelta({
      baselineWindows: [{ 'papercusp_auth.unmapped_sessions': c(9) }],
      signup: {},
      cleanup: { 'papercusp_auth.unmapped_sessions': c(0, 0, 1) },
      map: FAKE_MAP,
    });
    expect(v.passed).toBe(false);
    expect(v.falsifyingTables).toEqual(['papercusp_auth.unmapped_sessions']);
    expect(v.excusedAsNoise).toEqual([]);
  });

  it('refuses to judge without a baseline window', () => {
    expect(() => evaluateWriteDelta({ baselineWindows: [], signup: {}, cleanup: {}, map: FAKE_MAP })).toThrow(/baseline/);
  });

  it('judges against the real map: every papercusp_auth signup table it names passes, an unnamed one fails', () => {
    const named = evaluateWriteDelta({
      baselineWindows: [{}],
      signup: {
        'papercusp_auth.hosted_users': c(1),
        'papercusp_auth.hosted_signup_attempts': c(1, 1),
        'papercusp_auth.organizations': c(1),
        'papercusp_auth.organization_memberships': c(1),
        'papercusp_auth.hosted_sessions': c(1),
      },
      cleanup: {},
      map: LIVE_DATA_MAP,
    });
    expect(named.falsifyingTables).toEqual([]);
    const unnamed = evaluateWriteDelta({
      baselineWindows: [{}],
      signup: { 'papercusp_auth.not_a_real_table_p001': c(1) },
      cleanup: {},
      map: LIVE_DATA_MAP,
    });
    expect(unnamed.falsifyingTables).toEqual(['papercusp_auth.not_a_real_table_p001']);
  });

  it('runs baselines on both sides of the journey and attributes signup and cleanup writes to their windows', async () => {
    let counter = 0;
    const snapshots: WriteSnapshot[] = [
      { 'harness_shared.test_runs': c(0), 'papercusp_auth.hosted_users': c(0) }, // pre0
      { 'harness_shared.test_runs': c(1), 'papercusp_auth.hosted_users': c(0) }, // pre1
      { 'harness_shared.test_runs': c(1), 'papercusp_auth.hosted_users': c(0) }, // pre2
      { 'harness_shared.test_runs': c(2), 'papercusp_auth.hosted_users': c(1) }, // after signup
      { 'harness_shared.test_runs': c(2), 'papercusp_auth.hosted_users': c(1, 0, 1) }, // after cleanup
      { 'harness_shared.test_runs': c(3), 'papercusp_auth.hosted_users': c(1, 0, 1) }, // post1
      { 'harness_shared.test_runs': c(3), 'papercusp_auth.hosted_users': c(1, 0, 1) }, // post2
    ];
    const events: string[] = [];
    const labels: string[] = [];
    const run = await runWriteDelta({
      snapshot: async (label) => {
        labels.push(label);
        events.push(`snapshot${counter}`);
        return snapshots[counter++];
      },
      startJourney: async () => {
        events.push('journey');
        return { meta: { attemptId: 'a1' }, cleanup: async () => void events.push('cleanup') };
      },
      sleep: async () => undefined,
      now: () => new Date('2026-10-14T00:00:00Z'),
      windowMs: 1,
      baselineWindowsEachSide: 2,
      map: FAKE_MAP,
    });
    expect(events).toEqual(['snapshot0', 'snapshot1', 'snapshot2', 'journey', 'snapshot3', 'cleanup', 'snapshot4', 'snapshot5', 'snapshot6']);
    expect(labels).toEqual(['pre0', 'pre1', 'pre2', 'signupSnapshot', 'cleanupSnapshot', 'post1', 'post2']);
    expect(run.journeyWindow).toEqual({ startMark: 'pre2', endMark: 'cleanupSnapshot' });
    expect(run.firstPassFalsifying).toEqual([]);
    expect(run.meta).toEqual({ attemptId: 'a1' });
    expect(run.cleanupError).toBeNull();
    expect(run.verdict.baselineWindowCount).toBe(4);
    expect(run.verdict.signup.map((r) => r.table)).toEqual(['harness_shared.test_runs', 'papercusp_auth.hosted_users']);
    expect(run.verdict.cleanup.map((r) => r.table)).toEqual(['papercusp_auth.hosted_users']);
    expect(run.verdict.passed).toBe(true);
    expect(Object.keys(run.marks)).toEqual(expect.arrayContaining(['pre0', 'pre2', 'journeyStart', 'signupSnapshot', 'cleanupEnd', 'post2']));
  });

  it('cleans the journey up even when the post-signup snapshot throws', async () => {
    let n = 0;
    let cleaned = false;
    await expect(
      runWriteDelta({
        snapshot: async () => {
          n += 1;
          if (n === 3) throw new Error('pg down');
          return {};
        },
        startJourney: async () => ({ meta: null, cleanup: async () => void (cleaned = true) }),
        sleep: async () => undefined,
        now: () => new Date(),
        windowMs: 1,
        baselineWindowsEachSide: 1,
        map: FAKE_MAP,
      }),
    ).rejects.toThrow('pg down');
    expect(cleaned).toBe(true);
  });

  it('reports a cleanup failure instead of swallowing it', async () => {
    const run = await runWriteDelta({
      snapshot: async () => ({}),
      startJourney: async () => ({
        meta: null,
        cleanup: async () => {
          throw new Error('workos delete failed');
        },
      }),
      sleep: async () => undefined,
      now: () => new Date(),
      windowMs: 1,
      baselineWindowsEachSide: 1,
      map: FAKE_MAP,
    });
    expect(run.cleanupError).toMatch(/workos delete failed/);
  });

  describe('row-level attribution to fleet writers', () => {
    const journey = { 'papercusp_auth.hosted_users': c(1), 'harness_shared.backup_events': c(5) };
    const judge = (writerAttributions: Parameters<typeof evaluateWriteDelta>[0]['writerAttributions'], extra: WriteSnapshot = {}) =>
      evaluateWriteDelta({ baselineWindows: [{}], signup: { ...journey, ...extra }, cleanup: {}, map: FAKE_MAP, writerAttributions });

    it('excuses a non-customer table only when the probe saw rows and all of them match the writer', () => {
      const v = judge([{ table: 'harness_shared.backup_events', writer: 'backup', rowsInWindow: 5, rowsNotFromWriter: 0 }]);
      expect(v.passed).toBe(true);
      expect(v.attributedToFleetWriter.map((a) => a.table)).toEqual(['harness_shared.backup_events']);
      expect(v.signup.find((r) => r.table === 'harness_shared.backup_events')?.attributedToWriter).toBe('backup');
      expect(v.rejectedAttributions).toEqual([]);
    });

    it('keeps the table falsifying when any row in the window came from another writer', () => {
      const v = judge([{ table: 'harness_shared.backup_events', writer: 'backup', rowsInWindow: 5, rowsNotFromWriter: 1 }]);
      expect(v.falsifyingTables).toEqual(['harness_shared.backup_events']);
      expect(v.rejectedAttributions.map((a) => a.table)).toEqual(['harness_shared.backup_events']);
    });

    it('keeps the table falsifying when the probe saw no rows (it cannot vouch for writes it did not see)', () => {
      const v = judge([{ table: 'harness_shared.backup_events', writer: 'backup', rowsInWindow: 0, rowsNotFromWriter: 0 }]);
      expect(v.falsifyingTables).toEqual(['harness_shared.backup_events']);
    });

    it('is fail-closed: an unprobed table stays falsifying', () => {
      expect(judge([]).falsifyingTables).toEqual(['harness_shared.backup_events']);
    });

    it('never lets an attribution excuse a customer-schema table', () => {
      const v = judge(
        [{ table: 'papercusp_auth.unmapped_sessions', writer: 'fleet', rowsInWindow: 3, rowsNotFromWriter: 0 }],
        { 'papercusp_auth.unmapped_sessions': c(3) },
      );
      expect(v.falsifyingTables).toContain('papercusp_auth.unmapped_sessions');
      expect(v.rejectedAttributions.map((a) => a.table)).toEqual(['papercusp_auth.unmapped_sessions']);
    });

    it('runWriteDelta probes only first-pass non-customer candidates, over the journey window, then re-judges', async () => {
      let i = 0;
      const snaps: WriteSnapshot[] = [
        {},
        {},
        { 'harness_shared.backup_events': c(5), 'papercusp_auth.unmapped_sessions': c(1) },
        { 'harness_shared.backup_events': c(5), 'papercusp_auth.unmapped_sessions': c(1) },
        { 'harness_shared.backup_events': c(5), 'papercusp_auth.unmapped_sessions': c(1) },
      ];
      const asked: unknown[] = [];
      const run = await runWriteDelta({
        snapshot: async () => snaps[i++],
        startJourney: async () => ({ meta: null, cleanup: async () => undefined }),
        sleep: async () => undefined,
        now: () => new Date('2026-10-14T00:00:00Z'),
        windowMs: 1,
        baselineWindowsEachSide: 1,
        map: FAKE_MAP,
        attribute: async (candidates, window) => {
          asked.push({ candidates, window });
          return [{ table: 'harness_shared.backup_events', writer: 'backup', rowsInWindow: 5, rowsNotFromWriter: 0 }];
        },
      });
      expect(asked).toEqual([{ candidates: ['harness_shared.backup_events'], window: { startMark: 'pre1', endMark: 'cleanupSnapshot' } }]);
      expect(run.firstPassFalsifying).toEqual(['harness_shared.backup_events', 'papercusp_auth.unmapped_sessions']);
      expect(run.verdict.falsifyingTables).toEqual(['papercusp_auth.unmapped_sessions']);
      expect(run.verdict.passed).toBe(false);
    });

    it('declares probes whose SQL is bounded by the window and refuses malformed bounds', () => {
      const w = {
        start: '2026-10-14T00:09:54.097Z',
        end: '2026-10-14T00:10:40.504Z',
        idHighWater: { 'harness_shared.agent_usage_samples': { start: 100, end: 282 } },
      };
      const tables = FLEET_WRITER_PROBES.map((p) => p.table);
      expect(new Set(tables).size).toBe(tables.length);
      for (const p of FLEET_WRITER_PROBES) {
        expect(LIVE_DATA_MAP.customerSchemas.some((s) => p.table.startsWith(`${s}.`))).toBe(false);
        const sql = p.sql(w);
        expect(sql).toContain(p.table);
        if (p.idColumn) expect(sql).toMatch(/id > 100 AND id <= 282/);
        else expect(sql).toContain("'2026-10-14T00:09:54.097Z'::timestamptz");
        expect(() => p.sql({ ...w, start: "2026-10-14'; DROP TABLE x; --", idHighWater: {} })).toThrow();
      }
    });

    it('with repeated journeys, a non-customer table falsifies only if EVERY journey wrote it', () => {
      const j = (extra: WriteSnapshot) => ({ signup: { 'papercusp_auth.hosted_users': c(1), ...extra }, cleanup: {} });
      const sporadic = evaluateWriteDelta({
        baselineWindows: [{}],
        signup: { 'papercusp_auth.hosted_users': c(1), 'harness_shared.memory_anchors': c(2) },
        cleanup: {},
        repeatJourneys: [j({}), j({})],
        map: FAKE_MAP,
      });
      expect(sporadic.journeyCount).toBe(3);
      expect(sporadic.passed).toBe(true);
      expect(sporadic.signup.find((r) => r.table === 'harness_shared.memory_anchors')?.journeysWritten).toBe(1);
      const every = evaluateWriteDelta({
        baselineWindows: [{}],
        signup: { 'harness_shared.memory_anchors': c(2) },
        cleanup: {},
        repeatJourneys: [{ signup: {}, cleanup: { 'harness_shared.memory_anchors': c(1) } }, j({ 'harness_shared.memory_anchors': c(1) })],
        map: FAKE_MAP,
      });
      expect(every.falsifyingTables).toEqual(['harness_shared.memory_anchors']);
      expect(every.signup.find((r) => r.table === 'harness_shared.memory_anchors')?.ins).toBe(3);
    });

    it('with repeated journeys, an unnamed customer-schema table in ANY journey still falsifies', () => {
      const v = evaluateWriteDelta({
        baselineWindows: [{}],
        signup: {},
        cleanup: {},
        repeatJourneys: [{ signup: { 'papercusp_auth.unmapped_sessions': c(1) }, cleanup: {} }],
        map: FAKE_MAP,
      });
      expect(v.falsifyingTables).toEqual(['papercusp_auth.unmapped_sessions']);
    });

    it('runWriteDelta repeats the journey with baselines in between and probes over the whole journey span', async () => {
      const labels: string[] = [];
      let started = 0;
      let cleaned = 0;
      let window: unknown;
      const run = await runWriteDelta({
        snapshot: async (label): Promise<WriteSnapshot> => {
          labels.push(label);
          return label.startsWith('signupSnapshot') ? { 'harness_shared.only_in_journey_one': c(labels.length === 3 ? 1 : 0) } : {};
        },
        startJourney: async () => ({ meta: ++started, cleanup: async () => void (cleaned += 1) }),
        sleep: async () => undefined,
        now: () => new Date('2026-10-14T00:00:00Z'),
        windowMs: 1,
        baselineWindowsEachSide: 1,
        baselineWindowsBetween: 2,
        journeys: 2,
        map: FAKE_MAP,
        attribute: async (_c, w) => {
          window = w;
          return [];
        },
      });
      expect(labels).toEqual(['pre0', 'pre1', 'signupSnapshot', 'cleanupSnapshot', 'mid1_1', 'mid1_2', 'signupSnapshot2', 'cleanupSnapshot2', 'post1']);
      expect([started, cleaned]).toEqual([2, 2]);
      expect(run.metas).toEqual([1, 2]);
      expect(run.verdict.journeyCount).toBe(2);
      expect(run.verdict.passed).toBe(true);
      expect(window).toBeUndefined();
      expect(run.journeyWindow).toEqual({ startMark: 'pre1', endMark: 'cleanupSnapshot2' });
    });

    it('parses a probe row and rejects a malformed one', () => {
      const p = FLEET_WRITER_PROBES[0];
      expect(parseProbeResult(p, '6\t0\n')).toEqual({ table: p.table, writer: p.writer, rowsInWindow: 6, rowsNotFromWriter: 0 });
      expect(() => parseProbeResult(p, 'ERROR\n')).toThrow(/unparseable/);
    });
  });
});
