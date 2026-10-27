/**
 * consult-expiry-core.integration.test.ts — the P-005 expiry sweep against a
 * real Postgres (plan get-feedback-relevance-consults-2026-08-16, D-005).
 *
 * Bootstrap mirrors consult-verbs-core.integration.test.ts: the consult tables
 * come from applying the REAL migration file (834-consult-threads.sql,
 * readFileSync) — never a hand-mirrored CREATE that silently falls behind.
 *
 * What only a real-PG test can prove here:
 *  - the sweep's UPDATE flips ONLY past-due open rows (expires_at < now AND
 *    closed_at IS NULL) to state='expired' under the migration's state CHECK;
 *  - already-closed and not-yet-due rows are untouched;
 *  - the bounded LIMIT actually bounds one tick (saturated reporting);
 *  - the latched park-key emit fires ONLY for hard-blocked rows, addressed to
 *    the requester, in the row's own workspace.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { sweepExpiredConsults, type ExpirySweepDeps } from './consult-expiry-core';
import { continueCascadeDispatchCore } from './cascade-core';
import { consultExpiryFindSilentResponders, consultExpiryNotifyRequester } from './consult-expiry-adapters';
import { PgCoordLog, ensureCoordEventLogTable } from '@papercusp/coordination/event-log';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { currentRequestWorkspaceId } from '../workspace-als';
import { sendMessage } from '../agent-tools/coordination/messages';
import type { TaskRow } from '../task-manager/types';

// Execute the REAL message writer + REAL PG replay backend, but never resolve
// synthetic requester ids against the live agent roster or use the live DB.
const coordFixture = vi.hoisted(() => ({
  log: null as PgCoordLog | null,
  sql: null as Sql | null,
}));
vi.mock('../agent-tools/coordination/recipient-resolve', () => ({
  resolveBestEffortAgainstRoster: async (to: string[]) => to,
}));
vi.mock('../agent-tools/coordination/log', async (original) => ({
  ...await original<typeof import('../agent-tools/coordination/log')>(),
  // The message writer seals through this seam before appending. Both paths
  // must use the same isolated PG; retaining the production SQL resolver here
  // leaks to the live database even though coordLog itself is rebound.
  coordSql: () => {
    if (!coordFixture.sql) throw new Error('coord fixture SQL is not initialized');
    return coordFixture.sql;
  },
  coordHasPgFastPath: () => true,
  coordLog: {
    appendLineIfAbsent: (...args: Parameters<PgCoordLog['appendLineIfAbsent']>) =>
      coordFixture.log!.appendLineIfAbsent(...args),
    appendLine: (...args: Parameters<PgCoordLog['appendLine']>) =>
      coordFixture.log!.appendLine(...args),
  },
}));

const WS = 'ws-consult-expiry';
const NOW = new Date('2026-08-16T12:00:00Z');
const PAST = new Date(NOW.getTime() - 60_000).toISOString();
const FUTURE = new Date(NOW.getTime() + 3_600_000).toISOString();
const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);
// Migration 844 (cascade_cursor + cascade_digest) — .sql once armed, .DRAFT
// while iterating, so the suite is valid on both sides of the arming mv.
const MIGRATION_844_ARMED = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
);
const MIGRATION_844 = existsSync(MIGRATION_844_ARMED) ? MIGRATION_844_ARMED : `${MIGRATION_844_ARMED}.DRAFT`;
const MIGRATION_856 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/856-backfill-answered-expired-consult-outcomes.sql', import.meta.url),
);
const MIGRATION_963_ARMED = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/963-backfill-blank-owner-answered-consult-outcomes.sql', import.meta.url),
);
const MIGRATION_963 = existsSync(MIGRATION_963_ARMED) ? MIGRATION_963_ARMED : `${MIGRATION_963_ARMED}.DRAFT`;
// consult_state.dispatch_attempts — where P-003's answer-window failures are recorded.
const MIGRATION_1225 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1225-consult-dispatch-attempts.sql', import.meta.url),
);
const MIGRATION_1302 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1302-personal-disclosure-labels.sql', import.meta.url),
);

let rootSql: Sql;
let fixtureDb: MigratedTestDb;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'consulte' });
  rootSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // The expiry sweep projects the fine-grained terminal state onto this coarse
  // parent in the same transaction, so the fixture includes the columns that
  // projection predicates and updates (the real table is migration-132-owned).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL DEFAULT 'default',
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  // The REAL migrations — consult_state + consult_post_meta cannot drift.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_844, 'utf8'));
  await rootSql.unsafe(readFileSync(MIGRATION_1225, 'utf8'));
  // Empty disclosure ledger for these synthetic requesters, using the real
  // schema. Keep the production sealing check active rather than mocking it
  // away; its FK needs only this parent identity table in the isolated fixture.
  await rootSql.unsafe('CREATE TABLE harness_shared.users (id uuid PRIMARY KEY)');
  await rootSql.unsafe(readFileSync(MIGRATION_1302, 'utf8'));
  await ensureCoordEventLogTable(rootSql);
  coordFixture.sql = rootSql;
  coordFixture.log = new PgCoordLog({
    getSql: () => rootSql,
    ensureSchema: async () => {},
    getWorkspaceId: () => {
      const workspace = currentRequestWorkspaceId();
      if (!workspace) throw new Error('requester alert lost its row workspace');
      return workspace;
    },
  });
}, 120_000);

afterAll(async () => {
  coordFixture.sql = null;
  coordFixture.log = null;
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

// ── Fixture builders ─────────────────────────────────────────────────────
let seq = 0;
async function seedConsult(opts: {
  latency?: 'proceed' | 'hard-blocked';
  expiresAt?: string | null;
  closedAt?: string | null;
  state?: string;
  workspaceId?: string;
  requesterId?: string;
  routing?: unknown;
  cascadeCursor?: number;
  updatedAt?: string;
  conversationUpdatedAt?: string;
}): Promise<string> {
  seq += 1;
  const id = `conv-e-${seq}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question,
       latency_contract, expires_at, closed_at, routing, cascade_cursor)
    VALUES
      (${opts.workspaceId ?? WS}, ${id}, ${opts.requesterId ?? 'req-1'}, 'resp-1',
       ${opts.state ?? 'awaiting_responder'}, 'q', ${opts.latency ?? 'proceed'},
       ${opts.expiresAt === undefined ? PAST : opts.expiresAt}, ${opts.closedAt ?? null},
       ${rootSql.json((opts.routing ?? {}) as never)}, ${opts.cascadeCursor ?? 0})`;
  if (opts.updatedAt !== undefined) {
    await rootSql`
      UPDATE harness_shared.consult_state
         SET updated_at = ${opts.updatedAt}::timestamptz
      WHERE workspace_id = ${opts.workspaceId ?? WS} AND conversation_id = ${id}`;
  }
  await rootSql`
    INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, state, updated_at)
    VALUES
      (${opts.workspaceId ?? WS}, ${id}, 'consult', 'open',
       ${(opts.conversationUpdatedAt ?? PAST)}::timestamptz)`;
  return id;
}

/** A routing snapshot with a real selection menu (selection.selected is what
 * the 844 cascade drives off). */
function menuSnapshot(owners: string[], answeringOwnerIds: string[] = []) {
  return {
    selection: {
      selected: owners.map((o, i) => ({
        ownerId: o,
        ...(answeringOwnerIds[i] ? { answeringOwnerId: answeringOwnerIds[i] } : {}),
        via: 'floor' as const,
        score: 0.9 - i * 0.1,
        similarity: 0.8 - i * 0.1,
        liveness: 'live',
      })),
    },
  };
}

function makeDeps(opts: { limit?: number; emitError?: boolean; withReach?: boolean } = {}) {
  const emits: Array<Parameters<ExpirySweepDeps['emitReplyEvent']>[0]> = [];
  const alerts: Array<Parameters<ExpirySweepDeps['notifyRequester']>[0]> = [];
  // D-002/D-011: the sweep's cascade advance DISPATCHES (fork/convert) — it has
  // no wake seam at all. Kept under the old local name so the assertions below
  // keep reading as "who did this advance deliver to".
  const reachCalls: Array<Parameters<NonNullable<ExpirySweepDeps['dispatch']>>[0]> = [];
  const deps: ExpirySweepDeps = {
    getSql: () => rootSql,
    notifyRequester: async (alert) => { alerts.push(alert); },
    emitReplyEvent: async (e) => {
      if (opts.emitError) throw new Error('emit down');
      emits.push(e);
    },
    now: () => NOW,
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.withReach
      ? {
          dispatch: async (o) => {
            reachCalls.push(o);
            return { woke: 1, answeringOwnerId: `${o.responder}-fork` };
          },
        }
      : {}),
  };
  return { deps, emits, reachCalls, alerts };
}

