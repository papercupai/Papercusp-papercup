/**
 * The bulk-dedup in-flight check against real Postgres (WI-10004722, plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-005).
 *
 * The daily driver arms a run only when this says nothing is in flight, so both
 * directions matter: a missed live pass would stack two passes over the same corpus,
 * and a stale leftover counted as live would block the driver forever — which is
 * the "nothing ever runs" failure the driver exists to end. Inline DDL carries only
 * the columns the check reads (createFreshPgDb replays no migrations).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  BULK_DEDUP_IN_FLIGHT_WINDOW_MS,
  bulkDedupInFlight,
  type BulkDedupRoutineSql,
} from './work-items-admission-bulk-dedup-enqueue';

const WS = 'ws-bulk-driver';
const HARNESS = 'papercusp';
const NOW_MS = Date.parse('2026-10-01T12:00:00.000Z');
const HOUR = 60 * 60_000;
const BULK_ROLE = 'system:work-item-admission-bulk-dedup';

let db: FreshPgDb;
let sql: BulkDedupRoutineSql;

beforeAll(async () => {
  db = await createFreshPgDb('bulkdrv');
  sql = db.sql as unknown as BulkDedupRoutineSql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      install_slug text NOT NULL,
      target_role text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      next_fire_at timestamptz
    );
    CREATE TABLE harness_shared.admission_runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      run_kind text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      detail jsonb
    );
    CREATE SCHEMA dbos;
    CREATE TABLE dbos.workflow_status (
      workflow_uuid text PRIMARY KEY,
      status text NOT NULL,
      deduplication_id text,
      created_at bigint NOT NULL DEFAULT 0
    );
  `);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql.unsafe(
    'TRUNCATE harness_shared.routines, harness_shared.admission_runs, dbos.workflow_status',
  );
});

async function routine(row: {
  id: string;
  role?: string;
  active?: boolean;
  nextFireOffsetMs?: number | null;
  harness?: string;
  workspace?: string;
}) {
  const nextFireAt =
    row.nextFireOffsetMs === null || row.nextFireOffsetMs === undefined
      ? null
      : new Date(NOW_MS + row.nextFireOffsetMs).toISOString();
  await db.sql`
    INSERT INTO harness_shared.routines (id, workspace_id, install_slug, target_role, active, next_fire_at)
    VALUES (${row.id}, ${row.workspace ?? WS}, ${row.harness ?? HARNESS}, ${row.role ?? BULK_ROLE},
            ${row.active ?? false}, ${nextFireAt}::timestamptz)`;
}

async function fire(routineId: string, status: string) {
  await db.sql`
    INSERT INTO dbos.workflow_status (workflow_uuid, status, deduplication_id)
    VALUES (${`wf-${routineId}-${status}`}, ${status}, ${`routine:${routineId}`})`;
}

async function admissionRun(row: {
  id: string;
  kind: string;
  ageMs: number;
  finished?: boolean;
  harness?: string;
  leaseOwner?: string;
}) {
  const startedAt = new Date(NOW_MS - row.ageMs).toISOString();
  // Build the object in SQL: a JSON string bound as a parameter can land as a
  // jsonb string scalar, which would make detail->'lease' NULL and the test vacuous.
  const owner = row.leaseOwner ?? null;
  await db.sql`
    INSERT INTO harness_shared.admission_runs (id, workspace_id, harness_slug, run_kind, started_at, finished_at, detail)
    VALUES (${row.id}, ${WS}, ${row.harness ?? HARNESS}, ${row.kind}, ${startedAt}::timestamptz,
            ${row.finished ? startedAt : null}::timestamptz,
            CASE WHEN ${owner}::text IS NULL THEN NULL
                 ELSE jsonb_build_object('status', 'running', 'lease', jsonb_build_object('ownerId', ${owner}::text))
            END)`;
}

async function workflow(uuid: string, status: string) {
  await db.sql`INSERT INTO dbos.workflow_status (workflow_uuid, status) VALUES (${uuid}, ${status})`;
}

const check = () => bulkDedupInFlight(sql, { workspaceId: WS, harnessSlug: HARNESS, nowMs: NOW_MS });

describe('bulkDedupInFlight', () => {
  it('reports nothing in flight when every earlier pass finished', async () => {
    await routine({ id: 'rt-old-run', active: false });
    await fire('rt-old-run', 'SUCCESS');
    await admissionRun({ id: 'census-done', kind: 'census', ageMs: 2 * HOUR, finished: true });
    await admissionRun({ id: 'stage-done', kind: 'bulk-stage', ageMs: HOUR, finished: true });
    await expect(check()).resolves.toEqual({ inFlight: false });
  });

  it('counts an armed bulk-dedup routine that has not fired yet', async () => {
    await routine({ id: 'rt-armed', active: true, nextFireOffsetMs: -60_000 });
    await expect(check()).resolves.toMatchObject({ inFlight: true, reason: 'routine-armed', ref: 'rt-armed' });
  });

  it('counts a live routineFire of ANY bulk-dedup routine, manual or scheduled', async () => {
    await routine({ id: 'rt-manual-run', active: false });
    await fire('rt-manual-run', 'PENDING');
    await expect(check()).resolves.toMatchObject({
      inFlight: true,
      reason: 'routine-fire-live',
      ref: 'rt-manual-run',
    });
  });

  it('counts a census or bulk stage that started inside the window and never finished', async () => {
    await admissionRun({ id: 'stage-open', kind: 'bulk-stage', ageMs: 3 * HOUR });
    await expect(check()).resolves.toMatchObject({
      inFlight: true,
      reason: 'admission-run-open',
      ref: 'stage-open',
    });
  });

  it('treats an open stage whose lease-owning workflow has ended as abandoned, so the driver retries it (WI-10004918)', async () => {
    // Measured 2026-10-01: host restarts dead-lettered the 24h routineFire
    // (MAX_RECOVERY_ATTEMPTS_EXCEEDED) and its stage row stayed open for the whole window.
    for (const [i, status] of ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'ERROR', 'CANCELLED', 'SUCCESS'].entries()) {
      await workflow(`wf-dead-${i}`, status);
      await admissionRun({ id: `stage-orphan-${i}`, kind: 'bulk-stage', ageMs: 3 * HOUR, leaseOwner: `wf-dead-${i}` });
    }
    await expect(check()).resolves.toEqual({ inFlight: false });
  });

  it('still counts an open stage whose lease owner is live, or is not a DBOS workflow at all', async () => {
    await workflow('wf-live', 'PENDING');
    await admissionRun({ id: 'stage-live', kind: 'bulk-stage', ageMs: 3 * HOUR, leaseOwner: 'wf-live' });
    await expect(check()).resolves.toMatchObject({ inFlight: true, reason: 'admission-run-open', ref: 'stage-live' });

    await db.sql.unsafe('TRUNCATE harness_shared.admission_runs, dbos.workflow_status');
    await admissionRun({ id: 'stage-manual', kind: 'bulk-stage', ageMs: 3 * HOUR, leaseOwner: 'su-manual-caller' });
    await expect(check()).resolves.toMatchObject({ inFlight: true, reason: 'admission-run-open', ref: 'stage-manual' });
  });

  it('ignores stale leftovers older than the fire-timeout window, so they cannot block the driver forever', async () => {
    const stale = BULK_DEDUP_IN_FLIGHT_WINDOW_MS + HOUR;
    await routine({ id: 'rt-wedged', active: true, nextFireOffsetMs: -stale });
    await admissionRun({ id: 'stage-stranded', kind: 'bulk-stage', ageMs: stale });
    await admissionRun({ id: 'census-stranded', kind: 'census', ageMs: stale });
    await expect(check()).resolves.toEqual({ inFlight: false });
  });

  it("does not count the driver's own fire, other target roles, other harnesses or other run kinds", async () => {
    // The driver routine itself is live while it runs this check; it must not see itself.
    await routine({ id: 'rt-driver', role: 'system:work-item-admission-bulk-dedup-driver', active: true, nextFireOffsetMs: HOUR });
    await fire('rt-driver', 'PENDING');
    await routine({ id: 'rt-portal-run', harness: 'portal', active: true, nextFireOffsetMs: 0 });
    await fire('rt-portal-run', 'ENQUEUED');
    await routine({ id: 'rt-other-ws', workspace: 'ws-other', active: true, nextFireOffsetMs: 0 });
    await admissionRun({ id: 'tick-open', kind: 'promoter-tick', ageMs: HOUR });
    await admissionRun({ id: 'portal-stage-open', kind: 'bulk-stage', ageMs: HOUR, harness: 'portal' });
    await expect(check()).resolves.toEqual({ inFlight: false });
  });
});
