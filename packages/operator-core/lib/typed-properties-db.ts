/**
 * typed-properties-db.ts — the DB half of the typed goal/plan property contract
 * (work-on-everything-goal-2026-08-23 P-023 / WI-41047).
 *
 * The PURE decision (CAS + authorization + datatype validation) lives in
 * `typed-properties.ts`; THIS module owns the row I/O both write doors share:
 *
 *   - declaration validation against `datatype_registry` (creation seams +
 *     anywhere a `property_schema` document is accepted), and
 *   - the locked read → prepare → persist cycle on the owning goal / plan row
 *     (`goals:set-property` / `plans:set-property`).
 *
 * ONE writer per table, two thin doors — the same arrangement the goals
 * `_core.ts` insert has. The datatype registry remains the shape authority:
 * values are validated against the datatype's `payload_schema` via the shared
 * ajv seam, and an unknown datatype ref is an error, never a silent pass.
 *
 * Transport-agnostic: every function takes the `sql` handle (the caller's tx),
 * so the same code serves a tool ctx.tx, a withWorkspace tx, and an
 * integration test's admin client. Callers MUST run the write cycle inside a
 * transaction — the SELECT ... FOR UPDATE is what serializes concurrent CAS
 * writers on the same row.
 */
import type postgres from 'postgres';
import { isDeepStrictEqual } from 'node:util';
import {
  prepareTypedPropertyMutation,
  TypedPropertySchemaDocumentSchema,
  ORDERED_SELECTION_POLICY_DATATYPE,
  OrderedSelectionPolicySchema,
  readTypedPropertyCollection,
  type PropertyEditProvenance,
  type TypedPropertyMutationResult,
} from './typed-properties';
import { getDatatype } from './datatype-registry-store';
import { checkAgainstJsonSchema } from './json-schema-validation';
import {
  CANONICAL_WORKLIST_PROPERTY,
  PLAN_REF_LIST_DATATYPE,
  ensurePlanRefListDatatype,
  ensureOrderedSelectionPolicyDatatype,
  withCanonicalWorklistDeclaration,
} from './goals/package-property-datatypes';

/** The narrowest handle both callers' SQL tags satisfy (pool sql or tx). */
type SqlLike = postgres.Sql;

export interface GoalPlanClaimSelection {
  goalId: string;
  selected: string[];
  ordered: string[];
  attributed: string[];
  appliesToActor: boolean;
  policyVersion: number | null;
}

export function assertGoalPlanClaimSelection(
  selections: readonly GoalPlanClaimSelection[],
  args: { harness: string; planSlug: string; goalId?: string | null },
): void {
  const ref = `plan:${args.harness}/${args.planSlug}`;
  for (const selection of selections) {
    if ((selection.appliesToActor || selection.goalId === args.goalId || selection.attributed.includes(ref))
        && !selection.selected.includes(ref)) {
      throw new Error(`goal_plan_excluded: ${ref} is not selected by ${selection.goalId} at policy version ${selection.policyVersion ?? 'unavailable'}`);
    }
  }
}

/**
 * Call INSIDE the claim transaction. Owner property writes lock this same goal
 * row FOR UPDATE; FOR SHARE orders a new claim before or after that write.
 * No policy snapshot survives the transaction, and finishing an existing claim
 * does not enter this admission boundary.
 */
