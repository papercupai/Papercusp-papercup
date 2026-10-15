/**
 * message-log-gc.integration.test.ts — gcOldCoordMessages, the physical retention
 * GC over coord_event_log `messages`, both scopes.
 *
 * Proves the WI-401 safety contract: delete fully-aged message threads atomically;
 * keep recent threads, orphan replies, other surfaces, and any thread whose msg_id
 * is referenced by coord_thread_posts.post_msg_id.
 *
 * And the WI-8490 / D-010 extension: harness-scoped (FEDERATED) threads are swept
 * on their OWN shorter horizon rather than kept forever — the DELETE is what emits
 * the federated `del` op that tombstones coord history out of a release seed. A
 * MIXED-scope thread satisfies neither horizon and is kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { gcOldCoordMessages, gcOldPlanEvents, gcTerminalHandoffFamilies } = await import('./message-log-gc');

/** Federated horizon far past every fixture age — isolates the operator branch. */
const FED_NEVER = 10_000;

let rootSql: postgres.Sql;
const remainingIds = async () =>
  (await rootSql<{ msg_id: string }[]>`SELECT msg_id FROM harness_shared.coord_event_log ORDER BY msg_id`).map((r) => r.msg_id);

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `mgc_${randomBytes(5).toString('hex')}`;
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
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      surface text NOT NULL,
      writer_key text,
      msg_id text NOT NULL,
      body jsonb NOT NULL,
      harness_slug text,
      ts timestamptz DEFAULT now() NOT NULL
    )`);
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_thread_posts (
      id bigserial PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      thread_id text NOT NULL,
      author_id text,
      body text NOT NULL,
      created_at timestamptz DEFAULT now() NOT NULL,
      post_msg_id text,
      harness_slug text
    )`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.coord_event_log, harness_shared.coord_thread_posts RESTART IDENTITY`;
});

async function msg(opts: {
  msgId: string;
  ageDays: number;
  relatedTo?: string;
  harness?: string | null;
  surface?: string;
  /** Make it a single-primary CONDITION alarm (health state, not chatter). */
  conditionKey?: string;
}) {
  const body: Record<string, string> = opts.relatedTo
    ? { kind: 'message', msg_id: opts.msgId, related_msg_id: opts.relatedTo }
    : { kind: 'message', msg_id: opts.msgId };
  if (opts.conditionKey) body.condition_key = opts.conditionKey;
  await rootSql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, harness_slug, ts)
    VALUES (${opts.surface ?? 'messages'}, ${opts.msgId}, ${rootSql.json(body)}, ${opts.harness ?? null},
            now() - make_interval(days => ${opts.ageDays}))`;
}

