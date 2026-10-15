/**
 * work-items-derive-before-fed-stamp.integration.test.ts — WI-10003230 (mig 1227).
 *
 * `stamp_local_federated_write` decides "content changed" by comparing NEW with OLD and,
 * if so, mints a fresh local HLC + origin='local' — which the capture then ships. On
 * work_items three BEFORE-row triggers DERIVE a column from OLD/NEW (closed_ts,
 * state_changed_at, payload._completionEventIntentId). PostgreSQL fires same-timing
 * triggers in name order, and until mig 1227 all three sorted AFTER the stamp, so the
 * stamp judged the caller's un-normalized NEW and minted a clock for a write the
 * normalizer then turned into a no-op.
 *
 * Measured on the live-federation rig (2026-09-26): each remote op was applied twice;
 * the duplicate, clock-STATIONARY re-apply carried the peer's closed_ts onto a row
 * whose terminal->terminal freeze had kept a different one, so every duplicate minted a
 * local clock and shipped the (unchanged) row back — ~1 op/s on both frames, forever.
 *
 * These cases run against the REAL migration chain. Before mig 1227 the three
 * behavioural cases fail (the clock moves and an outbox op is added); the class guard
 * fails on any future table where an assigning BEFORE trigger sorts after the stamp.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { reconcileWorkItemCompletionEventIntents } from '../../../work-item-completion-event-reconciler';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const WS = 'ws-derive-before-fed-stamp';
const HARNESS = 'derive-before-fed-stamp-cell';

/** A BEFORE-row trigger function that writes NEW.<col> := ... (the detector's subject). */
const ASSIGNS_NEW = String.raw`NEW\.[a-z_]+\s*:=`;

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'derivebeforestamp',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-DERIVE-${seq}`;
}

type Clock = { fed_ts: string | null; fed_hlc: string | null; origin: string | null };

async function clockOf(id: string): Promise<Clock> {
  const [r] = await sql<Clock[]>`
    SELECT fed_ts::text AS fed_ts, fed_hlc, origin FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return r;
}

