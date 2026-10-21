/**
 * R-16 (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008): a pack carrying item types or
 * plan types, published through the REAL Worker publish path, lands PENDING operator review and
 * stays uninstallable until an operator approves it; a tool-only pack keeps today's policy
 * (approved on publish). A refused install leaves no rows.
 *
 * The Worker (apps/operator-public) runs in-process on a real SQLite D1 with every migration
 * applied, and GitHub is stubbed. The installer reads the listing the way production does
 * (GET /listings/:id, then coordsFromRow) and installs through the real type-pack path into real
 * Postgres. Worker sources compile only under @cloudflare/workers-types, so they load through a
 * non-literal specifier that tsc does not follow (as test/portal-cupboard-fixture.ts does).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  appSql: undefined as unknown as postgres.Sql,
}));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: <T,>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
      h.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx);
      }) as Promise<T>,
  };
});

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { installTypePack, readTypePackReceipt, typePackListingFromCoords } = await import('./type-pack');
const { coordsFromRow } = await import('./resolve-listing-by-kind');
const fx = await import('../../test/type-pack-fixture');

interface WorkerSurface {
  buildApi(): { request(path: string, init: RequestInit, env: unknown): Promise<Response> };
  makeSqliteDb(): { db: unknown; raw: { close(): void } };
  makeEnv(overrides: { DB: unknown }): { env: { DB: unknown } };
  stubGithub(stub: unknown): void;
  setReviewStatus(db: unknown, id: string, status: 'approved' | 'rejected', reason: string | null, now: number): Promise<void>;
}

async function loadWorker(): Promise<WorkerSurface> {
  // Non-literal so operator-core's tsc never compiles the Worker sources (they need
  // @cloudflare/workers-types). It must be an absolute file URL: Vite resolves a non-literal
  // RELATIVE specifier against the project root, not this file.
  const src = new URL('../../../../apps/operator-public/src/', import.meta.url);
  const load = (path: string) => import(new URL(`${path}.ts`, src).href) as Promise<Record<string, unknown>>;
  const [routes, sqlite, fake, workerDb] = await Promise.all([
    load('routes/index'), load('__tests__/sqlite-d1'), load('__tests__/fake-d1'), load('db'),
  ]);
  const surface = {
    buildApi: routes.buildApi, makeSqliteDb: sqlite.makeSqliteDb, makeEnv: fake.makeEnv,
    stubGithub: fake.stubGithub, setReviewStatus: workerDb.setReviewStatus,
  };
  for (const [name, fn] of Object.entries(surface)) {
    if (typeof fn !== 'function') throw new Error(`apps/operator-public no longer exports ${name}`);
  }
  return surface as unknown as WorkerSurface;
}

const WS = 'default';
const NS = `zzz-tpv-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { workspaceId: WS, installedBy: 'item-type-pack-review-test' };
const PUBLISHER = { id: 7101, login: 'type-pack-publisher' };
const HEAD = 'b'.repeat(40);

let db: OrgTestDb;
let worker: WorkerSurface;
let api: ReturnType<WorkerSurface['buildApi']>;
let env: { DB: unknown };
let closeD1: () => void;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  worker = await loadWorker();
  const d1 = worker.makeSqliteDb();
  closeD1 = () => d1.raw.close();
  env = worker.makeEnv({ DB: d1.db }).env;
  api = worker.buildApi();
}, 120_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  closeD1?.();
  await db?.cleanup();
});

/** Publish one pack through POST /listings, with GitHub stubbed to serve its manifest at HEAD. */
async function publishPack(repoId: number, listingRef: string, manifest: Record<string, unknown>, extra: Record<string, unknown>) {
  const bytes = JSON.stringify(manifest);
  const blob = createHash('sha1').update(bytes).digest('hex');
  worker.stubGithub({
    user: PUBLISHER,
    repo: { id: repoId, private: false, permissions: { admin: true }, default_branch: 'main' },
    head: { sha: HEAD },
    tree: { entries: [{ path: `${listingRef}/papercusp.json`, sha: blob, size: bytes.length }] },
    blobs: { [blob]: { content: Buffer.from(bytes).toString('base64') } },
  });
  const res = await api.request('/listings', {
    method: 'POST',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      github_owner: 'acme', github_name: `${listingRef}-repo`, github_url: `https://github.com/acme/${listingRef}-repo`,
      github_repository_id: repoId, listing_kind: 'pack', listing_ref: listingRef, title: listingRef, ...extra,
    }),
  }, env);
  const body = await res.json() as { ok?: boolean; id?: string; listing?: Record<string, unknown>; error?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { id: body.id!, listing: body.listing! };
}

