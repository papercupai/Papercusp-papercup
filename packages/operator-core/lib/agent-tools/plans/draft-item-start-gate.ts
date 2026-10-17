/**
 * Draft-plan item-start gate (WI-10008137).
 *
 * The conversation activation audit gates a plan's own `draft → ready/active`
 * transition (plan-activation-gate.ts, enforced in with-plan-lock.ts) and
 * `plans:start`. Item-level doors never checked it, so agents could begin work on a
 * draft plan that was never audited; measured 2026-10-10, 54 draft plans had
 * wip/done items and no activation audit. The plan then sat in `draft` while its work
 * progressed.
 *
 * Owner decision [owner 2026-10-10, directive #1614 "1 A"]: refuse STARTING an item
 * (moving it from not-started to wip/done) on an unaudited draft plan. Items already
 * in progress keep going: an item already wip may finish, and an item already
 * covered by a non-terminal work-item is in progress by definition (this is what lets
 * work-item lifecycle reflections and plan_items:convert's pickup reaction through).
 *
 * The IO is injected so the decision is unit-testable without a database.
 */
import { deriveIndexFromContent } from './derive-index';
import {
  isActivationAuditExemptTemplate,
  type ConversationActivationGateVerdict,
} from './plan-activation-gate';

/** Statuses that mean work has begun or ended; moving out of these is not a start. */
const STARTED_OR_TERMINAL = new Set(['wip', 'done', 'dropped']);
/** Target statuses that START an item. */
const START_TARGETS = new Set(['wip', 'done']);

export interface DraftItemStartRefusal {
  ok: false;
  slug: string;
  itemId: string;
  error: 'activation_audit_required';
  /** The gate's own code: conversation_audit_required or item_provenance_unresolved. */
  gateCode: string | undefined;
  hint: string;
}

export async function checkDraftItemStartGate(input: {
  slug: string;
  itemId: string;
  toStatus: string;
  /** The plan body; null when the plan could not be read (the normal path reports that). */
  readPlanContent: () => Promise<string | null>;
  evaluateGate: () => Promise<ConversationActivationGateVerdict>;
  /** True when a non-terminal work-item already covers this plan item. */
  hasCoveringWorkItem: () => Promise<boolean>;
  /** True when a terminal work-item proves a stale todo→done reflection. */
  hasTerminalCoveringWorkItem?: () => Promise<boolean>;
}): Promise<DraftItemStartRefusal | null> {
  if (!START_TARGETS.has(input.toStatus)) return null;

  const content = await input.readPlanContent();
  if (!content) return null;
  const index = deriveIndexFromContent(content);
  if (index.status !== 'draft') return null;
  if (isActivationAuditExemptTemplate(index.template)) return null;

  const item = index.items.find((candidate) => candidate.id === input.itemId);
  // Unknown item: let the normal path return its own item_not_found.
  if (!item) return null;
  if (STARTED_OR_TERMINAL.has(item.status)) return null;

  // A terminal linked work-item is completion evidence, not a new start. This
  // is the repair path for a missed work-item→plan reflection: the plan item
  // may still read `todo` on an unaudited legacy plan even though its sole
  // linked work-item already reached a terminal state. Keep the activation
  // gate for new `wip`/`done` starts with no completion evidence.
  if (input.toStatus === 'done' && input.hasTerminalCoveringWorkItem) {
    if (await input.hasTerminalCoveringWorkItem()) return null;
  }

  const gate = await input.evaluateGate();
  if (gate.satisfied) return null;
  if (await input.hasCoveringWorkItem()) return null;

  return {
    ok: false,
    slug: input.slug,
    itemId: input.itemId,
    error: 'activation_audit_required',
    gateCode: gate.code,
    hint:
      `Plan '${input.slug}' is a draft with no activation audit, so its items cannot start yet. ` +
      "Run plans:audit { phase:'activation' } (re-read the full source conversation and map it); " +
      'the plan activates automatically when the audit is recorded. ' +
      (gate.message ? `Gate: ${gate.message}` : ''),
  };
}

/**
 * The gate wired to the live database: the one entry point every item door calls
 * (plans:set-status, and the core convertPlanItem behind plan_items:convert,
 * plan_items:claim and coord:declare-intent). `planContent` skips the plan read when
 * the caller already holds the body. The DB-bound modules are imported lazily so the
 * pure decision above stays importable without a database.
 */
export async function checkDraftItemStartGateLive(input: {
  /** Both omitted ⇒ resolved like the claim path: resolvePlanScope({ harnessSlug }). */
  workspaceId?: string;
  harnessSlug?: string | null;
  slug: string;
  itemId: string;
  toStatus: string;
  planContent?: string | null;
}): Promise<DraftItemStartRefusal | null> {
  if (!START_TARGETS.has(input.toStatus)) return null;
  // Every DB-bound dependency loads at its point of use, so a non-draft plan (the
  // common case) costs one plan read at most and touches nothing else.
  let resolved: { workspaceId: string; harnessSlug: string } | null =
    input.workspaceId && input.harnessSlug
      ? { workspaceId: input.workspaceId, harnessSlug: input.harnessSlug }
      : null;
  const scope = async () => {
    if (!resolved) {
      const { resolvePlanScope } = await import('./source');
      resolved = await resolvePlanScope(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {});
    }
    return resolved;
  };
  const sql = async () => (await import('@papercusp/db-org')).getOrgPg().sql;
  let coverage: Promise<{ hasOpen: boolean; hasTerminal: boolean }> | undefined;
  const readCoverage = async (): Promise<{ hasOpen: boolean; hasTerminal: boolean }> => {
    coverage ??= (async () => {
      const { findCoverageWorkItems, TERMINAL_WORK_ITEM_STATES } = await import('../../plan-items/convert');
      const { workspaceId } = await scope();
      const linked = await findCoverageWorkItems(input.slug, input.itemId, [workspaceId]);
      return {
        hasOpen: linked.some((wi) => !TERMINAL_WORK_ITEM_STATES.has(wi.state)),
        hasTerminal: linked.some((wi) => TERMINAL_WORK_ITEM_STATES.has(wi.state)),
      };
    })();
    return coverage;
  };
  return checkDraftItemStartGate({
    slug: input.slug,
    itemId: input.itemId,
    toStatus: input.toStatus,
    readPlanContent: async () => {
      if (input.planContent !== undefined) return input.planContent;
      const { workspaceId, harnessSlug } = await scope();
      const rows = await (await sql())<Array<{ content: string }>>`
        SELECT content
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harnessSlug}
           AND plan_slug = ${input.slug}
         LIMIT 1`;
      return rows[0]?.content ?? null;
    },
    evaluateGate: async () => {
      const { evaluateConversationActivationGate } = await import('./plan-activation-gate');
      const { workspaceId, harnessSlug } = await scope();
      return evaluateConversationActivationGate((await sql()) as never, {
        workspaceId,
        harnessSlug,
        planSlug: input.slug,
      });
    },
    hasCoveringWorkItem: async () => (await readCoverage()).hasOpen,
    hasTerminalCoveringWorkItem: async () => (await readCoverage()).hasTerminal,
  });
}
