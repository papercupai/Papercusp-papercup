/**
 * work-items-loop-iteration-noise-exclusion.integration.test.ts — the issue-family AUTO-loop
 * bookkeeping self-select exclusion (EI-8802).
 *
 * Multiple agents' AUTO-loop iterations file a generic self-tracking work_item each wake
 * ("Loop wake #N: continue backlog drain...", "AUTO loop iteration: claim and process next
 * backlog item (su-XXXXX, <date>)") as a normal claimable `task`/issue-family item instead of a
 * PRIVATE carry-note (`loop:checkpoint`, which never enters the shared queue). These accumulate
 * (WI-3077/WI-3078, both filed 2026-07-05, both still open 4 days later) and get pulled by
 * `scheduler:get_next`/`claim_next` by OTHER agents draining the backlog — a full claim cycle
 * burned for zero real work.
 *
 * Mirrors work-items-federation-detector-exclusion.integration.test.ts's shape exactly (same
 * self-select floor pattern, gating on the row's TITLE instead of a payload key, since these
 * pre-date any tagging convention):
 *
 * Proves against real Postgres (testcontainer; Docker required):
 *   • claimNextWorkItem's issue tier SKIPS a "Loop wake #N" / "AUTO loop iteration:" marker and
 *     serves a real item instead — even when the marker is oldest;
 *   • a marker is STILL directly claimable BY ID (the floor only gates self-select);
 *   • an item whose title merely CONTAINS "loop" but doesn't match either marker prefix is NOT
 *     excluded;
 *   • the match is case-insensitive (ILIKE) and NULL-safe (no title);
 *   • diagnoseClaimNextMiss reports a marker-only backlog as DRAINED (pendingUnclaimed===0,
 *     drained===true) — a marker is not generic-work-queue material AT ALL;
 *   • a real ready item alongside a marker counts fully (the marker neither shadows siblings nor
 *     inflates the pending/ready counts).
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/work-items-loop-iteration-noise-exclusion.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, applyClaimPathReadDeps, WORK_ITEM_DEPS_DDL } from '../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

const wi = await import('./work-items');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

/** An issue-family row in the work_items BASE, with an explicit (possibly null) title. */
async function seedIssue(
  id: string,
  opts: { kind?: string; status?: string; title?: string | null; createdTs?: number } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
    VALUES (${H}, ${id}, ${opts.kind ?? 'task'}, ${opts.title ?? `title ${id}`}, ${opts.status ?? 'open'}, ${null},
       ${WS}, ${opts.createdTs ?? 0}, 0, ${null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('wi-loop-iteration-noise');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
  // The by-id issue claim auto-subscribes the claimer (coord_entity_subscriptions).
  await ensureCoordCapabilityTables(db.sql);
}, 180_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps`;
  setFlagOverridesForTest({
    [FLAGS.SCHEDULER_ISSUES_CLAIMABLE]: true,
    [FLAGS.SCHEDULER_MAINTAINED_READY]: false,
  });
});
afterEach(() => setFlagOverridesForTest({}));

describe('claimNextWorkItem SKIPS an AUTO-loop-iteration bookkeeping marker (EI-8802)', () => {
  it('serves the real item, never a "Loop wake #N" marker, even when it is oldest', async () => {
    await seedIssue('WI-loop-marker', { createdTs: 100, title: 'Loop wake #42: continue backlog drain on papercusp' });
    await seedIssue('WI-real', { createdTs: 200 });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real');

    expect(await wi.claimNextWorkItem({ harness: H, assignee: 'bee-2' })).toBeNull();

    const rows = await db.sql<{ taken_by: string | null }[]>`
      SELECT taken_by FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = 'WI-loop-marker'`;
    expect(rows[0]?.taken_by).toBeNull();
  });

  it('serves the real item, never an "AUTO loop iteration:" marker, even when it is oldest', async () => {
    await seedIssue('WI-loop-marker-2', {
      createdTs: 100,
      title: 'AUTO loop iteration: claim and process next backlog item (su-abc123, 2026-07-05)',
    });
    await seedIssue('WI-real-2', { createdTs: 200 });

    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real-2');
  });

  it('a marker is STILL directly claimable by id (the floor only gates self-select)', async () => {
    await seedIssue('WI-loop-marker-direct', { createdTs: 100, title: 'Loop wake #1: continue backlog drain' });
    const claimed = await wi.claimWorkItem('WI-loop-marker-direct', 'p2p-fleet', { harness: H });
    expect(claimed?.id).toBe('WI-loop-marker-direct');
    expect(claimed?.assignee).toBe('p2p-fleet');
  });

  it('a title that merely CONTAINS "loop" (not a marker prefix) is NOT excluded', async () => {
    await seedIssue('WI-mentions-loop', { createdTs: 100, title: 'Fix an infinite loop in the retry handler' });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-mentions-loop');
  });

  it('the match is case-insensitive', async () => {
    await seedIssue('WI-loop-marker-lower', { createdTs: 100, title: 'loop wake #7: continue backlog drain' });
    await seedIssue('WI-real-3', { createdTs: 200 });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-real-3');
  });

  it('a row with no title is NOT excluded (NULL-safe)', async () => {
    await seedIssue('WI-no-title', { createdTs: 100, title: null });
    const got = await wi.claimNextWorkItem({ harness: H, assignee: 'bee-1' });
    expect(got?.id).toBe('WI-no-title');
  });
});

describe('diagnoseClaimNextMiss treats a marker-only backlog as DRAINED (EI-8802)', () => {
  it('pendingUnclaimed === 0 and drained === true (idle is correct — NOT pending-but-gated)', async () => {
    await seedIssue('WI-loop-marker-diag', { createdTs: 100, title: 'Loop wake #9: continue backlog drain' });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(0);
    expect(diag.readyUnclaimed).toBe(0);
    expect(diag.drained).toBe(true);
  });

  it('a real ready item alongside a marker counts fully (marker neither shadows nor inflates)', async () => {
    await seedIssue('WI-loop-marker-diag-2', { createdTs: 100, title: 'Loop wake #10: continue backlog drain' });
    await seedIssue('WI-ready-diag-2', { createdTs: 200 });

    const diag = await wi.diagnoseClaimNextMiss({ harness: H, assignee: 'diag' });
    expect(diag.pendingUnclaimed).toBe(1); // ONLY the real item — the marker row is excluded
    expect(diag.readyUnclaimed).toBe(1);
    expect(diag.drained).toBe(false);
  });
});
