/**
 * R-11 — Freedom preserved (plan one-work-graph-structured-holds-2026-10-26; bar on P-010).
 *
 * An agent can add plan lines, work-items and blockers to an ACTIVE plan without owner
 * approval. As an agent, this suite adds a plan line, a child work-item under that line's
 * node and a blocker on the child, and asserts each write lands immediately and leaves no
 * approval record behind.
 *
 * Falsifier: adding a plan line, a work-item or a blocker to an active plan as an agent is
 * refused, parked or queued for owner approval.
 *
 * Every write goes through the real projected dispatch against a private, fully migrated
 * database (setupPlanPgFixture({ isolated: true })) — no module mocks. The line's node is
 * minted by harness_shared.convert_plan_lines_to_nodes (migration 1601, P-003), the same
 * function the plan-line writers call; a new open node carries the D-011 self-selection
 * park, which is a transition park keyed to P-008 and not an approval step, so the suite
 * pins that the park is that one and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../agent-tools/plans/add-item';
import '../agent-tools/work_items/create';
import '../agent-tools/work_items/set_blocker';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import {
  cleanupPlans,
  seedPlan,
  setupPlanPgFixture,
  type PlanPgFixture,
} from '../agent-tools/plans/__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-r11-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const SLUG = `zzz-r11-plan-${RUN}`;
const AGENT = 'su-r11-agent';

/** The D-011 transition park on a new open line node — the only park this suite allows. */
const LINE_NODE_PARK = 'migration:plan-line-work-item-nodes';

/** Every table an approval, owner ask or review queue would leave a row in. */
const APPROVAL_TABLES = [
  'harness_shared.sensitive_action_requests',
  'harness_shared.sensitive_action_approvals',
  'harness_shared.agent_loop_approvals',
  'harness_shared.pending_reviews',
  'harness_shared.session_pending_gates',
  'harness_shared.harness_escalations',
] as const;

const planBody = (slug: string) => `---
title: ${slug}
slug: ${slug}
status: active
created: 2026-10-28
updated: 2026-10-28
---

# ${slug}

## Now

**State:** test
**Next:** test

## Phase 1

- **P-001** \`done\` seed item

## Decisions

### D-001 — seed decision
Date: 2026-10-28
seed body
`;

let fx: PlanPgFixture;
let admin: postgres.Sql;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plan-graph-r11',
    role: 'su',
    uiClientId: AGENT,
    principal: { kind: 'agent', slug: AGENT, workspaceId: WS },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  // A live MCP request runs inside the request-workspace scope the HTTP layer opens, and
  // the stores stamp workspace_id from activeWorkspaceId(), not from ctx. Without the
  // scope a row lands in whatever workspace this process's registry selects.
  const d = await runWithWorkspace(WS, () =>
    dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {}),
  );
  const result = d.result as { structuredContent?: unknown; content?: Array<{ text?: string }>; isError?: boolean };
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, text };
  }
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 1200);
}

async function approvalRowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of APPROVAL_TABLES) {
    const [present] = await admin<{ ok: boolean }[]>`SELECT to_regclass(${table}) IS NOT NULL AS ok`;
    if (!present?.ok) continue;
    const [row] = await admin.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

async function planStatus(): Promise<string | undefined> {
  const [row] = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return row?.content.match(/^status:\s*(\S+)/m)?.[1];
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await seedPlan(admin, WS, HARNESS, SLUG, planBody(SLUG));
}, 120_000);

afterAll(async () => {
  if (!admin) return;
  await admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(
    () => {},
  );
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx.dispose();
});

