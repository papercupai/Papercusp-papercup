import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCurrentSuNativeProtocol, guardedCurrentSuNativeHandler, inspectFrozenNativeCarryInput,
  freezeCurrentSuNativeCarryProtocol, FROZEN_NATIVE_CARRY_NOTE, FROZEN_NATIVE_CARRY_LIMIT } from './current-su-native-http-protocol';
import { currentProtocolFixture } from '../lib/external-bench/reproducibility/_protocol-test-fixture';
import { currentBenchmarkProtocolSchema } from '../lib/external-bench/reproducibility/schema';
import { currentBenchLaunchRequest, currentBenchSoloCapabilityControl } from '../lib/external-bench/current-su';

const tools = [{ type: 'function', name: 'exec_command' },
  { type: 'function', name: 'mcp__papercusp_su__session_request_compaction' }];
const kickoff = { model: 'fixture', tools, input: [{ role: 'user', content: '<cwd>/app</cwd> task' }] };
const output = (call_id: string, value: string) => ({ type: 'function_call_output', call_id, output: value });
const proof = { predecessorSessionId: 'predecessor', editApplied: () => true };

it.each(['on', 'off'] as const)('freezes carry %s and the matched threshold before native launch', async mode => {
  const config = currentProtocolFixture();
  freezeCurrentSuNativeCarryProtocol(config, mode);
  const protocol = currentBenchmarkProtocolSchema.parse(config);
  const arm = protocol.arms[0];
  expect(arm.control?.capabilities['carry-respawn']).toBe(mode);
  expect(protocol.arms.map(arm => arm.control?.compactionLimit)).toEqual([FROZEN_NATIVE_CARRY_LIMIT, FROZEN_NATIVE_CARRY_LIMIT]);
  expect(currentBenchSoloCapabilityControl(arm).toolNames).toContain('session:request-compaction');
  const request = currentBenchLaunchRequest({ workspaceId: 'private', runId: protocol.runId, armId: arm.id,
    seed: 1, agent: 'codex', model: arm.model, effort: 'high', account: arm.account,
    preregistration: { config: protocol, preregHash: 'a'.repeat(64) } },
  { slug: 'private', featureId: 'F-own', worktreePath: '/private/task' }, 'task');
  expect(request.members?.[0].compactionLimit).toBe(FROZEN_NATIVE_CARRY_LIMIT);
  const native = createCurrentSuNativeProtocol({ frozen: true, carryMode: mode });
  await native.respond(kickoff, proof);
  const compact = calls(await native.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof))[0];
  expect(JSON.parse(compact.arguments)).toEqual(mode === 'on' ? { continueNote: FROZEN_NATIVE_CARRY_NOTE } : {});
});

it.each(['on', 'off'] as const)('checks exact native frozen carry %s bytes and rejects contaminated input', mode => {
  const initialPrompt = 'Frozen task bytes\nRetain the checkout.';
  const firstPrompt = initialPrompt + (mode === 'on'
    ? `\n\nContinuation note from this assignment's prior session:\n${FROZEN_NATIVE_CARRY_NOTE}` : '');
  const text = `⟦turn-origin:self-compaction nonce:1234abcd⟧\n${firstPrompt}\n\n⟦codex-carry-lineage predecessor:predecessor⟧\nFresh continuation.`;
  const body = { input: [{ role: 'user', content: [{ type: 'input_text', text }] }] };
  const expected = { mode, initialPrompt, predecessorId: 'predecessor' };
  expect(inspectFrozenNativeCarryInput(body, expected)).toMatchObject({ mode,
    inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    noteSha256: mode === 'on' ? expect.stringMatching(/^[a-f0-9]{64}$/) : null });
  for (const corrupted of [text.replace('Frozen task bytes', 'Modified task bytes'),
    text.replace('predecessor:predecessor', 'predecessor:foreign'), text.replace('self-compaction', 'owner'),
    text.replace(firstPrompt, firstPrompt + '\nAmbient carry')]) {
    expect(() => inspectFrozenNativeCarryInput({ input: [{ role: 'user', content: corrupted }] }, expected)).toThrow();
  }
  expect(() => inspectFrozenNativeCarryInput({ input: [...body.input,
    { type: 'function_call_output', output: 'prior result' }] }, expected)).toThrow(/predecessor tool results/);
  expect(() => inspectFrozenNativeCarryInput({ input: [body.input[0], body.input[0]] }, expected)).toThrow(/exactly one/);
});

