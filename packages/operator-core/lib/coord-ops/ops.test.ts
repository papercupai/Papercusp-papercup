/**
 * P0 — coord-op behaviour with fake caps. Each op is exercised through its `run`
 * + the registry (the same path the program executor + the tool wrappers use).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import './index.js'; // register all ops
import { requireCoordOp, coordOpNames, getCoordOp } from './registry.js';
import { makeFakeCaps, makeCtx, votePostBody } from './test-support.js';
import type { CollectedPost } from './types.js';

test('registry — all expected ops registered', () => {
  const names = coordOpNames();
  for (const n of [
    'coord:thread-open',
    'coord:thread-post',
    'orchestrator:spawn-roles',
    'coord:escalate',
    'coord:subscribe',
    'coord:collect',
    'vote:aggregate',
    'resolve',
    'coord:vote',
    'coord:deliberate',
    'coord:ask',
  ]) {
    assert.ok(names.has(n), `op "${n}" should be registered`);
  }
});

test('durable coordination effects reuse thread/member identities and isolate new runs', async () => {
  const { caps, calls } = makeFakeCaps();
  const thread = requireCoordOp('coord:thread-open');
  const spawn = requireCoordOp('orchestrator:spawn-roles');
  const ctx = { ...makeCtx(caps), effectId: 'coord-program:run-1:step' };
  await thread.run(thread.argsSchema.parse({ title: 'A decision' }), ctx);
  await thread.run(thread.argsSchema.parse({ title: 'A decision' }), ctx);
  assert.equal(calls.openThread[0].id, calls.openThread[1].id);
  assert.ok(calls.openThread[0].id?.startsWith('conv-'));
  await thread.run(thread.argsSchema.parse({ title: 'A decision' }), { ...ctx, effectId: 'coord-program:run-2:step' });
  assert.notEqual(calls.openThread[0].id, calls.openThread[2].id);
  const args = spawn.argsSchema.parse({ conversation_id: 'c', roles: [{ role: 'voter', count: 2 }] });
  await spawn.run(args, ctx);
  await spawn.run(args, ctx);
  const first = calls.spawnRoles[0].map((s) => s.idempotencyKey);
  assert.ok(first.every((key) => typeof key === 'string' && key.length > 0));
  assert.deepEqual(calls.spawnRoles[1].map((s) => s.idempotencyKey), first);
  assert.equal(new Set(first).size, 2);
  await spawn.run(args, { ...ctx, effectId: 'coord-program:run-2:step' });
  const independentRun = calls.spawnRoles[2].map((s) => s.idempotencyKey);
  assert.ok(independentRun.every((key) => typeof key === 'string' && key.length > 0));
  assert.equal(new Set(independentRun).size, 2);
  assert.equal(independentRun.some((key) => first.includes(key)), false);
});

test('coord:thread-open opens a thread + returns ids', async () => {
  const { caps, calls } = makeFakeCaps();
  const op = requireCoordOp('coord:thread-open');
  const r = (await op.run(op.argsSchema.parse({ title: 'Ship?', kind: 'discussion' }), makeCtx(caps))) as {
    thread_id: string;
    conversation_id: string;
  };
  assert.equal(r.conversation_id, 'conv-fake');
  assert.equal(calls.openThread[0]?.title, 'Ship?');
});

test('coord:collect resolves on quorum', async () => {
  const posts: CollectedPost[] = [
    { id: 1, author_id: 'a', body: 'x', created_ts: 't' },
    { id: 2, author_id: 'b', body: 'y', created_ts: 't' },
    { id: 3, author_id: 'c', body: 'z', created_ts: 't' },
  ];
  const { caps, calls } = makeFakeCaps({ posts: () => posts });
  const op = requireCoordOp('coord:collect');
  const r = (await op.run(op.argsSchema.parse({ conversation_id: 'conv-1', quorum: 3, timeout_s: 300 }), makeCtx(caps))) as {
    count: number;
    reason: string;
  };
  assert.equal(r.reason, 'quorum');
  assert.equal(r.count, 3);
  assert.equal(calls.sleeps.length, 0); // resolved on first read, never slept
});

test('coord:collect times out when quorum is never met', async () => {
  const posts: CollectedPost[] = [{ id: 1, author_id: 'a', body: 'x', created_ts: 't' }];
  const { caps, calls } = makeFakeCaps({ posts: () => posts });
  const op = requireCoordOp('coord:collect');
  // timeout_s=1, poll_ms=100 → 10 polls then timeout; instant fake sleep
  const r = (await op.run(op.argsSchema.parse({ conversation_id: 'c', quorum: 3, timeout_s: 1, poll_ms: 100 }), makeCtx(caps))) as {
    reason: string;
    count: number;
  };
  assert.equal(r.reason, 'timeout');
  assert.equal(r.count, 1);
  assert.equal(calls.sleeps.length, 10);
});

test('orchestrator:spawn-roles expands per-lens + caps at max_voters', async () => {
  const { caps, calls } = makeFakeCaps();
  const op = requireCoordOp('orchestrator:spawn-roles');
  const r = (await op.run(
    op.argsSchema.parse({
      conversation_id: 'conv-1',
      inject: { question: 'Ship?' },
      roles: [
        { role: 'voter', per: ['risk', 'cost', 'ux', 'perf', 'sec', 'legal'], as: 'lens' },
        { role: 'advocate', count: 1 },
      ],
      max_voters: 4,
    }),
    makeCtx(caps),
  )) as { launched: number; spawned: { role: string; inject: Record<string, unknown> }[] };
  // 4 voters (capped from 6) + 1 advocate
  assert.equal(r.launched, 5);
  const voters = r.spawned.filter((s) => s.role === 'voter');
  assert.equal(voters.length, 4);
  assert.deepEqual(
    voters.map((v) => v.inject.lens),
    ['risk', 'cost', 'ux', 'perf'],
  );
  // every spawn carries the conversation_id + base inject
  assert.equal(voters[0]?.inject.conversation_id, 'conv-1');
  assert.equal(voters[0]?.inject.question, 'Ship?');
  assert.equal(calls.spawnRoles[0]?.length, 5);
});

test('orchestrator:spawn-roles threads ctx.blueprintId onto every spec (prompt resolution)', async () => {
  const { caps, calls } = makeFakeCaps();
  const op = requireCoordOp('orchestrator:spawn-roles');
  await op.run(
    op.argsSchema.parse({
      conversation_id: 'conv-1',
      roles: [
        { role: 'voter', per: ['risk', 'cost'], as: 'lens' },
        { role: 'advocate', count: 1 },
      ],
    }),
    // runProgramCore stamps ctx.blueprintId; the spawn-runner turns it into a
    // BLUEPRINT_ID= extra so invoke() finds blueprints/<id>/prompts/<role>.md.
    makeCtx(caps, { blueprintId: 'vote' }),
  );
  const specs = calls.spawnRoles[0]!;
  assert.equal(specs.length, 3);
  assert.ok(specs.every((s) => s.blueprintId === 'vote'));
});

test('vote:aggregate tallies posts (confidence-weighted)', async () => {
  const op = requireCoordOp('vote:aggregate');
  const r = (await op.run(
    op.argsSchema.parse({
      posts: [
        { author_id: 'a', body: votePostBody('yes', 0.9) },
        { author_id: 'b', body: votePostBody('yes', 0.8) },
        { author_id: 'c', body: votePostBody('no', 0.4) },
      ],
      options: ['yes', 'no'],
    }),
    makeCtx(makeFakeCaps().caps),
  )) as { winner: string; advocate_veto: boolean };
  assert.equal(r.winner, 'yes');
  assert.equal(r.advocate_veto, false);
});

test('coord:escalate opens an escalation', async () => {
  const { caps, calls } = makeFakeCaps();
  const op = requireCoordOp('coord:escalate');
  const r = (await op.run(op.argsSchema.parse({ severity: 'question', summary: 'split vote' }), makeCtx(caps))) as {
    escalated: boolean;
  };
  assert.equal(r.escalated, true);
  assert.equal(calls.escalate[0]?.summary, 'split vote');
});

test('resolve notifies the caller + returns the decision', async () => {
  const { caps, calls } = makeFakeCaps();
  const op = requireCoordOp('resolve');
  const r = (await op.run(op.argsSchema.parse({ decision: 'yes', summary: 'done' }), makeCtx(caps, { callerId: 'caller-9' }))) as {
    resolved: boolean;
    decision: unknown;
  };
  assert.equal(r.resolved, true);
  assert.equal(r.decision, 'yes');
  assert.equal(calls.notify[0]?.to[0], 'caller-9');
});

test('coord:ask returns answered when the owner replies', async () => {
  const { caps } = makeFakeCaps({ answer: () => ({ answered: true, answer: 'go with yes' }) });
  const op = requireCoordOp('coord:ask');
  const r = (await op.run(op.argsSchema.parse({ question: 'Which option?', timeout_s: 1, poll_ms: 100 }), makeCtx(caps))) as {
    answered: boolean;
    answer: string | null;
  };
  assert.equal(r.answered, true);
  assert.equal(r.answer, 'go with yes');
});

test('coord:ask returns unanswered after timeout', async () => {
  const { caps, calls } = makeFakeCaps({ answer: () => ({ answered: false, answer: null }) });
  const op = requireCoordOp('coord:ask');
  const r = (await op.run(op.argsSchema.parse({ question: 'Which option?', timeout_s: 1, poll_ms: 100 }), makeCtx(caps))) as {
    answered: boolean;
  };
  assert.equal(r.answered, false);
  assert.equal(calls.sleeps.length, 10);
});

test('coord:ask stamps the escalation with its conversation id (EI-19399318647145782)', async () => {
  // An ask-owner writes TWO attention rows: the question thread (Alert tier)
  // and a severity:'question' escalation (DECISION tier). Without this stamp
  // nothing links them, so answering the conversation leaves the escalation
  // open forever — measured 9 of the 11 ever-resolved question conversations.
  // `conversations:resolve` clears the twin by matching exactly this field.
  const { caps, calls } = makeFakeCaps({ answer: () => ({ answered: true, answer: 'ok' }) });
  const op = requireCoordOp('coord:ask');
  await op.run(op.argsSchema.parse({ question: 'Which option?', timeout_s: 0 }), makeCtx(caps));

  const esc = calls.escalate[0];
  assert.ok(esc, 'the ask must open an escalation');
  assert.equal(esc.severity, 'question');
  // conv-fake is the fake openThread's conversation_id — the link must carry
  // the id of the thread THIS ask opened, not a fresh/derived one. Asserted
  // UNCONDITIONALLY: a `?? undefined`-style guard here would pass vacuously if
  // the escalate call ever stopped receiving meta at all.
  assert.equal(calls.openThread.length, 1);
  assert.equal(esc.meta?.conversationId, 'conv-fake');
});

test('coord:vote delegates to runProgram with depth+1', async () => {
  const { caps, calls } = makeFakeCaps({ onRunProgram: () => ({ outcome: 'resolve', resolved: true, decision: 'yes' }) });
  const op = requireCoordOp('coord:vote');
  const r = (await op.run(
    op.argsSchema.parse({ question: 'Ship?', options: ['yes', 'no'], lenses: ['risk', 'cost'] }),
    makeCtx(caps, { depth: 1 }),
  )) as { resolved: boolean; decision: unknown };
  assert.equal(r.resolved, true);
  assert.equal(r.decision, 'yes');
  assert.equal(calls.runProgram[0]?.blueprintId, 'vote');
  assert.equal(calls.runProgram[0]?.depth, 2); // ctx.depth(1) + 1
});

test('args schemas reject malformed input', () => {
  assert.throws(() => getCoordOp('coord:vote')!.argsSchema.parse({ question: 'x', options: ['only-one'] }));
  assert.throws(() => getCoordOp('coord:collect')!.argsSchema.parse({ conversation_id: '', quorum: 3 }));
});
