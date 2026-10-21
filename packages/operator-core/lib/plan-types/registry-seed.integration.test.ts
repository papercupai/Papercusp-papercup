/**
 * The first-party seed of the item-type and plan-type registry
 * (plan-item-types-registry-cupboard-2026-10-20 P-001, requirements R-1 and R-2).
 *
 * Runs against the integration-tier baseline PG, which applies every armed migration, so
 * migration 1541's tables and CHECKs are the real ones. It checks:
 *   - R-1: each of the six built-in deliverable kinds resolves to its first-party item type,
 *     in an existing workspace and in one created after the migration;
 *   - R-2: each verification profile resolves to its first-party plan type, with its classes
 *     and default item type, in both workspaces;
 *   - a registry row can never shadow a first-party id, and workspace rows resolve by
 *     revision range, hive scope and retirement, with an invalid row reported rather than used.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { DELIVERABLE_KINDS, VERIFICATION_PROFILES } from '../plan-verification-profile';
import { loadTypeRegistry } from './registry';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = DEFAULT_WORKSPACE_ID;
/** A workspace id that exists only after the migration ran: no seed could have reached it. */
const FRESH_WS = `zzz-ptr-fresh-${RUN}`;
const NS = `zzz-ptr-${RUN.replace(/[^a-z0-9]/g, '')}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;

function itemTypeDef(id: string, revision: number, modules: string[] = []) {
  // Every listed set names generic-core: a set without it is refused (R-9, definition-floor.test.ts).
  return { schemaVersion: 1, id, revision, title: `${id} r${revision}`, modules: ['generic-core', ...modules] };
}

async function insertItemType(
  workspaceId: string,
  def: Record<string, unknown> & { id: string; revision: number },
  extra: { hive?: string | null; retired?: boolean } = {},
) {
  await admin`
    INSERT INTO harness_shared.plan_item_type_definitions
      (workspace_id, hive_slug, type_id, revision, definition, origin, retired_at, retire_reason)
    VALUES (${workspaceId}, ${extra.hive ?? null}, ${def.id}, ${def.revision}, ${admin.json(def as never)}, 'workspace',
            ${extra.retired ? new Date() : null}, ${extra.retired ? 'fixture retire' : null})`;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
}, 120_000);

afterAll(async () => {
  if (!admin) return;
  await admin`DELETE FROM harness_shared.plan_item_type_definitions WHERE type_id LIKE ${`${NS}/%`}`;
  await admin`DELETE FROM harness_shared.plan_type_definitions WHERE type_id LIKE ${`${NS}/%`}`;
  await fx.dispose();
});

describe('migration 1541', () => {
  it('created both registry tables', async () => {
    // Read the catalog by schema + name: `to_regclass(...)::text` drops the schema prefix
    // whenever harness_shared is on the search_path, so it is not a stable assertion target.
    const rows = await admin<Array<{ relname: string }>>`
      SELECT c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relkind = 'r'
         AND c.relname IN ('plan_item_type_definitions', 'plan_type_definitions')
       ORDER BY c.relname`;
    expect(rows.map((r) => r.relname)).toEqual(['plan_item_type_definitions', 'plan_type_definitions']);
  });
});

describe('first-party item types (R-1)', () => {
  it('every built-in deliverable kind resolves to a first-party item type in an existing workspace', async () => {
    const registry = await loadTypeRegistry(admin, { workspaceId: WS });
    expect(DELIVERABLE_KINDS).toHaveLength(6);
    for (const kind of DELIVERABLE_KINDS) {
      const resolved = registry.itemType(`papercusp/${kind}`);
      expect(resolved, kind).not.toBeNull();
      expect(resolved!.origin).toBe('builtin');
      expect(resolved!.definition).toMatchObject({ schemaVersion: 1, id: `papercusp/${kind}`, revision: 1 });
      expect(resolved!.definition.modules[0]).toBe('generic-core');
    }
  });

  it('in a workspace created after the migration, the code kind resolves to its first-party definition', async () => {
    const [{ n }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.plan_item_type_definitions WHERE workspace_id = ${FRESH_WS}`;
    expect(n).toBe(0);
    const registry = await loadTypeRegistry(admin, { workspaceId: FRESH_WS });
    const code = registry.itemType('papercusp/code');
    expect(code?.origin).toBe('builtin');
    expect(code?.definition.modules).toEqual(['generic-core', 'code']);
    for (const kind of DELIVERABLE_KINDS) expect(registry.itemType(`papercusp/${kind}`), kind).not.toBeNull();
  });
});

