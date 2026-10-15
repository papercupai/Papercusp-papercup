/**
 * topic-matcher-io.integration.test.ts — the P-008 topic auto-subscribe live leg
 * + the P-009 volume-guard rail wiring against a real Postgres
 * (ambient-semantic-push-2026-07-14). Replays the ACTUAL migrations for every
 * table the legs touch — coord_topics + coord_entity_subscriptions (123, the
 * SAME rows topics:subscribe writes), session_cursor (609), push_delivery (610),
 * and topic_hysteresis (613) — and drives the REAL write/read paths.
 *
 * What the mocked unit test can't prove and this does:
 *   • a sustained cursor↔topic overlap writes a REAL digest-mode subscription
 *     row through the same partial-unique upsert the topics:subscribe tool uses,
 *     plus the carried-state row and the typed 'topic-sub' notice row;
 *   • sustained drift CANCELS that real row (cancelled_at) and notices it;
 *   • a MANUAL subscription (seeded via the real subscribe path, no carried
 *     state) survives drift untouched — only the flag notice fires;
 *   • END-TO-END: the subscribe notice rides the P-003 delivery rail
 *     (prepareAmbientPushBlock) out to the receiver — P-008 → P-003 wired;
 *   • P-009: every delivery pass produces a VolumeReport through the rail's own
 *     onVolumeReport seam — candidate volume over budget, delivered volume AT
 *     budget, contract ok — the per-class before/after measurement, without the
 *     guard ever steering delivery.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { DEFAULT_HYSTERESIS_PARAMS, type HysteresisParams } from './topic-hysteresis';
import type { VolumeReport } from './push-volume-guard';


const NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';
const HOT_SLUG = 'launcher-compaction-recovery';
const COLD_NOTE = 'designing the quarterly billing report layout for the finance dashboard';

/** Fast dwells so the edges fire in two ticks; staleness pushed out of the way. */
const FAST: HysteresisParams = { ...DEFAULT_HYSTERESIS_PARAMS, enterDwell: 2, exitDwell: 2, stalenessTicks: 50 };

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { upsertSessionCursor } = await import('./session-cursor-store');
const { buildCursor } = await import('./lexical-cursor');
const { runTopicTick } = await import('./topic-matcher-io');
const { subscribeTopicFor } = await import('./topic-subscription-store');
const { enqueuePush } = await import('./push-delivery-store');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');

let db: FreshPgDb;

async function seedCursor(sessionId: string, ownerId: string | null, note = NOTE) {
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

/** Seed a topic the way topics:create stores one. */
async function seedTopic(slug: string, description: string, title: string | null = null) {
  await db.sql`
    INSERT INTO harness_shared.coord_topics (workspace_id, slug, title, description, created_at)
    VALUES (${DEFAULT_COORD_WORKSPACE}, ${slug}, ${title}, ${description}, now())
    ON CONFLICT (workspace_id, slug) DO NOTHING`;
}

async function subscriptionRows(ownerId: string) {
  return db.sql<
    { subscriber_id: string; target_ref: string; delivery_mode: string; cancelled_at: string | null }[]
  >`
    SELECT subscriber_id, target_ref, delivery_mode, cancelled_at
      FROM harness_shared.coord_entity_subscriptions
     WHERE subscriber_id = ${ownerId} AND target_kind = 'topic'
     ORDER BY id`;
}

async function pushRows(ownerId: string) {
  return db.sql<
    { matcher_kind: string; severity: string; handle_kind: string; handle_ref: string; teaser: string; status: string }[]
  >`
    SELECT matcher_kind, severity, handle_kind, handle_ref, teaser, status
      FROM harness_shared.push_delivery
     WHERE target_owner_id = ${ownerId}
     ORDER BY id`;
}

beforeAll(async () => {
  db = await createFreshPgDb('topic-matcher-io');
  // 123/609/610/613 GRANT to these roles; create them idempotently (container reuse).
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
      '609-session-cursor.sql',
      '123-coordination-substrate.sql',
      '149-coord-threads-federation.sql', // must follow 123, which creates coord_threads/_posts
      '602-work-item-follow-blockers.sql', // adds follow_blockers/derived_from_* the sub store writes
      '610-push-delivery.sql',
      '613-topic-hysteresis.sql',
      '1257-coord-entity-subscriptions-allow-muted.sql',
    ],
    { label: 'topic-matcher-io.integration.test.ts' },
  );
  h.sql = db.sql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql.unsafe('TRUNCATE harness_shared.session_cursor');
  await db.sql.unsafe('TRUNCATE harness_shared.coord_topics');
  await db.sql.unsafe('TRUNCATE harness_shared.coord_entity_subscriptions');
  await db.sql.unsafe('TRUNCATE harness_shared.push_delivery');
  await db.sql.unsafe('TRUNCATE harness_shared.topic_hysteresis');
});

