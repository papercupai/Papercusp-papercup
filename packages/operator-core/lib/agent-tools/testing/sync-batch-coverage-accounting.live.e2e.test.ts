/**
 * LIVE end-to-end proof for green-main-ratchet-convergence-2026-10-17 AUTO-BAR-R-17-P-009
 * (rubric rev 12, #D-036..#D-039): both sync-batch routines kept recording five-minute slots,
 * every recorded slot carries a cause, and low coverage carries a fresh open alarm.
 *
 * Drives the real native check behind `testing:record-run { syncBatchCoverageAccounting: {} }`
 * (`executeSyncBatchCoverageAccounting`: the committed probe and four negative controls, read in
 * one read-only snapshot through the real `getOrgPg`, judged by the committed oracle) against the
 * live operator database. Only the ledger write is captured in memory, so this run records no
 * operational row of its own. An INDEPENDENT oracle then recomputes the probe's row in
 * TypeScript from the raw coverage ticks and alarm work-items, read over a separate `pg`
 * connection in the same snapshot as the probe.
 * Falsifier: the probe's window, floor, cause or alarm logic drifts from the recorded data (the
 * recomputation disagrees), a negative control stops failing, or the live data stops meeting
 * the bar.
 *
 * GUARDED: runs ONLY when PAPERCUSP_SYNC_BATCH_COVERAGE_LIVE=1; otherwise it skips (never passes
 * vacuously). Under that gate only, the suite lifts the unit-layer real-PG rail through the
 * sanctioned `allowRealPgForLiveSuite`. The live profile names the database unit, so the e2e
 * reporter records its runtime witness on the row:
 *
 *   PAPERCUSP_SYNC_BATCH_COVERAGE_LIVE=1 PAPERCUSP_TEST_RUN_HARNESS=papercusp \
 *   PAPERCUSP_APP_OPERATION_LIVE_PROFILE=docs/evidence/p009-r17-slot-accounting-live-2026-10-20/live-e2e-profile.json \
 *     npm run test:file -- packages/operator-core/lib/agent-tools/testing/sync-batch-coverage-accounting.live.e2e.test.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getOrgPg } from '@papercusp/db-org';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  judgeR17,
  parseR17Row,
  R17_COLUMNS,
  R17_MIN_SLOTS,
  R17_TARGET_RATIO,
  type R17Row,
} from '../../../../../scripts/lib/sync-batch-coverage-accounting-oracle.mjs';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { COVERAGE_EXPECTED_INTERVAL_MS } from '../../release/sync-batch-delta-check';
import { allowRealPgForLiveSuite } from '../../testing/live-suite-real-pg';
import { captureWorktreeSnapshotAsync } from '../../testing-worktree';
import { executeSyncBatchCoverageAccounting } from './record-run';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PROBE = 'docs/evidence/p009-r17-slot-accounting-live-2026-10-20/probe.sql';
const WORKSPACE = 'papercusp-workspace';
/** Each routine's coverage-low alarm, as the routines raise it. */
const ALARM_CONDITION: Record<string, string> = {
  'sync-batch-delta-check': 'sync-delta-coverage-low',
  'sync-batch-lint-guards': 'sync-lint-guards-coverage-low',
};
const TERMINAL = new Set(['done', 'dropped', 'resolved', 'closed']);
const WINDOW_MS = 86_400_000;
const ALARM_FRESH_MS = 4 * 3_600_000;
const NATIVE_TITLES = [
  'scope:workspace', 'scope:database-unchanged', 'definitions:read',
  'live:both-routines-present', 'live:slot-floor', 'live:every-slot-accounted',
  'live:low-coverage-has-fresh-alarm', 'live:probe-verdict-agrees',
  'control-noalarm:fails', 'control-stale:fails', 'control-terminal:fails', 'control-floor:fails',
];

const LIVE = process.env.PAPERCUSP_SYNC_BATCH_COVERAGE_LIVE === '1';
allowRealPgForLiveSuite(LIVE);

type Execution = NonNullable<NonNullable<Parameters<typeof executeSyncBatchCoverageAccounting>[1]>['execution']>;
type PersistParams = Parameters<Execution['persist']>[0];
interface RoutineRow { name: string; metadata: Record<string, any> | null }
interface AlarmRow { condition_key: string; status: string; last_seen: string | null }
interface ServerIdentity { database: string; port: number; started: string }

