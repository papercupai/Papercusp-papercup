/**
 * Anti-escape guards for plan verification declarations
 * (plan-verification-profiles-2026-10-17 P-005, requirements R-14 and R-15; D-004, D-008).
 *
 * A plan's verification profile and each item's declared deliverable decide whether the
 * code module (code-truth audit, spec-test adequacy, `testsRun`/`filesChanged`) applies.
 * Declaring work non-code is therefore a way to skip those checks. Two rules stop that:
 *
 * R-14: LOWERING a declaration after activation needs a Decision that is ALREADY recorded
 *   and a fresh activation audit. Lowering means an item's effective deliverable goes from
 *   code to non-code, or the profile goes from coding to general. Raising is always free,
 *   and so is any change while the plan is still a draft. "Fresh" means the latest
 *   activation audit covers the plan content BEFORE the lowering write, so the audit has
 *   reviewed the Decision. The sequence is plans:add-decision, then
 *   plans:audit { phase:'activation' }, then the lowering. A write that adds the Decision
 *   and lowers in one step is refused (D-008).
 *
 * R-15: a work item whose plan item resolves to a non-code deliverable (declared, or the
 *   general profile default) may not complete with code-change evidence: a `filesChanged`
 *   list, or the `bug` kind. Plan promotion gives every item the `feature` kind whatever its
 *   deliverable, so `feature` is not evidence (D-008).
 *
 * Pure checks plus one small read; the callers own their transactions. Every refusal names
 * the profile and the module it protects, as the plan's refusal contract requires.
 */
import type { PlanDecision } from '@papercusp/plan-parser';
import {
  INFERRED_PLAN_PROFILE,
  isVerificationProfile,
  resolveVerification,
  type DeliverableKind,
  type VerificationPlanInput,
  type VerificationProfile,
} from './plan-verification-profile';
import type { VerificationModule } from './plan-types/verification-modules';

/** Plan statuses that mean the plan has been activated (or gone further). */
export const ACTIVATED_PLAN_STATUSES = ['ready', 'active', 'awaiting-acceptance', 'shipped'] as const;

/** A plan counts as activated once it left draft for a lifecycle status, or once it was activation-audited. */
export function isPlanActivated(status: string | null | undefined, hasActivationAudit: boolean): boolean {
  if (hasActivationAudit) return true;
  return typeof status === 'string' && (ACTIVATED_PLAN_STATUSES as readonly string[]).includes(status);
}

/** The stamped profile, or the inferred one (coding) when the plan carries none. */
export function effectivePlanProfile(stamped: string | null | undefined): VerificationProfile {
  return isVerificationProfile(stamped) ? stamped : INFERRED_PLAN_PROFILE;
}

/**
 * Modules `before` requires that `after` no longer does, in `before`'s order. This is THE
 * lowering test (plan-item-types-registry-cupboard-2026-10-20 P-003, R-8): a change lowers
 * verification exactly when the resolved module set loses a module. Every route that can
 * change a resolution (a deliverable swap, a plan `type:` swap, a profile change, and the
 * registry writes P-005/P-006 add) judges itself with this one function (D-005).
 */
export function droppedModules(
  before: readonly VerificationModule[],
  after: readonly VerificationModule[],
): VerificationModule[] {
  const kept = new Set(after);
  return before.filter((module) => !kept.has(module));
}

/** The modules an item that declares no deliverable resolves to under `profile`. */
function profileDefaultModules(profile: VerificationProfile): readonly VerificationModule[] {
  return resolveVerification({ verificationProfile: profile }, { deliverable: null }).modules;
}

/** Modules a profile change drops from an item that relies on the profile's default type. */
export function profileChangeDroppedModules(
  from: string | null | undefined,
  to: VerificationProfile,
): VerificationModule[] {
  return droppedModules(profileDefaultModules(effectivePlanProfile(from)), profileDefaultModules(to));
}

/** True when a profile change drops a module from the profile's default item type. */
export function isProfileLowering(from: string | null | undefined, to: VerificationProfile): boolean {
  return profileChangeDroppedModules(from, to).length > 0;
}

