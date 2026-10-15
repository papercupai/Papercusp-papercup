/**
 * cross-plan-federation-seam.integration.test.ts — the marquee cross-plan
 * two-peer federation seam (BRIEF-test-coverage-fu-workitems-and-crossplan-seam,
 * Part B). Real Postgres, two simulated peers (two databases on the testcontainer).
 *
 * The per-domain federation tests each hand-build ONE projection and call its
 * writeToPg directly (coord-conversation-federation.integration.test.ts hard-codes
 * `{origin:'remote'}`; plan-item-assignments.integration.test.ts likewise). NONE
 * of them exercises the SHARED production apply path that multiplexes every
 * federated surface — and that is exactly where a cross-plan bug hides. This test
 * drives the REAL `buildHarnessProjectionApply` (the per-harness scoped registry
 * the boot path wires `mergeNow` to) end-to-end:
 *
 *   peer A: local write → migration-102/144/145 capture trigger → substrate_outbox
 *        → outboxRowToLocalWriteOp (the real Stage-3 reshape)
 *        → applyB(op) === buildHarnessProjectionApply(...)  (the real applyOpVia dispatch)
 *        → peer B's coord_conversations / plan_item_assignments converge.
 *
 * It asserts the FEDERATION CONTRACT the brief wants, on the surfaces that have
 * actually LANDED (coord_conversations = mig 144; plan_item_assignments /
 * 'item-assignments' = mig 145):
 *   1. content round-trips A→B for BOTH surfaces;
 *   2. CROSS-SURFACE MULTIPLEXING — a conversation op and an assignment op routed
 *      through ONE registry land in their respective tables (the seam per-domain
 *      tests miss);
 *   3. ORIGIN is DERIVED by the apply path from the ownLogKeyHex log-source
 *      comparison (own log → local, admitted remote log → remote) — NOT hard-coded;
 *   4. ISOLATION — "a non-subscribed peer does NOT receive it":
 *      (a) an operator-scope conversation never enters the outbox (doesn't federate);
 *      (b) the projection's per-harness binding DROPS a row for another harness;
 *      (c) the echo-guard: a remote-applied row does NOT re-enqueue on the receiver
 *          (the round-trip reaches a fixed point — no echo storm to other peers);
 *   5. an op for an unregistered table is dropped (applyOpVia returns false).
 *
 * SUBSCRIBE→INJECT (the brief's marquee Part B) — the messages rail. Since the
 * parent session, migration 150 (distributed-coordination Track A, surface #1)
 * landed coord_event_log federation: a harness-scoped coord message captures to
 * substrate_outbox, federates through the SAME scoped registry, lands in the
 * peer's coord_event_log, and — crucially — the peer's REAL `coord:inbox` read
 * (`readInbox` → PgCoordLog.readLines + filterInbox) finds it by the envelope
 * `to[]`. The second describe block below drives that full loop end-to-end across
 * two peers, including the isolation negative the brief names ("a non-subscribed
 * peer does NOT receive it"). This is the subscribe→inject seam that was BLOCKED
 * for the parent session — now wired, no longer speculative.
 *
 * STILL NOT in scope (genuinely unbuilt — would be speculative): the brief's
 * other two literal nouns. WORK-ITEM content federation is deferred
 * (unify-work-items D-011 #2 — no work_items projection), and TOPIC federation
 * has no projection at all. When those land, this file's two-peer harness extends
 * to them the same way the messages rail did.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { applyDisclosureLedgerForTest, createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import type { OpEnvelope } from '../op-envelope-types';
// The real coord:inbox read seam — drives the subscribe→inject half end-to-end.
import { PgCoordLog } from '@papercusp/coordination/event-log';
import {
  appendAck,
  readAckedMsgIds,
  readInbox,
  readThread,
  sendMessage,
} from '../../../agent-tools/coordination/messages';
import { configureCoordLog, resetCoordLog } from '../../../agent-tools/coordination/log';
import type { AgentIdentity } from '../../../agent-tools/coordination/identity';

// getOrgPg → peer B's DB: buildHarnessProjectionApply's projections write through
// it, so applying an op lands on peer B. Peer A is driven by its own raw client.
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { buildHarnessProjectionApply } = await import('../projections/register-all');

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');

/** Strip psql meta (\set …) + the standalone BEGIN;/COMMIT; wrapper (postgres-js
 *  refuses bare BEGIN/COMMIT in a pooled `unsafe`). Keeps GRANTs + plpgsql BEGIN. */
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