async function stateOf(id: string, ws = WS): Promise<{ state: string; closed_at: string | null }> {
  const rows = (await rootSql`
    SELECT state, closed_at FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${id}
  `) as unknown as Array<{ state: string; closed_at: string | null }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function conversationStateOf(id: string, ws = WS): Promise<{ state: string; updated_at: string }> {
  const rows = (await rootSql`
    SELECT state,
           to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
      FROM harness_shared.coord_conversations
     WHERE workspace_id = ${ws} AND id = ${id}
  `) as unknown as Array<{ state: string; updated_at: string }>;
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function setDigest(id: string, digest: unknown[]) {
  await rootSql`
    UPDATE harness_shared.consult_state
       SET cascade_digest = ${rootSql.json(digest as never)}
     WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
}

// ── Tests ────────────────────────────────────────────────────────────────
describe('sweepExpiredConsults', () => {
  it('recovers queued cascade launches before expiry and preserves a live continuation lease', async () => {
    const live = await seedConsult({ routing: { ...menuSnapshot(['resp-1']), cascadeDispatch: {
      version: 1, cursor: 0, responder: 'resp-1', leaseUntil: FUTURE,
    } } });
    const recover = await seedConsult({ routing: { ...menuSnapshot(['resp-1']), cascadeDispatch: {
      version: 1, cursor: 0, responder: 'resp-1', leaseUntil: PAST,
    } } });
    const { deps, alerts } = makeDeps();
    const resumed: string[] = [];
    deps.resumeCascadeDispatch = async (workspace, id) => {
      expect(workspace).toBe(WS);
      resumed.push(id);
      await rootSql`UPDATE harness_shared.consult_state SET routing = routing - 'cascadeDispatch', expires_at = ${FUTURE}::timestamptz
        WHERE workspace_id = ${workspace} AND conversation_id = ${id}`;
      return true;
    };
    await sweepExpiredConsults(deps);
    expect(resumed).toEqual([recover]);
    expect(await stateOf(live)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(await stateOf(recover)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(alerts).toHaveLength(0);
    await rootSql`DELETE FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id IN (${live}, ${recover})`;
  });
  it('flips ONLY past-due open rows to expired; hard-blocked rows get the latched park-key emit', async () => {
    const hardDue = await seedConsult({ latency: 'hard-blocked', conversationUpdatedAt: FUTURE });
    const proceedDue = await seedConsult({ latency: 'proceed' });
    const notDue = await seedConsult({ expiresAt: FUTURE });
    const noExpiry = await seedConsult({ expiresAt: null });
    const alreadyClosed = await seedConsult({
      latency: 'hard-blocked',
      state: 'closed_answered',
      closedAt: PAST,
    });

    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);

    expect(r.expired).toBe(2);
    expect(r.saturated).toBe(false);
    expect(r.woke).toEqual([hardDue]);

    expect(await stateOf(hardDue)).toMatchObject({ state: 'expired' });
    expect((await stateOf(hardDue)).closed_at).not.toBeNull();
    expect(await conversationStateOf(hardDue)).toEqual({ state: 'expired', updated_at: FUTURE });
    expect(await conversationStateOf(proceedDue)).toMatchObject({ state: 'expired' });
    expect(await stateOf(proceedDue)).toMatchObject({ state: 'expired' });
    expect(await stateOf(notDue)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(await stateOf(noExpiry)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    expect(await stateOf(alreadyClosed)).toMatchObject({ state: 'closed_answered' });

    // ONE emit — the hard-blocked row's park key, addressed to its requester,
    // in the row's own workspace, with the expired payload.
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      key: `consult:reply:${hardDue}`,
      to: ['req-1'],
      workspaceId: WS,
    });
    expect(emits[0].payload).toMatchObject({ conversation_id: hardDue, kind: 'expired' });
  });

  it('is idempotent: a second tick finds nothing (expired rows are closed rows)', async () => {
    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(0);
    expect(emits).toHaveLength(0);
  });

  it('bounds one tick at the limit and reports saturation; the rest drains next tick', async () => {
    const ids = await Promise.all([
      seedConsult({ latency: 'proceed' }),
      seedConsult({ latency: 'proceed' }),
      seedConsult({ latency: 'proceed' }),
    ]);
    const { deps } = makeDeps({ limit: 2 });
    const first = await sweepExpiredConsults(deps);
    expect(first.expired).toBe(2);
    expect(first.saturated).toBe(true);

    const second = await sweepExpiredConsults(deps);
    expect(second.expired).toBe(1);
    expect(second.saturated).toBe(false);

    for (const id of ids) expect((await stateOf(id)).state).toBe('expired');
  });

  it('a failed emit does not strand the flip (the await timeout is the backstop) nor the batch', async () => {
    const hardDue = await seedConsult({ latency: 'hard-blocked' });
    const { deps } = makeDeps({ emitError: true });
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(1);
    expect(r.woke).toEqual([]); // emit failed — honestly not reported as woken
    expect((await stateOf(hardDue)).state).toBe('expired'); // the flip survived
  });

  it('keeps a lifecycle row retryable when the durable requester alert fails, then replays the same key once the writer recovers', async () => {
    const id = await seedConsult({ latency: 'proceed' });
    const { deps, alerts } = makeDeps();
    let attempts = 0;
    const seenKeys: string[] = [];
    deps.notifyRequester = async (alert) => {
      attempts += 1;
      seenKeys.push(alert.msgId);
      if (attempts === 1) throw new Error('coord writer unavailable');
      alerts.push(alert);
    };

    const first = await sweepExpiredConsults(deps);
    expect(first).toMatchObject({
      expired: 0,
      advanced: 0,
      requesterAlerts: [],
      requesterAlertFailures: [id],
    });
    expect(await stateOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });

    const second = await sweepExpiredConsults(deps);
    expect(second).toMatchObject({
      expired: 1,
      requesterAlerts: [id],
      requesterAlertFailures: [],
    });
    expect(await stateOf(id)).toMatchObject({ state: 'expired' });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      conversationId: id,
      requesterId: 'req-1',
      workspaceId: WS,
    });
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
  });

  it('does not send a pickup alert when the consult is answered and closed during silent detection', async () => {
    const closedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const id = await seedConsult({
      expiresAt: FUTURE,
      routing: menuSnapshot(['resp-1'], ['resp-1-fork']),
    });
    const { deps, alerts } = makeDeps();
    deps.findSilentResponders = async () => {
      await rootSql`
        UPDATE harness_shared.consult_state
           SET state = 'closed_answered',
               exchanges_used = 1,
               closed_at = ${closedAt}::timestamptz,
               updated_at = ${closedAt}::timestamptz
         WHERE workspace_id = ${WS} AND conversation_id = ${id}
      `;
      await rootSql`
        UPDATE harness_shared.coord_conversations
           SET state = 'closed', updated_at = ${closedAt}::timestamptz
         WHERE workspace_id = ${WS} AND id = ${id}
      `;
      return new Set([id]);
    };

    const result = await sweepExpiredConsults(deps);

    expect(result).toMatchObject({
      requesterAlerts: [],
      requesterAlertFailures: [],
      advanced: 0,
      expired: 0,
    });
    expect(alerts).toEqual([]);
    const closed = await stateOf(id);
    expect(closed.state).toBe('closed_answered');
    expect(closed.closed_at).not.toBeNull();
  });

  it('does not expire a due snapshot after another writer refreshes the TTL', async () => {
    const refreshedExpiry = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    const refreshedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: PAST,
      routing: menuSnapshot(['resp-1']),
    });
    const { deps } = makeDeps();
    deps.notifyRequester = async () => {
      // Model a concurrent reply/advance that refreshes the row after the due
      // SELECT but before the expiry sweep's compare-and-set writes.
      await rootSql`
        UPDATE harness_shared.consult_state
           SET expires_at = ${refreshedExpiry}::timestamptz,
               updated_at = ${refreshedAt}::timestamptz
         WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    };

    const result = await sweepExpiredConsults(deps);
    const [row] = await rootSql<Array<{
      state: string;
      expires_at: string;
      closed_at: string | null;
      cascade_digest: unknown;
    }>>`
      SELECT state, expires_at, closed_at, cascade_digest
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;

    expect(result).toMatchObject({ expired: 0, advanced: 0 });
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(new Date(row.expires_at).toISOString()).toBe(refreshedExpiry);
    expect(row.cascade_digest).toEqual([]);
  });

  it('sweeps across workspaces, stamping each emit with the ROW workspace', async () => {
    const otherWs = 'ws-consult-expiry-2';
    const foreign = await seedConsult({
      latency: 'hard-blocked',
      workspaceId: otherWs,
      requesterId: 'req-other',
    });
    const { deps, emits } = makeDeps();
    const r = await sweepExpiredConsults(deps);
    expect(r.expired).toBe(1);
    expect(await stateOf(foreign, otherWs)).toMatchObject({ state: 'expired' });
    expect(emits[0]).toMatchObject({ workspaceId: otherWs, to: ['req-other'] });
  });
});

describe('migrations 856 + 963 historical answered-expired outcome repair', () => {
  it('repairs null-outcome expired rows with answers, including blank responder ids, and is idempotent', async () => {
    const legacyAnswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const blankOwnerAnswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const trulyUnanswered = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const explicitOutcome = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });
    const stillOpen = await seedConsult({ state: 'awaiting_responder', expiresAt: FUTURE });
    const scalarDigest = await seedConsult({ state: 'expired', closedAt: PAST, expiresAt: PAST });

    await setDigest(legacyAnswered, [
      { ownerId: 'reviewer-b', kind: 'answer', at: PAST, excerpt: 'first' },
      { ownerId: 'reviewer-a', kind: 'answer', at: PAST, excerpt: 'second' },
      { ownerId: 'reviewer-b', kind: 'answer', at: PAST, excerpt: 'follow-up' },
      { ownerId: 'reviewer-c', kind: 'expired', at: PAST, excerpt: 'old unanswered label' },
    ]);
    await setDigest(blankOwnerAnswered, [
      { ownerId: '', kind: 'answer', at: PAST, excerpt: 'anonymous first' },
      { ownerId: '', kind: 'answer', at: PAST, excerpt: 'anonymous follow-up' },
    ]);
    await setDigest(trulyUnanswered, [
      { ownerId: 'reviewer-z', kind: 'expired', at: PAST, excerpt: 'no answer' },
    ]);
    await setDigest(explicitOutcome, [
      { ownerId: 'reviewer-x', kind: 'answer', at: PAST, excerpt: 'answered' },
    ]);
    await setDigest(stillOpen, [
      { ownerId: 'reviewer-y', kind: 'answer', at: PAST, excerpt: 'not terminal' },
    ]);
    await rootSql`
      UPDATE harness_shared.consult_state
         SET cascade_digest = ${rootSql.json('legacy-scalar' as never)}
       WHERE workspace_id = ${WS} AND conversation_id = ${scalarDigest}
    `;
    await rootSql`
      UPDATE harness_shared.consult_state
         SET outcome = ${rootSql.json({ disposition: 'requester_recorded', answer: 'keep me' })}
       WHERE workspace_id = ${WS} AND conversation_id = ${explicitOutcome}
    `;

    const migrationSql = readFileSync(MIGRATION_856, 'utf8');
    const [candidate] = (await rootSql`
      SELECT count(*) FILTER (WHERE entry.value ->> 'kind' = 'answer')::integer AS answers
        FROM harness_shared.consult_state cs
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(cs.cascade_digest) = 'array' THEN cs.cascade_digest
            ELSE '[]'::jsonb
          END
        )
          WITH ORDINALITY AS entry(value, ordinality)
       WHERE cs.workspace_id = ${WS}
         AND cs.conversation_id = ${legacyAnswered}
         AND cs.state = 'expired'
         AND cs.outcome IS NULL
    `) as unknown as Array<{ answers: number }>;
    expect(candidate.answers).toBe(3);
    const updated = await rootSql.unsafe(migrationSql);
    expect(updated.count).toBe(1);

    // Migration 856 intentionally filtered blank responder ids, but that also
    // dropped the whole conversation when every substantive answer was
    // anonymous. Migration 963 retains the answer count and records that no
    // responder identity was available.
    const blankOwnerMigrationSql = readFileSync(MIGRATION_963, 'utf8');
    const blankOwnerUpdated = await rootSql.unsafe(blankOwnerMigrationSql);
    expect(blankOwnerUpdated.count).toBe(1);

    const outcomes = (await rootSql`
      SELECT conversation_id, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND conversation_id IN (
           ${legacyAnswered}, ${blankOwnerAnswered}, ${trulyUnanswered}, ${explicitOutcome}, ${stillOpen}, ${scalarDigest}
         )
    `) as unknown as Array<{ conversation_id: string; outcome: unknown }>;
    const byId = new Map(outcomes.map((row) => [row.conversation_id, row.outcome]));
    expect(byId.get(legacyAnswered)).toMatchObject({
      disposition: 'cascade_exhausted_with_answers',
      answers: 3,
      answered_by: ['reviewer-b', 'reviewer-a'],
    });
    expect(byId.get(blankOwnerAnswered)).toEqual({
      disposition: 'cascade_exhausted_with_answers',
      answers: 2,
      answered_by: [],
    });
    expect(byId.get(trulyUnanswered)).toBeNull();
    expect(byId.get(explicitOutcome)).toMatchObject({ disposition: 'requester_recorded', answer: 'keep me' });
    expect(byId.get(stillOpen)).toBeNull();
    expect(byId.get(scalarDigest)).toBeNull();

    const second856 = await rootSql.unsafe(migrationSql);
    const second962 = await rootSql.unsafe(blankOwnerMigrationSql);
    expect(second856.count).toBe(0);
    expect(second962.count).toBe(0);
    const afterSecondRun = (await rootSql`
      SELECT conversation_id, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS}
         AND conversation_id IN (${legacyAnswered}, ${blankOwnerAnswered})
       ORDER BY conversation_id
    `) as unknown as Array<{ conversation_id: string; outcome: unknown }>;
    expect(new Map(afterSecondRun.map((row) => [row.conversation_id, row.outcome]))).toEqual(
      new Map([
        [legacyAnswered, byId.get(legacyAnswered)],
        [blankOwnerAnswered, byId.get(blankOwnerAnswered)],
      ]),
    );
  });
});

// ── D-005/P-013 always-advance: expiry is a chain event, not a terminal ──

async function cascadeRow(id: string, ws = WS) {
  const rows = (await rootSql`
    SELECT state, closed_at, responder_id, cascade_cursor, cascade_digest, expires_at
      FROM harness_shared.consult_state
     WHERE workspace_id = ${ws} AND conversation_id = ${id}
  `) as unknown as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (typeof row.cascade_digest === 'string') row.cascade_digest = JSON.parse(row.cascade_digest);
  return row;
}

describe('sweepExpiredConsults — cascade advance (D-005/P-013)', () => {
  it('advances a non-due silent responder as an implicit decline without terminal expiry', async () => {
    const routedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: routedAt,
      routing: menuSnapshot(['resp-1', 'resp-2'], ['resp-1-fork', 'resp-2-fork']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const detectorCalls: Array<ReadonlyArray<{ conversationId: string; requesterId?: string; answeringOwnerId: string | null; routedAt: string }>> = [];
    deps.findSilentResponders = async (rows) => {
      detectorCalls.push(rows);
      return new Set([id]);
    };

    const r = await sweepExpiredConsults(deps);

    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(detectorCalls).toHaveLength(1);
    expect(detectorCalls[0]).toContainEqual({
      workspaceId: WS,
      conversationId: id,
      requesterId: 'req-1',
      sourceOwnerId: 'resp-1',
      answeringOwnerId: 'resp-1-fork',
      routedAt,
    });
    const row = await cascadeRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(row.cascade_digest).toMatchObject([
      {
        ownerId: 'resp-1',
        kind: 'dispatch_failed',
        excerpt: 'queued responder did not produce a consult post before bounded pickup recovery (implicit decline)',
      },
    ]);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime());
    expect(reachCalls).toHaveLength(1);
  });

  it('wires the production detector into the real-PG cascade for a parked no-pickup responder', async () => {
    const routedAt = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: routedAt,
      routing: menuSnapshot(['resp-1', 'resp-2'], ['resp-1-fork', 'resp-2-fork']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    deps.findSilentResponders = consultExpiryFindSilentResponders({
      getPresence: async () => ({ lastActiveAt: null }),
      resolveSessionStates: async () =>
        new Map([
          ['resp-1-fork', { sessionState: 'parked' }],
          ['resp-2-fork', { sessionState: 'parked' }],
        ]),
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => NOW,
    });

    const r = await sweepExpiredConsults(deps);

    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(await cascadeRow(id)).toMatchObject({
      state: 'awaiting_responder',
      closed_at: null,
      responder_id: 'resp-2',
      cascade_cursor: 1,
    });
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'resp-2', conversationId: id, workspaceId: WS });
  });

  it.each(['resp-prior-fork', 'resp-prior', 'req-1'])('recovers a reserved cascade answerer after a thrown launch with non-answerer posts from %s', async (priorAuthor) => {
    const id = await seedConsult({
      expiresAt: FUTURE,
      cascadeCursor: 1,
      updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      routing: {
        ...menuSnapshot(['resp-prior', 'resp-1', 'resp-2'], ['resp-prior-fork']),
        cascadeDispatch: { version: 1, cursor: 1, responder: 'resp-1', summary: 's', body: 'b', attempts: 0 },
      },
    });
    const continuation = {
      getSql: () => rootSql,
      now: () => NOW,
      dispatch: () => async (opts: { onAnsweringOwner?: (owner: string) => void | Promise<void> }) => {
        await opts.onAnsweringOwner?.('reserved-fork');
        throw new Error('failed after reservation');
      },
    };
    await expect(continueCascadeDispatchCore(WS, id, continuation)).rejects.toThrow('failed after reservation');
    const recoveryAt = new Date(NOW.getTime() + 30_001);
    expect(await continueCascadeDispatchCore(WS, id, {
      ...continuation, now: () => recoveryAt,
    })).toBe(false);
    const [reservation] = await rootSql`
      SELECT routing #>> '{cascadeDispatch,leaseUntil}' AS backoff,
             routing #>> '{selection,selected,1,answeringOwnerId}' AS answerer
      FROM harness_shared.consult_state WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    expect(reservation.answerer).toBe('reserved-fork');
    expect(Date.parse(reservation.backoff)).toBeLessThan(recoveryAt.getTime());

    const { deps, reachCalls } = makeDeps({ withReach: true });
    deps.now = () => recoveryAt;
    const detector = consultExpiryFindSilentResponders({
      getPresence: async () => null,
      resolveSessionStates: async () => new Map([['reserved-fork', { sessionState: 'ended' }]]),
      getThreadStore: () => ({
        getThreadByParent: async () => ({ thread_id: 'prior-decline' }) as never,
        listRecentPosts: async () => ({ total: 1, posts: [{ author_id: priorAuthor }] }),
      }),
      now: () => recoveryAt,
    });
    deps.findSilentResponders = (rows) => detector(rows.filter((row) => row.conversationId === id));

    await sweepExpiredConsults(deps);

    expect(await cascadeRow(id)).toMatchObject({
      state: 'awaiting_responder', closed_at: null, responder_id: 'resp-2', cascade_cursor: 2,
      cascade_digest: [{ ownerId: 'resp-1', kind: 'dispatch_failed' }],
    });
    expect(reachCalls.filter((call) => call.conversationId === id)).toEqual([
      expect.objectContaining({ responder: 'resp-2', conversationId: id }),
    ]);
  });

  it.each(['terminal', 'missing', 'live-task', 'answerer-post'] as const)(
    'recovers a ghost reserved launch through the existing cascade with requester follow-ups (%s)',
    async (evidence) => {
      const id = await seedConsult({
        expiresAt: FUTURE,
        updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
        routing: menuSnapshot(['resp-1', 'resp-2'], ['reserved-fork']),
      });
      const { deps, reachCalls } = makeDeps({ withReach: true });
      const task = {
        workspaceId: WS, class: 'agent-session',
        state: evidence === 'live-task' ? 'running' : 'ended_unobserved',
        endedAt: evidence === 'live-task' ? null : new Date(NOW.getTime() - 10 * 60_000).toISOString(),
        detail: { consultAnswer: { conversationId: id, sourceOwnerId: 'resp-1', answeringOwnerId: 'reserved-fork' } },
      } as unknown as TaskRow; // partial fixture: only the fields the detector reads
      const detector = consultExpiryFindSilentResponders({
        getPresence: async () => null,
        resolveSessionStates: async () => new Map(),
        listAnsweringTasks: async (workspaceId, owner) => {
          expect(workspaceId).toBe(WS);
          expect(owner).toBe('reserved-fork');
          return evidence === 'missing' ? [] : [task];
        },
        getThreadStore: () => ({
          getThreadByParent: async () => ({ thread_id: id }) as never,
          listRecentPosts: async () => ({ total: 2, posts: [
            { author_id: 'req-1' },
            { author_id: evidence === 'answerer-post' ? 'reserved-fork' : 'req-1' },
          ] }),
        }),
        now: () => NOW,
      });
      deps.findSilentResponders = (rows) => detector(rows.filter((row) => row.conversationId === id));
      await sweepExpiredConsults(deps);
      const row = await cascadeRow(id);
      if (evidence === 'terminal') {
        expect(row).toMatchObject({ state: 'awaiting_responder', closed_at: null, responder_id: 'resp-2', cascade_cursor: 1 });
        expect(row.cascade_digest).toMatchObject([{ ownerId: 'resp-1', kind: 'dispatch_failed' }]);
        expect(reachCalls.filter((call) => call.conversationId === id)).toEqual([
          expect.objectContaining({ responder: 'resp-2', conversationId: id }),
        ]);
      } else {
        expect(row).toMatchObject({ state: 'awaiting_responder', responder_id: 'resp-1', cascade_cursor: 0, cascade_digest: [] });
        expect(reachCalls.filter((call) => call.conversationId === id)).toEqual([]);
      }
    },
  );

  it('does not treat a parked knowledge source as silent while its forked answerer is live', async () => {
    const routedAt = new Date(NOW.getTime() - 60_000).toISOString();
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: routedAt,
      routing: menuSnapshot(['resp-1', 'resp-2'], ['resp-1-fork', 'resp-2-fork']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const livenessSubjects: string[][] = [];
    const presenceReads: string[] = [];
    const threadReads: string[] = [];
    const livenessByOwner = new Map([
      ['resp-1', { sessionState: 'parked' }],
      ['resp-1-fork', { sessionState: 'live' }],
    ]);
    deps.findSilentResponders = consultExpiryFindSilentResponders({
      getPresence: async (ownerId) => {
        presenceReads.push(ownerId);
        return { lastActiveAt: new Date(NOW.getTime() - 30_000).toISOString() };
      },
      resolveSessionStates: async (subjects) => {
        livenessSubjects.push(subjects.map((subject) => subject.ownerId));
        return new Map(subjects.map(({ ownerId }) => [
          ownerId,
          livenessByOwner.get(ownerId) ?? { sessionState: 'unknown' },
        ]));
      },
      getThreadStore: () => ({
        getThreadByParent: async (parent) => {
          threadReads.push(parent.ref);
          return { thread_id: `thread-${parent.ref}` } as never;
        },
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => NOW,
    });

    const result = await sweepExpiredConsults(deps);

    expect(livenessSubjects.flat()).toContain('resp-1-fork');
    expect(livenessSubjects.flat()).not.toContain('resp-1');
    expect(presenceReads).toContain('resp-1-fork');
    expect(presenceReads).not.toContain('resp-1');
    expect(threadReads).not.toContain(id);
    expect(reachCalls.filter((call) => call.conversationId === id)).toEqual([]);
    expect(await cascadeRow(id)).toMatchObject({
      state: 'awaiting_responder',
      closed_at: null,
      responder_id: 'resp-1',
      cascade_cursor: 0,
    });
  });

  it('does not infer an unstamped fork failure inside the pickup window', async () => {
    const id = await seedConsult({
      latency: 'hard-blocked',
      expiresAt: FUTURE,
      updatedAt: NOW.toISOString(),
      routing: menuSnapshot(['resp-1']),
    });
    const { deps } = makeDeps({ withReach: true });
    const detectorRows: string[] = [];
    deps.findSilentResponders = async (rows) => {
      detectorRows.push(...rows.map((row) => row.conversationId));
      return new Set();
    };

    await sweepExpiredConsults(deps);

    expect(detectorRows).toContain(id);
    expect(await cascadeRow(id)).toMatchObject({
      state: 'awaiting_responder',
      closed_at: null,
      responder_id: 'resp-1',
      cascade_cursor: 0,
    });
  });

  it('advances an unstamped dispatch after the pickup window, without consulting source liveness', async () => {
    const staleRoute = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const freshRoute = new Date(NOW.getTime() - 30 * 60_000 + 1).toISOString();
    const stale = await seedConsult({
      expiresAt: FUTURE, updatedAt: staleRoute, routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const fresh = await seedConsult({
      expiresAt: FUTURE, updatedAt: freshRoute, routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const detector = consultExpiryFindSilentResponders({
      getPresence: async () => { throw new Error('no answering owner exists'); },
      resolveSessionStates: async () => { throw new Error('source liveness is not dispatch proof'); },
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        listRecentPosts: async () => ({ total: 0 }),
      }),
      now: () => NOW,
    });
    deps.findSilentResponders = (rows) => detector(rows.filter((row) => row.conversationId === stale || row.conversationId === fresh));

    const result = await sweepExpiredConsults(deps);

    expect(result).toMatchObject({ advanced: 1, expired: 0 });
    expect(await cascadeRow(stale)).toMatchObject({ responder_id: 'resp-2', cascade_cursor: 1 });
    expect((await cascadeRow(stale)).cascade_digest).toMatchObject([{ kind: 'dispatch_failed' }]);
    expect(await cascadeRow(fresh)).toMatchObject({ responder_id: 'resp-1', cascade_cursor: 0 });
    expect(reachCalls.filter((call) => call.conversationId === stale)).toHaveLength(1);
    expect(reachCalls.filter((call) => call.conversationId === fresh)).toHaveLength(0);
  });

  it('a due row with menu remaining ADVANCES instead of expiring: cursor+responder move under a fresh window, digest records the expiry, next selectee woken — NO park emit', async () => {
    const id = await seedConsult({
      latency: 'hard-blocked',
      routing: menuSnapshot(['resp-1', 'resp-2']),
    });
    const { deps, emits, reachCalls } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0, woke: [], saturated: false });
    expect(emits).toHaveLength(0); // mid-chain: the parked requester sleeps on (more feedback coming)

    const row = await cascadeRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.closed_at).toBeNull();
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime()); // fresh window
    expect(row.cascade_digest).toMatchObject([{ ownerId: 'resp-1', kind: 'expired' }]);

    // The wake rides the ROW's workspace (one sweep serves them all) and
    // carries the digest into the next selectee's body.
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'resp-2', conversationId: id, workspaceId: WS });
    expect(reachCalls[0].body).toContain('reviewer 2/2');
    expect(reachCalls[0].body).toContain('- resp-1 (expired):');
  });

  it('EI-24351703367365896: an expired slot followed only by refused launches expires in this sweep', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot(['resp-1', 'unlaunchable']) });
    const { deps, emits, reachCalls } = makeDeps({ withReach: true });
    deps.dispatch = async (o) => { reachCalls.push(o); return { woke: 0 }; };
    await sweepExpiredConsults(deps);
    expect(reachCalls.filter((o) => o.conversationId === id).map((o) => o.responder)).toEqual(['unlaunchable']);
    expect(await cascadeRow(id)).toMatchObject({
      state: 'expired',
      cascade_digest: [{ ownerId: 'resp-1', kind: 'expired' }, { ownerId: 'unlaunchable', kind: 'dispatch_failed' }],
    });
    expect(emits.filter((e) => e.payload.conversation_id === id)).toHaveLength(1);
  });

  it('menu exhausted → terminal expire with the hard-blocked park emit; the digest still records the final expiry', async () => {
    const id = await seedConsult({
      latency: 'hard-blocked',
      routing: menuSnapshot(['resp-1']), // cursor 0 IS the last selectee
    });
    const { deps, emits } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1, woke: [id] });
    expect(emits[0]).toMatchObject({ payload: { conversation_id: id, kind: 'expired' }, to: ['req-1'] });

    const row = await cascadeRow(id);
    expect(row.state).toBe('expired');
    expect(row.closed_at).not.toBeNull();
    expect(row.cascade_digest).toMatchObject([{ ownerId: 'resp-1', kind: 'expired' }]);
  });

  it('advances even without a bound reach seam (cursor/responder/digest move; nobody woken) — tests-only shape, prod MUST bind reach', async () => {
    const id = await seedConsult({ routing: menuSnapshot(['resp-1', 'resp-2']) });
    const { deps } = makeDeps(); // no reach
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0 });
    const row = await cascadeRow(id);
    expect(row.responder_id).toBe('resp-2');
    expect(row.cascade_cursor).toBe(1);
  });
});