export interface DeliverableLowering {
  itemId: string;
  /** The declared item type before the write (null = undeclared, so the plan type's default applied). */
  from: string | null;
  to: string | null;
  /** The plan profile the lowering was judged under. */
  profile: VerificationProfile;
  /** Modules the item's resolved set had before the write and no longer has. */
  dropped: VerificationModule[];
}

/** The plan-level inputs a content write is judged under, before and after the write. */
export interface LoweringPlanContext {
  profile: VerificationProfile;
  /** The plan's `type:` slug before the write (null = the profile's first-party plan type). */
  planTypeBefore?: string | null;
  /** The plan's `type:` slug after the write (undefined = unchanged). */
  planTypeAfter?: string | null;
}

type ItemDeliverable = { id: string; deliverable?: string | null };

/** True when some item present on both sides changed its declared deliverable keyword. */
export function declaredDeliverablesChanged(
  prior: readonly ItemDeliverable[],
  next: readonly ItemDeliverable[],
): boolean {
  const before = new Map(prior.map((item) => [item.id, declared(item.deliverable)]));
  return next.some((item) => before.has(item.id) && before.get(item.id) !== declared(item.deliverable));
}

/** The item type an item declares (a built-in kind maps to its first-party id), or null. */
function declared(value: string | null | undefined): string | null {
  const r = resolveVerification({ verificationProfile: INFERRED_PLAN_PROFILE }, { deliverable: value });
  return r.deliverableSource === 'declared' ? r.itemType : null;
}

/**
 * Items present on both sides whose resolved module set loses a module across the write:
 * a changed `deliverable:`, a changed plan `type:`, or both. A newly added item is not a
 * lowering (it adds scope), and a removed item is not one either (dropping is a status
 * change with its own note). `context` may be a bare profile (no plan-type change).
 */
export function deliverableLowerings(
  prior: readonly ItemDeliverable[],
  next: readonly ItemDeliverable[],
  context: VerificationProfile | LoweringPlanContext,
): DeliverableLowering[] {
  const ctx: LoweringPlanContext = typeof context === 'string' ? { profile: context } : context;
  const planTypeBefore = ctx.planTypeBefore ?? null;
  const planBefore: VerificationPlanInput = { verificationProfile: ctx.profile, planType: planTypeBefore };
  const planAfter: VerificationPlanInput = {
    verificationProfile: ctx.profile,
    planType: ctx.planTypeAfter === undefined ? planTypeBefore : ctx.planTypeAfter,
  };
  const before = new Map(prior.map((item) => [item.id, item.deliverable ?? null]));
  const lowerings: DeliverableLowering[] = [];
  for (const item of next) {
    if (!before.has(item.id)) continue;
    const was = resolveVerification(planBefore, { deliverable: before.get(item.id) });
    const now = resolveVerification(planAfter, { deliverable: item.deliverable ?? null });
    const dropped = droppedModules(was.modules, now.modules);
    if (dropped.length > 0) {
      lowerings.push({
        itemId: item.id,
        from: declared(before.get(item.id)),
        to: declared(item.deliverable),
        profile: ctx.profile,
        dropped,
      });
    }
  }
  return lowerings;
}

const ITEM_ID_RE = (itemId: string) => new RegExp(`(^|[^A-Za-z0-9-])${itemId.replace(/[-]/g, '\\-')}(?![0-9])`);

/**
 * The id of an already-recorded Decision that names the item (or one of `alsoNamed`, such as
 * the new plan-level type on a `type:` swap) and says what changed — its deliverable, its
 * type or its modules — or null.
 */
export function decisionAuthorizingDeliverableLowering(
  decisions: readonly Pick<PlanDecision, 'id' | 'title' | 'body' | 'itemRefs'>[],
  itemId: string,
  alsoNamed: readonly string[] = [],
): string | null {
  for (const decision of decisions) {
    const text = `${decision.title}\n${decision.body}`;
    const namesItem = decision.itemRefs?.includes(itemId) || ITEM_ID_RE(itemId).test(text)
      || alsoNamed.some((ref) => ref.length > 0 && text.includes(ref));
    if (namesItem && /\b(deliverable|type|modules?)\b/i.test(text)) return decision.id;
  }
  return null;
}

