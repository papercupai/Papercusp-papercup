/**
 * What an item type asks of an item beyond its verification modules
 * (plan-item-types-registry-cupboard-2026-10-20 P-004):
 *
 * - R-10: `work_items:complete` validates `completion.typeFields` against the linked item's
 *   completion schema, given inline as JSON Schema or by a datatype reference. A reference
 *   that does not resolve refuses the close, as does a schema that cannot compile.
 * - R-11: activation seeds one acceptance bar per criterion of the item type's criteria
 *   template, and one per criterion of the rubric it names, mapped to every item of that type.
 *
 * Both read the item type through `resolveVerification`, so inside `withPinnedPlanTypes` they
 * see the revision the plan pinned at activation (D-007, R-14).
 */
import { isDeliverableKind, isTypeSlug, parsePlan } from '@papercusp/plan-parser';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { effectivePlanProfile, readLinkedDeliverableRows } from '../plan-verification-escape';
import {
  activeVerificationResolver,
  resolveVerification,
  type ItemTypeContract,
  type ItemTypeCriterion,
} from '../plan-verification-profile';

export type TypeFieldsRefusalCode =
  | 'item_type_fields_invalid'
  | 'item_type_datatype_unresolved'
  | 'item_type_completion_schema_invalid';

export type TypeFieldsCheck = { ok: true } | { ok: false; code: TypeFieldsRefusalCode; errors: string[] };

/**
 * The datatype a completion schema references: `undefined` when it does not resolve, otherwise
 * its payload schema (null when the datatype declares none, which constrains nothing).
 */
export type DatatypeSchemaLookup = (datatypeRef: string) => Promise<Record<string, unknown> | null | undefined>;

/** Check `typeFields` against one item type's completion schema. No schema means no constraint. */
export async function checkTypeFields(
  contract: Pick<ItemTypeContract, 'id' | 'completion'> | undefined,
  typeFields: Record<string, unknown> | undefined,
  lookupDatatype: DatatypeSchemaLookup,
): Promise<TypeFieldsCheck> {
  const completion = contract?.completion;
  if (!completion) return { ok: true };
  let schema: Record<string, unknown> | null;
  if ('schema' in completion) {
    schema = completion.schema;
  } else {
    const found = await lookupDatatype(completion.datatypeRef);
    if (found === undefined) {
      return {
        ok: false,
        code: 'item_type_datatype_unresolved',
        errors: [`item type ${contract!.id} references datatype '${completion.datatypeRef}', which is not installed in this workspace`],
      };
    }
    schema = found;
  }
  const checked = checkAgainstJsonSchema(schema, typeFields ?? {});
  if (checked.ok) return { ok: true };
  return {
    ok: false,
    code: checked.code === 'bad_schema' ? 'item_type_completion_schema_invalid' : 'item_type_fields_invalid',
    errors: checked.errors,
  };
}

export interface TypeFieldsRefusal {
  code: TypeFieldsRefusalCode;
  itemId: string;
  itemType: string;
  revision: number;
  errors: string[];
}

/** Read a datatype's payload schema from the workspace registry. */
export function registryDatatypeLookup(workspaceId: string): DatatypeSchemaLookup {
  return async (datatypeRef) => {
    const [{ withWorkspace }, { getDatatype }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../datatype-registry-store'),
    ]);
    const row = await withWorkspace(workspaceId, (tx) => getDatatype(tx as never, workspaceId, datatypeRef));
    return row ? row.payloadSchema : undefined;
  };
}

/**
 * R-10 at completion: the first linked plan item whose item type's completion schema the
 * close's `typeFields` violates, or null. Item types are read at the plan's pinned revisions.
 */
export async function readCloseItemTypeFieldsRefusal(
  input: {
    workspaceId: string;
    harnessSlug: string;
    planSlug: string;
    planItemIds: readonly string[];
    typeFields: Record<string, unknown> | undefined;
  },
  lookupDatatype: DatatypeSchemaLookup = registryDatatypeLookup(input.workspaceId),
): Promise<TypeFieldsRefusal | null> {
  if (input.planItemIds.length === 0) return null;
  const { withPinnedPlanTypes } = await import('./pins');
  const linked = await withPinnedPlanTypes(input, async () => {
    const rows = await readLinkedDeliverableRows(input);
    return rows.map((row) => ({
      itemId: row.item_id,
      contract: resolveVerification(
        { verificationProfile: effectivePlanProfile(row.verification_profile) },
        { deliverable: row.deliverable },
      ).itemTypeContract,
    }));
  });
  for (const { itemId, contract } of linked) {
    if (!contract?.completion) continue;
    const checked = await checkTypeFields(contract, input.typeFields, lookupDatatype);
    if (!checked.ok) {
      return { code: checked.code, itemId, itemType: contract.id, revision: contract.revision, errors: checked.errors };
    }
  }
  return null;
}