// ── WI-39862 honest expiry + WI-39861 min-ANSWERS refill ─────────────────────
describe('sweepExpiredConsults — honest expiry (WI-39862) + min-ANSWERS refill (WI-39861)', () => {
  const liveCand = (ownerId: string, score: number, similarity: number, liveness = 'live') => ({
    ownerId,
    score,
    // Two-stage snapshot shape: the floor reads `relevance`, so these fixtures
    // keep it equal to `score` and every above/below-floor relationship the
    // assertions below rely on is preserved exactly.
    relevance: score,
    signals: { similarity },
    liveness,
  });
  const selEntry = (ownerId: string, via: 'floor' | 'minimum' = 'floor') => ({
    ownerId,
    via,
    score: 0.8,
    relevance: 0.8,
    similarity: 0.7,
    liveness: 'live',
  });
  /** cascadeRow (above) deliberately selects only the cascade columns — these
   * WI-39862/WI-39861 assertions also need routing + outcome. */
  async function fullRow(id: string) {
    const rows = (await rootSql`
      SELECT state, closed_at, responder_id, cascade_cursor, cascade_digest, expires_at, routing, outcome
        FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}
    `) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (typeof row.cascade_digest === 'string') row.cascade_digest = JSON.parse(row.cascade_digest);
    return row;
  }
  function routingOf(row: Record<string, unknown>): { selection?: { selected?: Array<Record<string, unknown>>; refill?: Record<string, unknown>; min?: number } } {
    return (typeof row.routing === 'string' ? JSON.parse(row.routing) : row.routing) as ReturnType<typeof routingOf>;
  }

  it('terminal expiry WITH collected answers: answered-flavored outcome + NOT-unanswered emit; answers ≥ min suppresses refill', async () => {
    const routing = {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      // 'c' is live, untried, above-floor — refillable if the guard were wrong.
      candidates: [liveCand('ans-a', 0.9, 0.8), liveCand('exp-b', 0.8, 0.7), liveCand('c', 0.7, 0.6)],
      selection: { min: 1, max: 2, selected: [selEntry('ans-a'), selEntry('exp-b')] },
    };
    const id = await seedConsult({ latency: 'hard-blocked', routing, cascadeCursor: 1 });
    await setDigest(id, [{ ownerId: 'ans-a', kind: 'answer', at: PAST, excerpt: 'a real answer' }]);
    const { deps, emits } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1, woke: [id] });

    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    const outcome = typeof row.outcome === 'string' ? JSON.parse(row.outcome as string) : row.outcome;
    expect(outcome).toMatchObject({
      disposition: 'cascade_exhausted_with_answers',
      answers: 1,
      answered_by: ['ans-a'],
    });
    // No refill ran: answers (1) ≥ min (1) — menu length unchanged, no stamp.
    const routingRow = routingOf(row);
    expect(routingRow.selection?.selected).toHaveLength(2);
    expect(routingRow.selection?.refill).toBeUndefined();
    // The emit says NOT unanswered and points at the late-close disposition.
    expect(emits).toHaveLength(1);
    expect(emits[0].summary).toContain('NOT unanswered');
    expect(emits[0].summary).toContain('consult:close');
    expect(emits[0].payload).toMatchObject({ conversation_id: id, kind: 'expired', answers: 1 });
  });

  it('zero answers keeps the honest EXPIRED-unanswered emit and a bare outcome', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot(['only-r']) });
    const { deps, emits } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);
    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    expect(row.outcome).toBeNull();
    expect(emits[0].summary).toContain('EXPIRED unanswered');
    expect(emits[0].payload.answers).toBeUndefined();
  });

  it('exhaustion below min with an untried live pool: ONE refill round — menu extended (honest via), refill selectee woken', async () => {
    const routing = {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: [
        liveCand('r-a', 0.9, 0.8), // the original (expiring) selectee
        liveCand('r-b', 0.6, 0.5), // above-floor live → refill via 'floor'
        liveCand('r-dead', 0.55, 0.5, 'ended'), // above-floor DEAD → refill via 'floor' too (D-002)
        liveCand('r-d', 0.3, 0.2), // below-floor live → NOT promoted past the dead one
      ],
      selection: { min: 2, max: 2, selected: [selEntry('r-a')] },
    };
    const id = await seedConsult({ routing, cascadeCursor: 0 });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 1, expired: 0 });

    const row = await fullRow(id);
    expect(row.state).toBe('awaiting_responder');
    expect(row.responder_id).toBe('r-b');
    expect(row.cascade_cursor).toBe(1); // first refill entry (old menu length)
    expect(new Date(row.expires_at as string).getTime()).toBeGreaterThan(NOW.getTime()); // fresh window
    const routingRow = routingOf(row);
    expect(routingRow.selection?.selected).toHaveLength(3);
    expect(routingRow.selection?.selected?.[1]).toMatchObject({ ownerId: 'r-b', via: 'floor', refill: true });
    // R-2 in the EXPIRY refill: the above-floor DEAD candidate is refilled via
    // 'floor' in its own rank position, and the below-floor LIVE `r-d` is never
    // promoted past it. Before D-002 this slot held r-d via 'minimum' — the
    // liveness gate skipped r-dead and the min was then filled by a worse match.
    expect(routingRow.selection?.selected?.[2]).toMatchObject({ ownerId: 'r-dead', via: 'floor', refill: true });
    expect(routingRow.selection?.refill).toMatchObject({ added: ['r-b', 'r-dead'] });
    expect(routingRow.selection?.selected?.map((s) => s.ownerId)).not.toContain('r-d');
    expect(reachCalls).toHaveLength(1);
    expect(reachCalls[0]).toMatchObject({ responder: 'r-b', conversationId: id });
    expect(reachCalls[0].summary).toContain('min-answers refill');
    expect(reachCalls[0].body).toContain('reviewer 2/3');
  });

  it('the refill stamp is the ONE-round guard: a second exhaustion is terminal even with pool remaining', async () => {
    const routing = {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: [liveCand('s-a', 0.9, 0.8), liveCand('s-b', 0.6, 0.5), liveCand('s-c', 0.55, 0.5)],
      selection: {
        min: 2,
        max: 2,
        selected: [selEntry('s-a'), { ...selEntry('s-b'), refill: true }],
        refill: { at: PAST, added: ['s-b'], reason: 'cascade exhausted with 0 answer(s) < min 2' },
      },
    };
    const id = await seedConsult({ routing, cascadeCursor: 1 });
    const { deps } = makeDeps({ withReach: true });
    const r = await sweepExpiredConsults(deps);
    expect(r).toMatchObject({ advanced: 0, expired: 1 });
    const row = await fullRow(id);
    expect(row.state).toBe('expired');
    // s-c stayed untried: the stamp, not pool exhaustion, ended the chain.
    expect(routingOf(row).selection?.selected).toHaveLength(2);
  });
});

