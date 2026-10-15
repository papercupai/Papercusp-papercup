/**
 * seed-learning-singletons.integration.test.ts — the learning-loop singleton
 * cutover against a real Postgres (harness_shared.routines).
 *
 * Two PG-heavy behaviors a fake-sql unit test can't prove:
 *  - cutoverActiveLearningSingleton: ATOMIC behavior-neutral move — copy EVERY
 *    column of an ACTIVE papercup row into a @singleton row, then DELETE the
 *    papercup row, in one transaction (D-023 step 4). Dark/missing rows are skipped.
 *  - materializeLearningSingletons: the D-023 COLLISION GUARD (an ACTIVE legacy row
 *    is left untouched, never darkened) and the retire-legacy DELETE's `active=false`
 *    belt-and-braces guard.
 *
 * The blueprint machinery (loadBuiltinBlueprint / materialize-triggers / flags) is
 * mocked — only the routines SQL is exercised for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-seed';
const HOME = 'acme-home';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  declaresSingleton: true,
  platformOn: true,
  isPlatform: false,
  singletonName: 'graduation-singleton',
}));
vi.mock('@papercusp/orchestrator/blueprint', () => ({
  loadBuiltinBlueprint: () => ({ blueprint: { triggers: { schedule: h.declaresSingleton ? [{ singleton: true }] : [{}] } } }),
}));
vi.mock('./materialize-triggers', () => ({
  materializeBlueprintTriggers: async () => [{ hostSlug: '@singleton', name: 'graduation-singleton', singleton: true }],
  triggerRoutineSpecs: () => [{ name: h.singletonName, singleton: true }],
  isPlatformImprovementLoop: () => h.isPlatform,
  platformImprovementLoopsEnabled: async () => h.platformOn,
  singletonRoutinePayloadDefaults: (blueprintId: string) => (blueprintId === 'scout' ? { cycleTimeoutMs: 600_000 } : {}),
  SINGLETON_TRIGGER_HOST_SLUG: '@singleton',
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('@papercusp/flags', () => ({ FLAGS: { PLATFORM_IMPROVEMENT_LOOPS: 'platform_improvement_loops' } }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => HOME }));

const { cutoverActiveLearningSingleton, materializeLearningSingletons } = await import('./seed-learning-singletons');

const ENTRY = { blueprintId: 'graduation', legacyRoutine: 'graduation-scan' };
const SCOUT_ENTRY = { blueprintId: 'scout', legacyRoutine: 'scout-cycle' };
let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `seed_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: PK(id) + UNIQUE(install_slug, name) (the ON CONFLICT target).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text NOT NULL,
      install_slug text NOT NULL,
      name text NOT NULL,
      trigger_kind text NOT NULL,
      trigger_config jsonb NOT NULL,
      target_role text NOT NULL,
      payload_template jsonb,
      concurrency text DEFAULT 'queue' NOT NULL,
      catchup text DEFAULT 'skip-old' NOT NULL,
      active boolean DEFAULT true NOT NULL,
      last_fired_at timestamptz,
      next_fire_at timestamptz,
      created_at timestamptz DEFAULT now() NOT NULL,
      updated_at timestamptz DEFAULT now() NOT NULL,
      metadata jsonb,
      workspace_id text NOT NULL,
      CONSTRAINT routines_pkey PRIMARY KEY (id),
      CONSTRAINT routines_install_slug_name_key UNIQUE (install_slug, name),
      CONSTRAINT routines_workspace_nonempty CHECK (workspace_id <> '')
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.routines`;
  h.declaresSingleton = true;
  h.platformOn = true;
  h.isPlatform = false;
  h.singletonName = 'graduation-singleton';
});

async function insertLegacy(active: boolean, over: Record<string, unknown> = {}, entry = ENTRY) {
  await rootSql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, payload_template,
       concurrency, catchup, active, last_fired_at, next_fire_at, workspace_id, metadata)
    VALUES (${`rt_${HOME}_${entry.legacyRoutine}`}, ${HOME}, ${entry.legacyRoutine}, 'schedule',
            ${rootSql.json((over.trigger_config as object) ?? { cron: '0 0 * * *' })}, 'worker',
            ${rootSql.json((over.payload_template as object) ?? { blueprintId: entry.blueprintId, k: 'v' })},
            'queue', 'skip-old', ${active},
            ${(over.last_fired_at as string) ?? '2026-01-01T00:00:00Z'},
            ${(over.next_fire_at as string) ?? '2026-02-01T00:00:00Z'},
            ${WS}, ${rootSql.json((over.metadata as object) ?? { m: 1 })})`;
}

describe('cutoverActiveLearningSingleton (PG, atomic copy)', () => {
  it('skips when there is no legacy row', async () => {
    const r = await cutoverActiveLearningSingleton(rootSql, WS, ENTRY, { execute: true });
    expect(r).toMatchObject({ found: false, cutOver: false, skipped: 'not-found' });
  });

  it('skips a DARK legacy row (that path is for the dark CLI)', async () => {
    await insertLegacy(false);
    const r = await cutoverActiveLearningSingleton(rootSql, WS, ENTRY, { execute: true });
    expect(r).toMatchObject({ found: true, legacyActive: false, cutOver: false, skipped: 'legacy-dark' });
    // untouched: legacy row still there, no @singleton row created
    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${HOME}`).toHaveLength(1);
    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug='@singleton'`).toHaveLength(0);
  });

  it('dry-run on an ACTIVE row writes nothing', async () => {
    await insertLegacy(true);
    const r = await cutoverActiveLearningSingleton(rootSql, WS, ENTRY, { execute: false });
    expect(r).toMatchObject({ found: true, legacyActive: true, cutOver: false });
    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${HOME}`).toHaveLength(1);
    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug='@singleton'`).toHaveLength(0);
  });

  it('executes an ATOMIC behavior-neutral move: @singleton copies every column, papercup row deleted', async () => {
    await insertLegacy(true, { payload_template: { blueprintId: 'graduation', special: 'PAYLOAD' }, next_fire_at: '2026-03-03T03:03:03Z' });
    const r = await cutoverActiveLearningSingleton(rootSql, WS, ENTRY, { execute: true });
    expect(r).toMatchObject({ found: true, legacyActive: true, cutOver: true, singletonName: 'graduation-singleton' });

    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${HOME}`).toHaveLength(0); // legacy gone
    const s = (await rootSql<{ active: boolean; payload_template: Record<string, unknown>; next_fire_at: Date; workspace_id: string; name: string }[]>`
      SELECT active, payload_template, next_fire_at, workspace_id, name
        FROM harness_shared.routines WHERE install_slug='@singleton'`)[0]!;
    expect(s.name).toBe('graduation-singleton');
    expect(s.active).toBe(true); // active preserved (behavior-neutral)
    expect(s.payload_template).toEqual({ blueprintId: 'graduation', special: 'PAYLOAD' }); // payload byte-copied
    expect(s.next_fire_at.toISOString()).toBe('2026-03-03T03:03:03.000Z'); // timing preserved → no firing gap
    expect(s.workspace_id).toBe(WS);
  });

  it('adds the Scout singleton cycle timeout default when cutting over an old active scout row', async () => {
    h.singletonName = 'bp-singleton-scout-0';
    await insertLegacy(true, { payload_template: { blueprintId: 'scout', budget: { maxCostUsd: 0.5 } } }, SCOUT_ENTRY);
    const r = await cutoverActiveLearningSingleton(rootSql, WS, SCOUT_ENTRY, { execute: true });
    expect(r).toMatchObject({ found: true, legacyActive: true, cutOver: true, singletonName: 'bp-singleton-scout-0' });

    const [s] = await rootSql<{ payload_template: Record<string, unknown> }[]>`
      SELECT payload_template FROM harness_shared.routines WHERE install_slug='@singleton'`;
    expect(s.payload_template).toEqual({
      blueprintId: 'scout',
      budget: { maxCostUsd: 0.5 },
      cycleTimeoutMs: 600_000,
    });
  });
});

describe('materializeLearningSingletons (PG, guards)', () => {
  it('COLLISION GUARD: an ACTIVE legacy row is skipped and NOT darkened', async () => {
    await insertLegacy(true);
    const [res] = await materializeLearningSingletons(rootSql, WS, { only: 'graduation', execute: true, retireLegacy: true });
    expect(res).toMatchObject({ skipped: 'legacy-active', legacy: { active: true, deleted: false, keptActive: true } });
    expect(await rootSql`SELECT active FROM harness_shared.routines WHERE install_slug=${HOME}`).toMatchObject([{ active: true }]); // untouched
  });

  it('retire-legacy deletes the DARK legacy row (active=false guard)', async () => {
    await insertLegacy(false);
    const [res] = await materializeLearningSingletons(rootSql, WS, { only: 'graduation', execute: true, retireLegacy: true });
    expect(res.legacy.deleted).toBe(true);
    expect(await rootSql`SELECT 1 FROM harness_shared.routines WHERE install_slug=${HOME}`).toHaveLength(0);
  });
});
