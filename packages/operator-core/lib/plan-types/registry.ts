/**
 * The item-type and plan-type registry (plan-item-types-registry-cupboard-2026-10-20 P-001).
 *
 * Resolution order for one id:
 * 1. A first-party id (`papercusp/...`) resolves only from the built-in catalog. Migration
 *    1541 refuses a registry row in that namespace; a row that somehow exists is ignored.
 * 2. Any other id resolves from the workspace's registry rows: either workspace-wide
 *    (hive_slug NULL) or scoped to the requested hive. Among the non-retired rows whose
 *    revision satisfies the reference's range the highest revision wins. At equal revision
 *    a hive-scoped row beats a workspace-wide one.
 * 3. A plan PINNED to a revision (P-005, plan_type_pins) resolves exactly that revision with
 *    `itemTypeAt` / `planTypeAt`, retired or not: retiring a revision stops new references to
 *    it, never the plans already graded by it.
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
import { definitionContentHash } from './content-hash';
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
  /**
   * A retired revision never resolves for a new reference, but still resolves, by exact
   * revision, for a plan pinned to it (P-005, R-12/R-14).
   */
  retired: boolean;
  /** SHA-256 of the stored definition's canonical JSON (`content-hash.ts`); what a pin records. */
  contentHash: string;
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
  /** The highest non-retired revision in range: what a NEW reference resolves to. */
  itemType(id: string, range?: RevisionRange): RegisteredDefinition<ItemTypeDefinition> | null;
  planType(id: string, range?: RevisionRange): RegisteredDefinition<PlanTypeDefinition> | null;
  /** Exactly one revision, retired or not: what a PINNED reference resolves to. */
  itemTypeAt(id: string, revision: number): RegisteredDefinition<ItemTypeDefinition> | null;
  planTypeAt(id: string, revision: number): RegisteredDefinition<PlanTypeDefinition> | null;
  /** Every stored revision of one id, retired included, in ascending revision order. */
  itemTypeRevisions(id: string): RegisteredDefinition<ItemTypeDefinition>[];
  planTypeRevisions(id: string): RegisteredDefinition<PlanTypeDefinition>[];
  /** Ids with at least one non-retired revision. */
  itemTypeIds(): string[];
  planTypeIds(): string[];
  invalidRows: readonly InvalidDefinitionRow[];
}

type Candidate<T extends { id: string; revision: number }> = RegisteredDefinition<T>;

/** Hive-scoped beats workspace-wide at equal revision. */
function prefer<T extends { id: string; revision: number }>(candidate: Candidate<T>, best: Candidate<T> | null): boolean {
  if (!best) return true;
  if (candidate.definition.revision !== best.definition.revision) {
    return candidate.definition.revision > best.definition.revision;
  }
  return candidate.hiveSlug !== null && best.hiveSlug === null;
}

function pick<T extends { id: string; revision: number }>(
  candidates: readonly Candidate<T>[] | undefined,
  range: RevisionRange,
): RegisteredDefinition<T> | null {
  let best: Candidate<T> | null = null;
  for (const candidate of candidates ?? []) {
    if (candidate.retired) continue;
    if (!referenceAdmits({ id: candidate.definition.id, ...range }, candidate.definition.revision)) continue;
    if (prefer(candidate, best)) best = candidate;
  }
  return best;
}

function pickExact<T extends { id: string; revision: number }>(
  candidates: readonly Candidate<T>[] | undefined,
  revision: number,
): RegisteredDefinition<T> | null {
  let best: Candidate<T> | null = null;
  for (const candidate of candidates ?? []) {
    if (candidate.definition.revision !== revision) continue;
    if (prefer(candidate, best)) best = candidate;
  }
  return best;
}

function revisionsOf<T extends { id: string; revision: number }>(
  candidates: readonly Candidate<T>[] | undefined,
): RegisteredDefinition<T>[] {
  return [...(candidates ?? [])].sort((a, b) => a.definition.revision - b.definition.revision);
}

function liveIds<T extends { id: string; revision: number }>(byId: Map<string, Candidate<T>[]>): string[] {
  return [...byId].filter(([, list]) => list.some((candidate) => !candidate.retired)).map(([id]) => id).sort();
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
    add({
      definition,
      origin: 'builtin',
      hiveSlug: null,
      sourceListingId: null,
      retired: false,
      contentHash: definitionContentHash(definition),
    });
  }
  for (const row of rows) {
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
      retired: row.retired_at !== null && row.retired_at !== undefined,
      // Over the row AS STORED, not the parsed form: that is what define wrote and get returns.
      contentHash: definitionContentHash(row.definition),
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
    itemTypeAt: (id, revision) => pickExact(itemTypes.get(id), revision),
    planTypeAt: (id, revision) => pickExact(planTypes.get(id), revision),
    itemTypeRevisions: (id) => revisionsOf(itemTypes.get(id)),
    planTypeRevisions: (id) => revisionsOf(planTypes.get(id)),
    itemTypeIds: () => liveIds(itemTypes),
    planTypeIds: () => liveIds(planTypes),
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
