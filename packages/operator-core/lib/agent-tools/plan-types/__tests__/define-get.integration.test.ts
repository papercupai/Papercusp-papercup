/**
 * R-12: defined types read back unchanged
 * (plan-item-types-registry-cupboard-2026-10-20 P-005).
 *
 * Through the real projected dispatch against an isolated integration PG:
 * - a definition stored by plan-types:define reads back unchanged through plan-types:get;
 * - plan-types:list includes every defined type and leaves out retired revisions;
 * - a retired revision no longer resolves for a new activation, while an exact read still
 *   returns it (a pinned plan keeps resolving it, R-14).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import '../define';
import '../get';
import '../list';
import '../retire';
import '../../plans/new';
import '../../plans/add-item';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { definitionContentHash } from '../../../plan-types/content-hash';
import { loadTypeRegistry } from '../../../plan-types/registry';
import { pinPlanTypes } from '../../../plan-types/pins';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from '../../plans/__tests__/_pg-tool-fixture';
import { brief, expectOk, makeCaller } from './_tool-call';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-ptdefine-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const NS = `zzz-ptdefine-${Math.random().toString(36).slice(2, 8)}`;
const CLAUSE = `${NS}/clause`;
const BUILD = `${NS}/build`;

const call = makeCaller(HARNESS, 'plan-types-define-get');
let fx: PlanPgFixture;
let admin: postgres.Sql;

const clauseV1 = {
  schemaVersion: 1,
  id: CLAUSE,
  revision: 1,
  title: 'Contract clause',
  description: 'A clause drafted and reviewed as code.',
  modules: ['code', 'generic-core'],
  completion: { schema: { type: 'object', required: ['clauseRef'], properties: { clauseRef: { type: 'string' } } } },
  criteriaTemplate: [{ key: 'reviewed', title: 'Reviewed by counsel' }],
  display: { label: 'Clause', icon: 'scroll' },
};
const clauseV2 = { ...clauseV1, revision: 2, title: 'Contract clause (v2)' };
const buildV1 = {
  schemaVersion: 1,
  id: BUILD,
  revision: 1,
  title: 'Build plan',
  base: 'general',
  classes: ['plan-class-feature-ship'],
  defaultItemType: { id: CLAUSE },
  itemTypes: [{ id: CLAUSE, minRevision: 1 }, { id: 'papercusp/doc' }],
};

async function storedRows(id: string) {
  return admin<{ revision: number; retired_at: Date | null }[]>`
    SELECT revision, retired_at FROM harness_shared.plan_item_type_definitions
     WHERE workspace_id = ${WS} AND type_id = ${id} ORDER BY revision`;
}

function listedIds(payload: Record<string, unknown>): string[] {
  return (payload.types as Array<{ typeId: string; revision: number }>).map((t) => `${t.typeId}@${t.revision}`);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_type_pins WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_item_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('R-12: plan-types:define then plan-types:get', () => {
  it('an item type reads back exactly as defined', async () => {
    const defined = expectOk(await call('plan-types:define', { kind: 'item-type', definition: clauseV1 }));
    expect(defined.revision).toBe(1);
    expect(defined.definition).toEqual(clauseV1);
    expect(defined.contentHash).toBe(definitionContentHash(clauseV1));

    const got = expectOk(await call('plan-types:get', { kind: 'item-type', typeId: CLAUSE }));
    const type = got.type as Record<string, unknown>;
    expect(type.definition, brief(got)).toEqual(clauseV1);
    expect(type.contentHash).toBe(definitionContentHash(clauseV1));
    expect(type.origin).toBe('workspace');
    expect(type.retired).toBe(false);
  });

  it('a plan type reads back exactly as defined', async () => {
    expectOk(await call('plan-types:define', { kind: 'plan-type', definition: buildV1 }));
    const got = expectOk(await call('plan-types:get', { kind: 'plan-type', typeId: BUILD, revision: 1 }));
    expect((got.type as Record<string, unknown>).definition).toEqual(buildV1);
  });

  it('a built-in reads back from the catalog', async () => {
    const got = expectOk(await call('plan-types:get', { kind: 'item-type', typeId: 'papercusp/code' }));
    const type = got.type as Record<string, unknown>;
    expect(type.origin).toBe('builtin');
    expect((type.definition as { id: string }).id).toBe('papercusp/code');
  });
});

describe('R-12: plan-types:list and plan-types:retire', () => {
  it('lists every defined type, at its current revision', async () => {
    const listed = expectOk(await call('plan-types:list', { prefix: `${NS}/` }));
    expect(listedIds(listed).sort()).toEqual([`${BUILD}@1`, `${CLAUSE}@1`].sort());
    const all = expectOk(await call('plan-types:list', {}));
    expect(listedIds(all)).toContain('papercusp/code@1');
    expect(listedIds(all)).toContain(`${CLAUSE}@1`);
  });

  it('a newer revision replaces the listed one; retiring it brings the older one back', async () => {
    expectOk(await call('plan-types:define', { kind: 'item-type', definition: clauseV2 }));
    expect(listedIds(expectOk(await call('plan-types:list', { kind: 'item-type', prefix: `${NS}/` })))).toEqual([`${CLAUSE}@2`]);

    const retired = expectOk(await call('plan-types:retire', { kind: 'item-type', typeId: CLAUSE, revision: 2, reason: 'superseded in test' }));
    expect(retired.nowResolves).toBe(1);
    expect(listedIds(expectOk(await call('plan-types:list', { kind: 'item-type', prefix: `${NS}/` })))).toEqual([`${CLAUSE}@1`]);
    expect((await storedRows(CLAUSE)).map((r) => [r.revision, r.retired_at !== null])).toEqual([[1, false], [2, true]]);
  });

  it('an id whose every revision is retired is not listed, unless includeRetired', async () => {
    expectOk(await call('plan-types:retire', { kind: 'item-type', typeId: CLAUSE, revision: 1, reason: 'withdrawn in test' }));
    expect(listedIds(expectOk(await call('plan-types:list', { kind: 'item-type', prefix: `${NS}/` })))).toEqual([]);
    const withRetired = expectOk(await call('plan-types:list', { kind: 'item-type', prefix: `${NS}/`, includeRetired: true }));
    expect(listedIds(withRetired)).toEqual([`${CLAUSE}@1`, `${CLAUSE}@2`]);
    expect((withRetired.types as Array<{ retired: boolean }>).every((t) => t.retired)).toBe(true);
  });

  it('a retired revision still reads back by exact revision', async () => {
    const got = expectOk(await call('plan-types:get', { kind: 'item-type', typeId: CLAUSE, revision: 2 }));
    const type = got.type as Record<string, unknown>;
    expect(type.retired).toBe(true);
    expect(type.retireReason).toBe('superseded in test');
    expect(type.definition).toEqual(clauseV2);
  });
});

describe('R-12: a retired revision does not resolve for a new activation', () => {
  it('activation pins the live revision, never a retired one', async () => {
    const memo = `${NS}/memo`;
    const memoV1 = { schemaVersion: 1, id: memo, revision: 1, title: 'Memo', modules: ['generic-core'] };
    expectOk(await call('plan-types:define', { kind: 'item-type', definition: memoV1 }));
    expectOk(await call('plan-types:define', { kind: 'item-type', definition: { ...memoV1, revision: 2, modules: ['generic-core', 'code'] } }));
    expectOk(await call('plan-types:retire', { kind: 'item-type', typeId: memo, revision: 2, reason: 'withdrawn in test' }));

    const registry = await loadTypeRegistry(admin, { workspaceId: WS });
    expect(registry.itemType(memo)?.definition.revision).toBe(1);
    expect(registry.itemType(CLAUSE)).toBeNull();

    // Dated, so plans:new keeps it as given (it appends today's date to an undated slug).
    const slug = `r12-activation-${RUN}-2026-01-01`;
    expectOk(await call('plans:new', { slug, title: 'R-12 activation', verificationProfile: 'general', force: true }));
    expectOk(await call('plans:add-item', { slug, phase: 'Phase 1', importance: 'normal', items: [{ text: 'Write it', deliverable: memo }] }));
    // The pin writer an activating plan write runs (with-plan-lock.ts).
    const pinned = await pinPlanTypes(
      admin,
      { workspaceId: WS, harnessSlug: HARNESS, planSlug: slug },
      { verificationProfile: 'general', planType: null, deliverables: [memo, CLAUSE] },
      'su-test',
      'activation',
    );
    expect(pinned).toBeGreaterThan(0);
    const pins = await admin<{ type_id: string; revision: number }[]>`
      SELECT type_id, revision FROM harness_shared.plan_type_pins
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug} AND kind = 'item-type'
       ORDER BY type_id`;
    const byId = new Map(pins.map((p) => [p.type_id, Number(p.revision)]));
    expect(byId.get(memo)).toBe(1);
    // Every revision of CLAUSE is retired, so a new activation resolves none of them.
    expect(byId.has(CLAUSE)).toBe(false);
  });
});
