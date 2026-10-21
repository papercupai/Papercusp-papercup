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
import { beforeAll, describe, expect, it } from 'vitest';
import {
  judgeR17,
  parseR17Row,
  R17_COLUMNS,
  R17_MIN_SLOTS,
  R17_TARGET_RATIO,
  type R17Row,
} from '../../../../../scripts/lib/sync-batch-coverage-accounting-oracle.mjs';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
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
 * ticks inside the 24h window, how many were evaluated, how many carry no cause, and whether a
 * coverage-low alarm is both open on the routine and fresh on its non-terminal work-item.
 */
function recompute(nowMs: number, routines: RoutineRow[], alarms: AlarmRow[]): R17Row {
  const per = routines.map(({ name, metadata }) => {
    const cov = metadata?.sync_delta?.coverage ?? metadata?.sync_lint_guards?.coverage ?? {};
    const ticks = (Array.isArray(cov.ticks) ? cov.ticks : [])
      .filter((tick: { atMs?: unknown }) => Number(tick?.atMs) > nowMs - WINDOW_MS);
    const slots = ticks.length;
    const evaluated = ticks.filter((tick: { evaluated?: unknown }) => tick.evaluated === true).length;
    const unaccounted = ticks.filter((tick: { status?: unknown }) => (tick.status ?? '') === '').length;
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