/** The latest activation audit, reduced to what freshness needs. */
export interface ActivationAuditAnchor {
  auditSeq: number;
  /** Content hash of the plan revision the audit reviewed; null on audits that recorded none. */
  contentHash: string | null;
}

export type VerificationLoweringRefusalCode =
  | 'verification_lowering_requires_decision'
  | 'verification_lowering_requires_fresh_activation_audit';

export interface VerificationLoweringRefusal {
  ok: false;
  code: VerificationLoweringRefusalCode;
  message: string;
  profile: VerificationProfile;
  /** The verification modules the change would drop (never empty on a refusal). */
  modules: VerificationModule[];
  items?: string[];
  /** The next calls that make the lowering acceptable. */
  repair: string;
}

const SEQUENCE =
  "Record the reason with plans:add-decision (name the item and its new deliverable), re-run " +
  "plans:audit { phase:'activation' } so the audit covers that Decision, then repeat this write.";

/**
 * R-14 for content writes. Null = allowed. `priorContentHash` is the hash of the plan body
 * BEFORE this write; the Decisions must come from that same prior body.
 */
export function evaluateDeliverableLowering(input: {
  planSlug: string;
  activated: boolean;
  profile: VerificationProfile;
  lowerings: readonly DeliverableLowering[];
  priorDecisions: readonly Pick<PlanDecision, 'id' | 'title' | 'body' | 'itemRefs'>[];
  priorContentHash: string;
  latestActivationAudit: ActivationAuditAnchor | null;
  /** Extra ids a Decision may name instead of the item (the new plan-level type on a `type:` swap). */
  authorizingRefs?: readonly string[];
}): VerificationLoweringRefusal | null {
  if (!input.activated || input.lowerings.length === 0) return null;
  const describe = (l: DeliverableLowering) =>
    `${l.itemId} (${l.from ?? 'plan-type default'} → ${l.to ?? 'plan-type default'}; drops ${l.dropped.join(', ')})`;
  const modulesOf = (ls: readonly DeliverableLowering[]) => [...new Set(ls.flatMap((l) => l.dropped))];
  const unauthorized = input.lowerings.filter(
    (l) => !decisionAuthorizingDeliverableLowering(input.priorDecisions, l.itemId, input.authorizingRefs),
  );
  if (unauthorized.length > 0) {
    const modules = modulesOf(unauthorized);
    return {
      ok: false,
      code: 'verification_lowering_requires_decision',
      message:
        `plan '${input.planSlug}' (profile ${input.profile}) is activated, so the change to ${unauthorized.map(describe).join(', ')} ` +
        `would drop the ${modules.join(', ')} verification module${modules.length === 1 ? '' : 's'} without a recorded Decision. ` +
        `No recorded Decision names the item (or the new plan type) and its deliverable or type. ${SEQUENCE}`,
      profile: input.profile,
      modules,
      items: unauthorized.map((l) => l.itemId),
      repair: SEQUENCE,
    };
  }
  const audit = input.latestActivationAudit;
  if (!audit || audit.contentHash !== input.priorContentHash) {
    return {
      ok: false,
      code: 'verification_lowering_requires_fresh_activation_audit',
      message:
        `plan '${input.planSlug}' (profile ${input.profile}) is activated, and the change to ${input.lowerings.map(describe).join(', ')} ` +
        `drops verification modules. ${audit ? `Activation audit #${audit.auditSeq} reviewed an older revision` : 'No activation audit is recorded'}, ` +
        `so it has not reviewed the Decision that authorizes this. Re-run plans:audit { phase:'activation' }, then repeat this write.`,
      profile: input.profile,
      modules: modulesOf(input.lowerings),
      items: input.lowerings.map((l) => l.itemId),
      repair: "plans:audit { phase:'activation' }, then repeat this write.",
    };
  }
  return null;
}