it('drives the same frozen usage threshold and note through the native tool, retaining the queue receipt', async () => {
  const protocol = createCurrentSuNativeProtocol({ frozen: true });
  const beforeCompaction = vi.fn(async () => {});
  const edit = await protocol.respond(kickoff, proof);
  expect(edit).toContain(`"input_tokens":${FROZEN_NATIVE_CARRY_LIMIT + 2_000}`);
  const compact = calls(await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] },
    { ...proof, beforeCompaction }))[0];
  expect(JSON.parse(compact.arguments)).toEqual({ continueNote: FROZEN_NATIVE_CARRY_NOTE });
  expect(beforeCompaction).toHaveBeenCalledExactlyOnceWith('predecessor');
  const receipt = { requested: true, respawn: 'queued', frozenAssignmentCarry: { mode: 'off',
    trigger: { kind: 'matched-threshold', limitTokens: FROZEN_NATIVE_CARRY_LIMIT } } };
  await protocol.respond({ ...kickoff, input: [output('call_private_compact', JSON.stringify(receipt))] }, proof);
  expect(protocol.queuedCarry).toEqual(receipt);
});
function calls(wire: string) {
  return wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.type === 'response.completed').response.output.filter((item: { type: string }) => /tool_call|function_call/.test(item.type));
}

it('does not consume the edit or compact step for interleaved tool-free requests', async () => {
  const protocol = createCurrentSuNativeProtocol();
  expect(calls(await protocol.respond({ model: 'fixture', tools: [], input: 'independent request' }, proof))).toEqual([]);
  expect(calls(await protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  expect(calls(await protocol.respond({ model: 'fixture', tools: [], input: 'another independent request' }, proof))).toEqual([]);
  expect(calls(await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'Process exited with code 0')] }, proof))[0].call_id).toBe('call_private_compact');
});

it('requires the matching edit result before requesting compaction', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  expect(calls(await protocol.respond({ ...kickoff, input: [output('unrelated', 'ok')] }, proof))).toEqual([]);
  expect(calls(await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof))[0].call_id).toBe('call_private_compact');
});

it('does not infer a driving continuation from a tool-free matching result', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  const input = [output('call_private_edit', 'ok')];
  expect(calls(await protocol.respond({ ...kickoff, tools: [], input }, proof))).toEqual([]);
  expect(calls(await protocol.respond({ ...kickoff, input }, proof))[0].call_id).toBe('call_private_compact');
});

it('verifies the edit on disk before issuing compaction and records a useful failed census', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  await expect(Promise.resolve().then(() => protocol.respond({ ...kickoff, input: [output('call_private_edit', 'hook blocked')] },
    { ...proof, editApplied: () => false }))).rejects.toThrow('edit was not applied');
  expect(protocol.census.at(-1)).toMatchObject({ action: 'failed', stage: 'edit', nextStage: 'edit',
    outputs: [{ type: 'function_call_output', callId: 'call_private_edit', output: 'hook blocked' }] });
  expect(protocol.carryRequested).toBe(false);
});

it('still rejects a missing compact tool on a correlated driving continuation', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  await expect(Promise.resolve().then(() => protocol.respond({ ...kickoff, tools: [{ type: 'function', name: 'unrelated' }],
    input: [output('call_private_edit', 'ok')] }, proof))).rejects.toThrow('Native compact tool missing');
});