/** A refusal's one-line explanation for the completion reply. */
export function describeTypeFieldsRefusal(workItemId: string, planSlug: string, refusal: TypeFieldsRefusal): string {
  return (
    `${workItemId}'s linked item ${planSlug}#${refusal.itemId} has item type ${refusal.itemType} ` +
    `(revision ${refusal.revision}), whose completion fields this close does not satisfy ` +
    `(${refusal.code}): ${refusal.errors.join('; ')}. Pass them as completion.typeFields.`
  );
}

/** One plan item and the item-type contract it resolved to. */
export interface ItemContract {
  itemId: string;
  contract: ItemTypeContract | undefined;
}

/** A bar derived from an item type: the shape `buildAcceptanceBarSeed` merges with requirement bars. */
export interface ItemTypeBar {
  barKey: string;
  title: string;
  model: string;
  planItemIds: string[];
  /** Where it came from, for a refusal or the checklist. */
  source: { itemType: string; revision: number; criterionKey: string; rubricRef?: string };
}

/**
 * The bar key for one criterion of one item type, stable across revisions of the type. The
 * namespace separator becomes `--` because the criterion key derived from it allows only
 * lowercase letters, digits and hyphens.
 */
export function itemTypeBarKey(itemType: string, criterionKey: string): string {
  return `T-${itemType.replace('/', '--')}-${criterionKey}`;
}

export type ItemTypeBarDerivation =
  | { ok: true; bars: ItemTypeBar[] }
  | { ok: false; problems: { itemType: string; rubricRef: string; detail: string }[] };

/**
 * R-11: one bar per (item type, criterion), mapped to every item of that type, in item order.
 * Criteria come from the type's criteria template and from the rubric it names
 * (`rubricCriteria`, keyed by rubric slug). A named rubric that is not installed refuses: the
 * item would otherwise activate without the bars its type requires. A template key wins over a
 * rubric criterion with the same key.
 */
