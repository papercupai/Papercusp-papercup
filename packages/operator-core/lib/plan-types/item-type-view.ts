/**
 * plan-item-types-registry-cupboard P-007 (R-19, R-20, R-25): what the Plans pane shows about a
 * plan's types. Every item gets its resolved item type and resolved module set; an item whose
 * type asks for completion fields also gets the JSON schema the completion form is generated
 * from. Everything is read at the plan's pinned revisions, through the same resolver that
 * `plans:get`, `work_items:complete` and the ship gate use, so the pane cannot show a type or a
 * module the gate does not hold the item to.
 *
 * `checkPlanItemTypeFields` is the form's submit: it runs `checkTypeFields`, the validation
 * `work_items:complete` applies to `completion.typeFields`, against the item's pinned contract.
 */
import { isDeliverableKind, parsePlan } from '@papercusp/plan-parser';
import { effectivePlanProfile } from '../plan-verification-escape';
import { resolveVerification, type ItemTypeContract } from '../plan-verification-profile';
import { builtinKindOf } from './builtin-catalog';
import { checkTypeFields, registryDatatypeLookup, type DatatypeSchemaLookup, type TypeFieldsCheck } from './item-type-contract';

export interface PlanItemTypeViewItem {
  itemId: string;
  /** The resolved item type id, or null when the item resolves none (a non-code audit verdict). */
  itemType: string | null;
  /** The resolved revision, or null when the type did not resolve. */
  revision: number | null;
  /** True for the first-party item types that back the built-in deliverable kinds. */
  builtIn: boolean;
  /** The item's resolved module set: every verification module it is held to. */
  modules: string[];
  /** Where the completion fields come from, or null when the type asks for none. */
  completion: { kind: 'schema' } | { kind: 'datatype'; datatypeRef: string } | null;
  /**
   * The JSON schema the completion form renders. Null when the type asks for no fields, or when
   * a referenced datatype is not installed (then `completionUnresolved` is true).
   */
  completionSchema: Record<string, unknown> | null;
  completionUnresolved: boolean;
  criteria: Array<{ key: string; title: string }>;
  rubricRef: string | null;
}

export interface PlanItemTypeView {
  planSlug: string;
  /** The `type:` the plan declares, or null when it is held to its profile's first-party plan type. */
  planType: string | null;
  profile: string;
  items: PlanItemTypeViewItem[];
}

export interface PlanTypeScope {
  workspaceId?: string;
  harnessSlug?: string;
  planSlug: string;
}

interface PlanBody {
  verificationProfile?: string | null;
  content: string;
}

function planItems(content: string): Array<{ id: string; deliverable: string | null }> {
  const parsed = parsePlan(content);
  return parsed.items.map((item) => ({
    id: item.id,
    deliverable: (item as { deliverable?: string | null }).deliverable ?? null,
  }));
}

async function completionSchemaOf(
  contract: ItemTypeContract | undefined,
  lookupDatatype: DatatypeSchemaLookup,
): Promise<{ schema: Record<string, unknown> | null; unresolved: boolean }> {
  const completion = contract?.completion;
  if (!completion) return { schema: null, unresolved: false };
  if ('schema' in completion) return { schema: completion.schema, unresolved: false };
  const found = await lookupDatatype(completion.datatypeRef);
  if (found === undefined) return { schema: null, unresolved: true };
  return { schema: found ?? { type: 'object' }, unresolved: false };
}

