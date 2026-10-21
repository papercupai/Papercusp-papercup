/**
 * WI-6554700010018409: lookupDriftCauseWorkItems windows on the COMMIT time, not the time the
 * row was recorded. Migration 1540 added `committed_at`; `ts` is the record time and lagged
 * the commit by up to 85h during the WI-6554700010018197 outage. Rows recorded before 1540
 * have no `committed_at` and fall back to `ts`. Real PG with the real migrations, because
 * the window is enforced in SQL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ db: null as FreshPgDb | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.db!.sql }),
}));
const { lookupDriftCauseWorkItems } = await import('./edit-attribution');

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);

beforeAll(async () => {
  h.db = await createFreshPgDb('edit-attr-drift');
  await applyMigrationsForTest(
    h.db.sql,
    [
      '363-commit-attribution-ledger.sql',
      '364-edit-attribution-ledger-repo-root.sql',
      '784-edit-attribution-acquired-via.sql',
      '1367-edit-attribution-dispatch-call-id.sql',
      '1540-git-sync-commit-attribution-repo-committed-at.sql',
    ],
    { runtimeTables: ['harness_shared.git_sync_commit_attribution'] },
  );
}, 120_000);
afterAll(async () => {
  await h.db?.cleanup();
});
beforeEach(async () => {
  await h.db!.sql.unsafe('TRUNCATE harness_shared.git_sync_commit_attribution');
});

async function insertRow(row: {
  file: string;
  workItemId: string;
  ts: Date;
  committedAt: Date | null;
  harnessSlug?: string;
}): Promise<void> {
  const sql = h.db!.sql;
  await sql`
    INSERT INTO harness_shared.git_sync_commit_attribution
      (workspace_id, harness_slug, repo, commit_sha, file, work_item_id, ts, committed_at)
    VALUES ('ws', ${row.harnessSlug ?? 'papercusp'}, 'superproject', ${'c'.repeat(40)}, ${row.file},
            ${row.workItemId}, ${row.ts}, ${row.committedAt})`;
}

describe('lookupDriftCauseWorkItems windowing (real PG, migrations 363 + 1540)', () => {
  it('windows on commit time: an old commit recorded late is outside the default 14 days', async () => {
    // Committed 30 days ago, recorded just now: a ts-only window would wrongly include it.
    await insertRow({ file: 'src/late.ts', workItemId: 'WI-LATE', ts: daysAgo(0), committedAt: daysAgo(30) });
    // Committed and recorded 2 days ago.
    await insertRow({ file: 'src/recent.ts', workItemId: 'WI-RECENT', ts: daysAgo(2), committedAt: daysAgo(2) });

    const out = await lookupDriftCauseWorkItems(['src/late.ts', 'src/recent.ts']);

    expect(Object.fromEntries(out)).toEqual({ 'src/recent.ts': ['WI-RECENT'] });
  });

  it('falls back to the record time for rows written before committed_at existed', async () => {
    await insertRow({ file: 'src/legacy-new.ts', workItemId: 'WI-LEGACY-NEW', ts: daysAgo(3), committedAt: null });
    await insertRow({ file: 'src/legacy-old.ts', workItemId: 'WI-LEGACY-OLD', ts: daysAgo(30), committedAt: null });

    const out = await lookupDriftCauseWorkItems(['src/legacy-new.ts', 'src/legacy-old.ts']);

    expect(Object.fromEntries(out)).toEqual({ 'src/legacy-new.ts': ['WI-LEGACY-NEW'] });
  });

  it('honours lookbackHours on the commit time', async () => {
    await insertRow({ file: 'src/late.ts', workItemId: 'WI-LATE', ts: daysAgo(0), committedAt: daysAgo(30) });

    expect(Object.fromEntries(await lookupDriftCauseWorkItems(['src/late.ts'], { lookbackHours: 24 * 60 }))).toEqual({
      'src/late.ts': ['WI-LATE'],
    });
    expect((await lookupDriftCauseWorkItems(['src/late.ts'], { lookbackHours: 24 * 29 })).size).toBe(0);
  });

  it('scopes to harnessSlug when given', async () => {
    await insertRow({ file: 'src/a.ts', workItemId: 'WI-HERE', ts: daysAgo(1), committedAt: daysAgo(1) });
    await insertRow({
      file: 'src/a.ts',
      workItemId: 'WI-THERE',
      ts: daysAgo(1),
      committedAt: daysAgo(1),
      harnessSlug: 'papercusp/libs/papercusp',
    });

    expect(Object.fromEntries(await lookupDriftCauseWorkItems(['src/a.ts'], { harnessSlug: 'papercusp' }))).toEqual({
      'src/a.ts': ['WI-HERE'],
    });
  });
});