describe('P-005 requester alert — real message writer and PG replay boundary', () => {
  async function durableAlerts(id: string) {
    return rootSql<{ workspace_id: string; body: CoordEnvelope }[]>`
      SELECT workspace_id, body FROM harness_shared.coord_event_log
      WHERE surface = 'messages' AND body->>'conversation_id' = ${id}
      ORDER BY id`;
  }

  // A reusable oracle for the actual delivery property, also run against the
  // deliberately broken no-replay-key control below (no shared-tree mutation).
  function assertSingleAlert(rows: Awaited<ReturnType<typeof durableAlerts>>, id: string, ws: string) {
    expect(rows).toHaveLength(1);
    expect(rows[0].workspace_id).toBe(ws);
    expect(rows[0].body.to).toEqual(['req-alert']);
    expect(rows[0].body.summary).toContain(id);
    expect(rows[0].body.body).toContain(`conversation_id: "${id}"`);
    expect(rows[0].body.body).toContain('Recovery disposition: pending');
    expect(rows[0].body.body).toContain('never approval');
  }

  async function lostAcknowledgementProbe(latency: 'proceed' | 'hard-blocked', early: boolean, mutate = false) {
    const ws = `ws-alert-${seq + 1}`;
    const id = await seedConsult({
      latency, requesterId: 'req-alert', workspaceId: ws,
      expiresAt: early ? FUTURE : PAST, updatedAt: PAST,
      ...(early ? { routing: menuSnapshot(['resp-1', 'resp-2'], ['resp-1-fork', 'resp-2-fork']) } : {}),
    });
    const first = makeDeps({ withReach: true });
    first.deps.findSilentResponders = async () => new Set([id]);
    let persistenceFailure: unknown;
    first.deps.notifyRequester = consultExpiryNotifyRequester(async (identity, opts) => {
      try { await sendMessage(identity, mutate ? { ...opts, msgId: undefined } : opts); }
      catch (error) { persistenceFailure = error; throw error; }
      throw new Error('transport acknowledgement lost AFTER commit');
    });
    const attempted = await sweepExpiredConsults(first.deps);
    expect(attempted.requesterAlertFailures).toContain(id);
    expect(persistenceFailure, 'real requester-alert persistence must succeed before injecting acknowledgement loss').toBeUndefined();
    expect(await stateOf(id, ws)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    const original = (await durableAlerts(id))[0].body;

    // Fresh binding/deps simulate a restarted producer. No in-memory dedupe
    // state survives; only the durable message id can prevent a second alert.
    const retry = makeDeps({ withReach: true });
    retry.deps.findSilentResponders = async () => new Set([id]);
    retry.deps.now = () => new Date(NOW.getTime() + 1_000);
    retry.deps.notifyRequester = consultExpiryNotifyRequester((identity, opts) =>
      sendMessage(identity, mutate ? { ...opts, msgId: undefined } : opts));
    const recovered = await sweepExpiredConsults(retry.deps);
    expect(recovered.requesterAlerts).toContain(id);
    expect(recovered.requesterAlertFailures).toEqual([]);
    if (early) {
      expect(await cascadeRow(id, ws)).toMatchObject({ cascade_cursor: 1, responder_id: 'resp-2', closed_at: null });
      expect(retry.emits).toHaveLength(0); // do not release the hard-blocked park key mid-chain
    } else {
      expect(await stateOf(id, ws)).toMatchObject({ state: 'expired' });
      expect(recovered.woke.includes(id)).toBe(latency === 'hard-blocked');
    }
    const rows = await durableAlerts(id);
    expect(rows[0].body).toEqual(original); // first durable content survives replay
    // Leave no synthetic live consult for a later test's broad sweep.
    await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()} WHERE conversation_id = ${id}`;
    return { rows, id, ws };
  }

  it.each([
    ['proceed', false], ['hard-blocked', false],
    ['proceed', true], ['hard-blocked', true],
  ] as const)('deduplicates committed alerts after a lost acknowledgement (%s, early=%s)', async (latency, early) => {
    const { rows, id, ws } = await lostAcknowledgementProbe(latency, early);
    assertSingleAlert(rows, id, ws);
  });

  it('mutation control: dropping the replay key is caught by the SAME single-alert oracle', async () => {
    const { rows, id, ws } = await lostAcknowledgementProbe('proceed', true, true);
    expect(rows).toHaveLength(2);
    expect(() => assertSingleAlert(rows, id, ws)).toThrow();
  });

  it.each(['unknown', 'missing', 'throws'])('never invents an early stall from %s liveness', async (mode) => {
    const id = await seedConsult({
      expiresAt: FUTURE,
      updatedAt: PAST,
      routing: menuSnapshot(['resp-1'], ['resp-1-fork']),
    });
    const { deps, alerts } = makeDeps();
    deps.findSilentResponders = consultExpiryFindSilentResponders({
      getPresence: async () => null,
      resolveSessionStates: async () => {
        if (mode === 'throws') throw new Error('oracle unavailable');
        return mode === 'missing' ? new Map() : new Map([['resp-1-fork', { sessionState: 'unknown' }]]);
      },
      getThreadStore: () => { throw new Error('unknown is not evidence of an empty consult'); },
      now: () => NOW,
    });
    const result = await sweepExpiredConsults(deps);
    expect(alerts).toEqual([]);
    expect(result).toMatchObject({ expired: 0, advanced: 0, requesterAlerts: [], requesterAlertFailures: [] });
    expect(await stateOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()} WHERE conversation_id = ${id}`;
  });
});

