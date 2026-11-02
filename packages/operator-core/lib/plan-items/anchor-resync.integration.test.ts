import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import editTool from '../agent-tools/plans/edit';
import { deriveIndexFromContent } from '../agent-tools/plans/derive-index';
import { writePlanLineNodes, readPlanLineNodes } from '../agent-tools/plans/plan-line-graph';
import { writePlanIndexRows } from '../agent-tools/plans/plan-index-rows';
import { runWithWorkspace } from '../workspace-als';
import * as drift from './text-drift-report';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('./anchors', async importOriginal => {
  const actual = await importOriginal<typeof import('./anchors')>();
  return { ...actual, resolveHarnessAnchors: async (_workspace: string, _harness: string,
    inputs: import('./anchors').AnchorInput[]) => actual.resolvePlanItemAnchors(inputs,
    { root: fixture.root, snapshot: null, budgetMs: 5000 }) };
});

const HARNESS = 'zzz-anchor-resync';
const PLAN = 'anchor-resync-fixture';
let fx: PlanPgFixture;
const ctx = () => ({ signal: new AbortController().signal, role: 'su', workspaceId: fx.workspaceId,
  log: () => {}, progress: () => {}, metadata: () => {},
  principal: { kind: 'agent', slug: 'anchor-resync-editor', workspaceId: fx.workspaceId } }) as never;
function data(result: unknown): any {
  const envelope = result as { data?: unknown; content?: { type: string; text?: string }[] };
  if (envelope.data !== undefined) return envelope.data;
  const text = envelope.content?.find(item => item.type === 'text' && item.text?.startsWith('{'))?.text;
  if (!text) throw new Error('No JSON tool result');
  return JSON.parse(text);
}
const edit = (itemId: string, paths: string[]) => runWithWorkspace(fx.workspaceId,
  () => editTool.handler({ slug: PLAN, harness: HARNESS,
    itemId, anchors: paths.map(path => ({ path })) } as never, ctx()).then(data));
const plan = `---\ntitle: Anchor resync\nslug: ${PLAN}\nstatus: active\ncreated: 2026-11-02\nupdated: 2026-11-02\n---
# Anchor resync

## Now

**State:** Integration fixture.

**Next:** Edit code links.

## Phase 1 — Work

- **P-001** \`todo\` First item
- **P-002** \`todo\` Second item

## Decisions
`;
async function seed(id: string, options: { stamp?: boolean; ids?: string[]; holder?: string; status?: string;
  workspace?: string } = {}) {
  const payload = { paths: ['old.ts'], anchors: [{ requested: 'old' }], preserve: 'kept',
    ...(options.stamp ? { plan_item: { plan_slug: PLAN, item_id: 'P-001' } } : {}) };
  await fx.admin`INSERT INTO harness_shared.work_items
    (workspace_id,harness_slug,feature_id,title,status,item_kind,taken_by,payload,source_plan_slug,source_plan_item_ids)
    VALUES (${options.workspace ?? fx.workspaceId},${HARNESS},${id},'Fixture',${options.status ?? 'open'},'feature',
      ${options.holder ?? null},${JSON.stringify(payload)}::text::jsonb,
      ${options.ids ? PLAN : null},${options.ids ?? []}::text[])`;
}
async function payload(id: string) {
  const [row] = await fx.admin`SELECT payload FROM harness_shared.work_items WHERE feature_id=${id}`;
  return row.payload;
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  fixture.root = await mkdtemp(join(tmpdir(), 'anchor-resync-'));
  await writeFile(join(fixture.root, 'new.ts'), 'export const changed = true;');
  await writeFile(join(fixture.root, 'other.ts'), 'export const other = true;');
}, 180_000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await fx.admin`DELETE FROM harness_shared.coord_event_log WHERE body->>'plan_slug'=${PLAN}`;
  await fx.admin`DELETE FROM harness_shared.plan_item_anchors
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${PLAN}`;
  await fx.admin`DELETE FROM harness_shared.work_items WHERE harness_slug=${HARNESS}`;
  await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, PLAN, plan);
  // Current plan writers render the canonical work-graph line nodes. A raw
  // harness_plans row alone is intentionally graphless and loses its item lines.
  const scope = { workspaceId: fx.workspaceId, harnessSlug: HARNESS, slug: PLAN };
  const index = deriveIndexFromContent(plan);
  await fx.admin.begin(async tx => {
    await writePlanLineNodes(tx as never, scope, [], index.items);
    await writePlanIndexRows(tx as unknown as Parameters<typeof writePlanIndexRows>[0], { ...scope, planSlug: PLAN }, index);
  });
  expect((await readPlanLineNodes(fx.admin, scope)).map(item => item.id)).toEqual(['P-001', 'P-002']);
  expect(await fx.admin`SELECT id FROM harness_shared.plan_item_anchors
    WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${PLAN}`).toHaveLength(0);
});
afterAll(async () => {
  if (fx) {
    await fx.admin`DELETE FROM harness_shared.coord_event_log WHERE body->>'plan_slug'=${PLAN}`;
    await fx.admin`DELETE FROM harness_shared.plan_item_anchors
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${PLAN}`;
    await fx.admin`DELETE FROM harness_shared.work_items WHERE harness_slug=${HARNESS}`;
    await cleanupPlans(fx.admin, fx.workspaceId, HARNESS);
    await fx.dispose();
  }
  if (fixture.root) await rm(fixture.root, { recursive: true, force: true });
});