/** R-14 for the profile verb. Null = allowed. */
export function evaluateProfileLowering(input: {
  planSlug: string;
  activated: boolean;
  from: string | null | undefined;
  to: VerificationProfile;
  decisionId: string | null | undefined;
  decisions: readonly Pick<PlanDecision, 'id'>[];
  currentContentHash: string;
  latestActivationAudit: ActivationAuditAnchor | null;
}): VerificationLoweringRefusal | null {
  const modules = profileChangeDroppedModules(input.from, input.to);
  if (!input.activated || modules.length === 0) return null;
  const from = effectivePlanProfile(input.from);
  const decision = input.decisionId ? input.decisions.find((d) => d.id === input.decisionId) : undefined;
  if (!decision) {
    return {
      ok: false,
      code: 'verification_lowering_requires_decision',
      message:
        `plan '${input.planSlug}' is activated, so changing its verification profile from ${from} to ${input.to} drops the ` +
        `${modules.join(', ')} verification module${modules.length === 1 ? '' : 's'} for every item without its own deliverable. ` +
        (input.decisionId
          ? `Decision ${input.decisionId} is not recorded in this plan. `
          : 'Pass decisionId naming the recorded Decision that explains the change. ') +
        SEQUENCE.replace('name the item and its new deliverable', 'explain why the plan no longer needs those checks'),
      profile: from,
      modules,
      repair: SEQUENCE,
    };
  }
  const audit = input.latestActivationAudit;
  if (!audit || audit.contentHash !== input.currentContentHash) {
    return {
      ok: false,
      code: 'verification_lowering_requires_fresh_activation_audit',
      message:
        `plan '${input.planSlug}' is activated, and changing its verification profile from ${from} to ${input.to} drops the ` +
        `${modules.join(', ')} verification module${modules.length === 1 ? '' : 's'}. ${audit ? `Activation audit #${audit.auditSeq} reviewed an older revision` : 'No activation audit is recorded'}, ` +
        `so it has not reviewed ${decision.id}. Re-run plans:audit { phase:'activation' }, then repeat this call.`,
      profile: from,
      modules,
      repair: "plans:audit { phase:'activation' }, then repeat this call.",
    };
  }
  return null;
}

export type CodeEvidenceSignal = 'files-changed' | 'bug-kind';

export interface NonCodeDeliverableCodeEvidence {
  signals: CodeEvidenceSignal[];
  deliverable: DeliverableKind | null;
  profile: VerificationProfile;
  filesChanged: string[];
}

/**
 * R-15: code-change evidence on a work item whose plan item resolves to a non-code
 * deliverable. Null when the deliverable is code or no evidence is present. Only the declared
 * deliverable and the profile default count; inferred signals are left to the existing guards.
 */
export function nonCodeDeliverableCodeEvidence(input: {
  profile: string | null | undefined;
  deliverable: string | null | undefined;
  filesChanged: readonly string[];
  workItemKind: string | null | undefined;
}): NonCodeDeliverableCodeEvidence | null {
  const profile = effectivePlanProfile(input.profile);
  const resolved = resolveVerification({ verificationProfile: profile }, { deliverable: input.deliverable });
  if (resolved.codeDeliverable) return null;
  const filesChanged = input.filesChanged.filter((path) => typeof path === 'string' && path.trim().length > 0);
  const signals: CodeEvidenceSignal[] = [];
  if (filesChanged.length > 0) signals.push('files-changed');
  if (typeof input.workItemKind === 'string' && input.workItemKind.trim().toLowerCase() === 'bug') signals.push('bug-kind');
  if (signals.length === 0) return null;
  return { signals, deliverable: resolved.deliverable, profile, filesChanged };
}

