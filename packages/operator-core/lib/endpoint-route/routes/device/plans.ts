/**
 * Device plans routes — mobile-apps-revival-redesign-2026-06-05 (D-002).
 *
 *   GET  /device/plans                              device JWT
 *   GET  /device/plans/:slug                        device JWT
 *   POST /device/plans/:slug/items/:itemId/status   device JWT
 *
 * The phone's Plans tab browses the PG-canonical plans
 * (harness_shared.harness_plans) and acts on items (approve = a status
 * flip to `done`; nudge = a flip to `wip`; gate = `needs-human`). All
 * over the SAME source the desktop + TUI read, scoped to the device's
 * workspace, with an optional pot (harness) filter for the header's
 * "All Pots" switcher (D-003).
 *
 * Reads call the plans source layer directly; the item write dispatches
 * the `plans:set-status` tool in-process so it reuses the proven path
 * (PG advisory lock → surgical flip → plan-revision capture → plan-event
 * emit → needs-human push), rather than re-implementing the RMW.
 */
import { z } from 'zod';
import {
  defineTool,
  dispatchProjectedTool,
  lookupByMcpName,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import '../../../agent-tools/index';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import {
  listPlanIndexRows,
  listPlanIndexRowsForWorkspace,
  readPlanBySlug,
  type PlanIndexRow,
} from '../../../agent-tools/plans/source';
import { harnessExistsInWorkspace } from '../../../device-harnesses';
import {
  resolveEffectiveStatusForItems,
  type PlanItem,
} from '../../../agent-tools/plans/effective-status';
import {
  applyPlanItemBlocks,
  getAllBlockedPlanItems,
  overlayIssueBlocksForPlan,
  planItemRef,
} from '../../../issue-blocks-merge';

/**
 * Compact per-status item tally for a plan card, over EFFECTIVE status: the
 * dependency resolver plus the open issue-block overlay, as plans:list counts
 * it. The structured index carries only the authored status, so counting it
 * showed a dependency-blocked item as `todo` on the phone.
 */
function itemCounts(row: PlanIndexRow, blocked: Map<string, string[]>): Record<string, number> {
  const planItems: PlanItem[] = row.items.map((i) => ({
    id: i.id,
    text: i.text,
    storedStatus: i.status as PlanItem['storedStatus'],
    importance: i.importance as PlanItem['importance'],
    blockedBy: i.blockedBy ?? [],
    decisionRefs: i.decisionRefs ?? [],
    phase: i.phase ?? null,
    lineNumber: 0,
    rawLine: '',
  }));
  const { items } = applyPlanItemBlocks(resolveEffectiveStatusForItems(planItems).items, (id) =>
    blocked.get(planItemRef(row.planSlug, id)),
  );
  const counts: Record<string, number> = {};
  for (const it of items) counts[it.effectiveStatus] = (counts[it.effectiveStatus] ?? 0) + 1;
  return counts;
}

function planSummary(row: PlanIndexRow, blocked: Map<string, string[]>) {
  return {
    slug: row.planSlug,
    harness: row.harnessSlug,
    title: row.title ?? row.planSlug,
    status: row.status,
    updated: row.updated ?? row.updatedAt,
    owner: row.owner,
    archived: row.archived,
    itemCounts: itemCounts(row, blocked),
    nowState: row.nowState,
    nowNext: row.nowNext,
  };
}

/**
 * GET /device/plans?harness=<slug>&includeArchived= — plan summaries.
 * Omitted harness (or `all`) reads the workspace's canonical plan index
 * once. Member pots share Hive plans, so per-pot full-content reads repeat
 * the same plans and can exceed the mobile request deadline.
 */
const plansList = defineTool({
  method: 'GET',
  path: '/device/plans',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness');
    const includeArchived = url.searchParams.get('includeArchived') === 'true';

    // Preserve the existing list's instance plans and Now text, without
    // loading the full Markdown blobs the summary does not consume.
    const options = { includeArchived, includeInstances: true, heavyFields: true };
    let all: PlanIndexRow[];
    if (harness && harness !== 'all' && harness !== '*') {
      if (!(await harnessExistsInWorkspace(principal.workspaceId, harness))) {
        return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
      }
      all = await listPlanIndexRows({
        ...options,
        workspaceId: principal.workspaceId,
        harnessSlug: harness,
      });
    } else {
      all = await listPlanIndexRowsForWorkspace({
        ...options,
        workspaceId: principal.workspaceId,
      });
    }
    // Most-recently-updated first.
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    // The open issue-block overlay is workspace-wide: read it once for every card.
    // Non-fatal, as in plans:list: on error the counts fall back to resolver-only.
    let blocked = new Map<string, string[]>();
    try {
      blocked = await getAllBlockedPlanItems();
    } catch {
      /* resolver-only counts */
    }
    return Response.json({ plans: all.map((row) => planSummary(row, blocked)) });
  },
});

