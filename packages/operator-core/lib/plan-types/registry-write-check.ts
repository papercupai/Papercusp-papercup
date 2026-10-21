/**
 * The R-8 shrink check for registry writes
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, D-005 and D-006; P-006 reuses it).
 *
 * A registry write changes what an id resolves to: defining a newer revision, retiring one,
 * installing a same-id definition from a pack (P-006), or moving a plan's pin. A plan pinned to
 * the revisions it activated with resolves the same modules after any of these writes, so the
 * write cannot lower it. An activated plan WITHOUT a pin (activated by a build that did not
 * pin yet, or a draft that carries an activation audit) re-resolves, and a write that makes one
 * of its items lose a verification module is a lowering, exactly like a deliverable swap.
 *
 * So every registry write runs this one check, built on the P-003 `droppedModules` test and the
 * same Decision + fresh-activation-audit rule as a content write
 * (plan-verification-profiles-2026-10-17#D-004/#D-008). Each affected plan must already record a
 * Decision that names the type id (or the item) and says what changed, and its latest activation
 * audit must cover its current content. Pinning the plan to the revision it resolves today is
 * the other way through: the write is then inert for that plan.
 */
import type postgres from 'postgres';
import { parsePlan } from '@papercusp/plan-parser';
import {
  ACTIVATED_PLAN_STATUSES,
  droppedModules,
  effectivePlanProfile,
  evaluateDeliverableLowering,
  isPlanActivated,
  readLatestActivationAuditAnchor,
  type DeliverableLowering,
  type VerificationLoweringRefusal,
  type VerificationLoweringRefusalCode,
} from '../plan-verification-escape';
import { hashPlanContent } from '../agent-tools/plans/content-hash';
import type { VerificationProfile } from '../plan-verification-profile';
import { createPlanTypeResolver, declaredPlanType, loadPlanPins, type PlanPinScope } from './pins';
import type { TypeRegistrySnapshot } from './registry';
import type { PlanTypePins } from './resolve-verification';
import type { VerificationModule } from './verification-modules';

type Sql = postgres.Sql | postgres.TransactionSql;

/** The writes that can change a resolution without touching a plan body (R-8's registry routes). */
export type RegistryWriteRoute = 'define' | 'retire' | 'pin' | 'install';

type ItemDeliverable = { id: string; deliverable?: string | null };

/**
 * Ids whose resolution can reach `typeId`: the id itself, every item type that extends it and
 * every plan type that references it, transitively, in any of the snapshots. A plan can only
 * reach a non-first-party type by naming one of these ids in its body (`type:` or
 * `deliverable:`), because a first-party definition never references a third-party one.
 */
export function dependentTypeIds(typeId: string, snapshots: readonly TypeRegistrySnapshot[]): string[] {
  const dependents = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    const set = dependents.get(from) ?? new Set<string>();
    set.add(to);
    dependents.set(from, set);
  };
  for (const snapshot of snapshots) {
    for (const id of snapshot.itemTypeIds()) {
      for (const revision of snapshot.itemTypeRevisions(id)) {
        const parent = revision.definition.extends;
        if (parent) edge(parent.id, id);
      }
    }
    for (const id of snapshot.planTypeIds()) {
      for (const revision of snapshot.planTypeRevisions(id)) {
        for (const ref of [revision.definition.defaultItemType, ...revision.definition.itemTypes]) edge(ref.id, id);
      }
    }
  }
  const out = new Set<string>([typeId]);
  const queue = [typeId];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.shift()!) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return [...out].sort();
}

/**
 * Items whose resolved module set loses a module between two resolutions of the same plan body:
 * the registry before and after a write, or the plan's pins before and after a pin edit. Every
 * item is judged, plus the plan type's default for items that declare no deliverable.
 */
export function planRegistryLowerings(input: {
  items: readonly ItemDeliverable[];
  profile: VerificationProfile;
  planType: string | null;
  before: { registry: TypeRegistrySnapshot; pins: PlanTypePins };
  after: { registry: TypeRegistrySnapshot; pins: PlanTypePins };
}): DeliverableLowering[] {
  const plan = { verificationProfile: input.profile, planType: input.planType };
  const before = createPlanTypeResolver({ ...input.before, planType: input.planType });
  const after = createPlanTypeResolver({ ...input.after, planType: input.planType });
  const lowerings: DeliverableLowering[] = [];
  for (const item of input.items) {
    const deliverable = item.deliverable ?? null;
    const dropped = droppedModules(before(plan, { deliverable }).modules, after(plan, { deliverable }).modules);
    if (dropped.length > 0) {
      lowerings.push({ itemId: item.id, from: deliverable, to: deliverable, profile: input.profile, dropped });
    }
  }
  return lowerings;
}

export interface RegistryWritePlanRefusal {
  harnessSlug: string;
  planSlug: string;
  code: VerificationLoweringRefusalCode;
  items: string[];
  modules: VerificationModule[];
  message: string;
}

export interface RegistryWriteRefusal {
  ok: false;
  code: VerificationLoweringRefusalCode;
  message: string;
  route: RegistryWriteRoute;
  typeId: string;
  /** Every verification module the write would drop, across the refused plans. */
  modules: VerificationModule[];
  plans: RegistryWritePlanRefusal[];
  repair: string;
}