export async function lockGoalPlanClaimSelections(
  sql: SqlLike,
  workspaceId: string,
  assignee?: string,
): Promise<GoalPlanClaimSelection[]> {
  const goals = await sql<Array<{ id: string; property_schema: unknown; properties: unknown }>>`
    SELECT id, property_schema, properties FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId}
       AND property_schema->'worklist'->'collection' IS NOT NULL
     ORDER BY id FOR SHARE`;
  if (goals.length === 0) return [];
  const plans = await sql<Array<{ harness_slug: string; plan_slug: string; goal_id: string | null;
    status: string; op_status: string | null; archived: boolean }>>`
    SELECT harness_slug, plan_slug, goal_id, status, op_status, archived
      FROM harness_shared.harness_plans WHERE workspace_id = ${workspaceId}
     ORDER BY created_at, harness_slug, plan_slug`;
  const actorGoal = assignee
    ? await (await import('./modes/goal-context')).resolveGoalContext(workspaceId, assignee, sql, { requireRead: true }) : null;
  const refOf = (plan: typeof plans[number]) => `plan:${plan.harness_slug}/${plan.plan_slug}`;
  const canonical = (ref: string) => {
    if (!ref.startsWith('plan:') || ref.includes('/')) return ref;
    const matches = plans.filter((plan) => plan.plan_slug === ref.slice(5));
    return matches.length === 1 ? refOf(matches[0]) : ref;
  };
  return goals.map((goal) => {
    const schema = asDoc(goal.property_schema);
    const properties = asDoc(goal.properties);
    const definition = asDoc(schema.worklist);
    const collection = asDoc(definition.collection);
    const stored = asDoc(properties.worklist);
    const explicit = stored.value ?? definition.default ?? [];
    const refs = Array.isArray(explicit) && explicit.every((ref) => typeof ref === 'string')
      ? explicit.map(canonical) : null;
    const discovered = collection.source === 'active-workspace-plans'
      ? plans.filter((plan) => !plan.archived && (plan.op_status ?? plan.status) === 'active').map(refOf) : [];
    const selection = readTypedPropertyCollection({ propertySchema: schema, properties, property: 'worklist',
      source: refs ? { ok: true, items: [...new Set([...refs, ...discovered])] }
        : { ok: false, reason: 'invalid stored worklist' } });
    return { goalId: goal.id, selected: selection.ok && selection.configured ? selection.selected : [],
      ordered: selection.ok && selection.configured ? selection.items.map((item) => item.id) : [],
      attributed: plans.filter((plan) => plan.goal_id === goal.id).map(refOf),
      appliesToActor: actorGoal === goal.id,
      policyVersion: selection.ok && selection.configured ? selection.policyVersion : null };
  });
}

/** SQL composition over the shared reader's result; domain floors stay with the caller. */
export function goalPlanClaimFragments(
  sql: SqlLike,
  selections: readonly GoalPlanClaimSelection[],
  columns: { harness: string; goal: string; payload: string; sourcePlan: string; holder?: string },
  assignee?: string,
) {
  const plan = sql`COALESCE(${sql.unsafe(columns.sourcePlan)}, ${sql.unsafe(columns.payload)}->'plan_item'->>'plan_slug')`;
  const ref = sql`('plan:' || COALESCE(${sql.unsafe(columns.payload)}->'plan_item'->>'harness_slug',
    ${sql.unsafe(columns.harness)}) || '/' || ${plan})`;
  const applies = (selection: GoalPlanClaimSelection) => selection.appliesToActor ? sql`TRUE`
    : sql`(${sql.unsafe(columns.goal)} = ${selection.goalId} OR ${ref} = ANY(${selection.attributed}::text[]))`;
  const predicates = selections.map((selection) => sql`(NOT COALESCE(${applies(selection)}, false)
    OR ${plan} IS NULL OR ${ref} = ANY(${selection.selected}::text[]))`);
  const admission = predicates.reduce((result, predicate) => sql`(${result} AND ${predicate})`, sql`TRUE`);
  // A self-reclaim refreshes the current atomic unit; a transfer is NEW work.
  const where = columns.holder && assignee
    ? sql`(${sql.unsafe(columns.holder)} = ${assignee} OR ${admission})` : admission;
  const ranks = selections.map((selection) => sql`CASE WHEN ${applies(selection)}
    THEN array_position(${selection.ordered}::text[], ${ref}) ELSE NULL END`);
  const joinedRanks = ranks.slice(1).reduce((result, rank) => sql`${result}, ${rank}`, ranks[0] ?? sql`NULL`);
  const order = ranks.length ? sql`LEAST(${joinedRanks}) ASC NULLS LAST,` : sql``;
  return { where, order };
}

