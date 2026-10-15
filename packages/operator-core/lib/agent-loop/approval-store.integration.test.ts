/**
 * approval-store.integration.test.ts — the loop HITL approval round-trip
 * against a REAL fully-migrated Postgres (migration 934).
 *
 * Same rationale as agent-chat-lock.integration.test.ts (its sibling in the
 * same bug class): the cross-worker property this table exists for — the SSE
 * worker polls a decision another worker wrote — is invisible to a mocked-sql
 * unit test BY CONSTRUCTION. The discriminating assertions here are (a) a
 * decision written on an INDEPENDENT connection unblocks a waiter polling on
 * the module's own connection, and (b) direct table reads pin that state
 * actually lives in PG.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const {
  awaitLoopApprovalDecision,
  createLoopApproval,
  listPendingLoopApprovals,
  resolveLoopApproval,
} = await import('./approval-store');
const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_loop_approvals`;
});

/** An independent connection — the stand-in for a second cluster worker
 *  serving the approval POST. */
function otherWorker(): Sql {
  return postgres(db.adminDsn, {
    max: 1,
    onnotice: () => {},
    prepare: false,
    connection: { search_path: 'harness_shared, public' },
  });
}

/** Hold delivery of a real PG query so cancellation/deadline changes
 * happen after it completes, rather than relying on a scheduling race. All
 * queries and results still come from the suite's actual database. */
function afterApprovalQuery(queryText: string, afterQuery: () => Promise<void> | void): Sql {
  let intercepted = false;
  return new Proxy(sql, {
    apply(target, thisArg, args) {
      const query = Reflect.apply(target, thisArg, args);
      const text = args[0] as TemplateStringsArray;
      if (!intercepted && text[0]?.includes(queryText)) {
        intercepted = true;
        return query.then(async (rows: unknown) => {
          await afterQuery();
          return rows;
        });
      }
      return query;
    },
  });
}

const REQ = {
  chatId: 'chat-1',
  callId: 'call-1',
  workspaceId: 'ws-1',
  toolName: 'capability:bash',
  toolInput: { command: 'echo hi' },
  stepIndex: 0,
};

