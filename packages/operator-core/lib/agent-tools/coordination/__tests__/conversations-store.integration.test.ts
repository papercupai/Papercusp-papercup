/**
 * conversations-store.integration.test.ts — the PgConversationStore CONTRACT on
 * real Postgres (app-wide-test-coverage-2026-06-05 P-009): throwaway db on the
 * shared testcontainer (createFreshPgDb), schema via the package's own
 * ensureConversationsTable (mirrors migration 132), same rig as
 * conversations.integration.test.ts.
 *
 * The two lifecycle integration suites drive the store only THROUGH
 * conversations-core; this file pins the store's own row-level contract the
 * core paths skim over:
 *
 *  • create → get round-trip (defaults + explicit fields, ISO timestamp
 *    round-trip); duplicate-id create is DO NOTHING + read-back (first wins).
 *  • list — created_at DESC ordering, each scalar filter + their composition,
 *    limit honored and clamped to ≥1.
 *  • setState — resolved is the ONLY state that carries resolved_at (closing or
 *    re-opening clears it); there is NO transition guard (closed → open is
 *    permitted); unknown id is a silent no-op; an off-enum state is rejected by
 *    the CHECK constraint (the only invalid-state behavior that exists).
 *  • setAcceptedAnswer — persists + round-trips; omitted optionals null; a
 *    second call overwrites (including back to null).
 *  • setPromoted — records the issue, closes, bumps updated_at, and (unlike
 *    setState) PRESERVES resolved_at.
 *  • touch — bumps updated_at only.
 *  • create CHECK constraints — scope/slug coherence + the kind enum.
 *  • reparentThread — re-keys the thread AND its posts to the destination's
 *    thread_id in one tx, leaves unrelated threads untouched, and a second
 *    reparent of the same source is {reparented:false}.
 *  • workspace isolation — same id lives independently per workspace_id; writes
 *    scoped to another workspace never touch this one's row.
 *  • ensureConversationsTable is idempotent (re-run keeps data).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { ensureCoordCapabilityTables, PgThreadStore } from '@papercusp/coordination/capabilities';
import {
  ensureConversationsTable,
  PgConversationStore,
  reparentThread,
  type ConversationKind,
  type ConversationState,
  type CreateConversationInput,
} from '../conversations-store';

const WS = 'default';
const T0 = '2026-06-04T00:00:00.000Z';
const T1 = '2026-06-04T00:00:01.000Z';
const T2 = '2026-06-04T00:00:02.000Z';
const T3 = '2026-06-04T00:00:03.000Z';

let db: FreshPgDb;
let sql: postgres.Sql;
let store: PgConversationStore;

function input(id: string, over: Partial<CreateConversationInput> = {}): CreateConversationInput {
  return {
    id,
    kind: 'question',
    scope: 'operator',
    asker_id: 'agA',
    body: `body of ${id}`,
    producer: 'test',
    created_ts: T0,
    ...over,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('conv-store');
  sql = db.sql;
  await ensureCoordCapabilityTables(sql);
  await ensureConversationsTable(sql);
  store = new PgConversationStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS });
});
afterAll(async () => {
  // WI-5194: when beforeAll itself fails (observed cause: the shared dev
  // Postgres server was mid crash-recovery, or a testcontainer connection got
  // dropped) `db` is never assigned, so an unconditional `db.cleanup()` here
  // threw `Cannot read properties of undefined (reading 'cleanup')` — masking
  // the REAL beforeAll error in the test-run record with a confusing, useless
  // secondary one. Guard so the original infra failure is what actually
  // surfaces (there's nothing to clean up if provisioning never completed).
  if (db) await db.cleanup();
});
beforeEach(async () => {
  await sql`TRUNCATE harness_shared.coord_conversations,
                    harness_shared.coord_threads,
                    harness_shared.coord_thread_posts RESTART IDENTITY`;
});

describe('create → get round-trip', () => {
  it('persists defaults: open state, null accepted/promoted fields, timestamps = created_ts', async () => {
    const created = await store.create(input('c1', { title: null }));
    const row = await store.get('c1');
    expect(row).toEqual(created);
    expect(row).toMatchObject({
      id: 'c1',
      kind: 'question',
      scope: 'operator',
      harness_slug: null,
      asker_id: 'agA',
      title: null,
      body: 'body of c1',
      state: 'open',
      accepted_answer: null,
      accepted_post_id: null,
      capture_target: null,
      promoted_issue_id: null,
      created_ts: T0,
      updated_ts: T0,
      resolved_ts: null,
    });
  });

  it('round-trips explicit harness scope + title', async () => {
    await store.create(
      input('c2', { kind: 'discussion', scope: 'harness', harness_slug: 'papercup', title: 'a title' }),
    );
    const row = await store.get('c2');
    expect(row?.kind).toBe('discussion');
    expect(row?.scope).toBe('harness');
    expect(row?.harness_slug).toBe('papercup');
    expect(row?.title).toBe('a title');
  });

  it('reads lifecycle only for the requested ids in the current workspace', async () => {
    const other = new PgConversationStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: 'other-ws' });
    await store.create(input('batch-open'));
    await store.create(input('batch-resolved'));
    await store.setState('batch-resolved', 'resolved', { now_ts: T1 });
    await other.create(input('batch-other'));

    const rows = await store.getStatesByIds(['batch-open', 'batch-resolved', 'missing', 'batch-open', 'batch-other']);
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'batch-open', state: 'open' },
      { id: 'batch-resolved', state: 'resolved' },
    ]);
    expect(await store.getStatesByIds([])).toEqual([]);
  });

  it('a duplicate-id create is DO NOTHING + read-back: the first row wins', async () => {
    await store.create(input('dup', { body: 'first' }));
    const second = await store.create(input('dup', { body: 'second', title: 'late title' }));
    expect(second.body).toBe('first');
    expect(second.title).toBeNull();
    expect((await store.get('dup'))?.body).toBe('first');
  });

  it('get returns null for an unknown id', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});

describe('list — filters, ordering, limit clamp', () => {
  beforeEach(async () => {
    await store.create(input('q-old', { created_ts: T0 }));
    await store.create(input('d-mid', { kind: 'discussion', created_ts: T1 }));
    await store.create(input('q-harness', { scope: 'harness', harness_slug: 'pcup', created_ts: T2 }));
    await store.create(input('q-new', { created_ts: T3 }));
    await store.setState('q-new', 'resolved', { now_ts: T3 });
  });

  it('orders newest-first (created_at DESC)', async () => {
    expect((await store.list()).map((r) => r.id)).toEqual(['q-new', 'q-harness', 'd-mid', 'q-old']);
  });

  it('each scalar filter narrows, and they compose', async () => {
    expect((await store.list({ kind: 'discussion' })).map((r) => r.id)).toEqual(['d-mid']);
    expect((await store.list({ state: 'resolved' })).map((r) => r.id)).toEqual(['q-new']);
    expect((await store.list({ scope: 'harness' })).map((r) => r.id)).toEqual(['q-harness']);
    expect((await store.list({ harness_slug: 'pcup' })).map((r) => r.id)).toEqual(['q-harness']);
    expect((await store.list({ kind: 'question', state: 'open', scope: 'operator' })).map((r) => r.id)).toEqual([
      'q-old',
    ]);
    expect(await store.list({ kind: 'question', state: 'resolved', scope: 'harness' })).toEqual([]);
  });

  it('honors limit and clamps a non-positive limit up to 1', async () => {
    expect((await store.list({ limit: 2 })).map((r) => r.id)).toEqual(['q-new', 'q-harness']);
    expect((await store.list({ limit: 0 })).map((r) => r.id)).toEqual(['q-new']);
    expect((await store.list({ limit: -5 })).map((r) => r.id)).toEqual(['q-new']);
  });
});

describe('setState — resolved_at semantics, no transition guard', () => {
  it('resolved sets resolved_at; closing afterwards CLEARS it (only the resolved state carries it)', async () => {
    await store.create(input('s1'));
    await store.setState('s1', 'resolved', { now_ts: T1 });
    let row = await store.get('s1');
    expect(row?.state).toBe('resolved');
    expect(row?.resolved_ts).toBe(T1);
    expect(row?.updated_ts).toBe(T1);

    await store.setState('s1', 'closed', { now_ts: T2 });
    row = await store.get('s1');
    expect(row?.state).toBe('closed');
    expect(row?.resolved_ts).toBeNull();
    expect(row?.updated_ts).toBe(T2);
  });

  it('has NO transition guard: closed → open is permitted (re-open), resolved_at stays null', async () => {
    await store.create(input('s2'));
    await store.setState('s2', 'closed', { now_ts: T1 });
    await store.setState('s2', 'open', { now_ts: T2 });
    const row = await store.get('s2');
    expect(row?.state).toBe('open');
    expect(row?.resolved_ts).toBeNull();
  });

  it('is a silent no-op for an unknown id', async () => {
    await expect(store.setState('ghost', 'resolved', { now_ts: T1 })).resolves.toBeUndefined();
  });

  it('an off-enum state is rejected by the CHECK constraint (the only invalid-state guard)', async () => {
    await store.create(input('s3'));
    await expect(store.setState('s3', 'archived' as ConversationState, { now_ts: T1 })).rejects.toThrow(
      /coord_conversations_state_check/,
    );
    expect((await store.get('s3'))?.state).toBe('open');
  });
});

describe('closeIfOpen — the conversations:withdraw compare-and-set', () => {
  it('closes an open row once, and the loser of a second close learns the terminal state', async () => {
    await store.create(input('w1'));
    const first = await store.closeIfOpen('w1', { now_ts: T1 });
    expect(first).toMatchObject({ ok: true, conversation: { id: 'w1', state: 'closed', resolved_ts: null, updated_ts: T1 } });

    const second = await store.closeIfOpen('w1', { now_ts: T2 });
    expect(second).toMatchObject({ error: 'not_open', conversation: { state: 'closed', updated_ts: T1 } });
  });

  it('never overwrites a resolved row, and reports an unknown id as not_found', async () => {
    await store.create(input('w2'));
    await store.setState('w2', 'resolved', { now_ts: T1 });
    expect(await store.closeIfOpen('w2', { now_ts: T2 })).toMatchObject({ error: 'not_open', conversation: { state: 'resolved' } });
    expect((await store.get('w2'))?.resolved_ts).toBe(T1);
    expect(await store.closeIfOpen('ghost', { now_ts: T1 })).toEqual({ error: 'not_found' });
  });
});

describe('setAcceptedAnswer', () => {
  it('persists answer + post id + capture target and bumps updated_at', async () => {
    await store.create(input('a1'));
    await store.setAcceptedAnswer('a1', {
      answer: 'the fix',
      post_id: 7,
      capture_target: 'mem0:workspace:default',
      now_ts: T1,
    });
    const row = await store.get('a1');
    expect(row?.accepted_answer).toBe('the fix');
    expect(row?.accepted_post_id).toBe(7);
    expect(row?.capture_target).toBe('mem0:workspace:default');
    expect(row?.updated_ts).toBe(T1);
    // setAcceptedAnswer does not flip the lifecycle — that is setState's job.
    expect(row?.state).toBe('open');
  });

  it('omitted optionals store null, and a second call overwrites (including back to null)', async () => {
    await store.create(input('a2'));
    await store.setAcceptedAnswer('a2', { answer: 'first', post_id: 3, capture_target: 'mem0:x', now_ts: T1 });
    await store.setAcceptedAnswer('a2', { answer: 'second', now_ts: T2 });
    const row = await store.get('a2');
    expect(row?.accepted_answer).toBe('second');
    expect(row?.accepted_post_id).toBeNull();
    expect(row?.capture_target).toBeNull();
    expect(row?.updated_ts).toBe(T2);
  });
});

describe('reopenResolved — bounded compensation inverse', () => {
  it('restores the open source row and clears every resolution scalar', async () => {
    await store.create(input('undo-answer'));
    await store.setAcceptedAnswer('undo-answer', {
      answer: 'bulk close reason',
      post_id: 7,
      capture_target: 'none',
      now_ts: T1,
    });
    await store.setState('undo-answer', 'resolved', { now_ts: T1 });

    expect(
      await store.reopenResolved('undo-answer', {
        expected_answer: 'bulk close reason',
        now_ts: T2,
      }),
    ).toBe('reopened');
    expect(await store.get('undo-answer')).toMatchObject({
      state: 'open',
      accepted_answer: null,
      accepted_post_id: null,
      capture_target: null,
      resolved_ts: null,
      updated_ts: T2,
    });
    expect(
      await store.reopenResolved('undo-answer', {
        expected_answer: 'bulk close reason',
        now_ts: T3,
      }),
    ).toBe('already_open');
  });

  it('compare-and-set refuses to overwrite a different terminal answer', async () => {
    await store.create(input('changed-answer'));
    await store.setAcceptedAnswer('changed-answer', { answer: 'newer answer', now_ts: T1 });
    await store.setState('changed-answer', 'resolved', { now_ts: T1 });
    expect(
      await store.reopenResolved('changed-answer', {
        expected_answer: 'bulk answer',
        now_ts: T2,
      }),
    ).toBe('source_changed');
    expect(await store.get('changed-answer')).toMatchObject({
      state: 'resolved',
      accepted_answer: 'newer answer',
    });
  });

  it('participates in a caller transaction so receipt failure rolls the source restore back', async () => {
    await store.create(input('rollback-answer'));
    await store.setAcceptedAnswer('rollback-answer', { answer: 'bulk answer', now_ts: T1 });
    await store.setState('rollback-answer', 'resolved', { now_ts: T1 });

    await expect(
      sql.begin(async (tx) => {
        const txStore = new PgConversationStore({
          getSql: () => tx,
          ensureSchema: async () => {},
          workspaceId: WS,
        });
        expect(
          await txStore.reopenResolved('rollback-answer', {
            expected_answer: 'bulk answer',
            now_ts: T2,
          }),
        ).toBe('reopened');
        throw new Error('receipt write failed');
      }),
    ).rejects.toThrow('receipt write failed');

    expect(await store.get('rollback-answer')).toMatchObject({
      state: 'resolved',
      accepted_answer: 'bulk answer',
    });
  });
});

describe('supersede — row transaction', () => {
  it('uses the exact accepted answer as a compare-and-set for correcting a resolved owner question', async () => {
    await store.create(input('resolved-owner-question'));
    await store.setAcceptedAnswer('resolved-owner-question', {
      answer: 'approved answer v1',
      post_id: 17,
      capture_target: 'mem0:workspace:default',
      now_ts: T1,
    });
    await store.setState('resolved-owner-question', 'resolved', { now_ts: T1 });

    const stale = await store.supersede(
      'resolved-owner-question',
      input('stale-replacement'),
      { now_ts: T2, expected_answer: 'older answer' },
    );
    expect(stale).toMatchObject({
      error: 'source_changed',
      conversation: { id: 'resolved-owner-question', state: 'resolved', accepted_answer: 'approved answer v1' },
    });
    expect(await store.get('stale-replacement')).toBeNull();

    const corrected = await store.supersede(
      'resolved-owner-question',
      input('corrected-replacement'),
      { now_ts: T2, expected_answer: 'approved answer v1' },
    );
    if ('error' in corrected) throw new Error(corrected.error);
    expect(corrected).toMatchObject({
      conversation: {
        id: 'resolved-owner-question',
        state: 'superseded',
        superseded_by: 'corrected-replacement',
        accepted_answer: null,
        accepted_post_id: null,
        capture_target: null,
        resolved_ts: null,
      },
      replacement: { id: 'corrected-replacement', state: 'open' },
    });
  });

  it('inserts the replacement and retires the old gate in one store operation', async () => {
    await store.create(input('old-gate', { title: 'old title' }));
    const result = await store.supersede(
      'old-gate',
      input('new-gate', { title: 'new title', body: 'corrected body', asker_id: 'agB', created_ts: T1 }),
      { now_ts: T1 },
    );
    if ('error' in result) throw new Error(result.error);

    expect(result.conversation).toMatchObject({
      id: 'old-gate',
      state: 'superseded',
      superseded_by: 'new-gate',
      superseded_ts: T1,
      resolved_ts: null,
    });
    expect(result.replacement).toMatchObject({
      id: 'new-gate',
      state: 'open',
      title: 'new title',
      body: 'corrected body',
      asker_id: 'agB',
    });
    expect((await store.list({ state: 'open' })).map((r) => r.id)).toEqual(['new-gate']);
  });

  it('does not create a second replacement after the old gate is terminal', async () => {
    await store.create(input('old-gate'));
    const first = await store.supersede('old-gate', input('new-gate'), { now_ts: T1 });
    if ('error' in first) throw new Error(first.error);
    const second = await store.supersede('old-gate', input('newer-gate'), { now_ts: T2 });
    expect(second).toMatchObject({ error: 'not_open', conversation: { superseded_by: 'new-gate' } });
    expect(await store.get('newer-gate')).toBeNull();
  });

  it('reuses an existing TransactionSql handle instead of opening a nested transaction', async () => {
    await sql.begin(async (tx) => {
      const txStore = new PgConversationStore({
        getSql: () => tx,
        ensureSchema: async () => {},
        workspaceId: WS,
      });
      await txStore.create(input('tx-old'));
      const result = await txStore.supersede('tx-old', input('tx-new'), {
        now_ts: T1,
      });
      if ('error' in result) throw new Error(result.error);
      expect(result).toMatchObject({
        conversation: { id: 'tx-old', state: 'superseded' },
        replacement: { id: 'tx-new', state: 'open' },
      });
    });
    expect(await store.get('tx-new')).toMatchObject({ state: 'open' });
  });
});

describe('setPromoted', () => {
  it('records the issue id, closes the conversation, bumps updated_at — and PRESERVES resolved_at', async () => {
    await store.create(input('p1'));
    await store.setState('p1', 'resolved', { now_ts: T1 });
    await store.setPromoted('p1', { issue_id: 'EI-42', now_ts: T2 });
    const row = await store.get('p1');
    expect(row?.promoted_issue_id).toBe('EI-42');
    expect(row?.state).toBe('closed');
    expect(row?.updated_ts).toBe(T2);
    // Unlike setState('closed'), the promote close keeps the resolution time.
    expect(row?.resolved_ts).toBe(T1);
  });
});

describe('touch', () => {
  it('bumps updated_at and nothing else', async () => {
    await store.create(input('t1', { title: 'keep me' }));
    await store.touch('t1', T2);
    const row = await store.get('t1');
    expect(row?.updated_ts).toBe(T2);
    expect(row?.created_ts).toBe(T0);
    expect(row?.state).toBe('open');
    expect(row?.title).toBe('keep me');
  });
});

describe('create CHECK constraints (migration 132 mirror)', () => {
  it('rejects harness scope without a slug, and operator scope WITH one', async () => {
    await expect(store.create(input('bad1', { scope: 'harness', harness_slug: null }))).rejects.toThrow(
      /coord_conversations_scope_slug_check/,
    );
    await expect(store.create(input('bad2', { scope: 'operator', harness_slug: 'pcup' }))).rejects.toThrow(
      /coord_conversations_scope_slug_check/,
    );
  });

  it('rejects an off-enum kind', async () => {
    await expect(store.create(input('bad3', { kind: 'rant' as ConversationKind }))).rejects.toThrow(
      /coord_conversations_kind_check/,
    );
  });
});

describe('reparentThread (D-005 carry)', () => {
  it('re-keys the thread AND its posts to the destination thread_id in one tx; unrelated threads untouched', async () => {
    const threadStore = new PgThreadStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS });
    await threadStore.getOrCreateThread(
      { kind: 'conversation', ref: 'c-src' },
      { thread_id: 'thr-c-src', created_ts: T0 },
    );
    await threadStore.addPost({ thread_id: 'thr-c-src', author_id: 'agA', body: 'p1', created_ts: T0 });
    await threadStore.addPost({ thread_id: 'thr-c-src', author_id: 'agB', body: 'p2', created_ts: T1 });
    await threadStore.getOrCreateThread(
      { kind: 'conversation', ref: 'c-other' },
      { thread_id: 'thr-c-other', created_ts: T0 },
    );
    await threadStore.addPost({ thread_id: 'thr-c-other', body: 'bystander', created_ts: T0 });

    const rep = await reparentThread(
      sql,
      WS,
      { kind: 'conversation', ref: 'c-src' },
      { kind: 'issue', ref: 'EI-7' },
      'issue-thread-EI-7',
    );
    expect(rep).toEqual({ reparented: true, thread_id: 'issue-thread-EI-7' });

    // The source parent no longer has a thread; the destination does, under ITS id.
    expect(await threadStore.getThreadByParent({ kind: 'conversation', ref: 'c-src' })).toBeNull();
    expect((await threadStore.getThreadByParent({ kind: 'issue', ref: 'EI-7' }))?.thread_id).toBe('issue-thread-EI-7');

    // Posts followed the re-key (order preserved); nothing lingers under the old id.
    expect((await threadStore.listPosts('issue-thread-EI-7')).map((p) => p.body)).toEqual(['p1', 'p2']);
    expect(await threadStore.listPosts('thr-c-src')).toEqual([]);

    // The unrelated thread kept its id + post.
    expect((await threadStore.getThreadByParent({ kind: 'conversation', ref: 'c-other' }))?.thread_id).toBe(
      'thr-c-other',
    );
    expect((await threadStore.listPosts('thr-c-other')).map((p) => p.body)).toEqual(['bystander']);
  });

  it('a second reparent of the same (now thread-less) source reports {reparented:false}', async () => {
    const threadStore = new PgThreadStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: WS });
    await threadStore.getOrCreateThread(
      { kind: 'conversation', ref: 'c-once' },
      { thread_id: 'thr-c-once', created_ts: T0 },
    );
    const first = await reparentThread(
      sql,
      WS,
      { kind: 'conversation', ref: 'c-once' },
      { kind: 'issue', ref: 'EI-8' },
      'issue-thread-EI-8',
    );
    expect(first.reparented).toBe(true);
    const again = await reparentThread(
      sql,
      WS,
      { kind: 'conversation', ref: 'c-once' },
      { kind: 'issue', ref: 'EI-8' },
      'issue-thread-EI-8',
    );
    expect(again).toEqual({ reparented: false });
  });
});

describe('workspace isolation', () => {
  it('the same id lives independently per workspace; writes in another workspace never touch this one', async () => {
    const other = new PgConversationStore({ getSql: () => sql, ensureSchema: async () => {}, workspaceId: 'ws-other' });
    await store.create(input('shared-id', { body: 'default-ws body' }));

    // Invisible across the boundary…
    expect(await other.get('shared-id')).toBeNull();
    expect(await other.list()).toEqual([]);

    // …the same id is creatable independently (PK is (workspace_id, id))…
    await other.create(input('shared-id', { body: 'other-ws body' }));
    expect((await other.get('shared-id'))?.body).toBe('other-ws body');
    expect((await store.get('shared-id'))?.body).toBe('default-ws body');

    // …and a write scoped to the other workspace is a no-op on this one's row.
    await other.setState('shared-id', 'resolved', { now_ts: T1 });
    expect((await store.get('shared-id'))?.state).toBe('open');
    expect((await other.get('shared-id'))?.state).toBe('resolved');
  });
});

describe('schema setup', () => {
  it('ensureConversationsTable is idempotent: a re-run keeps existing data', async () => {
    await store.create(input('keep'));
    await ensureConversationsTable(sql);
    expect((await store.get('keep'))?.body).toBe('body of keep');
  });
});