/** JSONB columns come back parsed on some driver configs and as raw text on
 *  others — normalize to an object (the columns are NOT NULL DEFAULT '{}'). */
function asDoc(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export type PropertySchemaDeclarationCheck =
  | { ok: true; declared: string[] }
  | { ok: false; issues: string[] };

/**
 * Validate a `property_schema` DECLARATION document: shape (zod), every
 * datatype ref resolves in this workspace's `datatype_registry`, and every
 * declared `default` satisfies its datatype's `payload_schema`.
 *
 * The declare-time gate for every creation seam (goals:create / goals:start /
 * plans:new) — the same validated-on-declare rule the IO schemas ship (714):
 * a declaration stored unresolvable could not be checked at write time, and
 * the write door must never render "could not check" as "anything goes".
 */
export async function validatePropertySchemaDeclaration(
  sql: SqlLike,
  workspaceId: string,
  doc: unknown,
): Promise<PropertySchemaDeclarationCheck> {
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  }
  const issues: string[] = [];
  for (const [name, def] of Object.entries(parsed.data)) {
    if (def.datatype === ORDERED_SELECTION_POLICY_DATATYPE) {
      await ensureOrderedSelectionPolicyDatatype(sql, workspaceId);
      if (def.default !== undefined) {
        const policy = OrderedSelectionPolicySchema.safeParse(def.default);
        if (!policy.success) issues.push(`${name}: invalid ordered-selection-policy default`);
      }
    }
    const dt = await getDatatype(sql, workspaceId, def.datatype);
    if (!dt) {
      issues.push(
        `${name}: unknown datatype '${def.datatype}' — not in datatype_registry for this workspace (declare it via meta:define-datatype first)`,
      );
      continue;
    }
    if (def.default !== undefined) {
      const check = checkAgainstJsonSchema(dt.payloadSchema, def.default);
      if (!check.ok) {
        issues.push(`${name}: default does not satisfy datatype '${def.datatype}': ${check.errors.join('; ')}`);
      }
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, declared: Object.keys(parsed.data) };
}

/** Add declarations on an existing goal without replacing its property values. */
export async function extendGoalPropertySchema(
  sql: SqlLike,
  args: { workspaceId: string; goalId: string; patch: unknown; expected: unknown },
): Promise<{ ok: true; propertySchema: Record<string, unknown> } |
  { ok: false; code: 'not_found' | 'stale_schema' | 'invalid_schema' | 'owner_policy_declaration'; issues?: string[] }> {
  const [row] = await sql<Array<{ property_schema: unknown }>>`
    SELECT property_schema FROM harness_shared.goals
     WHERE workspace_id = ${args.workspaceId} AND id = ${args.goalId} FOR UPDATE`;
  if (!row) return { ok: false, code: 'not_found' };
  const current = asDoc(row.property_schema);
  if (!isDeepStrictEqual(current, args.expected)) return { ok: false, code: 'stale_schema' };
  if (args.patch === null || typeof args.patch !== 'object' || Array.isArray(args.patch)) {
    return { ok: false, code: 'invalid_schema', issues: ['schema patch must be an object'] };
  }
  const patch = asDoc(args.patch);
  for (const [key, raw] of Object.entries(patch)) {
    const definition = asDoc(raw);
    const prior = asDoc(current[key]);
    // Declarations cannot be used as a second owner-policy writer. Existing
    // owner contracts and collection metadata are immutable on this extension
    // door; actual owner choices use the canonical value/CAS/provenance writer.
    if ((prior.editable_by === 'owner' || prior.collection) && !isDeepStrictEqual(prior, definition)) {
      return { ok: false, code: 'owner_policy_declaration' };
    }
    if (definition.datatype === ORDERED_SELECTION_POLICY_DATATYPE && current[key] === undefined &&
        !isDeepStrictEqual(definition.default ?? { order: [], excluded: [] }, { order: [], excluded: [] })) {
      return { ok: false, code: 'owner_policy_declaration' };
    }
    if (definition.collection && current[key] !== undefined) {
      const { collection: _collection, ...base } = definition;
      if (!isDeepStrictEqual(base, prior)) return { ok: false, code: 'owner_policy_declaration' };
    }
  }
  const propertySchema = { ...current, ...patch };
  const checked = await validatePropertySchemaDeclaration(sql, args.workspaceId, propertySchema);
  if (!checked.ok) return { ok: false, code: 'invalid_schema', issues: checked.issues };
  await sql`UPDATE harness_shared.goals SET property_schema = ${JSON.stringify(propertySchema)}::jsonb,
    updated_at = now() WHERE workspace_id = ${args.workspaceId} AND id = ${args.goalId}`;
  return { ok: true, propertySchema };
}

/** Validate one VALUE against a datatype's registered payload_schema. */
async function validateValueForDatatype(
  sql: SqlLike,
  workspaceId: string,
  datatype: string,
  value: unknown,
): Promise<{ ok: true } | { ok: false; issues: string[] }> {
  const dt = await getDatatype(sql, workspaceId, datatype);
  if (!dt) {
    return {
      ok: false,
      issues: [`unknown datatype '${datatype}' — not in datatype_registry for this workspace`],
    };
  }
  // A datatype with no payload_schema constrains nothing (checkAgainstJsonSchema
  // treats null/empty as "no constraint declared").
  const check = checkAgainstJsonSchema(dt.payloadSchema, value);
  if (check.ok) return { ok: true };
  return { ok: false, issues: check.errors };
}

export type TypedPropertyWriteResult = { ok: false; code: 'not_found' } | TypedPropertyMutationResult;

export interface TypedPropertyWriteArgs {
  reason?: string;
  workspaceId: string;
  property: string;
  value: unknown;
  /** CAS guard — the version the caller last read; 0 = "no explicit value yet". */
  expectedVersion: number;
  /** Explicit destructive opt-in for an authoritative array-length reduction. */
  confirmShrink?: boolean;
  provenance: PropertyEditProvenance;
  actorId: string;
}

/**
 * Run the shared prepare over one row's (property_schema, properties) pair.
 * The ONE datatype this write can touch is pre-resolved here so the pure
 * core's injected validator stays synchronous.
 */
async function runPreparedMutation(
  sql: SqlLike,
  args: TypedPropertyWriteArgs,
  row: { property_schema: unknown; properties: unknown },
): Promise<TypedPropertyMutationResult> {
  const schemaDoc = asDoc(row.property_schema);
  const propsDoc = asDoc(row.properties);
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(schemaDoc);
  const datatypeRef = parsed.success ? parsed.data[args.property]?.datatype : undefined;
  if (datatypeRef === ORDERED_SELECTION_POLICY_DATATYPE) {
    await ensureOrderedSelectionPolicyDatatype(sql, args.workspaceId);
  }
  const resolved = datatypeRef
    ? await validateValueForDatatype(sql, args.workspaceId, datatypeRef, args.value)
    : null; // unknown property / bad schema — prepare refuses before validate runs
  return prepareTypedPropertyMutation({
    propertySchema: schemaDoc,
    properties: propsDoc,
    property: args.property,
    value: args.value,
    expectedVersion: args.expectedVersion,
    confirmShrink: args.confirmShrink,
    provenance: args.provenance,
    actorId: args.actorId,
    reason: args.reason,
    validate: () => (resolved === null || resolved.ok ? { ok: true } : { ok: false, issues: resolved.issues }),
  });
}

/**
 * The `goals:set-property` write cycle: lock the goal row, decide via the pure
 * core, persist the merged `properties` document. Caller supplies a tx.
 */
export async function applyGoalPropertyWrite(
  sql: SqlLike,
  args: TypedPropertyWriteArgs & { goalId: string },
): Promise<TypedPropertyWriteResult> {
  const rows = await sql<Array<{ property_schema: unknown; properties: unknown }>>`
    SELECT property_schema, properties
      FROM harness_shared.goals
     WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}
     FOR UPDATE`;
  if (!rows[0]) return { ok: false, code: 'not_found' };
  // Goals created before the canonical worklist seed still have no declaration.
  // Repair at the existing write boundary, under the same row lock as CAS, so
  // they can enter the placement worklist without a privileged data patch.
  // A custom declaration remains authoritative, including owner-only editing.
  const schema = asDoc(rows[0].property_schema);
  const worklistWrite = args.property === CANONICAL_WORKLIST_PROPERTY;
  const seedWorklist =
    worklistWrite && !Object.prototype.hasOwnProperty.call(schema, CANONICAL_WORKLIST_PROPERTY);
  const propertySchema = seedWorklist ? withCanonicalWorklistDeclaration(schema) : schema;
  if (worklistWrite) {
    const parsed = TypedPropertySchemaDocumentSchema.safeParse(propertySchema);
    if (
      parsed.success &&
      parsed.data[CANONICAL_WORKLIST_PROPERTY]?.datatype === PLAN_REF_LIST_DATATYPE
    ) {
      await ensurePlanRefListDatatype(sql, args.workspaceId);
    }
  }
  const result = await runPreparedMutation(sql, args, { ...rows[0], property_schema: propertySchema });
  if (!result.ok) return result;
  await sql`
    UPDATE harness_shared.goals
       SET properties = ${JSON.stringify(result.properties)}::text::jsonb,
           property_schema = CASE WHEN ${seedWorklist}
             THEN ${JSON.stringify(propertySchema)}::text::jsonb ELSE property_schema END,
           updated_at = now()
     WHERE id = ${args.goalId} AND workspace_id = ${args.workspaceId}`;
  return result;
}

/**
 * The `plans:set-property` write cycle — identical contract on the
 * `harness_plans` row (PK workspace_id, harness_slug, plan_slug).
 */
export async function applyPlanPropertyWrite(
  sql: SqlLike,
  args: TypedPropertyWriteArgs & { harnessSlug: string; planSlug: string },
): Promise<TypedPropertyWriteResult> {
  const rows = await sql<Array<{ property_schema: unknown; properties: unknown }>>`
    SELECT property_schema, properties
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug}
     FOR UPDATE`;
  if (!rows[0]) return { ok: false, code: 'not_found' };
  const result = await runPreparedMutation(sql, args, rows[0]);
  if (!result.ok) return result;
  await sql`
    UPDATE harness_shared.harness_plans
       SET properties = ${JSON.stringify(result.properties)}::text::jsonb,
           updated_at = now()
     WHERE workspace_id = ${args.workspaceId} AND harness_slug = ${args.harnessSlug}
       AND plan_slug = ${args.planSlug}`;
  return result;
}

/**
 * Read one row's property surface as the shape every reader wants: the raw
 * declaration + envelopes, plus the EFFECTIVE value per declared property
 * (stored value, else the declaration's default) so no caller re-derives the
 * fallback rule. Returns null when the row is absent.
 */
export function derivePropertySurface(row: { property_schema: unknown; properties: unknown }): {
  propertySchema: Record<string, unknown>;
  properties: Record<string, unknown>;
  effective: Record<string, unknown>;
} {
  const schemaDoc = asDoc(row.property_schema);
  const propsDoc = asDoc(row.properties);
  const effective: Record<string, unknown> = {};
  const parsed = TypedPropertySchemaDocumentSchema.safeParse(schemaDoc);
  if (parsed.success) {
    for (const [name, def] of Object.entries(parsed.data)) {
      const stored = propsDoc[name] as { value?: unknown } | undefined;
      effective[name] = stored && typeof stored === 'object' && 'value' in stored ? stored.value : def.default;
    }
  }
  return { propertySchema: schemaDoc, properties: propsDoc, effective };
}