/**
 * The probe's six-field row, recomputed from the raw records without its SQL: per routine, the
 * distinct five-minute slots inside the 24h window, how many were evaluated, how many carry no cause, and whether a
 * coverage-low alarm is both open on the routine and fresh on its non-terminal work-item.
 */
function recompute(nowMs: number, routines: RoutineRow[], alarms: AlarmRow[]): R17Row {
  const per = routines.map(({ name, metadata }) => {
    const cov = metadata?.sync_delta?.coverage ?? metadata?.sync_lint_guards?.coverage ?? {};
    const bySlot = new Map<number, { evaluated: boolean; accounted: boolean }>();
    for (const tick of Array.isArray(cov.ticks) ? cov.ticks : []) {
      const atMs = Number(tick?.atMs);
      if (!Number.isFinite(atMs) || atMs <= nowMs - WINDOW_MS || atMs > nowMs) continue;
      const key = Math.floor(atMs / COVERAGE_EXPECTED_INTERVAL_MS);
      const prior = bySlot.get(key);
      // Each opportunity needs a judgment/cause once, independently of duplicate record order.
      bySlot.set(key, { evaluated: prior?.evaluated === true || tick.evaluated === true,
        accounted: prior?.accounted === true || (tick.status ?? '') !== '' });
    }
    const slots = bySlot.size;
    const evaluated = [...bySlot.values()].filter(slot => slot.evaluated).length;
    const unaccounted = [...bySlot.values()].filter(slot => !slot.accounted).length;
    const alarmOpen = Object.hasOwn(cov, 'alarmOpenSinceMs');
    const alarmFresh = alarms.some(alarm => alarm.condition_key === ALARM_CONDITION[name]
      && !TERMINAL.has(alarm.status) && alarm.last_seen !== null
      && Date.parse(alarm.last_seen) > nowMs - ALARM_FRESH_MS);
    return { slots, unaccounted, ratio: slots > 0 ? evaluated / slots : 0, alarmed: alarmOpen && alarmFresh };
  });
  return {
    routines: per.length,
    min_slots: per.length ? Math.min(...per.map(p => p.slots)) : 0,
    min_ratio: per.length ? Math.min(...per.map(p => p.ratio)) : 0,
    unaccounted_slots: per.reduce((sum, p) => sum + p.unaccounted, 0),
    low_without_current_alarm: per.filter(p => p.ratio < R17_TARGET_RATIO && !p.alarmed).length,
    accounted: per.length === 2 && per.every(p => p.slots >= R17_MIN_SLOTS && p.unaccounted === 0
      && (p.ratio >= R17_TARGET_RATIO || p.alarmed)) ? 1 : 0,
  };
}

const line = (row: Record<string, unknown>) => R17_COLUMNS.map(column => String(row[column])).join('|');

const FIXTURE_NOW = Date.UTC(2026, 9, 20, 12);
type Tick = { atMs: number; evaluated: boolean; status?: string };
const tick = (atMs: number, evaluated = true): Tick => ({ atMs, evaluated, status: evaluated ? 'green' : 'skipped' });
const recent = FIXTURE_NOW - COVERAGE_EXPECTED_INTERVAL_MS;
const distinct = (evaluated = true) => Array.from({ length: R17_MIN_SLOTS }, (_, i) =>
  tick(recent - i * COVERAGE_EXPECTED_INTERVAL_MS, evaluated));
