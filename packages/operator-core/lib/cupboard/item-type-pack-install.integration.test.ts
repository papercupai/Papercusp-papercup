/**
 * R-15 and SPEC-P-006 (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008), on real Postgres:
 * installing a plan type resolves each item type it references to the pack that provides it, the
 * built-in catalog, or the registry, and never to a pending pack or one of undeclared provenance.
 * Installing an item-type pack also installs the rubric its item type references.
 *
 * The Cupboard is in memory (fake-cupboard listings + manifests); the planner, the applier, the
 * registry write path and the pinned rubric seed are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
const rubrics = await import('../rubrics');
const { runWithWorkspaceIfConcrete } = await import('../workspace-als');
const readRubric = (id: string) => runWithWorkspaceIfConcrete(WS, () => rubrics.getRubric(id));
const { installTypePack } = await import('./type-pack');
const { provisionPackRubric } = await import('./type-pack-io');
const { builtinItemTypeId } = await import('../plan-types/builtin-catalog');
const fx = await import('../../test/type-pack-fixture');

const WS = 'default';
const NS = `zzz-tpi-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { workspaceId: WS, installedBy: 'item-type-pack-install-test' };

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  rubrics.__resetRubricSeedStateForTests();
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

function install(root: import('../../test/type-pack-fixture').FakePack, cupboard: ReturnType<typeof fx.fakeCupboard>) {
  return installTypePack(h.sql, root, CTX, { ...cupboard, provisionRubric: provisionPackRubric });
}

describe('installing a plan type resolves its item types to packs (R-15)', () => {
  it('resolves an item type provided by another pack and installs that pack first', async () => {
    const memo = `${NS}/memo`;
    const plan = `${NS}/review-plan`;
    const itemPack = fx.fakePack(`${NS}-items-a`, { itemTypes: [fx.itemTypeDef(memo)] });
    const planPack = fx.fakePack(`${NS}-plans-a`, { planTypes: [fx.planTypeDef(plan, [{ id: memo, minRevision: 1 }])] });
    const cupboard = fx.fakeCupboard([itemPack, planPack]);

    const result = await install(planPack, cupboard);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.receipts.map((r) => r.listingId)).toEqual([itemPack.listing.listingId, planPack.listing.listingId]);
    expect(cupboard.fetched).toEqual([itemPack.listing.listingId]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: itemPack.listing.listingId }]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', plan))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: planPack.listing.listingId }]);
    expect(result.receipts[1]!.dependencies).toContainEqual(
      expect.objectContaining({ kind: 'item-type', id: memo, revision: 1, via: 'listing', listingId: itemPack.listing.listingId }));
  });

  it('resolves a reference to a built-in item type from the built-in catalog, with no Cupboard lookup', async () => {
    const code = builtinItemTypeId('code');
    const plan = `${NS}/build-plan`;
    const planPack = fx.fakePack(`${NS}-plans-builtin`, { planTypes: [fx.planTypeDef(plan, [{ id: code, minRevision: 1 }])] });
    const cupboard = fx.fakeCupboard([planPack]);

    const result = await install(planPack, cupboard);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(cupboard.lookups).toEqual([]);
    expect(result.receipts[0]!.dependencies).toEqual([
      expect.objectContaining({ id: code, revision: 1, via: 'registry', origin: 'builtin' }),
    ]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', plan)).toHaveLength(1);
  });

  it('refuses a plan-type reference to an item type that names no revision or range, writing nothing', async () => {
    const memo = `${NS}/unbounded-memo`;
    const plan = `${NS}/unbounded-plan`;
    const itemPack = fx.fakePack(`${NS}-items-unbounded`, { itemTypes: [fx.itemTypeDef(memo)] });
    const planPack = fx.fakePack(`${NS}-plans-unbounded`, { planTypes: [fx.planTypeDef(plan, [{ id: memo }])] });

    const result = await install(planPack, fx.fakeCupboard([itemPack, planPack]));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_pack_manifest_invalid');
    expect(!result.ok && result.message).toMatch(/must name a revision or revision range/);
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo)).toEqual([]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', plan)).toEqual([]);
  });

  it('picks the approved, content-pinned provider over a pending one and one of undeclared provenance', async () => {
    const memo = `${NS}/contested-memo`;
    const plan = `${NS}/contested-plan`;
    // The pending and unpinned candidates offer a HIGHER revision, so only the eligibility rule
    // (not "newest wins") can explain choosing the approved, pinned one.
    const pending = fx.fakePack(`${NS}-items-pending`, { itemTypes: [fx.itemTypeDef(memo, {}, 3)] }, { reviewStatus: 'pending' });
    const unpinned = fx.fakePack(`${NS}-items-unpinned`, { itemTypes: [fx.itemTypeDef(memo, {}, 2)] }, { pinned: false });
    const approved = fx.fakePack(`${NS}-items-approved`, { itemTypes: [fx.itemTypeDef(memo)] });
    const planPack = fx.fakePack(`${NS}-plans-contested`, { planTypes: [fx.planTypeDef(plan, [{ id: memo, minRevision: 1 }])] });
    const cupboard = fx.fakeCupboard([pending, unpinned, approved, planPack]);

    const result = await install(planPack, cupboard);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(cupboard.fetched).toEqual([approved.listing.listingId]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: approved.listing.listingId }]);
  });

  it('refuses when the only providers are pending or unpinned, writing nothing', async () => {
    const memo = `${NS}/unreviewed-memo`;
    const plan = `${NS}/unreviewed-plan`;
    const pending = fx.fakePack(`${NS}-items-only-pending`, { itemTypes: [fx.itemTypeDef(memo)] }, { reviewStatus: 'pending' });
    const unpinned = fx.fakePack(`${NS}-items-only-unpinned`, { itemTypes: [fx.itemTypeDef(memo)] }, { pinned: false });
    const planPack = fx.fakePack(`${NS}-plans-unreviewed`, { planTypes: [fx.planTypeDef(plan, [{ id: memo, minRevision: 1 }])] });

    const result = await install(planPack, fx.fakeCupboard([pending, unpinned, planPack]));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_provider_missing');
    expect(!result.ok && result.message).toMatch(/awaiting review: .*-items-only-pending/);
    expect(!result.ok && result.message).toMatch(/no content pin: .*-items-only-unpinned/);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', plan)).toEqual([]);
  });

  it('refuses two approved packs offering the same item-type revision instead of guessing', async () => {
    const memo = `${NS}/twin-memo`;
    const plan = `${NS}/twin-plan`;
    const a = fx.fakePack(`${NS}-items-twin-a`, { itemTypes: [fx.itemTypeDef(memo)] });
    const b = fx.fakePack(`${NS}-items-twin-b`, { itemTypes: [fx.itemTypeDef(memo)] });
    const planPack = fx.fakePack(`${NS}-plans-twin`, { planTypes: [fx.planTypeDef(plan, [{ id: memo, minRevision: 1 }])] });

    const result = await install(planPack, fx.fakeCupboard([a, b, planPack]));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_provider_ambiguous');
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo)).toEqual([]);
  });

  it('refuses a reference whose revision range no available pack meets, writing nothing', async () => {
    const memo = `${NS}/ranged-memo`;
    const plan = `${NS}/ranged-plan`;
    const itemPack = fx.fakePack(`${NS}-items-ranged`, { itemTypes: [fx.itemTypeDef(memo, {}, 1)] });
    const planPack = fx.fakePack(`${NS}-plans-ranged`, { planTypes: [fx.planTypeDef(plan, [{ id: memo, minRevision: 2, maxRevision: 4 }])] });

    const result = await install(planPack, fx.fakeCupboard([itemPack, planPack]));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_provider_missing');
    expect(!result.ok && result.message).toContain(`${memo}@2..4`);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/ranged`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
  });
});

describe('installing an item-type pack installs the rubric its item type references (SPEC-P-006)', () => {
  it('co-installs the bundled rubric, active and readable, alongside the item type', async () => {
    const memo = `${NS}/reviewed-memo`;
    const rubricId = `${NS}-memo-review`;
    const itemPack = fx.fakePack(`${NS}-items-reviewed`, {
      itemTypes: [fx.itemTypeDef(memo, { rubricRef: rubricId })],
      rubrics: [fx.rubricSource(rubricId)],
    });
    expect(await readRubric(rubricId)).toBeNull();

    const result = await install(itemPack, fx.fakeCupboard([itemPack]));

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const rubric = await readRubric(rubricId);
    expect(rubric).toMatchObject({ rubricId, status: 'active', criteria: [{ key: 'sourced' }] });
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo)).toHaveLength(1);
  });
});
