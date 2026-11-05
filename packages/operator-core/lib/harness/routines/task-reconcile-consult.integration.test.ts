import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { consultAnswerFacts, consultSettlement } from '../../task-manager/reaper';
import type { TaskRow } from '../../task-manager/types';

let sql: Sql;
let db: MigratedTestDb;
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<Record<string, unknown>>()), getOrgPg: () => ({ sql }),
}));

// Exercise the exact adapter registered with task-reconcile, including its SQL.
import { readConsultStatesForReaper } from './task-reconcile-action';

const WS = 'reaper-followup-it';
const OTHER_WS = 'reaper-other-it';
const OWNER = 'su-answerer';
const EXPERT = 'su-expert';
const CONV = 'conv-followup';
const AT = '2026-11-05T17:40:00.000Z';
const task = {
  workspaceId: WS, class: 'agent-session', detail: { consultAnswer: {
    conversationId: CONV, answeringOwnerId: OWNER, sourceOwnerId: EXPERT, operation: 'fork',
  } },
} as TaskRow;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'consult-reaper' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL, id text NOT NULL, kind text NOT NULL DEFAULT 'question',
      PRIMARY KEY (workspace_id, id))`);
  for (const migration of ['834-consult-threads.sql', '844-consult-cascade-cursor.sql']) {
    await sql.unsafe(readFileSync(new URL(`../../../../../libs/papercusp/libs/db/sql/${migration}`, import.meta.url), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  try { await sql?.end({ timeout: 5 }); } finally { await db?.drop(); }
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.consult_post_meta`;
  await sql`DELETE FROM harness_shared.consult_state`;
  for (const workspace of [WS, OTHER_WS]) {
    await sql`INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, routing)
      VALUES (${workspace}, ${CONV}, 'su-requester', ${EXPERT}, 'active',
        ${sql.json({ selection: { selected: [{ ownerId: EXPERT, answeringOwnerId: OWNER }] } })})`;
  }
});

async function post(id: number, author: string, kind: string, workspace = WS, at = AT) {
  await sql`INSERT INTO harness_shared.consult_post_meta
    (workspace_id, post_id, conversation_id, author_id, kind, created_at)
    VALUES (${workspace}, ${id}, ${CONV}, ${author}, ${kind}, ${at})`;
}

async function loaded() {
  const rows = await readConsultStatesForReaper([task]);
  expect(rows).not.toBeNull();
  expect(rows).toHaveLength(1);
  expect(rows![0].workspaceId).toBe(WS);
  return rows!;
}

describe('EI-27971881208671219: production consult reaper post loading', () => {
  it('loads answer → requester follow-up → responder progress in stable post order and spares the responder', async () => {
    // Same timestamp and reverse insertion order force the post-id tie-breaker.
    await post(30, OWNER, 'new_fact');
    await post(10, EXPERT, 'answer');
    await post(20, 'su-requester', 'question');
    await post(40, OWNER, 'answer', OTHER_WS);
    const rows = await loaded();
    expect(rows[0].responses?.map((p) => [p.authorId, p.kind])).toEqual([
      [EXPERT, 'answer'], ['su-requester', 'question'], [OWNER, 'new_fact'],
    ]);
    expect(consultSettlement(consultAnswerFacts(task)!, rows)).toBeNull();
  });

  it('retains clarifying questions and requester facts as unfinished exchanges', async () => {
    await post(10, OWNER, 'answer');
    await post(20, 'su-requester', 'new_fact');
    await post(30, OWNER, 'clarifying_question');
    const rows = await loaded();
    expect(rows[0].responses?.map((p) => p.kind)).toEqual(['answer', 'new_fact', 'clarifying_question']);
    expect(consultSettlement(consultAnswerFacts(task)!, rows)).toBeNull();
  });

  it.each(['answer', 'decline'])('still settles a final %s at its own time', async (kind) => {
    await post(10, OWNER, 'answer');
    await post(20, 'su-requester', 'question');
    await post(30, OWNER, 'new_fact');
    const finalAt = '2026-11-05T17:50:00.000Z';
    await post(40, OWNER, kind, WS, finalAt);
    const rows = await loaded();
    expect(consultSettlement(consultAnswerFacts(task)!, rows)?.settledAtMs).toBe(Date.parse(finalAt));
  });
});