/**
 * GET /device/plans/:slug?harness=<slug> — one plan's full parsed
 * structure (frontmatter + Now + items + decisions) for the detail view.
 */
const planGet = defineTool({
  method: 'GET',
  path: '/device/plans/:slug',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const requestedHarness = new URL(req.url).searchParams.get('harness');
    const harness = requestedHarness && requestedHarness !== 'all' && requestedHarness !== '*'
      ? requestedHarness : undefined;
    if (harness && !(await harnessExistsInWorkspace(principal.workspaceId, harness))) {
      return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
    }
    // Authentication identifies the phone, but source scope must also be pinned:
    // an unpinned harness resolves across the registry, outside this pairing.
    const found = await readPlanBySlug(ctx.params.slug, {
      workspaceId: principal.workspaceId,
      harnessSlug: harness,
    });
    if (!found) return Response.json({ error: 'plan_not_found' }, { status: 404 });
    const { parsed, archived, row } = found;
    // Items carry the EFFECTIVE status plans:get returns (dependency resolver, then
    // open issue blocks). parsePlan alone yields only the authored `storedStatus`,
    // and the iOS client reads `effectiveStatus ?? status`, so without this it
    // rendered every item as `todo`. overlayIssueBlocksForPlan is non-fatal.
    const { items, blockingIssues } = await overlayIssueBlocksForPlan(
      row.planSlug,
      resolveEffectiveStatusForItems(parsed.items).items,
    );
    return Response.json({
      slug: row.planSlug,
      harness: row.harnessSlug,
      archived,
      title: row.title ?? row.planSlug,
      status: row.status,
      owner: row.owner,
      frontmatter: parsed.frontmatter,
      now: parsed.now,
      items: items.map((it) =>
        blockingIssues[it.id] ? { ...it, blockedByIssues: blockingIssues[it.id] } : it,
      ),
      decisions: parsed.decisions,
    });
  },
});

/**
 * POST /device/plans/:slug/items/:itemId/status — flip a plan item's
 * status from the phone (approve→done, nudge→wip, gate→needs-human, …).
 * Dispatches plans:set-status in-process for the full locked RMW path.
 */
const planItemSetStatus = defineTool({
  method: 'POST',
  path: '/device/plans/:slug/items/:itemId/status',
  auth: DEVICE_AUTH,
  cors: true,
  input: z.object({
    status: z.string().min(1),
    note: z.string().max(400).optional(),
    harness: z.string().min(1).optional(),
  }),
  async handler(_req, ctx) {
    const principal = devicePrincipal(ctx);
    const tool = lookupByMcpName('plans:set-status');
    if (!tool) return Response.json({ error: 'plans:set-status not registered' }, { status: 500 });

    const toolCtx: UnifiedToolContext = {
      log: () => {},
      signal: ctx.signal,
      progress: () => {},
      emit: () => {},
      workspaceId: principal.workspaceId,
      role: 'operator',
      runId: globalThis.crypto.randomUUID(),
      spawnId: globalThis.crypto.randomUUID(),
      transport: 'in_process',
      uiClientId: null,
    };

    const dispatched = await dispatchProjectedTool(
      tool,
      'plans:set-status',
      {
        slug: ctx.params.slug,
        item: ctx.params.itemId,
        status: ctx.input.status,
        ...(ctx.input.note ? { note: ctx.input.note } : {}),
        ...(ctx.input.harness ? { harness: ctx.input.harness } : {}),
      },
      toolCtx,
      {},
    );

    if (!dispatched.ok) {
      return Response.json(
        { error: dispatched.error?.code ?? 'dispatch_failed', message: dispatched.error?.message },
        { status: 400 },
      );
    }
    let parsed: unknown = {};
    try {
      parsed = JSON.parse((dispatched.result?.content[0] as { text?: string })?.text ?? '{}');
    } catch {
      /* leave as {} */
    }
    return Response.json(parsed, { status: dispatched.result?.isError ? 400 : 200 });
  },
});

export default [plansList, planGet, planItemSetStatus];
