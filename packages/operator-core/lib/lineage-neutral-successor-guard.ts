/**
 * Eligibility guard for the one lineage-neutral successor path: recovering the
 * original author of a frozen-tests binding without making the recovering
 * caller an ancestor of that author.
 *
 * The work-item manifest is the anchor. The immutable evidence row supplies
 * its author, and audit-only includeRetracted reads are required because a
 * withdrawn binding may still be the manifest's re-freeze anchor.
 */
import { withWorkspace } from '@papercusp/db-org';
import { listSpecEvidence } from './agent-tools/plans/spec-evidence-store';
import { readPlanBySlug } from './agent-tools/plans/source';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { getWorkItem, type WorkItem } from './work-items';
import { z } from 'zod';

const manifestSchema = z.object({
  revision: z.number().int().positive(),
  bindingId: z.number().int().positive(),
  planSlug: z.string().min(1),
  redRunIds: z.array(z.number().int().positive()).min(1).max(32),
  frozenAt: z.string().datetime(),
  decisionId: z.string().optional(),
}).strict();

export type LineageNeutralSuccessorRefusal = {
  code:
    | 'source-work-item-required'
    | 'source-work-item-unavailable'
    | 'source-work-item-terminal'
    | 'frozen-tests-manifest-required'
    | 'frozen-tests-plan-not-opted-in'
    | 'frozen-tests-binding-unavailable'
    | 'frozen-tests-author-mismatch';
  message: string;
  bindingId?: number;
};

export interface LineageNeutralSuccessorEligibilityDeps {
  workItem(input: { workItemId: string; harnessSlug: string; workspaceId: string }): Promise<WorkItem | null>;
  plan(slug: string, scope: { workspaceId: string; harnessSlug: string }): ReturnType<typeof readPlanBySlug>;
  evidence: typeof listSpecEvidence;
}

const defaultDeps: LineageNeutralSuccessorEligibilityDeps = {
  workItem: ({ workItemId, harnessSlug, workspaceId }) =>
    withWorkspace(workspaceId, tx => getWorkItem(workItemId, harnessSlug, {}, tx)),
  plan: (slug, scope) => readPlanBySlug(slug, scope),
  evidence: listSpecEvidence,
};

function planStamp(item: WorkItem): string | null {
  const payload = item.payload as { plan_item?: { plan_slug?: unknown } } | null;
  return item.sourcePlanSlug ?? (typeof payload?.plan_item?.plan_slug === 'string' ? payload.plan_item.plan_slug : null);
}

function refusal(
  code: LineageNeutralSuccessorRefusal['code'],
  message: string,
  extra: Pick<LineageNeutralSuccessorRefusal, 'bindingId'> = {},
): LineageNeutralSuccessorRefusal {
  return { code, message, ...extra };
}

/**
 * Return a refusal when the source identity is not the original author of the
 * exact non-terminal frozen-tests manifest it is recovering. The registration
 * gate established the binding's independence; this guard preserves that
 * identity by refusing to add the recovering caller as a lineage parent.
 * Read errors intentionally propagate so callers fail closed.
 */
export async function findLineageNeutralSuccessorRefusal(input: {
  workspaceId: string;
  harnessSlug: string | null | undefined;
  workItemId: string | null | undefined;
  sourceOwnerId: string | null | undefined;
}, deps: LineageNeutralSuccessorEligibilityDeps = defaultDeps): Promise<LineageNeutralSuccessorRefusal | null> {
  const workspaceId = input.workspaceId.trim();
  const harnessSlug = input.harnessSlug?.trim() ?? '';
  const workItemId = input.workItemId?.trim() ?? '';
  const sourceOwnerId = input.sourceOwnerId?.trim() ?? '';
  if (!workspaceId || !harnessSlug || !workItemId || !sourceOwnerId) {
    return refusal('source-work-item-required', 'the source session is not bound to a work item in a known harness.');
  }

  const item = await deps.workItem({ workItemId, harnessSlug, workspaceId });
  if (!item || item.id !== workItemId || item.harness !== harnessSlug) {
    return refusal('source-work-item-unavailable', 'the source work item could not be resolved in its exact harness.');
  }
  if ((ANY_FAMILY_TERMINAL_STATES as readonly string[]).includes(item.state)) {
    return refusal('source-work-item-terminal', 'the source work item is already terminal.');
  }

  const manifest = manifestSchema.safeParse((item.payload as Record<string, unknown> | null)?._frozenTests);
  if (!manifest.success || planStamp(item) !== manifest.data.planSlug) {
    return refusal('frozen-tests-manifest-required', 'the source work item has no valid, plan-matched frozen-tests manifest.');
  }

  const plan = await deps.plan(manifest.data.planSlug, { workspaceId, harnessSlug });
  if (!plan || plan.parsed.frontmatter.frozenTests !== 'pilot') {
    return refusal('frozen-tests-plan-not-opted-in', 'the manifest plan is not currently opted into frozen-tests.');
  }

  const rows = await deps.evidence({
    workspaceId,
    harnessSlug,
    planSlugs: [manifest.data.planSlug],
    workItemIds: [item.id],
    bindingIds: [manifest.data.bindingId],
    includeRetracted: true,
  });
  const binding = rows.find(row => row.id === manifest.data.bindingId
    && row.workItemId === item.id
    && row.planSlug === manifest.data.planSlug
    && row.evidenceKind === 'manual');
  if (!binding) {
    return refusal('frozen-tests-binding-unavailable', 'the exact frozen-tests manifest binding is not readable.', {
      bindingId: manifest.data.bindingId,
    });
  }
  if (!binding.createdBy || binding.createdBy !== sourceOwnerId) {
    return refusal('frozen-tests-author-mismatch', 'the source identity did not author the manifest binding.', {
      bindingId: manifest.data.bindingId,
    });
  }

  return null;
}

export function renderLineageNeutralSuccessorRefusal(refusalResult: LineageNeutralSuccessorRefusal): string {
  return `lineage_neutral_successor_refused: ${refusalResult.message} (${refusalResult.code}).`;
}