const WS = 'ws_fed';
const HARNESS = 'fed';
const PEER_A_LOG = 'a'.repeat(64); // peer A's own-log hex key (the "remote" source on B)
const PEER_B_LOG = 'b'.repeat(64); // peer B's own-log hex key
const SENDER_A: AgentIdentity = {
  ownerId: 'su-A',
  ownerLabel: 'su-A',
  source: 'omp-hook-session',
  workspaceId: WS,
  userId: null,
};
const SENDER_B: AgentIdentity = {
  ownerId: 'su-B',
  ownerLabel: 'su-B',
  source: 'omp-hook-session',
  workspaceId: WS,
  userId: null,
};

/** Stand up the column-faithful federated schema + the real capture triggers
 *  (mig 102 outbox/fn, 144 conversations, 140 assignments table, 145 assignment
 *  triggers) on a throwaway peer DB. Mirrors coord-conversation-federation's setup. */
async function setupPeerSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;
  `);
  // coord_conversations, post-144 shape (origin/author_pubkey present).
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text DEFAULT 'default' NOT NULL, id text NOT NULL,
      kind text NOT NULL, scope text DEFAULT 'operator' NOT NULL, harness_slug text,
      asker_id text NOT NULL, title text, body text DEFAULT '' NOT NULL,
      state text DEFAULT 'open' NOT NULL, accepted_answer text, accepted_post_id bigint,
      capture_target text, promoted_issue_id text,
      producer text,                                  -- EI-21462599108204160 (mig 961)
      superseded_by text, superseded_at timestamptz,  -- EI-21466427005733939
      created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
      resolved_at timestamptz, origin text NOT NULL DEFAULT 'local', author_pubkey text,
      CONSTRAINT coord_conversations_pkey PRIMARY KEY (workspace_id, id),
      CONSTRAINT coord_conversations_kind_check  CHECK (kind  = ANY (ARRAY['question','discussion'])),
      CONSTRAINT coord_conversations_scope_check CHECK (scope = ANY (ARRAY['operator','harness'])),
      CONSTRAINT coord_conversations_state_check CHECK (state = ANY (ARRAY['open','resolved','closed'])),
      CONSTRAINT coord_conversations_scope_slug_check CHECK (
          (scope = 'harness' AND harness_slug IS NOT NULL AND harness_slug <> '')
       OR (scope = 'operator' AND harness_slug IS NULL))
    );
  `);
  // Minimal hfc/issues stubs (mig 102 attaches capture triggers to them).
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_features_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      feature_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (harness_slug, feature_id));
    CREATE TABLE harness_shared.harness_issues_consolidated (
      workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
      issue_id TEXT NOT NULL, author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local',
      PRIMARY KEY (harness_slug, issue_id));
  `);
  // coord_event_log base table (the message rail). Mig 150 ALTERs it (federation
  // columns + capture triggers + the fed unique index) — so create the base shape
  // first, exactly like the runtime ensureCoordEventLogTable would.
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default',
      surface text NOT NULL, writer_key text, msg_id text NOT NULL,
      body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now(),
      superseded_by_msg_id text, superseded_at timestamptz); -- EI-21467654382027859
    CREATE UNIQUE INDEX coord_event_log_event_uq
      ON harness_shared.coord_event_log (workspace_id, surface, msg_id)
      WHERE surface IN ('handoffs', 'escalations');
  `);
  await sql.unsafe(readFileSync(OUTBOX_MIGRATION, 'utf8')); // 102: outbox + capture fn + hfc/issues triggers
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '144-coord-conversations-federation.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '140-plan-item-assignments.sql'), 'utf8')));
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '145-plan-item-assignments-federation.sql'), 'utf8')));
  // 150: coord_event_log federation — harness_slug/origin/author_pubkey + fed
  // unique index + the messages/handoffs/escalations capture triggers.
  await sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '150-coord-event-log-federation.sql'), 'utf8')));
  // Real sendMessage seals against this ledger before persisting or capturing
  // a message. Both peers need the maintained migration, including with no
  // active disclosures; an absent ledger must continue to fail closed.
  await applyDisclosureLedgerForTest(sql);

  // 181 (EI-79 step 2): fed_ts LWW-guard column on every federated table the
  // writers stamp, + MASK fed_ts in the broad hfc/issues capture triggers so a
  // wall-clock fed_ts bump never re-enqueues an unchanged row (convergence).
  await sql.unsafe(`
    ALTER TABLE harness_shared.coord_conversations          ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.coord_conversations          ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
    ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
    ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
    ALTER TABLE harness_shared.plan_item_assignments         ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.plan_item_assignments         ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
    ALTER TABLE harness_shared.coord_event_log               ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
    ALTER TABLE harness_shared.coord_event_log               ADD COLUMN IF NOT EXISTS fed_hlc TEXT;
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_features_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
    CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
      AFTER UPDATE ON harness_shared.harness_issues_consolidated
      FOR EACH ROW WHEN ((to_jsonb(OLD.*) - 'fed_ts') IS DISTINCT FROM (to_jsonb(NEW.*) - 'fed_ts'))
      EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
  `);
}

