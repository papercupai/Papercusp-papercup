/**
 * Blocker auto-clear against a real Postgres (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * The unit test (work-item-ref-blocker-auto-clear.test.ts) drives the clear through a fake
 * transaction, so it never runs the SQL. This file runs `clearBlockersNamingFinishedWorkItems`
 * inside a real transaction over a scratch `harness_shared.work_items` holding the columns the
 * clear reads and writes, plus the real migration 1475 index.
 *
 * Clauses under test:
 *   AUTO-BAR-R-10-P-011 — when a work item referenced by another item's blocker reaches a
 *     terminal state, the blocker is cleared with history preserved.
 *   SPEC-P-011 — a blocker that references a non-terminal work item stays set.
 *
 * Plan event-wait-settlement-2026-10-20 P-003 — the second describe drives the REAL announced
 * settlement (registerAnnouncement → stampAnnouncementsFired / retireAnnouncement) over the
 * real work-items store and the production follow-up; only the coord transport ends
 * (sendMessage, wakeRecipients) are spied:
 *   AUTO-BAR-R-4-P-003 — a feature-family item returns from blocked to open when the system
 *     clears its last blocker.
 *   AUTO-BAR-R-5-P-003 — the holder receives a waking coord message when the system clears
 *     the item's last blocker, on every settlement path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  ADV_SESSIONS_CLAIM_MIN_DDL,
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  WORK_ITEM_DEPS_DDL,
  applyClaimPathReadDeps,
} from '../test/_work-items-schema';
import { BLOCKER_AUTO_CLEAR_ACTOR, clearBlockersNamingFinishedWorkItems } from './work-item-ref-blocker-auto-clear';
import type { WorkItem } from './work-items';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  sendMessage: vi.fn(async () => ({})),
  wakeRecipients: vi.fn(async () => ({})),
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-registry')>()),
  activeWorkspaceId: () => 'default',
}));
vi.mock('./agent-tools/coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/messages')>()),
  sendMessage: h.sendMessage,
}));
vi.mock('./agent-tools/coordination/inbox-wake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/inbox-wake')>()),
  wakeRecipients: h.wakeRecipients,
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const armed = path.join(sqlDir, '1475-work-items-external-blockers-partial-idx.sql');
const migrationPath = existsSync(armed) ? armed : `${armed}.DRAFT`;

const WS = 'ws-a';
const OTHER_WS = 'ws-b';
const T0 = '2026-10-12T10:00:00.000Z';
const NOW = '2026-10-12T18:45:00.000Z';

let sql: postgres.Sql;
let adminUri: string;
let dbName: string;

function blocker(ref: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'runtime',
    capability: 'live-dependency',
    capabilitySource: 'explicit',
    ref,
    summary: `waiting on ${ref}`,
    status: 'active',
    createdAt: T0,
    createdBy: 'su-blocked-holder',
    updatedAt: T0,
    ...over,
  };
}

/** An issue that `work_items:set_blocker` auto-parked. */
function parkedIssuePayload(blockers: unknown[]) {
  return { externalBlockers: blockers, held_open_reason: 'blocked', held_open_by: 'su-x', _claimHold: { by: 'su-x' } };
}

