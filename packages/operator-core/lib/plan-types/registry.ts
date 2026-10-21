/**
 * The item-type and plan-type registry (plan-item-types-registry-cupboard-2026-10-20 P-001).
 *
 * Resolution order for one id:
 * 1. A first-party id (`papercusp/...`) resolves only from the built-in catalog. Migration
 *    1541 refuses a registry row in that namespace; a row that somehow exists is ignored.
 * 2. Any other id resolves from the workspace's registry rows: not retired, and either
 *    workspace-wide (hive_slug NULL) or scoped to the requested hive. Among the rows whose
 *    revision satisfies the reference's range the highest revision wins. At equal revision
 *    a hive-scoped row beats a workspace-wide one.
 *
 * A row whose definition fails schema validation is never resolvable. It is listed in
 * `invalidRows`, so an unreadable definition is reported rather than silently treated as a
 * weaker one (an unresolvable type fails safe to the strictest checks: see
 * resolve-verification.ts).
 *
 * The snapshot is synchronous so the synchronous `resolveVerification` call sites can consult
 * it. Load it once per evaluation with `loadTypeRegistry`.
 */
import type postgres from 'postgres';
import { BUILTIN_CATALOG, type TypeCatalog } from './builtin-catalog';
import {
  isFirstPartyTypeId,
  parseItemTypeDefinition,
  parsePlanTypeDefinition,
  referenceAdmits,
  type ItemTypeDefinition,
  type PlanTypeDefinition,
  type TypeReference,
} from './definitions';

export type DefinitionOrigin = 'builtin' | 'workspace' | 'pack';

export interface RegisteredDefinition<T> {
  definition: T;
  origin: DefinitionOrigin;
  /** Null for a built-in or a workspace-wide row. */
  hiveSlug: string | null;
  sourceListingId: string | null;
}

/** One row of either registry table, as read from Postgres. */
export interface DefinitionRow {
  type_id: string;
  revision: number;
  hive_slug: string | null;
  definition: unknown;
  origin: 'workspace' | 'pack';
  source_listing_id: string | null;
  retired_at: Date | string | null;
}

export interface InvalidDefinitionRow {
  table: 'plan_item_type_definitions' | 'plan_type_definitions';
  typeId: string;
  revision: number;
  issues: string[];
}

export type RevisionRange = Pick<TypeReference, 'minRevision' | 'maxRevision'>;

export interface TypeRegistrySnapshot {
  itemType(id: string, range?: RevisionRange): RegisteredDefinition<ItemTypeDefinition> | null;
  planType(id: string, range?: RevisionRange): RegisteredDefinition<PlanTypeDefinition> | null;
  itemTypeIds(): string[];
  planTypeIds(): string[];
  invalidRows: readonly InvalidDefinitionRow[];
}

interface Candidate<T extends { id: string; revision: number }> extends RegisteredDefinition<T> {
  revision: number;
}

function pick<T extends { id: string; revision: number }>(
  candidates: readonly Candidate<T>[] | undefined,
  range: RevisionRange,
): RegisteredDefinition<T> | null {
  let best: Candidate<T> | null = null;
  for (const candidate of candidates ?? []) {
    if (!referenceAdmits({ id: candidate.definition.id, ...range }, candidate.revision)) continue;
    if (
      !best
      || candidate.revision > best.revision
      || (candidate.revision === best.revision && candidate.hiveSlug !== null && best.hiveSlug === null)
    ) {
      best = candidate;
    }
  }
  if (!best) return null;
  const { revision: _revision, ...registered } = best;
  return registered;
}

function index<T extends { id: string; revision: number }>(
  builtins: readonly T[],
  rows: readonly DefinitionRow[],
  hiveSlug: string | null,
  parse: (input: unknown) => { ok: true; definition: T } | { ok: false; issues: string[] },
  table: InvalidDefinitionRow['table'],
  invalid: InvalidDefinitionRow[],
): Map<string, Candidate<T>[]> {
  const byId = new Map<string, Candidate<T>[]>();
  const add = (candidate: Candidate<T>) => {
    const list = byId.get(candidate.definition.id) ?? [];
    list.push(candidate);
    byId.set(candidate.definition.id, list);
  };
  for (const definition of builtins) {
    add({ definition, origin: 'builtin', hiveSlug: null, sourceListingId: null, revision: definition.revision });
  }
  for (const row of rows) {
    if (row.retired_at) continue;
    if (isFirstPartyTypeId(row.type_id)) continue;
    if (row.hive_slug !== null && row.hive_slug !== hiveSlug) continue;
    const parsed = parse(row.definition);
    if (!parsed.ok || parsed.definition.id !== row.type_id || parsed.definition.revision !== row.revision) {
      invalid.push({
        table,
        typeId: row.type_id,
        revision: row.revision,
        issues: parsed.ok ? ['definition id/revision do not match the row'] : parsed.issues,
      });
      continue;
    }
    add({
      definition: parsed.definition,
      origin: row.origin,
      hiveSlug: row.hive_slug,
      sourceListingId: row.source_listing_id,
      revision: row.revision,
    });
  }
  return byId;
}

export function buildTypeRegistrySnapshot(input: {
  catalog?: TypeCatalog;
  itemTypeRows?: readonly DefinitionRow[];
  planTypeRows?: readonly DefinitionRow[];
  hiveSlug?: string | null;
} = {}): TypeRegistrySnapshot {
  const catalog = input.catalog ?? BUILTIN_CATALOG;
  const hiveSlug = input.hiveSlug ?? null;
  const invalidRows: InvalidDefinitionRow[] = [];
  const itemTypes = index(
    catalog.itemTypes, input.itemTypeRows ?? [], hiveSlug, parseItemTypeDefinition, 'plan_item_type_definitions', invalidRows,
  );
  const planTypes = index(
    catalog.planTypes, input.planTypeRows ?? [], hiveSlug, parsePlanTypeDefinition, 'plan_type_definitions', invalidRows,
  );
  return {
    itemType: (id, range = {}) => pick(itemTypes.get(id), range),
    planType: (id, range = {}) => pick(planTypes.get(id), range),
    itemTypeIds: () => [...itemTypes.keys()].sort(),
    planTypeIds: () => [...planTypes.keys()].sort(),
    invalidRows,
  };
}

export interface TypeRegistryScope {
  workspaceId: string;
  hiveSlug?: string | null;
}

/**
 * Read the workspace's registry rows and build a snapshot over them and the built-in catalog.
 * Every predicate is scoped to the workspace, so the admin pool and an RLS-scoped transaction
 * read the same rows. Retired rows are filtered in the snapshot, not here, so the read is one
 * plain scan of each table.
 */
export async function loadTypeRegistry(
  sql: postgres.Sql | postgres.TransactionSql,
  scope: TypeRegistryScope,
  opts: { catalog?: TypeCatalog } = {},
): Promise<TypeRegistrySnapshot> {
  const [itemTypeRows, planTypeRows] = await Promise.all([
    sql<DefinitionRow[]>`
      SELECT type_id, revision, hive_slug, definition, origin, source_listing_id, retired_at
        FROM harness_shared.plan_item_type_definitions
       WHERE workspace_id = ${scope.workspaceId}`,
    sql<DefinitionRow[]>`
      SELECT type_id, revision, hive_slug, definition, origin, source_listing_id, retired_at
        FROM harness_shared.plan_type_definitions
       WHERE workspace_id = ${scope.workspaceId}`,
  ]);
  return buildTypeRegistrySnapshot({
    catalog: opts.catalog,
    itemTypeRows,
    planTypeRows,
    hiveSlug: scope.hiveSlug ?? null,
  });
}