interface CandidatePlan {
  harness_slug: string;
  plan_slug: string;
  status: string | null;
  content: string;
  verification_profile: string | null;
}

/**
 * Activated plans in the workspace whose body names one of `ids`. `only` narrows it to one plan
 * (the pin edit), which is judged whether or not its body names the type.
 */
async function readCandidatePlans(
  sql: Sql,
  workspaceId: string,
  ids: readonly string[],
  only?: { harnessSlug: string; planSlug: string },
): Promise<CandidatePlan[]> {
  if (only) {
    return sql<CandidatePlan[]>`
      SELECT harness_slug, plan_slug, status, content, verification_profile
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${only.harnessSlug}
         AND plan_slug = ${only.planSlug}`;
  }
  const patterns = ids.map((id) => `%${id}%`);
  return sql<CandidatePlan[]>`
    SELECT p.harness_slug, p.plan_slug, p.status, p.content, p.verification_profile
      FROM harness_shared.harness_plans p
     WHERE p.workspace_id = ${workspaceId}
       AND p.content LIKE ANY(${patterns}::text[])
       AND (p.status = ANY(${[...ACTIVATED_PLAN_STATUSES]}::text[])
            OR EXISTS (SELECT 1 FROM harness_shared.plan_audits a
                        WHERE a.workspace_id = p.workspace_id
                          AND a.harness_slug = p.harness_slug
                          AND a.plan_slug = p.plan_slug
                          AND a.audit_kind = 'activation'))`;
}

const PIN_REPAIR =
  'Either pin each listed plan to the revision it resolves today (plan-types:pin), which makes this write inert ' +
  'for it, or record a Decision in that plan naming the type id and why it no longer needs those checks ' +
  "(plans:add-decision), re-run plans:audit { phase:'activation' } on it, then repeat this write.";

/**
 * Run the shrink check for one registry write. Null = allowed. `before`/`after` are the registry
 * around the write; for a pin edit pass the same registry twice and the plan's new pin in
 * `pinEdit`, which also limits the check to that plan.
 */
export async function checkRegistryWriteLowering(
  sql: Sql,
  input: {
    workspaceId: string;
    route: RegistryWriteRoute;
    typeId: string;
    before: TypeRegistrySnapshot;
    after: TypeRegistrySnapshot;
    pinEdit?: { harnessSlug: string; planSlug: string; pinsAfter: (pins: PlanTypePins) => PlanTypePins };
  },
): Promise<RegistryWriteRefusal | null> {
  const ids = dependentTypeIds(input.typeId, [input.before, input.after]);
  const candidates = await readCandidatePlans(sql, input.workspaceId, ids, input.pinEdit);
  const refused: RegistryWritePlanRefusal[] = [];
  for (const plan of candidates) {
    const scope: PlanPinScope = { workspaceId: input.workspaceId, harnessSlug: plan.harness_slug, planSlug: plan.plan_slug };
    const audit = await readLatestActivationAuditAnchor(sql as never, scope);
    if (!isPlanActivated(plan.status, audit !== null)) continue;
    const pins = await loadPlanPins(sql, scope);
    const parsed = parsePlan(plan.content);
    const profile = effectivePlanProfile(plan.verification_profile);
    const lowerings = planRegistryLowerings({
      items: parsed.items,
      profile,
      planType: declaredPlanType(plan.content),
      before: { registry: input.before, pins },
      after: { registry: input.after, pins: input.pinEdit ? input.pinEdit.pinsAfter(pins) : pins },
    });
    const refusal: VerificationLoweringRefusal | null = evaluateDeliverableLowering({
      planSlug: plan.plan_slug,
      activated: true,
      profile,
      lowerings,
      priorDecisions: parsed.decisions,
      priorContentHash: hashPlanContent(plan.content),
      latestActivationAudit: audit,
      authorizingRefs: [input.typeId],
    });
    if (!refusal) continue;
    refused.push({
      harnessSlug: plan.harness_slug,
      planSlug: plan.plan_slug,
      code: refusal.code,
      items: refusal.items ?? [],
      modules: refusal.modules,
      message: refusal.message,
    });
  }
  if (refused.length === 0) return null;
  const modules = [...new Set(refused.flatMap((p) => p.modules))];
  const code: VerificationLoweringRefusalCode = refused.some((p) => p.code === 'verification_lowering_requires_decision')
    ? 'verification_lowering_requires_decision'
    : 'verification_lowering_requires_fresh_activation_audit';
  const named = refused.map((p) => `${p.harnessSlug}/${p.planSlug} (${p.items.join(', ')})`).join('; ');
  return {
    ok: false,
    code,
    message:
      `${input.route} of ${input.typeId} would drop the ${modules.join(', ')} verification module` +
      `${modules.length === 1 ? '' : 's'} from activated plan${refused.length === 1 ? '' : 's'} that resolve it ` +
      `without a pin: ${named}. ${PIN_REPAIR}`,
    route: input.route,
    typeId: input.typeId,
    modules,
    plans: refused,
    repair: PIN_REPAIR,
  };
}
