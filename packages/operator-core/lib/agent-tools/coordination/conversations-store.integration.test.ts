/**
 * conversations-store.integration.test.ts — PgConversationStore (coord_conversations),
 * against a real Postgres. Fully injectable (opts.getSql) — no db-org mock needed; the
 * store's own ensureConversationsTable builds the faithful table.
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - create is idempotent (ON CONFLICT (workspace_id, id) DO NOTHING) and reads back;
 *  - setState sets resolved_at ONLY when resolving and CLEARS it otherwise;
 *  - setPromoted records the issue id AND closes the conversation;
 *  - list filters (kind/scope/state) + newest-first + clamped limit; all reads are
 *    workspace-scoped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const { PgConversationStore, ensureConversationsTable, reparentThread } = await import('./conversations-store');

const WS = 'ws-conv';
let rootSql: postgres.Sql;
const store = () => new PgConversationStore({ getSql: () => rootSql, ensureSchema: async () => {}, workspaceId: WS } as never);
const mk = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'question', scope: 'harness', harness_slug: 'web', asker_id: 'u1', title: 't', body: 'b', producer: 'test', created_ts: '2026-01-01T00:00:00Z', ...over }) as never;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `conv_${randomBytes(5).toString('hex')}`;
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
  await ensureConversationsTable(rootSql); // the store's own DDL (mirrors migration 132)
  // coord_threads + coord_thread_posts for reparentThread AND the WI-5807
  // unansweredOnly join. `title`, `created_at` and `post_count` are NOT padding:
  // migration 123 gives coord_threads all three, `title`/`created_at` COLLIDE with
  // coord_conversations' own columns, and post_count is what "unanswered" is
  // measured from — a rig missing them would let an ambiguous-column or
  // missing-column regression pass here and only fail in production.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_threads (
      workspace_id text NOT NULL, thread_id text NOT NULL,
      parent_kind text NOT NULL, parent_ref text NOT NULL,
      title text, created_at timestamptz DEFAULT now() NOT NULL,
      post_count integer NOT NULL DEFAULT 0
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_thread_posts (
      workspace_id text NOT NULL, thread_id text NOT NULL, body text
    )`);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_conversations, harness_shared.coord_threads, harness_shared.coord_thread_posts`;
});

describe('PgConversationStore (PG)', () => {
  // EI-1534: the getWorkspaceId thunk must re-resolve the scope on EVERY query
  // (not pin once at construction) so one shared singleton store isolates
  // per-request workspaces instead of leaking 'default' into every window.
  it('getWorkspaceId thunk scopes dynamically per call — no cross-workspace leak', async () => {
    let currentWs = 'wsA';
    // ONE store instance (mirrors the operator singleton) whose scope follows a thunk.
    const dyn = new PgConversationStore({
      getSql: () => rootSql,
      ensureSchema: async () => {},
      getWorkspaceId: () => currentWs,
    } as never);

    currentWs = 'wsA';
    await dyn.create(mk('a1', { title: 'in A' }));
    currentWs = 'wsB';
    await dyn.create(mk('b1', { title: 'in B' }));

    // Reads re-resolve the thunk: A sees only A's, B sees only B's.
    currentWs = 'wsA';
    const inA = await dyn.list({});
    expect(inA.map((c) => c.id)).toEqual(['a1']);
    expect(await dyn.get('b1')).toBeNull(); // B's row is invisible from A's scope

    currentWs = 'wsB';
    const inB = await dyn.list({});
    expect(inB.map((c) => c.id)).toEqual(['b1']);
    expect(await dyn.get('a1')).toBeNull();
  });

  it('create reads back and is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const row = await store().create(mk('c1', { title: 'first' }));
    expect(row).toMatchObject({ id: 'c1', title: 'first', state: 'open' });
    await store().create(mk('c1', { title: 'SECOND' })); // same id → no-op
    expect((await store().get('c1'))!.title).toBe('first'); // original preserved
  });

  it('round-trips recovered-owner lane provenance', async () => {
    const row = await store().create(mk('c-prov', { producer: 'coord:ask-owner', plan_slug: 'plan-a', work_item_id: 'WI-a' }));
    expect(row).toMatchObject({ plan_slug: 'plan-a', work_item_id: 'WI-a' });
  });

  it('setState sets resolved_at when resolving, and CLEARS it on any other state', async () => {
    await store().create(mk('c2'));
    await store().setState('c2', 'resolved' as never, { now_ts: '2026-02-02T00:00:00Z' });
    expect((await store().get('c2'))!.resolved_ts).toBe('2026-02-02T00:00:00.000Z');
    await store().setState('c2', 'open' as never, { now_ts: '2026-03-03T00:00:00Z' });
    expect((await store().get('c2'))!.resolved_ts).toBeNull(); // reopening clears resolved_at
  });

  it('setPromoted records the issue id and closes the conversation', async () => {
    await store().create(mk('c3'));
    await store().setPromoted('c3', { issue_id: 'EI-9', now_ts: '2026-02-02T00:00:00Z' });
    const row = (await store().get('c3'))!;
    expect(row.state).toBe('closed');
    expect(row.promoted_issue_id).toBe('EI-9');
  });

  it('list filters by state, newest-first, clamped', async () => {
    await store().create(mk('a', { created_ts: '2026-01-01T00:00:00Z' }));
    await store().create(mk('b', { created_ts: '2026-03-01T00:00:00Z' }));
    await store().create(mk('c', { created_ts: '2026-02-01T00:00:00Z' }));
    await store().setState('b', 'resolved' as never, { now_ts: '2026-04-01T00:00:00Z' });
    expect((await store().list()).map((r) => r.id)).toEqual(['b', 'c', 'a']); // created_at DESC
    expect((await store().list({ state: 'resolved' as never })).map((r) => r.id)).toEqual(['b']); // state filter
  });

  it('reads are workspace-scoped (a row in another workspace is invisible)', async () => {
    const other = new PgConversationStore({ getSql: () => rootSql, ensureSchema: async () => {}, workspaceId: 'other-ws' } as never);
    await other.create(mk('x'));
    expect(await store().get('x')).toBeNull(); // WS store can't see other-ws's conversation
  });
});

describe('reparentThread (PG, atomic re-key)', () => {
  async function seedThread(parentKind: string, parentRef: string, threadId: string, postBodies: string[]) {
    await rootSql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref) VALUES (${WS}, ${threadId}, ${parentKind}, ${parentRef})`;
    for (const b of postBodies) {
      await rootSql`INSERT INTO harness_shared.coord_thread_posts (workspace_id, thread_id, body) VALUES (${WS}, ${threadId}, ${b})`;
    }
  }

  it('re-keys the thread AND its posts to the new thread_id, and moves the parent', async () => {
    await seedThread('conversation', 'conv-1', 'thr-old', ['p1', 'p2']);
    const res = await reparentThread(rootSql, WS, { kind: 'conversation', ref: 'conv-1' }, { kind: 'issue', ref: 'EI-9' }, 'issue-thread-EI-9');
    expect(res).toEqual({ reparented: true, thread_id: 'issue-thread-EI-9' });
    // the thread moved + re-keyed
    const thr = (await rootSql<{ thread_id: string; parent_kind: string; parent_ref: string }[]>`SELECT thread_id, parent_kind, parent_ref FROM harness_shared.coord_threads`)[0]!;
    expect(thr).toEqual({ thread_id: 'issue-thread-EI-9', parent_kind: 'issue', parent_ref: 'EI-9' });
    // the POSTS followed (re-keyed too) — none left on the old thread_id
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_thread_posts WHERE thread_id='thr-old'`).toHaveLength(0);
    expect(await rootSql`SELECT 1 FROM harness_shared.coord_thread_posts WHERE thread_id='issue-thread-EI-9'`).toHaveLength(2);
  });

  it('is a no-op when the source parent has no thread', async () => {
    expect(await reparentThread(rootSql, WS, { kind: 'conversation', ref: 'nope' }, { kind: 'issue', ref: 'EI-1' }, 'issue-thread-EI-1')).toEqual({ reparented: false });
  });
});

// ── WI-5807 (P-007): the unanswered/unscoped list filters ────────────────────
// These back coord:orient's open-questions PULL surface. They are SQL-shaped
// (a LEFT JOIN against coord_threads plus an OR-widened harness predicate), so a
// fake-sql unit test proves nothing about them — the join, the COALESCE, and the
// `c.`-qualification against coord_threads' colliding title/created_at columns
// only exist against a real Postgres.
describe('PgConversationStore.list — unansweredOnly / includeUnscoped (PG)', () => {
  const thread = (ref: string, postCount: number) =>
    rootSql`INSERT INTO harness_shared.coord_threads (workspace_id, thread_id, parent_kind, parent_ref, title, post_count)
            VALUES (${WS}, ${'thr-' + ref}, 'conversation', ${ref}, 'a THREAD title that must not shadow the conversation title', ${postCount})`;

  it('unansweredOnly keeps zero-reply AND never-threaded conversations, drops replied ones', async () => {
    const s = store();
    await s.create(mk('c-never-threaded')); // no coord_threads row at all
    await s.create(mk('c-zero-posts'));
    await s.create(mk('c-answered'));
    await thread('c-zero-posts', 0);
    await thread('c-answered', 2);

    const unanswered = await s.list({ unansweredOnly: true });
    expect(unanswered.map((r) => r.id).sort()).toEqual(['c-never-threaded', 'c-zero-posts']);
    // …and the filter is opt-in: without it, the replied one is still listed.
    expect((await s.list({})).map((r) => r.id)).toContain('c-answered');
  });

  it('projects the CONVERSATION row through the join (no column shadowed by coord_threads)', async () => {
    const s = store();
    await s.create(mk('c-1', { title: 'the conversation title', created_ts: '2026-02-02T00:00:00Z' }));
    await thread('c-1', 0);
    const [row] = await s.list({ unansweredOnly: true });
    // coord_threads also has title + created_at; an unqualified select would
    // either error or silently return the THREAD's values here.
    expect(row.title).toBe('the conversation title');
    expect(row.created_ts).toBe('2026-02-02T00:00:00.000Z');
    expect(row.id).toBe('c-1');
  });

  it('includeUnscoped widens a harness filter to "this harness OR workspace-wide"', async () => {
    const s = store();
    await s.create(mk('c-mine', { harness_slug: 'web' }));
    await s.create(mk('c-other', { harness_slug: 'other-harness' }));
    await s.create(mk('c-global', { harness_slug: null, scope: 'operator' }));

    // Strict (existing behavior): only the harness's own.
    const strict = await s.list({ harness_slug: 'web' });
    expect(strict.map((r) => r.id)).toEqual(['c-mine']);

    // Widened: the harness's own PLUS the workspace-wide ones — the measured
    // reason this exists (32 of 39 open questions are harness-less).
    const widened = await s.list({ harness_slug: 'web', includeUnscoped: true });
    expect(widened.map((r) => r.id).sort()).toEqual(['c-global', 'c-mine']);
    expect(widened.map((r) => r.id)).not.toContain('c-other');
  });

  it('composes with the existing scalar filters and stays workspace-scoped', async () => {
    const s = store();
    await s.create(mk('c-open-q', { kind: 'question' }));
    await s.create(mk('c-open-d', { kind: 'discussion' }));
    await s.create(mk('c-resolved-q', { kind: 'question' }));
    await s.setState('c-resolved-q', 'resolved');
    await rootSql`INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, scope, harness_slug, asker_id, title, body, state, created_at, updated_at)
      VALUES ('other-ws', 'c-foreign', 'question', 'harness', 'web', 'u1', 't', 'b', 'open', now(), now())`;

    const rows = await s.list({ kind: 'question', state: 'open', unansweredOnly: true });
    expect(rows.map((r) => r.id)).toEqual(['c-open-q']);
  });
});
