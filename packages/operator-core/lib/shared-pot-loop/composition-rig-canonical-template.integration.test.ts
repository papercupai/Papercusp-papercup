/**
 * WI-10005142 P-001: exercise the maintained migration-keyed org template
 * before replacing composition-rig's private schema. These are real isolated
 * PostgreSQL cells; the existing rig's federation/authority oracles remain in
 * its consumer tests. Print observations without inventing a cold-build cost:
 * the integration globalSetup may already have warmed the current template.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { getTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, orgTemplateKey, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-shl-comp';
const HARNESS = 'shl';
const POT = 'shl-hive';
const FEATURE = 'F-TEMPLATE-SPIKE';
const cells: OrgTestDb[] = [];
const observations: Record<string, unknown> = { templateKey: orgTemplateKey(), provisioningMs: [] };

async function seedProject(db: OrgTestDb): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.projects (id, name, status, slug, workspace_id, created_ts, updated_ts)
    VALUES ('p-shl-spike', 'SharedPotLoop', 'active', ${HARNESS}, ${WS}, 0, 0)`;
}

async function seedFeature(db: OrgTestDb, feature: string, workspace = WS, harness = HARNESS): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, attempts,
       item_kind, needs_human_review, ts, created_ts, updated_ts, redundancy)
    VALUES (${workspace}, ${harness}, ${feature}, 'Template spike', 'rig seed contract', 'open', 0,
            'feature', FALSE, 1, 1, 1, NULL)`;
}

describe('composition cells from the maintained canonical org template', () => {
  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      // Match createFreshPgDb's pool size, preserving the rig's concurrency seam.
      cells.push(await createOrgTestDb({ adminPoolMax: 4 }));
      (observations.provisioningMs as number[]).push(performance.now() - start);
    }
    observations.databases = cells.map((db) => db.dbName);
    // Pre-run contract check: a schema-adoption failure should identify the
    // required seed fields, rather than cascade through unrelated controls.
    const memberColumns = await cells[0].adminSql`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = 'pot_members'
        AND column_name IN ('pot_home_slug', 'github_username') ORDER BY column_name`;
    expect(memberColumns).toEqual([
      { column_name: 'github_username', is_nullable: 'NO' },
      { column_name: 'pot_home_slug', is_nullable: 'NO' },
    ]);
    observations.memberSeedRequirements = memberColumns;
  }, 240_000);

  afterAll(async () => {
    const start = performance.now();
    await Promise.all(cells.map((db) => db.cleanup()));
    observations.cleanupMs = performance.now() - start;
    // Observe the actual managed-drop result, including deferred teardown.
    const admin = postgres(await getTestPg(), { max: 1, onnotice: () => {}, prepare: false });
    try {
      observations.remainingDatabases = await admin`
        SELECT datname, datconnlimit FROM pg_database
        WHERE datname::text = ANY(${admin.array(cells.map((db) => db.dbName), 1009)}::text[])`;
    } finally {
      await admin.end({ timeout: 5 });
      console.info('canonical-template-spike', JSON.stringify(observations));
    }
  }, 60_000);

  it('contains the retained migration fixes and the fifth readiness gap in both cells', async () => {
    const tables = ['adv_sessions', 'work_item_release_cooldowns', 'plan_item_assignments',
      'agent_name_sessions', 'work_item_deps', 'work_items', 'routines', 'plan_items'];
    for (const db of cells) {
      const relations = await db.adminSql<{ name: string; present: string | null }[]>`
        SELECT name, to_regclass('harness_shared.' || name)::text AS present
        FROM unnest(${db.adminSql.array(tables)}) AS name`;
      expect(relations.filter((row) => !row.present)).toEqual([]);
      const columns = await db.adminSql<{ table_name: string; column_name: string; column_default: string | null }[]>`
        SELECT table_name, column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'harness_shared'
          AND table_name IN ('work_item_deps', 'work_items')
          AND column_name IN ('satisfaction', 'nature', 'admission', 'admitted_at', 'admitted_by')
        ORDER BY table_name, column_name`;
      expect(columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ table_name: 'work_item_deps', column_name: 'satisfaction' }),
        expect.objectContaining({ table_name: 'work_items', column_name: 'admission' }),
        expect.objectContaining({ table_name: 'work_items', column_name: 'admitted_at' }),
        expect.objectContaining({ table_name: 'work_items', column_name: 'admitted_by' }),
      ]));
      observations.columns = columns;
    }
    expect(cells[0].dbName).not.toBe(cells[1].dbName);
  });

  it('preserves the project/backlog seed contract, canonical defaults and independent cells', async () => {
    const [a, b] = cells;
    for (const db of cells) {
      await seedProject(db);
      // The maintained chain requires a canonical parent pot and both member
      // identity fields. The old private rig omitted those constraints.
      await db.adminSql`INSERT INTO harness_shared.pots
        (workspace_id, pot_home_slug, public_key, keychain_id, title, created_at, updated_at)
        VALUES (${WS}, ${POT}, decode(repeat('01', 32), 'hex'), 'kc-spike', 'Rig pot', 1, 1)`;
      await db.adminSql`INSERT INTO harness_shared.pot_members
        (workspace_id, pot_home_slug, github_user_id, github_username,
         binding_status, device_attestations, revoked_pubkeys)
        VALUES (${WS}, ${POT}, 4202, 'swarm-b', 'verified',
                '[{"device_pubkey":"spike-peer"}]'::jsonb, ARRAY[]::text[])`;
      await db.adminSql`INSERT INTO harness_shared.user_trust_list
        (workspace_id, trusted_github_user_id, created_ts) VALUES (${WS}, 4202, 1)`;
    }
    await seedFeature(a, FEATURE);
    const [row] = await a.adminSql`
      SELECT feature_id, workspace_id, harness_slug, item_kind, status, nature, origin,
             admission, admitted_at, admitted_by, feature_order, redundancy, fed_ts, fed_hlc
      FROM harness_shared.harness_features_consolidated WHERE feature_id = ${FEATURE}`;
    expect(row).toMatchObject({ feature_id: FEATURE, workspace_id: WS, harness_slug: HARNESS,
      item_kind: 'feature', status: 'open', nature: 'work', origin: 'local', redundancy: null,
      admission: null, admitted_at: null, admitted_by: null });
    const other = await b.adminSql`SELECT feature_id FROM harness_shared.work_items WHERE feature_id = ${FEATURE}`;
    expect(other).toEqual([]);
    observations.seededFeature = row;
    observations.seedOutbox = await a.adminSql`
      SELECT table_name, harness_slug, op, key, row->>'feature_id' AS feature_id
      FROM harness_shared.substrate_outbox ORDER BY id`;
  });

  it('rejects the incomplete peer seed that the private rig had allowed', async () => {
    await expect(cells[0].adminSql`INSERT INTO harness_shared.pot_members
      (workspace_id, github_user_id, binding_status, device_attestations, revoked_pubkeys)
      VALUES (${WS}, 4203, 'verified', '[]'::jsonb, ARRAY[]::text[])`)
      .rejects.toMatchObject({ code: '23502', column_name: 'pot_home_slug' });
  });

  it('uses the real workspace RLS policy while retaining the admin bypass used by the rig', async () => {
    const [a] = cells;
    const feature = 'F-RLS-SPIKE';
    await seedFeature(a, feature);
    await seedFeature(a, 'F-OTHER-WORKSPACE', 'ws-other-spike', 'other-spike');
    const [roles] = await a.adminSql`
      SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;
    expect(roles.rolsuper || roles.rolbypassrls).toBe(true);
    const [rls] = await a.adminSql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'harness_shared.work_items'::regclass`;
    expect(rls.relrowsecurity).toBe(true);
    observations.rls = { adminRole: roles, relation: rls,
      policies: await a.adminSql`SELECT policyname, qual, with_check FROM pg_policies
        WHERE schemaname = 'harness_shared' AND tablename = 'work_items'` };
    const visible = await a.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${WS}, true)`;
      return tx`SELECT feature_id FROM harness_shared.work_items
        WHERE feature_id IN (${feature}, 'F-OTHER-WORKSPACE') ORDER BY feature_id`;
    });
    expect(visible.map((row) => row.feature_id)).toEqual([feature]);
    const unscoped = await a.appSql`SELECT feature_id FROM harness_shared.work_items
      WHERE feature_id IN (${feature}, 'F-OTHER-WORKSPACE')`;
    expect(unscoped).toEqual([]);
  });

  it('runs canonical capture/stamp triggers for dispatch updates and keeps test-only effects local', async () => {
    const [a] = cells;
    const feature = 'F-CDC-SPIKE';
    await seedFeature(a, feature);
    observations.triggers = await a.adminSql`
      SELECT c.relname AS relation, t.tgname, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND NOT t.tgisinternal
        AND c.relname IN ('work_items', 'projects', 'pots', 'pot_members', 'user_trust_list')
      ORDER BY c.relname, t.tgname`;
    const [{ watermark }] = await a.adminSql`SELECT coalesce(max(id), 0) AS watermark FROM harness_shared.substrate_outbox`;
    await a.adminSql`UPDATE harness_shared.work_items SET feature_order = 7
      WHERE harness_slug = ${HARNESS} AND feature_id = ${feature}`;
    const updates = await a.adminSql`
      SELECT table_name, op, jsonb_build_object('feature_order', row->'feature_order',
        'feature_id', row->'feature_id', 'fed_ts', row->'fed_ts', 'fed_hlc', row->'fed_hlc') AS row
      FROM harness_shared.substrate_outbox
      WHERE id > ${watermark} AND row->>'feature_id' = ${feature} ORDER BY id`;
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((row) => row.row?.feature_order === 7)).toBe(true);
    observations.dispatchOutbox = updates;
    const [stamp] = await a.adminSql`SELECT fed_ts, fed_hlc FROM harness_shared.work_items
      WHERE harness_slug = ${HARNESS} AND feature_id = ${feature}`;
    expect(Number(stamp.fed_ts)).toBeGreaterThan(0);
    observations.stamp = stamp;
    // This one table is intentionally outside production CDC: external actions
    // must not become federated state when the rig adopts the full schema.
    await a.adminSql.unsafe(`CREATE TABLE harness_shared.rig_side_effects (
      work_item_id text NOT NULL, executed_by text NOT NULL, executed_at_ms bigint NOT NULL, note text)`);
    const [{ watermark: beforeEffect }] = await a.adminSql`SELECT coalesce(max(id), 0) AS watermark FROM harness_shared.substrate_outbox`;
    await a.adminSql`INSERT INTO harness_shared.rig_side_effects VALUES (${FEATURE}, 'cell-a', 1, 'spike')`;
    const [effects] = await a.adminSql`SELECT count(*)::int AS count FROM harness_shared.substrate_outbox WHERE id > ${beforeEffect}`;
    expect(effects.count).toBe(0);
  });
});
