import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPlanItemAnchorMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { writePlanItemAnchors } from './anchor-store';
import { declarationContentHash, unknownAnchor, type PlanItemAnchor } from './anchors';
import { sweepPlanItemAnchors, type PlanAnchorNotice, type PlanAnchorSweepOptions } from './anchor-freshness-sweep';
import { runPlanAnchorFreshnessAction } from '../harness/routines/plan-anchor-freshness-action';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { getMessageById } from '../agent-tools/coordination/messages';
import { runWithWorkspace } from '../workspace-als';
import { seedPlanAnchorFreshnessRoutine } from '../harness/routines/seed-plan-anchor-freshness-routine';
import { PLAN_ANCHOR_FRESHNESS_CRON } from './anchor-freshness-sweep';

const WS = 'anchor-sweep-fixture';
const HARNESS = 'anchor-sweep';
const PLAN = 'freshness-fixture';
const source = 'export function linked() { return 1; }';
let db: FreshPgDb;
let root: string;
let anchor: PlanItemAnchor;
let sent: PlanAnchorNotice[];
const scope = { workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN };

beforeAll(async () => {
  db = await createFreshPgDb('plan-anchor-sweep');
  // The real anchor migration grants these runtime roles; a fresh container has neither.
  await db.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$`);
  await applyPlanItemAnchorMigrationsForTest(db.sql);
  await db.sql.unsafe(`CREATE TABLE harness_shared.plan_items (
    workspace_id text NOT NULL,harness_slug text NOT NULL,plan_slug text NOT NULL,item_id text NOT NULL,status text NOT NULL,
    PRIMARY KEY(workspace_id,harness_slug,plan_slug,item_id))`);
  root = await mkdtemp(join(tmpdir(), 'plan-anchor-sweep-'));
  anchor = { ...unknownAnchor({ symbol: 'linked' }, 'no-snapshot'), symbolId: 'linked-id', symbolName: 'linked',
    path: 'code.ts', line: 1, resolution: 'resolved', unknownReason: null, freshness: 'fresh',
    contentHash: await declarationContentHash(source, { id: 'linked-id', name: 'linked', path: 'code.ts',
      line: 1, column: 17, sha256: '', signature: '', aliases: [], callers: [] }) };
}, 180_000);
beforeEach(async () => {
  sent = [];
  await db.sql`TRUNCATE harness_shared.plan_item_anchors,harness_shared.plan_anchor_notices,harness_shared.plan_items RESTART IDENTITY`;
  await writeFile(join(root, 'code.ts'), source);
});

describe('default freshness notice delivery on the migrated coordination schema', () => {
  let fx: BaselineCoordFixture;
  const privateWs = 'anchor-default-notice-fixture';
  const privatePlan = 'default-notice-fixture';
  const privateScope = { workspaceId: privateWs, harnessSlug: HARNESS, planSlug: privatePlan };
  beforeAll(async () => { fx = await setupBaselineCoordFixture(); }, 180_000);
  afterAll(async () => {
    if (!fx) return;
    try {
      await fx.admin`DELETE FROM harness_shared.coord_event_log WHERE workspace_id=${privateWs}`;
      await fx.admin`DELETE FROM harness_shared.plan_anchor_notices WHERE workspace_id=${privateWs}`;
      await fx.admin`DELETE FROM harness_shared.routines WHERE workspace_id=${privateWs}`;
      await fx.admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id=${privateWs}`;
      await fx.admin`DELETE FROM harness_shared.work_items WHERE workspace_id IN (${privateWs},'anchor-other-workspace')`;
    } finally { await fx.dispose(); }
  });
  it('seeds the declared schedule active by default and preserves an explicit pause on reseed', async () => {
    const previous = process.env.PAPERCUSP_POT_HOME_SLUG;
    process.env.PAPERCUSP_POT_HOME_SLUG = 'anchor-freshness-private-home';
    try {
      await runWithWorkspace(privateWs, seedPlanAnchorFreshnessRoutine);
      const [seeded] = await fx.admin`SELECT active,trigger_kind,trigger_config,target_role
        FROM harness_shared.routines WHERE workspace_id=${privateWs} AND name='plan-anchor-freshness'`;
      expect(seeded).toMatchObject({ active: true, trigger_kind: 'cron',
        trigger_config: { cron: PLAN_ANCHOR_FRESHNESS_CRON, cap: 50 }, target_role: 'system:plan-anchor-freshness' });
      await fx.admin`UPDATE harness_shared.routines SET active=false
        WHERE workspace_id=${privateWs} AND name='plan-anchor-freshness'`;
      await runWithWorkspace(privateWs, seedPlanAnchorFreshnessRoutine);
      const [reseeded] = await fx.admin`SELECT active FROM harness_shared.routines
        WHERE workspace_id=${privateWs} AND name='plan-anchor-freshness'`;
      expect(reseeded!.active).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_POT_HOME_SLUG;
      else process.env.PAPERCUSP_POT_HOME_SLUG = previous;
    }
  });
  it('uses the explicit workspace, finds real open holders, persists one coord message and replays its stable id', async () => {
    await fx.admin`INSERT INTO harness_shared.harness_plans(workspace_id,harness_slug,plan_slug,title,content,content_hash)
      VALUES (${privateWs},${HARNESS},${privatePlan},'Private default notice fixture','',md5(''))`;
    for (const [seq,itemId] of ['P-001','P-002'].entries()) {
      await fx.admin`INSERT INTO harness_shared.plan_items(workspace_id,harness_slug,plan_slug,item_id,seq,status)
        VALUES (${privateWs},${HARNESS},${privatePlan},${itemId},${seq},'todo')`;
      await fx.admin.begin(tx => writePlanItemAnchors(tx, privateScope, { itemId, anchors: [anchor] }, 'fixture'));
    }
    for (const [id,ws,status,holder] of [
      ['WI-900000001',privateWs,'open','holder-open-default'],
      ['WI-900000002',privateWs,'done','holder-closed-default'],
      ['WI-900000003','anchor-other-workspace','open','holder-other-workspace'],
    ]) await fx.admin`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,title,status,taken_by,source_plan_slug,item_kind)
      VALUES (${ws},${HARNESS},${id},'Private holder fixture',${status},${holder},${privatePlan},'feature')`;
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    const input = { ...privateScope, root, sql: fx.admin, budgetMs: 5000 };
    // Deliberately run under a different ambient workspace. The explicit scope
    // must drive both the holder query and the coordination writer/readback.
    const first = await runWithWorkspace('anchor-other-workspace', () => sweepPlanItemAnchors(input));
    expect(first).toMatchObject({ checked: 2, noticesCreated: 1, noticesDelivered: 1 });
    const [notice] = await fx.admin`SELECT id::text,audience,coord_message_id FROM harness_shared.plan_anchor_notices
      WHERE workspace_id=${privateWs} AND plan_slug=${privatePlan}`;
    expect(notice!.audience).toEqual([`@plan:${privatePlan}`,'holder-open-default']);
    const msgId = `plan-anchor-notice:${HARNESS}:${notice!.id}`;
    expect(notice!.coord_message_id).toBe(msgId);
    const message = await runWithWorkspace(privateWs, () => getMessageById(msgId));
    expect(message).toMatchObject({ msg_id: msgId, from: 'system:plan-anchor-freshness',
      plan_slug: privatePlan, to: ['holder-open-default'] });
    // Model the crash window after send but before the outbox acknowledgement.
    await fx.admin`UPDATE harness_shared.plan_anchor_notices SET coord_message_id=NULL
      WHERE workspace_id=${privateWs} AND id::text=${notice!.id}`;
    expect(await runWithWorkspace('anchor-other-workspace', () => sweepPlanItemAnchors(input)))
      .toMatchObject({ noticesCreated: 0, noticesDelivered: 1 });
    expect(await fx.admin`SELECT msg_id FROM harness_shared.coord_event_log
      WHERE workspace_id=${privateWs} AND msg_id=${msgId}`).toHaveLength(1);
  }, 30_000);
});
afterAll(async () => {
  if (db) await db.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});