/** The teaching message for an R-15 refusal; `where` is 'completion' or 'ship'. */
export function describeNonCodeDeliverableCodeEvidence(
  subject: string,
  itemRef: string,
  evidence: NonCodeDeliverableCodeEvidence,
): string {
  const parts: string[] = [];
  if (evidence.signals.includes('files-changed')) {
    parts.push(`its completion lists filesChanged (${evidence.filesChanged.slice(0, 5).join(', ')}${evidence.filesChanged.length > 5 ? ', …' : ''})`);
  }
  if (evidence.signals.includes('bug-kind')) parts.push("its work item is kind 'bug'");
  return (
    `${subject}: plan item ${itemRef} declares the non-code deliverable '${evidence.deliverable ?? 'profile default'}' ` +
    `(profile ${evidence.profile}), so the code verification module does not apply, but ${parts.join(' and ')}. ` +
    `That is code work under a non-code label. If the item changed code, declare deliverable 'code' ` +
    `(raising needs no Decision) and complete it with code evidence. If it did not, remove filesChanged and ` +
    `cite the deliverable instead (artifact, work-item, measurement or external citation).`
  );
}

interface LinkedDeliverableRow {
  item_id: string;
  deliverable: string | null;
  verification_profile: string | null;
}

/** The declared deliverable of each linked plan item, with its plan's stamped profile. */
export async function readLinkedDeliverableRows(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
}): Promise<LinkedDeliverableRow[]> {
  const { withWorkspace } = await import('@papercusp/db-org');
  return withWorkspace(input.workspaceId, (tx) =>
    tx<LinkedDeliverableRow[]>`
      SELECT i.item_id, i.deliverable, p.verification_profile
        FROM harness_shared.plan_items i
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = i.workspace_id AND p.harness_slug = i.harness_slug AND p.plan_slug = i.plan_slug
       WHERE i.workspace_id = ${input.workspaceId}
         AND i.harness_slug = ${input.harnessSlug}
         AND i.plan_slug = ${input.planSlug}
         AND i.item_id = ANY(${[...input.planItemIds]})
       ORDER BY i.item_id`,
  );
}

/**
 * R-13: true only when at least one linked plan item exists and EVERY one resolves to a
 * non-code deliverable under its plan's stamped profile. An empty or partial read is false, so
 * a close keeps the tests-run requirement whenever the deliverable is not positively non-code.
 */
export function linkedDeliverablesAreNonCode(
  rows: readonly { deliverable: string | null; verification_profile: string | null }[],
): boolean {
  return rows.length > 0 && rows.every((row) =>
    !resolveVerification(
      { verificationProfile: effectivePlanProfile(row.verification_profile) },
      { deliverable: row.deliverable },
    ).codeDeliverable);
}

/** R-13 at completion: whether every plan item a closing work item is linked to is non-code. */
export async function readCloseDeliverablesAreNonCode(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
}): Promise<boolean> {
  if (input.planItemIds.length === 0) return false;
  // plan-item-types-registry-cupboard P-005 (R-14): judged under the plan's pinned revisions.
  return withPinnedPlanTypes(input, async () => {
    const rows = await readLinkedDeliverableRows(input);
    // Every requested item must be present: a missing row is an unknown deliverable, not non-code.
    return rows.length === new Set(input.planItemIds).size && linkedDeliverablesAreNonCode(rows);
  });
}

/**
 * Run a one-plan gate under that plan's pinned type revisions and declared plan type
 * (plan-item-types-registry-cupboard P-005, R-14). Imported lazily: the registry modules and
 * this one import each other.
 */
async function withPinnedPlanTypes<T>(
  scope: { workspaceId?: string; harnessSlug?: string; planSlug: string },
  fn: () => Promise<T>,
): Promise<T> {
  const pins = await import('./plan-types/pins');
  return pins.withPinnedPlanTypes(scope, fn);
}

/** The key {@link readClauseCodeDeliverables} and its callers share for one (plan, item) pair. */
export function clauseDeliverableKey(planSlug: string, planItemId: string): string {
  return `${planSlug}\u0000${planItemId}`;
}

/**
 * P-004 (spec-test adequacy): whether each clause's plan item is a CODE deliverable under its
 * plan's stamped profile and the item's declared deliverable. One query covers every pair. A
 * pair with no row is ABSENT from the map, and callers treat absent as code, so a missing or
 * unreadable deliverable never lowers the executable-proof floor (D-005 fails safe to coding).
 */