describe('R-11: an agent adds to an active plan without owner approval', () => {
  it('adds a plan line, a child work-item and a blocker; each lands immediately with no approval record', async () => {
    const before = await approvalRowCounts();
    expect(Object.keys(before).length, 'the migrated DB must carry the approval tables').toBeGreaterThan(0);
    expect(await planStatus()).toBe('active');

    // 1. A plan line.
    const added = await call('plans:add-item', {
      slug: SLUG,
      phase: 'Phase 1',
      text: 'agent-added line',
      importance: 'normal',
    });
    expect(added.ok, brief(added)).toBe(true);
    const lineId = (added.results as Array<{ itemId?: string }> | undefined)?.[0]?.itemId;
    expect(lineId, brief(added)).toMatch(/^P-\d{3,}$/);

    const [indexed] = await admin<{ status: string }[]>`
      SELECT status FROM harness_shared.plan_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG} AND item_id = ${lineId!}`;
    expect(indexed?.status, 'the line is indexed at once, as ordinary todo work').toBe('todo');
    expect(await planStatus(), 'the plan stays active').toBe('active');

    await admin`SELECT harness_shared.convert_plan_lines_to_nodes(${WS})`;
    const [node] = await admin<{ feature_id: string; status: string; payload: Record<string, unknown> }[]>`
      SELECT feature_id, status, payload FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG} AND plan_line_id = ${lineId!}`;
    expect(node, 'the line has its work-item node').toBeTruthy();
    expect(node!.status).toBe('open');
    if (node!.payload._claimHold) {
      expect(node!.payload.claim_hold_by, 'the only park on a new line node is the D-011 transition park').toBe(
        LINE_NODE_PARK,
      );
    }

    // 2. A child work-item under the line's node.
    const created = await call('work_items:create', {
      kind: 'task',
      title: 'agent-added child of the new line',
      parent: node!.feature_id,
    });
    expect(created.ok, brief(created)).not.toBe(false);
    const childId = (created.results as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(childId, brief(created)).toMatch(/^[A-Z]+-\d+$/);
    const [child] = await admin<{ feature_id: string; status: string; parent_id: string | null; harness_slug: string; payload: Record<string, unknown> }[]>`
      SELECT feature_id, status, parent_id, harness_slug, payload FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${childId!}`;
    expect(child, `the child lands at once: ${brief(created)}`).toBeTruthy();
    expect(child!.parent_id, `the child hangs under the line's node: ${brief(child)}`).toBe(node!.feature_id);
    expect(child!.status, 'the child is ordinary open work, not parked for a human').toBe('open');
    expect(child!.payload._claimHold ?? false).toBe(false);

    // 3. A blocker on the child. The wait ref must be provable (set_blocker refuses an
    // uncatalogued key), so the child waits on a catalogued completion key of an upstream
    // item the agent also files — that create is itself another unapproved write.
    const upstream = await call('work_items:create', { kind: 'task', title: 'agent-added upstream build step' });
    const upstreamId = (upstream.results as Array<{ id?: string }> | undefined)?.[0]?.id;
    expect(upstreamId, brief(upstream)).toMatch(/^[A-Z]+-\d+$/);
    const waitRef = `work-item:done:${upstreamId}`;
    const blocked = await call('work_items:set_blocker', {
      id: child!.feature_id,
      kind: 'event',
      ref: waitRef,
      summary: 'Waits on the upstream build step to finish.',
    });
    expect(blocked.ok, brief(blocked)).not.toBe(false);
    // A ref that names only a work-item is stored as a `blocks` edge in the single
    // dependency store (D-009 R-1), not as an external row: set_blocker reports it as
    // convertedToEdge, and the edge is readable at once.
    const converted = (blocked.results as Array<{ convertedToEdge?: { rel?: string; blockers?: string[] } }> | undefined)?.[0]
      ?.convertedToEdge;
    expect(converted?.rel, `set_blocker records the work-item wait as an edge: ${brief(blocked)}`).toBe('blocks');
    expect(converted?.blockers ?? []).toContain(upstreamId);
    const edges = await admin<{ dep_type: string }[]>`
      SELECT dep_type FROM harness_shared.work_item_deps
       WHERE blocked_ref = ${child!.feature_id} AND blocker_ref = ${upstreamId!}`;
    expect(
      edges.map((e) => e.dep_type),
      `the blocker is stored as a blocks edge at once: ${brief(edges)}`,
    ).toContain('blocks');
    const [afterBlock] = await admin<{ status: string }[]>`
      SELECT status FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${child!.feature_id}`;
    expect(afterBlock!.status, 'a dependency blocker never routes the item to a human').not.toBe('needs-human');

    // No step asked anyone for approval.
    expect(await approvalRowCounts()).toEqual(before);
    expect(await planStatus()).toBe('active');
  }, 120_000);
});