const fixtures = [
  { name: 'duplicate ticks in one slot count once', ticks: [tick(recent), tick(recent + 1)], slots: 1, ratio: 1 },
  { name: 'ticks in separate slots count separately', ticks: [tick(recent - 1), tick(recent)], slots: 2, ratio: 1 },
  { name: 'duplicates cannot manufacture the 276-slot floor',
    ticks: Array.from({ length: R17_MIN_SLOTS }, (_, i) => tick(recent + i)), slots: 1, ratio: 1 },
  { name: '276 distinct slots satisfy the unchanged floor', ticks: distinct(), slots: R17_MIN_SLOTS, ratio: 1, accounted: 1 },
  { name: 'evaluated duplicates cannot inflate the coverage ratio',
    ticks: [...Array.from({ length: 20 }, (_, i) => tick(recent + i)), tick(recent - COVERAGE_EXPECTED_INTERVAL_MS, false)],
    slots: 2, ratio: 0.5, low: 2 },
  { name: 'a judged duplicate credits its slot once', ticks: [tick(recent, false), tick(recent + 1)], slots: 1, ratio: 1 },
  { name: 'mixed-status duplicates account for their slot with a nonempty cause',
    ticks: [{ atMs: recent, evaluated: true }, { ...tick(recent + 1), status: 'red' }], slots: 1, ratio: 1 },
  { name: 'mixed-status duplicates account for their slot in either record order',
    ticks: [{ ...tick(recent + 1), status: 'red' }, { atMs: recent, evaluated: true }], slots: 1, ratio: 1 },
  { name: 'duplicates without any cause leave their slot unaccounted',
    ticks: [{ atMs: recent, evaluated: true }, { atMs: recent + 1, evaluated: true, status: '' }],
    slots: 1, ratio: 1, unaccounted: 2 },
  { name: 'a cause in another slot cannot account for an empty slot',
    ticks: [{ atMs: recent, evaluated: true }, tick(recent - COVERAGE_EXPECTED_INTERVAL_MS)],
    slots: 2, ratio: 1, unaccounted: 2 },
  { name: 'the 24h window excludes its lower bound and future ticks, and includes now',
    ticks: [tick(FIXTURE_NOW - WINDOW_MS - 1), tick(FIXTURE_NOW - WINDOW_MS), tick(FIXTURE_NOW), tick(FIXTURE_NOW + 1)],
    slots: 1, ratio: 1 },
  { name: 'empty histories retain both routine identities', ticks: [], slots: 0, ratio: 0, low: 2 },
  { name: 'fresh alarms still account for low coverage at the unchanged floor',
    ticks: distinct(false), slots: R17_MIN_SLOTS, ratio: 0, alarm: true, accounted: 1 },
];

function fixtureRows(ticks: Tick[], alarm = false): RoutineRow[] {
  return Object.keys(ALARM_CONDITION).map((name, i) => ({ name, metadata: {
    [i === 0 ? 'sync_delta' : 'sync_lint_guards']: {
      coverage: { ticks, ...(alarm ? { alarmOpenSinceMs: recent } : {}) },
    },
  } }));
}
function fixtureAlarms(alarm = false): AlarmRow[] {
  return alarm ? Object.values(ALARM_CONDITION).map(condition_key => ({
    condition_key, status: 'open', last_seen: new Date(recent).toISOString(),
  })) : [];
}
function expectedFixture(fixture: typeof fixtures[number]): R17Row {
  return { routines: 2, min_slots: fixture.slots, min_ratio: fixture.ratio,
    unaccounted_slots: fixture.unaccounted ?? 0, low_without_current_alarm: fixture.low ?? 0,
    accounted: fixture.accounted ?? 0 };
}

describe('R17 distinct five-minute slots: independent recomputation', () => {
  it.each(fixtures)('$name', fixture => {
    expect(recompute(FIXTURE_NOW, fixtureRows(fixture.ticks, fixture.alarm), fixtureAlarms(fixture.alarm)))
      .toEqual(expectedFixture(fixture));
  });
});

describe.skipIf(!LIVE)('R17 distinct five-minute slots: committed SQL on read-only PostgreSQL', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '15s'");
  }, 60_000);
  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  });
  it.each(fixtures)('$name', async fixture => {
    // Execute the committed SQL unchanged apart from its input relations and clock.
    // JSON parameters feed a read-only fixture; no live routine or alarm row is written.
    const probe = readFileSync(resolve(ROOT, PROBE), 'utf8')
      .replaceAll('harness_shared.routines',
        'jsonb_to_recordset($1::jsonb) AS fixture_routines(workspace_id text, name text, metadata jsonb)')
      .replaceAll('harness_shared.work_items w',
        'jsonb_to_recordset($2::jsonb) AS w(workspace_id text, condition_key text, status text, payload jsonb)')
      .replaceAll('now()', 'to_timestamp($3::double precision / 1000)');
    const routines = fixtureRows(fixture.ticks, fixture.alarm).map(row => ({ ...row, workspace_id: WORKSPACE }));
    const alarms = fixtureAlarms(fixture.alarm).map(({ last_seen, ...row }) => ({ ...row,
      workspace_id: WORKSPACE, payload: { _conditionUpsert: { lastSeenAt: last_seen } },
    }));
    // Foreign workspace/routine rows must never contribute slots or satisfy an alarm.
    const foreign = routines.map(row => ({ ...row, workspace_id: 'foreign-workspace' }));
    const [row] = (await client.query(probe, [JSON.stringify([...routines, ...foreign]), JSON.stringify(alarms), FIXTURE_NOW])).rows;
    expect(parseR17Row(line(row))).toEqual(expectedFixture(fixture));
  });
});

