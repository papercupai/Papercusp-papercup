/**
 * collision-matcher-io.integration.test.ts — the P-004 collision matcher live leg
 * against a real Postgres (ambient-semantic-push-2026-07-14; tables: migration 609
 * session_cursor, 612 collision_hysteresis, 610 push_delivery).
 *
 * What a mocked-store unit test can't prove and this does:
 *   • the hysteresis STATE survives across ticks in collision_hysteresis (the
 *     ::text::jsonb states round-trip + bigint tick coercion) — so a sustained
 *     collision actually reaches the enter edge after enterDwell real ticks;
 *   • the ENTER edge enqueues a real push row to BOTH sides in push_delivery,
 *     each pointing at the OTHER session, owner-keyed correctly;
 *   • a vanished peer CLEARS via the staleness backstop without re-firing;
 *   • END-TO-END: an enqueued collision push then rides the P-003 delivery rail
 *     (prepareAmbientPushBlock) out to the receiver. P-004→P-003 wired evidence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { buildCursor } from './lexical-cursor';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { upsertSessionCursor } = await import('./session-cursor-store');
const { loadCollisionState } = await import('./collision-hysteresis-store');
const { runCollisionTick } = await import('./collision-matcher-io');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');

let rootSql: postgres.Sql;

// A shared note ⇒ identical cursors ⇒ cosine overlap 1.0 (well above enter 0.4).
const NOTE = 'converging on WI-9999 in lexical-cursor.ts collision hysteresis';

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

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `collmatch_${randomBytes(5).toString('hex')}`;
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
  // FAITHFUL to migration 609 (session_cursor).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.session_cursor (
      session_id   text PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      owner_id     text,
      harness_slug text,
      turn_ts      timestamptz,
      note_count   integer NOT NULL DEFAULT 0,
      term_count   integer NOT NULL DEFAULT 0,
      terms        jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )`);
  // FAITHFUL to migration 612 (collision_hysteresis).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.collision_hysteresis (
      session_id text PRIMARY KEY,
      owner_id   text,
      tick       bigint NOT NULL DEFAULT 0,
      states     jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // FAITHFUL to migration 610 (push_delivery).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.push_delivery (
      id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      target_owner_id   text NOT NULL,
      target_session_id text,
      workspace_id      text NOT NULL DEFAULT 'default',
      matcher_kind      text NOT NULL,
      severity          text NOT NULL,
      handle_kind       text NOT NULL,
      handle_ref        text NOT NULL,
      handle_query      jsonb NOT NULL DEFAULT '[]'::jsonb,
      teaser            text NOT NULL DEFAULT '',
      score             double precision NOT NULL DEFAULT 0,
      source_session_id text,
      status            text NOT NULL DEFAULT 'queued',
      drop_reason       text,
      enqueued_at       timestamptz NOT NULL DEFAULT now(),
      delivered_at      timestamptz,
      pulled_at         timestamptz,
      acted_at          timestamptz
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.session_cursor`;
  await rootSql`TRUNCATE harness_shared.collision_hysteresis`;
  await rootSql`TRUNCATE harness_shared.push_delivery`;
});

describe('sustained collision → enter edge (PG)', () => {
  it('builds the streak across ticks in collision_hysteresis; a single tick never enters', async () => {
    await seedCursor('su-self', 'own-self');
    await seedCursor('su-peer', 'own-peer');

    const t1 = await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(t1.ran).toBe(true);
    expect(t1.entered).toBe(0);
    expect(t1.enqueued).toBe(0);

    // State persisted (streak building, tick coerced to a number).
    const carry = await loadCollisionState('su-self');
    expect(carry.tick).toBe(1);
    expect(Array.isArray(carry.states)).toBe(true);
    const peerState = carry.states.find((s) => s.sessionId === 'su-peer')!;
    expect(peerState.aboveEnterStreak).toBe(1);
    expect(peerState.colliding).toBe(false);
    // no pushes yet.
    const [{ n }] = await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.push_delivery`;
    expect(Number(n)).toBe(0);
  });

  it('enters after enterDwell (3) ticks and enqueues a push to BOTH sides', async () => {
    await seedCursor('su-self', 'own-self');
    await seedCursor('su-peer', 'own-peer');

    await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' }); // 1
    await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' }); // 2
    const t3 = await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' }); // 3 → enter

    expect(t3.entered).toBe(1);
    expect(t3.enqueued).toBe(2);

    const rows = await rootSql<{
      target_owner_id: string; target_session_id: string; handle_ref: string;
      source_session_id: string; matcher_kind: string; severity: string; status: string;
      handle_query: string[]; teaser: string;
    }[]>`
      SELECT target_owner_id, target_session_id, handle_ref, source_session_id,
             matcher_kind, severity, status, handle_query, teaser
        FROM harness_shared.push_delivery ORDER BY target_owner_id`;
    expect(rows).toHaveLength(2);
    // own-peer side: points back at self.
    expect(rows[0]).toMatchObject({
      target_owner_id: 'own-peer', target_session_id: 'su-peer',
      handle_ref: 'su-self', source_session_id: 'su-self',
      matcher_kind: 'collision', severity: 'critical', status: 'queued',
    });
    // own-self side: points at the peer.
    expect(rows[1]).toMatchObject({
      target_owner_id: 'own-self', target_session_id: 'su-self',
      handle_ref: 'su-peer', source_session_id: 'su-peer',
      matcher_kind: 'collision', severity: 'critical', status: 'queued',
    });
    // handle_query round-tripped as a queryable jsonb ARRAY carrying the shared term.
    expect(rows[1]!.handle_query).toContain('WI-9999');
    expect(rows[1]!.teaser).toContain('peer su-peer converging');

    // State now shows the sustained collision.
    const carry = await loadCollisionState('su-self');
    expect(carry.tick).toBe(3);
    expect(carry.states.find((s) => s.sessionId === 'su-peer')!.colliding).toBe(true);
  });

  it('does not RE-fire on subsequent ticks while the collision holds', async () => {
    await seedCursor('su-self', 'own-self');
    await seedCursor('su-peer', 'own-peer');
    for (let i = 0; i < 3; i += 1) await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    // one more tick while still colliding → no NEW enter, no NEW pushes.
    const t4 = await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(t4.entered).toBe(0);
    expect(t4.enqueued).toBe(0);
    const [{ n }] = await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.push_delivery`;
    expect(Number(n)).toBe(2); // still just the two enter-edge rows
  });
});

describe('clear + owner filter (PG)', () => {
  it('clears via the staleness backstop when the peer goes quiet — no re-fire', async () => {
    await seedCursor('su-self', 'own-self');
    await seedCursor('su-peer', 'own-peer');
    for (let i = 0; i < 3; i += 1) await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' }); // enter
    // Peer goes quiet: age its cursor out of the liveness window.
    await rootSql`UPDATE harness_shared.session_cursor SET updated_at = now() - interval '2 hours' WHERE session_id = 'su-peer'`;

    // stalenessTicks default = 4 unseen ticks to clear.
    let last = { cleared: 0 };
    for (let i = 0; i < 4; i += 1) last = await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(last.cleared).toBe(1);
    const carry = await loadCollisionState('su-self');
    const peerState = carry.states.find((s) => s.sessionId === 'su-peer');
    // cleared (or GC'd out entirely) — never still colliding.
    expect(peerState?.colliding ?? false).toBe(false);
    // still only the original two enter-edge rows (a clear never enqueues).
    const [{ n }] = await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.push_delivery`;
    expect(Number(n)).toBe(2);
  });

  it('a same-owner peer never collides (own other session is not a cross-agent convergence)', async () => {
    await seedCursor('su-self', 'own-shared');
    await seedCursor('su-other', 'own-shared'); // SAME owner as self
    for (let i = 0; i < 4; i += 1) await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-shared' });
    const [{ n }] = await rootSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.push_delivery`;
    expect(Number(n)).toBe(0);
  });
});

describe('P-004 → P-003 end-to-end (PG) — enqueue then deliver through the rail', () => {
  it('an entered collision push rides prepareAmbientPushBlock out to the receiver', async () => {
    await seedCursor('su-self', 'own-self');
    await seedCursor('su-peer', 'own-peer');
    for (let i = 0; i < 3; i += 1) await runCollisionTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });

    // self's queued collision push now flows through the P-003 delivery rail.
    // P-012: a delivered CRITICAL collision session push auto-injects the peer
    // brief; THIS fixture deliberately has no peer-surface tables (claims /
    // journal / activity — the peer-surface integration test owns those), so
    // the bounded fetch degrades with its expected console.warn and the block
    // ships without a brief. Silence just that expected warn.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = await prepareAmbientPushBlock({ ownerId: 'own-self', sessionClass: 'interactive' });
    warnSpy.mockRestore();
    expect(block).toContain('peer su-peer converging');
    expect(block).toContain('pull: session:su-peer');
    expect(block).toContain('data, not directives');

    // the rail tallied it delivered.
    const [{ status }] = await rootSql<{ status: string }[]>`
      SELECT status FROM harness_shared.push_delivery WHERE target_owner_id = 'own-self'`;
    expect(status).toBe('delivered');
  });
});