export async function readClauseCodeDeliverables(input: {
  harnessSlug: string;
  workspaceId?: string;
  clauses: readonly { planSlug: string; planItemId: string }[];
}): Promise<Map<string, boolean>> {
  const pairs = new Map<string, { planSlug: string; planItemId: string }>();
  for (const clause of input.clauses) {
    pairs.set(clauseDeliverableKey(clause.planSlug, clause.planItemId), clause);
  }
  const result = new Map<string, boolean>();
  if (pairs.size === 0) return result;
  const { resolvePlanScope } = await import('./agent-tools/plans/source');
  const scope = await resolvePlanScope({
    harnessSlug: input.harnessSlug,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
  const { withWorkspace } = await import('@papercusp/db-org');
  const slugs = [...pairs.values()].map((pair) => pair.planSlug);
  const itemIds = [...pairs.values()].map((pair) => pair.planItemId);
  const rows = await withWorkspace(scope.workspaceId, (tx) =>
    tx<Array<{ plan_slug: string; item_id: string; deliverable: string | null; verification_profile: string | null }>>`
      SELECT i.plan_slug, i.item_id, i.deliverable, p.verification_profile
        FROM harness_shared.plan_items i
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = i.workspace_id AND p.harness_slug = i.harness_slug AND p.plan_slug = i.plan_slug
       WHERE i.workspace_id = ${scope.workspaceId}
         AND i.harness_slug = ${scope.harnessSlug}
         AND (i.plan_slug, i.item_id) IN (
           SELECT s, t FROM unnest(${slugs}::text[], ${itemIds}::text[]) AS pair(s, t)
         )`,
  );
  // plan-item-types-registry-cupboard P-005 (R-14): each plan's rows are judged under that
  // plan's pinned revisions, so the clauses of several plans never share one plan's pins.
  type ClauseRow = (typeof rows)[number];
  const rowsByPlan = new Map<string, ClauseRow[]>();
  for (const row of rows) {
    const planRows = rowsByPlan.get(row.plan_slug);
    if (planRows) planRows.push(row);
    else rowsByPlan.set(row.plan_slug, [row]);
  }
  for (const [planSlug, planRows] of rowsByPlan) {
    await withPinnedPlanTypes({ ...scope, planSlug }, async () => {
      for (const row of planRows) {
        const resolved = resolveVerification(
          { verificationProfile: effectivePlanProfile(row.verification_profile) },
          { deliverable: row.deliverable },
        );
        result.set(clauseDeliverableKey(row.plan_slug, row.item_id), resolved.codeDeliverable);
      }
    });
  }
  return result;
}

/**
 * R-15 at completion: read the declared deliverable of each plan item a closing work item is
 * linked to (plus the plan's stamped profile) and return the first item whose non-code
 * deliverable is contradicted by the completion's code evidence. Null = nothing to refuse.
 */
export async function readNonCodeDeliverableCloseEvidence(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  planItemIds: readonly string[];
  filesChanged: readonly string[];
  workItemKind: string | null | undefined;
}): Promise<{ itemId: string; evidence: NonCodeDeliverableCodeEvidence } | null> {
  if (input.planItemIds.length === 0) return null;
  return withPinnedPlanTypes(input, async () => {
    const rows = await readLinkedDeliverableRows(input);
    for (const row of rows) {
      const evidence = nonCodeDeliverableCodeEvidence({
        profile: row.verification_profile,
        deliverable: row.deliverable,
        filesChanged: input.filesChanged,
        workItemKind: input.workItemKind,
      });
      if (evidence) return { itemId: row.item_id, evidence };
    }
    return null;
  });
}

/** Work-item states that count as a successful close (the plan reflects them as `done`). */
const SUCCESSFUL_CLOSE_STATES = ['done', 'resolved', 'passed'] as const;

export interface NonCodeDeliverableShipHit {
  itemId: string;
  workItemId: string;
  evidence: NonCodeDeliverableCodeEvidence;
}

/**
 * R-15 at ship (D-008): run the completion check again over every successfully closed work
 * item linked to a plan item, using the deliverable and profile in force NOW. A deliverable
 * lowered after its work item closed with code evidence is caught here, since the completion
 * check only saw the declaration at close time. Links are the same two the promotion and
 * close paths write: `source_plan_item_ids` and `payload.plan_item`. Errors propagate: the
 * caller decides how an unreadable check fails. Reads through `getOrgPg`, the same pool the
 * ship gate reads its plan row from, with every predicate scoped to the workspace.
 */
export async function readNonCodeDeliverableShipEvidence(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): Promise<NonCodeDeliverableShipHit[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const rows = await sql<{
      item_id: string;
      work_item_id: string;
      item_kind: string | null;
      files_changed: unknown;
      deliverable: string | null;
      verification_profile: string | null;
    }[]>`
      WITH linked AS (
        SELECT wi.feature_id, li.item_id, wi.item_kind, wi.payload
          FROM harness_shared.work_items wi
          CROSS JOIN LATERAL unnest(wi.source_plan_item_ids) AS li(item_id)
         WHERE wi.workspace_id = ${input.workspaceId}
           AND wi.harness_slug = ${input.harnessSlug}
           AND wi.source_plan_slug = ${input.planSlug}
           AND wi.status = ANY(${[...SUCCESSFUL_CLOSE_STATES]}::text[])
        UNION
        SELECT wi.feature_id, wi.payload->'plan_item'->>'item_id', wi.item_kind, wi.payload
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = ${input.workspaceId}
           AND wi.harness_slug = ${input.harnessSlug}
           AND wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug}
           AND wi.status = ANY(${[...SUCCESSFUL_CLOSE_STATES]}::text[])
      )
      SELECT l.item_id, l.feature_id AS work_item_id, l.item_kind,
             (CASE WHEN jsonb_typeof(l.payload->'_completionEvidence'->'filesChanged') = 'array'
                   THEN l.payload->'_completionEvidence'->'filesChanged' ELSE '[]'::jsonb END)
               || (CASE WHEN jsonb_typeof(l.payload->'_completionEvidence'->'verification'->'filesChanged') = 'array'
                   THEN l.payload->'_completionEvidence'->'verification'->'filesChanged' ELSE '[]'::jsonb END)
               AS files_changed,
             i.deliverable, p.verification_profile
        FROM linked l
        JOIN harness_shared.plan_items i
          ON i.workspace_id = ${input.workspaceId} AND i.harness_slug = ${input.harnessSlug}
         AND i.plan_slug = ${input.planSlug} AND i.item_id = l.item_id
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = i.workspace_id AND p.harness_slug = i.harness_slug AND p.plan_slug = i.plan_slug
       ORDER BY l.item_id, l.feature_id`;
  // plan-item-types-registry-cupboard P-005 (R-14): judged under the plan's pinned revisions.
  return withPinnedPlanTypes(input, async () => {
    const hits: NonCodeDeliverableShipHit[] = [];
    for (const row of rows) {
      const filesChanged = Array.isArray(row.files_changed)
        ? row.files_changed.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const evidence = nonCodeDeliverableCodeEvidence({
        profile: row.verification_profile,
        deliverable: row.deliverable,
        filesChanged,
        workItemKind: row.item_kind,
      });
      if (evidence) hits.push({ itemId: row.item_id, workItemId: row.work_item_id, evidence });
    }
    return hits;
  });
}

type Query = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** The latest activation audit for one plan, read inside the caller's transaction. */
export async function readLatestActivationAuditAnchor(
  tx: Query,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string },
): Promise<ActivationAuditAnchor | null> {
  const rows = await tx<Array<{ audit_seq: number | string; audited_plan_content_hash: string | null }>>`
    SELECT audit_seq, audited_plan_content_hash
      FROM harness_shared.plan_audits
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}
       AND audit_kind = 'activation'
     ORDER BY audit_seq DESC
     LIMIT 1`;
  const row = rows[0];
  return row ? { auditSeq: Number(row.audit_seq), contentHash: row.audited_plan_content_hash ?? null } : null;
}
