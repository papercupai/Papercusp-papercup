/** P-004: actual projected plan tools against a private migrated Postgres. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../agent-tools/plans/items';
import '../agent-tools/plans/add-item';
import '../agent-tools/plans/set-item-blocked-by';
import '../agent-tools/plans/set-status';
import '../agent-tools/plans/set-content';
import '../agent-tools/plans/start';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { getPlanRow, listPlanIndexRows } from '../agent-tools/plans/source';
import { deriveIndexFromContent } from '../agent-tools/plans/derive-index';
import { withPlanLock } from '../agent-tools/plans/with-plan-lock';
import { allocateNextItemId, appendItemToBody, buildItemLine } from '../agent-tools/plans/add-item';
import { parsePlan } from '@papercusp/plan-parser';
import { validatePlanCandidateDependencyTransition } from '../agent-tools/plans/plan-candidate-dependencies';
import { promotePlanItems } from '../plan-workitem-promotion-run';
import { cleanupPlans, registerHarnessProject, setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';

const HARNESS = `zzz-graph-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = `${HARNESS}-plan`;
const WS = DEFAULT_WORKSPACE_ID;
let fx: PlanPgFixture;
let admin: postgres.Sql;
const opts = { workspaceId: WS, harnessSlug: HARNESS };
const body = `---\ntitle: graph tools\nslug: ${SLUG}\nstatus: draft\ncreated: 2026-10-28\nupdated: 2026-10-28\n---\n\n# Graph tools\n\nKeep the introduction exactly.\n\n## Phase 1\n\nFree prose before the line.\n- **P-001** \`todo\` prerequisite\nFree prose after the line.\n\n## Decisions\n\n### D-001 — Rationale\nKeep this rationale exactly.\n`;

async function call(name: string, args: Record<string, unknown>) {
  const tool = lookupByMcpName(name);
  expect(tool, name).toBeTruthy();
  const ctx = { workspaceId: WS, harnessSlug: HARNESS, runId: 'plan-graph-tools', role: 'su',
    uiClientId: 'su-plan-graph-tools', principal: { kind: 'agent', slug: 'su-plan-graph-tools', workspaceId: WS },
    gateBypass: { role: true, capability: true, quota: true }, transport: 'mcp',
    requestedFormat: 'json', requestedStructured: true };
  const d = await runWithWorkspace(WS, () => dispatchProjectedTool(tool!, name, { harness: HARNESS, ...args }, ctx as never, {}));
  expect('result' in d, JSON.stringify(d)).toBe(true);
  const result = d.result as { structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> };
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}
async function nodes() {
  return admin<{ feature_id: string; plan_line_id: string; status: string; plan_line_text: string }[]>`
    SELECT feature_id, plan_line_id, status, plan_line_text FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
     ORDER BY plan_seq`;
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  const created = await withPlanLock(null, { ...opts, slug: SLUG, intent: 'P-004 fixture creation' },
    async () => ({ newBody: body, value: { ok: true } }));
  expect(created.kind).toBe('applied');
}, 120_000);
afterAll(async () => {
  if (!admin) return;
  await cleanupPlans(admin, WS, HARNESS);
  await fx.dispose();
});

describe('six plan tools use graph nodes', () => {
  it('creates nodes on the ordinary write path, adds freely and writes dependencies including terminal blockers', async () => {
    const initial = await nodes();
    expect(initial.map((n) => n.plan_line_id)).toEqual(['P-001']);
    const pre = await getPlanRow(SLUG, opts);
    const candidate = appendItemToBody(pre!.content, 'Phase 1', buildItemLine(allocateNextItemId(pre!.content), 'dependent', ['P-001'], 'normal')).newBody;
    const verdict = validatePlanCandidateDependencyTransition(parsePlan(pre!.content), parsePlan(candidate), null);
    expect(verdict.state, JSON.stringify({ verdict, before: pre!.content, candidate })).toBe('valid');
    const add = await call('plans:add-item', { slug: SLUG, phase: 'Phase 1', text: 'dependent', importance: 'normal', blockedBy: ['P-001'] });
    expect(add.ok, JSON.stringify(add)).toBe(true);
    expect((await nodes()).map((n) => n.plan_line_id)).toEqual(['P-001', 'P-002']);
    const row = await getPlanRow(SLUG, opts);
    expect(row!.items.find((i) => i.id === 'P-002')?.blockedBy).toEqual(['P-001']);
    const changed = await call('plans:set-item-blocked-by', { slug: SLUG, item: 'P-002', blockedBy: [] });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    // A work-item lifecycle write must be reflected even while the stored body remains stale.
    await admin`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS}
      AND harness_slug = ${HARNESS} AND feature_id = ${initial[0].feature_id}`;
    const terminalEdge = await call('plans:set-item-blocked-by', { slug: SLUG, item: 'P-002', blockedBy: ['P-001'] });
    expect(terminalEdge.ok, JSON.stringify(terminalEdge)).toBe(true);
    expect((await getPlanRow(SLUG, opts))!.items[1].blockedBy).toEqual(['P-001']);
    const [edge] = await admin<{ satisfaction: string }[]>`SELECT satisfaction FROM harness_shared.work_item_deps
      WHERE blocker_ref = ${`${HARNESS}#${initial[0].feature_id}`} AND dep_type = 'blocks'`;
    expect(edge?.satisfaction).toBe('settled');
  });

  it('items and rendered markdown ignore stale body/index data; set-status writes the same node', async () => {
    const before = await nodes();
    await admin`UPDATE harness_shared.work_items SET plan_line_text = 'GRAPH AUTHORITATIVE' WHERE workspace_id = ${WS}
      AND harness_slug = ${HARNESS} AND feature_id = ${before[1].feature_id}`;
    await admin`UPDATE harness_shared.harness_plans SET items = '[]'::jsonb WHERE workspace_id = ${WS}
      AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const result = await call('plans:items', { slug: SLUG });
    expect(JSON.stringify(result)).toContain('GRAPH AUTHORITATIVE');
    const list = await listPlanIndexRows(opts);
    expect(list.find((p) => p.planSlug === SLUG)?.items[1].text).toBe('GRAPH AUTHORITATIVE');
    const row = await getPlanRow(SLUG, opts);
    expect(deriveIndexFromContent(row!.content).items[1].text).toBe('GRAPH AUTHORITATIVE');
    for (const prose of ['Keep the introduction exactly.', 'Free prose before the line.', 'Free prose after the line.', 'Keep this rationale exactly.']) expect(row!.content).toContain(prose);
    const status = await call('plans:set-status', { slug: SLUG, item: 'P-002', status: 'dropped', note: 'fixture removal' });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    const after = await nodes();
    expect(after[1].feature_id).toBe(before[1].feature_id);
    expect(after[1].status).toBe('dropped');
  });

  it('set-content writes node fields, retains identities and can remove lines without deleting work', async () => {
    const before = await nodes();
    const row = await getPlanRow(SLUG, opts);
    const edit = await call('plans:set-content', { slug: SLUG, content: row!.content.replace('GRAPH AUTHORITATIVE', 'edited through content'), expectedVersion: row!.version });
    expect(edit.ok, JSON.stringify(edit)).toBe(true);
    expect((await nodes())[1]).toMatchObject({ feature_id: before[1].feature_id, plan_line_text: expect.stringContaining('edited through content') });
    const current = await getPlanRow(SLUG, opts);
    const removed = await call('plans:set-content', { slug: SLUG, content: current!.content.split('\n').filter((l) => !l.startsWith('- **P-002**')).join('\n'), allowShrink: true, expectedVersion: current!.version });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect((await nodes()).map((n) => n.plan_line_id)).toEqual(['P-001']);
    const [retained] = await admin<{ plan_line_id: string | null }[]>`SELECT plan_line_id FROM harness_shared.work_items
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = ${before[1].feature_id}`;
    expect(retained.plan_line_id).toBeNull();
  });

  it('start validates the graph instead of stale body blockers before promotion', async () => {
    const added = await call('plans:add-item', { slug: SLUG, phase: 'Phase 1', text: 'second', importance: 'normal' });
    expect(added.ok, JSON.stringify(added)).toBe(true);
    const n = await nodes();
    // Seed corrupt graph edges to distinguish graph admission from parsing the clean body.
    for (const [blocked, blocker] of [[n[0], n[1]], [n[1], n[0]]]) await admin`
      INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction)
      VALUES ('default', 'feature', ${`${HARNESS}#${blocked.feature_id}`}, 'feature', ${`${HARNESS}#${blocker.feature_id}`}, 'blocks', 'settled')`;
    const result = await call('plans:start', { slug: SLUG, consulted: false, consult_reason: 'isolated graph admission regression' });
    expect(JSON.stringify(result)).toContain('invalid_plan_dependencies');
    expect((await nodes()).map((x) => x.feature_id)).toEqual(n.map((x) => x.feature_id));
  });

  it('the start promotion path reuses graph identities even without legacy implements stamps', async () => {
    // Represent a pre-epoch active plan with an already established graph. Its
    // unrelated acceptance authoring gates are outside this identity regression.
    await admin`DELETE FROM harness_shared.work_item_deps WHERE blocked_ref LIKE ${`${HARNESS}#%`}`;
    const row = await getPlanRow(SLUG, opts);
    const written = await withPlanLock(null, { ...opts, slug: SLUG, intent: 'legacy promotion identity fixture' },
      async () => ({ newBody: row!.content.replace('created: 2026-10-28', 'created: 2026-01-01'), value: { ok: true } }));
    expect(written.kind).toBe('applied');
    await admin`UPDATE harness_shared.harness_plans SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const before = await nodes();
    for (let i = 0; i < 2; i++) {
      const result = await runWithWorkspace(WS, () => promotePlanItems({ workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG, createdBy: 'su-plan-graph-tools' }));
      expect(result.promoted, JSON.stringify(result)).toBe(0);
      expect(result.workItems?.map((x) => x.workItemId), JSON.stringify(result)).toEqual(before.filter((n) => n.status === 'open').map((n) => n.feature_id));
      const all = await admin<{ feature_id: string }[]>`SELECT feature_id FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
      // Removed P-002 remains historical work, but promotion adds no rows.
      expect(all).toHaveLength(3);
    }
  });
});
