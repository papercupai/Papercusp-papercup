/**
 * Authoring item-type and plan-type definitions
 * (plan-item-types-registry-cupboard-2026-10-20 P-005, R-12/R-13/R-14, D-006).
 *
 * The bodies of the plan-types:* tools, exported so the integration tests drive the same code:
 *
 * - define: validate a definition (the schema, the verification-module catalog, the generic-core
 *   floor), require the next revision of its id, require every type it references to resolve,
 *   run the shared shrink check (registry-write-check.ts) and store it AS GIVEN. Get returns the
 *   stored JSON, so a definition reads back unchanged (R-12).
 * - retire: mark one revision retired. A retired revision never resolves for a new reference,
 *   but still resolves, by exact revision, for a plan pinned to it (R-14).
 * - pin: move one plan's pin for one type to another revision. It runs the same shrink check
 *   against that plan.
 * - get / list: read the registry over the built-in catalog.
 *
 * Writes are workspace-wide (hive_slug NULL), which is the scope plans resolve under
 * (`loadPlanTypes` reads the registry without a hive). Definitions are immutable (migration
 * 1545's trigger): a new rule is a new revision.
 */
import type postgres from 'postgres';
import { BUILTIN_CATALOG } from './builtin-catalog';
import { definitionContentHash } from './content-hash';
import {
  isFirstPartyTypeId,
  parseItemTypeDefinition,
  parsePlanTypeDefinition,
  type ItemTypeDefinition,
  type PlanTypeDefinition,
  type TypeReference,
} from './definitions';
import { loadPlanPins, pinsFromRows, type PinRow, type PlanPinScope } from './pins';
import { buildTypeRegistrySnapshot, type DefinitionRow, type TypeRegistrySnapshot } from './registry';
import { checkRegistryWriteLowering, type RegistryWriteRefusal } from './registry-write-check';
import {
  createRegistryVerificationResolver,
  type PlanTypePins,
  type ResolvedTypeRef,
  type TypeKind,
} from './resolve-verification';

type Sql = postgres.Sql | postgres.TransactionSql;

export const TYPE_TABLES = {
  'item-type': 'plan_item_type_definitions',
  'plan-type': 'plan_type_definitions',
} as const satisfies Record<TypeKind, string>;

export interface StoredDefinitionRow extends DefinitionRow {
  created_at: Date | string | null;
  created_by: string | null;
  retired_by: string | null;
  retire_reason: string | null;
}

export interface RegistryRows {
  itemTypeRows: StoredDefinitionRow[];
  planTypeRows: StoredDefinitionRow[];
}

/** Every stored row of both tables in the workspace, retired included. */
export async function readRegistryRows(sql: Sql, workspaceId: string): Promise<RegistryRows> {
  const columns = sql`type_id, revision, hive_slug, definition, origin, source_listing_id, retired_at,
    created_at, created_by, retired_by, retire_reason`;
  const [itemTypeRows, planTypeRows] = await Promise.all([
    sql<StoredDefinitionRow[]>`SELECT ${columns} FROM harness_shared.plan_item_type_definitions
      WHERE workspace_id = ${workspaceId} ORDER BY type_id, revision`,
    sql<StoredDefinitionRow[]>`SELECT ${columns} FROM harness_shared.plan_type_definitions
      WHERE workspace_id = ${workspaceId} ORDER BY type_id, revision`,
  ]);
  return { itemTypeRows, planTypeRows };
}

export function snapshotOf(rows: RegistryRows): TypeRegistrySnapshot {
  return buildTypeRegistrySnapshot({ itemTypeRows: rows.itemTypeRows, planTypeRows: rows.planTypeRows });
}

function rowsOf(rows: RegistryRows, kind: TypeKind): StoredDefinitionRow[] {
  return kind === 'plan-type' ? rows.planTypeRows : rows.itemTypeRows;
}