interface OutboxDbRow {
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

let dbA: FreshPgDb; // the remote sender (raw client; its triggers capture to its outbox)
let dbB: FreshPgDb; // the local applier (getOrgPg → its sql; buildHarnessProjectionApply writes here)
let applyA: (op: OpEnvelope) => Promise<boolean>;
let applyB: (op: OpEnvelope) => Promise<boolean>;

/** Reshape one peer's outbox into remote OpEnvelopes and apply them through the
 *  destination's REAL scoped registry. `replays` deliberately supports the
 *  duplicate-delivery recurrence: replaying one immutable op must still leave
 *  one coord_event_log row at the receiver. */
async function drainPeerToPeer(
  source: FreshPgDb,
  destination: FreshPgDb,
  apply: (op: OpEnvelope) => Promise<boolean>,
  sourceLogKeyHex: string,
  replays = 1,
): Promise<number> {
  h.sql = destination.sql;
  const rows = await source.sql<OutboxDbRow[]>`
    SELECT table_name, op, key, row, ts FROM harness_shared.substrate_outbox ORDER BY id`;
  let applied = 0;
  for (const r of rows) {
    const local = outboxRowToLocalWriteOp({ table_name: r.table_name, op: r.op as 'put' | 'del', key: r.key, ts: r.ts, row: r.row });
    for (let replay = 0; replay < replays; replay += 1) {
      if (await apply({ ...local, sourceLogKeyHex })) applied += 1;
    }
  }
  await source.sql`DELETE FROM harness_shared.substrate_outbox`;
  return applied;
}

async function drainAtoB(sourceLogKeyHex = PEER_A_LOG, replays = 1): Promise<number> {
  return drainPeerToPeer(dbA, dbB, applyB, sourceLogKeyHex, replays);
}

async function drainBtoA(sourceLogKeyHex = PEER_B_LOG, replays = 1): Promise<number> {
  return drainPeerToPeer(dbB, dbA, applyA, sourceLogKeyHex, replays);
}

beforeAll(async () => {
  dbA = await createFreshPgDb('cross_plan_fed_a');
  dbB = await createFreshPgDb('cross_plan_fed_b');
  await setupPeerSchema(dbA.sql);
  await setupPeerSchema(dbB.sql);
  h.sql = dbB.sql; // the registry's projections write to peer B
  applyA = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, ownLogKeyHex: PEER_A_LOG });
  applyB = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, ownLogKeyHex: PEER_B_LOG });
}, 90_000);

afterAll(async () => {
  await dbA?.cleanup();
  await dbB?.cleanup();
});

beforeEach(async () => {
  // Clear the CONTENT tables first, then substrate_outbox LAST — deleting a
  // harness-scoped row fires the AFTER-DELETE capture trigger (it re-enqueues a
  // del into substrate_outbox), so draining the outbox last drops those cleanup
  // del-rows and each test starts from a truly empty outbox on both peers.
  for (const db of [dbA, dbB]) {
    await db.sql`DELETE FROM harness_shared.coord_conversations`;
    await db.sql`DELETE FROM harness_shared.plan_item_assignments`;
    await db.sql`DELETE FROM harness_shared.coord_event_log`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  }
});

