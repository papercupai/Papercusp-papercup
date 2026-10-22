/**
 * Per-part plan-federation CUTOVER acceptance — flag-ON mutual exclusion on real PG
 * (plan-federation-regrain-2026-06-13 P-009 / D-004; verifies the owner-authorised
 * P-008 cutover before the flag flip).
 *
 * THE PROPERTY UNDER TEST: with papercusp-plan-part-federation ON, the whole-blob
 * `plans-by-slug` path must NOT clobber a per-part merge. The whole-blob projection
 * (projections/harness-plans.ts) drops to BOOTSTRAP-ONLY (INSERT … ON CONFLICT DO
 * NOTHING) and the per-part recompose (projections/harness-plan-parts.ts) becomes
 * the SOLE writer of harness_plans content + scalars. This proves it end-to-end on
 * real Postgres with the REAL projections + the REAL triggers (mig 125 plans
 * capture, mig 214 local-stamp, mig 270/271 parts table + capture, mig 102 outbox):
 *
 *   1. flag ON: a whole-blob op for a NEW plan still BOOTSTRAPS it (INSERT).
 *   2. flag ON: a stale whole-blob op for an EXISTING plan is IGNORED (DO NOTHING) —
 *      no clobber.
 *   3. flag ON (the headline): concurrent edits to DIFFERENT items both survive —
 *      the per-part recompose merges them; the stale whole-blob ops don't clobber.
 *   4. flag ON: the recompose re-derives the scalar columns (a status change in the
 *      frontmatter part federates).
 *   5. flag OFF (control): the whole-blob op UPDATES (clobbers) — proving the gate
 *      is load-bearing and the flag-OFF path is byte-unchanged.
 *   6. TWO-INSTANCE convergence (separate PG dbs): a local part edit on A captures
 *      via the REAL mig-271 trigger → outbox; applied on B's real projection it
 *      merges; cross-applied both peers converge byte-identically with BOTH edits.
 *
 * Owns its schema (mig 102 outbox/capture-fn + column-faithful harness_plans stub +
 * mig 125 plans capture + mig 214 stamp + mig 270/271 parts); does not touch the dev DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { buildHarnessPlansProjection, type HarnessPlanRow } from '../projections/harness-plans';
import { buildHarnessPlanPartsProjection, type PlanPartWireRow } from '../projections/harness-plan-parts';
import { PgPlanPartsStore } from '../../../plan-parts/store';
import { capturePlanParts } from '../../../plan-parts/federation';
import { reconcilePlanParts } from '../../../plan-parts/reconcile';
import { splitPlanIntoParts, type FederatedPart } from '@papercusp/plan-parser';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';
import {
  FEDERATED_BOOTSTRAP_REVISION_AUTHOR,
  FEDERATED_RECOMPOSE_REVISION_AUTHOR,
  FEDERATED_WHOLE_BLOB_REVISION_AUTHOR,
} from '../../../agent-tools/plans/revisions';

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

const WS = 'ws_cutover';
const H = 'papercup';
const SLUG = 'cutover-plan';

function planMarkdown(p1: string, p2: string, status = 'draft'): string {
  return [
    '---',
    'title: Cutover Test',
    `slug: ${SLUG}`,
    `status: ${status}`,
    'created: 2026-06-13',
    'updated: 2026-06-13',
    'owner: o@example.com',
    '---',
    '',
    '# Cutover Test',
    '',
    '## Phase 1 — work',
    '',
    `- **P-001** \`todo\` ${p1}`,
    `- **P-002** \`todo\` ${p2}`,
    '',
  ].join('\n');
}

function planRow(content: string, status = 'draft'): HarnessPlanRow {
  return {
    harness_slug: H,
    plan_slug: SLUG,
    content,
    content_hash: hashPlanContent(content),
    title: 'Cutover Test',
    status,
    created: '2026-06-13',
    updated: '2026-06-13',
    owner: 'o@example.com',
    supersedes: [],
    superseded_by: null,
    archived: false,
    is_legacy: false,
  };
}

/** The full plan schema + every trigger this cutover rides, applied to one db. */
async function setupSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;
  `);
  // Mig 102 (archive) attaches generic capture triggers to the consolidated
  // tables, so column-faithful stubs must exist first (ei117 pattern).
  await sql.unsafe(`
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
  await sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));

  // Column-faithful harness_plans stub (ei117) + the parts table from mig 270.
  await sql.unsafe(`
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
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(), -- read by the boot reconcile sweep (WI-10006276)
      archived      BOOLEAN NOT NULL DEFAULT false,
      is_legacy     BOOLEAN NOT NULL DEFAULT false,
      items         JSONB NOT NULL DEFAULT '[]'::jsonb, -- mig 675 derived plan index
      decisions     JSONB NOT NULL DEFAULT '[]'::jsonb, -- mig 675 derived plan index
      template      TEXT,            -- mig 329 (plan-template-mechanism)
      template_data JSONB,           -- mig 329 (plan-template-mechanism)
      promote_policy JSONB,          -- mig 331 (promote-policy-column)
      input_schema JSONB,            -- mig 714 (structured plan inputs)
      output_schema JSONB,           -- mig 908 (structured plan outputs)
      property_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
      properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      forced_past JSONB,
      author_pubkey TEXT,
      owner_author_pubkey TEXT,      -- P-018/D-012 author-scoped write authority
      origin        TEXT NOT NULL DEFAULT 'local',
      fed_ts        BIGINT,
      fed_hlc       TEXT,
      -- Read by the acceptance-bar receiver seed on every remote apply
      -- (acceptance-bar-seed.ts); live types from information_schema.
      template_slug                    TEXT,
      acceptance_bar_epoch             INTEGER,
      acceptance_bar_cohort            TEXT,
      acceptance_bar_set_hash          TEXT,
      acceptance_bar_rubric_slug       TEXT,
      acceptance_bar_rubric_revision   BIGINT,
      acceptance_bar_seeded_at         TIMESTAMPTZ,
      acceptance_bar_seeded_by         TEXT,
      acceptance_bar_verified_revision BIGINT,
      verification_profile             TEXT,
      verification_profile_source      TEXT,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
  `);
  // Column-faithful stubs (ei117) for the rows the plan writers append beside
  // harness_plans in the same transaction: the derived index rows (mig 675,
  // writePlanIndexRows — their absence red-pinned every test here with
  // `relation "harness_shared.plan_items" does not exist`) and the revision spine
  // (baseline + mig 218; WI-10006275 records one revision per changing recompose).
  // Shapes copied from the live information_schema / pg_constraint. Omitted:
  // plan_revisions.content_snapshot_hash (mig 1107, GENERATED, never written).
  await sql.unsafe(`
    CREATE TABLE harness_shared.plan_items (
      workspace_id      TEXT NOT NULL,
      harness_slug      TEXT NOT NULL,
      plan_slug         TEXT NOT NULL,
      item_id           TEXT NOT NULL,
      seq               INTEGER NOT NULL,
      item_text         TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT 'todo',
      importance        TEXT,
      phase             TEXT,
      blocked_by        TEXT[] NOT NULL DEFAULT '{}',
      decision_refs     TEXT[] NOT NULL DEFAULT '{}',
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      owner_gate_marker TEXT,
      deliverable       TEXT,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
      FOREIGN KEY (workspace_id, harness_slug, plan_slug)
        REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug) ON DELETE CASCADE
    );
    CREATE TABLE harness_shared.plan_decisions (
      workspace_id  TEXT NOT NULL,
      harness_slug  TEXT NOT NULL,
      plan_slug     TEXT NOT NULL,
      decision_id   TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      title         TEXT NOT NULL DEFAULT '',
      body          TEXT NOT NULL DEFAULT '',
      decision_date TEXT,
      item_refs     TEXT[] NOT NULL DEFAULT '{}',
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      affects       TEXT[] NOT NULL DEFAULT '{}',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, decision_id),
      FOREIGN KEY (workspace_id, harness_slug, plan_slug)
        REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug) ON DELETE CASCADE
    );
    CREATE TABLE harness_shared.plan_revisions (
      id               BIGSERIAL PRIMARY KEY,
      workspace_id     TEXT NOT NULL DEFAULT 'default',
      harness_slug     TEXT NOT NULL DEFAULT 'papercup',
      plan_slug        TEXT NOT NULL,
      seq              INTEGER NOT NULL,
      content_hash     TEXT NOT NULL,
      content_snapshot TEXT NOT NULL,
      rationale        TEXT,
      author_kind      TEXT NOT NULL,
      author_id        TEXT NOT NULL,
      session_id       TEXT,
      session_kind     TEXT,
      created_at       BIGINT NOT NULL,
      UNIQUE (workspace_id, harness_slug, plan_slug, seq)
    );
  `);
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '125-harness-plans-federation.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '270-harness-plan-parts.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '271-harness-plan-parts-capture.sql'), 'utf8')));

  // Mig 214 attaches its stamp trigger to all 11 CDC tables (strict — no silent
  // skip on a typo'd name), so cheap stubs stand in for the ones not written here.
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.coord_conversations (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.coord_threads (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.coord_thread_posts (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.plan_item_assignments (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.hive_settings (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.hive_members (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
    CREATE TABLE harness_shared.engineer_issues (id INT, origin TEXT, fed_ts BIGINT, fed_hlc TEXT);
  `);
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '214-federated-fed-ts-local-stamp.sql'), 'utf8')));
}

/** A peer: its db + the two real projections (flag-configurable) + its part store. */
function peer(sql: postgres.Sql, flagOn: boolean) {
  const isFlagOn = async () => flagOn;
  const store = new PgPlanPartsStore(sql, WS, H);
  const plans = buildHarnessPlansProjection({ workspaceId: WS, harnessSlug: H, sql, isFlagOn });
  const parts = buildHarnessPlanPartsProjection({ workspaceId: WS, harnessSlug: H, sql, store, isFlagOn });
  const getPlan = async () => {
    const [r] = await sql<Array<{ content: string; status: string | null; origin: string; version: number }>>`
      SELECT content, status, origin, version::int AS version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${SLUG}`;
    return r;
  };
  const outboxCount = async () => {
    const [r] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r!.n;
  };
  // This node's plan_revisions spine for the test plan, oldest first.
  const revisions = async () =>
    sql<
      Array<{
        seq: number;
        content_hash: string;
        content_snapshot: string;
        rationale: string | null;
        author_kind: string;
        author_id: string;
      }>
    >`
      SELECT seq, content_hash, content_snapshot, rationale, author_kind, author_id
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${SLUG}
       ORDER BY seq`;
  // Apply a whole-blob op as a remote peer would (origin remote, given wire ts).
  const recvWholeBlob = (content: string, ts: number, status = 'draft') =>
    plans.writeToPg(planRow(content, status), { authorPubkey: 'REMOTE', origin: 'remote', ts });
  // Apply a single part op as a remote peer would.
  const recvPart = (row: PlanPartWireRow, ts: number) =>
    parts.writeToPg(row, { authorPubkey: 'REMOTE', origin: 'remote', ts });
  // Apply a part DELETE (tombstone) op as a remote peer would. `key` is the
  // hyperbee key == `<plan_slug>/<part_key>`; `delTs` is the del op's wire ts.
  const recvDelete = (key: string, delTs: number) => parts.deleteFromPg(key, delTs);
  // Find a seeded part's wire row by item id (key/body derived from the store).
  const partRowFor = async (planSlug: string, idToken: string): Promise<PlanPartWireRow> => {
    const all = await store.getParts(planSlug);
    for (const [key, p] of all) {
      if (p.kind === 'item' && (key.includes(idToken) || p.text.includes(idToken))) {
        return {
          harness_slug: H,
          plan_slug: planSlug,
          part_key: key,
          kind: p.kind,
          body: p.text,
          ordinal: p.order,
          tombstone: false,
        };
      }
    }
    throw new Error(`no item part for ${idToken}`);
  };
  return { sql, store, plans, parts, getPlan, outboxCount, revisions, recvWholeBlob, recvPart, recvDelete, partRowFor };
}

describe('plan-part federation cutover (real PG: flag-ON mutual exclusion, no clobber)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_cutover');
    await setupSchema(db.sql);
    p = peer(db.sql, true); // flag ON
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('WI-10006275: a recompose that changes the bytes records exactly ONE system revision; a no-op recompose records none', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap content
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    const before = await p.revisions();

    // A remote part edit recomposes the plan into new bytes.
    const p1 = await p.partRowFor(SLUG, 'P-001');
    await p.recvPart({ ...p1, body: '- **P-001** `todo` one-X' }, 201);
    const recomposed = (await p.getPlan())!.content;
    expect(recomposed).toContain('one-X');

    const after = await p.revisions();
    expect(after).toHaveLength(before.length + 1);
    const rev = after[after.length - 1]!;
    // The revision describes exactly the bytes now live, so plans:revisions /
    // plans:audit can see (and a restore can target) a federated change.
    expect(rev.content_snapshot).toBe(recomposed);
    expect(rev.content_hash).toBe(hashPlanContent(recomposed));
    expect(rev.author_kind).toBe('system');
    expect(rev.author_id).toBe(FEDERATED_RECOMPOSE_REVISION_AUTHOR);
    expect(rev.rationale).toContain('federated per-part recompose');

    // The same op again merges to identical bytes: the content_hash guard skips the
    // UPDATE, so a no-op recompose mints no revision.
    await p.recvPart({ ...p1, body: '- **P-001** `todo` one-X' }, 201);
    expect(await p.revisions()).toHaveLength(after.length);
  });

  it('1. flag ON: a whole-blob op for a NEW plan BOOTSTRAPS it (INSERT)', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100);
    expect((await p.getPlan())!.content).toBe(c0);
    const [profile] = await db.sql<Array<{
      verification_profile: string | null;
      verification_profile_source: string | null;
    }>>`
      SELECT verification_profile, verification_profile_source
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${H} AND plan_slug = ${SLUG}`;
    expect(profile).toEqual({ verification_profile: 'coding', verification_profile_source: 'harness-default' });
    // WI-10006275: the bootstrap is this node's first write of the plan, so its bytes
    // get exactly one (system) revision row.
    const revs = await p.revisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.content_snapshot).toBe(c0);
    expect(revs[0]!.content_hash).toBe(hashPlanContent(c0));
    expect(revs[0]!.author_kind).toBe('system');
    expect(revs[0]!.author_id).toBe(FEDERATED_BOOTSTRAP_REVISION_AUTHOR);
  });

  it('2. flag ON: a stale whole-blob op for an EXISTING plan is IGNORED (DO NOTHING, no clobber)', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap
    await p.recvWholeBlob(planMarkdown('CLOBBER-1', 'CLOBBER-2'), 200); // stale whole-doc
    expect((await p.getPlan())!.content).toBe(c0); // unchanged — gate held
    expect(await p.revisions()).toHaveLength(1); // the ignored blob mints no revision
  });

  it('3. flag ON (HEADLINE): concurrent different-item edits both survive; whole-blob does not clobber', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap content
    // Seed parts from C0 (the backfill); clear the capture echo it produces.
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;

    const p1 = await p.partRowFor(SLUG, 'P-001');
    const p2 = await p.partRowFor(SLUG, 'P-002');
    // Peer X edits P-001, peer Y edits P-002 — each arrives as a (stale) whole-blob
    // op AND its part op, newer than the bootstrap. Apply interleaved.
    await p.recvWholeBlob(planMarkdown('one-X', 'two'), 201); // X's stale full doc
    await p.recvPart({ ...p1, body: '- **P-001** `todo` one-X' }, 201);
    await p.recvWholeBlob(planMarkdown('one', 'two-Y'), 202); // Y's stale full doc
    await p.recvPart({ ...p2, body: '- **P-002** `todo` two-Y' }, 202);

    const content = (await p.getPlan())!.content;
    expect(content).toContain('one-X'); // X's edit survived
    expect(content).toContain('two-Y'); // Y's edit survived — MERGE, not clobber
    expect(content).not.toContain('`todo` one\n'); // original P-001 line gone
    expect(content).not.toContain('`todo` two\n'); // original P-002 line gone
  });

  it('4. flag ON: the recompose re-derives scalar columns (a status change federates)', async () => {
    const c0 = planMarkdown('one', 'two', 'draft');
    await p.recvWholeBlob(c0, 100);
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    expect((await p.getPlan())!.status).toBe('draft');

    // A remote edit flips the frontmatter part's status to active.
    const all = await p.store.getParts(SLUG);
    let fmKey = '';
    for (const [key, part] of all) if (part.kind === 'frontmatter') fmKey = key;
    expect(fmKey).not.toBe('');
    const fmPart = all.get(fmKey)!;
    await p.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: fmKey,
        kind: 'frontmatter',
        body: fmPart.text.replace('status: draft', 'status: active'),
        ordinal: fmPart.order,
        tombstone: false,
      },
      300,
    );
    expect((await p.getPlan())!.status).toBe('active'); // scalar re-derived from frontmatter part
  });

  it('P-009: per-part recomposition refuses a cycle and preserves the last valid live candidate', async () => {
    const c0 = planMarkdown('one', 'two', 'ready');
    await p.recvWholeBlob(c0, 100);
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    const p1 = await p.partRowFor(SLUG, 'P-001');
    const p2 = await p.partRowFor(SLUG, 'P-002');

    // First leg is a valid DAG and may land.
    await p.recvPart({ ...p1, body: '- **P-001** `todo` one blocked-by: P-002' }, 201);
    const valid = (await p.getPlan())!.content;
    expect(valid).toContain('one blocked-by: P-002');

    // The reciprocal leg would make the recomposed candidate cyclic. It remains
    // staged in harness_plan_parts, but cannot overwrite the live plan row.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await p.recvPart({ ...p2, body: '- **P-002** `todo` two blocked-by: P-001' }, 202);
    expect(warn.mock.calls.flat().join(' ')).toContain('rejected federated part recompose');
    warn.mockRestore();
    expect((await p.getPlan())!.content).toBe(valid);
  });

  it('7. flag ON RECEIVE baseline (P-010): a parts-empty peer (content via whole-blob) merges a lone incoming part — not a broken one-part doc', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // content present via whole-blob bootstrap…
    expect((await p.store.getParts(SLUG)).size).toBe(0); // …but harness_plan_parts is EMPTY (no backfill)

    // A lone remote part op for P-001 arrives. applyPart must self-baseline from
    // the local harness_plans.content FIRST, then merge — else recompose would
    // produce join({1 part}) and erase P-002.
    const edited = splitPlanIntoParts(planMarkdown('one-REMOTE', 'two')).find((pt) => pt.key === 'item:P-001')!;
    await p.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: edited.key,
        kind: edited.kind,
        body: edited.text,
        ordinal: edited.order,
        tombstone: false,
      },
      700,
    );

    const content = (await p.getPlan())!.content;
    expect(content).toContain('one-REMOTE'); // the incoming edit applied
    expect(content).toContain('`todo` two'); // P-002 survived (baseline seeded it)
    expect(content).toContain('## Phase 1 — work'); // structure intact, not a 1-part doc
  });
});

describe('plan-part federation cutover — flag-OFF control (whole-blob path byte-unchanged)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_cutover_off');
    await setupSchema(db.sql);
    p = peer(db.sql, false); // flag OFF
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('5. flag OFF: a newer whole-blob op UPDATES content (clobbers) — gate is load-bearing', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // full upsert (insert)
    await p.recvWholeBlob(planMarkdown('one-NEW', 'two-NEW'), 200); // newer → applies
    expect((await p.getPlan())!.content).toBe(planMarkdown('one-NEW', 'two-NEW')); // whole-doc LWW (the legacy behavior)
  });

  it('WI-10006313: flag OFF: the whole-blob upsert records a revision exactly when it writes new bytes', async () => {
    // A remote INSERT is this node's first copy of the plan: one bootstrap revision.
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100);
    let revs = await p.revisions();
    expect(revs).toHaveLength(1);
    expect(revs[0]!.content_snapshot).toBe(c0);
    expect(revs[0]!.content_hash).toBe(hashPlanContent(c0));
    expect(revs[0]!.author_kind).toBe('system');
    expect(revs[0]!.author_id).toBe(FEDERATED_BOOTSTRAP_REVISION_AUTHOR);

    // A newer remote blob with different bytes overwrites content (DO UPDATE): one
    // revision describing exactly the bytes now live, so plans:revisions / plans:audit
    // can see a federated overwrite (a rollback included) and a restore can target it.
    const c1 = planMarkdown('one-NEW', 'two-NEW');
    await p.recvWholeBlob(c1, 200);
    expect((await p.getPlan())!.content).toBe(c1);
    revs = await p.revisions();
    expect(revs).toHaveLength(2);
    expect(revs[1]!.content_snapshot).toBe(c1);
    expect(revs[1]!.content_hash).toBe(hashPlanContent(c1));
    expect(revs[1]!.author_kind).toBe('system');
    expect(revs[1]!.author_id).toBe(FEDERATED_WHOLE_BLOB_REVISION_AUTHOR);
    expect(revs[1]!.rationale).toContain('federated whole-blob apply');

    // Equal bytes again: a remote re-delivery, then the local echo of an own write.
    // Both still pass the LWW guard and fire the DO UPDATE, but no content changed.
    await p.recvWholeBlob(c1, 300);
    await p.plans.writeToPg(planRow(c1), { authorPubkey: 'LOCAL', origin: 'local', ts: 400 });
    // A stale blob loses the LWW guard and writes nothing.
    await p.recvWholeBlob(c0, 50);
    expect((await p.getPlan())!.content).toBe(c1);
    expect(await p.revisions()).toHaveLength(2);
  });

  it('WI-10006313: flag OFF: a local-origin INSERT records no revision (as with flag ON, only a remote bootstrap does)', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.plans.writeToPg(planRow(c0), { authorPubkey: 'LOCAL', origin: 'local', ts: 100 });
    expect((await p.getPlan())!.content).toBe(c0);
    expect(await p.revisions()).toHaveLength(0);
  });

  it('P-009: whole-blob import rejects a newly cyclic candidate without changing the live row', async () => {
    const valid = planMarkdown('one', 'two', 'ready');
    await p.recvWholeBlob(valid, 100, 'ready');
    const cyclic = planMarkdown('one blocked-by: P-002', 'two blocked-by: P-001', 'ready');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await p.recvWholeBlob(cyclic, 200, 'ready');
    expect(warn.mock.calls.flat().join(' ')).toContain('rejected federated whole-plan write');
    warn.mockRestore();
    expect((await p.getPlan())!.content).toBe(valid);
  });

  it('P-009: whole-blob import permits a strict-subset repair of a legacy-invalid row', async () => {
    const legacy = planMarkdown('one blocked-by: P-099', 'two blocked-by: P-098', 'ready');
    await p.sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, origin, fed_ts)
      VALUES (${WS}, ${H}, ${SLUG}, ${legacy}, ${hashPlanContent(legacy)}, 'Cutover Test', 'ready', 'remote', 100)
    `;
    const repair = planMarkdown('one blocked-by: P-099', 'two', 'ready');

    await p.recvWholeBlob(repair, 200, 'ready');

    expect((await p.getPlan())!.content).toBe(repair);
  });
});

describe('plan-part federation cutover — TWO-INSTANCE convergence (separate PG dbs, flag ON)', () => {
  let dbA: FreshPgDb;
  let dbB: FreshPgDb;
  let A: ReturnType<typeof peer>;
  let B: ReturnType<typeof peer>;

  beforeAll(async () => {
    dbA = await createFreshPgDb('plan_part_conv_a');
    dbB = await createFreshPgDb('plan_part_conv_b');
    await setupSchema(dbA.sql);
    await setupSchema(dbB.sql);
    A = peer(dbA.sql, true);
    B = peer(dbB.sql, true);
  }, 90_000);
  afterAll(async () => {
    await dbA?.cleanup();
    await dbB?.cleanup();
  });

  it('6. a local part edit on A captures via the real trigger; cross-applied, A and B converge byte-identically with BOTH edits', async () => {
    const c0 = planMarkdown('one', 'two');
    // Both peers start at C0 (bootstrap content + seed parts).
    for (const x of [A, B]) {
      await x.recvWholeBlob(c0, 100);
      await capturePlanParts(x.store, SLUG, c0, 100, 'seed');
      await x.sql`DELETE FROM harness_shared.substrate_outbox`;
    }

    // A LOCALLY edits P-001 (origin local) → the REAL mig-271 capture trigger fires.
    const aP1 = await A.partRowFor(SLUG, 'P-001');
    await A.store.upsertPart(
      SLUG,
      {
        key: aP1.part_key,
        kind: 'item',
        text: '- **P-001** `todo` one-A',
        order: aP1.ordinal,
        fedTs: 201,
        author: 'A',
      },
      'local',
    );
    expect(await A.outboxCount()).toBeGreaterThan(0); // capture fired on the local part write

    // B LOCALLY edits P-002.
    const bP2 = await B.partRowFor(SLUG, 'P-002');
    await B.store.upsertPart(
      SLUG,
      {
        key: bP2.part_key,
        kind: 'item',
        text: '- **P-002** `todo` two-B',
        order: bP2.ordinal,
        fedTs: 202,
        author: 'B',
      },
      'local',
    );

    // Cross-apply each peer's edited part to the other (what the swarm carries).
    await B.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: aP1.part_key,
        kind: 'item',
        body: '- **P-001** `todo` one-A',
        ordinal: aP1.ordinal,
        tombstone: false,
      },
      201,
    );
    await A.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: bP2.part_key,
        kind: 'item',
        body: '- **P-002** `todo` two-B',
        ordinal: bP2.ordinal,
        tombstone: false,
      },
      202,
    );
    // Each peer also recomposes its own local edit into harness_plans (the local
    // write path does this; here drive it via a self-apply of the local part).
    await A.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: aP1.part_key,
        kind: 'item',
        body: '- **P-001** `todo` one-A',
        ordinal: aP1.ordinal,
        tombstone: false,
      },
      201,
    );
    await B.recvPart(
      {
        harness_slug: H,
        plan_slug: SLUG,
        part_key: bP2.part_key,
        kind: 'item',
        body: '- **P-002** `todo` two-B',
        ordinal: bP2.ordinal,
        tombstone: false,
      },
      202,
    );

    const ca = (await A.getPlan())!.content;
    const cb = (await B.getPlan())!.content;
    expect(ca).toContain('one-A');
    expect(ca).toContain('two-B');
    expect(cb).toContain('one-A');
    expect(cb).toContain('two-B');
    expect(ca).toBe(cb); // byte-identical convergence across two separate databases
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G11 [P1] — part-deletion (tombstone) lifecycle. On the PG store a tombstone is
// SOFT (a flag + fed_ts, not a DELETE) so a late op for a removed key is still
// LWW-ordered: a STALE older edit loses to the tombstone (stays deleted) while a
// NEWER edit wins (resurrects). Tombstones never appear in recomposed content.
// ─────────────────────────────────────────────────────────────────────────────
describe('plan-part federation — G11 part-deletion (tombstone) lifecycle (real PG, flag ON)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_g11');
    await setupSchema(db.sql);
    p = peer(db.sql, true); // flag ON — recompose drives harness_plans
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  // Seed a two-item plan + its parts; clear the capture echo from the backfill.
  async function seed(): Promise<void> {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100);
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  }
  const delKey = `${SLUG}/item:P-001`;

  it('a deleted part stays deleted against a STALE older edit; tombstone absent from recomposed content', async () => {
    await seed();
    // Delete P-001 at ts=300.
    await p.recvDelete(delKey, 300);
    let content = (await p.getPlan())!.content;
    expect(content).not.toContain('P-001'); // (c) tombstone absent from recompose
    expect(content).toContain('P-002'); // sibling untouched

    // A STALE edit (ts=250 < 300) for the SAME key arrives → must LOSE to the tombstone.
    const p1 = {
      harness_slug: H,
      plan_slug: SLUG,
      part_key: 'item:P-001',
      kind: 'item' as const,
      body: '- **P-001** `todo` STALE-EDIT',
      ordinal: 1,
      tombstone: false,
    };
    await p.recvPart(p1, 250);

    // Store: the tombstone still wins (soft tombstone, LWW by fed_ts).
    const tomb = (await p.store.getParts(SLUG)).get('item:P-001');
    expect(tomb?.tombstone).toBe(true);
    content = (await p.getPlan())!.content;
    expect(content).not.toContain('STALE-EDIT'); // (a) stays deleted
    expect(content).not.toContain('P-001');
  });

  it('a NEWER edit resurrects a deleted part', async () => {
    await seed();
    await p.recvDelete(delKey, 300);
    expect((await p.getPlan())!.content).not.toContain('P-001');

    // A NEWER edit (ts=350 > 300) for the SAME key arrives → must WIN, resurrecting it.
    const p1 = {
      harness_slug: H,
      plan_slug: SLUG,
      part_key: 'item:P-001',
      kind: 'item' as const,
      body: '- **P-001** `done` RESURRECTED',
      ordinal: 1,
      tombstone: false,
    };
    await p.recvPart(p1, 350);

    const live = (await p.store.getParts(SLUG)).get('item:P-001');
    expect(live?.tombstone).toBeUndefined(); // (b) no longer a tombstone
    const content = (await p.getPlan())!.content;
    expect(content).toContain('RESURRECTED');
    expect(content).toContain('P-002');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G12 [P2] — per-part LWW tie-break on EQUAL fedTs. The PG store's ON CONFLICT
// guard tie-breaks identical fed_ts by lexical `author` (z>a), COALESCE'ing NULL
// to '' so a named author beats NULL and NULL never beats anything. Exercised
// directly against PgPlanPartsStore.upsertPart on real PG.
// ─────────────────────────────────────────────────────────────────────────────
describe('plan-part federation — G12 equal-fedTs author tie-break (real PG store)', () => {
  let db: FreshPgDb;
  let store: PgPlanPartsStore;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_g12');
    await setupSchema(db.sql);
    store = new PgPlanPartsStore(db.sql, WS, H);
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
  });

  const mk = (author: string | undefined, body: string): FederatedPart => ({
    key: 'item:P-001',
    kind: 'item',
    text: body,
    order: 0,
    fedTs: 500,
    ...(author !== undefined ? { author } : {}),
  });
  const bodyOf = async () => (await store.getParts('g12')).get('item:P-001')?.text;
  const authorOf = async () => (await store.getParts('g12')).get('item:P-001')?.author;

  it('equal fedTs, different author: higher author (z) wins — apply a-then-z', async () => {
    await store.upsertPart('g12', mk('a', 'from-a'));
    await store.upsertPart('g12', mk('z', 'from-z'));
    expect(await bodyOf()).toBe('from-z'); // z > a → z wins
  });

  it('equal fedTs, different author: higher author (z) wins — apply z-then-a (order-independent)', async () => {
    await store.upsertPart('g12', mk('z', 'from-z'));
    await store.upsertPart('g12', mk('a', 'from-a')); // a < z → loses the tie, dropped
    expect(await bodyOf()).toBe('from-z'); // z still wins regardless of apply order
  });

  it('equal fedTs, NULL author vs named: named wins (COALESCE default) — both orders', async () => {
    // named-then-NULL: NULL ('') is not > named, so it loses.
    await store.upsertPart('g12', mk('m', 'from-named'));
    await store.upsertPart('g12', mk(undefined, 'from-null'));
    expect(await bodyOf()).toBe('from-named');
    expect(await authorOf()).toBe('m');

    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    // NULL-then-named: named ('m') > NULL ('') so it wins.
    await store.upsertPart('g12', mk(undefined, 'from-null'));
    await store.upsertPart('g12', mk('m', 'from-named'));
    expect(await bodyOf()).toBe('from-named');
    expect(await authorOf()).toBe('m');
  });

  it('equal fedTs, NULL author vs NULL author: tie is NOT won (COALESCE("","") not strictly >), first write stands', async () => {
    await store.upsertPart('g12', mk(undefined, 'first-null'));
    await store.upsertPart('g12', mk(undefined, 'second-null')); // '' > '' is false → dropped
    expect(await bodyOf()).toBe('first-null');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G13 [P2] — whole-blob → part-edit → stale-whole-blob ordering. With the flag ON
// the whole-blob path is bootstrap-only; a later whole-blob op must be REJECTED by
// the clobber gate (INSERT … DO NOTHING) while the per-part recompose remains the
// sole content writer. Final content reflects the part edit, never the stale blob.
// ─────────────────────────────────────────────────────────────────────────────
describe('plan-part federation — G13 whole-blob / part-edit / stale-whole-blob ordering (real PG, flag ON)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_g13');
    await setupSchema(db.sql);
    p = peer(db.sql, true); // flag ON
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('whole-blob bootstrap → newer whole-blob rejected by gate → part edit applies; never the rejected blob', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap (INSERT)
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;

    // A whole-blob op at ts=150 must be REJECTED by the clobber gate (DO NOTHING).
    await p.recvWholeBlob(planMarkdown('BLOB-150-one', 'BLOB-150-two'), 150);
    expect((await p.getPlan())!.content).toBe(c0); // gate held — blob did not clobber

    // A per-part edit at ts=200 applies via the recompose (the sole content writer).
    const p1 = await p.partRowFor(SLUG, 'P-001');
    await p.recvPart({ ...p1, body: '- **P-001** `done` part-edit-200' }, 200);

    const content = (await p.getPlan())!.content;
    expect(content).toContain('part-edit-200'); // the part edit is reflected
    expect(content).not.toContain('BLOB-150'); // the ts=150 blob never appears
    expect(content).toContain('two'); // P-002 untouched (merge, not clobber)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G14 [P3] — recompose no-op skip. `content_hash IS DISTINCT FROM` skips a recompose
// whose merged output is byte-identical to what's stored: applying the SAME part op
// twice must NOT bump `version` or emit a second `substrate_outbox` row. A broken
// hash compare would churn the version → a federation loop.
// ─────────────────────────────────────────────────────────────────────────────
describe('plan-part federation — G14 recompose no-op skip (real PG, flag ON)', () => {
  let db: FreshPgDb;
  let p: ReturnType<typeof peer>;

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_g14');
    await setupSchema(db.sql);
    p = peer(db.sql, true); // flag ON
  }, 60_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('applying the SAME part op twice leaves version unchanged and emits no new outbox row', async () => {
    const c0 = planMarkdown('one', 'two');
    await p.recvWholeBlob(c0, 100); // bootstrap
    await capturePlanParts(p.store, SLUG, c0, 100, 'seed');
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;

    const p1 = await p.partRowFor(SLUG, 'P-001');
    const edit = { ...p1, body: '- **P-001** `done` edited-once' };

    // First apply: the recompose changes content → version bumps once.
    await p.recvPart(edit, 200);
    const v1 = (await p.getPlan())!.version;
    const outbox1 = await p.outboxCount();

    // Second apply of the IDENTICAL op (same body, newer ts): the part LWW upsert
    // changes nothing material; the recompose output hashes identically → the
    // `content_hash IS DISTINCT FROM` guard skips the UPDATE. No version churn.
    await p.recvPart(edit, 300);
    const v2 = (await p.getPlan())!.version;
    const outbox2 = await p.outboxCount();

    expect(v2).toBe(v1); // version did NOT churn on the no-op recompose
    expect(outbox2).toBe(outbox1); // no spurious capture → no federation loop
  });
});

// WI-10006276 — the boot reconcile sweep stamps a LOCAL plan's capture with the time its
// CONTENT was written, not harness_plans.updated_at. Mig 211 bumps updated_at on
// non-content writes too (op_status, archived, supersede links), and mig 214 stamps
// fed_ts on them as well, so neither column dates the body. If a local row's newer
// remote parts arrived but were not recomposed (a dependency-admission rejection or a
// deferred batch), such a bump let the stale body out-rank them in the parts LWW and
// the sweep federated the stale body back out over the newer edit.
describe('plan-part reconcile sweep: content_ts is the content write time (real PG, WI-10006276)', () => {
  let db: FreshPgDb;
  const T1 = Date.UTC(2026, 9, 1, 12, 0, 0); // local body written; its revision is recorded
  const T2 = T1 + 60_000; // a peer's newer P-001 part arrives here and is NOT recomposed
  const T3 = T1 + 120_000; // a non-content write bumps updated_at past T2

  beforeAll(async () => {
    db = await createFreshPgDb('plan_part_reconcile_ts');
    await setupSchema(db.sql);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM harness_shared.harness_plan_parts`;
    await db.sql`DELETE FROM harness_shared.harness_plans`;
    await db.sql`DELETE FROM harness_shared.plan_revisions`;
  });

  const store = (): PgPlanPartsStore => new PgPlanPartsStore(db.sql, WS, H);

  async function seedLocalPlan(content: string, revisionAt: number, updatedAt: number): Promise<void> {
    await db.sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, origin, updated_at)
      VALUES (${WS}, ${H}, ${SLUG}, 'Cutover Test', 'draft', ${content}, ${hashPlanContent(content)}, 'local',
              to_timestamp(${updatedAt / 1000}))`;
    await db.sql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, author_kind, author_id, created_at)
      VALUES (${WS}, ${H}, ${SLUG}, 1, ${hashPlanContent(content)}, ${content}, 'agent', 'su-test', ${revisionAt})`;
  }

  async function seedRemoteParts(content: string, fedTs: number): Promise<void> {
    for (const part of splitPlanIntoParts(content)) {
      await store().upsertPart(SLUG, { ...part, fedTs, author: 'peer-b' }, 'remote');
    }
  }

  async function storedP001(): Promise<string | undefined> {
    const parts = [...(await store().getParts(SLUG)).values()];
    return parts.find((x) => !x.tombstone && x.text.includes('**P-001**'))?.text;
  }

  it('a stale local body whose updated_at a non-content write bumped does NOT beat newer remote parts', async () => {
    await seedLocalPlan(planMarkdown('alpha', 'beta'), T1, T3);
    await seedRemoteParts(planMarkdown('alpha-remote', 'beta'), T2);

    const result = await reconcilePlanParts({ workspaceId: WS, sql: db.sql });

    expect(result.errors).toBe(0);
    expect(result.plansScanned).toBe(1);
    expect(await storedP001()).toContain('alpha-remote');
  });

  it('positive control: a local edit written AFTER the remote parts is still captured over them', async () => {
    const T4 = T1 + 180_000;
    await seedLocalPlan(planMarkdown('zeta', 'beta'), T4, T4);
    await seedRemoteParts(planMarkdown('alpha-remote', 'beta'), T2);

    const result = await reconcilePlanParts({ workspaceId: WS, sql: db.sql });

    expect(result.errors).toBe(0);
    const p001 = await storedP001();
    expect(p001).toContain('zeta');
    expect(p001).not.toContain('alpha-remote');
  });
});
