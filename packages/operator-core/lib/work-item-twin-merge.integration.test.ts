/**
 * scope-unique-identifiers-2026-07-26 P-011 (WI-10008280; decisions D-002, D-004, D-007),
 * against real Postgres.
 *
 * Migration 1443 clears every same-workspace work-item twin (one feature_id under several
 * harness_slugs of one workspace) so P-012 can add UNIQUE (workspace_id, feature_id):
 * fixture residue is deleted, same-title twins merge into a ranked survivor, and divergent
 * collisions keep the id on one row while the others get a deterministic migration-owned id.
 * These tests apply the real migration file on the consolidated work_items fixture.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');

function readMigration(file: string, marker: string, overrideEnv: string): string {
  // MIGRATION_1443_PATH / MIGRATION_1444_PATH let scripts/mutation-probe.sh point the suite at a
  // mutated COPY of that one migration.
  const override = process.env[overrideEnv];
  if (override) return readFileSync(override, 'utf8');
  const armed = resolve(SQL_DIR, file);
  const draft = `${armed}.DRAFT`;
  const path = existsSync(armed) ? armed : draft;
  if (!existsSync(path)) throw new Error(`migration not found at ${armed} or ${draft}`);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(marker)) throw new Error(`migration at ${path} does not contain ${marker}`);
  return text;
}

const MIGRATION_1443 = readMigration('1443-merge-same-workspace-work-item-twins.sql', 'twin_1443', 'MIGRATION_1443_PATH');
// P-012: the index that keeps twins from coming back (a DRAFT until D-012's deploy gate clears).
const MIGRATION_1444 = readMigration(
  '1444-work-items-unique-workspace-feature-id.sql',
  'work_items_workspace_feature_id_uq',
  'MIGRATION_1444_PATH',
);
// The REAL endpoint-delete guard: a hand-rolled fixture without it let 1443's
// first armed revision pass here and then abort on live data.
const MIGRATION_988 = readFileSync(resolve(SQL_DIR, '988-work-item-dependency-delete-guard.sql'), 'utf8');

const WS = 'papercusp-workspace';
const BAK_TABLES = [
  'bak_20261011_work_item_twin_deps_1443',
  'bak_20261011_work_item_twins_1443',
  'bak_20261011_work_item_twin_manifest_1443',
  'bak_20261011_work_item_twin_edges_1443',
  'bak_20261011_work_item_twin_carry_notes_1443',
  'bak_20261011_work_item_twin_links_1443',
];

let db: FreshPgDb;

interface Row {
  harness: string;
  id: string;
  title: string;
  status?: string;
  origin?: 'local' | 'remote';
  createdTs?: number;
  updatedTs?: number;
  plan?: string | null;
  payload?: Record<string, unknown>;
  terminalOwner?: string | null;
  authority?: string | null;
  workspace?: string;
}

async function insert(row: Row): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, source_plan_slug, payload, terminal_owner, authority)
    VALUES (${row.workspace ?? WS}, ${row.harness}, ${row.id}, ${row.title}, ${row.status ?? 'open'},
            'feature', ${row.origin ?? 'local'}, ${row.createdTs ?? 1000}, ${row.updatedTs ?? 1000},
            ${row.plan ?? null}, ${db.sql.json((row.payload ?? {}) as never)}, ${row.terminalOwner ?? null},
            ${row.authority ?? null})`;
}

async function rows(id: string, workspace = WS) {
  return db.sql<Array<{ harness_slug: string; status: string; payload: Record<string, any> | null; terminal_owner: string | null; authority: string | null }>>`
    SELECT harness_slug, status, payload, terminal_owner, authority FROM harness_shared.work_items
     WHERE workspace_id = ${workspace} AND feature_id = ${id} ORDER BY harness_slug`;
}

async function renamed(harness: string, oldId: string): Promise<string> {
  const r = await db.sql<Array<{ new_id: string }>>`
    SELECT new_id FROM harness_shared.bak_20261011_work_item_twin_manifest_1443
     WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND feature_id = ${oldId} AND action = 'rekey'`;
  expect(r).toHaveLength(1);
  return r[0]!.new_id;
}

async function applyMigration(): Promise<void> {
  await db.sql.unsafe(MIGRATION_1443).simple();
}

beforeAll(async () => {
  db = await createFreshPgDb('work-item-twin-merge');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await db.sql.unsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS work_items_ws_harness_id_uq
      ON harness_shared.work_items (workspace_id, harness_slug, feature_id);
    CREATE OR REPLACE FUNCTION harness_shared.canonical_harness_slug(p_slug text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE WHEN p_slug IN ('papercup', 'papercup-hive') THEN 'papercusp' ELSE p_slug END $fn$;
    CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
      workspace_id text NOT NULL, scope text NOT NULL, note text, journal jsonb,
      updated_ts bigint, deps jsonb, PRIMARY KEY (workspace_id, scope));
    CREATE TABLE IF NOT EXISTS harness_shared.coord_links (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, src_kind text NOT NULL,
      src_ref text NOT NULL, dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
      workspace_id text, harness_slug text, work_item_id text, owner text,
      PRIMARY KEY (workspace_id, harness_slug, work_item_id));
    CREATE TABLE IF NOT EXISTS harness_shared.feature_claims (
      workspace_id text, harness_slug text, feature_id text, seq bigint,
      PRIMARY KEY (workspace_id, harness_slug, feature_id, seq));
    CREATE TABLE IF NOT EXISTS harness_shared.claim_audit (
      workspace_id text, id bigint, harness_slug text, feature_id text,
      PRIMARY KEY (workspace_id, id));
    CREATE TABLE IF NOT EXISTS harness_shared.work_item_spec_revision_edges (
      workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
      plan_slug text NOT NULL, spec_id text NOT NULL, spec_revision integer NOT NULL,
      spec_fingerprint text NOT NULL, created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision),
      FOREIGN KEY (workspace_id, harness_slug, work_item_id)
        REFERENCES harness_shared.work_items (workspace_id, harness_slug, feature_id) ON DELETE RESTRICT);
    -- Stand-ins for the live federation triggers on work_items (D-010). A capture
    -- stand-in that modelled only the DELETE half let 1443 pass here while, live, it
    -- federated 283 deletes:
    --  * stamp_local_federated_write (BEFORE UPDATE): a write that moves fed_ts/fed_hlc
    --    is an apply/repair and is kept verbatim; a write it judges content-changing is
    --    re-stamped origin='local'. Modelled at its worst case, EVERY clock-stationary
    --    UPDATE re-stamps, which is what live xbench rows did to an origin-only mark.
    --  * capture_work_items_outbox (AFTER UPDATE / DELETE): ships a local-origin row as
    --    a put / del; its echo-loop guard skips any other origin.
    CREATE TABLE IF NOT EXISTS harness_shared.test_outbox (op text, harness_slug text, key text);
    CREATE OR REPLACE FUNCTION harness_shared.test_stamp_local_write() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.fed_ts IS DISTINCT FROM OLD.fed_ts OR NEW.fed_hlc IS DISTINCT FROM OLD.fed_hlc THEN
          RETURN NEW;
        END IF;
        NEW.origin := 'local';
        RETURN NEW;
      END $fn$;
    DROP TRIGGER IF EXISTS test_stamp_local_write_trg ON harness_shared.work_items;
    CREATE TRIGGER test_stamp_local_write_trg BEFORE UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.test_stamp_local_write();
    CREATE OR REPLACE FUNCTION harness_shared.test_capture_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      DECLARE r record;
      BEGIN
        IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
        IF COALESCE(r.origin, 'local') <> 'local' THEN RETURN NULL; END IF;
        INSERT INTO harness_shared.test_outbox
          VALUES (CASE TG_OP WHEN 'DELETE' THEN 'del' ELSE 'put' END, r.harness_slug, r.feature_id);
        RETURN NULL;
      END $fn$;
    DROP TRIGGER IF EXISTS test_capture_outbox_del_trg ON harness_shared.work_items;
    CREATE TRIGGER test_capture_outbox_del_trg AFTER DELETE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.test_capture_outbox();
    DROP TRIGGER IF EXISTS test_capture_outbox_upd_trg ON harness_shared.work_items;
    CREATE TRIGGER test_capture_outbox_upd_trg AFTER UPDATE ON harness_shared.work_items
      FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
      EXECUTE FUNCTION harness_shared.test_capture_outbox();
    CREATE TABLE IF NOT EXISTS harness_shared.work_item_deps (
      id bigint PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      blocked_kind text NOT NULL, blocked_ref text NOT NULL,
      blocker_kind text NOT NULL, blocker_ref text NOT NULL,
      dep_type text NOT NULL DEFAULT 'blocks', created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      satisfaction text NOT NULL DEFAULT 'settled',
      CONSTRAINT work_item_deps_no_self CHECK (NOT (blocked_kind = blocker_kind AND blocked_ref = blocker_ref)));
    CREATE UNIQUE INDEX IF NOT EXISTS work_item_deps_edge_uniq ON harness_shared.work_item_deps
      (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type);
  `).simple();
  await db.sql.unsafe(MIGRATION_988).simple();
});

afterAll(async () => db?.cleanup());

beforeEach(async () => {
  await db.sql.unsafe(`
    DROP TABLE IF EXISTS ${BAK_TABLES.map((t) => `harness_shared.${t}`).join(', ')};
    TRUNCATE harness_shared.work_item_spec_revision_edges, harness_shared.carry_notes,
      harness_shared.coord_links, harness_shared.work_item_claims, harness_shared.feature_claims,
      harness_shared.claim_audit, harness_shared.test_outbox, harness_shared.harness_plans,
      harness_shared.work_item_deps;
    DROP INDEX IF EXISTS harness_shared.work_items_workspace_feature_id_uq;
    DELETE FROM harness_shared.work_items;
    TRUNCATE harness_shared.test_outbox;
  `).simple();
});

describe('migration 1443: same-workspace work-item twins', () => {
  it('deletes fixture twins and leaves non-twin fixture rows and other workspaces alone', async () => {
    await insert({ harness: 'xbench-su-a', id: 'xbench-run1', title: 'bench task' });
    await insert({ harness: 'xbench-su-b', id: 'xbench-run1', title: 'bench task' });
    await insert({ harness: 'hevaldeepchain1m', id: 'w1', title: 'Stage 1' });
    await insert({ harness: 'hevaldiamond2m', id: 'w1', title: 'Base loader' });
    await insert({ harness: 'contract-test-1-a', id: 'F-CONTRACT-001', title: 'contract' });
    await insert({ harness: 'contract-test-2-b', id: 'F-CONTRACT-001', title: 'contract' });
    await insert({ harness: 'xbench-su-a', id: 'xbench-solo', title: 'not a twin' });
    await insert({ harness: 'papercusp', id: 'EI-7', title: 'same id, other workspace', workspace: 'default' });
    await insert({ harness: 'portal', id: 'EI-7', title: 'same id, other workspace' });

    await applyMigration();

    expect(await rows('xbench-run1')).toHaveLength(0);
    expect(await rows('w1')).toHaveLength(0);
    expect(await rows('F-CONTRACT-001')).toHaveLength(0);
    expect(await rows('xbench-solo')).toHaveLength(1);
    expect(await rows('EI-7', 'default')).toHaveLength(1);
    expect(await rows('EI-7')).toHaveLength(1);

    const manifest = await db.sql<Array<{ action: string; n: number }>>`
      SELECT action, count(*)::int AS n FROM harness_shared.bak_20261011_work_item_twin_manifest_1443 GROUP BY action`;
    expect(manifest).toEqual([{ action: 'fixture-delete', n: 6 }]);
    const backed = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.bak_20261011_work_item_twins_1443`;
    expect(backed[0]!.n).toBe(6);
  });

  it('merges retired-slug and operator twins into the concrete harness and carries the terminal state over', async () => {
    await insert({
      harness: 'papercup', id: 'EI-100', title: 'Fix the gate', status: 'done', updatedTs: 2000,
      payload: { _completionEvidence: { summary: 'shipped' } }, terminalOwner: 'su-x', authority: 'committed',
    });
    await insert({ harness: 'papercusp', id: 'EI-100', title: 'Fix the gate', status: 'open', updatedTs: 1500 });
    await insert({ harness: 'operator:papercusp-workspace', id: 'EI-200', title: 'Alarm', status: 'open', updatedTs: 9000 });
    await insert({ harness: 'papercusp', id: 'EI-200', title: 'Alarm', status: 'resolved', updatedTs: 3000 });
    await db.sql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
      VALUES (${WS}, 'papercup', 'EI-100', 'p', 's', 1, ${'a'.repeat(64)}, 'test')`;

    await applyMigration();

    const ei100 = await rows('EI-100');
    expect(ei100.map((r) => r.harness_slug)).toEqual(['papercusp']);
    expect(ei100[0]!.status).toBe('done');
    expect(ei100[0]!.terminal_owner).toBe('su-x');
    expect(ei100[0]!.authority).toBe('committed');
    expect(ei100[0]!.payload?._completionEvidence).toEqual({ summary: 'shipped' });
    expect(ei100[0]!.payload?._twinMerge?.migration).toBe(1443);
    expect(ei100[0]!.payload?._twinMerge?.sources).toEqual([
      expect.objectContaining({ harness: 'papercup', status: 'done' }),
    ]);

    const ei200 = await rows('EI-200');
    expect(ei200.map((r) => r.harness_slug)).toEqual(['papercusp']);
    expect(ei200[0]!.status).toBe('resolved');

    // The merged source's spec edge could not follow it across harnesses: backed up, dropped.
    const edges = await db.sql`SELECT 1 FROM harness_shared.work_item_spec_revision_edges`;
    expect(edges).toHaveLength(0);
    const edgeBak = await db.sql`SELECT 1 FROM harness_shared.bak_20261011_work_item_twin_edges_1443`;
    expect(edgeBak).toHaveLength(1);
  });

  it('keeps the harness that owns the source plan and moves the checkpoint onto it', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES (${WS}, 'sidestage', 'side-plan')`;
    await insert({ harness: 'papercusp', id: 'WI-300', title: 'Judge thresholds', status: 'blocked', plan: 'side-plan', updatedTs: 9000 });
    await insert({ harness: 'sidestage', id: 'WI-300', title: 'Judge thresholds', status: 'done', plan: 'side-plan', updatedTs: 1000 });
    await db.sql`
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note, updated_ts)
      VALUES (${WS}, 'workitem:papercusp:WI-300', '## State\nhalf way', 5)`;

    await applyMigration();

    const wi300 = await rows('WI-300');
    expect(wi300.map((r) => r.harness_slug)).toEqual(['sidestage']);
    expect(wi300[0]!.status).toBe('done');
    const notes = await db.sql<Array<{ scope: string; note: string }>>`
      SELECT scope, note FROM harness_shared.carry_notes WHERE workspace_id = ${WS}`;
    expect(notes).toEqual([{ scope: 'workitem:sidestage:WI-300', note: '## State\nhalf way' }]);
  });

  it('lifts dependency edges past the delete guard and re-points them at the row that carries on', async () => {
    // Fixture chain (the live shape that aborted 1443's first armed revision).
    await insert({ harness: 'heval-a', id: 'w1', title: 'step 1' });
    await insert({ harness: 'heval-b', id: 'w1', title: 'step 1' });
    await insert({ harness: 'heval-a', id: 'w2', title: 'step 2' });
    await insert({ harness: 'heval-b', id: 'w2', title: 'step 2' });
    // One item recorded twice: papercusp survives.
    await insert({ harness: 'papercup', id: 'WI-701', title: 'Same' });
    await insert({ harness: 'papercusp', id: 'WI-701', title: 'Same' });
    // A divergent collision: the local pot row is renamed.
    await insert({ harness: 'pot', id: 'WI-702', title: 'A' });
    await insert({ harness: 'papercusp', id: 'WI-702', title: 'B', origin: 'remote' });
    await insert({ harness: 'other', id: 'X1', title: 'downstream' });
    await db.sql.unsafe(`
      INSERT INTO harness_shared.work_item_deps (id, workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref) VALUES
        (1, '${WS}', 'feature', 'heval-a#w2', 'feature', 'heval-a#w1'),
        (2, '${WS}', 'feature', 'papercup#WI-701', 'issue', 'EI-9'),
        (3, 'default', 'feature', 'papercup#WI-701', 'issue', 'EI-10'),
        (4, '${WS}', 'feature', 'other#X1', 'feature', 'pot#WI-702'),
        (5, '${WS}', 'feature', 'papercup#WI-701', 'feature', 'papercusp#WI-701');
    `).simple();

    await applyMigration();

    const newId = await renamed('pot', 'WI-702');
    const deps = await db.sql<Array<{ id: number; workspace_id: string; blocked_ref: string; blocker_ref: string }>>`
      SELECT id, workspace_id, blocked_ref, blocker_ref FROM harness_shared.work_item_deps ORDER BY id`;
    expect(deps).toEqual([
      { id: 2, workspace_id: WS, blocked_ref: 'papercusp#WI-701', blocker_ref: 'EI-9' },
      // Another workspace: the ref is not a twin there, so the edge is untouched.
      { id: 3, workspace_id: 'default', blocked_ref: 'papercup#WI-701', blocker_ref: 'EI-10' },
      { id: 4, workspace_id: WS, blocked_ref: 'other#X1', blocker_ref: `pot#${newId}` },
    ]);
    // Fixture edge (1) and the source->survivor edge that would become a self-loop (5) are dropped.
    const bak = await db.sql`SELECT id FROM harness_shared.bak_20261011_work_item_twin_deps_1443 ORDER BY id`;
    expect(bak.map((r) => Number(r.id))).toEqual([1, 2, 3, 4, 5]);
    expect((await rows('w1')).length + (await rows('w2')).length).toBe(0);
  });

  it('merges into a survivor that is itself renamed because it collided with a different item', async () => {
    // papercup + papercusp are one item recorded twice (same title); beta is a
    // different item on the same id and keeps it (remote origin), so the merge
    // survivor (papercusp) is renamed after the merge.
    await insert({ harness: 'papercup', id: 'EI-600', title: 'Gate stall', status: 'done', updatedTs: 2000, terminalOwner: 'su-z' });
    await insert({ harness: 'papercusp', id: 'EI-600', title: 'Gate stall', status: 'open', updatedTs: 1500 });
    await insert({ harness: 'beta', id: 'EI-600', title: 'Unrelated item', origin: 'remote' });

    await applyMigration();

    expect((await rows('EI-600')).map((r) => r.harness_slug)).toEqual(['beta']);
    const newId = await renamed('papercusp', 'EI-600');
    const survivor = await rows(newId);
    expect(survivor.map((r) => r.harness_slug)).toEqual(['papercusp']);
    expect(survivor[0]!.status).toBe('done');
    expect(survivor[0]!.terminal_owner).toBe('su-z');
    expect(survivor[0]!.payload?._twinMerge?.sources).toEqual([
      expect.objectContaining({ harness: 'papercup', status: 'done' }),
    ]);
    expect(survivor[0]!.payload?._physicalTwinRekey).toEqual(
      expect.objectContaining({ oldId: 'EI-600', keptBy: 'beta' }),
    );
  });

  it('renames the local side of a divergent collision deterministically and moves what belongs to it', async () => {
    await insert({ harness: 'papercusp', id: 'WI-400', title: 'Write the spec triad', origin: 'remote', createdTs: 2000 });
    await insert({ harness: 'pot', id: 'WI-400', title: 'green-checkpoint stall', status: 'done', createdTs: 1000 });
    await insert({ harness: 'hiveloop-hive', id: 'F-FIX-001', title: 'bees exit rc=0', status: 'dropped' });
    await insert({ harness: 'papercusp', id: 'F-FIX-001', title: 'set_state error', status: 'done', origin: 'remote' });
    await insert({ harness: 'alpha', id: 'EI-500', title: 'first', createdTs: 1 });
    await insert({ harness: 'beta', id: 'EI-500', title: 'second', createdTs: 2 });
    await db.sql.unsafe(`
      INSERT INTO harness_shared.coord_links (id, workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
      VALUES (1, '${WS}', 'work_item', 'WI-400', 'event', 'green-stall:pot', 'about'),
             (2, '${WS}', 'work_item', 'WI-400', 'event', 'triad:papercusp-public', 'about');
      INSERT INTO harness_shared.carry_notes (workspace_id, scope, note) VALUES ('${WS}', 'workitem:pot:WI-400', 'pot note');
      INSERT INTO harness_shared.work_item_claims VALUES ('${WS}', 'pot', 'WI-400', 'su-y');
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
      VALUES ('${WS}', 'pot', 'WI-400', 'p', 's', 1, '${'b'.repeat(64)}', 'test');
    `).simple();

    await applyMigration();

    // The remote-origin row keeps the id; the local row is renamed.
    expect((await rows('WI-400')).map((r) => r.harness_slug)).toEqual(['papercusp']);
    const wiNew = await renamed('pot', 'WI-400');
    expect(wiNew).toMatch(/^WI-\d+$/);
    const n = BigInt(wiNew.slice(3));
    expect(n >= 9_007_101_443_000_000n && n < 9_007_102_443_000_000n).toBe(true);
    expect(n < 2n ** 53n).toBe(true);
    const moved = await rows(wiNew);
    expect(moved.map((r) => r.harness_slug)).toEqual(['pot']);
    expect(moved[0]!.payload?._physicalTwinRekey).toMatchObject({
      migration: 1443, oldId: 'WI-400', sourceHarness: 'pot', keptBy: 'papercusp',
    });

    // Deterministic: the same (workspace, harness, old id) always yields the same new id.
    const expected = await db.sql<Array<{ id: string }>>`
      SELECT 'WI-' || (9007101443000000::bigint
        + ((hashtextextended(${WS} || '/pot/WI-400', 1443) % 1000000000) + 1000000000) % 1000000000)::text AS id`;
    expect(wiNew).toBe(expected[0]!.id);

    const links = await db.sql<Array<{ id: number; src_ref: string }>>`
      SELECT id::int, src_ref FROM harness_shared.coord_links ORDER BY id`;
    expect(links).toEqual([{ id: 1, src_ref: wiNew }, { id: 2, src_ref: 'WI-400' }]);
    const notes = await db.sql`SELECT scope FROM harness_shared.carry_notes`;
    expect(notes).toEqual([{ scope: `workitem:pot:${wiNew}` }]);
    const claims = await db.sql`SELECT work_item_id FROM harness_shared.work_item_claims`;
    expect(claims).toEqual([{ work_item_id: wiNew }]);
    const edges = await db.sql`SELECT harness_slug, work_item_id FROM harness_shared.work_item_spec_revision_edges`;
    expect(edges).toEqual([{ harness_slug: 'pot', work_item_id: wiNew }]);

    expect((await rows('F-FIX-001')).map((r) => r.harness_slug)).toEqual(['papercusp']);
    expect(await renamed('hiveloop-hive', 'F-FIX-001')).toMatch(/^F-FIX-1443\d{9}$/);

    expect((await rows('EI-500')).map((r) => r.harness_slug)).toEqual(['alpha']);
    expect(await renamed('beta', 'EI-500')).toMatch(/^EI-1443\d{13}$/);
  });

  it('deletes twins locally without shipping a delete to peers, and leaves the triggers live', async () => {
    await insert({ harness: 'papercup', id: 'WI-600', title: 'dup' });
    await insert({ harness: 'papercusp', id: 'WI-600', title: 'dup' });
    await insert({ harness: 'xbench-su-a', id: 'xbench-6', title: 'bench' });
    await insert({ harness: 'xbench-su-b', id: 'xbench-6', title: 'bench' });

    await applyMigration();

    // Without the origin mark, the retired papercup twin's delete would be captured —
    // and live, canonical_harness_slug('papercup') ships it as a delete of the papercusp
    // survivor. A mark that leaves fed_ts alone is re-stamped 'local' by the stamp
    // trigger, so the deleted rows would also ship a put (a stale source overwriting the
    // survivor on peers) and a del (D-010). Only the survivor may federate.
    const shipped = await db.sql<Array<{ op: string; harness_slug: string; key: string }>>`
      SELECT op, harness_slug, key FROM harness_shared.test_outbox ORDER BY op, harness_slug, key`;
    expect(shipped.filter((o) => o.op === 'del' || o.harness_slug !== 'papercusp')).toEqual([]);
    const trg = await db.sql<Array<{ tgname: string; tgenabled: string }>>`
      SELECT tgname, tgenabled FROM pg_trigger
       WHERE tgname IN ('test_capture_outbox_del_trg', 'test_capture_outbox_upd_trg', 'test_stamp_local_write_trg')
       ORDER BY tgname`;
    expect(trg.map((t) => t.tgenabled)).toEqual(['O', 'O', 'O']);
    const survivor = await db.sql<Array<{ origin: string }>>`
      SELECT origin FROM harness_shared.work_items WHERE feature_id = 'WI-600'`;
    expect(survivor).toEqual([{ origin: 'local' }]);
    await db.sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'WI-600'`;
    expect(await db.sql`SELECT op, harness_slug, key FROM harness_shared.test_outbox WHERE op = 'del'`)
      .toEqual([{ op: 'del', harness_slug: 'papercusp', key: 'WI-600' }]);
  });

  it('deletes the old-id row as a stale copy when a peer already federated the renamed row', async () => {
    await insert({ harness: 'papercusp', id: 'WI-700', title: 'spec triad', origin: 'remote' });
    await insert({ harness: 'pot', id: 'WI-700', title: 'green stall', createdTs: 1 });
    const expected = await db.sql<Array<{ id: string }>>`
      SELECT 'WI-' || (9007101443000000::bigint
        + ((hashtextextended(${WS} || '/pot/WI-700', 1443) % 1000000000) + 1000000000) % 1000000000)::text AS id`;
    await insert({ harness: 'pot', id: expected[0]!.id, title: 'green stall', origin: 'remote' });

    await applyMigration();

    expect((await rows('WI-700')).map((r) => r.harness_slug)).toEqual(['papercusp']);
    expect((await rows(expected[0]!.id)).map((r) => r.harness_slug)).toEqual(['pot']);
    const manifest = await db.sql`
      SELECT action, new_id FROM harness_shared.bak_20261011_work_item_twin_manifest_1443
       WHERE harness_slug = 'pot'`;
    expect(manifest).toEqual([{ action: 'stale-delete', new_id: expected[0]!.id }]);
  });

  it('leaves no twins, so UNIQUE (workspace_id, feature_id) can be created; a clean database is a no-op', async () => {
    await insert({ harness: 'papercup', id: 'EI-800', title: 'a' });
    await insert({ harness: 'papercup-hive', id: 'EI-800', title: 'a' });
    await insert({ harness: 'papercusp', id: 'EI-800', title: 'a' });
    await insert({ harness: 'email', id: 'WI-900', title: 'draft reply', createdTs: 5 });
    await insert({ harness: 'papercusp', id: 'WI-900', title: 'spec triad', createdTs: 6 });
    await insert({ harness: 'portal', id: 'WI-900', title: 'gate red', createdTs: 7 });

    await applyMigration();

    await db.sql.unsafe(`
      CREATE UNIQUE INDEX test_work_items_ws_id_uq ON harness_shared.work_items (workspace_id, feature_id);
      DROP INDEX harness_shared.test_work_items_ws_id_uq;`).simple();
    expect((await rows('WI-900')).map((r) => r.harness_slug)).toEqual(['email']);

    const before = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM harness_shared.work_items`;
    await applyMigration();
    const after = await db.sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM harness_shared.work_items`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

describe('migration 1444: UNIQUE (workspace_id, feature_id)', () => {
  async function insertError(row: Row): Promise<{ code?: string; constraint_name?: string } | null> {
    try {
      await insert(row);
      return null;
    } catch (error) {
      return error as { code?: string; constraint_name?: string };
    }
  }

  it('after 1443, refuses a twin insert while the same id stays legal in another workspace and on its own row', async () => {
    await insert({ harness: 'papercup', id: 'WI-950', title: 'dup' });
    await insert({ harness: 'papercusp', id: 'WI-950', title: 'dup' });

    await applyMigration();
    await db.sql.unsafe(MIGRATION_1444).simple();

    const twin = await insertError({ harness: 'papercup-hive', id: 'WI-950', title: 'dup' });
    expect(twin?.code).toBe('23505');
    expect(twin?.constraint_name).toBe('work_items_workspace_feature_id_uq');
    expect((await rows('WI-950')).map((r) => r.harness_slug)).toEqual(['papercusp']);

    expect(await insertError({ harness: 'papercup-hive', id: 'WI-950', title: 'dup', workspace: 'other-ws' })).toBeNull();
    // The physical-key upsert every writer uses is unaffected for the row that holds the id.
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, title, status, item_kind)
      VALUES (${WS}, 'papercusp', 'WI-950', 'dup', 'done', 'feature')
      ON CONFLICT (harness_slug, feature_id) DO UPDATE SET status = EXCLUDED.status`;
    expect((await rows('WI-950')).map((r) => r.status)).toEqual(['done']);

    // Re-applying is a no-op.
    await db.sql.unsafe(MIGRATION_1444).simple();
  });

  it('refuses a second row for an existing F- id in the same workspace (scope-unique-identifiers R-7, D-007)', async () => {
    // F-FIX-001 is one of the three same-workspace F- twin sets D-007 measured live.
    // The index is prefix-agnostic, so an F- id is refused exactly like a WI- id.
    await applyMigration();
    await db.sql.unsafe(MIGRATION_1444).simple();
    await insert({ harness: 'hiveloop-hive', id: 'F-FIX-001', title: 'fix' });

    const twin = await insertError({ harness: 'papercusp', id: 'F-FIX-001', title: 'fix' });
    expect(twin?.code).toBe('23505');
    expect(twin?.constraint_name).toBe('work_items_workspace_feature_id_uq');
    expect((await rows('F-FIX-001')).map((r) => r.harness_slug)).toEqual(['hiveloop-hive']);
  });

  it('refuses to run while a twin remains, and names one', async () => {
    await insert({ harness: 'papercup', id: 'WI-951', title: 'dup' });
    await insert({ harness: 'papercusp', id: 'WI-951', title: 'dup' });

    await expect(db.sql.unsafe(MIGRATION_1444).simple()).rejects.toThrow(
      /1444: 1 same-workspace work-item twin set\(s\) remain \(e\.g\. papercusp-workspace\/WI-951\)/,
    );
    const idx = await db.sql`SELECT 1 FROM pg_indexes WHERE indexname = 'work_items_workspace_feature_id_uq'`;
    expect(idx).toHaveLength(0);
  });
});
