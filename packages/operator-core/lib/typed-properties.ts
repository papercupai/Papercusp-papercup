/**
 * Typed goal/plan property contract (work-on-everything-goal-2026-08-23 P-023).
 *
 * Declarations live in an owning row's `property_schema`; values, CAS versions,
 * and provenance live together in its ONE `properties` jsonb document. The
 * datatype registry remains the shape authority — callers inject the resolved
 * datatype validator rather than duplicating JSON-Schema compilation here.
 */

import { z } from 'zod';
import { VALID_PLAN_SLUG } from './agent-tools/plans/run-instance-slug';
import type { RefusalContract } from './capability-envelope/refusal-contract-types';

export const PROPERTY_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export const ORDERED_SELECTION_POLICY_DATATYPE = 'ordered-selection-policy';
// Keep the namespace qualification while accepting the exact plan keys the
// platform mints, including scheduled instances. One run must not poison the pool.
export const QUALIFIED_COLLECTION_PLAN_REF = new RegExp(
  `^plan:[a-z0-9][a-z0-9._-]*/(?:${VALID_PLAN_SLUG.source.slice(1, -1)})$`,
);

const collectionItemId = z.string().min(1).max(400);
const uniqueItemIds = z.array(collectionItemId).max(10_000)
  .refine((ids) => new Set(ids).size === ids.length, 'collection item ids must be unique');

/** Owner preferences retain dormant ids when their source disappears. */
export const OrderedSelectionPolicySchema = z.object({
  order: uniqueItemIds,
  excluded: uniqueItemIds,
  /** Explicit reselection when the collection starts unchecked. */
  included: uniqueItemIds.optional(),
}).strict();
export type OrderedSelectionPolicy = z.infer<typeof OrderedSelectionPolicySchema>;

/** The registry uses the existing JSON-Schema validator, with the same shape as the pure writer. */
export function orderedSelectionPolicyPayloadSchema(): Record<string, unknown> {
  const ids = { type: 'array', maxItems: 10_000, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 400 } };
  return { type: 'object', required: ['order', 'excluded'], additionalProperties: false,
    properties: { order: ids, excluded: ids, included: ids } };
}

/** Opt-in metadata; source data and owner policy remain separate properties. */
export const TypedPropertyCollectionSchema = z.object({
  source: z.enum(['manual', 'active-workspace-plans']),
  policy: z.string().regex(PROPERTY_NAME),
  order: z.enum(['display', 'priority']),
  selectable: z.boolean(),
  defaultSelected: z.boolean(),
}).strict();
export type TypedPropertyCollection = z.infer<typeof TypedPropertyCollectionSchema>;

export const PropertyEditableBySchema = z.enum(['owner', 'agent', 'both']);
export type PropertyEditableBy = z.infer<typeof PropertyEditableBySchema>;

export const TypedPropertyDefinitionSchema = z
  .object({
    datatype: z.string().min(1).max(120),
    default: z.unknown().optional(),
    editable_by: PropertyEditableBySchema,
    collection: TypedPropertyCollectionSchema.optional(),
  })
  .strict();
export type TypedPropertyDefinition = z.infer<typeof TypedPropertyDefinitionSchema>;