/** Resolve every item of one plan body. Call inside `withPinnedPlanTypes` for the plan's pins. */
export async function resolvePlanItemTypeView(
  planSlug: string,
  plan: PlanBody,
  lookupDatatype: DatatypeSchemaLookup,
): Promise<PlanItemTypeView> {
  const { declaredPlanType } = await import('./pins');
  const planType = declaredPlanType(plan.content);
  const planInput = { verificationProfile: effectivePlanProfile(plan.verificationProfile ?? null), planType };
  const items: PlanItemTypeViewItem[] = [];
  let profile: string = planInput.verificationProfile ?? 'unknown';
  for (const item of planItems(plan.content)) {
    const resolved = resolveVerification(planInput, item.deliverable ? { deliverable: item.deliverable } : {});
    profile = resolved.profile;
    const contract = resolved.itemTypeContract;
    const { schema, unresolved } = await completionSchemaOf(contract, lookupDatatype);
    const completion = contract?.completion;
    items.push({
      itemId: item.id,
      itemType: resolved.itemType,
      revision: contract?.revision ?? null,
      builtIn: resolved.itemType !== null && builtinKindOf(resolved.itemType) !== null,
      modules: [...resolved.modules],
      completion: !completion
        ? null
        : 'schema' in completion
          ? { kind: 'schema' }
          : { kind: 'datatype', datatypeRef: completion.datatypeRef },
      completionSchema: schema,
      completionUnresolved: unresolved,
      criteria: (contract?.criteriaTemplate ?? []).map(({ key, title }) => ({ key, title })),
      rubricRef: contract?.rubricRef ?? null,
    });
  }
  return { planSlug, planType, profile, items };
}

async function readPlanBody(scope: PlanTypeScope): Promise<PlanBody | null> {
  const { getPlanRow } = await import('../agent-tools/plans/source');
  const row = await getPlanRow(scope.planSlug, {
    ...(scope.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
    ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
  });
  if (!row || typeof row.content !== 'string') return null;
  return { verificationProfile: (row as { verificationProfile?: string | null }).verificationProfile ?? null, content: row.content };
}

async function datatypeLookupFor(scope: PlanTypeScope): Promise<DatatypeSchemaLookup> {
  if (scope.workspaceId) return registryDatatypeLookup(scope.workspaceId);
  const { resolvePlanScope } = await import('../agent-tools/plans/source');
  const { workspaceId } = await resolvePlanScope(scope.harnessSlug ? { harnessSlug: scope.harnessSlug } : {});
  return registryDatatypeLookup(workspaceId);
}

/** The Plans pane's type view of one plan, at its pinned revisions. Null when the plan is unknown. */
export async function readPlanItemTypeView(scope: PlanTypeScope): Promise<PlanItemTypeView | null> {
  const plan = await readPlanBody(scope);
  if (!plan) return null;
  const lookupDatatype = await datatypeLookupFor(scope);
  const { withPinnedPlanTypes } = await import('./pins');
  return withPinnedPlanTypes(scope, () => resolvePlanItemTypeView(scope.planSlug, plan, lookupDatatype));
}

export type PlanItemTypeFieldsCheck =
  | TypeFieldsCheck
  | { ok: false; code: 'plan_not_found' | 'plan_item_not_found'; errors: string[] };

/**
 * The completion form's submit: check `typeFields` against one plan item's pinned item-type
 * contract with `checkTypeFields`, the validation `work_items:complete` applies.
 */
export async function checkPlanItemTypeFields(
  scope: PlanTypeScope & { itemId: string; typeFields: Record<string, unknown> },
): Promise<PlanItemTypeFieldsCheck> {
  const plan = await readPlanBody(scope);
  if (!plan) return { ok: false, code: 'plan_not_found', errors: [`plan ${scope.planSlug} was not found`] };
  const item = planItems(plan.content).find((it) => it.id === scope.itemId);
  if (!item) {
    return { ok: false, code: 'plan_item_not_found', errors: [`plan ${scope.planSlug} has no item ${scope.itemId}`] };
  }
  const lookupDatatype = await datatypeLookupFor(scope);
  const { withPinnedPlanTypes, declaredPlanType } = await import('./pins');
  const planInput = {
    verificationProfile: effectivePlanProfile(plan.verificationProfile ?? null),
    planType: declaredPlanType(plan.content),
  };
  const contract = await withPinnedPlanTypes(scope, async () =>
    resolveVerification(planInput, item.deliverable ? { deliverable: item.deliverable } : {}).itemTypeContract,
  );
  return checkTypeFields(contract, scope.typeFields, lookupDatatype);
}

/** True when a deliverable value names a registry item type rather than a built-in kind. */
export function namesRegistryItemType(deliverable: string | null | undefined): boolean {
  return typeof deliverable === 'string' && deliverable !== '' && !isDeliverableKind(deliverable);
}
