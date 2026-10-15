/**
 * coord-capability-pg-stores.integration.test.ts — runs the capability
 * CONFORMANCE suites against the production `Pg*` capability stores over a REAL
 * Postgres (testcontainer). These are the exact same assertions the in-memory
 * doubles pass in `packages/coordination/src/capabilities/capabilities.test.ts`,
 * so this is the swappability proof for the PG side.
 *
 * This is the "operator's live-PG integration test" that
 * `packages/coordination/src/capabilities/pg-stores.ts` (header + each store's
 * doc) points to — documented as the intended home for these assertions but
 * previously ABSENT. Added in the app-wide-test-coverage breadth wave (EI-423):
 * the Pg* stores were only exercised indirectly (via the conversations/audience
 * tools) and never pinned directly against the contract suites.
 *
 * Isolation: every conformance `factory()` call mints a FRESH workspaceId, so a
 * store-set is partitioned (by `workspace_id`) from every other call — the same
 * freshness the in-memory factory gives by returning a brand-new empty store.
 * The five tables are created once via `ensureCoordCapabilityTables` (the
 * package's standalone schema rig, mirroring migration 123).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *   lib/coord-capability-pg-stores.integration.test.ts
 */
import { afterAll, beforeAll, test, expect } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { applyMigrationForTest, createFreshPgDb } from '../test/_pg-helpers';
import {
  describeLinkableStoreConformance,
  describeResolveObjectSubscribers,
  describeSubscribableStoreConformance,
  describeThreadableStoreConformance,
  describeTopicStoreConformance,
} from '@papercusp/coordination/capabilities/conformance';
import {
  ensureCoordCapabilityTables,
  PgEntitySubscriptionStore,
  PgLinkStore,
  PgTaggableStore,
  PgThreadStore,
  PgTopicStore,
} from '@papercusp/coordination/capabilities';

let sql: postgres.Sql;

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