describe('agent-loop approval store — real Postgres (migration 934)', () => {
  it('create → pending list shows the request with its tool payload', async () => {
    await createLoopApproval(REQ);
    const pending = await listPendingLoopApprovals({ chatId: 'chat-1', workspaceId: 'ws-1' });
    expect(pending).toHaveLength(1);
    expect(pending[0].callId).toBe('call-1');
    expect(pending[0].toolName).toBe('capability:bash');
    expect(pending[0].toolInput).toEqual({ command: 'echo hi' });
  });

  it('a decision resolved on a DIFFERENT connection unblocks the polling waiter (the clustered-worker shape)', async () => {
    await createLoopApproval(REQ);
    const worker2 = otherWorker();
    try {
      const waiter = awaitLoopApprovalDecision({
        chatId: 'chat-1',
        callId: 'call-1',
        workspaceId: 'ws-1',
        pollMs: 60,
        timeoutMs: 10_000,
      });
      // Give the waiter a poll cycle, then resolve from the "other worker".
      await new Promise((r) => setTimeout(r, 150));
      const resolved = await resolveLoopApproval(
        {
          chatId: 'chat-1',
          callId: 'call-1',
          workspaceId: 'ws-1',
          approved: true,
          resolvedBy: 'test:worker2',
        },
        { sql: worker2 },
      );
      expect(resolved).toBe(true);
      const decision = await waiter;
      expect(decision.approved).toBe(true);
      // Consumed: the row is gone after the waiter reads its decision.
      const [row] = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM harness_shared.agent_loop_approvals WHERE chat_id = 'chat-1'`;
      expect(Number(row?.n)).toBe(0);
    } finally {
      await worker2.end({ timeout: 5 });
    }
  });

  it('deny carries the reason through to the waiter', async () => {
    await createLoopApproval(REQ);
    const waiter = awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 60,
      timeoutMs: 10_000,
    });
    await new Promise((r) => setTimeout(r, 120));
    await resolveLoopApproval({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      approved: false,
      reason: 'too risky',
    });
    const decision = await waiter;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe('too risky');
  });

  it('resolve is a one-shot: the second resolve returns false (already resolved)', async () => {
    await createLoopApproval(REQ);
    const first = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'ws-1', approved: true,
    });
    const second = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'ws-1', approved: false,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('resolve refuses a workspace mismatch (scoping is part of the WHERE)', async () => {
    await createLoopApproval(REQ);
    const resolved = await resolveLoopApproval({
      chatId: 'chat-1', callId: 'call-1', workspaceId: 'OTHER-ws', approved: true,
    });
    expect(resolved).toBe(false);
  });

  it.each([true, false])('a mismatched waiter cannot consume a resolved approval (approved=%s)', async (approved) => {
    await createLoopApproval(REQ);
    await resolveLoopApproval({
      ...REQ, approved, reason: 'workspace A decision', resolvedBy: 'test:workspace-A',
    });
    const before = await sql`SELECT * FROM harness_shared.agent_loop_approvals`;

    const foreignDecision = await awaitLoopApprovalDecision({
      ...REQ, workspaceId: 'OTHER-ws', timeoutMs: 0,
    });
    expect(foreignDecision.approved).toBe(false);
    expect(foreignDecision.reason).toBe('approval request expired');
    const after = await sql`SELECT * FROM harness_shared.agent_loop_approvals`;
    expect([...after]).toEqual([...before]);

    // The rightful waiter still receives the untouched decision and consumes it.
    const rightfulDecision = await awaitLoopApprovalDecision(REQ);
    expect(rightfulDecision).toEqual({ approved, reason: 'workspace A decision' });
    expect(await sql`SELECT * FROM harness_shared.agent_loop_approvals`).toHaveLength(0);
  });

  it.each(['timeout', 'abort'] as const)('a mismatched waiter cannot deny or delete a pending approval on %s', async (exit) => {
    await createLoopApproval(REQ);
    const before = await sql`SELECT * FROM harness_shared.agent_loop_approvals`;
    const ctrl = new AbortController();
    if (exit === 'abort') ctrl.abort();

    const foreignDecision = await awaitLoopApprovalDecision({
      ...REQ, workspaceId: 'OTHER-ws', timeoutMs: 0, signal: ctrl.signal,
    });
    expect(foreignDecision.approved).toBe(false);
    expect(foreignDecision.reason).toBe(exit === 'abort'
      ? 'approval aborted (run cancelled)' : 'approval request expired');
    const after = await sql`SELECT * FROM harness_shared.agent_loop_approvals`;
    expect([...after]).toEqual([...before]);

    // A foreign wait must leave a request that its own workspace can resolve.
    expect(await resolveLoopApproval({ ...REQ, approved: true })).toBe(true);
    expect((await awaitLoopApprovalDecision(REQ)).approved).toBe(true);
  });

  it('timeout self-denies: the row leaves pending and the waiter gets a deny', async () => {
    await createLoopApproval(REQ);
    const decision = await awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 120,
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('timed out');
    const pending = await listPendingLoopApprovals({ chatId: 'chat-1', workspaceId: 'ws-1' });
    expect(pending).toHaveLength(0);
  });

  it.each([
    ['timeout', 'read'], ['abort', 'read'], ['timeout', 'consume'], ['abort', 'consume'],
  ] as const)('an approved decision cannot cross the waiter %s during its PG %s', async (exit, stage) => {
    await createLoopApproval(REQ);
    expect(await resolveLoopApproval({ ...REQ, approved: true })).toBe(true);
    const ctrl = new AbortController();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let queryCompleted = false;
    try {
      const delayedSql = afterApprovalQuery(stage === 'read'
        ? 'SELECT status, reason' : 'DELETE FROM harness_shared.agent_loop_approvals', () => {
        queryCompleted = true;
        if (exit === 'abort') ctrl.abort();
        // Advance only after the selected PG result exists, so slow queries
        // cannot expire the consume case prematurely at its earlier read.
        else now += 100;
      });

      const decision = await awaitLoopApprovalDecision({
        ...REQ, timeoutMs: exit === 'timeout' ? 50 : 10_000, signal: ctrl.signal,
      }, { sql: delayedSql });

      expect(queryCompleted).toBe(true);
      expect(decision).toEqual({
        approved: false,
        reason: exit === 'timeout' ? 'approval timed out' : 'approval aborted (run cancelled)',
      });
      expect(await sql`SELECT * FROM harness_shared.agent_loop_approvals`).toHaveLength(0);
      expect(await resolveLoopApproval({ ...REQ, approved: true })).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('an approved decision remains usable when its PG read completes within the waiter bounds', async () => {
    await createLoopApproval(REQ);
    expect(await resolveLoopApproval({ ...REQ, approved: true })).toBe(true);
    let readCompleted = false;
    const decision = await awaitLoopApprovalDecision({ ...REQ, timeoutMs: 10_000 }, {
      sql: afterApprovalQuery('SELECT status, reason', () => { readCompleted = true; }),
    });
    expect(readCompleted).toBe(true);
    expect(decision.approved).toBe(true);
    expect(await sql`SELECT * FROM harness_shared.agent_loop_approvals`).toHaveLength(0);
  });

  it('abort self-denies promptly', async () => {
    await createLoopApproval(REQ);
    const ctrl = new AbortController();
    const waiter = awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 10_000,
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    const decision = await waiter;
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('aborted');
  });

  it('a vanished row (age sweep) reads as an expired deny, never an approve', async () => {
    await createLoopApproval(REQ);
    await sql`DELETE FROM harness_shared.agent_loop_approvals`;
    const decision = await awaitLoopApprovalDecision({
      chatId: 'chat-1',
      callId: 'call-1',
      workspaceId: 'ws-1',
      pollMs: 40,
      timeoutMs: 5_000,
    });
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('expired');
  });
});