// ── P-014 / RSR-P-014-A: a silent review consult at half its TTL becomes pullable work ──
describe('review consult conversion at half TTL (review-system-rework-reduction-2026-09-23 P-014)', () => {
  const MIN = 60_000;
  const at = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * MIN).toISOString();
  const VETTING = { policy: 'rubric-vetting', ...menuSnapshot(['resp-1', 'resp-2']) };
  const GRADING = {
    ...menuSnapshot(['resp-1', 'resp-2']),
    cascade: { flavor: 'acceptance-grading', planSlug: 'plan-x', rubricId: 'rubric-x', harnessSlug: 'hx' },
  };
  const seeded: string[] = [];

  /** Seed with an explicit TTL window (created_at → expires_at) and exchange count. */
  async function seedReview(opts: {
    routing: unknown;
    createdMin: number;
    expiresMin: number;
    exchangesUsed?: number;
    latency?: 'proceed' | 'hard-blocked';
  }): Promise<string> {
    seq += 1;
    const id = `conv-review-${seq}`;
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, expires_at, routing, cascade_cursor, exchanges_used, created_at, updated_at)
      VALUES
        (${WS}, ${id}, 'rubric-author', 'resp-1', 'awaiting_responder', 'Vet acceptance rubric R rev 2',
         ${opts.latency ?? 'proceed'}, ${at(opts.expiresMin)}::timestamptz,
         ${rootSql.json(opts.routing as never)}, 0, ${opts.exchangesUsed ?? 0},
         ${at(opts.createdMin)}::timestamptz, ${at(opts.createdMin)}::timestamptz)`;
    await rootSql`
      INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, state, updated_at)
      VALUES (${WS}, ${id}, 'consult', 'open', ${at(opts.createdMin)}::timestamptz)`;
    seeded.push(id);
    return id;
  }

  function withFiler(fail = false) {
    const base = makeDeps({ withReach: true });
    const filed: Array<Parameters<NonNullable<ExpirySweepDeps['fileReviewWorkItem']>>[0]> = [];
    base.deps.fileReviewWorkItem = async (req) => {
      filed.push(req);
      if (fail) throw new Error('work-item store down');
      return { id: `WI-review-${req.conversationId}` };
    };
    return { ...base, filed };
  }

  async function rowOf(id: string) {
    const rows = (await rootSql`
      SELECT state, closed_at, cascade_cursor, outcome, responder_id FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`) as unknown as Array<Record<string, unknown>>;
    const row = rows[0]!;
    if (typeof row.outcome === 'string') row.outcome = JSON.parse(row.outcome);
    return row;
  }

  afterAll(async () => {
    if (seeded.length > 0) {
      await rootSql`UPDATE harness_shared.consult_state SET closed_at = ${NOW.toISOString()}
                     WHERE conversation_id = ANY(${seeded}) AND closed_at IS NULL`;
    }
  });

  it('keeps an early silent review consult open when its cascade menu is exhausted', async () => {
    // The responder re-parked after routing, but the 30-minute review window
    // has not reached P-014's half-TTL conversion point yet.
    const routing = { policy: 'rubric-vetting', ...menuSnapshot(['resp-1'], ['resp-1-fork']) };
    const id = await seedReview({
      routing,
      createdMin: -3,
      expiresMin: 27,
      latency: 'hard-blocked',
    });
    const { deps, filed, reachCalls } = withFiler();
    deps.findSilentResponders = async () => new Set([id]);

    const result = await sweepExpiredConsults(deps);

    expect(result).toMatchObject({ expired: 0, advanced: 0, converted: [], conversionFailures: [] });
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null, cascade_cursor: 0 });
    expect(filed.filter((f) => f.conversationId === id)).toEqual([]);
    expect(reachCalls.filter((c) => c.conversationId === id)).toEqual([]);
  });

  it('converts a silent rubric-vetting consult past half its TTL to a work item instead of cascading', async () => {
    // Window -70min → +50min: the midpoint (-10min) is behind NOW; nobody has engaged.
    const id = await seedReview({ routing: VETTING, createdMin: -70, expiresMin: 50 });
    const { deps, filed, reachCalls, alerts } = withFiler();
    const result = await sweepExpiredConsults(deps);

    expect(filed.filter((f) => f.conversationId === id)).toEqual([
      expect.objectContaining({
        workspaceId: WS, conversationId: id, kind: 'rubric-vetting',
        requesterId: 'rubric-author', silentResponderId: 'resp-1',
      }),
    ]);
    expect(result.converted).toContainEqual({ conversationId: id, workItemId: `WI-review-${id}`, kind: 'rubric-vetting' });
    // NOT cascaded: no dispatch to resp-2, the cursor never moved.
    expect(reachCalls.filter((c) => c.conversationId === id)).toEqual([]);
    const row = await rowOf(id);
    expect(row).toMatchObject({ state: 'expired', cascade_cursor: 0 });
    expect(row.closed_at).not.toBeNull();
    expect(row.outcome).toMatchObject({
      disposition: 'converted_to_review_work_item', work_item_id: `WI-review-${id}`, review_kind: 'rubric-vetting',
    });
    expect((await conversationStateOf(id)).state).toBe('expired');
    // The requester is told where the review went and how to record vetting from it.
    const alert = alerts.find((a) => a.conversationId === id)!;
    expect(alert.msgId).toContain('consult-review-conversion');
    expect(alert.body).toContain(`vettingWorkItem: 'WI-review-${id}'`);
  });

  it('does not send a conversion alert when a reply closes the consult during work-item filing', async () => {
    const closedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const id = await seedReview({ routing: VETTING, createdMin: -70, expiresMin: 50 });
    const { deps, filed, alerts } = withFiler();
    deps.fileReviewWorkItem = async (req) => {
      filed.push(req);
      await rootSql`
        UPDATE harness_shared.consult_state
           SET state = 'closed_answered',
               exchanges_used = 1,
               closed_at = ${closedAt}::timestamptz,
               updated_at = ${closedAt}::timestamptz
         WHERE workspace_id = ${WS} AND conversation_id = ${id}
      `;
      await rootSql`
        UPDATE harness_shared.coord_conversations
           SET state = 'closed', updated_at = ${closedAt}::timestamptz
         WHERE workspace_id = ${WS} AND id = ${id}
      `;
      return { id: `WI-review-${id}` };
    };

    const result = await sweepExpiredConsults(deps);

    expect(filed.filter((request) => request.conversationId === id)).toHaveLength(1);
    expect(result).toMatchObject({ converted: [], conversionFailures: [] });
    expect(alerts).toEqual([]);
    const closed = await rowOf(id);
    expect(closed.state).toBe('closed_answered');
    expect(closed.closed_at).not.toBeNull();
  });

  it('converts a due silent review consult rather than cascading or expiring it without a work item', async () => {
    const id = await seedReview({ routing: VETTING, createdMin: -130, expiresMin: -10 });
    const { deps, filed, reachCalls } = withFiler();
    await sweepExpiredConsults(deps);
    expect(filed.map((f) => f.conversationId)).toContain(id);
    expect(reachCalls.filter((c) => c.conversationId === id)).toEqual([]);
    expect((await rowOf(id)).outcome).toMatchObject({ disposition: 'converted_to_review_work_item' });
  });

  it('converts an acceptance-grading cascade and hands the filer its routing (reservation reuse)', async () => {
    const id = await seedReview({ routing: GRADING, createdMin: -70, expiresMin: 50 });
    const { deps, filed } = withFiler();
    const result = await sweepExpiredConsults(deps);
    const req = filed.find((f) => f.conversationId === id)!;
    expect(req.kind).toBe('acceptance-grading');
    expect(req.routing).toMatchObject({ cascade: { flavor: 'acceptance-grading', planSlug: 'plan-x' } });
    expect(result.converted).toContainEqual(expect.objectContaining({ conversationId: id, kind: 'acceptance-grading' }));
  });

  it('converts an unstamped acceptance dispatch after pickup grace before half TTL', async () => {
    const id = await seedReview({ routing: GRADING, createdMin: -40, expiresMin: 200 });
    await rootSql`
      UPDATE harness_shared.consult_state
         SET cascade_cursor = 1, responder_id = 'resp-2'
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
    const { deps, filed, reachCalls } = withFiler();
    const detector = consultExpiryFindSilentResponders({
      getPresence: async () => { throw new Error('no answering owner exists'); },
      resolveSessionStates: async () => { throw new Error('source liveness is not dispatch proof'); },
      getThreadStore: () => ({
        getThreadByParent: async (parent) => ({ thread_id: `thread-${parent.ref}` }) as never,
        // The first grader's decline is a real post but not pickup by resp-2.
        listRecentPosts: async () => ({ total: 1, posts: [{ author_id: 'resp-1' }] }),
      }),
      now: () => NOW,
    });
    deps.findSilentResponders = (rows) => detector(rows.filter((row) => row.conversationId === id));

    const result = await sweepExpiredConsults(deps);

    expect(result.converted).toContainEqual({ conversationId: id, workItemId: `WI-review-${id}`, kind: 'acceptance-grading' });
    expect(filed.filter((request) => request.conversationId === id)).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ state: 'expired', closed_at: expect.anything() });
    expect(reachCalls.filter((call) => call.conversationId === id)).toEqual([]);
  });

  it('leaves a review consult alone before half its TTL, once someone has engaged, or when it is not a review', async () => {
    const early = await seedReview({ routing: VETTING, createdMin: -10, expiresMin: 110 });
    const engaged = await seedReview({ routing: VETTING, createdMin: -70, expiresMin: 50, exchangesUsed: 1 });
    const ordinary = await seedReview({ routing: menuSnapshot(['resp-1', 'resp-2']), createdMin: -70, expiresMin: 50 });
    const { deps, filed } = withFiler();
    const result = await sweepExpiredConsults(deps);
    const touched = filed.map((f) => f.conversationId);
    for (const id of [early, engaged, ordinary]) {
      expect(touched).not.toContain(id);
      expect(result.converted.map((c) => c.conversationId)).not.toContain(id);
      expect(await rowOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });
    }
  });

  it('retries a failed conversion on the next tick; the consult stays open until the item is filed', async () => {
    const id = await seedReview({ routing: VETTING, createdMin: -70, expiresMin: 50 });
    const failing = withFiler(true);
    const first = await sweepExpiredConsults(failing.deps);
    expect(first.conversionFailures).toContain(id);
    expect(failing.reachCalls.filter((c) => c.conversationId === id)).toEqual([]);
    expect(await rowOf(id)).toMatchObject({ state: 'awaiting_responder', closed_at: null });

    const healthy = withFiler();
    const second = await sweepExpiredConsults(healthy.deps);
    expect(second.converted.map((c) => c.conversationId)).toContain(id);
    expect((await rowOf(id)).outcome).toMatchObject({ work_item_id: `WI-review-${id}` });
  });

  it('wakes a hard-blocked requester with the work item instead of leaving them parked', async () => {
    const id = await seedReview({ routing: VETTING, createdMin: -3, expiresMin: 2, latency: 'hard-blocked' });
    const { deps, emits } = withFiler();
    await sweepExpiredConsults(deps);
    const emit = emits.find((e) => e.payload.conversation_id === id)!;
    expect(emit).toMatchObject({ to: ['rubric-author'], workspaceId: WS });
    expect(emit.payload).toMatchObject({ kind: 'converted', work_item_id: `WI-review-${id}` });
  });

  it('keeps the pre-P-014 cascade when no filer is bound', async () => {
    const id = await seedReview({ routing: VETTING, createdMin: -130, expiresMin: -10 });
    const { deps, reachCalls } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);
    expect(reachCalls.filter((c) => c.conversationId === id).map((c) => c.responder)).toEqual(['resp-2']);
  });
});