export const TypedPropertySchemaDocumentSchema = z
  .record(z.string().regex(PROPERTY_NAME), TypedPropertyDefinitionSchema)
  .refine((document) => Object.keys(document).length <= 100, 'at most 100 properties may be declared')
  .superRefine((document, ctx) => {
    for (const [name, definition] of Object.entries(document)) {
      if (definition.datatype === ORDERED_SELECTION_POLICY_DATATYPE &&
          (definition.editable_by !== 'owner' || (definition.default !== undefined &&
            !OrderedSelectionPolicySchema.safeParse(definition.default).success))) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name],
          message: 'ordered-selection-policy must be owner-only with a valid policy default' });
      }
      const collection = definition.collection;
      if (!collection) continue;
      const policy = document[collection.policy];
      if (collection.policy === name || !policy || policy.collection ||
          policy.datatype !== ORDERED_SELECTION_POLICY_DATATYPE || policy.editable_by !== 'owner') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'collection', 'policy'],
          message: 'collection policy must reference a separate owner-only ordered-selection-policy property' });
      }
      if (collection.source === 'active-workspace-plans' && definition.datatype !== 'plan-ref-list') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'datatype'],
          message: 'active-workspace-plans requires the plan-ref-list datatype' });
      }
      if (collection.source === 'active-workspace-plans' && policy?.default !== undefined) {
        const preferences = OrderedSelectionPolicySchema.safeParse(policy.default);
        if (preferences.success && [...preferences.data.order, ...preferences.data.excluded,
          ...(preferences.data.included ?? [])]
            .some((id) => !QUALIFIED_COLLECTION_PLAN_REF.test(id))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [collection.policy, 'default'],
            message: 'active plan policy defaults require qualified plan:<harness>/<slug> refs' });
        }
      }
      if (definition.default !== undefined) {
        const ids = uniqueItemIds.safeParse(definition.default);
        if (!ids.success || (collection.source === 'active-workspace-plans' &&
            ids.data.some((id) => !QUALIFIED_COLLECTION_PLAN_REF.test(id)))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'default'],
            message: 'collection defaults must be unique item ids; active plans require qualified plan:<harness>/<slug> refs' });
        }
      }
    }
  });
export type TypedPropertySchemaDocument = z.infer<typeof TypedPropertySchemaDocumentSchema>;

export const PropertyEditProvenanceSchema = z.enum(['owner-edit', 'agent-edit']);
export type PropertyEditProvenance = z.infer<typeof PropertyEditProvenanceSchema>;

