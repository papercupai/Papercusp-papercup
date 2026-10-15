/**
 * Stranded admission_runs reaper against real Postgres (WI-10004726, plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-008).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADMISSION_RUN_STRANDED_AFTER_MS,
  DEFAULT_BULK_STAGE_LEASE_MS,
  reapStrandedAdmissionRuns,
  STRANDED_ADMISSION_RUN_REASON,
} from './admission-runs-reaper';
import type { OrgSql } from './work-items';

const WS = 'ws-reaper';
const NOW_MS = Date.parse('2026-10-01T12:00:00.000Z');
const MIN = 60_000;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('admreap');
  // The columns the reaper reads/writes, from the real admission_runs shape.
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.admission_runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      run_kind text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      detail jsonb
    )`);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.admission_runs`;
});

async function seed(row: {
  id: string;
  kind: string;
  ageMin: number;
  workspace?: string;
  harness?: string;
  finished?: boolean;
  status?: string;
  lease?: { ownerId: string; expiresAtMs: number };
}): Promise<void> {
  const startedAt = new Date(NOW_MS - row.ageMin * MIN).toISOString();
  const detail = {
    status: row.status ?? 'running',
    mode: 'promoter',
    outcome: { unit: 'items', failureReason: null },
    ...(row.lease
      ? { lease: { ownerId: row.lease.ownerId, expiresAt: row.lease.expiresAtMs } }
      : {}),
  };
  await db.sql`
    INSERT INTO harness_shared.admission_runs (id, workspace_id, harness_slug, run_kind, started_at, finished_at, detail)
    VALUES (${row.id}, ${row.workspace ?? WS}, ${row.harness ?? 'papercusp'}, ${row.kind}, ${startedAt}::timestamptz,
            ${row.finished ? startedAt : null}::timestamptz, ${JSON.stringify(detail)}::text::jsonb)`;
}

async function readRow(id: string) {
  const [row] = await db.sql<Array<{ finished_at: Date | null; detail: Record<string, any> }>>`
    SELECT finished_at, detail FROM harness_shared.admission_runs WHERE id = ${id}`;
  return row!;
}

describe('reapStrandedAdmissionRuns', () => {
  it('settles each kind past its own threshold as failed/stranded, across every harness of the workspace', async () => {
    await seed({ id: 'tick-stranded', kind: 'promoter-tick', ageMin: 121 });
    await seed({ id: 'tick-other-harness', kind: 'promoter-tick', ageMin: 3 * 24 * 60, harness: 'portal' });
    await seed({ id: 'park-stranded', kind: 'durable-park-audit', ageMin: 61 });
    await seed({ id: 'sweep-stranded', kind: 'delta-sweep', ageMin: 181 });
    await seed({ id: 'digest-stranded', kind: 'daily-digest', ageMin: 181 });

    const reaped = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, {
      workspaceId: WS, reaperRunId: 'fail-open-reaper', nowMs: NOW_MS,
    });

    expect(reaped.map((r) => r.id).sort()).toEqual(
      ['digest-stranded', 'park-stranded', 'sweep-stranded', 'tick-other-harness', 'tick-stranded'],
    );
    expect(reaped.find((r) => r.id === 'tick-other-harness')).toMatchObject({ harnessSlug: 'portal', runKind: 'promoter-tick' });

    const row = await readRow('tick-stranded');
    expect(row.finished_at).not.toBeNull();
    expect(row.detail.status).toBe('failed');
    expect(row.detail.outcome.failureReason).toBe(STRANDED_ADMISSION_RUN_REASON);
    expect(row.detail.outcome.unit).toBe('items');
    expect(row.detail.mode).toBe('promoter');
    expect(row.detail.reapedBy).toBe('fail-open-reaper');
    expect(row.detail.reapedAt).toBe(new Date(NOW_MS).toISOString());
    expect(row.detail.strandedAfterMs).toBe(ADMISSION_RUN_STRANDED_AFTER_MS['promoter-tick']);
    expect(String(row.detail.error)).toContain('promoter-tick stranded threshold');
  });

  it('reaps only expired bulk-stage leases on the recurring tick and fences their old owner', async () => {
    await seed({
      id: 'stage-expired',
      kind: 'bulk-stage',
      ageMin: 10,
      lease: { ownerId: 'workflow-dead', expiresAtMs: NOW_MS - 1 },
    });
    await seed({
      id: 'stage-live-old-start',
      kind: 'bulk-stage',
      ageMin: 10 * 24 * 60,
      lease: { ownerId: 'workflow-live', expiresAtMs: NOW_MS + 60 * MIN },
    });
    await seed({ id: 'stage-legacy-stranded', kind: 'bulk-stage', ageMin: 121 });
    await seed({ id: 'census-old', kind: 'census', ageMin: 10 * 24 * 60 });

    const reaped = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, {
      workspaceId: WS,
      reaperRunId: 'fail-open-reaper',
      nowMs: NOW_MS,
    });

    expect(reaped.map((row) => row.id).sort()).toEqual(['stage-expired', 'stage-legacy-stranded']);
    const expired = await readRow('stage-expired');
    expect(expired.finished_at).not.toBeNull();
    expect(expired.detail.status).toBe('failed');
    expect(expired.detail.outcome.failureReason).toBe(STRANDED_ADMISSION_RUN_REASON);
    expect(expired.detail.lease).toMatchObject({
      ownerId: null,
      invalidatedOwnerId: 'workflow-dead',
      invalidatedAt: new Date(NOW_MS).toISOString(),
    });
    expect(expired.detail.reapedBy).toBe('fail-open-reaper');
    expect(expired.detail.strandedAfterMs).toBe(DEFAULT_BULK_STAGE_LEASE_MS);

    const live = await readRow('stage-live-old-start');
    expect(live.finished_at).toBeNull();
    expect(live.detail.status).toBe('running');
    expect(live.detail.lease.ownerId).toBe('workflow-live');
    expect((await readRow('census-old')).finished_at).toBeNull();
  });

  it('leaves live, finished, lease-owned, foreign-workspace and self rows untouched', async () => {
    await seed({ id: 'tick-live', kind: 'promoter-tick', ageMin: 119 });
    await seed({ id: 'park-live', kind: 'durable-park-audit', ageMin: 59 });
    await seed({ id: 'tick-finished', kind: 'promoter-tick', ageMin: 600, finished: true, status: 'complete' });
    await seed({ id: 'tick-status-complete', kind: 'promoter-tick', ageMin: 600, status: 'complete' });
    // A live bulk-stage lease remains resumable; census keeps its run-start reaper.
    await seed({
      id: 'stage-old',
      kind: 'bulk-stage',
      ageMin: 10 * 24 * 60,
      lease: { ownerId: 'workflow-live', expiresAtMs: NOW_MS + 60 * MIN },
    });
    await seed({ id: 'census-old', kind: 'census', ageMin: 10 * 24 * 60 });
    await seed({ id: 'tick-foreign', kind: 'promoter-tick', ageMin: 600, workspace: 'other-ws' });
    await seed({ id: 'fail-open-reaper', kind: 'promoter-tick', ageMin: 600 });

    const reaped = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, {
      workspaceId: WS, reaperRunId: 'fail-open-reaper', nowMs: NOW_MS,
    });

    expect(reaped).toEqual([]);
    for (const id of ['tick-live', 'park-live', 'stage-old', 'census-old', 'tick-foreign', 'fail-open-reaper']) {
      const row = await readRow(id);
      expect(row.finished_at, id).toBeNull();
      expect(row.detail.status, id).toBe('running');
    }
    expect((await readRow('tick-status-complete')).detail.status).toBe('complete');
  });

  it('is idempotent: a second pass reaps nothing', async () => {
    await seed({ id: 'tick-stranded', kind: 'promoter-tick', ageMin: 500 });
    const first = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, { workspaceId: WS, reaperRunId: 'r1', nowMs: NOW_MS });
    const second = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, { workspaceId: WS, reaperRunId: 'r2', nowMs: NOW_MS });
    expect(first.map((r) => r.id)).toEqual(['tick-stranded']);
    expect(second).toEqual([]);
    expect((await readRow('tick-stranded')).detail.reapedBy).toBe('r1');
  });

  it('honours a threshold override and refuses a non-positive one', async () => {
    await seed({ id: 'tick-30m', kind: 'promoter-tick', ageMin: 30 });
    const reaped = await reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, {
      workspaceId: WS, reaperRunId: 'r', nowMs: NOW_MS, strandedAfterMs: { 'promoter-tick': 20 * MIN },
    });
    expect(reaped.map((r) => r.id)).toEqual(['tick-30m']);
    await expect(reapStrandedAdmissionRuns(db.sql as unknown as OrgSql, {
      workspaceId: WS, reaperRunId: 'r', nowMs: NOW_MS, strandedAfterMs: { 'daily-digest': 0 },
    })).rejects.toThrow(/positive number of ms/);
  });
});