describe('P-003 idle answering sessions end at the consult window (WI-10003199)', () => {
  async function attemptsOf(id: string): Promise<Array<Record<string, unknown>>> {
    const rows = (await rootSql`
      SELECT dispatch_attempts FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}
    `) as unknown as Array<{ dispatch_attempts: unknown }>;
    const v = rows[0]!.dispatch_attempts;
    return (typeof v === 'string' ? JSON.parse(v) : v) as Array<Record<string, unknown>>;
  }

  /** A fake task ledger: the answering sessions still running, and every stop call. */
  function withStopper(deps: ExpirySweepDeps, running: Set<string>, opts: { throws?: boolean } = {}) {
    const stops: Array<Parameters<NonNullable<ExpirySweepDeps['stopAnsweringSession']>>[0]> = [];
    deps.stopAnsweringSession = async (t) => {
      stops.push(t);
      if (opts.throws) throw new Error('ledger down');
      const key = t.answeringOwnerId ?? t.sourceOwnerId;
      return running.delete(key) ? `stopped task for ${key}` : 'no live answering session found';
    };
    return stops;
  }

  it('an expired silent slot is stopped and recorded as a failed attempt with the expiry reason (cascade advances)', async () => {
    const id = await seedConsult({ routing: menuSnapshot(['resp-1', 'resp-2'], ['resp-1-fork']) });
    const { deps } = makeDeps({ withReach: true });
    const running = new Set(['resp-1-fork']);
    const stops = withStopper(deps, running);

    const r = await sweepExpiredConsults(deps);

    expect(r.answerFailures.filter((f) => f.conversationId === id)).toEqual([
      { conversationId: id, reason: 'answer-window-expired', stopOutcome: 'stopped task for resp-1-fork', recorded: true },
    ]);
    expect(stops.filter((s) => s.conversationId === id)).toEqual([
      { workspaceId: WS, conversationId: id, answeringOwnerId: 'resp-1-fork', sourceOwnerId: 'resp-1' },
    ]);
    expect(running.has('resp-1-fork')).toBe(false);
    const attempts = await attemptsOf(id);
    expect(attempts.at(-1)).toMatchObject({
      sourceOwnerId: 'resp-1',
      dispatched: false,
      answeringOwnerId: 'resp-1-fork',
      answerFailure: { reason: 'answer-window-expired', cascadeCursor: 0 },
      attempts: [{ outcome: 'failed', reason: 'answer-window-expired' }],
    });
  });

  it('the terminal expiry of an exhausted menu stops and records the last silent slot', async () => {
    const id = await seedConsult({ routing: menuSnapshot(['resp-1'], ['resp-1-fork']) });
    const { deps } = makeDeps();
    const running = new Set(['resp-1-fork']);
    withStopper(deps, running);

    const r = await sweepExpiredConsults(deps);

    expect((await stateOf(id)).state).toBe('expired');
    expect(r.answerFailures.filter((f) => f.conversationId === id).map((f) => f.reason)).toEqual(['answer-window-expired']);
    expect(running.has('resp-1-fork')).toBe(false);
    expect((await attemptsOf(id)).at(-1)).toMatchObject({ attempts: [{ outcome: 'failed', reason: 'answer-window-expired' }] });
  });

  it('a slot whose responder already engaged (state active) is neither stopped nor recorded', async () => {
    const id = await seedConsult({ state: 'active', routing: menuSnapshot(['resp-1'], ['resp-1-fork']) });
    const { deps } = makeDeps();
    const running = new Set(['resp-1-fork']);
    const stops = withStopper(deps, running);

    const r = await sweepExpiredConsults(deps);

    expect(stops.filter((s) => s.conversationId === id)).toEqual([]);
    expect(r.answerFailures.filter((f) => f.conversationId === id)).toEqual([]);
    expect(running.has('resp-1-fork')).toBe(true);
    expect(await attemptsOf(id)).toEqual([]);
  });

  it('a stop that throws still records the failure, naming the stop error', async () => {
    const id = await seedConsult({ routing: menuSnapshot(['resp-1'], ['resp-1-fork']) });
    const { deps } = makeDeps();
    withStopper(deps, new Set(['resp-1-fork']), { throws: true });

    const r = await sweepExpiredConsults(deps);

    expect(r.answerFailures.find((f) => f.conversationId === id)).toMatchObject({ recorded: true, stopOutcome: 'stop threw: ledger down' });
    expect(String((await attemptsOf(id)).at(-1)?.detail)).toContain('stop threw: ledger down');
  });
});

