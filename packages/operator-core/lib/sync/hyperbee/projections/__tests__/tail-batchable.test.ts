/**
 * p2p-join-catchup-speed-2026-09-23 P-537 (D-034 #2): the frequent tail tables fold inside
 * the merge's batch transaction.
 *
 * Before P-537 only engineer-issues declared `batchable`, so every coord-messages,
 * features-by-id, plan-parts, coord-thread-posts or coord-threads op (49% of the run-7
 * tail) committed the open batch and then autocommitted alone. These tests pin the
 * `batchable` contract for each of the five: every statement runs on the batch handle,
 * a caught statement error recovers the op before the next statement, and every effect
 * that makes another reader look for the op's row waits for the commit. The batch's own
 * after-commit protocol (run after COMMIT, dropped on a lost batch) is pinned in
 * read-merge-batch-apply.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => true }));

import { runInProjectionBatch, type ProjectionBatchSession, type ProvenanceContext } from '../../projection';
import { buildCoordThreadProjection, type CoordThreadRow } from '../coord-thread';
import { buildCoordThreadPostProjection, type CoordThreadPostRow } from '../coord-thread-post';
import { buildHarnessFeaturesProjection, type HarnessFeatureRow } from '../harness-features';
import { buildCoordMessageProjection, type CoordMessageRow } from '../coord-message';
import { buildHarnessPlanPartsProjection, type PlanPartWireRow } from '../harness-plan-parts';

const SLUG = 'papercusp';

/**
 * A handle that records each statement as `<name>: <first words>` in the shared `log`.
 * `respond` picks a statement's rows, or an Error to fail it.
 */
function fakeSql(name: string, log: string[], respond: (text: string) => unknown[] | Error = () => []): postgres.Sql {
  const run = (text: string) => {
    const words = text.replace(/\s+/g, ' ').trim();
    log.push(`${name}: ${words.slice(0, 48)}`);
    const r = respond(words);
    const p = r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    p.catch(() => {});
    return p;
  };
  const fn = (strings: TemplateStringsArray) => run(strings.join('$'));
  return Object.assign(fn, { unsafe: (text: string) => run(text) }) as unknown as postgres.Sql;
}

/** The statements (not fragments) one handle ran, in order. */
function statementsOf(log: string[], name: string): string[] {
  return log.filter((l) => new RegExp(`^${name}: (INSERT|UPDATE|DELETE|SELECT)`).test(l));
}

/**
 * A merge batch session over `batch`. With `queue`, it holds after-commit effects like an
 * open transaction does; without, the op's writes count as autocommitted.
 */
function fakeSession(batch: postgres.Sql, log: string[], queue?: (() => Promise<void>)[]): ProjectionBatchSession {
  return {
    sqlFor: async () => batch,
    flush: async () => {
      log.push('session: flush');
    },
    recover: async () => {
      log.push('session: recover');
    },
    ...(queue
      ? {
          afterCommit: (fn: () => Promise<void>) => {
            log.push('session: afterCommit');
            queue.push(fn);
            return true;
          },
        }
      : {}),
  };
}

const remote: ProvenanceContext = { origin: 'remote', authorPubkey: 'pk-remote', ts: 2_000 };

const thread: CoordThreadRow = {
  harness_slug: SLUG,
  thread_id: 't-1',
  parent_kind: 'plan',
  parent_ref: 'p2p-join-catchup-speed-2026-09-23',
  title: null,
  created_by: null,
  created_at: 1_000,
  last_post_at: 1_500,
  post_count: 1,
};

const post: CoordThreadPostRow = {
  harness_slug: SLUG,
  post_msg_id: 'm-1',
  thread_id: 't-1',
  author_id: null,
  body: 'hello',
  created_at: 1_000,
};

const feature: HarnessFeatureRow = {
  harness_slug: SLUG,
  feature_id: 'F-001',
  title: 'Auth flow',
  summary: null,
  status: 'in_queue',
  attempts: 0,
  claims: null,
  notes: null,
  metadata: null,
  kind: 'feature',
  project_id: null,
  expected_cost_cents: null,
  tags: null,
  needs_human_review: false,
  ts: 1_000,
  created_ts: 1_000,
  updated_ts: 1_000,
  parent_id: null,
  goal_id: null,
  taken_by: null,
  taken_at: null,
  expires_at: null,
};

function message(body: Record<string, unknown> = {}): CoordMessageRow {
  return {
    harness_slug: SLUG,
    msg_id: 'mq-reply',
    surface: 'messages',
    writer_key: 'su-2',
    body: { ts: '2026-09-25T00:00:00Z', msg_id: 'mq-reply', from: 'su-2', to: ['su-1'], kind: 'message', summary: 'hi', ...body },
    ts: 1_000,
  };
}

