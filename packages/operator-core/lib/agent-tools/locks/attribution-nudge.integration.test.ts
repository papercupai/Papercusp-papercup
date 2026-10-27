/**
 * P-010 (code-intel-delivery-and-outcomes-2026-10-26, SPEC-P-010): the edit-time nudge
 * reads the canonical holder column against real Postgres. Before this landed the only
 * edit-time holder read was the TTL lease table work_item_claims, which held 12 live rows
 * fleet-wide while 81 agents held 338 work items, so most edits were unattributed. These
 * cases pin which holds suppress the nudge: a non-terminal item in the same workspace
 * does; a terminal item, another owner's item, or another workspace's item does not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';
import { ATTRIBUTION_NUDGE, readAttributionNudge, type NudgeSql } from './attribution-nudge';

const WS = 'ws-nudge';
let db: FreshPgDb;
let seq = 0;

beforeAll(async () => {
  db = await createFreshPgDb('attribution-nudge');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
}, 120_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.work_items');
});

async function hold(owner: string, status: string, workspace = WS): Promise<void> {
  seq += 1;
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts)
    VALUES ('papercusp', ${`WI-nudge-${seq}`}, 'change', 'nudge fixture', ${status}, ${owner}, ${workspace}, 100, 0)`;
}

const nudgeFor = (ownerId: string) =>
  readAttributionNudge({ sql: db.sql as unknown as NudgeSql, workspaceId: WS, ownerId, timeoutMs: 5_000 });

describe('attribution nudge against real Postgres', () => {
  it('nudges an editor who holds nothing', async () => {
    await expect(nudgeFor('su-empty')).resolves.toBe(ATTRIBUTION_NUDGE);
  });

  it('is suppressed by a held open, wip or blocked item', async () => {
    await hold('su-open', 'open');
    await hold('su-wip', 'wip');
    await hold('su-blocked', 'blocked');
    await expect(nudgeFor('su-open')).resolves.toBeUndefined();
    await expect(nudgeFor('su-wip')).resolves.toBeUndefined();
    await expect(nudgeFor('su-blocked')).resolves.toBeUndefined();
  });

  it('still nudges when the only held items are terminal', async () => {
    await hold('su-closed', 'done');
    await hold('su-closed', 'dropped');
    await expect(nudgeFor('su-closed')).resolves.toBe(ATTRIBUTION_NUDGE);
  });

  it("is not suppressed by another owner's item or another workspace's item", async () => {
    await hold('su-other', 'wip');
    await hold('su-elsewhere', 'wip', 'ws-other');
    await expect(nudgeFor('su-empty')).resolves.toBe(ATTRIBUTION_NUDGE);
    await expect(nudgeFor('su-elsewhere')).resolves.toBe(ATTRIBUTION_NUDGE);
  });
});