describe('cross-plan two-peer federation seam — content round-trip via the real scoped apply', () => {
  it('a conversation written on A converges on B with DERIVED origin=remote', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state)
      VALUES (${WS}, 'conv-1', 'question', 'harness', ${HARNESS}, 'su-A', 'cross-machine Q', 'asked on A', 'open')`;
    expect(await drainAtoB()).toBe(1);

    const [onB] = await dbB.sql<{ title: string; state: string; origin: string; author_pubkey: string; harness_slug: string }[]>`
      SELECT title, state, origin, author_pubkey, harness_slug
        FROM harness_shared.coord_conversations WHERE workspace_id = ${WS} AND id = 'conv-1'`;
    expect(onB.title).toBe('cross-machine Q');
    expect(onB.state).toBe('open');
    expect(onB.harness_slug).toBe(HARNESS);
    // origin was DERIVED by applyOpVia (A's log key != B's own log key), not passed in.
    expect(onB.origin).toBe('remote');
    // a remote op is attributed by the immutable source-log key (P-002/D-004).
    expect(onB.author_pubkey).toBe(PEER_A_LOG);
  });

  it('an UPDATE then a DELETE on A converge on B', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, state)
      VALUES (${WS}, 'conv-2', 'question', 'harness', ${HARNESS}, 'su-A', 'q', 'open')`;
    await drainAtoB();

    await dbA.sql`UPDATE harness_shared.coord_conversations
      SET state='resolved', accepted_answer='answered on A', resolved_at=now()
      WHERE workspace_id=${WS} AND id='conv-2'`;
    await drainAtoB();
    const [updated] = await dbB.sql<{ state: string; accepted_answer: string | null }[]>`
      SELECT state, accepted_answer FROM harness_shared.coord_conversations WHERE id='conv-2'`;
    expect(updated.state).toBe('resolved');
    expect(updated.accepted_answer).toBe('answered on A');

    await dbA.sql`DELETE FROM harness_shared.coord_conversations WHERE workspace_id=${WS} AND id='conv-2'`;
    await drainAtoB();
    expect(await dbB.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE id='conv-2'`).toHaveLength(0);
  });

  it('a plan-item ASSIGNMENT written on A converges on B (the second federated surface)', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.plan_item_assignments
        (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user)
      VALUES (${WS}, ${HARNESS}, 'my-plan', 'P-005', 'builder-1', 'userA')`;
    expect(await drainAtoB()).toBe(1);

    const [onB] = await dbB.sql<{ assignee_name: string; assigned_by_user: string; origin: string }[]>`
      SELECT assignee_name, assigned_by_user, origin
        FROM harness_shared.plan_item_assignments
       WHERE workspace_id=${WS} AND harness_slug=${HARNESS} AND plan_slug='my-plan' AND item_id='P-005'`;
    expect(onB.assignee_name).toBe('builder-1');
    expect(onB.assigned_by_user).toBe('userA');
    expect(onB.origin).toBe('remote');
  });

  it('CROSS-SURFACE MULTIPLEXING: a conversation op + an assignment op route through ONE registry to the right tables', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, state)
      VALUES (${WS}, 'conv-mux', 'discussion', 'harness', ${HARNESS}, 'su-A', 'multi', 'open')`;
    await dbA.sql`
      INSERT INTO harness_shared.plan_item_assignments
        (workspace_id, harness_slug, plan_slug, item_id, assignee_name)
      VALUES (${WS}, ${HARNESS}, 'mux-plan', 'P-009', 'builder-2')`;

    // Both ops drain through the SAME applyB registry; each must hit its own projection.
    expect(await drainAtoB()).toBe(2);

    const conv = await dbB.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE id='conv-mux'`;
    const asg = await dbB.sql`SELECT 1 FROM harness_shared.plan_item_assignments WHERE plan_slug='mux-plan' AND item_id='P-009'`;
    expect(conv).toHaveLength(1);
    expect(asg).toHaveLength(1);
  });
});