const options = (extra: Partial<PlanAnchorSweepOptions> = {}): PlanAnchorSweepOptions => ({
  ...scope, root, sql: db.sql, budgetMs: 5000, holders: async () => ['holder-open','holder-open'],
  notify: async notice => { sent.push(notice); return `message:${notice.id}`; }, ...extra,
});
async function seed(itemId: string, status = 'todo', links = [anchor]) {
  await db.sql`INSERT INTO harness_shared.plan_items(workspace_id,harness_slug,plan_slug,item_id,status)
    VALUES (${WS},${HARNESS},${PLAN},${itemId},${status})`;
  await db.sql.begin(tx => writePlanItemAnchors(tx, scope, { itemId, anchors: links }, 'fixture'));
}
async function rows() {
  return db.sql`SELECT item_id,freshness,stale_notice_id,last_check_ok FROM harness_shared.plan_item_anchors ORDER BY item_id`;
}

describe('bounded plan-anchor sweep on real Postgres', () => {
  it('groups newly stale links into one recorded notice, excludes terminal/path links, and deduplicates repeats', async () => {
    await seed('P-001');
    await seed('P-002');
    await seed('P-003', 'done');
    await seed('P-004', 'dropped');
    await seed('P-005', 'todo', [{ ...anchor, anchorKind: 'path' }]);
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    const first = await sweepPlanItemAnchors(options());
    expect(first).toMatchObject({ scanned: 2, checked: 2, noticesCreated: 1, noticesDelivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ planSlug: PLAN, audience: [`@plan:${PLAN}`,'holder-open'] });
    expect(sent[0]!.anchorIds).toHaveLength(2);
    expect(await rows()).toEqual([
      expect.objectContaining({ item_id: 'P-001', freshness: 'stale', last_check_ok: false, stale_notice_id: Number(sent[0]!.id) }),
      expect.objectContaining({ item_id: 'P-002', freshness: 'stale', last_check_ok: false, stale_notice_id: Number(sent[0]!.id) }),
      expect.objectContaining({ item_id: 'P-003', freshness: 'fresh', stale_notice_id: null }),
      expect.objectContaining({ item_id: 'P-004', freshness: 'fresh', stale_notice_id: null }),
      expect.objectContaining({ item_id: 'P-005', freshness: 'fresh', stale_notice_id: null }),
    ]);
    const [record] = await db.sql`SELECT plan_slug,anchor_ids,audience,coord_message_id FROM harness_shared.plan_anchor_notices`;
    expect(record).toEqual({ plan_slug: PLAN, anchor_ids: sent[0]!.anchorIds, audience: sent[0]!.audience,
      coord_message_id: `message:${sent[0]!.id}` });
    expect(await sweepPlanItemAnchors(options())).toMatchObject({ noticesCreated: 0, noticesDelivered: 0 });
    expect(sent).toHaveLength(1);
  });
  it('persists a retryable notice before delivery, then replays it without creating another record', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), 'export const other = 1;');
    await expect(sweepPlanItemAnchors(options({ notify: async () => { throw new Error('delivery unavailable'); } })))
      .rejects.toThrow('delivery unavailable');
    const [before] = await db.sql`SELECT id::text,coord_message_id FROM harness_shared.plan_anchor_notices`;
    expect(before!.coord_message_id).toBeNull();
    expect(await sweepPlanItemAnchors(options())).toMatchObject({ noticesCreated: 0, noticesDelivered: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(before!.id);
    expect(await rows()).toEqual([expect.objectContaining({ freshness: 'missing' })]);
  });
  it('rechecks terminal status after source inspection instead of changing an item closed during the sweep', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    await sweepPlanItemAnchors(options({ holders: async () => {
      await db.sql`UPDATE harness_shared.plan_items SET status='done' WHERE item_id='P-001'`;
      return ['holder-open'];
    } }));
    expect(await rows()).toEqual([expect.objectContaining({ freshness: 'fresh', stale_notice_id: null })]);
    expect(sent).toHaveLength(0);
  });
  it('serializes concurrent passes so one stale set produces one notice and one delivery', async () => {
    await seed('P-001');
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    await Promise.all([sweepPlanItemAnchors(options()),sweepPlanItemAnchors(options())]);
    const records = await db.sql`SELECT id FROM harness_shared.plan_anchor_notices`;
    expect(records).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  it('honors the per-pass cap and leaves unavailable repositories unchanged', async () => {
    await seed('P-001');
    await seed('P-002');
    expect(await sweepPlanItemAnchors(options({ cap: 1, root: join(root, 'unavailable') })))
      .toMatchObject({ scanned: 1, checked: 0, deferred: 1, noticesCreated: 0 });
    expect((await rows()).map(row => row.freshness)).toEqual(['fresh','fresh']);
  });
  it('the workspace routine covers a non-home harness and drains its pending outbox under a shared cap', async () => {
    await seed('P-001');
    await seed('P-002');
    await writeFile(join(root, 'code.ts'), source.replace('return 1', 'return 2'));
    const ctx = { workspaceId: WS, installSlug: 'operator-home', triggerConfig: { cap: 1 }, payloadTemplate: null };
    const deps = { sql: db.sql,
      loadRegistry: (async () => ({ projects: [{ slug: HARNESS, path: root }] })) as
        NonNullable<Parameters<typeof runPlanAnchorFreshnessAction>[1]>['loadRegistry'],
      sweep: (input: PlanAnchorSweepOptions) => sweepPlanItemAnchors({ ...input,
        holders: options().holders, notify: options().notify, budgetMs: 5000 }) };
    expect(await runPlanAnchorFreshnessAction(ctx, deps)).toMatchObject({ diagnostics: {
      scanned: 1, checked: 1, noticesCreated: 1, noticesDelivered: 1, harnesses: [HARNESS], cap: 1 } });
    expect((await rows()).filter(row => row.freshness === 'stale')).toHaveLength(1);
    // Even with no eligible source rows left, retry an already recorded notice.
    await db.sql`UPDATE harness_shared.plan_items SET status='done'`;
    await db.sql`UPDATE harness_shared.plan_anchor_notices SET coord_message_id=NULL`;
    expect(await runPlanAnchorFreshnessAction(ctx, deps)).toMatchObject({ diagnostics: {
      scanned: 0, noticesCreated: 0, noticesDelivered: 1, harnesses: [HARNESS] } });
  });
});
