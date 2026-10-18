import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createCurrentSuNativeProtocol, guardedCurrentSuNativeHandler } from './current-su-native-http-protocol';

const tools = [{ type: 'function', name: 'exec_command' },
  { type: 'function', name: 'mcp__papercusp_su__session_request_compaction' }];
const kickoff = { model: 'fixture', tools, input: [{ role: 'user', content: '<cwd>/app</cwd> task' }] };
const output = (call_id: string, value: string) => ({ type: 'function_call_output', call_id, output: value });
const proof = { predecessorSessionId: 'predecessor', editApplied: () => true };
function calls(wire: string) {
  return wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)))
    .find(event => event.type === 'response.completed').response.output.filter((item: { type: string }) => /tool_call|function_call/.test(item.type));
}

it('does not consume the edit or compact step for interleaved tool-free requests', () => {
  const protocol = createCurrentSuNativeProtocol();
  expect(calls(protocol.respond({ model: 'fixture', tools: [], input: 'independent request' }, proof))).toEqual([]);
  expect(calls(protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  expect(calls(protocol.respond({ model: 'fixture', tools: [], input: 'another independent request' }, proof))).toEqual([]);
  expect(calls(protocol.respond({ ...kickoff, input: [output('call_private_edit', 'Process exited with code 0')] }, proof))[0].call_id).toBe('call_private_compact');
});

it('requires the matching edit result before requesting compaction', () => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  expect(calls(protocol.respond({ ...kickoff, input: [output('unrelated', 'ok')] }, proof))).toEqual([]);
  expect(calls(protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof))[0].call_id).toBe('call_private_compact');
});

it('does not infer a driving continuation from a tool-free matching result', () => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  const input = [output('call_private_edit', 'ok')];
  expect(calls(protocol.respond({ ...kickoff, tools: [], input }, proof))).toEqual([]);
  expect(calls(protocol.respond({ ...kickoff, input }, proof))[0].call_id).toBe('call_private_compact');
});

it('verifies the edit on disk before issuing compaction and records a useful failed census', () => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  expect(() => protocol.respond({ ...kickoff, input: [output('call_private_edit', 'hook blocked')] },
    { ...proof, editApplied: () => false })).toThrow('edit was not applied');
  expect(protocol.census.at(-1)).toMatchObject({ action: 'failed', stage: 'edit', nextStage: 'edit',
    outputs: [{ type: 'function_call_output', callId: 'call_private_edit', output: 'hook blocked' }] });
  expect(protocol.carryRequested).toBe(false);
});

it('still rejects a missing compact tool on a correlated driving continuation', () => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  expect(() => protocol.respond({ ...kickoff, tools: [{ type: 'function', name: 'unrelated' }],
    input: [output('call_private_edit', 'ok')] }, proof)).toThrow('Native compact tool missing');
});

it('correlates custom tool outputs, queue acknowledgement and successor lineage despite interleaving', () => {
  const protocol = createCurrentSuNativeProtocol();
  const custom = { ...kickoff, tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec' }] }] };
  const edit = calls(protocol.respond(custom, proof))[0];
  expect(edit).toMatchObject({ type: 'custom_tool_call', name: 'exec', namespace: 'functions', call_id: 'call_private_edit' });
  expect(edit.input).toContain('tools.exec_command');
  const compact = calls(protocol.respond({ ...custom, input: [{ ...output('call_private_edit', 'ok'), type: 'custom_tool_call_output' }] }, proof))[0];
  expect(compact.input).toContain('session:request-compaction');
  const queued = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ requested: true, status: 'queued' }) }] });
  protocol.respond({ ...custom, input: [output('unrelated', queued)] }, proof);
  expect(protocol.carryRequested).toBe(false);
  protocol.respond({ ...custom, input: [{ ...output('call_private_compact', queued), type: 'custom_tool_call_output' }] }, proof);
  expect(protocol.carryRequested).toBe(true);
  expect(protocol.carryInputSeen).toBe(false);
  protocol.respond({ ...custom, input: 'codex-carry-lineage predecessor:another-session' }, proof);
  expect(protocol.carryInputSeen).toBe(false);
  expect(calls(protocol.respond({ ...custom, input: 'codex-carry-lineage predecessor:predecessor' }, proof))).toEqual([]);
  expect(protocol.carryInputSeen).toBe(true);
  expect(protocol.initialBody).toEqual(custom);
  expect(protocol.census.at(-1)).toMatchObject({ stage: 'queued', lineage: true, action: 'acknowledge', inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(protocol.census)).not.toContain('<cwd>/app</cwd> task');
});

it('does not accept queue prose outside the matching compaction output', () => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  expect(() => protocol.respond({ ...kickoff, input: [output('call_private_compact', '{"requested":false}'),
    { role: 'user', content: '{"requested":true,"status":"queued"}' }] }, proof)).toThrow('Managed boundary did not queue');
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
])('accepts the correlated lossless TOON queue response in native framing (%#)', received => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  protocol.respond({ ...kickoff, input: [output('call_private_compact', received)] }, proof);
  expect(protocol.carryRequested).toBe(true);
  expect(protocol.carryInputSeen).toBe(false);
  protocol.respond({ ...kickoff, input: 'codex-carry-lineage predecessor:predecessor' }, proof);
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
])('rejects refusal, malformed data and incidental queue prose (%#)', received => {
  const protocol = createCurrentSuNativeProtocol();
  protocol.respond(kickoff, proof);
  protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  expect(() => protocol.respond({ ...kickoff, input: [output('call_private_compact', received)] }, proof))
    .toThrow('Managed boundary did not queue');
  expect(protocol.carryRequested).toBe(false);
});

it('repeats only the same idempotent kickoff and never replays tools after the queued boundary', () => {
  const protocol = createCurrentSuNativeProtocol();
  expect(calls(protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  expect(calls(protocol.respond(kickoff, proof))[0].call_id).toBe('call_private_edit');
  protocol.respond({ ...kickoff, input: [output('call_private_edit', 'ok')] }, proof);
  protocol.respond({ ...kickoff, input: [output('call_private_compact', '{"requested":true,"status":"queued"}')] }, proof);
  expect(calls(protocol.respond(kickoff, proof))).toEqual([]);
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