describe('cross-plan federation seam — origin derivation + isolation contracts', () => {
  it('ORIGIN derivation: a self-origin op (sourceLogKeyHex == ownLogKeyHex) on a CDC table is SKIPPED (EI-117 echo breaker)', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, state)
      VALUES (${WS}, 'conv-self', 'question', 'harness', ${HARNESS}, 'su-A', 'echo', 'open')`;
    // Drain stamped with B's OWN log key → the apply path classifies it as an
    // own-log op. coord_conversations is CDC-captured (mig 144), so an own-log
    // op is by construction a REPLAY of a row B's PG already authored —
    // re-applying it as origin='local' is exactly the capture-echo vector
    // behind EI-117. The contract is now: skipped entirely (skipOwnOps); the
    // own-source → origin='local' derivation itself stays covered at unit
    // level (projection.test.ts) and on log-first projections.
    const applied = await drainAtoB(PEER_B_LOG);
    expect(applied).toBe(0);
    const rows = await dbB.sql`
      SELECT 1 FROM harness_shared.coord_conversations WHERE id='conv-self'`;
    expect(rows).toHaveLength(0);
  });

  it("ISOLATION (a): an operator-scope conversation never enters A's outbox — it does not federate", async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body)
      VALUES (${WS}, 'conv-op', 'discussion', 'operator', NULL, 'su-A', 'operator scope')`;
    const [{ n }] = await dbA.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(0);
    // Nothing to drain → peer B never receives it.
    expect(await drainAtoB()).toBe(0);
    expect(await dbB.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE id='conv-op'`).toHaveLength(0);
  });

  it("ISOLATION (b): a row for ANOTHER harness is DROPPED by B's per-harness projection binding", async () => {
    // A captures a harness-scoped conv for a DIFFERENT harness ('other').
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, state)
      VALUES (${WS}, 'conv-other', 'question', 'harness', 'other', 'su-A', 'not for B', 'open')`;
    // The op reshapes + decodes fine, but B's projection is bound to HARNESS='fed',
    // so writeToPg's `row.harness_slug !== opts.harnessSlug` guard drops it.
    await drainAtoB();
    expect(await dbB.sql`SELECT 1 FROM harness_shared.coord_conversations WHERE id='conv-other'`).toHaveLength(0);
  });

  it('ISOLATION (c) — ECHO-GUARD: a remote-applied row does NOT re-enqueue on B (the round-trip reaches a fixed point)', async () => {
    await dbA.sql`
      INSERT INTO harness_shared.coord_conversations
        (workspace_id, id, kind, scope, harness_slug, asker_id, body, state)
      VALUES (${WS}, 'conv-echo', 'question', 'harness', ${HARNESS}, 'su-A', 'echo test', 'open')`;
    await drainAtoB(); // applies on B with origin='remote'

    // B wrote the row origin='remote' → B's OWN mig-144 capture trigger must NOT
    // enqueue it (else B would re-broadcast A's content to every other peer → storm).
    const [{ n }] = await dbB.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(0);
  });

  it('an op for an UNREGISTERED table is dropped (applyOpVia returns false)', async () => {
    const stray: OpEnvelope = {
      type: 'put', table: 'no-such-projection', hbKey: 'k', value: { any: 1 },
      ts: 1_700_000_000_000, schema_version: 1, sourceLogKeyHex: PEER_A_LOG,
    };
    expect(await applyB(stray)).toBe(false);
  });
});