let wsCounter = 0;
/** A fresh workspace_id per factory() call → each store-set is isolated. */
const freshWs = () => `conf_${++wsCounter}_${randomBytes(2).toString('hex')}`;
const opts = (workspaceId: string) => ({
  getSql: () => sql,
  // Tables are created once in beforeAll; the per-store ensure is a no-op here
  // (mirrors the operator, which passes a no-op ensureSchema — schema is
  // migrations-only per repo storage policy).
  ensureSchema: async () => {},
  workspaceId,
});

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `coordcap_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 8, onnotice: () => {} });
  await ensureCoordCapabilityTables(sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

// The four single-store contracts — the SAME suites the in-memory doubles run.
describeTopicStoreConformance('PgTopicStore', () => new PgTopicStore(opts(freshWs())));
describeSubscribableStoreConformance(
  'PgEntitySubscriptionStore',
  () => new PgEntitySubscriptionStore(opts(freshWs())),
);
describeLinkableStoreConformance('PgLinkStore', () => new PgLinkStore(opts(freshWs())));
describeThreadableStoreConformance('PgThreadStore', () => new PgThreadStore(opts(freshWs())));

// The resolveObjectSubscribers fan-out core over the PG trio (subscriptions +
// link-backed tags + topics sharing one workspace_id).
describeResolveObjectSubscribers('Pg trio', () => {
  const ws = freshWs();
  return {
    subscriptions: new PgEntitySubscriptionStore(opts(ws)),
    tags: new PgTaggableStore(opts(ws)),
    topics: new PgTopicStore(opts(ws)),
  };
});

// EI-1743 regression: a stable id-derived thread_id can outlive a CHANGED parent_ref (e.g. a
// work-item whose workItemObjectRef mutates). The second getOrCreateThread then inserts the SAME
// thread_id under a new parent → before the fix the named-arbiter ON CONFLICT let the PK conflict
// throw `coord_threads_pkey` and work_items:comment crashed. It must instead return the existing
// thread (the thread_id IS that item's thread; posts attach by thread_id).
test('PgThreadStore.getOrCreateThread tolerates a thread_id reused under a different parent (EI-1743)', async () => {
  const store = new PgThreadStore(opts(freshWs()));
  const TID = 'work-item-thread-WI-EI1743';
  const t1 = await store.getOrCreateThread(
    { kind: 'feature', ref: 'F-OLD' },
    { thread_id: TID, created_ts: '2026-06-20T00:00:00.000Z' },
  );
  expect(t1.thread_id).toBe(TID);
  // Same stable thread_id, but the item's ObjectRef has since changed — must NOT throw on the PK.
  const t2 = await store.getOrCreateThread(
    { kind: 'feature', ref: 'F-NEW' },
    { thread_id: TID, created_ts: '2026-06-20T00:01:00.000Z' },
  );
  expect(t2.thread_id).toBe(TID);
  // The thread is resolvable by thread_id and a post still attaches (the comment is recorded).
  expect((await store.getThreadById(TID))?.thread_id).toBe(TID);
  const post = await store.addPost({ thread_id: TID, author_id: 'su-ei1743', body: 'comment after ref change', created_ts: '2026-06-20T00:02:00.000Z' });
  expect(post).toBeTruthy();
});

// EI-1652 regression: the ORIGINAL repro shape — two work_items:amend/comment calls firing in
// the SAME parallel batch (a genuine race, not a sequential re-key like EI-1743's) both hit
// `duplicate key value violates unique constraint "coord_threads_pkey"`. This is the same
// bare-ON-CONFLICT-DO-NOTHING fix's OTHER leg: two truly CONCURRENT getOrCreateThread calls for
// the SAME thread_id (e.g. two parallel comments on the same item, each lazily creating its
// thread) must never throw on the PK race — one INSERT wins, the other's ON CONFLICT DO NOTHING
// no-ops, and BOTH read back the same row.
test('PgThreadStore.getOrCreateThread tolerates two CONCURRENT calls racing to create the same thread (EI-1652)', async () => {
  const store = new PgThreadStore(opts(freshWs()));
  const TID = 'work-item-thread-WI-EI1652';
  const parent = { kind: 'feature' as const, ref: 'F-FIX-EI1652' };
  const [t1, t2] = await Promise.all([
    store.getOrCreateThread(parent, { thread_id: TID, created_ts: '2026-07-18T00:00:00.000Z' }),
    store.getOrCreateThread(parent, { thread_id: TID, created_ts: '2026-07-18T00:00:00.001Z' }),
  ]);
  expect(t1.thread_id).toBe(TID);
  expect(t2.thread_id).toBe(TID);
  // Both concurrent callers can then post without a second race — each addPost is its own insert.
  const [p1, p2] = await Promise.all([
    store.addPost({ thread_id: TID, author_id: 'su-a', body: 'first parallel comment', created_ts: '2026-07-18T00:00:01.000Z' }),
    store.addPost({ thread_id: TID, author_id: 'su-b', body: 'second parallel comment', created_ts: '2026-07-18T00:00:01.001Z' }),
  ]);
  expect(p1).toBeTruthy();
  expect(p2).toBeTruthy();
});

test('PgThreadStore.getPostById reads a post only from its workspace partition', async () => {
  const writer = new PgThreadStore(opts(freshWs()));
  const otherWorkspace = new PgThreadStore(opts(freshWs()));
  const thread = await writer.getOrCreateThread(
    { kind: 'issue', ref: 'EI-thread-post-scope' },
    { thread_id: `thread-post-scope-${randomBytes(4).toString('hex')}`, created_ts: '2026-10-01T00:00:00.000Z' },
  );
  const post = await writer.addPost({
    thread_id: thread.thread_id,
    author_id: 'su-scope-test',
    body: 'workspace-scoped evidence',
    created_ts: '2026-10-01T00:01:00.000Z',
  });

  await expect(writer.getPostById(post.id)).resolves.toEqual(post);
  await expect(otherWorkspace.getPostById(post.id)).resolves.toBeNull();
});

// EI-11826 regression: the event-await fan-out can read existing event-key
// subscriptions while the candidate migrations are still pending. Migration
// 568 permits target_kind='event', but migration 602 adds the optional
// follow/derived columns that the current read path must tolerate being absent.
test('PgEntitySubscriptionStore reads event subscribers before migration 602', async () => {
  const db = await createFreshPgDb('coordcap-pre602');
  try {
    await applyMigrationForTest(db.sql, resolve(SQL_DIR, '123-coordination-substrate.sql'));
    await applyMigrationForTest(db.sql, resolve(SQL_DIR, '429-coord-entity-subscriptions-allow-fleet-kind.sql'));
    await applyMigrationForTest(db.sql, resolve(SQL_DIR, '568-coord-entity-subscriptions-allow-event-kind.sql'));

    const workspaceId = 'pre602';
    const eventKey = 'green-checkpoint:red:papercusp';
    await db.sql`
      INSERT INTO harness_shared.coord_entity_subscriptions
        (workspace_id, subscriber_id, target_kind, target_ref, delivery_mode, created_at)
      VALUES
        (${workspaceId}, 'subscriber-pre602', 'event', ${eventKey}, 'full', '2026-08-27T00:00:00.000Z')`;

    const store = new PgEntitySubscriptionStore({
      getSql: () => db.sql,
      ensureSchema: async () => {},
      workspaceId,
    });
    await expect(store.listTargetSubscribers('event', eventKey)).resolves.toMatchObject([
      {
        subscriber_id: 'subscriber-pre602',
        target_kind: 'event',
        target_ref: eventKey,
        delivery_mode: 'full',
        follow_blockers: false,
        derived_from: null,
      },
    ]);
    await expect(store.listSubscriptions('subscriber-pre602')).resolves.toMatchObject([
      {
        target_kind: 'event',
        target_ref: eventKey,
        follow_blockers: false,
        derived_from: null,
      },
    ]);
  } finally {
    await db?.cleanup();
  }
});
