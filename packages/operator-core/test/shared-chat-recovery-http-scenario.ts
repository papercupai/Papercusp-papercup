/** Current bundled operator, private migrated PG, real HTTP; no provider stubs. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import { parseSseStream } from '@papercusp/sse';
import { getOrCreateActiveConversation } from '../lib/operator-conversations';
import { admitConverseTurn } from '../lib/agent-tools/operator/converse-turn';

async function nextApplicationFrame(frames: ReturnType<typeof parseSseStream>) {
  let frame = await frames.next();
  while (!frame.done && frame.value.event === 'heartbeat') frame = await frames.next();
  return frame;
}

export async function measureSharedChatRecovery(input: { workspace: string; base: string }) {
  const { workspace, base } = input;
  assert.match(workspace, /^test-runtime-/);
  assert.ok(!['3070', '3170'].includes(new URL(base).port));
  const { sql } = getOrgPg();
  const name = 'shared-chat-recovery';
  const bearer = randomUUID();
  await sql.unsafe(`INSERT INTO harness_shared.system_principals (workspace_id,name,bearer_hash,capabilities)
    VALUES ($1,$2,$3,'["chat:write"]')`, [workspace, name, createHash('sha256').update(bearer).digest('hex')]);
  await sql.unsafe(`INSERT INTO harness_shared.token_index (workspace_id,harness_slug,kind,token)
    VALUES ($1,$2,'system',$3)`, [workspace, `system:${name}`, bearer]);
  const conversation = await getOrCreateActiveConversation(workspace);
  const identity = { conversationId: conversation.id, turnId: randomUUID() };
  const principalId = `system:${name}`;
  const admit = (turn = identity) => admitConverseTurn({ options: { sql, workspaceId: workspace, turn,
    scope: { principalId, tenantId: workspace, customerId: principalId, publicOwnerId: principalId } },
    credential: { kind: 'system', name, bearer }, capability: 'chat:write', toolName: 'chat:ask_choice',
    runId: randomUUID(), source: 'text_typed' });
  const turn = await admit();
  const controllers: AbortController[] = [];
  const post = (body: object) => {
    const ctrl = new AbortController(); controllers.push(ctrl);
    return fetch(`${base}/api/agent-mcp/operator-converse`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-papercusp-workspace': workspace },
      body: JSON.stringify({ chatProtocolVersion: 1, ...identity, ...body }),
      signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(15000)]) });
  };
  try {
    let published = 0;
    await turn.publish({ type: 'delta', text: '<say>First ' }, () => { published++; });
    const first = await post({ operation: 'reconnect', afterSequence: 0 });
    assert.equal(first.status, 200, await (first.ok ? Promise.resolve('') : first.text()));
    const firstFrames = parseSseStream(first.body);
    const initial = await nextApplicationFrame(firstFrames);
    assert.equal(initial.value?.event, 'chat-event');
    assert.equal(JSON.parse(initial.value!.data).sequence, 1);
    controllers[0].abort();
    await firstFrames.return();
    assert.equal((await turn.store.read(identity))!.state.phase, 'running', 'socket detach must not cancel execution');

    await turn.publish({ type: 'delta', text: 'Second</say>' }, () => { published++; });
    const second = await post({ operation: 'reconnect', afterSequence: 1 });
    assert.equal(second.status, 200);
    const secondFrames = parseSseStream(second.body);
    const resumed = await nextApplicationFrame(secondFrames);
    assert.equal(resumed.value?.event, 'chat-event');
    assert.deepEqual(JSON.parse(resumed.value!.data), { schemaVersion: 1, ...identity,
      eventId: JSON.parse(resumed.value!.data).eventId, sequence: 2, event: { type: 'delta', text: 'Second</say>' } });

    const cancellation = await post({ operation: 'cancel' });
    assert.equal(cancellation.status, 200);
    assert.equal((await cancellation.json()).state.phase, 'cancelled');
    assert.equal((await turn.store.read(identity))!.state.phase, 'cancelled');
    let done: { persistedTurn?: unknown; phase?: string } | undefined;
    for await (const event of secondFrames) {
      if (event.event === 'chat-event') assert.fail('cursor replay duplicated a prior event');
      if (event.event === 'done') { done = JSON.parse(event.data); break; }
    }
    assert.equal(done?.phase, 'cancelled');
    const before = await turn.store.read(identity);
    await assert.rejects(turn.publish({ type: 'delta', text: 'late' }, () => { published++; }), /cancelled/);
    assert.equal(published, 2);
    assert.deepEqual(await turn.store.read(identity), before);
    const terminal = await turn.finalize({ status: 'cancelled', text: 'First Second' });
    assert.deepEqual(done?.persistedTurn, terminal);

    const missing = await post({ operation: 'reconnect', turnId: randomUUID(), afterSequence: 0 });
    assert.equal(missing.status, 404);
    const corruptIdentity = { ...identity, turnId: randomUUID() };
    await admit(corruptIdentity);
    await sql.unsafe(`UPDATE harness_shared.operator_turns
      SET chat_state=jsonb_set(chat_state,'{schemaVersion}','99') WHERE id=$1`, [corruptIdentity.turnId]);
    const corrupt = await post({ operation: 'reconnect', turnId: corruptIdentity.turnId });
    assert.equal(corrupt.status, 503);

    await sql.unsafe(`UPDATE harness_shared.system_principals SET capabilities='[]'
      WHERE workspace_id=$1 AND name=$2`, [workspace, name]);
    const revoked = await post({ operation: 'reconnect', afterSequence: 0 });
    assert.equal(revoked.status, 403);
    const rows = await sql.unsafe(`SELECT id,text,chat_state->'execution'->>'status' AS status
      FROM harness_shared.operator_turns WHERE conversation_id=$1 ORDER BY seq`, [identity.conversationId]);
    assert.equal(rows.length, 2, 'reconnect/cancel must never admit another assistant');
    assert.deepEqual(rows[0], { id: identity.turnId, text: 'First Second', status: 'cancelled' });
    return { workspace, identity, terminal, published, status: 'cancelled', rows: rows.length,
      missing: missing.status, corrupt: corrupt.status, revoked: revoked.status };
  } finally {
    controllers.forEach(ctrl => ctrl.abort());
  }
}
