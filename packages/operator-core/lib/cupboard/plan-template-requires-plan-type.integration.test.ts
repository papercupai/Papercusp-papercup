/**
 * R-17 (plan-item-types-registry-cupboard-2026-10-20 P-006, D-008), on real Postgres: installing a
 * plan template whose listing declares `requires_plan_type` also installs that plan type and the
 * item types it references. A template whose plan type references a pending item-type pack refuses
 * the WHOLE install: no registry row, no receipt and no seeded template.
 *
 * The Cupboard listing, the template's git content and the template seeder are injected; the plan
 * template install path (installPlanFromCupboard), the type-pack planner and applier, and the
 * registry write path are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import type { FakePack, Ref } from '../../test/type-pack-fixture';

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
const { installPlanFromCupboard } = await import('./install-plan-io');
const { readTypePackReceipt } = await import('./type-pack');
const fx = await import('../../test/type-pack-fixture');

const WS = 'default';
const NS = `zzz-tpt-${Math.random().toString(36).slice(2, 8)}`;
const REF = 'reviewed-memo-plan';

let db: OrgTestDb;
let scratch: string;
const savedHome = process.env.PAPERCUSP_HOME;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  h.appSql = db.appSql;
  scratch = mkdtempSync(join(tmpdir(), 'plan-template-requires-plan-type-'));
  // The template installs into the user layer under PAPERCUSP_HOME; keep it off the real home.
  process.env.PAPERCUSP_HOME = join(scratch, 'home');
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
  if (savedHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = savedHome;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function templateMarkdown(slug: string, planType: string): string {
  return `---
title: Reviewed memo plan
slug: ${slug}
status: draft
type: ${planType}
---

## Goal

Write memos that a reviewer signs off.

## Phase 1

- **P-001** \`todo\` Write the memo.
`;
}

/** A template listing requiring `required`, its git content, and a seeder that records each seed. */
function template(listingId: string, slug: string, required: Ref, packs: FakePack[]) {
  const seeded: string[] = [];
  const cupboard = fx.fakeCupboard(packs);
  // The template installs under plan-templates/<ref>, and a second install of the same ref is
  // refused as an overwrite, so every template in this file gets its own ref.
  const ref = `${REF}-${listingId}`;
  const deps = {
    resolveListing: async (id: string) => ({
      githubUrl: 'https://github.com/acme/plan-templates',
      ref,
      listingId: id,
      requiresPlanType: JSON.stringify(required),
    }),
    gitDeps: {
      cloneRepo: async (_url: string, dest: string) => {
        await fs.mkdir(join(dest, ref), { recursive: true });
        await fs.writeFile(join(dest, ref, 'plan.md'), templateMarkdown(slug, required.id));
      },
      fetchAtSha: async () => { throw new Error('the template listing is unpinned in this test'); },
      listTreeBlobs: async () => [],
      tmpDir: () => scratch,
    },
    seedPlanTemplate: async (args: { slug: string }) => {
      seeded.push(args.slug);
      return { seeded: true };
    },
    planTypes: {
      sql: h.sql,
      workspaceId: WS,
      installedBy: 'plan-template-requires-plan-type-test',
      deps: { ...cupboard, provisionRubric: async () => { throw new Error('no rubric in this test'); } },
    },
  };
  return { install: () => installPlanFromCupboard({ listingId }, deps), seeded, cupboard };
}

describe('installing a plan template pulls in the plan type it requires (R-17)', () => {
  it('installs the required plan type and the item types it references, then seeds the template', async () => {
    const memo = `${NS}/memo`;
    const planType = `${NS}/review-plan`;
    const itemPack = fx.fakePack(`${NS}-items`, { itemTypes: [fx.itemTypeDef(memo)] });
    const planPack = fx.fakePack(`${NS}-plans`, { planTypes: [fx.planTypeDef(planType, [{ id: memo, minRevision: 1 }])] });
    const tpl = template(`${NS}-template`, `${NS}-reviewed-memos`, { id: planType, minRevision: 1 }, [itemPack, planPack]);

    const result = await tpl.install();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(tpl.seeded).toEqual([`${NS}-reviewed-memos`]);
    expect(result.result.planType).toMatchObject({ required: { id: planType, minRevision: 1 }, resolvedBy: 'listing' });
    expect(result.result.planType!.installed.map((r) => r.listingId)).toEqual([itemPack.listing.listingId, planPack.listing.listingId]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', planType))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: planPack.listing.listingId }]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_item_type_definitions', memo))
      .toEqual([{ revision: 1, origin: 'pack', sourceListingId: itemPack.listing.listingId }]);
    expect(await readTypePackReceipt(h.sql, WS, planPack.listing.listingId)).not.toBeNull();
  });

  it('needs no install when the workspace already resolves the required plan type', async () => {
    const planType = `${NS}/review-plan`;
    const tpl = template(`${NS}-template-again`, `${NS}-reviewed-memos-again`, { id: planType, minRevision: 1 }, []);

    const result = await tpl.install();

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.result.planType).toMatchObject({ resolvedBy: 'registry', installed: [] });
    expect(tpl.cupboard.lookups).toEqual([]);
    expect(tpl.seeded).toEqual([`${NS}-reviewed-memos-again`]);
  });

  it('refuses the whole install when the plan type references a pending item-type pack', async () => {
    const memo = `${NS}/pending-memo`;
    const planType = `${NS}/pending-plan`;
    const pendingItems = fx.fakePack(`${NS}-items-pending`, { itemTypes: [fx.itemTypeDef(memo)] }, { reviewStatus: 'pending' });
    const planPack = fx.fakePack(`${NS}-plans-pending`, { planTypes: [fx.planTypeDef(planType, [{ id: memo, minRevision: 1 }])] });
    const tpl = template(`${NS}-template-pending`, `${NS}-pending-memos`, { id: planType, minRevision: 1 }, [pendingItems, planPack]);

    const result = await tpl.install();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(422);
    expect(!result.ok && result.detail).toBe('type_provider_missing');
    expect(!result.ok && result.error).toMatch(/awaiting review/);
    expect(tpl.seeded).toEqual([]);
    expect(await fx.countTypeRows(h.sql, WS, `${NS}/pending`)).toEqual({ itemTypes: 0, planTypes: 0, receipts: 0 });
    expect(await readTypePackReceipt(h.sql, WS, planPack.listing.listingId)).toBeNull();
  });

  it('refuses the whole install when the required plan type itself is only offered by a pending pack', async () => {
    const planType = `${NS}/unreviewed-plan`;
    const pendingPlans = fx.fakePack(`${NS}-plans-unreviewed`, {
      planTypes: [fx.planTypeDef(planType, [{ id: `${NS}/memo`, minRevision: 1 }])],
    }, { reviewStatus: 'pending' });
    const tpl = template(`${NS}-template-unreviewed`, `${NS}-unreviewed-memos`, { id: planType, minRevision: 1 }, [pendingPlans]);

    const result = await tpl.install();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.detail).toBe('type_provider_missing');
    expect(tpl.seeded).toEqual([]);
    expect(await fx.definitionSource(h.sql, WS, 'plan_type_definitions', planType)).toEqual([]);
  });
});
