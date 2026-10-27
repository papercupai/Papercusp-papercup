/**
 * EI-117 regression — the replay/revert storm guard, end-to-end on real PG.
 *
 * The defect (struck the fleet-federation-reanchor + shared-hive-federation
 * plan docs twice on 2026-06-09): local writes to federated tables never
 * stamped `fed_ts`, so a replayed/old federated op LWW-beat newer local
 * content; and a row last written by a projection kept `origin='remote'`, so
 * the NEXT local write was skipped by the CDC capture trigger and never
 * reached the log — leaving the log's head as the OLD content the next replay
 * restored. The TS half (TableProjection.skipOwnOps — the own-op echo
 * breaker) is unit-tested in __tests__/projection.test.ts; THIS test proves
 * the PG half on `harness_plans` with the REAL capture triggers (mig 125),
 * the REAL projection writer (projections/harness-plans.ts), and the REAL
 * stamp trigger (mig 214):
 *
 *   1. a local INSERT gets fed_ts stamped + origin 'local' + captures;
 *   2. an OLDER remote op cannot revert newer local content;
 *   3. a ts-less remote op cannot clobber a stamped row (the removed
 *      `EXCLUDED.fed_ts IS NULL` disjunct), even though BEFORE-INSERT
 *      triggers run before conflict resolution (the EXCLUDED subtlety);
 *   4. a NEWER remote op applies and is NOT re-captured (echo guard);
 *   5. a local UPDATE after a remote apply re-arms federation (origin reset
 *      + fresh stamp + capture) and the previous remote op replayed is
 *      dropped — the full storm-proof loop;
 *   6. a bookkeeping-only write (version bump) keeps the stamp + captures
 *      nothing.
 *
 * Owns its schema (archive 102 outbox/capture-fn + a column-faithful
 * harness_plans stub + 125 plans capture triggers + 214 stamp triggers,
 * the current revision store and receiver BAR migrations);
 * does not touch the dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { buildHarnessPlansProjection, type HarnessPlanRow } from '../projections/harness-plans';
import { seedAcceptanceBarsOnFederatedApply } from '../../../acceptance-bar-receiver-seed';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_ei117';
const HARNESS = 'papercup';
const SLUG = 'storm-victim-plan';

function planRow(content: string): HarnessPlanRow {
  return {
    harness_slug: HARNESS,
    plan_slug: SLUG,
    content,
    content_hash: `hash-of-${content}`,
    title: 'Storm victim',
    status: 'active',
    created: '2026-06-09',
    updated: '2026-06-09',
    owner: 'owner@example.com',
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
  };
}

describe('EI-117 replay/revert guard (real PG: migs 102+125+214 + the real plans projection writer)', () => {
  let db: FreshPgDb;
  let writeRemote: (row: HarnessPlanRow, ts: number | undefined) => Promise<void | false>;

  beforeAll(async () => {
    db = await createFreshPgDb('ei117_replay_guard');

    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);

    // Mig 102 (archive) attaches generic capture triggers to the consolidated
    // tables, so column-faithful stubs must exist first. (This stub pattern was
    // shared with engineer-issues-federation-trigger.integration.test.ts, deleted
    // under WI-41780 as a historical-schema test; the pattern itself is unaffected.)
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
      );
    `);
    await db.sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));

    // Column-faithful harness_plans stub (the federated subset + the fed cols
    // mig 181 adds + the local-CAS `version`). PK matches the projection's
    // ON CONFLICT target.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_plans (
        workspace_id  TEXT NOT NULL,
        harness_slug  TEXT NOT NULL,
        plan_slug     TEXT NOT NULL,
        title         TEXT,
        status        TEXT,
        created       TEXT,
        updated       TEXT,
        owner         TEXT,
        initiative    TEXT,
        supersedes    TEXT[] NOT NULL DEFAULT '{}',
        superseded_by TEXT,
        content       TEXT NOT NULL DEFAULT '',
        content_hash  TEXT NOT NULL DEFAULT '',
        version       BIGINT NOT NULL DEFAULT 0,
        archived      BOOLEAN NOT NULL DEFAULT false,
        is_legacy     BOOLEAN NOT NULL DEFAULT false,
        author_pubkey TEXT,
        origin        TEXT NOT NULL DEFAULT 'local',
        fed_ts        BIGINT,
        fed_hlc       TEXT,
        -- writeToPg's column list also carries the plan-template + promote-policy
        -- scalars and the owner-author bind (writer columns added after the stub;
        -- missing any of them 42703s EVERY per-part write — broke the 2026-07-05 gate).
        template            TEXT,
        template_data       JSONB,
        template_slug       TEXT,
        promote_policy      JSONB,
        owner_author_pubkey TEXT,
        -- mig 714 (input_schema) + mig 908 (output_schema) + mig 923 (property_schema,
        -- properties) + mig 861 (forced_past): the writer's INSERT/ON CONFLICT column
        -- list carries all five (projections/harness-plans.ts) -- missing any of them
        -- 42703s every per-part write, same failure class as the comment above
        -- (EI-20433418865457805). property_schema/properties are NOT NULL DEFAULT
        -- '{}'::jsonb to match the real schema (923) and the writer's ON CONFLICT DO
        -- UPDATE COALESCE-against-existing-value.
        input_schema    JSONB,
        output_schema   JSONB,
        property_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
        properties      JSONB NOT NULL DEFAULT '{}'::jsonb,
        forced_past     JSONB,
        PRIMARY KEY (workspace_id, harness_slug, plan_slug)
      );
    `);
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '125-harness-plans-federation.sql'), 'utf8')));
    // The writer re-derives both the legacy JSONB index and normalized rows in
    // the same transaction. Apply their real migrations: missing items/decisions
    // columns otherwise preempt the replay and revision rollback assertions.
    for (const mig of [
      '128-harness-plans-normalize.sql',
      '675-normalize-plan-items-decisions.sql',
      '1071-restore-plan-items-owner-gate-marker-after-1059-collision.sql',
      '1142-plan-decision-affects-authority.sql',
      '851-first-class-plan-spec-clauses.sql',
      '1111-acceptance-bar-contract-seed.sql',
    ]) {
      await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, mig), 'utf8')));
    }

    // The whole-blob writer now records remote content in the local revision
    // spine, just like the sibling plan-part cutover fixture. Keep the baseline
    // table shape, then apply the real workspace/hash migrations.
    await db.sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE harness_shared.plan_revisions (
        id BIGSERIAL PRIMARY KEY,
        harness_slug TEXT NOT NULL DEFAULT 'papercup',
        plan_slug TEXT NOT NULL,
        seq INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        content_snapshot TEXT NOT NULL,
        rationale TEXT,
        author_kind TEXT NOT NULL,
        author_id TEXT NOT NULL,
        session_id TEXT,
        session_kind TEXT,
        created_at BIGINT NOT NULL,
        UNIQUE (harness_slug, plan_slug, seq)
      );
    `);
    for (const mig of [
      '218-plan-revisions-workspace-scope.sql',
      '1107-plan-revisions-content-snapshot-hash.sql',
    ]) {
      await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, mig), 'utf8')));
    }

    // Mig 214 attaches its stamp trigger to all 11 CDC tables (strict by
    // design — no silent skip on a typo'd name), so cheap stubs stand in for
    // the ones this test never writes.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.coord_event_log (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.coord_conversations (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.coord_threads (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.coord_thread_posts (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.plan_item_assignments (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.hive_settings (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.hive_members (id INT, origin TEXT, fed_ts BIGINT);
      CREATE TABLE harness_shared.engineer_issues (id INT, origin TEXT, fed_ts BIGINT);
    `);
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '214-federated-fed-ts-local-stamp.sql'), 'utf8')));

    const projection = buildHarnessPlansProjection({
      workspaceId: WS,
      harnessSlug: HARNESS,
      sql: db.sql,
      // EI-117 guards the WHOLE-BLOB LWW revert path — the PLAN_PART_FEDERATION-OFF
      // branch. With the flag ON (now the production default) writeToPg is bootstrap-
      // only (ON CONFLICT DO NOTHING; per-part recompose owns updates), which
      // plan-part-federation-cutover.integration.test.ts covers. Pin OFF here so this
      // suite keeps exercising the LWW guard instead of trivially passing on DO NOTHING.
      isFlagOn: async () => false,
    });
    writeRemote = (row, ts) =>
      projection.writeToPg(row, { authorPubkey: 'REMOTE-LOG-KEY', origin: 'remote', ts });
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  async function row() {
    const [r] = await db.sql<
      Array<{ content: string; origin: string; fed_ts: number | null; version: number }>
    >`
      SELECT content, origin, fed_ts::bigint AS fed_ts, version::int AS version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    return r;
  }
  async function outboxCount(): Promise<number> {
    const [r] = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r!.n;
  }
  async function localInsert(content: string) {
    await db.sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, origin)
      VALUES (${WS}, ${HARNESS}, ${SLUG}, ${content}, ${'hash-of-' + content}, 'Storm victim', 'active', 'local')`;
  }
  async function localUpdate(content: string) {
    // A typical local writer: touches the document, NOT origin/fed_ts.
    await db.sql`
      UPDATE harness_shared.harness_plans
         SET content = ${content}, content_hash = ${'hash-of-' + content}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  }

  it('1. a local INSERT gets a fed_ts stamp + origin local + one captured put', async () => {
    await localInsert('v1-local');
    const r = await row();
    expect(r!.content).toBe('v1-local');
    expect(r!.origin).toBe('local');
    expect(r!.fed_ts).not.toBeNull();
    expect(Number(r!.fed_ts)).toBeGreaterThan(Date.now() - 60_000);
    expect(await outboxCount()).toBe(1);
  });

  it('2. an OLDER remote op cannot revert newer local content (the EI-117 revert)', async () => {
    await localInsert('v1-local');
    const before = await row();
    await writeRemote(planRow('STALE-REPLAY'), Number(before!.fed_ts) - 10_000);
    const after = await row();
    expect(after!.content).toBe('v1-local');
    expect(after!.origin).toBe('local');
    expect(after!.fed_ts).toBe(before!.fed_ts);
  });

  it('3. a ts-less remote op cannot clobber a stamped row (removed EXCLUDED-NULL disjunct, EXCLUDED subtlety included)', async () => {
    await localInsert('v1-local');
    await writeRemote(planRow('NULL-TS-OP'), undefined);
    const after = await row();
    expect(after!.content).toBe('v1-local');
    expect(after!.origin).toBe('local');
  });

  it('4. a NEWER remote op applies, stamps its wire ts, and is NOT re-captured', async () => {
    await localInsert('v1-local');
    const before = await row();
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    // Anchor the op ts to the ROW's PG-stamped clock (cross-clock-skew-proof).
    const opTs = Number(before!.fed_ts) + 10_000;
    await writeRemote(planRow('remote-newer'), opTs);
    const after = await row();
    expect(after!.content).toBe('remote-newer');
    expect(after!.origin).toBe('remote');
    expect(Number(after!.fed_ts)).toBe(opTs);
    expect(await outboxCount()).toBe(0); // echo guard: remote applies never re-capture
  });

  it('5. a local UPDATE after a remote apply re-arms federation, and the replayed remote op is dropped', async () => {
    await localInsert('v1-local');
    const seeded = await row();
    // A remote op 10ms past the seed stamp applies (newer)…
    const opTs = Number(seeded!.fed_ts) + 10;
    await writeRemote(planRow('remote-newer'), opTs);
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    // …then real time passes, so the next local stamp lands past opTs (PG is
    // the single clock here; 50ms of wall time dwarfs the 10ms op offset).
    await new Promise((r2) => setTimeout(r2, 50));

    // The local writer does NOT touch origin/fed_ts (the with-plan-lock-shaped
    // gap) — the mig-214 trigger must reset origin + stamp past the op ts so
    // the capture trigger fires and the replay loses LWW.
    await localUpdate('v2-local-after-remote');
    const r = await row();
    expect(r!.content).toBe('v2-local-after-remote');
    expect(r!.origin).toBe('local');
    expect(Number(r!.fed_ts)).toBeGreaterThan(opTs); // fresh stamp beats the op
    expect(await outboxCount()).toBe(1); // the local edit federates again

    // The storm: replay the previous remote op verbatim → must be a no-op.
    await writeRemote(planRow('remote-newer'), opTs);
    const after = await row();
    expect(after!.content).toBe('v2-local-after-remote');
    expect(after!.origin).toBe('local');
  });

  it('6. a bookkeeping-only write (version bump) keeps the stamp and captures nothing', async () => {
    await localInsert('v1-local');
    const before = await row();
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      UPDATE harness_shared.harness_plans SET version = version + 1
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const after = await row();
    expect(after!.fed_ts).toBe(before!.fed_ts);
    expect(after!.version).toBe(before!.version + 1);
    expect(await outboxCount()).toBe(0);
  });

  it('7. a missing revision store rolls back remote content; restoring it records the actual applied bytes', async () => {
    await localInsert('revision-control-local');
    const before = await row();
    const count = await outboxCount();
    const opTs = Number(before!.fed_ts) + 10_000;
    await db.sql.unsafe('ALTER TABLE harness_shared.plan_revisions RENAME TO plan_revisions_unavailable');
    try {
      await expect(writeRemote(planRow('revision-control-remote'), opTs)).rejects.toThrow(
        /plan revision unavailable.*relation "harness_shared.plan_revisions" does not exist/,
      );
      expect(await row()).toEqual(before);
      expect(await outboxCount()).toBe(count);
    } finally {
      await db.sql.unsafe('ALTER TABLE harness_shared.plan_revisions_unavailable RENAME TO plan_revisions');
    }
    await writeRemote(planRow('revision-control-remote'), opTs);
    expect((await row())!.content).toBe('revision-control-remote');
    expect(await outboxCount()).toBe(count);
    const revisions = await db.sql<Array<{ content_snapshot: string; author_kind: string }>>`
      SELECT content_snapshot, author_kind FROM harness_shared.plan_revisions
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
       ORDER BY seq DESC LIMIT 1`;
    expect(revisions).toEqual([{ content_snapshot: 'revision-control-remote', author_kind: 'system' }]);
  });

  it('8. receiver reseeding distinguishes missing epoch and template columns from an ordinary plan without a rubric', async () => {
    await localInsert('receiver-control-local');
    const before = await row();
    const count = await outboxCount();
    const subject = { workspaceId: WS, harnessSlug: HARNESS, planSlug: SLUG };
    for (const column of ['acceptance_bar_epoch', 'template_slug']) {
      await db.sql.unsafe(`ALTER TABLE harness_shared.harness_plans RENAME COLUMN ${column} TO receiver_column_unavailable`);
      try {
        const missing = await seedAcceptanceBarsOnFederatedApply(db.sql, subject);
        expect(missing.status).toBe('failed');
        if (missing.status !== 'failed') throw new Error(`Expected a missing ${column} failure`);
        expect(missing.error).toContain(`column "${column}" does not exist`);
        expect(await row()).toEqual(before);
        expect(await outboxCount()).toBe(count);
      } finally {
        await db.sql.unsafe(`ALTER TABLE harness_shared.harness_plans RENAME COLUMN receiver_column_unavailable TO ${column}`);
      }
      await expect(seedAcceptanceBarsOnFederatedApply(db.sql, subject)).resolves.toEqual({
        status: 'skipped', reason: 'no-rubric',
      });
    }
    expect(await row()).toEqual(before);
    expect(await outboxCount()).toBe(count);
  });
});