describe("the brief's marquee SUBSCRIBE→INJECT seam — a coord message round-trips A→B and surfaces in B's real coord:inbox", () => {
  // Point the coord:inbox read seam (PgCoordLog over getSql) at peer B, scoped to
  // the federated workspace, so the REAL readInbox reads peer B's coord_event_log.
  // resetCoordLog() in afterEach restores the default getOrgPg-backed log.
  const pointInboxAtPeerB = () =>
    configureCoordLog(new PgCoordLog({ getSql: () => dbB.sql, ensureSchema: async () => {}, workspaceId: WS }));
  const pointInboxAtPeerA = () =>
    configureCoordLog(new PgCoordLog({ getSql: () => dbA.sql, ensureSchema: async () => {}, workspaceId: WS }));
  afterEach(() => resetCoordLog());

  /** Drive the REAL production send seam against peer A. `sendMessage` builds
   *  the envelope and appends it through PgCoordLog; surface='messages' + a
   *  harness_slug then makes mig-150's capture trigger enqueue it to
   *  substrate_outbox, so it federates. `to[]` is the addressing the inbox
   *  filters on. This deliberately does not hand-build the row that the seam is
   *  meant to prove. */
  async function sendOnA(msgId: string, to: string[], summary: string) {
    configureCoordLog(new PgCoordLog({ getSql: () => dbA.sql, ensureSchema: async () => {}, workspaceId: WS }));
    const sent = await sendMessage(SENDER_A, { msgId, to, summary, harnessSlug: HARNESS });
    expect(sent).toMatchObject({ msg_id: msgId, from: 'su-A', to, summary, harness_slug: HARNESS });
    return sent;
  }

  it('both peers refuse a missing disclosure ledger before any message or outbox write, then federate after restoration', async () => {
    for (const { source, destination, sender, recipient, apply, logKey } of [
      { source: dbA, destination: dbB, sender: SENDER_A, recipient: 'su-B', apply: applyB, logKey: PEER_A_LOG },
      { source: dbB, destination: dbA, sender: SENDER_B, recipient: 'su-A', apply: applyA, logKey: PEER_B_LOG },
    ]) {
      const msgId = `ledger-control-${sender.ownerId}`;
      configureCoordLog(new PgCoordLog({ getSql: () => source.sql, ensureSchema: async () => {}, workspaceId: WS }));
      await source.sql`DROP TABLE harness_shared.personal_disclosures`;
      try {
        await expect(sendMessage(sender, {
          msgId, to: [recipient], summary: 'ledger restoration control', harnessSlug: HARNESS,
        })).rejects.toMatchObject({ code: 'disclosure_ledger_unavailable' });
        expect(await source.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE msg_id = ${msgId}`).toHaveLength(0);
        expect(await source.sql`SELECT 1 FROM harness_shared.substrate_outbox`).toHaveLength(0);
        expect(await destination.sql`SELECT 1 FROM harness_shared.coord_event_log WHERE msg_id = ${msgId}`).toHaveLength(0);
      } finally {
        await applyDisclosureLedgerForTest(source.sql);
      }

      await sendMessage(sender, {
        msgId, to: [recipient], summary: 'ledger restoration control', harnessSlug: HARNESS,
      });
      expect(await drainPeerToPeer(source, destination, apply, logKey)).toBe(1);
      configureCoordLog(new PgCoordLog({ getSql: () => destination.sql, ensureSchema: async () => {}, workspaceId: WS }));
      expect((await readInbox(recipient)).find((entry) => entry.msg_id === msgId)).toMatchObject({
        from: sender.ownerId, to: [recipient], summary: 'ledger restoration control',
      });
      expect(await destination.sql`SELECT 1 FROM harness_shared.substrate_outbox`).toHaveLength(0);
    }
  });

  it("an ADDRESSED message on A lands in B's coord_event_log AND surfaces via the real readInbox — a non-addressed peer's inbox does NOT", async () => {
    await sendOnA('fed-msg-1', ['su-B'], 'cross-machine hello');
    expect(await drainAtoB()).toBe(1);

    // (1) the federated row converged on B with origin DERIVED = remote.
    const [onB] = await dbB.sql<{ surface: string; origin: string; harness_slug: string }[]>`
      SELECT surface, origin, harness_slug FROM harness_shared.coord_event_log WHERE msg_id = 'fed-msg-1'`;
    expect(onB.surface).toBe('messages');
    expect(onB.origin).toBe('remote');
    expect(onB.harness_slug).toBe(HARNESS);

    // (2) INJECT — the recipient's REAL coord:inbox read finds it by the envelope to[].
    pointInboxAtPeerB();
    const recipientInbox = await readInbox('su-B');
    const got = recipientInbox.find((e) => e.msg_id === 'fed-msg-1');
    expect(got).toBeTruthy();
    expect(got?.summary).toBe('cross-machine hello');
    expect(got?.from).toBe('su-A');

    // (3) ISOLATION — a peer NOT in to[] does not receive it ("a non-subscribed peer does NOT").
    const otherInbox = await readInbox('su-C');
    expect(otherInbox.find((e) => e.msg_id === 'fed-msg-1')).toBeFalsy();
  });

  it("a BROADCAST (to:['*']) message reaches EVERY recipient's inbox on B after one federation", async () => {
    const sent = await sendOnA('fed-bcast', ['*'], 'all hands');
    expect(sent.audience).toEqual(['*']);
    expect(await drainAtoB()).toBe(1);

    pointInboxAtPeerB();
    for (const who of ['su-B', 'su-C']) {
      const inbox = await readInbox(who);
      expect(inbox.find((e) => e.msg_id === 'fed-bcast')).toMatchObject({ audience: ['*'] });
    }
  });

  it('a related structured report returns B→A, duplicate delivery stays singular, thread order survives, and the ack returns A→B', async () => {
    // This composes the seams the predecessor incident crossed. The narrower
    // suites prove report normalization, reply wake, projection upsert, thread
    // folding, and ack lookup separately; this test proves their shared wire
    // envelope survives BOTH federation directions through production
    // sendMessage/PgCoordLog/outbox/apply/read seams.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-08-26T20:00:00.000Z'));
      const original = await sendOnA('fed-thread-1-original', ['su-B'], 'return the coordination audit');
      expect(await drainAtoB()).toBe(1);

      vi.setSystemTime(new Date('2026-08-26T20:00:00.100Z'));
      pointInboxAtPeerB();
      const report = {
        title: 'Coordination audit',
        plans: [
          {
            slug: 'p2p-coordination-public-release-2026-08-26',
            status: 'done',
            items: [{ id: 'P-002', text: 'transport audit', status: 'done' }],
          },
        ],
      };
      const reply = await sendMessage(SENDER_B, {
        msgId: 'fed-thread-2-report',
        to: ['su-A'],
        summary: 'coordination audit complete',
        related_msg_id: original.msg_id,
        harnessSlug: HARNESS,
        extra: { report },
      });

      // Replay the immutable remote op: msg_id is the federation key, so the
      // receiver must retain exactly one report row rather than append a dup.
      await drainBtoA(PEER_B_LOG, 2);
      const [{ n: reportRows }] = await dbA.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.coord_event_log WHERE msg_id = ${reply.msg_id}`;
      expect(reportRows).toBe(1);

      pointInboxAtPeerA();
      const delivered = (await readInbox('su-A')).find((e) => e.msg_id === reply.msg_id);
      expect(delivered).toMatchObject({
        from: 'su-B',
        to: ['su-A'],
        related_msg_id: original.msg_id,
        report,
        harness_slug: HARNESS,
      });

      vi.setSystemTime(new Date('2026-08-26T20:00:00.200Z'));
      const ack = await appendAck(SENDER_A, reply.msg_id, SENDER_B.ownerId, HARNESS);
      expect(ack).toMatchObject({ kind: 'ack', related_msg_id: reply.msg_id, harness_slug: HARNESS });
      expect(await drainAtoB()).toBe(1);

      pointInboxAtPeerB();
      const thread = await readThread(original.msg_id);
      expect(thread.map((entry) => entry.msg_id)).toEqual([original.msg_id, reply.msg_id, ack.msg_id]);
      expect(await readAckedMsgIds(SENDER_A.ownerId)).toEqual(new Set([reply.msg_id]));
      expect((await readInbox('su-B')).find((e) => e.msg_id === ack.msg_id)).toMatchObject({
        from: 'su-A',
        kind: 'ack',
        related_msg_id: reply.msg_id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ISOLATION: an operator-scope message (harness_slug NULL) never enters A\'s outbox — coordination with no swarm stays LOCAL (D-007)', async () => {
    const env = {
      ts: '2026-06-05T00:00:00.000Z', msg_id: 'op-msg', from: 'su-A', to: ['su-B'],
      kind: 'message', summary: 'operator scope',
    };
    await dbA.sql`
      INSERT INTO harness_shared.coord_event_log
        (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
      VALUES (${WS}, 'messages', 'su-A', 'op-msg', ${JSON.stringify(env)}::text::jsonb, NULL, 'local')`;

    const [{ n }] = await dbA.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(0); // the mig-150 WHEN clause short-circuits on harness_slug IS NULL
    expect(await drainAtoB()).toBe(0);

    pointInboxAtPeerB();
    expect((await readInbox('su-B')).find((e) => e.msg_id === 'op-msg')).toBeFalsy();
  });

  it('ECHO-GUARD: the remote message applied on B does NOT re-enqueue on B (the round-trip reaches a fixed point)', async () => {
    await sendOnA('fed-echo', ['su-B'], 'echo check');
    await drainAtoB(); // applies on B with origin='remote'

    // B wrote the row origin='remote' → mig-150's capture trigger (WHEN origin='local')
    // must NOT enqueue it, else B would re-broadcast A's message to every other peer.
    const [{ n }] = await dbB.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(0);
  });
});