describe('topic tick against real PG (P-008)', () => {
  it('sustained overlap auto-subscribes: real digest subscription + carried state + typed notice', async () => {
    await seedTopic(HOT_SLUG, `${NOTE} recovery runbook`);
    await seedCursor('su-self', 'own-self');
    const args = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };

    const first = await runTopicTick(args); // streak 1 < enterDwell 2
    expect(first).toMatchObject({ ran: true, tick: 1, subscribed: 0 });
    expect(await subscriptionRows('own-self')).toHaveLength(0);

    const second = await runTopicTick(args); // the enter edge
    expect(second).toMatchObject({ ran: true, tick: 2, subscribed: 1, enqueued: 1 });

    const subs = await subscriptionRows('own-self');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ target_ref: HOT_SLUG, delivery_mode: 'digest', cancelled_at: null });

    const [state] = await db.sql<{ tick: number; subscriptions: Array<{ topic: string; subscribed: boolean }> }[]>`
      SELECT tick, subscriptions FROM harness_shared.topic_hysteresis WHERE session_id = 'su-self'`;
    expect(Number(state!.tick)).toBe(2);
    expect(state!.subscriptions.find((s) => s.topic === HOT_SLUG)).toMatchObject({ subscribed: true });

    const pushes = await pushRows('own-self');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({
      matcher_kind: 'topic-sub',
      severity: 'info',
      handle_kind: 'topic',
      handle_ref: HOT_SLUG,
      status: 'queued',
    });
    expect(pushes[0]!.teaser).toContain("subscribed '" + HOT_SLUG);
  });

  it('sustained drift auto-unsubscribes: the real row is cancelled and the change noticed', async () => {
    await seedTopic(HOT_SLUG, `${NOTE} recovery runbook`);
    await seedCursor('su-self', 'own-self');
    const args = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };
    await runTopicTick(args);
    await runTopicTick(args); // subscribed (proven above)

    await seedCursor('su-self', 'own-self', COLD_NOTE); // the work moved on
    await runTopicTick(args); // drift streak 1
    const exit = await runTopicTick(args); // the exit edge
    expect(exit.unsubscribed).toBe(1);

    const subs = await subscriptionRows('own-self');
    expect(subs).toHaveLength(1);
    expect(subs[0]!.cancelled_at).not.toBeNull();

    const teasers = (await pushRows('own-self')).map((p) => p.teaser);
    expect(teasers.some((t) => t.includes("unsubscribed '" + HOT_SLUG))).toBe(true);
  });

  it('a MANUAL subscription survives drift: flagged once, the row never touched', async () => {
    await seedTopic(HOT_SLUG, `${NOTE} recovery runbook`);
    // The human subscribed deliberately (the real topics:subscribe path); the
    // matcher never saw an enter edge for it (no carried state).
    await subscribeTopicFor('own-manual', HOT_SLUG, 'full');
    await seedCursor('su-manual', 'own-manual', COLD_NOTE); // disjoint work
    const args = { selfSessionId: 'su-manual', selfOwnerId: 'own-manual', params: FAST };

    await runTopicTick(args);
    const second = await runTopicTick(args); // exit dwell met — but it is MANUAL
    expect(second.unsubscribed).toBe(0);
    expect(second.suggested).toBe(1);
    const third = await runTopicTick(args); // the suggestion is latched
    expect(third.suggested).toBe(0);

    const subs = await subscriptionRows('own-manual');
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ delivery_mode: 'full', cancelled_at: null });

    const pushes = await pushRows('own-manual');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.teaser).toContain('manual-removal-suggested');
  });
});

