/** Current-build private worker for the consult reaper lifetime proof. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { readConsultStatesForReaper } from './task-reconcile-action';
import { consultAnswerFacts, consultSettlement } from '../../task-manager/reaper';
import { flushPendingTelemetry } from '../../projected-tool-deps';
import type { TaskRow } from '../../task-manager/types';

const root = resolve(import.meta.dirname, '../../../../..');
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
assert.match(workspaceId, /^test-runtime-/);
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN'])
  assert.equal(process.env[key], undefined, key + ' must not enter the private runtime');
const hashes = JSON.parse(process.env.CONSULT_REAPER_SOURCE_HASHES!) as Record<string, string>;
const sourceHashes = Object.fromEntries(Object.entries(hashes).map(([path, expected]) => {
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, expected, 'loaded-source receipt changed: ' + path);
  return [path, actual];
}));
const sql = getOrgPg().sql;
const conversationId = 'conv-private-reaper-followup';
const task = { workspaceId, class: 'agent-session', detail: { consultAnswer: {
  conversationId, answeringOwnerId: 'su-private-answerer', sourceOwnerId: 'su-private-expert', operation: 'fork',
} } } as TaskRow;

try {
  const [server] = await sql`SELECT inet_server_port() AS port`;
  assert.equal(String(server!.port), process.env.PAPERCUSP_PG_PORT);
  await sql`INSERT INTO harness_shared.consult_state
    (workspace_id, conversation_id, requester_id, responder_id, state, routing)
    VALUES (${workspaceId}, ${conversationId}, 'su-private-requester', 'su-private-expert', 'active',
      ${sql.json({ selection: { selected: [{ ownerId: 'su-private-expert', answeringOwnerId: 'su-private-answerer' }] } })})`;
  const post = async (id: number, author: string, kind: string, at: string) => {
    await sql`INSERT INTO harness_shared.consult_post_meta
      (workspace_id, post_id, conversation_id, author_id, kind, created_at)
      VALUES (${workspaceId}, ${id}, ${conversationId}, ${author}, ${kind}, ${at})`;
  };
  await post(10, 'su-private-expert', 'answer', '2026-11-05T17:40:00.000Z');
  await post(20, 'su-private-requester', 'question', '2026-11-05T17:44:00.000Z');
  await post(30, 'su-private-answerer', 'new_fact', '2026-11-05T17:46:00.000Z');
  const unfinished = await readConsultStatesForReaper([task]);
  assert.ok(unfinished && unfinished.length === 1);
  assert.equal(unfinished[0]!.responses!.length, 3);
  const unfinishedSettlement = consultSettlement(consultAnswerFacts(task)!, unfinished);
  assert.equal(unfinishedSettlement, null);
  const finalAnswerAt = '2026-11-05T17:50:00.000Z';
  await post(40, 'su-private-answerer', 'answer', finalAnswerAt);
  const final = await readConsultStatesForReaper([task]);
  assert.ok(final && final.length === 1);
  const settlement = consultSettlement(consultAnswerFacts(task)!, final);
  assert.equal(settlement?.settledAtMs, Date.parse(finalAnswerAt));
  await sql`CREATE TABLE harness_shared.consult_reaper_effect
    (workspace_id text, conversation_id text, settled_at timestamptz)`;
  await sql`INSERT INTO harness_shared.consult_reaper_effect VALUES
    (${workspaceId}, ${conversationId}, ${new Date(settlement!.settledAtMs!)})`;
  const persisted = await sql`SELECT settled_at FROM harness_shared.consult_reaper_effect
    WHERE workspace_id=${workspaceId} AND conversation_id=${conversationId}`;
  assert.equal(persisted.length, 1);
  assert.equal(new Date(persisted[0]!.settled_at).toISOString(), finalAnswerAt);
  console.log('CONSULT_REAPER_RECEIPT ' + JSON.stringify({ workspaceId, sourceHashes,
    unfinishedPosts: unfinished[0]!.responses!.length, unfinishedSettlement,
    finalPosts: final[0]!.responses!.length, persistedSettlements: persisted.length, finalAnswerAt }));
} finally {
  await flushPendingTelemetry();
  await sql.end({ timeout: 5 });
}