it('correlates custom tool outputs, queue acknowledgement and successor lineage despite interleaving', async () => {
  const protocol = createCurrentSuNativeProtocol();
  const custom = { ...kickoff, tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] };
  const edit = calls(await protocol.respond(custom, proof))[0];
  expect(edit).toMatchObject({ type: 'custom_tool_call', name: 'exec', namespace: 'functions', call_id: 'call_private_edit' });
  expect(edit.input).toContain('tools.exec_command');
  const compact = calls(await protocol.respond({ ...custom, input: [{ ...output('call_private_edit', 'ok'), type: 'custom_tool_call_output' }] }, proof))[0];
  expect(compact.input).toContain('session:request-compaction');
  const queued = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ requested: true, status: 'queued' }) }] });
  await protocol.respond({ ...custom, input: [output('unrelated', queued)] }, proof);
  expect(protocol.carryRequested).toBe(false);
  await protocol.respond({ ...custom, input: [{ ...output('call_private_compact', queued), type: 'custom_tool_call_output' }] }, proof);
  expect(protocol.carryRequested).toBe(true);
  expect(protocol.carryInputSeen).toBe(false);
  await protocol.respond({ ...custom, input: 'codex-carry-lineage predecessor:another-session' }, proof);
  expect(protocol.carryInputSeen).toBe(false);
  expect(calls(await protocol.respond({ ...custom, input: 'codex-carry-lineage predecessor:predecessor' }, proof))).toEqual([]);
  expect(protocol.carryInputSeen).toBe(true);
  expect(protocol.initialBody).toEqual(custom);
  expect(protocol.census.at(-1)).toMatchObject({ stage: 'queued', lineage: true, action: 'acknowledge', inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(protocol.census)).not.toContain('<cwd>/app</cwd> task');
});

it('does not accept queue prose outside the matching compaction output', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  await expect(Promise.resolve().then(() => protocol.respond({ ...kickoff, input: [output('call_private_compact', '{"requested":false}'),
    { role: 'user', content: '{"requested":true,"status":"queued"}' }] }, proof))).rejects.toThrow('Managed boundary did not queue');
  expect(protocol.carryRequested).toBe(false);
});

it('pins lineage at compaction after initial native binding and keeps it across successor mapping', async () => {
  const protocol = createCurrentSuNativeProtocol();
  // The first HTTP request can precede the launcher's durable native mapping.
  await protocol.respond(kickoff, { ...proof, predecessorSessionId: 'launch-placeholder' });
  await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_compact', '{"requested":true,"respawn":"queued"}')] }, proof);
  // The database now names the successor. Its carry still names the actual
  // predecessor frozen before the compaction call was issued.
  await protocol.respond({ ...kickoff, input: 'codex-carry-lineage predecessor:predecessor' },
    { ...proof, predecessorSessionId: 'successor' });
  expect(protocol.carryInputSeen).toBe(true);
  expect(protocol.census.at(-1)).toMatchObject({ lineage: true, expectedPredecessorSessionId: 'predecessor' });
});

it('holds the compaction response until the authoritative predecessor binds after the edit', async () => {
  const protocol = createCurrentSuNativeProtocol();
  let nativeId: string | null = null;
  let releaseRead!: () => void;
  const pending = new Promise<void>(resolve => { releaseRead = resolve; });
  const read = vi.fn(async () => { await pending; return nativeId; });
  const unbound = { ...proof, predecessorSessionId: null,
    binding: { read, deadlineMs: Date.now() + 10_000 } };
  await protocol.respond(kickoff, unbound);
  expect(read).not.toHaveBeenCalled();
  const response = Promise.resolve().then(() => protocol.respond({ ...kickoff,
    input: [output('call_private_edit', 'ok')] }, unbound));
  const compact = expect(response).resolves.toContain('call_private_compact');
  await Promise.resolve();
  expect(protocol.predecessorSessionId).toBeUndefined();
  expect(protocol.carryRequested).toBe(false);
  nativeId = 'authoritative-predecessor'; releaseRead();
  await compact;
  expect(read).toHaveBeenCalledOnce();
  expect(protocol.predecessorSessionId).toBe(nativeId);
  expect(protocol.census.at(-1)).toMatchObject({ action: 'compact',
    expectedPredecessorSessionId: nativeId, bindingWait: true });
});