describe.skipIf(!LIVE)('LIVE: sync-batch slot accounting on the operator database (AUTO-BAR-R-17-P-009)', () => {
  let identity: ServerIdentity;
  let recomputed: R17Row;
  let probeLine: string;
  let driftedLine: string;

  beforeAll(async () => {
    const client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      // One read-only snapshot: the raw records and the probe judge the same data.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout = '15s'");
      const [head] = (await client.query(`SELECT current_database() AS database, inet_server_port() AS port,
        pg_postmaster_start_time()::text AS started, (extract(epoch from now())*1000)::bigint::text AS now_ms`)).rows;
      identity = { database: head.database, port: Number(head.port), started: head.started };
      const routines = (await client.query(
        'SELECT name, metadata FROM harness_shared.routines WHERE workspace_id = $1 AND name = ANY($2)',
        [WORKSPACE, Object.keys(ALARM_CONDITION)])).rows as RoutineRow[];
      const alarms = (await client.query(`SELECT condition_key, status,
        payload->'_conditionUpsert'->>'lastSeenAt' AS last_seen
        FROM harness_shared.work_items WHERE workspace_id = $1 AND condition_key = ANY($2)`,
      [WORKSPACE, Object.values(ALARM_CONDITION)])).rows as AlarmRow[];
      const probe = readFileSync(resolve(ROOT, PROBE), 'utf8');
      const [row] = (await client.query(probe)).rows;
      const [drifted] = (await client.query(probe.replaceAll('86400000', '43200000'))).rows;
      recomputed = recompute(Number(head.now_ms), routines, alarms);
      probeLine = line(row);
      driftedLine = line(drifted);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }, 60_000);

  it('the native check reaches the same live server as the independent oracle', async () => {
    const { sql } = getOrgPg();
    const [native] = await sql`SELECT current_database() AS database, inet_server_port() AS port,
      pg_postmaster_start_time()::text AS started`;
    expect({ database: native?.database, port: Number(native?.port), started: native?.started }).toEqual(identity);
  });

  it('the native check, run end to end, would record a pass with all four controls failing', async () => {
    const persisted: PersistParams[] = [];
    const result = await executeSyncBatchCoverageAccounting({ workspaceId: WORKSPACE, harnessSlug: 'papercusp' }, {
      execution: {
        snapshot: captureWorktreeSnapshotAsync,
        // The runtime witness belongs to the recording host; this run records nothing.
        readRuntime: async () => null,
        persist: async (params) => {
          persisted.push(params);
          return { written: 1, ids: [0] };
        },
      },
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, status: 'pass' });
    expect(persisted).toHaveLength(1);
    const [run] = persisted[0]!.rows;
    const execution = run?.execution as { passed: number; failed: number; passedCaseTitles?: string[];
      failedCaseTitles?: string[] };
    expect(run?.filePath).toBe(PROBE);
    expect(execution.failedCaseTitles, run?.outputTail ?? '').toBeUndefined();
    expect(execution.failed).toBe(0);
    // Non-vacuity: every scope, live and control assertion was measured, not just "no failures".
    expect([...(execution.passedCaseTitles ?? [])].sort()).toEqual([...NATIVE_TITLES].sort());
  }, 180_000);

  it('an independent recomputation from the raw ticks agrees with the probe row, and the oracle passes it', () => {
    const probe = parseR17Row(probeLine);
    expect(recomputed.routines, 'both routines must be present in the snapshot').toBe(2);
    expect({ ...recomputed, min_ratio: 0 }).toEqual({ ...probe, min_ratio: 0 });
    expect(recomputed.min_ratio).toBeCloseTo(probe.min_ratio, 12);
    const verdict = judgeR17(probe);
    expect(verdict.passed, JSON.stringify(verdict.assertions)).toBe(true);
  });

  it('the recomputation is sensitive: a probe whose window drifts to 12h disagrees with it', () => {
    // 276 five-minute slots cannot fit in 12h, so a passing live row guarantees a real difference.
    expect(parseR17Row(driftedLine).min_slots).toBeLessThan(recomputed.min_slots);
    expect(judgeR17(parseR17Row(driftedLine)).passed).toBe(false);
  });
});
