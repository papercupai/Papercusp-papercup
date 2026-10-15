/**
 * adjacency-cross-feed-io.integration.test.ts — the P-013 adjacency cross-feed
 * LIVE LEG against a real Postgres (ambient-semantic-push-2026-07-14). Replays
 * the ACTUAL migrations for every table the leg touches — coord_topics +
 * coord_entity_subscriptions (123, the SAME rows topics:subscribe writes),
 * session_cursor (609), push_delivery (610), collision_hysteresis (612, the
 * upstream tick whose snapshot is shared), adjacency_state (614) — and drives
 * the REAL paths end-to-end.
 *
 * What the mocked unit suite can't prove and this does:
 *   • the COMPUTE-ONCE handoff: boundedCollisionTick's returned snapshot +
 *     owner map feed boundedAdjacencyTick — one peer read, both matchers;
 *   • a sustained in-band overlap creates a REAL 'adj:…' coord_topics row +
 *     a digest subscription row for self's owner + the typed entered notice
 *     on the delivery rail + the carried adjacency_state row;
 *   • an ON-TOPIC journal note lands as a real cross-feed push row targeted at
 *     the PEER's owner (`[adj:…] su-…:` teaser);
 *   • ESCALATION: the pair converging to duplicate territory cancels the real
 *     subscription (cancelled_at) and notices the exit — the P-004 handover.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';
import type { AdjacencyParams } from './adjacency-cross-feed';


const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { upsertSessionCursor } = await import('./session-cursor-store');
const { buildCursor } = await import('./lexical-cursor');
const { boundedCollisionTick } = await import('./collision-matcher-io');
const { boundedAdjacencyTick } = await import('./adjacency-cross-feed-io');

let db: FreshPgDb;

const SELF = 'su-adj-self';
const SELF_OWNER = 'own-adj-self';
const PEER = 'su-adj-peer';
const PEER_OWNER = 'own-adj-peer';

const SELF_NOTE = 'debugging psu-launcher.mjs restart loop — WI-4790 advisory lock leak';
const PEER_NOTE = 'drafting the psu-launcher.mjs WI-4790 rollout playbook and recovery docs';

/** A wide band + fast dwell so the edges fire without cosine fine-tuning: any
 *  partial overlap is in-band, only a near-duplicate (identical notes ⇒ ~1.0)
 *  escalates. Staleness pushed out of the way. */
const FAST: AdjacencyParams = {
  enterThreshold: 0.05,
  duplicateThreshold: 0.95,
  enterDwell: 2,
  exitThreshold: 0.01,
  exitDwell: 10,
  stalenessTicks: 50,
  maxTrackedPeers: 16,
};

async function seedCursor(sessionId: string, ownerId: string, note: string) {
  const cursor = buildCursor([note], { sessionId });
  await upsertSessionCursor({
    workspaceId: 'default',
    sessionId,
    ownerId,
    harnessSlug: null,
    turnTs: null,
    cursor,
  });
}

/** One combined turn-end tick: the collision tick computes the snapshot ONCE,
 *  the adjacency tick rides it (the exact record-turn.ts wiring). */
async function combinedTick(journalNote?: string) {
  const collision = await boundedCollisionTick({ selfSessionId: SELF, selfOwnerId: SELF_OWNER });
  expect(collision.ran).toBe(true);
  expect(collision.snapshot).toBeDefined();
  return boundedAdjacencyTick({
    selfSessionId: SELF,
    selfOwnerId: SELF_OWNER,
    snapshot: collision.snapshot!,
    ownerBySession: collision.ownerBySession,
    journalNote: journalNote ?? null,
    params: FAST,
  });
}

async function subscriptionRows() {
  return db.sql<{ target_ref: string; delivery_mode: string; cancelled_at: string | null }[]>`
    SELECT target_ref, delivery_mode, cancelled_at
      FROM harness_shared.coord_entity_subscriptions
     WHERE subscriber_id = ${SELF_OWNER} AND target_kind = 'topic'
     ORDER BY id`;
}

async function topicSubPushes(targetOwnerId: string) {
  return db.sql<{ teaser: string; handle_ref: string; severity: string }[]>`
    SELECT teaser, handle_ref, severity
      FROM harness_shared.push_delivery
     WHERE target_owner_id = ${targetOwnerId} AND matcher_kind = 'topic-sub'
     ORDER BY id`;
}

