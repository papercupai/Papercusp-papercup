/**
 * Fixtures for the Cupboard type-pack tests (plan-item-types-registry-cupboard-2026-10-20 P-006,
 * D-008): definition builders, pack listings as the Worker serves them (review status, content pin,
 * declared types), an in-memory Cupboard for the planner's two dependencies, and row counters for
 * the "a refused install leaves no rows" assertions.
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { TypeDeclaration, TypePackListing, TypePackPlanDeps } from '../lib/cupboard/type-pack';

export type Ref = { id: string; minRevision?: number; maxRevision?: number };

/** A deterministic, well-formed content pin for a listing id. */
export function fakePin(seed: string): { commitSha: string; treeDigest: string } {
  const hex = createHash('sha256').update(seed).digest('hex');
  return { commitSha: hex.slice(0, 40), treeDigest: hex };
}

export function itemTypeDef(id: string, extra: Record<string, unknown> = {}, revision = 1): Record<string, unknown> & { id: string; revision: number } {
  return { schemaVersion: 1, id, revision, title: `${id} r${revision}`, modules: ['generic-core'], ...extra };
}

export function planTypeDef(id: string, itemTypes: Ref[], extra: Record<string, unknown> = {}, revision = 1): Record<string, unknown> & { id: string; revision: number } {
  return {
    schemaVersion: 1,
    id,
    revision,
    title: `${id} r${revision}`,
    base: 'general',
    classes: ['plan-class-feature-ship'],
    defaultItemType: itemTypes[0],
    itemTypes,
    ...extra,
  };
}

export function rubricSource(rubricId: string): Record<string, unknown> {
  return {
    rubricId,
    title: `${rubricId} review`,
    characteristic: 'reviewed memo quality',
    description: 'Bundled with a type pack for its item type.',
    ratingScale: ['pass', 'fail', 'unknown'],
    methodRef: null,
    criteria: [{
      key: 'sourced', title: 'Sourced', model: 'Every claim names its source.',
      method: 'Read the memo and check each claim.', driftMarkers: 'A claim with no source.',
    }],
  };
}

export function datatypeSource(id: string): Record<string, unknown> {
  return {
    id,
    title: `${id} completion`,
    description: 'The completion fields of a reviewed memo.',
    payloadSchema: {
      type: 'object',
      required: ['reviewer'],
      properties: { reviewer: { type: 'string', minLength: 1 } },
    },
  };
}

export interface FakePack {
  listing: TypePackListing;
  manifest: { name: string; version: string; typePack: unknown };
}

function declarations(defs: unknown[] | undefined): TypeDeclaration[] {
  return (defs ?? []).flatMap((def) => {
    const { id, revision } = (def ?? {}) as { id?: unknown; revision?: unknown };
    return typeof id === 'string' && typeof revision === 'number' ? [{ id, revision }] : [];
  });
}

/**
 * A pack listing plus its manifest. By default the listing is approved, content-pinned, and declares
 * exactly the types its manifest carries; each option breaks one of those.
 */
export function fakePack(
  listingId: string,
  block: { itemTypes?: unknown[]; planTypes?: unknown[]; rubrics?: unknown[]; datatypes?: unknown[] },
  options: {
    reviewStatus?: string;
    pinned?: boolean;
    declares?: { itemTypes: TypeDeclaration[]; planTypes: TypeDeclaration[] };
  } = {},
): FakePack {
  return {
    listing: {
      listingId,
      reviewStatus: options.reviewStatus ?? 'approved',
      pin: options.pinned === false ? null : fakePin(listingId),
      releaseContentHash: null,
      providesItemTypes: options.declares?.itemTypes ?? declarations(block.itemTypes),
      providesPlanTypes: options.declares?.planTypes ?? declarations(block.planTypes),
    },
    manifest: { name: listingId, version: '1.0.0', typePack: block },
  };
}

/** An in-memory Cupboard: providers are the packs that declare a type; fetch returns the manifest. */
export function fakeCupboard(packs: readonly FakePack[]): TypePackPlanDeps & { fetched: string[]; lookups: string[] } {
  const fetched: string[] = [];
  const lookups: string[] = [];
  return {
    fetched,
    lookups,
    async findProviders(kind, id) {
      lookups.push(`${kind}:${id}`);
      return packs
        .filter((pack) => (kind === 'item-type' ? pack.listing.providesItemTypes : pack.listing.providesPlanTypes).some((decl) => decl.id === id))
        .map((pack) => pack.listing);
    },
    async fetchPack(listing) {
      fetched.push(listing.listingId);
      const pack = packs.find((candidate) => candidate.listing.listingId === listing.listingId);
      if (!pack) throw new Error(`no pack ${listing.listingId} on this fake Cupboard`);
      return { listing, manifest: pack.manifest };
    },
  };
}

/** Registry rows under a namespace and receipts whose listing id starts with it. */
export async function countTypeRows(
  sql: postgres.Sql,
  workspaceId: string,
  namespace: string,
): Promise<{ itemTypes: number; planTypes: number; receipts: number }> {
  const [row] = await sql<Array<{ item_types: number; plan_types: number; receipts: number }>>`
    SELECT
      (SELECT count(*)::int FROM harness_shared.plan_item_type_definitions
        WHERE workspace_id = ${workspaceId} AND type_id LIKE ${namespace + '%'}) AS item_types,
      (SELECT count(*)::int FROM harness_shared.plan_type_definitions
        WHERE workspace_id = ${workspaceId} AND type_id LIKE ${namespace + '%'}) AS plan_types,
      (SELECT count(*)::int FROM harness_shared.type_pack_installations
        WHERE workspace_id = ${workspaceId} AND listing_id LIKE ${namespace + '%'}) AS receipts`;
  return { itemTypes: row!.item_types, planTypes: row!.plan_types, receipts: row!.receipts };
}

/** The (origin, source listing) a stored definition row records. */
export async function definitionSource(
  sql: postgres.Sql,
  workspaceId: string,
  table: 'plan_item_type_definitions' | 'plan_type_definitions',
  typeId: string,
): Promise<Array<{ revision: number; origin: string; sourceListingId: string | null }>> {
  const rows = await sql<Array<{ revision: number; origin: string; source_listing_id: string | null }>>`
    SELECT revision, origin, source_listing_id FROM harness_shared.${sql(table)}
     WHERE workspace_id = ${workspaceId} AND type_id = ${typeId} ORDER BY revision`;
  return rows.map((row) => ({ revision: Number(row.revision), origin: row.origin, sourceListingId: row.source_listing_id }));
}