/** GET /listings/:id as the installer (no credentials) or as the publisher. */
async function readListing(id: string, asPublisher = false): Promise<{ status: number; row: Record<string, unknown> | null }> {
  if (asPublisher) worker.stubGithub({ user: PUBLISHER });
  const res = await api.request(`/listings/${id}`, asPublisher ? { headers: { Authorization: 'Bearer t' } } : {}, env);
  return { status: res.status, row: res.status === 200 ? await res.json() as Record<string, unknown> : null };
}

function installFromRow(row: Record<string, unknown>, manifest: { name: string; version: string; typePack: unknown }) {
  const coords = coordsFromRow(row);
  expect(coords, 'the Worker row must resolve to install coordinates').not.toBeNull();
  const listing = typePackListingFromCoords(coords!);
  expect(listing, 'the Worker row must carry its listing id').not.toBeNull();
  return installTypePack(h.sql, { listing: listing!, manifest }, CTX, {
    ...fx.fakeCupboard([]),
    provisionRubric: async () => { throw new Error('this pack bundles no rubric'); },
  });
}

describe('published type packs wait for operator review (R-16)', () => {
  const memo = `${NS}/reviewed-memo`;
  const manifest = { name: `${NS}-review-types`, version: '1.0.0', kind: 'pack', typePack: { itemTypes: [fx.itemTypeDef(memo)] } };
  let typePackId = '';

  it('a pack declaring an item type lands pending, content-pinned, through the real publish path', async () => {
    const published = await publishPack(9101, 'review-types', manifest, { provides_item_types: [{ id: memo, revision: 1 }] });
    typePackId = published.id;

    expect(published.listing.review_status).toBe('pending');
    expect(published.listing.provides_item_types).toBe(JSON.stringify([{ id: memo, revision: 1 }]));
    expect(published.listing.pinned_commit_sha).toBe(HEAD);
    expect(String(published.listing.pinned_tree_digest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tool-only pack keeps today\'s policy and is approved on publish', async () => {
    const published = await publishPack(9102, 'markdown-tools', { name: `${NS}-md`, version: '1.0.0', kind: 'pack' }, { provides_tools: ['md.render'] });

    expect(published.listing.review_status).toBe('approved');
    expect((await readListing(published.id)).status).toBe(200);
  });

  it('the pending type pack cannot be installed: invisible to the installer, refused from the publisher\'s view, no rows', async () => {
    expect((await readListing(typePackId)).status).toBe(404);

    const asPublisher = await readListing(typePackId, true);
    expect(asPublisher.status).toBe(200);
    expect(asPublisher.row!.review_status).toBe('pending');
    const result = await installFromRow(asPublisher.row!, manifest);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_pack_not_approved');
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/reviewed`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    expect(await readTypePackReceipt(h.sql, WS, typePackId)).toBeNull();
  });

  it('once an operator approves it, the same listing installs and its receipt pins the Worker\'s content pin', async () => {
    await worker.setReviewStatus(env.DB, typePackId, 'approved', 'type pack reviewed', Date.now());
    const approved = await readListing(typePackId);
    expect(approved.status).toBe(200);
    expect(approved.row!.review_status).toBe('approved');

    const result = await installFromRow(approved.row!, manifest);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: typePackId }]);
    expect(await readTypePackReceipt(h.sql, WS, typePackId)).toMatchObject({
      listingId: typePackId,
      commitSha: approved.row!.pinned_commit_sha,
      treeDigest: approved.row!.pinned_tree_digest,
    });
  });
});