export const StoredTypedPropertySchema = z
  .object({
    value: z.unknown(),
    version: z.number().int().positive(),
    edited_at: z.string().datetime(),
    edited_by: z.string().min(1).max(200),
    provenance: PropertyEditProvenanceSchema,
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type StoredTypedProperty = z.infer<typeof StoredTypedPropertySchema>;

export const StoredTypedPropertiesSchema = z.record(z.string(), StoredTypedPropertySchema);
export type StoredTypedProperties = z.infer<typeof StoredTypedPropertiesSchema>;

export type TypedPropertyCollectionRead =
  | { ok: true; configured: false }
  | { ok: false; configured: true; reason: string }
  | {
      ok: true;
      configured: true;
      collection: TypedPropertyCollection;
      policy: OrderedSelectionPolicy;
      policyVersion: number;
      items: Array<{ id: string; selected: boolean }>;
      selected: string[];
      /**
       * True when no owner policy is saved yet and the effective policy was
       * derived from the stored collection list ("only plans I pick" starts
       * from the saved worklist). Nothing was written; the first owner apply
       * persists exactly this policy at expectedVersion 0.
       */
      seededFromList?: true;
    };

/**
 * One effective selection for every opted-in collection. A registered source
 * adapter supplies ids; this function never discovers, persists or admits work.
 * Owner order/exclusions survive absent items, while newly seen ids append in
 * source order. Domain blocking reasons belong to the consumer, not this policy.
 */
export function readTypedPropertyCollection(args: {
  propertySchema: unknown;
  properties: unknown;
  property: string;
  source?: { ok: true; items: readonly string[] } | { ok: false; reason: string };
}): TypedPropertyCollectionRead {
  const schema = TypedPropertySchemaDocumentSchema.safeParse(args.propertySchema ?? {});
  if (!schema.success) return { ok: false, configured: true, reason: 'invalid collection declaration' };
  const definition = schema.data[args.property];
  const collection = definition?.collection;
  if (!collection) return { ok: true, configured: false };
  if (args.properties != null && (typeof args.properties !== 'object' || Array.isArray(args.properties))) {
    return { ok: false, configured: true, reason: 'invalid stored property document' };
  }
  const properties = args.properties && typeof args.properties === 'object' && !Array.isArray(args.properties)
    ? args.properties as Record<string, unknown> : {};
  const policyDefinition = schema.data[collection.policy];
  const policyEntry = properties[collection.policy] === undefined ? null
    : StoredTypedPropertySchema.safeParse(properties[collection.policy]);
  if (policyEntry && (!policyEntry.success || policyEntry.data.provenance !== 'owner-edit')) {
    return { ok: false, configured: true, reason: 'owner policy envelope is invalid or not owner-authored' };
  }
  const policy = OrderedSelectionPolicySchema.safeParse(policyEntry?.success ? policyEntry.data.value
    : policyDefinition.default ?? { order: [], excluded: [] });
  if (!policy.success) return { ok: false, configured: true, reason: 'invalid owner selection policy' };
  if (args.source?.ok === false) return { ok: false, configured: true, reason: args.source.reason };
  if (collection.source !== 'manual' && !args.source) {
    return { ok: false, configured: true, reason: 'registered collection source is unavailable' };
  }
  const sourceEntry = properties[args.property] === undefined ? null
    : StoredTypedPropertySchema.safeParse(properties[args.property]);
  if (!args.source && sourceEntry && !sourceEntry.success) {
    return { ok: false, configured: true, reason: 'invalid manual collection envelope' };
  }
  const ids = z.array(collectionItemId).max(10_000).safeParse(args.source?.items ??
    (sourceEntry?.success ? sourceEntry.data.value : definition.default ?? []));
  if (!ids.success) return { ok: false, configured: true, reason: 'invalid collection item ids' };
  const seed = seedPolicyFromStoredList({ collection, policy: policy.data, saved: policyEntry !== null,
    stored: args.source && sourceEntry?.success ? sourceEntry.data.value : undefined, available: ids.data });
  const effective = seed ?? policy.data;
  if (collection.source === 'active-workspace-plans' &&
      [...ids.data, ...effective.order, ...effective.excluded, ...(effective.included ?? [])]
        .some((id) => !QUALIFIED_COLLECTION_PLAN_REF.test(id))) {
    return { ok: false, configured: true, reason: 'active plan collections require qualified plan refs' };
  }
  const available = new Set(ids.data);
  const ordered = [...new Set([...effective.order.filter((id) => available.has(id)), ...ids.data])];
  const excluded = new Set(effective.excluded);
  const included = new Set(effective.included ?? []);
  const items = ordered.map((id) => ({ id, selected: !collection.selectable ||
    (!excluded.has(id) && (collection.defaultSelected || included.has(id))) }));
  return { ok: true, configured: true, collection, policy: effective,
    policyVersion: policyEntry?.success ? policyEntry.data.version : 0,
    items, selected: items.filter((item) => item.selected).map((item) => item.id),
    ...(seed ? { seededFromList: true as const } : {}) };
}

/**
 * "Only plans I pick" for a registered-source collection: when it declares
 * `defaultSelected:false`, no owner policy is saved yet, and the declaration's
 * default policy names no explicit picks, the stored collection list (for a
 * goal worklist, the saved `worklist` value) is the starting pick list. It is a
 * DERIVATION, never a write: provenance stays honest, and the owner's first
 * apply persists exactly this policy. Unqualified legacy refs resolve to the one
 * available id with the same slug, otherwise they are dropped from the seed.
 */
function seedPolicyFromStoredList(args: {
  collection: TypedPropertyCollection;
  policy: OrderedSelectionPolicy;
  saved: boolean;
  stored: unknown;
  available: readonly string[];
}): OrderedSelectionPolicy | null {
  const { collection, policy } = args;
  if (args.saved || collection.source === 'manual' || collection.defaultSelected || !collection.selectable ||
      policy.included !== undefined || !Array.isArray(args.stored)) return null;
  const resolve = (ref: unknown): string | null => {
    if (typeof ref !== 'string' || !ref) return null;
    if (collection.source !== 'active-workspace-plans' || QUALIFIED_COLLECTION_PLAN_REF.test(ref)) return ref;
    const slug = ref.startsWith('plan:') && !ref.includes('/') ? ref.slice('plan:'.length) : null;
    const matches = slug ? args.available.filter((id) => id.endsWith(`/${slug}`)) : [];
    return matches.length === 1 ? matches[0] : null;
  };
  const excluded = new Set(policy.excluded);
  const picks = [...new Set(args.stored.map(resolve).filter((id): id is string => id !== null))]
    .filter((id) => !excluded.has(id));
  return { order: [...picks, ...policy.order.filter((id) => !picks.includes(id))],
    excluded: [...policy.excluded], included: picks };
}

export type TypedPropertyMutationFailure =
  | { ok: false; code: 'bad_property_schema'; issues: string[] }
  | { ok: false; code: 'bad_properties'; issues: string[] }
  | { ok: false; code: 'unknown_property'; property: string }
  | {
      ok: false;
      code: 'forbidden';
      property: string;
      editableBy: PropertyEditableBy;
      refusal: RefusalContract;
    }
  | { ok: false; code: 'stale'; property: string; expectedVersion: number; actualVersion: number }
  | { ok: false; code: 'invalid_value'; property: string; datatype: string; issues: string[] }
  | {
      ok: false;
      code: 'shrink_blocked';
      property: string;
      priorLength: number;
      proposedLength: number;
      actualVersion: number;
      recovery: { confirmShrink: true };
      refusal: RefusalContract;
    };

export type TypedPropertyMutationResult =
  | TypedPropertyMutationFailure
  | {
      ok: true;
      definition: TypedPropertyDefinition;
      priorValue: unknown;
      priorVersion: number;
      entry: StoredTypedProperty;
      properties: StoredTypedProperties;
    };

export interface PrepareTypedPropertyMutationArgs {
  propertySchema: unknown;
  properties: unknown;
  property: string;
  value: unknown;
  expectedVersion: number;
  /**
   * Explicitly confirms that an array-length reduction is intentional.
   *
   * Typed-property values are whole replacements. A caller that received a
   * result-door-trimmed array otherwise cannot distinguish its excerpt from
   * the authoritative list, so every reduction fails closed unless the caller
   * opts into the destructive path after a complete read.
   */
  confirmShrink?: boolean;
  provenance: PropertyEditProvenance;
  actorId: string;
  editedAt?: string;
  /** Owner's explanation, persisted atomically with the versioned value. */
  reason?: string;
  /** Validate against the definition's datatype_registry payload_schema. */
  validate: (datatype: string, value: unknown) => { ok: true } | { ok: false; issues: string[] };
}

const issuesOf = (error: z.ZodError): string[] =>
  error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);

/**
 * Pure CAS + authorization + datatype-validation decision shared by both write
 * doors. `expectedVersion: 0` means "the property has no explicit value yet"
 * (its declaration's default, if any, is the effective prior value).
 */
/** Clip one value for a delta line — short JSON, never a paragraph. */
const shortValue = (v: unknown): string => {
  if (v === undefined) return '∅';
  let s: string;
  try {
    s = JSON.stringify(v) ?? 'undefined';
  } catch {
    s = String(v);
  }
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
};

/**
 * Render ONE property write as the human-readable delta line the owning
 * agent's orient/wake fold shows (`worklist: +"docs sweeps" −"perf"`).
 *
 * Pure — rides the plan-events envelope's `detail` field, which the orient
 * fold already passes through verbatim, so no render code exists downstream.
 * Arrays of scalars diff element-wise (+added −removed, insertion order);
 * everything else renders `prior → next` with values clipped to one line.
 */
export function renderPropertyDelta(property: string, prior: unknown, next: unknown): string {
  const scalarArray = (v: unknown): v is Array<string | number | boolean | null> =>
    Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
  if (scalarArray(next) && (prior === undefined || prior === null || scalarArray(prior))) {
    const before = new Set((scalarArray(prior) ? prior : []).map(shortValue));
    const after = new Set(next.map(shortValue));
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));
    if (added.length > 0 || removed.length > 0) {
      const parts = [...added.map((a) => `+${a}`), ...removed.map((r) => `−${r}`)];
      return `${property}: ${parts.join(' ')}`;
    }
    return `${property}: unchanged`;
  }
  return `${property}: ${shortValue(prior)} → ${shortValue(next)}`;
}