describe('first-party plan types (R-2)', () => {
  it('every verification profile resolves to a first-party plan type with its classes and default item type', async () => {
    for (const workspaceId of [WS, FRESH_WS]) {
      const registry = await loadTypeRegistry(admin, { workspaceId });
      for (const profile of VERIFICATION_PROFILES) {
        const resolved = registry.planType(`papercusp/${profile}`);
        expect(resolved, `${workspaceId} ${profile}`).not.toBeNull();
        expect(resolved!.origin).toBe('builtin');
        expect(resolved!.definition.base).toBe(profile);
        expect(resolved!.definition.classes.length).toBeGreaterThan(0);
        // The default item type is itself resolvable, so no profile default dangles.
        const defaultRef = resolved!.definition.defaultItemType;
        expect(registry.itemType(defaultRef.id, defaultRef)?.origin).toBe('builtin');
      }
    }
  });

  it('in a workspace created after the migration, the coding profile resolves to papercusp/coding', async () => {
    const registry = await loadTypeRegistry(admin, { workspaceId: FRESH_WS });
    const coding = registry.planType('papercusp/coding');
    expect(coding?.definition).toMatchObject({ id: 'papercusp/coding', base: 'coding', defaultItemType: { id: 'papercusp/code' } });
  });
});

describe('registry rows', () => {
  it('a registry row cannot use the first-party namespace', async () => {
    await expect(insertItemType(WS, itemTypeDef('papercusp/code', 2))).rejects.toThrow(/first_party_reserved/);
  });

  it('a row whose definition id does not match its row is refused by the DB', async () => {
    await expect(admin`
      INSERT INTO harness_shared.plan_item_type_definitions (workspace_id, type_id, revision, definition, origin)
      VALUES (${WS}, ${`${NS}/mismatch`}, 1, ${admin.json(itemTypeDef(`${NS}/other`, 1) as never)}, 'workspace')`)
      .rejects.toThrow(/definition_matches_row/);
  });

  it('resolves the highest admitted revision, prefers the hive row, skips retired rows and reports invalid ones', async () => {
    const id = `${NS}/legal-review`;
    await insertItemType(WS, itemTypeDef(id, 1));
    await insertItemType(WS, itemTypeDef(id, 2, ['code']));
    await insertItemType(WS, itemTypeDef(id, 3), { retired: true });
    await insertItemType(WS, { ...itemTypeDef(id, 2), title: 'hive copy' }, { hive: 'hive-a' });
    // Valid for the DB CHECK (id/revision/schemaVersion match) but not for the schema.
    await insertItemType(WS, { ...itemTypeDef(`${NS}/broken`, 1), modules: ['not-a-module'] });

    const ws = await loadTypeRegistry(admin, { workspaceId: WS });
    expect(ws.itemType(id)?.definition).toMatchObject({ revision: 2, modules: ['generic-core', 'code'] });
    expect(ws.itemType(id, { maxRevision: 1 })?.definition.revision).toBe(1);
    expect(ws.itemType(id, { minRevision: 3 })).toBeNull();
    expect(ws.itemType(`${NS}/broken`)).toBeNull();
    expect(ws.invalidRows.map((row) => row.typeId)).toContain(`${NS}/broken`);

    const hive = await loadTypeRegistry(admin, { workspaceId: WS, hiveSlug: 'hive-a' });
    expect(hive.itemType(id)?.definition.title).toBe('hive copy');
    expect(hive.itemType(id)?.hiveSlug).toBe('hive-a');

    // Another workspace never sees these rows.
    const fresh = await loadTypeRegistry(admin, { workspaceId: FRESH_WS });
    expect(fresh.itemType(id)).toBeNull();
  });
});
