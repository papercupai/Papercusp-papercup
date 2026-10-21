/**
 * type-pack-io — the real Cupboard and git wiring for type-pack installs
 * (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008). The pure planner and applier live in
 * `type-pack.ts`; this module supplies their dependencies:
 *
 *  - `findProviders` asks the Cupboard Worker which listings declare an item type or plan type
 *    (`GET /listings?provides_item_type=<id>`, migration 049). Public browse returns approved rows
 *    only, and the chooser still refuses anything not approved and content-pinned.
 *  - `fetchPack` fetches a dependency pack at exactly its listing's pinned commit, recomputes the
 *    tree digest over the listing's subdirectory, refuses a mismatch, and reads the manifest.
 *  - `provisionRubric` is the no-clobber pinned rubric seed (`provisionPinnedRubric`).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalTreeDigest, type TreeDigestEntry } from '@papercusp/artifact-registry';
import { resolveCupboardBaseUrl } from './base-url';
import { coordsFromRow, type ResolvedListingCoords } from './resolve-listing-by-kind';
import {
  installTypePack,
  typePackListingFromCoords,
  type TypePackApplyDeps,
  type TypePackInstallResult,
  type TypePackListing,
  type TypePackManifest,
  type TypePackPlanDeps,
  type TypePackRefusal,
} from './type-pack';

export interface TypePackIoOptions {
  fetch?: typeof fetch;
  baseUrl?: () => string;
  fetchAtSha?: (url: string, dest: string, sha: string) => Promise<void>;
  listTreeBlobs?: (dir: string, sha: string, ref: string) => Promise<TreeDigestEntry[]>;
  tmpDir?: () => string;
}

export interface CupboardTypePackDeps extends TypePackPlanDeps {
  /** Remember a listing's coordinates so `fetchPack` can fetch it (the root of an install, or a provider). */
  remember: (coords: ResolvedListingCoords) => TypePackListing | null;
}

/** The manifest a pack carries in `<listing ref>/papercusp.json`. */
export async function readPackManifest(dir: string): Promise<TypePackManifest> {
  const raw = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as Record<string, unknown>;
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    throw new Error('papercusp.json must carry a string name and version');
  }
  return { name: raw.name, version: raw.version, typePack: raw.typePack };
}

export function cupboardTypePackDeps(options: TypePackIoOptions = {}): CupboardTypePackDeps {
  const known = new Map<string, ResolvedListingCoords>();
  const remember = (coords: ResolvedListingCoords): TypePackListing | null => {
    const listing = typePackListingFromCoords(coords);
    if (listing) known.set(listing.listingId, coords);
    return listing;
  };
  return {
    remember,
    async findProviders(kind, id) {
      const base = (options.baseUrl ?? resolveCupboardBaseUrl)();
      const param = kind === 'item-type' ? 'provides_item_type' : 'provides_plan_type';
      const res = await (options.fetch ?? fetch)(`${base}/listings?${param}=${encodeURIComponent(id)}&limit=100`);
      if (!res.ok) throw new Error(`Cupboard lookup of packs providing ${kind} ${id} failed: HTTP ${res.status}`);
      const body = (await res.json()) as { results?: unknown[] };
      return (body.results ?? []).flatMap((row) => {
        const coords = row && typeof row === 'object' ? coordsFromRow(row as Record<string, unknown>) : null;
        const listing = coords ? remember(coords) : null;
        return listing ? [listing] : [];
      });
    },
    async fetchPack(listing) {
      const coords = known.get(listing.listingId);
      if (!coords) throw new Error(`no coordinates are known for pack listing ${listing.listingId}`);
      if (!listing.pin) throw new Error(`pack listing ${listing.listingId} has no content pin`);
      const io = await import('./install-io');
      const fetchAtSha = options.fetchAtSha ?? io.gitFetchAtSha;
      const listTreeBlobs = options.listTreeBlobs ?? io.gitListTreeBlobs;
      const dir = join((options.tmpDir ?? tmpdir)(), `type-pack-${randomUUID()}`);
      try {
        await fetchAtSha(coords.githubUrl, dir, listing.pin.commitSha);
        const entries = await listTreeBlobs(dir, listing.pin.commitSha, coords.ref);
        if (!entries.length || (await canonicalTreeDigest(entries)) !== listing.pin.treeDigest) {
          throw new Error(`the mirror of pack listing ${listing.listingId} differs from its content pin`);
        }
        return { listing, manifest: await readPackManifest(join(dir, coords.ref)) };
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/** The real no-clobber pinned rubric seed. */
export const provisionPackRubric: TypePackApplyDeps['provisionRubric'] = async (source, workspaceId) => {
  const { provisionPinnedRubric } = await import('../rubrics');
  await provisionPinnedRubric(source, workspaceId);
};

/**
 * The production `installTypePack` dependency of the plugin/pack install core: install the root
 * pack's typePack (already fetched and verified by the core) into the active workspace.
 */
export async function installTypePackForPlugin(args: {
  manifest: { name: string; version: string; typePack: unknown };
  listing: TypePackListing;
  coords?: ResolvedListingCoords;
}): Promise<TypePackInstallResult | TypePackRefusal> {
  const [{ getOrgPg }, { activeWorkspaceId }] = await Promise.all([
    import('@papercusp/db-org'),
    import('../workspace-registry'),
  ]);
  const deps = cupboardTypePackDeps();
  if (args.coords) deps.remember(args.coords);
  return installTypePack(
    getOrgPg().sql as unknown as postgres.Sql,
    { listing: args.listing, manifest: args.manifest },
    { workspaceId: activeWorkspaceId(), installedBy: 'cupboard-install' },
    { ...deps, provisionRubric: provisionPackRubric },
  );
}
