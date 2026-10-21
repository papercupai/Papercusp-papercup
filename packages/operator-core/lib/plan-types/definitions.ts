/**
 * Item-type and plan-type definitions, schema version 1
 * (plan-item-types-registry-cupboard-2026-10-20 P-001, D-001).
 *
 * The model follows tools and packs:
 * - An ITEM TYPE is the atom: one kind of plan step, the verification modules it is held to,
 *   its completion fields and its criteria. Plans and plan types depend on it by id.
 * - A PLAN TYPE declares the item types it uses, by id and revision range. It also names its
 *   base (the coding/general verification profile it replaces), the acceptance plan classes
 *   it admits, and the item type an item gets when it declares none.
 *
 * Definitions are DECLARATIVE ONLY (D-003). They compose the existing verification modules
 * and declarative checks, and never carry executable code.
 *
 * Ids are namespaced (`papercusp/code`, `acme/legal-review`). The `papercusp/` namespace is
 * first-party: its definitions live in `builtin-catalog.ts`, and migration 1541 refuses a
 * registry row in it. Revisions are positive integers, as for rubrics, so a range is a plain
 * min/max comparison.
 *
 * Validation here is about SHAPE, plus one platform floor that every write path shares: no
 * item type may drop the generic-core checks (R-9, `validateDefinitionFloor`). An absent
 * `modules` field means generic-core alone; a listed set that leaves generic-core out is
 * REFUSED, not repaired, so what an author wrote is what gets stored. Define (P-005), pack
 * install (P-006) and the registry loader (raw rows) all go through `parseItemTypeDefinition`.
 * A plan type carries no module list (its items resolve through item types), so the strict
 * plan-type schema refuses any attempt to declare one. Floors that compare a definition with
 * another (an `extends` parent, a pinned revision) belong to the authoring tools (P-005).
 */
import { z } from 'zod';
import { VERIFICATION_MODULES, type VerificationModule } from './verification-modules';

export const TYPE_DEFINITION_SCHEMA_VERSION = 1 as const;

/** The first-party namespace. Only `builtin-catalog.ts` defines types in it. */
export const FIRST_PARTY_NAMESPACE = 'papercusp' as const;

/**
 * `<namespace>/<name>`: lowercase letters, digits and inner hyphens in each segment. The same
 * grammar as migration 1541's CHECK, so a definition this accepts is a row the DB accepts.
 */
export const TYPE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

export function isTypeId(value: unknown): value is string {
  return typeof value === 'string' && TYPE_ID_PATTERN.test(value);
}

export function isFirstPartyTypeId(id: string): boolean {
  return id.startsWith(`${FIRST_PARTY_NAMESPACE}/`);
}

const typeIdSchema = z.string().regex(TYPE_ID_PATTERN, 'a type id is <namespace>/<name> in lowercase, e.g. acme/legal-review');
const revisionSchema = z.number().int().min(1);
const moduleSchema = z.enum(VERIFICATION_MODULES);

/** The module no definition may drop (R-9): the generic checks every plan item is held to. */
export const FLOOR_MODULE = 'generic-core' as const satisfies VerificationModule;

/** A reference to an item type: an exact revision, a range, or (both bounds absent) the latest. */
export const typeReferenceSchema = z
  .object({
    id: typeIdSchema,
    minRevision: revisionSchema.optional(),
    maxRevision: revisionSchema.optional(),
  })
  .strict()
  .refine((ref) => ref.minRevision === undefined || ref.maxRevision === undefined || ref.minRevision <= ref.maxRevision, {
    message: 'minRevision must not exceed maxRevision',
  });
export type TypeReference = z.infer<typeof typeReferenceSchema>;

const displaySchema = z
  .object({
    label: z.string().min(1).max(60).optional(),
    icon: z.string().min(1).max(60).optional(),
    color: z.string().min(1).max(30).optional(),
  })
  .strict();

/** Completion fields: an inline JSON Schema, or a reference to a registered datatype. */
const completionSchema = z.union([
  z.object({ schema: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ datatypeRef: z.string().min(1) }).strict(),
]);

/** A declarative check: a named check kind plus its parameters. Never code. */
const declarativeCheckSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * How the bar a criterion seeds is verified (D-011): the METHOD, an optional declarative check
 * and an optional replication note. A distributed type carries it so the bars it seeds arrive
 * gradable instead of each installing pot amending every bar by hand. The check keeps this
 * module's own `{ kind, params }` shape; the pack installer and the seed validate it as a
 * declarative rubric check.
 */
const criterionVerificationSchema = z
  .object({
    method: z.string().trim().min(1).max(4000),
    check: declarativeCheckSchema.optional(),
    replication: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();

const criterionTemplateSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    verification: criterionVerificationSchema.optional(),
  })
  .strict();