async function insert(row: {
  ws?: string;
  id: string;
  kind?: string;
  status: string;
  payload?: Record<string, unknown>;
  takenBy?: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, feature_id, item_kind, status, payload, harness_slug, taken_by, updated_ts)
    VALUES (${row.ws ?? WS}, ${row.id}, ${row.kind ?? 'bug'}, ${row.status},
            ${sql.json((row.payload ?? {}) as postgres.JSONValue)}, 'papercusp', ${row.takenBy ?? 'su-blocked-holder'}, 0)`;
}

async function read(id: string, ws = WS) {
  const [row] = await sql<{ status: string; payload: Record<string, unknown>; updated_ts: string }[]>`
    SELECT status, payload, updated_ts FROM harness_shared.work_items WHERE workspace_id = ${ws} AND feature_id = ${id}`;
  return row!;
}

function blockersOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return payload.externalBlockers as Array<Record<string, unknown>>;
}

async function runClear(ids: string[]) {
  return sql.begin((tx) =>
    clearBlockersNamingFinishedWorkItems(tx as unknown as postgres.TransactionSql, { workspaceId: WS, ids, now: NOW }),
  );
}

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `blocker_auto_clear_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, item_kind text, status text,
      payload jsonb DEFAULT '{}'::jsonb, harness_slug text, taken_by text, updated_ts bigint,
      PRIMARY KEY (workspace_id, feature_id)
    );
  `);
  await sql.unsafe(readFileSync(migrationPath, 'utf8'));

  // The work items the blockers name.
  await insert({ id: 'WI-9', kind: 'feature', status: 'done' });
  await insert({ id: 'WI-8', kind: 'feature', status: 'wip' });
  await insert({ id: 'WI-90', kind: 'feature', status: 'wip' });
  await insert({ id: 'WI-7', kind: 'feature', status: 'dropped' });

  // EI-1: qualified ref naming the finished item → cleared, issue restored.
  await insert({ id: 'EI-1', status: 'blocked', payload: parkedIssuePayload([blocker('root-disk-headroom / WI-9')]) });
  // EI-2: ref names WI-90; the LIKE prefilter matches it, the whole-token check must not.
  await insert({ id: 'EI-2', status: 'blocked', payload: parkedIssuePayload([blocker('WI-90')]) });
  // EI-3: names a finished AND a still-open item → stays.
  await insert({ id: 'EI-3', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9 + WI-8')]) });
  // EI-4: an owner ask that mentions the finished item → stays.
  await insert({
    id: 'EI-4',
    status: 'blocked',
    payload: parkedIssuePayload([blocker('owner signs off on WI-9', { kind: 'human', capability: 'product-decision' })]),
  });
  // EI-5: same blocker in another workspace → untouched.
  await insert({ ws: OTHER_WS, id: 'EI-5', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9')]) });
  // EI-6: already terminal → not selected.
  await insert({ id: 'EI-6', status: 'done', payload: parkedIssuePayload([blocker('WI-9')]) });
  // WI-20: feature with a second active blocker → one cleared, status untouched.
  await insert({
    id: 'WI-20',
    kind: 'feature',
    status: 'blocked',
    payload: { externalBlockers: [blocker('WI-9'), blocker('gate:release', { kind: 'gate' })] },
  });
  // EI-7: names a finished item and a dropped one → cleared, the dropped id reported.
  await insert({ id: 'EI-7', status: 'blocked', payload: parkedIssuePayload([blocker('WI-9 and WI-7')]) });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
});

describe('clearBlockersNamingFinishedWorkItems against Postgres', () => {
  it('AUTO-BAR-R-10: clears only satisfied live-dependency blockers, keeps history and restores parked issues', async () => {
    const out = await runClear(['WI-9']);

    expect(out.map((item) => item.featureId).sort()).toEqual(['EI-1', 'EI-7', 'WI-20']);
    const byId = new Map(out.map((item) => [item.featureId, item]));
    expect(byId.get('EI-1')).toMatchObject({ family: 'issue', status: 'open', restored: true, activeRemaining: 0 });
    expect(byId.get('EI-7')!.cleared[0]).toMatchObject({ namedIds: ['WI-9', 'WI-7'], endedWithoutDone: ['WI-7'] });
    expect(byId.get('WI-20')).toMatchObject({ family: 'feature', status: 'blocked', restored: false, activeRemaining: 1 });

    const ei1 = await read('EI-1');
    expect(ei1.status).toBe('open');
    expect(ei1.payload).not.toHaveProperty('held_open_reason');
    expect(ei1.payload).not.toHaveProperty('_claimHold');
    expect(Number(ei1.updated_ts)).toBe(Date.parse(NOW));
    // History kept: the record is still there, marked cleared, original fields intact.
    expect(blockersOf(ei1.payload)).toEqual([
      expect.objectContaining({
        ref: 'root-disk-headroom / WI-9',
        createdAt: T0,
        createdBy: 'su-blocked-holder',
        status: 'cleared',
        clearedAt: NOW,
        clearedBy: BLOCKER_AUTO_CLEAR_ACTOR,
        evidence: 'auto-cleared: WI-9 is done',
      }),
    ]);

    const wi20 = await read('WI-20');
    expect(wi20.status).toBe('blocked');
    expect(blockersOf(wi20.payload).map((b) => [b.ref, b.status])).toEqual([
      ['WI-9', 'cleared'],
      ['gate:release', 'active'],
    ]);
  });

  it('SPEC-P-011: leaves blockers naming a non-terminal item, owner asks, other workspaces and terminal rows alone', async () => {
    for (const id of ['EI-2', 'EI-3', 'EI-4']) {
      const row = await read(id);
      expect(row.status, id).toBe('blocked');
      expect(row.payload, id).toHaveProperty('held_open_reason', 'blocked');
      expect(blockersOf(row.payload).every((b) => b.status === 'active'), id).toBe(true);
      expect(Number(row.updated_ts), id).toBe(0);
    }
    const other = await read('EI-5', OTHER_WS);
    expect(blockersOf(other.payload)[0]).toMatchObject({ status: 'active' });
    expect(Number(other.updated_ts)).toBe(0);
    const terminal = await read('EI-6');
    expect(blockersOf(terminal.payload)[0]).toMatchObject({ status: 'active' });
  });

  it('SPEC-P-011: clears the multi-item blocker once its last named item finishes, and is idempotent', async () => {
    expect(await runClear(['WI-9'])).toEqual([]);

    await sql`UPDATE harness_shared.work_items SET status = 'done' WHERE workspace_id = ${WS} AND feature_id = 'WI-8'`;
    const out = await runClear(['WI-8']);
    expect(out.map((item) => item.featureId)).toEqual(['EI-3']);
    const ei3 = await read('EI-3');
    expect(ei3.status).toBe('open');
    expect(blockersOf(ei3.payload)[0]).toMatchObject({ status: 'cleared', evidence: 'auto-cleared: WI-9 is done, WI-8 is done' });
  });

  it('migration 1475: the clear predicate can use the partial index', async () => {
    const plan = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      return tx.unsafe(
        `EXPLAIN SELECT feature_id FROM harness_shared.work_items wi
          WHERE wi.workspace_id = 'ws-a' AND wi.payload ? 'externalBlockers'`,
      );
    });
    const text = plan.map((row) => String((row as Record<string, unknown>)['QUERY PLAN'])).join('\n');
    expect(text).toContain('work_items_external_blockers_ws_idx');
  });
});

describe('announced settlement runs the shared follow-up (event-wait-settlement-2026-10-20 P-003)', () => {
  const H = 'papercusp';
  const WS_DEFAULT = 'default';
  let db: FreshPgDb;
  let store: typeof import('./events/await/store');
  let engine: typeof import('./events/await/engine');

  /** A complete stored event blocker record (readExternalBlockers drops incomplete ones). */
  const eventBlocker = (ref: string) => ({
    kind: 'event', capability: 'live-dependency', capabilitySource: 'explicit', ref, summary: `waits on ${ref}`,
    status: 'active', createdAt: T0, createdBy: 'su-p003-holder', updatedAt: T0,
  });

  async function seed(row: { id: string; kind: string; status: string; takenBy: string | null; payload: unknown }) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (harness_slug, feature_id, item_kind, title, status, taken_by, workspace_id, created_ts, updated_ts, payload)
      VALUES (${H}, ${row.id}, ${row.kind}, ${`title ${row.id}`}, ${row.status}, ${row.takenBy}, ${WS_DEFAULT}, 100, 0,
              ${JSON.stringify(row.payload)}::text::jsonb)`;
  }

  async function rowOf(id: string) {
    const [row] = await db.sql<{ status: string; payload: Record<string, unknown> }[]>`
      SELECT status, payload FROM harness_shared.work_items WHERE workspace_id = ${WS_DEFAULT} AND feature_id = ${id}`;
    return { status: row!.status, payload: row!.payload, blockers: (row!.payload.externalBlockers ?? []) as Array<Record<string, unknown>> };
  }

  /** The one coord message the follow-up sent, with its identity and options. */
  function sentMessage() {
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    return h.sendMessage.mock.calls[0] as unknown as [
      { ownerId: string; workspaceId: string },
      { to: string[]; summary: string; body: string; harnessSlug: string },
    ];
  }

  beforeAll(async () => {
    db = await createFreshPgDb('ews-p003-follow-up');
    h.sql = db.sql;
    await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
    await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
    await db.sql.unsafe(ADV_SESSIONS_CLAIM_MIN_DDL);
    await ensureCoordCapabilityTables(db.sql);
    await applyEventSubstrateMigrationsForTest(db.sql, { label: 'work-item-ref-blocker-auto-clear.integration.test.ts' });
    // Durable-park settlement writes its receipt here (writeDurableParkClearReceipt).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
        id text PRIMARY KEY, ts bigint, actor text, action text, subject text,
        details jsonb, workspace_id text)`).simple();
    store = await import('./events/await/store');
    // P-004 drives the real emit; no wake pump runs against this bare database.
    engine = await import('./events/await/engine');
    engine.setAutoPumpEnabledForTests(false);
  }, 180_000);
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(() => {
    h.sendMessage.mockClear();
    h.wakeRecipients.mockClear();
  });

  it('AUTO-BAR-R-4-P-003 + AUTO-BAR-R-5-P-003: a fired announced key returns the parked feature to open and wakes its holder', async () => {
    const key = 'work-item:done:WI-p003-upstream';
    await seed({ id: 'WI-p003-feature', kind: 'feature', status: 'blocked', takenBy: 'su-p003-holder',
      payload: { externalBlockers: [eventBlocker(key)], sibling: 'kept' } });
    await store.registerAnnouncement({ subscriberId: 'su-p003-producer', eventKey: key, scopeKind: 'global' });

    expect(await store.stampAnnouncementsFired(key, { firedBy: 'su-p003-producer' })).toBe(1);

    const after = await rowOf('WI-p003-feature');
    expect(after.status).toBe('open');
    expect(after.payload.sibling).toBe('kept');
    expect(after.blockers).toEqual([expect.objectContaining({ ref: key, status: 'cleared', clearedBy: 'su-p003-producer' })]);

    const [identity, opts] = sentMessage();
    expect(identity).toMatchObject({ ownerId: BLOCKER_AUTO_CLEAR_ACTOR, workspaceId: WS_DEFAULT });
    expect(opts).toMatchObject({ to: ['su-p003-holder'], harnessSlug: H });
    expect(opts.summary).toContain('WI-p003-feature');
    expect(opts.body).toContain('No active blocker remains on WI-p003-feature.');
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p003-holder'],
      expect.objectContaining({ summary: opts.summary, workspaceId: WS_DEFAULT }));
  });

  it('AUTO-BAR-R-4-P-003: a feature with another active blocker stays blocked, and its holder still hears', async () => {
    const key = 'work-item:done:WI-p003-first';
    await seed({ id: 'WI-p003-two-waits', kind: 'feature', status: 'blocked', takenBy: 'su-p003-holder',
      payload: { externalBlockers: [eventBlocker(key), eventBlocker('work-item:done:WI-p003-second')] } });
    await store.registerAnnouncement({ subscriberId: 'su-p003-producer', eventKey: key, scopeKind: 'global' });

    expect(await store.stampAnnouncementsFired(key, { firedBy: 'su-p003-producer' })).toBe(1);

    const after = await rowOf('WI-p003-two-waits');
    expect(after.status).toBe('blocked');
    expect(after.blockers.map((b) => [b.ref, b.status])).toEqual([
      [key, 'cleared'],
      ['work-item:done:WI-p003-second', 'active'],
    ]);
    const [, opts] = sentMessage();
    expect(opts.body).toContain('1 other active blocker(s) still hold WI-p003-two-waits');
    expect(h.wakeRecipients).toHaveBeenCalledTimes(1);
  });

  it('AUTO-BAR-R-5-P-003: a fired park trigger releases the durable park and tells the agent that parked it', async () => {
    const key = 'work-item:done:WI-p003-park-upstream';
    await seed({ id: 'EI-p003-park', kind: 'bug', status: 'open', takenBy: null,
      payload: { _claimHold: true, claim_hold_by: 'su-p003-parker', claim_hold_release: { trigger: key } } });
    await store.registerAnnouncement({ subscriberId: 'su-p003-producer', eventKey: key, scopeKind: 'global' });

    expect(await store.stampAnnouncementsFired(key, { firedBy: 'su-p003-producer' })).toBe(1);

    const after = await rowOf('EI-p003-park');
    expect(after.payload).not.toHaveProperty('claim_hold_by');
    expect(after.payload).not.toHaveProperty('_claimHold');
    const [, opts] = sentMessage();
    expect(opts.to).toEqual(['su-p003-parker']);
    expect(opts.summary.startsWith('Park released on EI-p003-park:')).toBe(true);
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p003-parker'], expect.objectContaining({ workspaceId: WS_DEFAULT }));
  });

  it('AUTO-BAR-R-5-P-003: retiring an announcement settles the auto-parked issue and wakes its holder', async () => {
    const key = 'work-item:done:WI-p003-retired';
    await seed({ id: 'EI-p003-retire', kind: 'bug', status: 'blocked', takenBy: 'su-p003-issue-holder',
      payload: { externalBlockers: [eventBlocker(key)], held_open_reason: 'blocked', held_open_by: 'su-x' } });
    const announcement = await store.registerAnnouncement({ subscriberId: 'su-p003-declarer', eventKey: key, scopeKind: 'global' });

    const retired = await store.retireAnnouncement({ announcementId: Number(announcement.id), subscriberId: 'su-p003-declarer' });

    expect(retired).toMatchObject({ retired: true, eventKey: key });
    expect((await rowOf('EI-p003-retire')).status).toBe('open');
    const [, opts] = sentMessage();
    expect(opts.to).toEqual(['su-p003-issue-holder']);
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p003-issue-holder'], expect.anything());
  });

  // event-wait-settlement-2026-10-20 P-004: the same follow-up on an UNANNOUNCED proving fire,
  // through the real emit — the latch statement finds the waiter, then settlement runs.
  it('AUTO-BAR-R-4-P-004: one unannounced emit of a proving key returns the parked feature to open and wakes its holder', async () => {
    const key = 'release:deployed:9c1e7f00';
    await seed({ id: 'WI-p004-feature', kind: 'feature', status: 'blocked', takenBy: 'su-p004-holder',
      payload: { externalBlockers: [eventBlocker(key)] } });
    expect(await store.findAnnouncementsForKey(key)).toEqual([]);

    const emitted = await engine.emitAwaitedEvent({ key, source: 'release-gate' });

    expect(emitted.ok).toBe(true);
    const after = await rowOf('WI-p004-feature');
    expect(after.status).toBe('open');
    expect(after.blockers).toEqual([expect.objectContaining({
      ref: key, status: 'cleared', clearedBy: 'release-gate', evidence: `event "${key}" fired`,
    })]);
    const [, opts] = sentMessage();
    expect(opts.to).toEqual(['su-p004-holder']);
    expect(opts.body).toContain('No active blocker remains on WI-p004-feature.');
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p004-holder'], expect.objectContaining({ workspaceId: WS_DEFAULT }));
  });

  // event-wait-settlement-2026-10-20 P-007 (Design 7): the completion fire itself clears the
  // live-dependency blockers naming the finished item. Each case finishes the upstream with a
  // bare SQL write, so no work_items:complete / set_state tool reaction can run, which is what a
  // plans:set-status cascade or a drop looks like to this module. It then publishes
  // work-item:done through the real producer every terminal transition goes through
  // (emitWorkItemDoneEvent), into the real emit.
  const dependencyBlocker = (ref: string) => ({
    kind: 'runtime', capability: 'live-dependency', capabilitySource: 'explicit', ref, summary: `waits on ${ref}`,
    status: 'active', createdAt: T0, createdBy: 'su-p007-holder', updatedAt: T0,
  });

  async function finishUpstreamAndFire(id: string, status: 'done' | 'dropped') {
    await db.sql`UPDATE harness_shared.work_items SET status = ${status} WHERE workspace_id = ${WS_DEFAULT} AND feature_id = ${id}`;
    const { emitWorkItemDoneEvent } = await import('./work-items-events');
    await emitWorkItemDoneEvent({ id, state: status, kind: 'feature', harness: H, title: `title ${id}` } as unknown as WorkItem);
  }

  it.each([
    ['AUTO-BAR-R-13-P-007: a blocker naming a work item clears when that item is closed through a plan-status cascade, and its holder is woken', 'done', '9007301'],
    ['AUTO-BAR-R-14-P-007: a blocker naming a work item clears when that item is dropped, and its holder is woken', 'dropped', '9007401'],
  ] as const)('%s', async (_title, status, n) => {
    const upstream = `WI-${n}`;
    const blocked = `WI-${Number(n) + 1}`;
    await seed({ id: upstream, kind: 'feature', status: 'wip', takenBy: 'su-p007-upstream', payload: {} });
    await seed({ id: blocked, kind: 'feature', status: 'blocked', takenBy: 'su-p007-holder',
      payload: { externalBlockers: [dependencyBlocker(`work-item:${upstream}`)] } });

    await finishUpstreamAndFire(upstream, status);

    const after = await rowOf(blocked);
    expect(after.status).toBe('open');
    expect(after.blockers).toEqual([expect.objectContaining({
      ref: `work-item:${upstream}`, status: 'cleared', clearedBy: BLOCKER_AUTO_CLEAR_ACTOR,
    })]);
    const [identity, opts] = sentMessage();
    expect(identity).toMatchObject({ ownerId: BLOCKER_AUTO_CLEAR_ACTOR, workspaceId: WS_DEFAULT });
    expect(opts.to).toEqual(['su-p007-holder']);
    expect(opts.body).toContain(`No active blocker remains on ${blocked}.`);
    expect(h.wakeRecipients).toHaveBeenCalledWith(['su-p007-holder'], expect.objectContaining({ workspaceId: WS_DEFAULT }));
  });

  it('a completion fire for an item that is not terminal (a late fire after a reopen) leaves the blocker and sends nothing', async () => {
    await seed({ id: 'WI-9007501', kind: 'feature', status: 'wip', takenBy: 'su-p007-upstream', payload: {} });
    await seed({ id: 'WI-9007502', kind: 'feature', status: 'blocked', takenBy: 'su-p007-holder',
      payload: { externalBlockers: [dependencyBlocker('work-item:WI-9007501')] } });
    const { emitWorkItemDoneEvent } = await import('./work-items-events');

    await emitWorkItemDoneEvent({ id: 'WI-9007501', state: 'done', kind: 'feature', harness: H, title: 'reopened' } as unknown as WorkItem);

    const after = await rowOf('WI-9007502');
    expect(after.status).toBe('blocked');
    expect(after.blockers.map((b) => b.status)).toEqual(['active']);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.wakeRecipients).not.toHaveBeenCalled();
  });

  it('a fire that waits on nothing sends nothing', async () => {
    const key = 'work-item:done:WI-p003-nobody-waits';
    await store.registerAnnouncement({ subscriberId: 'su-p003-producer', eventKey: key, scopeKind: 'global' });
    expect(await store.stampAnnouncementsFired(key, { firedBy: 'su-p003-producer' })).toBe(1);
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.wakeRecipients).not.toHaveBeenCalled();
  });
});