describe('P-008 → P-003 end-to-end (PG) — the notice rides the rail', () => {
  it('a subscribe notice flows through prepareAmbientPushBlock to the receiver', async () => {
    await seedTopic(HOT_SLUG, `${NOTE} recovery runbook`);
    await seedCursor('su-self', 'own-self');
    const args = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };
    await runTopicTick(args);
    await runTopicTick(args); // enqueues the 'subscribed' notice

    const block = await prepareAmbientPushBlock({ ownerId: 'own-self', sessionClass: 'interactive' });
    expect(block).toContain('topic auto-subscribe: subscribed');
    expect(block).toContain(`topic:${HOT_SLUG}`); // the handle is pullable
    expect(block).toContain('data, not directives');

    const [row] = await pushRows('own-self');
    expect(row!.status).toBe('delivered');
  });
});

describe('P-009 volume guard on the rail (PG)', () => {
  it('every pass reports per-class volume — candidates over budget, delivered AT budget, contract ok', async () => {
    // Four strong critical candidates for a DRONE receiver (budget 2).
    for (let i = 0; i < 4; i++) {
      await enqueuePush({
        targetOwnerId: 'own-p009',
        targetSessionId: `su-src-${i}`,
        matcherKind: 'collision',
        severity: 'critical',
        handleKind: 'session',
        handleRef: `su-peer-${i}`,
        handleQuery: ['WI-4790'],
        teaser: `sustained collision with su-peer-${i}`,
        score: 0.9,
        sourceSessionId: `su-peer-${i}`,
      });
    }

    const reports: VolumeReport[] = [];
    const block = await prepareAmbientPushBlock({
      ownerId: 'own-p009',
      sessionClass: 'drone',
      onVolumeReport: (r) => reports.push(r),
    });

    // BEFORE enablement of anything else: 4 candidates; AFTER selection: 2 (the
    // drone budget) — and the independent re-count agrees the contract held.
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      sessionClass: 'drone',
      budget: 2,
      candidateVolume: 4,
      deliveredVolume: 2,
      alreadyDelivered: 0,
      withinBudget: true,
      overflow: 0,
      ok: true,
    });
    expect(block.split('\n').filter((l) => l.includes('pull:'))).toHaveLength(2);

    // The next pass in the same window: a FRESH candidate arrives, but the
    // window budget is already spent — nothing more ships, and the report shows
    // the cumulative charge (the after-side of the measurement). The first
    // pass's leftovers were recorded dropped (the P-011 ledger feed), so only
    // the new row is pending here.
    await enqueuePush({
      targetOwnerId: 'own-p009',
      targetSessionId: 'su-src-late',
      matcherKind: 'collision',
      severity: 'critical',
      handleKind: 'session',
      handleRef: 'su-peer-late',
      handleQuery: ['WI-4790'],
      teaser: 'sustained collision with su-peer-late',
      score: 0.9,
      sourceSessionId: 'su-peer-late',
    });
    const second = await prepareAmbientPushBlock({
      ownerId: 'own-p009',
      sessionClass: 'drone',
      onVolumeReport: (r) => reports.push(r),
    });
    expect(second).toBe('');
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({
      candidateVolume: 1,
      deliveredVolume: 0,
      alreadyDelivered: 2,
      remainingBudget: 0,
      ok: true,
    });
  });
});