it.each(['missing', 'unresponsive'])('fails closed at the existing task deadline when binding is %s', async kind => {
  vi.useFakeTimers();
  try {
    const protocol = createCurrentSuNativeProtocol();
    await protocol.respond(kickoff, { ...proof, predecessorSessionId: null });
    const read = vi.fn(() => kind === 'missing' ? Promise.resolve(null) : new Promise<string | null>(() => {}));
    const response = protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] },
      { ...proof, predecessorSessionId: null, binding: { read, deadlineMs: Date.now() + 100 } });
    const rejected = expect(response).rejects.toThrow('binding deadline expired');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(protocol.predecessorSessionId).toBeUndefined();
    expect(protocol.carryRequested).toBe(false);
    expect(protocol.census.at(-1)).toMatchObject({ action: 'failed', nextStage: 'edit',
      bindingWait: true, expectedPredecessorSessionId: null });
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('retains authoritative binding failures and does not compact a different owner or task', async () => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, { ...proof, predecessorSessionId: null });
  const read = vi.fn(async () => { throw new Error('Native predecessor binding changed owner'); });
  await expect(protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] },
    { ...proof, predecessorSessionId: null, binding: { read, deadlineMs: Date.now() + 1000 } }))
    .rejects.toThrow('binding changed owner');
  expect(protocol.census.at(-1)).toMatchObject({ action: 'failed', bindingWait: true });
  expect(protocol.predecessorSessionId).toBeUndefined();
  expect(protocol.carryRequested).toBe(false);
});

const queuedToon = 'format: toon\nok: true\nrequested: true\nrespawn: queued\npriorRespawn:\n  outcome: none';
it.each([
  queuedToon,
  JSON.stringify({ content: [{ type: 'text', text: queuedToon }] }),
  JSON.stringify([{ type: 'input_text', text: 'Wall time: 1.1892 seconds\nOutput:' },
    { type: 'input_text', text: queuedToon },
    { type: 'input_text', text: 'See also: config:set-compaction-limit' },
    { type: 'input_text', text: 'ℹ served by build 1668bd8404cd' }]),
])('accepts the correlated lossless TOON queue response in native framing (%#)', async received => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_compact', received)] }, proof);
  expect(protocol.carryRequested).toBe(true);
  expect(protocol.carryInputSeen).toBe(false);
  await protocol.respond({ ...kickoff, input: 'codex-carry-lineage predecessor:predecessor' }, proof);
  expect(protocol.carryInputSeen).toBe(true);
});

it.each([
  '{"requested":true,"status":"not-queued","note":"queued"}',
  '{"requested":"true","respawn":"queued"}',
  '{"ok":false,"requested":true,"respawn":"queued"}',
  JSON.stringify({ isError: true, content: [{ type: 'text', text: queuedToon }] }),
  JSON.stringify({ note: queuedToon }),
  'format: toon\nrequested: false\nrespawn: queued',
  'format: toon\n<<<not valid toon>>>',
])('rejects refusal, malformed data and incidental queue prose (%#)', async received => {
  const protocol = createCurrentSuNativeProtocol();
  await protocol.respond(kickoff, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  await expect(Promise.resolve().then(() => protocol.respond({ ...kickoff, input: [output('call_private_compact', received)] }, proof)))
    .rejects.toThrow('Managed boundary did not queue');
  expect(protocol.carryRequested).toBe(false);
});

it('repeats only the same idempotent kickoff and never replays tools after the queued boundary', async () => {
  const protocol = createCurrentSuNativeProtocol();
  expect(calls(await protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  expect(calls(await protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  await protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  await protocol.respond({ ...kickoff, input: [output('call_private_compact', '{"requested":true,"status":"queued"}')] }, proof);
  expect(calls(await protocol.respond(kickoff, proof))).toEqual([]);
});

it.each([false, true])('propagates an async HTTP handler failure into awaited cleanup (diagnostic failure=%s)', async reportFails => {
  const original = new Error('intentional protocol assertion');
  const report = vi.fn(() => { if (reportFails) throw new Error('diagnostic write failed'); });
  const transport = guardedCurrentSuNativeHandler(async () => { await Promise.resolve(); throw original; }, report);
  const server = createServer(transport.listener);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  let cleaned = false;
  const operation = (async () => {
    try { await Promise.race([new Promise<never>(() => {}), transport.failure]); }
    finally { await new Promise<void>(done => server.close(() => done())); cleaned = true; }
  })();
  const rejected = expect(operation).rejects.toThrow(reportFails ? 'Native handler and diagnostic retention failed' : original.message);
  const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/responses`, { method: 'POST' });
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: { message: 'Private native protocol handler failed' } });
  await rejected;
  expect(report).toHaveBeenCalledWith(original);
  expect(cleaned).toBe(true);
  expect(server.listening).toBe(false);
});