async function planEvent(opts: { msgId: string; ageDays: number }) {
  await rootSql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, ts)
    VALUES ('plan-events', ${opts.msgId}, ${rootSql.json({ kind: 'plan_event', msg_id: opts.msgId })},
            now() - make_interval(days => ${opts.ageDays}))`;
}

async function handoffEvent(opts: {
  msgId: string;
  ageDays: number;
  kind: 'handoff' | 'handoff_accepted' | 'handoff_expired' | 'handoff_repinged';
  relatedTo?: string;
  harness?: string | null;
}) {
  const body: Record<string, string> = { kind: opts.kind, msg_id: opts.msgId };
  if (opts.relatedTo) body.related_msg_id = opts.relatedTo;
  await rootSql`
    INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, harness_slug, ts)
    VALUES ('handoffs', ${opts.msgId}, ${rootSql.json(body)}, ${opts.harness ?? null},
            now() - make_interval(days => ${opts.ageDays}))`;
}

async function postRef(msgId: string) {
  await rootSql`
    INSERT INTO harness_shared.coord_thread_posts (thread_id, author_id, body, post_msg_id)
    VALUES ('thread-1', 'agent', 'post', ${msgId})`;
}

describe('gcOldCoordMessages (PG)', () => {
  it('deletes only fully-aged operator-scope rooted threads, preserving thread/ref safety', async () => {
    await msg({ msgId: 'standalone-old', ageDays: 45 });

    await msg({ msgId: 'thread-old-root', ageDays: 45 });
    await msg({ msgId: 'thread-old-reply', ageDays: 44, relatedTo: 'thread-old-root' });
    await msg({ msgId: 'thread-old-grandchild', ageDays: 43, relatedTo: 'thread-old-reply' });

    await msg({ msgId: 'recent-child-root', ageDays: 45 });
    await msg({ msgId: 'recent-child', ageDays: 1, relatedTo: 'recent-child-root' });

    await msg({ msgId: 'harness-child-root', ageDays: 45 });
    await msg({ msgId: 'harness-child', ageDays: 45, relatedTo: 'harness-child-root', harness: 'peer-hive' });

    await msg({ msgId: 'harness-root', ageDays: 45, harness: 'peer-hive' });
    await msg({ msgId: 'operator-child-of-harness-root', ageDays: 45, relatedTo: 'harness-root' });

    await msg({ msgId: 'orphan-reply', ageDays: 45, relatedTo: 'missing-root' });

    await msg({ msgId: 'post-ref-root', ageDays: 45 });
    await msg({ msgId: 'post-ref-reply', ageDays: 45, relatedTo: 'post-ref-root' });
    await postRef('post-ref-reply');

    await msg({ msgId: 'old-presence', ageDays: 45, surface: 'presence' });

    const r = await gcOldCoordMessages(30, FED_NEVER);
    expect(r).toEqual({ operator: 4, federated: 0, total: 4 }); // standalone + 3-message old thread
    expect(await remainingIds()).toEqual([
      'harness-child',
      'harness-child-root',
      'harness-root',
      'old-presence',
      'operator-child-of-harness-root',
      'orphan-reply',
      'post-ref-reply',
      'post-ref-root',
      'recent-child',
      'recent-child-root',
    ]);
  });

  it('retentionDays controls the fully-aged cutoff', async () => {
    await msg({ msgId: 'root', ageDays: 10 });
    await msg({ msgId: 'reply', ageDays: 10, relatedTo: 'root' });
    expect(await gcOldCoordMessages(14, FED_NEVER)).toEqual({ operator: 0, federated: 0, total: 0 });
    expect(await gcOldCoordMessages(7, FED_NEVER)).toEqual({ operator: 2, federated: 0, total: 2 });
  });

  // ── WI-8490 / D-010: the federated branch ────────────────────────────────────
  // A harness-scoped thread is the one whose DELETE emits a federated `del` op
  // (mig-150 capture_coord_event_del_trg) — the mechanism that tombstones coord
  // history out of a release seed. It is swept on its own, shorter horizon.

  it('sweeps a fully-aged federated thread on the FEDERATED horizon, not the operator one', async () => {
    await msg({ msgId: 'fed-root', ageDays: 10, harness: 'peer-hive' });
    await msg({ msgId: 'fed-reply', ageDays: 9, relatedTo: 'fed-root', harness: 'peer-hive' });

    // 30d operator / 14d federated: 10 days is inside BOTH horizons — nothing goes.
    expect(await gcOldCoordMessages(30, 14)).toEqual({ operator: 0, federated: 0, total: 0 });

    // 30d operator / 7d federated: the operator horizon alone would still keep it,
    // so a deletion here can only have come from the federated branch.
    expect(await gcOldCoordMessages(30, 7)).toEqual({ operator: 0, federated: 2, total: 2 });
    expect(await remainingIds()).toEqual([]);
  });

  it('counts the two scopes separately in one sweep', async () => {
    await msg({ msgId: 'op-old', ageDays: 45 });
    await msg({ msgId: 'fed-old-a', ageDays: 20, harness: 'peer-hive' });
    await msg({ msgId: 'fed-old-b', ageDays: 20, harness: 'other-hive' });
    await msg({ msgId: 'fed-recent', ageDays: 2, harness: 'peer-hive' });
    await msg({ msgId: 'op-recent', ageDays: 2 });

    expect(await gcOldCoordMessages(30, 7)).toEqual({ operator: 1, federated: 2, total: 3 });
    expect(await remainingIds()).toEqual(['fed-recent', 'op-recent']);
  });

  it('keeps a MIXED-scope thread: it satisfies neither horizon', async () => {
    await msg({ msgId: 'mixed-root', ageDays: 400, harness: 'peer-hive' });
    await msg({ msgId: 'mixed-reply', ageDays: 400, relatedTo: 'mixed-root' });

    // Aged far past BOTH horizons and still kept — deleting either half would
    // orphan the other, and there is no defensible single horizon for the pair.
    expect(await gcOldCoordMessages(30, 7)).toEqual({ operator: 0, federated: 0, total: 0 });
    expect(await remainingIds()).toEqual(['mixed-reply', 'mixed-root']);
  });

  it('federated sweep honours the same thread/ref safety as the operator sweep', async () => {
    // A federated thread with a RECENT reply is not fully aged.
    await msg({ msgId: 'fed-live-root', ageDays: 30, harness: 'peer-hive' });
    await msg({ msgId: 'fed-live-reply', ageDays: 1, relatedTo: 'fed-live-root', harness: 'peer-hive' });
    // A federated thread referenced by a thread post must not be orphaned.
    await msg({ msgId: 'fed-post-root', ageDays: 30, harness: 'peer-hive' });
    await postRef('fed-post-root');
    // A federated orphan reply (root already gone) is kept — deleting a fragment
    // cannot improve thread integrity.
    await msg({ msgId: 'fed-orphan', ageDays: 30, relatedTo: 'gone', harness: 'peer-hive' });
    // A federated NON-message surface is out of scope (live coordination state
    // with its own lifecycle collector — see the module's SCOPE note).
    await msg({ msgId: 'fed-escalation', ageDays: 30, harness: 'peer-hive', surface: 'escalations' });

    expect(await gcOldCoordMessages(30, 7)).toEqual({ operator: 0, federated: 0, total: 0 });
    expect(await remainingIds()).toEqual([
      'fed-escalation',
      'fed-live-reply',
      'fed-live-root',
      'fed-orphan',
      'fed-post-root',
    ]);
  });

  it('keeps a federated CONDITION-carrying thread on the LONGER operator horizon', async () => {
    // openSinglePrimaryConditions + the coord conditions fast path both bound their
    // scan at MESSAGE_GC_RETENTION_DAYS because "nothing older survives GC anyway".
    // If federated retention expired condition rows at 7d, an unresolved alarm would
    // vanish from that window and read as RESOLVED rather than as missing.
    await msg({ msgId: 'fed-cond', ageDays: 10, harness: 'peer-hive', conditionKey: 'single-primary:x' });
    await msg({ msgId: 'fed-plain', ageDays: 10, harness: 'peer-hive' });

    expect(await gcOldCoordMessages(30, 7)).toEqual({ operator: 0, federated: 1, total: 1 });
    expect(await remainingIds()).toEqual(['fed-cond']);

    // It is exempt from the FEDERATED horizon, not immortal: it goes once the
    // operator horizon (the health readers' own window) is reached.
    expect(await gcOldCoordMessages(7, 7)).toEqual({ operator: 0, federated: 1, total: 1 });
    expect(await remainingIds()).toEqual([]);
  });

  it('takes threads OLDEST-FIRST under threadLimit so a large drain converges', async () => {
    await msg({ msgId: 'fed-age-10', ageDays: 10, harness: 'peer-hive' });
    await msg({ msgId: 'fed-age-30', ageDays: 30, harness: 'peer-hive' });
    await msg({ msgId: 'fed-age-20', ageDays: 20, harness: 'peer-hive' });

    expect(await gcOldCoordMessages(30, 7, 1)).toEqual({ operator: 0, federated: 1, total: 1 });
    expect(await remainingIds()).toEqual(['fed-age-10', 'fed-age-20']); // the 30d one went first

    expect(await gcOldCoordMessages(30, 7, 1)).toEqual({ operator: 0, federated: 1, total: 1 });
    expect(await remainingIds()).toEqual(['fed-age-10']);
  });

  it('sweeps old plan-events only, with a row limit so the backlog converges', async () => {
    await planEvent({ msgId: 'plan-old-1', ageDays: 45 });
    await planEvent({ msgId: 'plan-old-2', ageDays: 45 });
    await planEvent({ msgId: 'plan-old-3', ageDays: 45 });
    await planEvent({ msgId: 'plan-recent', ageDays: 2 });
    await msg({ msgId: 'message-old', ageDays: 45 });

    expect(await gcOldPlanEvents(30, 2)).toBe(2);
    expect(await remainingIds()).toEqual(['message-old', 'plan-old-3', 'plan-recent']);

    expect(await gcOldPlanEvents(30, 2)).toBe(1);
    expect(await remainingIds()).toEqual(['message-old', 'plan-recent']);
  });

  it('deletes only fully-aged terminal operator-scope handoff families', async () => {
    await handoffEvent({ msgId: 'handoff-accepted-old', ageDays: 45, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-accepted-old-status', ageDays: 44, kind: 'handoff_accepted',
      relatedTo: 'handoff-accepted-old',
    });

    await handoffEvent({ msgId: 'handoff-expired-old', ageDays: 45, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-expired-old-status', ageDays: 44, kind: 'handoff_expired',
      relatedTo: 'handoff-expired-old',
    });
    await handoffEvent({
      msgId: 'handoff-expired-old-reping', ageDays: 43, kind: 'handoff_repinged',
      relatedTo: 'handoff-expired-old',
    });

    await handoffEvent({ msgId: 'handoff-open-old', ageDays: 45, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-open-old-reping', ageDays: 44, kind: 'handoff_repinged',
      relatedTo: 'handoff-open-old',
    });

    await handoffEvent({ msgId: 'handoff-recent', ageDays: 2, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-recent-status', ageDays: 1, kind: 'handoff_accepted',
      relatedTo: 'handoff-recent',
    });

    await handoffEvent({ msgId: 'handoff-fed-old', ageDays: 45, kind: 'handoff', harness: 'peer-hive' });
    await handoffEvent({
      msgId: 'handoff-fed-old-status', ageDays: 44, kind: 'handoff_accepted',
      relatedTo: 'handoff-fed-old', harness: 'peer-hive',
    });

    // A mixed-scope family is protected as a whole; deleting the local half
    // would leave a federated sibling with no local family root.
    await handoffEvent({ msgId: 'handoff-mixed-old', ageDays: 45, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-mixed-old-status', ageDays: 44, kind: 'handoff_accepted',
      relatedTo: 'handoff-mixed-old', harness: 'peer-hive',
    });

    await msg({ msgId: 'other-old', ageDays: 45, surface: 'presence' });

    expect(await gcTerminalHandoffFamilies(30)).toBe(5);
    expect(await remainingIds()).toEqual([
      'handoff-fed-old',
      'handoff-fed-old-status',
      'handoff-mixed-old',
      'handoff-mixed-old-status',
      'handoff-open-old',
      'handoff-open-old-reping',
      'handoff-recent',
      'handoff-recent-status',
      'other-old',
    ]);
  });

  it('limits terminal handoff GC by family, not individual rows', async () => {
    await handoffEvent({ msgId: 'handoff-cap-a', ageDays: 45, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-cap-a-status', ageDays: 44, kind: 'handoff_expired',
      relatedTo: 'handoff-cap-a',
    });
    await handoffEvent({ msgId: 'handoff-cap-b', ageDays: 40, kind: 'handoff' });
    await handoffEvent({
      msgId: 'handoff-cap-b-status', ageDays: 39, kind: 'handoff_accepted',
      relatedTo: 'handoff-cap-b',
    });

    expect(await gcTerminalHandoffFamilies(30, 1)).toBe(2);
    expect(await remainingIds()).toEqual(['handoff-cap-b', 'handoff-cap-b-status']);
    expect(await gcTerminalHandoffFamilies(30, 1)).toBe(2);
    expect(await remainingIds()).toEqual([]);
  });
});