// ── a requester's proceed-reconciliation survives the sweep's terminal writes ──
// EI-23764501791910357 slice 3. `outcome.reconciliation` (written by consult:reconcile)
// is what discharges a proceed-consult's reconciliation obligation. The sweep's two
// outcome-REPLACING terminal writers — the cascade-exhausted expiry and the P-014
// review-conversion flip — must carry it forward, or a sweep landing after the
// requester reconciled would silently RE-OPEN the debt.
describe.each(['confirmed', 'rescoped', 'reversed', 'moot'] as const)('sweepExpiredConsults — carries a recorded reconciliation through the terminal write (EI-23764501791910357): %s', (disposition) => {
  const RECONCILIATION = {
    disposition,
    note: 'kept going on my assumption, narrowed scope when the answer arrived',
    by: 'req-1',
    at: PAST,
    consult_state: 'awaiting_responder',
  };
  const cand = (ownerId: string, score: number, similarity: number) => ({
    ownerId,
    score,
    relevance: score,
    signals: { similarity },
    liveness: 'live',
  });

  async function reconcileRow(id: string) {
    await rootSql`
      UPDATE harness_shared.consult_state
         SET outcome = ${rootSql.json({ reconciliation: RECONCILIATION } as never)}
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`;
  }
  async function outcomeOf(id: string) {
    const rows = (await rootSql`
      SELECT state, outcome FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`) as unknown as Array<{ state: string; outcome: unknown }>;
    const row = rows[0]!;
    return { state: row.state, outcome: typeof row.outcome === 'string' ? JSON.parse(row.outcome) : row.outcome };
  }

  it('terminal expiry WITH collected answers: the answered-flavored outcome lands BESIDE the reconciliation', async () => {
    const routing = {
      relevanceFloor: 0.5,
      simFloor: 0.4,
      candidates: [cand('ans-a', 0.9, 0.8), cand('exp-b', 0.8, 0.7)],
      selection: {
        min: 1,
        max: 2,
        selected: ['ans-a', 'exp-b'].map((ownerId) => ({
          ownerId, via: 'floor', score: 0.8, relevance: 0.8, similarity: 0.7, liveness: 'live',
        })),
      },
    };
    const id = await seedConsult({ latency: 'hard-blocked', routing, cascadeCursor: 1 });
    await setDigest(id, [{ ownerId: 'ans-a', kind: 'answer', at: PAST, excerpt: 'a real answer' }]);
    await reconcileRow(id);
    const { deps } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);

    expect(await outcomeOf(id)).toEqual({
      state: 'expired',
      outcome: {
        disposition: 'cascade_exhausted_with_answers',
        answers: 1,
        answered_by: ['ans-a'],
        reconciliation: RECONCILIATION,
      },
    });
  });

  it('terminal expiry with ZERO answers: the reconciliation-only outcome is left intact (a NULL new outcome must not erase it)', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot(['only-r']) });
    await reconcileRow(id);
    const { deps } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);

    expect(await outcomeOf(id)).toEqual({ state: 'expired', outcome: { reconciliation: RECONCILIATION } });
  });

  it('CONTROL: terminal expiry with zero answers and NO reconciliation still writes a NULL outcome (not "{}" or a JSON null)', async () => {
    const id = await seedConsult({ latency: 'hard-blocked', routing: menuSnapshot(['only-r']) });
    const { deps } = makeDeps({ withReach: true });
    await sweepExpiredConsults(deps);

    const [{ sql_null }] = (await rootSql`
      SELECT outcome IS NULL AS sql_null FROM harness_shared.consult_state
       WHERE workspace_id = ${WS} AND conversation_id = ${id}`) as unknown as Array<{ sql_null: boolean }>;
    expect(sql_null).toBe(true);
  });

  it('P-014 review conversion: the converted_to_review_work_item outcome lands BESIDE the reconciliation', async () => {
    seq += 1;
    const id = `conv-recon-review-${seq}`;
    const at = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * 60_000).toISOString();
    await rootSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question,
         latency_contract, expires_at, routing, cascade_cursor, exchanges_used, created_at, updated_at, outcome)
      VALUES
        (${WS}, ${id}, 'req-1', 'resp-1', 'awaiting_responder', 'Vet acceptance rubric R rev 2',
         'proceed', ${at(50)}::timestamptz,
         ${rootSql.json({ policy: 'rubric-vetting', ...menuSnapshot(['resp-1', 'resp-2']) } as never)}, 0, 0,
         ${at(-70)}::timestamptz, ${at(-70)}::timestamptz,
         ${rootSql.json({ reconciliation: RECONCILIATION } as never)})`;
    await rootSql`
      INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, state, updated_at)
      VALUES (${WS}, ${id}, 'consult', 'open', ${at(-70)}::timestamptz)`;
    const base = makeDeps({ withReach: true });
    base.deps.fileReviewWorkItem = async (req) => ({ id: `WI-review-${req.conversationId}` });
    await sweepExpiredConsults(base.deps);

    expect(await outcomeOf(id)).toEqual({
      state: 'expired',
      outcome: {
        disposition: 'converted_to_review_work_item',
        work_item_id: `WI-review-${id}`,
        review_kind: 'rubric-vetting',
        silent_responder: 'resp-1',
        reconciliation: RECONCILIATION,
      },
    });
  });
});