const part: PlanPartWireRow = {
  harness_slug: SLUG,
  plan_slug: 'plan-a',
  part_key: 'P-001',
  kind: 'item',
  body: '- [ ] P-001 do it',
  ordinal: 1,
  tombstone: false,
};

describe('P-537: the frequent tail projections fold inside the merge batch', () => {
  it('all five declare batchable', () => {
    const opts = { workspaceId: 'w', harnessSlug: SLUG };
    for (const p of [
      buildCoordThreadProjection(opts),
      buildCoordThreadPostProjection(opts),
      buildHarnessFeaturesProjection(opts),
      buildCoordMessageProjection(opts),
      buildHarnessPlanPartsProjection(opts),
    ]) {
      expect(p.batchable, p.tableTag).toBe(true);
    }
  });

  it('coord-threads and coord-thread-posts: put and delete run on the batch handle', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log);
    const batch = fakeSql('batch', log);
    const threads = buildCoordThreadProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: plain });
    const posts = buildCoordThreadPostProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: plain });
    await runInProjectionBatch(fakeSession(batch, log), async () => {
      await threads.writeToPg(thread, remote);
      await threads.deleteFromPg('t-1', 3_000);
      await posts.writeToPg(post, remote);
      await posts.deleteFromPg('m-1', 3_000);
    });
    expect(statementsOf(log, 'plain')).toEqual([]);
    expect(statementsOf(log, 'batch').map((s) => s.split(' ').slice(1, 4).join(' '))).toEqual([
      'INSERT INTO harness_shared.coord_threads',
      'DELETE FROM harness_shared.coord_threads',
      'INSERT INTO harness_shared.coord_thread_posts',
      'DELETE FROM harness_shared.coord_thread_posts',
    ]);
  });

  it('features-by-id: a failed verified-author read recovers the op, then the row is still written on the batch', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log);
    const batch = fakeSql('batch', log, (text) =>
      text.startsWith('SELECT github_user_id') ? Object.assign(new Error('relation does not exist'), { code: '42P01' }) : [],
    );
    const features = buildHarnessFeaturesProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: plain });
    await runInProjectionBatch(fakeSession(batch, log), async () => {
      await features.writeToPg(feature, remote);
      await features.deleteFromPg('F-001', 3_000);
    });
    expect(statementsOf(log, 'plain')).toEqual([]);
    const order = log.filter((l) => l.startsWith('session: ') || /^batch: (INSERT|DELETE|SELECT)/.test(l));
    // Inside the batch the failed read aborted the transaction: the op rolls back to its
    // savepoint before the upsert, or every later statement would fail with 25P02. After
    // recovery the distinct-entity existence read (WI-6327) still runs on the batch handle.
    expect(order.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual([
      'batch: SELECT',
      'session: recover',
      'batch: SELECT',
      'batch: INSERT',
      'batch: DELETE',
    ]);
    expect(order[2]).toContain('SELECT harness_slug, created_ts');
  });

  it('features-by-id: a local row skips the author read and needs no recovery', async () => {
    const log: string[] = [];
    const batch = fakeSql('batch', log);
    const features = buildHarnessFeaturesProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: fakeSql('plain', log) });
    await runInProjectionBatch(fakeSession(batch, log), () => features.writeToPg(feature, { origin: 'local', authorPubkey: '' }));
    // Only the distinct-entity existence read (WI-6327) precedes the upsert; no verified-author read.
    const batchStatements = statementsOf(log, 'batch');
    expect(batchStatements.map((s) => s.split(' ')[1])).toEqual(['SELECT', 'INSERT']);
    expect(batchStatements[0]).toContain('SELECT harness_slug, created_ts');
    expect(log).not.toContain('session: recover');
  });

  it('coord-messages: the row lands on the batch, and the reply-wake lookup waits for the commit on the plain handle', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log);
    const batch = fakeSql('batch', log, (text) => (text.startsWith('INSERT') ? [{ inserted: true }] : []));
    const messages = buildCoordMessageProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: plain });
    const queue: (() => Promise<void>)[] = [];
    await runInProjectionBatch(fakeSession(batch, log, queue), () =>
      messages.writeToPg(message({ related_msg_id: 'mq-original' }), remote),
    );
    // Inside the batch the new row is invisible to other connections, so nothing that
    // makes a reader look for it may run yet.
    expect(statementsOf(log, 'batch').map((s) => s.split(' ').slice(1, 3).join(' '))).toEqual([
      'INSERT INTO',
    ]);
    expect(statementsOf(log, 'plain')).toEqual([]);
    expect(queue).toHaveLength(1);

    // COMMIT: the effect runs, on the plain handle (the batch one is dead by then).
    await queue[0]!();
    expect(statementsOf(log, 'plain').map((s) => s.split(' ').slice(1, 4).join(' '))).toEqual([
      'SELECT body FROM',
    ]);
  });

  it('coord-messages: outside a batch the effects run inline, as the serial path did', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log, (text) => (text.startsWith('INSERT') ? [{ inserted: true }] : []));
    const messages = buildCoordMessageProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: plain });
    await messages.writeToPg(message({ related_msg_id: 'mq-original' }), remote);
    expect(statementsOf(log, 'plain').map((s) => s.split(' ')[1])).toEqual(['INSERT', 'SELECT']);
  });

  it('coord-messages: a replayed (not fresh) row queues no effect', async () => {
    const log: string[] = [];
    const batch = fakeSql('batch', log, () => []);
    const messages = buildCoordMessageProjection({ workspaceId: 'w', harnessSlug: SLUG, sql: fakeSql('plain', log) });
    const queue: (() => Promise<void>)[] = [];
    await runInProjectionBatch(fakeSession(batch, log, queue), () =>
      messages.writeToPg(message({ related_msg_id: 'mq-original' }), remote),
    );
    expect(queue).toHaveLength(0);
  });

  it('coord-messages: the quarantine path commits the batch before it writes on another connection', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log);
    const batch = fakeSql('batch', log);
    const messages = buildCoordMessageProjection({
      workspaceId: 'w',
      harnessSlug: SLUG,
      sql: plain,
      potHomeSlug: SLUG,
      resolveAuthorDevice: () => 'device-1',
      resolveCommsTier: async () => ({ tier: 'observe', githubUserId: 7 }),
    });
    await runInProjectionBatch(fakeSession(batch, log, []), () => messages.writeToPg(message(), remote));
    const order = log.filter((l) => l.startsWith('session: ') || /^(plain|batch): (INSERT|UPDATE|DELETE|SELECT)/.test(l));
    expect(order[0]).toBe('session: flush');
    expect(order.slice(1).every((l) => l.startsWith('plain: '))).toBe(true);
    expect(order.length).toBeGreaterThan(1);
    expect(statementsOf(log, 'batch')).toEqual([]);
  });

  it('plan-parts: the part write runs on the batch and the recompose waits for the commit', async () => {
    const log: string[] = [];
    const plain = fakeSql('plain', log);
    const batch = fakeSql('batch', log);
    const recomposed: string[] = [];
    const parts = buildHarnessPlanPartsProjection({
      workspaceId: 'w',
      harnessSlug: SLUG,
      sql: plain,
      isFlagOn: async () => true,
      readLocalContent: async () => null,
      recomposeSink: async (planSlug) => {
        recomposed.push(planSlug);
      },
    });
    const queue: (() => Promise<void>)[] = [];
    await runInProjectionBatch(fakeSession(batch, log, queue), async () => {
      await parts.writeToPg(part, remote);
      await parts.deleteFromPg('plan-a/P-002', 3_000);
    });
    expect(statementsOf(log, 'batch').map((s) => s.split(' ')[1])).toEqual(['SELECT', 'INSERT', 'INSERT']);
    expect(statementsOf(log, 'plain')).toEqual([]);
    expect(recomposed).toEqual([]);
    expect(queue).toHaveLength(2);

    // COMMIT: each recompose re-reads the merged parts on the plain handle.
    for (const fn of queue) await fn();
    expect(recomposed).toEqual(['plan-a', 'plan-a']);
    expect(statementsOf(log, 'plain').map((s) => s.split(' ')[1])).toEqual(['SELECT', 'SELECT']);
  });

  it('plan-parts: a failed baseline read recovers the op before the part write', async () => {
    const log: string[] = [];
    const batch = fakeSql('batch', log, (text) => (text.startsWith('SELECT') ? new Error('statement timeout') : []));
    const parts = buildHarnessPlanPartsProjection({
      workspaceId: 'w',
      harnessSlug: SLUG,
      sql: fakeSql('plain', log),
      isFlagOn: async () => true,
      readLocalContent: async () => null,
      recomposeSink: async () => {},
    });
    await runInProjectionBatch(fakeSession(batch, log, []), () => parts.writeToPg(part, remote));
    const order = log.filter((l) => l.startsWith('session: recover') || /^batch: (INSERT|SELECT)/.test(l));
    expect(order.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['batch: SELECT', 'session: recover', 'batch: INSERT']);
  });
});
