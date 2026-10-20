/**
 * bug-inflow.integration.test.ts — bug-inflow-one-problem-one-row-2026-10-18 R-6, exact counts.
 *
 * bug-inflow.test.ts pins the SHAPE of the work.bugInflow reading. This file pins the
 * COUNTS: it seeds a known population into harness_shared.work_items on a fully migrated
 * Postgres, runs the production tick writer (refreshBugInflowDaily, i.e. the real
 * BUG_INFLOW_REFRESH_SQL), reads the stored rows back through readBugInflowDaily, and
 * asserts every number.
 *
 * The population covers each rule the R-6 method states:
 *   - filed-per-day is bucketed by reporter source (payload.source, then a watchdog
 *     reporterKind, then filedByRole as role:<r>, else unattributed);
 *   - a row stamped duplicate_of counts in filed-per-day like any other filing, and in
 *     closed-per-day on the day it reaches a terminal status, under that status;
 *   - closed-per-day counts by close day, so a row filed before the window still counts;
 *   - observation-lane rows, other workspaces and non-issue kinds count nowhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { readBugInflowDaily, refreshBugInflowDaily } from './bug-inflow';

const WS = 'ws-r6-exact';
const OTHER_WS = 'ws-r6-other';
const NOW = new Date('2026-10-20T12:00:00Z');
const at = (iso: string) => Date.parse(iso);

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

async function seed(row: {
  id: string;
  ws?: string;
  kind?: string;
  status?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  closedAt?: string;
  duplicateOf?: string;
}) {
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, workspace_id, title, status, item_kind, nature, payload,
       created_ts, closed_ts, duplicate_of, duplicate_source)
    VALUES ('r6-h', ${row.id}, ${row.ws ?? WS}, ${`r6 ${row.id}`}, ${row.status ?? 'open'},
            ${row.kind ?? 'bug'}, 'work', ${db.adminSql.json((row.payload ?? {}) as never)},
            ${at(row.createdAt)}, ${row.closedAt ? at(row.closedAt) : null},
            ${row.duplicateOf ?? null}, ${row.duplicateOf ? 'agent' : null})`;
}

describe('R-6: the stored inflow rollup counts exactly what was filed and closed', () => {
  it('buckets filings by source and closes by status per UTC day, counting a duplicate_of row in both', async () => {
    // Filed on 2026-10-19: two watchdog, two role:su (one of them a duplicate, dropped the same day).
    await seed({ id: 'R6-A', payload: { source: 'watchdog' }, createdAt: '2026-10-19T03:00:00Z' });
    await seed({ id: 'R6-B', payload: { reporterKinds: ['watchdog', 'agent'] }, createdAt: '2026-10-19T04:00:00Z' });
    await seed({ id: 'R6-C', kind: 'change', payload: { filedByRole: 'su' }, createdAt: '2026-10-19T05:00:00Z' });
    await seed({
      id: 'R6-D', payload: { filedByRole: 'su' }, status: 'dropped', duplicateOf: 'R6-A',
      createdAt: '2026-10-19T06:00:00Z', closedAt: '2026-10-19T08:00:00Z',
    });
    // Filed BEFORE the window, closed inside it: counts as a close on 2026-10-19 only.
    await seed({ id: 'R6-H', status: 'done', createdAt: '2026-10-17T09:00:00Z', closedAt: '2026-10-19T10:00:00Z' });
    // Filed on 2026-10-20 with no attribution.
    await seed({ id: 'R6-I', kind: 'task', createdAt: '2026-10-20T01:00:00Z' });
    // Counted nowhere: an observation note, another workspace, a feature-family row.
    await seed({ id: 'R6-E', payload: { lane: 'observation', source: 'watchdog' }, createdAt: '2026-10-19T07:00:00Z' });
    await seed({ id: 'R6-F', ws: OTHER_WS, payload: { source: 'watchdog' }, createdAt: '2026-10-19T07:30:00Z' });
    await seed({ id: 'R6-G', kind: 'feature', payload: { source: 'watchdog' }, createdAt: '2026-10-19T07:45:00Z' });

    const written = await refreshBugInflowDaily(WS, { now: NOW, sql: db.adminSql });
    expect(written.days).toEqual(['2026-10-19', '2026-10-20']);

    const reading = await readBugInflowDaily(WS, { days: 2, now: NOW, sql: db.adminSql });
    expect(reading.assessment).toBe('measured');
    expect(reading.missingDays).toEqual([]);
    const byDay = new Map(reading.days.map((d) => [d.day, d]));

    expect(byDay.get('2026-10-19')).toMatchObject({
      filedTotal: 4,
      filedBySource: { watchdog: 2, 'role:su': 2 },
      closedTotal: 2,
      closedByStatus: { dropped: 1, done: 1 },
      net: 2,
    });
    expect(byDay.get('2026-10-20')).toMatchObject({
      filedTotal: 1,
      filedBySource: { unattributed: 1 },
      closedTotal: 0,
      closedByStatus: {},
      net: 1,
    });
    expect(reading.totals).toEqual({
      filed: 5,
      closed: 2,
      net: 3,
      filedBySource: { watchdog: 2, 'role:su': 2, unattributed: 1 },
      closedByStatus: { dropped: 1, done: 1 },
    });
  });
});
