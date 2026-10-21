/**
 * R-24 (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008), on real Postgres: installing a
 * type pack co-installs every rubric and datatype its definitions reference and records an install
 * receipt that pins the pack's provenance (listing, commit sha, tree digest) and every definition,
 * rubric and datatype with its content hash. A reference the pack neither bundles nor finds in the
 * workspace, or a bundled datatype that conflicts with the workspace's, refuses the whole install.
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
const { getDatatype } = await import('../datatype-registry-store');
const { installTypePack, readTypePackReceipt } = await import('./type-pack');
const { provisionPackRubric } = await import('./type-pack-io');
const { definitionContentHash } = await import('../plan-types/content-hash');
const fx = await import('../../test/type-pack-fixture');

const WS = 'default';
const NS = `zzz-tpr-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { workspaceId: WS, installedBy: 'item-type-pack-receipt-test' };
const HEX64 = /^[0-9a-f]{64}$/;

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

function install(pack: import('../../test/type-pack-fixture').FakePack) {
  return installTypePack(h.sql, pack, CTX, { ...fx.fakeCupboard([pack]), provisionRubric: provisionPackRubric });
}

describe('installing a type pack co-installs and pins what it references (R-24)', () => {
  const rubricId = `${NS}-memo-review`;
  const datatypeId = `${NS}-memo-completion`;

  it('co-installs the bundled rubric and datatype and pins the pack, each definition and each resource in the receipt', async () => {
    const memo = `${NS}/reviewed-memo`;
    const pack = fx.fakePack(`${NS}-bundled`, {
      itemTypes: [fx.itemTypeDef(memo, { rubricRef: rubricId, completion: { datatypeRef: datatypeId } })],
      rubrics: [fx.rubricSource(rubricId)],
      datatypes: [fx.datatypeSource(datatypeId)],
    });

    const result = await install(pack);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    // Both referenced resources are now present in the workspace.
    expect(await readRubric(rubricId)).toMatchObject({ rubricId, status: 'active' });
    const datatype = await getDatatype(h.sql, WS, datatypeId);
    expect(datatype?.payloadSchema).toEqual(fx.datatypeSource(datatypeId).payloadSchema);

    const receipt = await readTypePackReceipt(h.sql, WS, pack.listing.listingId);
    expect(receipt).toMatchObject({
      listingId: pack.listing.listingId,
      packName: pack.manifest.name,
      packVersion: '1.0.0',
      commitSha: pack.listing.pin!.commitSha,
      treeDigest: pack.listing.pin!.treeDigest,
      installedBy: CTX.installedBy,
    });
    expect(receipt!.itemTypes).toEqual([{ id: memo, revision: 1, contentHash: expect.stringMatching(HEX64) }]);
    expect(receipt!.rubrics).toEqual([
      { ref: rubricId, source: 'pack', contentHash: definitionContentHash(fx.rubricSource(rubricId)) },
    ]);
    expect(receipt!.datatypes).toEqual([
      { ref: datatypeId, source: 'pack', contentHash: definitionContentHash(fx.datatypeSource(datatypeId).payloadSchema) },
    ]);
  });

  it('pins a rubric and datatype already present in the workspace as workspace-sourced', async () => {
    const memo = `${NS}/second-memo`;
    const pack = fx.fakePack(`${NS}-reuses`, {
      itemTypes: [fx.itemTypeDef(memo, { rubricRef: rubricId, completion: { datatypeRef: datatypeId } })],
    });

    const result = await install(pack);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const receipt = await readTypePackReceipt(h.sql, WS, pack.listing.listingId);
    expect(receipt!.rubrics).toEqual([{ ref: rubricId, source: 'workspace', contentHash: null }]);
    expect(receipt!.datatypes).toEqual([
      { ref: datatypeId, source: 'workspace', contentHash: definitionContentHash(fx.datatypeSource(datatypeId).payloadSchema) },
    ]);
  });

  it('refuses an item type whose rubric the pack does not bundle and the workspace does not have, writing nothing', async () => {
    const memo = `${NS}/orphan-memo`;
    const pack = fx.fakePack(`${NS}-orphan`, { itemTypes: [fx.itemTypeDef(memo, { rubricRef: `${NS}-nowhere-rubric` })] });

    const result = await install(pack);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_pack_dependency_missing');
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/orphan`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    expect(await readTypePackReceipt(h.sql, WS, pack.listing.listingId)).toBeNull();
  });

  it('refuses a bundled datatype that conflicts with the workspace datatype of the same id, writing nothing', async () => {
    const memo = `${NS}/conflicting-memo`;
    const conflicting = { ...fx.datatypeSource(datatypeId), payloadSchema: { type: 'object', required: ['approver'], properties: { approver: { type: 'string' } } } };
    const pack = fx.fakePack(`${NS}-conflict`, {
      itemTypes: [fx.itemTypeDef(memo, { completion: { datatypeRef: datatypeId } })],
      datatypes: [conflicting],
    });

    const result = await install(pack);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_pack_dependency_conflict');
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/conflicting`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    expect((await getDatatype(h.sql, WS, datatypeId))?.payloadSchema).toEqual(fx.datatypeSource(datatypeId).payloadSchema);
  });

  it('re-installing the same pack is idempotent: the definitions are unchanged and one receipt remains', async () => {
    const memo = `${NS}/again-memo`;
    const pack = fx.fakePack(`${NS}-again`, { itemTypes: [fx.itemTypeDef(memo)] });

    const first = await install(pack);
    const second = await install(pack);

    expect(first.ok && second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.receipts[0]!.itemTypes).toEqual([{ id: memo, revision: 1, contentHash: expect.stringMatching(HEX64), unchanged: true }]);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/again`)).toEqual({ itemTypes: 1, planTypes: 0, receipts: 0 });
    expect(await fx.countTypeRows(h.sql, WS, `${NS}-again`)).toMatchObject({ receipts: 1 });
  });
});