function withRows(rows: RegistryRows, kind: TypeKind, next: StoredDefinitionRow[]): RegistryRows {
  return kind === 'plan-type' ? { ...rows, planTypeRows: next } : { ...rows, itemTypeRows: next };
}

/** Serialize registry writes for one id, so two defines cannot both take the same revision. */
async function lockTypeId(sql: Sql, workspaceId: string, kind: TypeKind, typeId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`plan-types:${workspaceId}:${kind}:${typeId}`}, 0))`;
}

export type AuthoringRefusalCode =
  | 'definition_invalid'
  | 'first_party_namespace_reserved'
  | 'revision_out_of_order'
  | 'revision_conflict'
  | 'reference_unresolved'
  | 'type_revision_not_found'
  | 'type_revision_already_retired'
  | 'plan_not_found';

export interface AuthoringRefusal {
  ok: false;
  code: AuthoringRefusalCode;
  message: string;
  issues?: string[];
  expectedRevision?: number;
  references?: string[];
}

function refuse(code: AuthoringRefusalCode, message: string, extra: Omit<AuthoringRefusal, 'ok' | 'code' | 'message'> = {}): AuthoringRefusal {
  return { ok: false, code, message, ...extra };
}

function firstPartyRefusal(typeId: string): AuthoringRefusal {
  return refuse(
    'first_party_namespace_reserved',
    `${typeId} is in the first-party papercusp/ namespace, which only the built-in catalog defines. Use your own namespace.`,
  );
}

/**
 * Types a definition references that do not resolve against `registry` (which already holds the
 * definition): an item type's parent chain, or each item type a plan type lists. A reference
 * resolves when the resolver reports resolving that id; an unknown id, a revision range nothing
 * meets, an `extends` cycle or an over-deep chain does not.
 */
export function unresolvedReferences(kind: TypeKind, definition: ItemTypeDefinition | PlanTypeDefinition, registry: TypeRegistrySnapshot): string[] {
  const resolvedIds = (run: (resolver: ReturnType<typeof createRegistryVerificationResolver>) => void): Set<string> => {
    const seen: ResolvedTypeRef[] = [];
    run(createRegistryVerificationResolver(registry, { onResolved: (ref) => seen.push(ref) }));
    return new Set(seen.filter((ref) => ref.kind === 'item-type').map((ref) => `${ref.id}@${ref.revision}`));
  };
  if (kind === 'item-type') {
    const def = definition as ItemTypeDefinition;
    if (!def.extends) return [];
    const resolved = resolvedIds((resolver) => resolver({ verificationProfile: 'general' }, { deliverable: def.id }));
    return resolved.has(`${def.id}@${def.revision}`) ? [] : [describeRef(def.extends)];
  }
  const def = definition as PlanTypeDefinition;
  const missing: string[] = [];
  for (const ref of def.itemTypes) {
    const ids = resolvedIds((resolver) =>
      resolver({ verificationProfile: def.base, planType: def.id }, { deliverable: ref.id }));
    if (![...ids].some((key) => key.startsWith(`${ref.id}@`))) missing.push(describeRef(ref));
  }
  return missing;
}

function describeRef(ref: TypeReference): string {
  const range = ref.minRevision === undefined && ref.maxRevision === undefined
    ? ''
    : ` (revision ${ref.minRevision ?? 1}..${ref.maxRevision ?? 'latest'})`;
  return `${ref.id}${range}`;
}

export interface DefineResult {
  ok: true;
  kind: TypeKind;
  typeId: string;
  revision: number;
  contentHash: string;
  /** The definition exactly as stored; plan-types:get returns this. */
  definition: unknown;
  /** A pack re-install found this exact revision already stored with the same content (no write). */
  unchanged?: true;
}

/**
 * A definition written by a Cupboard type-pack install (P-006, D-008) rather than by
 * plan-types:define. The row records the providing listing (origin 'pack'), and the shared shrink
 * check runs as the 'install' route, so a same-id install is held to the same rule as a define.
 * A pack carries its own revision numbers: a later revision may skip numbers, the same revision
 * with the same content is an idempotent re-install, and the same revision with different content
 * is refused because a stored revision never changes.
 */
export interface PackDefineSource {
  listingId: string;
}

export async function defineTypeDefinition(
  sql: Sql,
  input: { workspaceId: string; kind: TypeKind; definition: unknown; createdBy: string; pack?: PackDefineSource },
): Promise<DefineResult | AuthoringRefusal | RegistryWriteRefusal> {
  const parsed = input.kind === 'plan-type'
    ? parsePlanTypeDefinition(input.definition)
    : parseItemTypeDefinition(input.definition);
  if (!parsed.ok) {
    return refuse('definition_invalid', `The ${input.kind} definition is invalid: ${parsed.issues.join('; ')}`, { issues: parsed.issues });
  }
  const definition = parsed.definition;
  if (isFirstPartyTypeId(definition.id)) return firstPartyRefusal(definition.id);
  await lockTypeId(sql, input.workspaceId, input.kind, definition.id);
  const rows = await readRegistryRows(sql, input.workspaceId);
  const sameId = rowsOf(rows, input.kind).filter((row) => row.type_id === definition.id && row.hive_slug === null);
  const expected = sameId.reduce((max, row) => Math.max(max, Number(row.revision)), 0) + 1;
  if (input.pack) {
    const existing = sameId.find((row) => Number(row.revision) === definition.revision);
    if (existing) {
      const storedHash = definitionContentHash(existing.definition);
      if (storedHash === definitionContentHash(input.definition)) {
        return {
          ok: true,
          kind: input.kind,
          typeId: definition.id,
          revision: definition.revision,
          contentHash: storedHash,
          definition: existing.definition,
          unchanged: true,
        };
      }
      return refuse(
        'revision_conflict',
        `${definition.id} revision ${definition.revision} is already stored with different content. ` +
          'A stored revision never changes; publish the pack with the next revision.',
        { expectedRevision: expected },
      );
    }
    if (definition.revision < expected) {
      return refuse(
        'revision_out_of_order',
        `${definition.id} revision ${definition.revision} is older than the stored revision ${expected - 1}. ` +
          'A pack install never adds a revision below the newest stored one.',
        { expectedRevision: expected },
      );
    }
  } else if (definition.revision !== expected) {
    return refuse(
      'revision_out_of_order',
      `${definition.id} must be defined at revision ${expected}, not ${definition.revision}. ` +
        'A stored revision never changes; define the next one.',
      { expectedRevision: expected },
    );
  }
  const newRow: StoredDefinitionRow = {
    type_id: definition.id,
    revision: definition.revision,
    hive_slug: null,
    definition: input.definition,
    origin: 'workspace',
    source_listing_id: null,
    retired_at: null,
    created_at: null,
    created_by: input.createdBy,
    retired_by: null,
    retire_reason: null,
  };
  const before = snapshotOf(rows);
  const after = snapshotOf(withRows(rows, input.kind, [...rowsOf(rows, input.kind), newRow]));
  const missing = unresolvedReferences(input.kind, definition, after);
  if (missing.length > 0) {
    return refuse(
      'reference_unresolved',
      `${definition.id} references ${missing.join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not resolve in this workspace. ` +
        'Define or install each referenced type first (an unresolvable type is held to every verification module).',
      { references: missing },
    );
  }
  const lowering = await checkRegistryWriteLowering(sql, {
    workspaceId: input.workspaceId,
    route: input.pack ? 'install' : 'define',
    typeId: definition.id,
    before,
    after,
  });
  if (lowering) return lowering;
  await sql`
    INSERT INTO harness_shared.${sql(TYPE_TABLES[input.kind])}
      (workspace_id, hive_slug, type_id, revision, definition, origin, source_listing_id, created_by)
    VALUES (${input.workspaceId}, NULL, ${definition.id}, ${definition.revision},
            ${sql.json(input.definition as never)}, ${input.pack ? 'pack' : 'workspace'},
            ${input.pack?.listingId ?? null}, ${input.createdBy})`;
  const [stored] = await sql<{ definition: unknown }[]>`
    SELECT definition FROM harness_shared.${sql(TYPE_TABLES[input.kind])}
     WHERE workspace_id = ${input.workspaceId} AND hive_slug IS NULL
       AND type_id = ${definition.id} AND revision = ${definition.revision}`;
  return {
    ok: true,
    kind: input.kind,
    typeId: definition.id,
    revision: definition.revision,
    contentHash: definitionContentHash(stored!.definition),
    definition: stored!.definition,
  };
}

export interface RetireResult {
  ok: true;
  kind: TypeKind;
  typeId: string;
  revision: number;
  /** The revision a new reference resolves to now, or null when none is left. */
  nowResolves: number | null;
}

export async function retireTypeDefinition(
  sql: Sql,
  input: { workspaceId: string; kind: TypeKind; typeId: string; revision: number; reason: string; retiredBy: string },
): Promise<RetireResult | AuthoringRefusal | RegistryWriteRefusal> {
  if (isFirstPartyTypeId(input.typeId)) return firstPartyRefusal(input.typeId);
  await lockTypeId(sql, input.workspaceId, input.kind, input.typeId);
  const rows = await readRegistryRows(sql, input.workspaceId);
  const target = rowsOf(rows, input.kind).find(
    (row) => row.type_id === input.typeId && Number(row.revision) === input.revision && row.hive_slug === null,
  );
  if (!target) {
    return refuse('type_revision_not_found', `No ${input.kind} ${input.typeId} revision ${input.revision} is defined in this workspace.`);
  }
  if (target.retired_at) {
    return refuse('type_revision_already_retired', `${input.typeId} revision ${input.revision} is already retired; a retirement cannot change.`);
  }
  const retired: StoredDefinitionRow = { ...target, retired_at: new Date(), retired_by: input.retiredBy, retire_reason: input.reason };
  const before = snapshotOf(rows);
  const after = snapshotOf(withRows(rows, input.kind, rowsOf(rows, input.kind).map((row) => (row === target ? retired : row))));
  const lowering = await checkRegistryWriteLowering(sql, {
    workspaceId: input.workspaceId,
    route: 'retire',
    typeId: input.typeId,
    before,
    after,
  });
  if (lowering) return lowering;
  await sql`
    UPDATE harness_shared.${sql(TYPE_TABLES[input.kind])}
       SET retired_at = now(), retired_by = ${input.retiredBy}, retire_reason = ${input.reason}
     WHERE workspace_id = ${input.workspaceId} AND hive_slug IS NULL
       AND type_id = ${input.typeId} AND revision = ${input.revision}`;
  const latest = input.kind === 'plan-type' ? after.planType(input.typeId) : after.itemType(input.typeId);
  return { ok: true, kind: input.kind, typeId: input.typeId, revision: input.revision, nowResolves: latest?.definition.revision ?? null };
}

export interface PinResult {
  ok: true;
  planSlug: string;
  kind: TypeKind;
  typeId: string;
  revision: number;
  contentHash: string;
  /** The pin this replaced, or null when the plan had none for the type. */
  previous: { revision: number; contentHash: string } | null;
}

function replacePin(pins: PlanTypePins, kind: TypeKind, typeId: string, pin: { revision: number; contentHash: string }): PlanTypePins {
  const itemTypes = new Map(pins.itemTypes);
  const planTypes = new Map(pins.planTypes);
  (kind === 'plan-type' ? planTypes : itemTypes).set(typeId, pin);
  return { itemTypes, planTypes };
}

/**
 * Move one plan's pin for one type to `revision` (retired revisions included). Runs inside the
 * caller's transaction, which must hold the plan's advisory lock so the pin and the plan body
 * cannot move under the check.
 */
export async function pinPlanTypeRevision(
  sql: Sql,
  input: PlanPinScope & { kind: TypeKind; typeId: string; revision: number; reason: string; pinnedBy: string },
): Promise<PinResult | AuthoringRefusal | RegistryWriteRefusal> {
  const [plan] = await sql<{ plan_slug: string }[]>`
    SELECT plan_slug FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND plan_slug = ${input.planSlug}
     FOR UPDATE`;
  if (!plan) return refuse('plan_not_found', `No plan ${input.planSlug} in harness ${input.harnessSlug}.`);
  const registry = snapshotOf(await readRegistryRows(sql, input.workspaceId));
  const found = input.kind === 'plan-type'
    ? registry.planTypeAt(input.typeId, input.revision)
    : registry.itemTypeAt(input.typeId, input.revision);
  if (!found) {
    return refuse('type_revision_not_found', `No ${input.kind} ${input.typeId} revision ${input.revision} resolves in this workspace.`);
  }
  const pin = { revision: input.revision, contentHash: found.contentHash };
  const current = await loadPlanPins(sql, input);
  const previous = (input.kind === 'plan-type' ? current.planTypes : current.itemTypes).get(input.typeId) ?? null;
  const lowering = await checkRegistryWriteLowering(sql, {
    workspaceId: input.workspaceId,
    route: 'pin',
    typeId: input.typeId,
    before: registry,
    after: registry,
    pinEdit: {
      harnessSlug: input.harnessSlug,
      planSlug: input.planSlug,
      pinsAfter: (pins) => replacePin(pins, input.kind, input.typeId, pin),
    },
  });
  if (lowering) return lowering;
  await sql`
    INSERT INTO harness_shared.plan_type_pins
      (workspace_id, harness_slug, plan_slug, kind, type_id, revision, content_hash, pinned_by, pin_reason)
    VALUES (${input.workspaceId}, ${input.harnessSlug}, ${input.planSlug}, ${input.kind}, ${input.typeId},
            ${input.revision}, ${pin.contentHash}, ${input.pinnedBy}, ${input.reason})
    ON CONFLICT ON CONSTRAINT plan_type_pins_pkey DO UPDATE
       SET revision = EXCLUDED.revision, content_hash = EXCLUDED.content_hash,
           pinned_at = now(), pinned_by = EXCLUDED.pinned_by, pin_reason = EXCLUDED.pin_reason`;
  return {
    ok: true,
    planSlug: input.planSlug,
    kind: input.kind,
    typeId: input.typeId,
    revision: input.revision,
    contentHash: pin.contentHash,
    previous: previous ? { revision: previous.revision, contentHash: previous.contentHash } : null,
  };
}

export interface TypeDefinitionView {
  kind: TypeKind;
  typeId: string;
  revision: number;
  origin: 'builtin' | 'workspace' | 'pack';
  /** The definition as stored (for a built-in, the catalog entry). */
  definition: unknown;
  contentHash: string;
  retired: boolean;
  sourceListingId: string | null;
  createdBy: string | null;
  createdAt: string | null;
  retiredBy: string | null;
  retireReason: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function viewOfRow(kind: TypeKind, row: StoredDefinitionRow): TypeDefinitionView {
  return {
    kind,
    typeId: row.type_id,
    revision: Number(row.revision),
    origin: row.origin,
    definition: row.definition,
    contentHash: definitionContentHash(row.definition),
    retired: row.retired_at !== null && row.retired_at !== undefined,
    sourceListingId: row.source_listing_id,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    retiredBy: row.retired_by,
    retireReason: row.retire_reason,
  };
}

function builtinViews(kind: TypeKind): TypeDefinitionView[] {
  const list: ReadonlyArray<{ id: string; revision: number }> = kind === 'plan-type' ? BUILTIN_CATALOG.planTypes : BUILTIN_CATALOG.itemTypes;
  return list.map((definition) => ({
    kind,
    typeId: definition.id,
    revision: definition.revision,
    origin: 'builtin' as const,
    definition,
    contentHash: definitionContentHash(definition),
    retired: false,
    sourceListingId: null,
    createdBy: null,
    createdAt: null,
    retiredBy: null,
    retireReason: null,
  }));
}

/** Every revision of every type of `kind`: the built-ins, then the workspace's stored rows. */
function allViews(kind: TypeKind, rows: RegistryRows): TypeDefinitionView[] {
  return [
    ...builtinViews(kind),
    ...rowsOf(rows, kind).filter((row) => row.hive_slug === null).map((row) => viewOfRow(kind, row)),
  ];
}

export type GetResult =
  | { ok: true; type: TypeDefinitionView; revisions: Array<{ revision: number; retired: boolean }> }
  | AuthoringRefusal;

/** One definition: an exact revision (retired included), or the latest revision a new reference resolves. */
export async function getTypeDefinition(
  sql: Sql,
  input: { workspaceId: string; kind: TypeKind; typeId: string; revision?: number },
): Promise<GetResult> {
  const views = allViews(input.kind, await readRegistryRows(sql, input.workspaceId)).filter((v) => v.typeId === input.typeId);
  const revisions = views.map((v) => ({ revision: v.revision, retired: v.retired })).sort((a, b) => a.revision - b.revision);
  const pick = input.revision !== undefined
    ? views.find((v) => v.revision === input.revision)
    : views.filter((v) => !v.retired).sort((a, b) => b.revision - a.revision)[0];
  if (!pick) {
    const what = input.revision !== undefined ? `revision ${input.revision}` : 'a revision a new reference can resolve (all are retired)';
    return refuse('type_revision_not_found', `No ${input.kind} ${input.typeId} ${views.length === 0 ? 'is defined' : `has ${what}`} in this workspace.`);
  }
  return { ok: true, type: pick, revisions };
}

export interface TypeListEntry {
  kind: TypeKind;
  typeId: string;
  revision: number;
  title: string;
  origin: TypeDefinitionView['origin'];
  retired: boolean;
  contentHash: string;
}

/**
 * The types of one or both kinds. By default one entry per id, at the revision a new reference
 * resolves; an id whose every revision is retired is left out. `includeRetired` lists every
 * revision instead.
 */
export async function listTypeDefinitions(
  sql: Sql,
  input: { workspaceId: string; kind?: TypeKind; includeRetired?: boolean; prefix?: string },
): Promise<TypeListEntry[]> {
  const rows = await readRegistryRows(sql, input.workspaceId);
  const kinds: TypeKind[] = input.kind ? [input.kind] : ['plan-type', 'item-type'];
  const entries: TypeListEntry[] = [];
  for (const kind of kinds) {
    const views = allViews(kind, rows).filter((v) => !input.prefix || v.typeId.startsWith(input.prefix));
    const chosen = input.includeRetired
      ? views
      : [...views.filter((v) => !v.retired).reduce((latest, v) => {
          const prior = latest.get(v.typeId);
          if (!prior || v.revision > prior.revision) latest.set(v.typeId, v);
          return latest;
        }, new Map<string, TypeDefinitionView>()).values()];
    for (const v of chosen) {
      const title = (v.definition as { title?: unknown } | null)?.title;
      entries.push({
        kind,
        typeId: v.typeId,
        revision: v.revision,
        title: typeof title === 'string' ? title : v.typeId,
        origin: v.origin,
        retired: v.retired,
        contentHash: v.contentHash,
      });
    }
  }
  return entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.typeId.localeCompare(b.typeId) || a.revision - b.revision);
}

/** A plan's pins as stored, for plans:get and the tools' receipts. */
export async function readPlanPinRows(sql: Sql, scope: PlanPinScope): Promise<PinRow[]> {
  return sql<PinRow[]>`
    SELECT kind, type_id, revision, content_hash
      FROM harness_shared.plan_type_pins
     WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harnessSlug} AND plan_slug = ${scope.planSlug}
     ORDER BY kind, type_id`;
}

export { pinsFromRows };