export const itemTypeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(TYPE_DEFINITION_SCHEMA_VERSION),
    id: typeIdSchema,
    revision: revisionSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    /** The item type this one refines. The authoring tools (P-005) resolve and floor it. */
    extends: typeReferenceSchema.optional(),
    /**
     * Verification modules. Absent means generic-core alone; a listed set must name
     * generic-core (`validateDefinitionFloor`), which can never be dropped.
     */
    modules: z.array(moduleSchema).default([FLOOR_MODULE]),
    completion: completionSchema.optional(),
    /** Citation kinds that may verify an item of this type, e.g. code, test, artifact. */
    citations: z.array(z.string().min(1)).optional(),
    /** The work-item kind promoted for an item of this type. */
    workItemKind: z.string().min(1).optional(),
    criteriaTemplate: z.array(criterionTemplateSchema).optional(),
    rubricRef: z.string().min(1).optional(),
    checks: z.array(declarativeCheckSchema).optional(),
    display: displaySchema.optional(),
  })
  .strict();
export type ItemTypeDefinition = z.infer<typeof itemTypeDefinitionSchema>;
export type ItemTypeDefinitionInput = z.input<typeof itemTypeDefinitionSchema>;

/** The base a plan type builds on: the coding or general verification profile it replaces. */
export const PLAN_TYPE_BASES = ['coding', 'general'] as const;
export type PlanTypeBase = (typeof PLAN_TYPE_BASES)[number];

export const planTypeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(TYPE_DEFINITION_SCHEMA_VERSION),
    id: typeIdSchema,
    revision: revisionSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(4000).default(''),
    base: z.enum(PLAN_TYPE_BASES),
    /**
     * The acceptance plan classes this plan type admits (each names a class rubric). The plan
     * design wrote one `class`; a profile admits several (coding: feature-ship, bugfix and
     * migration), so a plan type carries the list and the plan picks one at activation.
     */
    classes: z.array(z.string().min(1)).min(1),
    /** The item type an item gets when it declares none. Must be one of `itemTypes`. */
    defaultItemType: typeReferenceSchema,
    /** The item types this plan type references, by id and revision range. */
    itemTypes: z.array(typeReferenceSchema).min(1),
    /** When true, a plan of this type may only use `itemTypes`. */
    restrictItemTypes: z.boolean().optional(),
    requiredSections: z.array(z.string().min(1)).optional(),
    display: displaySchema.optional(),
  })
  .strict()
  .refine((def) => def.itemTypes.some((ref) => ref.id === def.defaultItemType.id), {
    message: 'defaultItemType must be one of itemTypes',
    path: ['defaultItemType'],
  })
  .refine((def) => new Set(def.itemTypes.map((ref) => ref.id)).size === def.itemTypes.length, {
    message: 'itemTypes must not reference the same item type twice',
    path: ['itemTypes'],
  });
export type PlanTypeDefinition = z.infer<typeof planTypeDefinitionSchema>;
export type PlanTypeDefinitionInput = z.input<typeof planTypeDefinitionSchema>;

/** Modules in catalog order, with generic-core always first and no duplicates. */
export function normalizeModules(modules: readonly VerificationModule[]): VerificationModule[] {
  const wanted = new Set<VerificationModule>(['generic-core', ...modules]);
  return VERIFICATION_MODULES.filter((module) => wanted.has(module));
}

export type DefinitionParse<T> = { ok: true; definition: T } | { ok: false; issues: string[] };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/**
 * The generic-core floor (R-9): the issues that refuse a module set leaving generic-core out,
 * or none. It judges the set AS WRITTEN, before `normalizeModules` would add generic-core back,
 * so a definition that drops it is refused rather than silently stored as something else.
 */
export function validateDefinitionFloor(definition: { modules: readonly string[] }): string[] {
  if (definition.modules.includes(FLOOR_MODULE)) return [];
  return [`modules: must include ${FLOOR_MODULE}; no item type may drop the generic-core checks`];
}

/**
 * Validate an item-type definition, hold it to the generic-core floor and normalize its module
 * set. The one gate define (P-005), pack install (P-006) and the registry loader share.
 */
export function parseItemTypeDefinition(input: unknown): DefinitionParse<ItemTypeDefinition> {
  const parsed = itemTypeDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  const floor = validateDefinitionFloor(parsed.data);
  if (floor.length > 0) return { ok: false, issues: floor };
  return { ok: true, definition: { ...parsed.data, modules: normalizeModules(parsed.data.modules) } };
}

export function parsePlanTypeDefinition(input: unknown): DefinitionParse<PlanTypeDefinition> {
  const parsed = planTypeDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: issuesOf(parsed.error) };
  return { ok: true, definition: parsed.data };
}

/** Whether a revision satisfies a reference's range. */
export function referenceAdmits(ref: TypeReference, revision: number): boolean {
  return (ref.minRevision === undefined || revision >= ref.minRevision)
    && (ref.maxRevision === undefined || revision <= ref.maxRevision);
}