async function outboxCount(id: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WS} AND key = ${id}`;
  return r.n;
}

describe('work_items derivation triggers fire before the federation stamp (WI-10003230, mig 1227)', () => {
  it('class guard: no BEFORE-row trigger that assigns NEW.<col> sorts after stamp_local_federated_write on any table', async () => {
    const offenders = await sql<{ relname: string; tgname: string; proname: string }[]>`
      WITH stamp AS (
        SELECT t.tgrelid, t.tgname::text AS stamp_name
          FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE p.proname = 'stamp_local_federated_write' AND NOT t.tgisinternal
      )
      SELECT c.relname::text AS relname, t.tgname::text AS tgname, p.proname::text AS proname
        FROM stamp s
        JOIN pg_trigger t ON t.tgrelid = s.tgrelid AND NOT t.tgisinternal
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_class c ON c.oid = s.tgrelid
       WHERE (t.tgtype & 3) = 3                                   -- ROW (1) + BEFORE (2)
         AND t.tgname::text COLLATE "C" > s.stamp_name COLLATE "C" -- fires after the stamp
         AND p.prosrc ~ ${ASSIGNS_NEW}
       ORDER BY 1, 2`;
    expect(offenders).toEqual([]);
  });

  it('class guard is not vacuous: it sees the stamp on work_items and the derivations that must precede it', async () => {
    const preceding = await sql<{ tgname: string }[]>`
      SELECT t.tgname::text AS tgname
        FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgrelid = 'harness_shared.work_items'::regclass AND NOT t.tgisinternal
         AND (t.tgtype & 3) = 3
         AND t.tgname::text COLLATE "C" < 'stamp_local_federated_write_trg' COLLATE "C"
         AND p.prosrc ~ ${ASSIGNS_NEW}
         AND p.proname IN ('stamp_work_item_closed_ts', 'stamp_work_item_state_changed_at',
                           'stamp_work_item_completion_event_intent')
       ORDER BY 1`;
    expect(preceding.map((r) => r.tgname)).toEqual([
      'stamp_before_fed_work_item_closed_ts_trg',
      'stamp_before_fed_work_item_completion_event_intent_trg',
      'stamp_before_fed_work_item_state_changed_at_trg',
    ]);
    const [stamp] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger
       WHERE tgrelid = 'harness_shared.work_items'::regclass
         AND tgname = 'stamp_local_federated_write_trg'`;
    expect(stamp.n).toBe(1);
  });

  it('the measured loop: a clock-stationary duplicate re-apply with a divergent closed_ts keeps the clock and ships nothing', async () => {
    const id = nextId('F');
    const peerHlc1 = '009999999990000:peeraaaa';
    const peerHlc2 = '009999999990500:peeraaaa';
    // A terminal replica that arrived without a close time (honest NULL on insert).
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         origin, fed_ts, fed_hlc, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'contested', 'body', 'done', 'feature',
              'remote', 9999999990000, ${peerHlc1}, ${sql.json({})})`;

    // First apply of the peer's op: the wire clock moves (the stamp honours it), and the
    // terminal->terminal rule keeps the stored closed_ts.
    await sql`
      UPDATE harness_shared.work_items
         SET title = 'B-side-write', closed_ts = 1790419581205,
             fed_ts = 9999999990500, fed_hlc = ${peerHlc2}, origin = 'remote'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const applied = await clockOf(id);
    expect(applied).toEqual({ fed_ts: '9999999990500', fed_hlc: peerHlc2, origin: 'remote' });
    const opsAfterApply = await outboxCount(id);

    // The duplicate apply of the SAME op: identical clock, the peer's closed_ts again.
    // Before mig 1227 the stamp saw closed_ts differ, minted a local clock, and only then
    // did the closed_ts trigger freeze the column back — an unchanged row with a new clock.
    await sql`
      UPDATE harness_shared.work_items
         SET title = 'B-side-write', closed_ts = 1790419581205,
             fed_ts = 9999999990500, fed_hlc = ${peerHlc2}, origin = 'remote'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await clockOf(id)).toEqual(applied);
    expect(await outboxCount(id)).toBe(opsAfterApply);
  });

  it('a clock-stationary write whose completion-intent id the trigger restores keeps the clock', async () => {
    const id = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'intent', 'body', 'todo', 'feature', 'local', ${sql.json({})})`;
    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const [closed] = await sql<{ intent: string | null }[]>`
      SELECT payload->>'_completionEventIntentId' AS intent FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect(closed.intent).not.toBeNull(); // the close minted an in-flight intent
    const before = await clockOf(id);
    const opsBefore = await outboxCount(id);

    // A replica payload carrying a different intent id: the trigger restores ours.
    await sql`
      UPDATE harness_shared.work_items
         SET payload = payload || ${sql.json({ _completionEventIntentId: 'peer-intent' })}
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    const [after] = await sql<{ intent: string | null }[]>`
      SELECT payload->>'_completionEventIntentId' AS intent FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect(after.intent).toBe(closed.intent);
    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(id)).toBe(opsBefore);
  });

  it('an issue-family metadata write whose state_changed_at the trigger freezes keeps the clock', async () => {
    const id = nextId('WI');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'issue', 'body', 'open', 'bug', 'local',
              ${sql.json({ _ei: { severity: 'minor' } })})`;
    const before = await clockOf(id);
    const opsBefore = await outboxCount(id);

    // state_changed_at is issue-family wire content; a same-status write may not move it.
    await sql`
      UPDATE harness_shared.work_items
         SET state_changed_at = now() + interval '1 day'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(id)).toBe(opsBefore);
  });

  it('no under-federation: a genuine local change on a derived row still stamps and ships once', async () => {
    const id = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'close me', 'body', 'todo', 'feature', 'local', ${sql.json({})})`;
    const before = await clockOf(id);
    const opsBefore = await outboxCount(id);

    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    const after = await clockOf(id);
    expect(after.fed_hlc).not.toBe(before.fed_hlc);
    expect(after.origin).toBe('local');
    expect(await outboxCount(id)).toBe(opsBefore + 1);
    const [row] = await sql<{ closed_ts: string | null }[]>`
      SELECT closed_ts::text AS closed_ts FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect(row.closed_ts).not.toBeNull(); // the derivation still ran on the real close
  });
});

describe('a completion-event intent belongs to the node that made the close (WI-10005136, mig 1328)', () => {
  const INTENT_KEY = '_completionEventIntentId';
  const WS_RECONCILE = 'ws-completion-intent-origin';

  async function intentOf(ws: string, id: string): Promise<string | null> {
    const [r] = await sql<{ intent: string | null }[]>`
      SELECT payload->>${INTENT_KEY} AS intent FROM harness_shared.work_items
       WHERE workspace_id = ${ws} AND feature_id = ${id}`;
    return r.intent;
  }

  async function clockIn(ws: string, id: string): Promise<Clock> {
    const [r] = await sql<Clock[]>`
      SELECT fed_ts::text AS fed_ts, fed_hlc, origin FROM harness_shared.work_items
       WHERE workspace_id = ${ws} AND feature_id = ${id}`;
    return r;
  }

  /** An open replica of a peer's item, as the projection inserts it. */
  async function seedPeerOpen(ws: string, id: string, hlc: string): Promise<void> {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         origin, fed_ts, fed_hlc, payload)
      VALUES (${ws}, ${HARNESS}, ${id}, 'peer item', 'body', 'todo', 'feature',
              'remote', 9999999980000, ${hlc}, ${sql.json({})})`;
  }

  /** The projection applying the peer's next op: the wire clock moves, origin stays remote. */
  async function applyPeerOp(
    ws: string, id: string, fields: { status: string; fedTs: number; hlc: string; payload: Record<string, unknown> },
  ): Promise<void> {
    await sql`
      UPDATE harness_shared.work_items
         SET status = ${fields.status}, payload = ${sql.json(fields.payload as never)},
             fed_ts = ${fields.fedTs}, fed_hlc = ${fields.hlc}, origin = 'remote'
       WHERE workspace_id = ${ws} AND feature_id = ${id}`;
  }

  it("applying a peer's close does not mint a local intent, re-stamp the row, or ship an op", async () => {
    const id = nextId('F');
    await seedPeerOpen(WS, id, '009999999980000:peerbbbb');
    await applyPeerOp(WS, id, { status: 'done', fedTs: 9999999980500, hlc: '009999999980500:peerbbbb', payload: {} });
    const opsAfterApply = await outboxCount(id);

    expect(await intentOf(WS, id)).toBeNull();
    expect(await clockOf(id)).toEqual({ fed_ts: '9999999980500', fed_hlc: '009999999980500:peerbbbb', origin: 'remote' });
    expect(await outboxCount(id)).toBe(opsAfterApply);
  });

  it("keeps the publisher's intent verbatim, and does not restore it when the publisher's acknowledgement arrives", async () => {
    const id = nextId('F');
    await seedPeerOpen(WS, id, '009999999981000:peercccc');
    await applyPeerOp(WS, id, {
      status: 'done', fedTs: 9999999981500, hlc: '009999999981500:peercccc', payload: { [INTENT_KEY]: 'peer-intent-1' },
    });
    expect(await intentOf(WS, id)).toBe('peer-intent-1');

    // The publisher fired its event and cleared the key. This node has no matching local
    // fire, which before mig 1328 made the trigger restore the stale intent.
    await applyPeerOp(WS, id, { status: 'done', fedTs: 9999999982000, hlc: '009999999982000:peercccc', payload: {} });
    expect(await intentOf(WS, id)).toBeNull();
    expect((await clockOf(id)).origin).toBe('remote');
  });

  it('positive control: a local close still mints an intent', async () => {
    const id = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'close me locally', 'body', 'todo', 'feature', 'local', ${sql.json({})})`;
    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = ${id}`;

    expect(await intentOf(WS, id)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the reconciler sweeps only this node's closes and leaves a peer's pending intent untouched", async () => {
    const localId = nextId('F');
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS_RECONCILE}, ${HARNESS}, ${localId}, 'local close', 'body', 'todo', 'feature', 'local', ${sql.json({})})`;
    await sql`UPDATE harness_shared.work_items SET status = 'done'
               WHERE workspace_id = ${WS_RECONCILE} AND feature_id = ${localId}`;

    const peerId = nextId('F');
    await seedPeerOpen(WS_RECONCILE, peerId, '009999999983000:peerdddd');
    await applyPeerOp(WS_RECONCILE, peerId, {
      status: 'done', fedTs: 9999999983500, hlc: '009999999983500:peerdddd', payload: { [INTENT_KEY]: 'peer-intent-2' },
    });
    const peerClockBefore = await clockIn(WS_RECONCILE, peerId);
    expect(await intentOf(WS_RECONCILE, localId)).not.toBeNull();
    expect(await intentOf(WS_RECONCILE, peerId)).toBe('peer-intent-2');

    const asked: string[] = [];
    let emitted = 0;
    const result = await reconcileWorkItemCompletionEventIntents(WS_RECONCILE, {
      sql: sql as never,
      getItem: (async (id: string) => { asked.push(id); return null; }) as never,
      emitDone: (async () => { emitted += 1; }) as never,
      nowMs: Date.now() + 60_000,
    });

    expect(asked).toEqual([localId]);
    expect(result.considered).toBe(1);
    expect(emitted).toBe(0);
    expect(await intentOf(WS_RECONCILE, peerId)).toBe('peer-intent-2');
    expect(await clockIn(WS_RECONCILE, peerId)).toEqual(peerClockBefore);
  });
});