beforeAll(async () => {
  db = await createFreshPgDb('adjacency-feed');
  // The replayed migrations GRANT to these roles; create them idempotently.
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // Stub the capture fn BEFORE 149 creates its triggers on it (the real body drags
  // the whole outbox chain in; irrelevant here). Safe as a no-op returning NULL
  // because every trigger 149 attaches is AFTER — an AFTER trigger's return value
  // is ignored, so this cannot swallow a row. Same precedent as
  // dead-end-matcher-io.integration.test.ts.
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  `);
  // EI-18808675015292160: applyMigrationsForTest AUDITS this list before applying
  // it, so a migration landing on one of these tables without being listed fails
  // naming the FILE, not a bare `column "..." does not exist`.
  await applyMigrationsForTest(
    db.sql,
    [
      '123-coordination-substrate.sql',
      '149-coord-threads-federation.sql', // must follow 123, which creates coord_threads/_posts
      '602-work-item-follow-blockers.sql', // adds follow_blockers/derived_from_* the sub store writes
      '609-session-cursor.sql',
      '610-push-delivery.sql',
      '612-collision-hysteresis.sql',
      '614-adjacency-state.sql',
      '1257-coord-entity-subscriptions-allow-muted.sql',
    ],
    { label: 'adjacency-cross-feed-io.integration.test.ts' },
  );
  h.sql = db.sql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('the adjacency lifecycle over real rows (P-013)', () => {
  it('enter → shared topic + digest subscription + notice → on-topic cross-feed → escalated exit cancels', async () => {
    await seedCursor(SELF, SELF_OWNER, SELF_NOTE);
    await seedCursor(PEER, PEER_OWNER, PEER_NOTE);

    // Tick 1: in-band overlap builds the streak — no edge yet.
    const t1 = await combinedTick();
    expect(t1).toMatchObject({ ran: true, tick: 1, entered: 0 });
    expect(await subscriptionRows()).toHaveLength(0);

    // Tick 2: the enter edge — real topic row, real subscription, real notice.
    const t2 = await combinedTick();
    expect(t2).toMatchObject({ tick: 2, entered: 1, subscribed: 1 });

    const subs = await subscriptionRows();
    expect(subs).toHaveLength(1);
    const slug = subs[0]!.target_ref;
    expect(slug).toMatch(/^adj:/);
    expect(subs[0]).toMatchObject({ delivery_mode: 'digest', cancelled_at: null });

    const [topicRow] = await db.sql<{ slug: string; title: string | null }[]>`
      SELECT slug, title FROM harness_shared.coord_topics WHERE slug = ${slug}`;
    expect(topicRow).toBeDefined();
    expect(topicRow!.title).toContain('adjacent lanes');

    const selfNotices = await topicSubPushes(SELF_OWNER);
    expect(selfNotices).toHaveLength(1);
    expect(selfNotices[0]).toMatchObject({ handle_ref: slug, severity: 'info' });
    expect(selfNotices[0]!.teaser).toContain('adjacency: entered');

    const [stateRow] = await db.sql<{ tick: number; topics: Record<string, { topic: string }> }[]>`
      SELECT tick, topics FROM harness_shared.adjacency_state WHERE session_id = ${SELF}`;
    expect(Number(stateRow!.tick)).toBe(2);
    expect(stateRow!.topics[PEER]?.topic).toBe(slug);

    // Tick 3: this turn's ON-TOPIC journal note cross-feeds to the PEER's owner.
    const t3 = await combinedTick('progress: WI-4790 psu-launcher.mjs restart loop isolated to the advisory lock');
    expect(t3).toMatchObject({ tick: 3, crossFed: 1 });
    const peerFeed = await topicSubPushes(PEER_OWNER);
    expect(peerFeed).toHaveLength(1);
    expect(peerFeed[0]).toMatchObject({ handle_ref: slug, severity: 'info' });
    expect(peerFeed[0]!.teaser).toContain(`[${slug}] ${SELF}:`);
    expect(peerFeed[0]!.teaser).toContain('WI-4790');

    // ESCALATION: the peer converges to (near-)duplicate — the adjacency exits
    // ('escalated-to-collision', P-004's territory) and cancels the real row.
    await seedCursor(PEER, PEER_OWNER, SELF_NOTE);
    const t4 = await combinedTick();
    expect(t4).toMatchObject({ tick: 4, exited: 1, unsubscribed: 1 });

    const subsAfter = await subscriptionRows();
    expect(subsAfter).toHaveLength(1);
    expect(subsAfter[0]!.cancelled_at).not.toBeNull();

    const noticesAfter = await topicSubPushes(SELF_OWNER);
    expect(noticesAfter).toHaveLength(2);
    expect(noticesAfter[1]!.teaser).toContain('adjacency: exited');
    expect(noticesAfter[1]!.teaser).toContain('escalated-to-collision');

    // The carried topics map dropped the peer.
    const [stateAfter] = await db.sql<{ topics: Record<string, unknown> }[]>`
      SELECT topics FROM harness_shared.adjacency_state WHERE session_id = ${SELF}`;
    expect(stateAfter!.topics[PEER]).toBeUndefined();
  }, 30_000);
});
