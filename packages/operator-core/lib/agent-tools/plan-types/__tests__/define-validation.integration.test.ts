/**
 * R-13: definitions may only use catalogued verification modules
 * (plan-item-types-registry-cupboard-2026-10-20 P-005).
 *
 * plan-types:define validates each definition against the definition schema, the
 * verification-module catalog and the generic-core floor, and refuses anything else WITHOUT
 * storing it. It also refuses the first-party namespace, a revision that is not the next one,
 * and references that do not resolve. Every refusal is checked against the table: nothing is
 * written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import '../define';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from '../../plans/__tests__/_pg-tool-fixture';
import { brief, expectOk, expectRefusal, makeCaller } from './_tool-call';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-ptvalid-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const NS = `zzz-ptvalid-${Math.random().toString(36).slice(2, 8)}`;

const call = makeCaller(HARNESS, 'plan-types-define-validation');
let fx: PlanPgFixture;
let admin: postgres.Sql;

function itemType(id: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, id, revision: 1, title: id, modules: ['generic-core'], ...extra };
}

async function storedCount(table: 'plan_item_type_definitions' | 'plan_type_definitions', id: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.${admin(table)} WHERE workspace_id = ${WS} AND type_id = ${id}`;
  return row!.n;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_item_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
    await admin`DELETE FROM harness_shared.plan_type_definitions WHERE workspace_id = ${WS} AND type_id LIKE ${`${NS}/%`}`.catch(() => {});
  }
  await fx?.dispose();
});

describe('R-13: the module catalog and the definition schema', () => {
  it('refuses a module outside the verification-module catalog, and stores nothing', async () => {
    const id = `${NS}/telepathic`;
    const res = expectRefusal(
      await call('plan-types:define', { kind: 'item-type', definition: itemType(id, { modules: ['generic-core', 'telepathy'] }) }),
      'definition_invalid',
    );
    expect(String(res.message), brief(res)).toMatch(/modules/);
    expect(await storedCount('plan_item_type_definitions', id)).toBe(0);
  });

  it('refuses a definition that fails the schema (missing title, unknown key), and stores nothing', async () => {
    const missing = `${NS}/untitled`;
    const { title: _title, ...untitled } = itemType(missing);
    expectRefusal(await call('plan-types:define', { kind: 'item-type', definition: untitled }), 'definition_invalid');
    expect(await storedCount('plan_item_type_definitions', missing)).toBe(0);

    const extra = `${NS}/extra-key`;
    expectRefusal(
      await call('plan-types:define', { kind: 'item-type', definition: itemType(extra, { runScript: 'rm -rf /' }) }),
      'definition_invalid',
    );
    expect(await storedCount('plan_item_type_definitions', extra)).toBe(0);
  });

  it('refuses a module set without generic-core (the R-9 floor)', async () => {
    const id = `${NS}/no-floor`;
    expectRefusal(await call('plan-types:define', { kind: 'item-type', definition: itemType(id, { modules: ['code'] }) }), 'definition_invalid');
    expect(await storedCount('plan_item_type_definitions', id)).toBe(0);
  });

  it('refuses a plan type whose default item type is not one of its item types', async () => {
    const id = `${NS}/bad-plan`;
    const def = {
      schemaVersion: 1, id, revision: 1, title: 'Bad', base: 'general', classes: ['plan-class-feature-ship'],
      defaultItemType: { id: 'papercusp/code' }, itemTypes: [{ id: 'papercusp/doc' }],
    };
    expectRefusal(await call('plan-types:define', { kind: 'plan-type', definition: def }), 'definition_invalid');
    expect(await storedCount('plan_type_definitions', id)).toBe(0);
  });

  it('stores a definition naming only catalogued modules (positive control)', async () => {
    const id = `${NS}/clause`;
    expectOk(await call('plan-types:define', { kind: 'item-type', definition: itemType(id, { modules: ['generic-core', 'code', 'design-evidence'] }) }));
    expect(await storedCount('plan_item_type_definitions', id)).toBe(1);
  });
});

describe('R-13: namespace, revision order and references', () => {
  it('refuses the first-party papercusp/ namespace', async () => {
    expectRefusal(await call('plan-types:define', { kind: 'item-type', definition: itemType('papercusp/shadow') }), 'first_party_namespace_reserved');
  });

  it('refuses any revision but the next one', async () => {
    const id = `${NS}/ordered`;
    const skipped = expectRefusal(
      await call('plan-types:define', { kind: 'item-type', definition: itemType(id, { revision: 3 }) }),
      'revision_out_of_order',
    );
    expect(skipped.expectedRevision).toBe(1);
    expectOk(await call('plan-types:define', { kind: 'item-type', definition: itemType(id) }));
    const again = expectRefusal(await call('plan-types:define', { kind: 'item-type', definition: itemType(id) }), 'revision_out_of_order');
    expect(again.expectedRevision).toBe(2);
    expect(await storedCount('plan_item_type_definitions', id)).toBe(1);
  });

  it('refuses an extends parent that does not resolve', async () => {
    const id = `${NS}/orphan`;
    const res = expectRefusal(
      await call('plan-types:define', { kind: 'item-type', definition: itemType(id, { extends: { id: `${NS}/missing-parent` } }) }),
      'reference_unresolved',
    );
    expect(res.references).toEqual([`${NS}/missing-parent`]);
    expect(await storedCount('plan_item_type_definitions', id)).toBe(0);
  });

  it('refuses a plan type listing an item type that does not resolve', async () => {
    const id = `${NS}/dangling-plan`;
    const def = {
      schemaVersion: 1, id, revision: 1, title: 'Dangling', base: 'general', classes: ['plan-class-feature-ship'],
      defaultItemType: { id: 'papercusp/doc' }, itemTypes: [{ id: 'papercusp/doc' }, { id: `${NS}/nowhere` }],
    };
    const res = expectRefusal(await call('plan-types:define', { kind: 'plan-type', definition: def }), 'reference_unresolved');
    expect(res.references).toEqual([`${NS}/nowhere`]);
    expect(await storedCount('plan_type_definitions', id)).toBe(0);
  });
});