export function deriveItemTypeBars(
  items: readonly ItemContract[],
  rubricCriteria: ReadonlyMap<string, readonly ItemTypeCriterion[]>,
): ItemTypeBarDerivation {
  const bars = new Map<string, ItemTypeBar>();
  const problems: { itemType: string; rubricRef: string; detail: string }[] = [];
  for (const { itemId, contract } of items) {
    if (!contract) continue;
    const criteria: { criterion: ItemTypeCriterion; rubricRef?: string }[] = [];
    const keys = new Set<string>();
    for (const criterion of contract.criteriaTemplate ?? []) {
      keys.add(criterion.key);
      criteria.push({ criterion });
    }
    if (contract.rubricRef) {
      const fromRubric = rubricCriteria.get(contract.rubricRef);
      if (!fromRubric) {
        if (!problems.some((p) => p.itemType === contract.id && p.rubricRef === contract.rubricRef)) {
          problems.push({
            itemType: contract.id,
            rubricRef: contract.rubricRef,
            detail: `item type ${contract.id} names rubric '${contract.rubricRef}', which is not installed; install it before activation`,
          });
        }
        continue;
      }
      for (const criterion of fromRubric) {
        if (keys.has(criterion.key)) continue;
        keys.add(criterion.key);
        criteria.push({ criterion, rubricRef: contract.rubricRef });
      }
    }
    for (const { criterion, rubricRef } of criteria) {
      const barKey = itemTypeBarKey(contract.id, criterion.key);
      const existing = bars.get(barKey);
      if (existing) {
        if (!existing.planItemIds.includes(itemId)) existing.planItemIds.push(itemId);
        continue;
      }
      bars.set(barKey, {
        barKey,
        title: criterion.title,
        model: criterion.description?.trim() || criterion.title,
        planItemIds: [itemId],
        source: {
          itemType: contract.id,
          revision: contract.revision,
          criterionKey: criterion.key,
          ...(rubricRef ? { rubricRef } : {}),
        },
      });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, bars: [...bars.values()] };
}

/** What `plans:get` shows for one item whose registry type asks something of it (R-11, D-007). */
export interface ItemTypeChecklistEntry {
  itemId: string;
  itemType: string;
  revision: number;
  /** The completion fields a close must carry as `completion.typeFields`, or null for none. */
  completion: { kind: 'schema' } | { kind: 'datatype'; datatypeRef: string } | null;
  /** The type's criteria template: each becomes an acceptance bar at activation. */
  criteria: Array<{ key: string; title: string }>;
  /** The rubric whose criteria also become bars at activation. */
  rubricRef: string | null;
}

/** True when a plan body can resolve a registry type (a `type:` or a non-built-in deliverable). */
function declaresRegistryTypes(
  planType: string | null,
  items: ReadonlyArray<{ deliverable?: string | null }>,
): boolean {
  return planType !== null || items.some((item) => !isDeliverableKind(item.deliverable) && isTypeSlug(item.deliverable));
}

/**
 * The item-type checklist `plans:get` renders, read at the plan's pinned revisions. Items whose
 * type asks nothing (no completion fields, criteria or rubric) are left out; a plan that
 * declares no registry type returns [] without reading anything.
 */
export async function readItemTypeChecklist(
  scope: { workspaceId?: string; harnessSlug?: string; planSlug: string },
  plan: { verificationProfile?: string | null; content: string },
  items: ReadonlyArray<{ id: string; deliverable?: string | null }>,
): Promise<ItemTypeChecklistEntry[]> {
  const { declaredPlanType, withPinnedPlanTypes } = await import('./pins');
  if (!declaresRegistryTypes(declaredPlanType(plan.content), items)) return [];
  const planInput = { verificationProfile: effectivePlanProfile(plan.verificationProfile ?? null) };
  return withPinnedPlanTypes(scope, async () => {
    const entries: ItemTypeChecklistEntry[] = [];
    for (const item of items) {
      const contract = resolveVerification(planInput, item.deliverable ? { deliverable: item.deliverable } : {})
        .itemTypeContract;
      if (!contract) continue;
      const criteria = (contract.criteriaTemplate ?? []).map(({ key, title }) => ({ key, title }));
      if (!contract.completion && criteria.length === 0 && !contract.rubricRef) continue;
      entries.push({
        itemId: item.id,
        itemType: contract.id,
        revision: contract.revision,
        completion: !contract.completion
          ? null
          : 'schema' in contract.completion
            ? { kind: 'schema' }
            : { kind: 'datatype', datatypeRef: contract.completion.datatypeRef },
        criteria,
        rubricRef: contract.rubricRef ?? null,
      });
    }
    return entries;
  });
}

/** The tagged-template executor the activation seed runs in. */
type SeedSql = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** A rubric criterion as stored in a rubric row's `template_data.criteria`. */
function rubricCriterion(value: unknown): ItemTypeCriterion | null {
  if (!value || typeof value !== 'object') return null;
  const { key, title, model } = value as { key?: unknown; title?: unknown; model?: unknown };
  if (typeof key !== 'string' || key === '' || typeof title !== 'string' || title === '') return null;
  return { key, title, ...(typeof model === 'string' && model.trim() !== '' ? { description: model } : {}) };
}

/**
 * R-11 at activation: the item-type bars for one plan body, inside the seed's transaction.
 * A plan that declares no registry type (no `type:` and only built-in deliverables) resolves
 * only built-in types, which carry no contract, so nothing is read. Otherwise each item is
 * resolved under the plan's pins (an unpinned plan reads the current revisions, which
 * activation then pins), and each rubric an item type names is read from this workspace.
 */
export async function deriveSeedItemTypeBars(
  sql: SeedSql,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string },
  planContent: string,
): Promise<ItemTypeBarDerivation> {
  const { declaredPlanType, loadPlanTypes } = await import('./pins');
  const planType = declaredPlanType(planContent);
  const items = parsePlan(planContent).items;
  if (!declaresRegistryTypes(planType, items)) return { ok: true, bars: [] };

  const [profileRow] = await sql<Array<{ verification_profile: string | null }>>`
    SELECT verification_profile FROM harness_shared.harness_plans
     WHERE workspace_id = ${scope.workspaceId}
       AND harness_slug = ${scope.harnessSlug}
       AND plan_slug = ${scope.planSlug}`;
  const plan = { verificationProfile: effectivePlanProfile(profileRow?.verification_profile ?? null), planType };
  const resolver = activeVerificationResolver() ?? (await loadPlanTypes(sql as never, scope, { planType })).resolver;
  const contracts: ItemContract[] = items.map((item) => ({
    itemId: item.id,
    contract: resolver(plan, item.deliverable ? { deliverable: item.deliverable } : {}).itemTypeContract,
  }));

  const rubricCriteria = new Map<string, ItemTypeCriterion[]>();
  const rubricRefs = new Set(contracts.flatMap(({ contract }) => (contract?.rubricRef ? [contract.rubricRef] : [])));
  for (const rubricRef of rubricRefs) {
    const [row] = await sql<Array<{ template_data: { criteria?: unknown } | null }>>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${scope.workspaceId}
         AND template = 'rubric'
         AND template_slug IS NULL
         AND plan_slug = ${rubricRef}
         AND archived IS NOT TRUE
       ORDER BY (harness_slug = ${scope.harnessSlug}) DESC, harness_slug
       LIMIT 1`;
    const criteria = row?.template_data?.criteria;
    if (!Array.isArray(criteria)) continue;
    rubricCriteria.set(
      rubricRef,
      criteria.flatMap((criterion) => {
        const parsed = rubricCriterion(criterion);
        return parsed ? [parsed] : [];
      }),
    );
  }
  return deriveItemTypeBars(contracts, rubricCriteria);
}