describe('P007 anchor resync through plans:edit on real migrated PostgreSQL', () => {
  it('P007-links: refreshes payload and source-id links, unions grouped items, preserves unrelated payload, and leaves closed/other-scope rows alone', async () => {
    expect((await edit('P-002', ['other.ts'])).ok).toBe(true);
    await seed('WI-900000201', { stamp: true });
    await seed('WI-900000202', { ids: ['P-001'] });
    await seed('WI-900000203', { stamp: true, ids: ['P-001', 'P-002'] });
    await seed('WI-900000204', { stamp: true, status: 'done' });
    await seed('WI-900000205', { ids: ['P-001'], status: 'dropped' });
    await seed('WI-900000206', { stamp: true, workspace: 'anchor-other-scope' });
    const result = await edit('P-001', ['new.ts']);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // The canonical graph node for P-001 is also an open linked work item.
    expect(result.planItemAnchorResync.affected).toHaveLength(4);
    expect(result.planItemAnchorResync.affected.filter((item: any) => item.workItemId === 'WI-900000203')).toHaveLength(1);
    const [node] = await fx.admin`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${PLAN} AND plan_line_id='P-001'`;
    expect((await payload(node.feature_id)).paths).toEqual(['new.ts']);
    for (const id of ['WI-900000201', 'WI-900000202']) {
      expect(await payload(id)).toMatchObject({ paths: ['new.ts'], preserve: 'kept',
        anchors: [{ requested: 'new.ts', path: 'new.ts', resolution: 'resolved' }] });
    }
    expect((await payload('WI-900000203')).paths).toEqual(['new.ts', 'other.ts']);
    expect((await payload('WI-900000203')).anchors.map((anchor: any) => anchor.path)).toEqual(['new.ts', 'other.ts']);
    for (const id of ['WI-900000204', 'WI-900000205', 'WI-900000206']) {
      expect(await payload(id)).toMatchObject({ paths: ['old.ts'], anchors: [{ requested: 'old' }] });
    }
  });

  it('P007-notify: sends a dual-linked holder exactly one persisted notice naming the plan item and files, and sends none for unclaimed work', async () => {
    await seed('WI-900000211', { stamp: true, ids: ['P-001'], holder: 'anchor-resync-holder' });
    await seed('WI-900000212', { stamp: true });
    const result = await edit('P-001', ['new.ts']);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.planItemAnchorResync.notified).toBe(1);
    const messages = await fx.admin`SELECT body->>'summary' AS summary,body->>'body' AS body,body->'to' AS recipients
      FROM harness_shared.coord_event_log WHERE workspace_id=${fx.workspaceId} AND surface='messages'
        AND body->>'plan_slug'=${PLAN} AND body->>'kind'='message' AND body->>'notify_kind' IS NULL`;
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain('anchor-resync-holder');
    expect(messages[0].summary).toContain(`${PLAN}#P-001`);
    expect(messages[0].body).toContain('new.ts');
    expect(messages[0].body).toContain('old.ts');
  });

  it('P007-clear: removing the last links clears stale paths and anchors', async () => {
    await seed('WI-900000221', { ids: ['P-001'] });
    expect((await edit('P-001', ['new.ts'])).ok).toBe(true);
    expect((await edit('P-001', [])).ok).toBe(true);
    expect(await payload('WI-900000221')).toMatchObject({ paths: [], anchors: [], preserve: 'kept' });
  });

  it('P007-atomic: a resync failure rolls back the anchor edit and sends no notice', async () => {
    await seed('WI-900000231', { stamp: true, holder: 'anchor-resync-holder' });
    const resync = vi.spyOn(drift, 'resyncPlanItemAnchors').mockRejectedValueOnce(new Error('fixture resync failure'));
    await expect(edit('P-001', ['new.ts'])).rejects.toThrow('fixture resync failure');
    expect(resync).toHaveBeenCalledOnce();
    expect((await payload('WI-900000231')).paths).toEqual(['old.ts']);
    const links = await fx.admin`SELECT id FROM harness_shared.plan_item_anchors
      WHERE workspace_id=${fx.workspaceId} AND harness_slug=${HARNESS} AND plan_slug=${PLAN}`;
    expect(links).toHaveLength(0);
    expect(await fx.admin`SELECT msg_id FROM harness_shared.coord_event_log WHERE body->>'plan_slug'=${PLAN}`).toHaveLength(0);
  });
});