export function prepareTypedPropertyMutation(
  args: PrepareTypedPropertyMutationArgs,
): TypedPropertyMutationResult {
  const declaration = TypedPropertySchemaDocumentSchema.safeParse(args.propertySchema ?? {});
  if (!declaration.success) {
    return { ok: false, code: 'bad_property_schema', issues: issuesOf(declaration.error) };
  }
  const stored = StoredTypedPropertiesSchema.safeParse(args.properties ?? {});
  if (!stored.success) {
    return { ok: false, code: 'bad_properties', issues: issuesOf(stored.error) };
  }

  const definition = declaration.data[args.property];
  if (!definition) return { ok: false, code: 'unknown_property', property: args.property };

  const actor = args.provenance === 'owner-edit' ? 'owner' : 'agent';
  if (definition.editable_by !== 'both' && definition.editable_by !== actor) {
    return {
      ok: false,
      code: 'forbidden',
      property: args.property,
      editableBy: definition.editable_by,
      refusal: {
        observed: { property: args.property, editableBy: definition.editable_by, actor, provenance: args.provenance },
        liftsWhen:
          `the edit is made as ${definition.editable_by === 'owner' ? 'an owner-edit' : 'an agent-edit'} ` +
          `(the property declares editable_by=${definition.editable_by}), or the declaration is changed to ` +
          'editable_by=both. Retrying with the same provenance changes nothing',
        whoCanMakeItTrue: definition.editable_by === 'owner' ? ['owner'] : ['another-agent'],
      } satisfies RefusalContract,
    };
  }

  const current = stored.data[args.property];
  const actualVersion = current?.version ?? 0;
  if (args.expectedVersion !== actualVersion) {
    return {
      ok: false,
      code: 'stale',
      property: args.property,
      expectedVersion: args.expectedVersion,
      actualVersion,
    };
  }

  const validation = args.validate(definition.datatype, args.value);
  if (!validation.ok) {
    return {
      ok: false,
      code: 'invalid_value',
      property: args.property,
      datatype: definition.datatype,
      issues: validation.issues,
    };
  }

  // Keep the declared collection semantics strict even if an existing registry
  // row has an unconstrained payload. Never discard a dormant preference merely
  // because the corresponding source item is currently absent.
  const policyConsumers = Object.values(declaration.data)
    .filter((def) => def.collection?.policy === args.property);
  const policy = definition.datatype === ORDERED_SELECTION_POLICY_DATATYPE
    ? OrderedSelectionPolicySchema.safeParse(args.value) : null;
  const ids = definition.collection ? uniqueItemIds.safeParse(args.value) : null;
  const activePlanIds = policy?.success && policyConsumers.some((def) =>
    def.collection?.source === 'active-workspace-plans')
    ? [...policy.data.order, ...policy.data.excluded, ...(policy.data.included ?? [])]
    : ids?.success && definition.collection?.source === 'active-workspace-plans' ? ids.data : [];
  if ((policy && !policy.success) || (ids && !ids.success) ||
      activePlanIds.some((id) => !QUALIFIED_COLLECTION_PLAN_REF.test(id))) {
    return { ok: false, code: 'invalid_value', property: args.property, datatype: definition.datatype,
      issues: policy && !policy.success ? issuesOf(policy.error)
        : ids && !ids.success ? issuesOf(ids.error)
          : ['active plan collections require qualified plan:<harness>/<slug> refs'] };
  }

  const priorValue = current ? current.value : definition.default;
  if (
    args.confirmShrink !== true &&
    Array.isArray(priorValue) &&
    Array.isArray(args.value) &&
    args.value.length < priorValue.length
  ) {
    return {
      ok: false,
      code: 'shrink_blocked',
      property: args.property,
      priorLength: priorValue.length,
      proposedLength: args.value.length,
      actualVersion,
      recovery: { confirmShrink: true },
      refusal: {
        observed: {
          property: args.property,
          priorLength: String(priorValue.length),
          proposedLength: String(args.value.length),
        },
        liftsWhen:
          'the caller resubmits the same value with confirmShrink:true (it asserts the shorter list is ' +
          'intentional), or submits a value at least as long as the stored one',
        whoCanMakeItTrue: ['self'],
      } satisfies RefusalContract,
    };
  }

  const entry: StoredTypedProperty = {
    value: args.value,
    version: actualVersion + 1,
    edited_at: args.editedAt ?? new Date().toISOString(),
    edited_by: args.actorId,
    provenance: args.provenance,
    ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
  };
  return {
    ok: true,
    definition,
    priorValue,
    priorVersion: actualVersion,
    entry,
    properties: { ...stored.data, [args.property]: entry },
  };
}
