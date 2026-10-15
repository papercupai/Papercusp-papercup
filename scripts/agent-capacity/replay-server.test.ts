import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeChunk, encodeChunk, fingerprintRequest, type RecordedExchange } from './record-proxy';
import {
  execSessionRewriter,
  learnReplayIds,
  learnReplayTasks,
  namedTaskOutputs,
  newReplayState,
  pairFor,
  pairTasks,
  recordedTaskCallIds,
  recordedTaskPrefix,
  reportedTaskOutputs,
  taskOutputRefs,
  taskOutputRewriter,
  type TaskOutputIds,
  recordedExecCalls,
  reportedExecSessionIds,
  type ExecSessionIds,
  parseExchanges,
  parseReplayUrl,
  replaceAcross,
  rewriteExchange,
  shouldHold,
  sseEvents,
  startReplayServer,
  takeExchange,
  type ReplayServer,
  type ServedRecord,
} from './replay-server';

const MSG = '/v1/messages?beta=true';

function ex(seq: number, over: Partial<RecordedExchange> & { model?: string; messages?: number; tools?: number; body?: string[] } = {}): RecordedExchange {
  const body = over.body ?? [`event: message_start\ndata: {"seq":${seq}}\n\n`, 'event: message_stop\ndata: {}\n\n'];
  return {
    seq,
    sessionId: 's1',
    startedAt: '2026-09-30T00:00:00.000Z',
    method: over.method ?? 'POST',
    path: over.path ?? MSG,
    req: { bytes: 10, sha256: 'x', model: over.model ?? 'm', stream: true, messages: over.messages ?? 2, tools: over.tools ?? 20 },
    status: over.status ?? 200,
    contentType: over.contentType === undefined ? 'text/event-stream; charset=utf-8' : over.contentType,
    ttfbMs: 0,
    totalMs: over.totalMs ?? 0,
    resBytes: 0,
    chunks: over.chunks ?? body.map((b, i) => encodeChunk(i * 5, Buffer.from(b))),
  };
}

const req = (model: string | null, messages: number | null, tools: number | null, p = MSG, method = 'POST') => ({
  method,
  path: p,
  fp: { bytes: 1, sha256: 'y', model, stream: true, messages, tools },
});

describe('takeExchange', () => {
  it('prefers an exact fingerprint over an earlier shape-only match', () => {
    // Main thread (20 tools) and a subagent (14 tools) interleave; the subagent request
    // arrives first but must not steal the main thread's recorded reply.
    const st = newReplayState('s1', 'a', [ex(0, { messages: 2, tools: 20 }), ex(1, { messages: 2, tools: 14 })]);
    expect(takeExchange(st, req('m', 2, 14))).toMatchObject({ tier: 'exact', exchange: { seq: 1 } });
    expect(takeExchange(st, req('m', 2, 20))).toMatchObject({ tier: 'exact', exchange: { seq: 0 } });
    expect(st.counts).toEqual({ exact: 2, shape: 0, path: 0, exhausted: 0 });
  });

  it('serves the earliest unconsumed exact match, so a recorded 502 then its retry replay in order', () => {
    const st = newReplayState('s1', 'a', [ex(0, { status: 502, messages: 10 }), ex(1, { status: 200, messages: 10 })]);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(502);
    expect(takeExchange(st, req('m', 10, 20))?.exchange.status).toBe(200);
  });

  it('falls back to shape, then path, then reports exhaustion', () => {
    const st = newReplayState('s1', 'a', [ex(0, { model: 'm', messages: 4 }), ex(1, { model: 'other', messages: 9 })]);
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('shape');
    expect(takeExchange(st, req('m', 99, 20))?.tier).toBe('path');
    expect(takeExchange(st, req('m', 99, 20))).toBeNull();
    expect(takeExchange(st, req('m', 2, 20, '/v1/other'))).toBeNull();
    expect(st.counts).toEqual({ exact: 0, shape: 1, path: 1, exhausted: 2 });
  });

  it('never matches across method or path', () => {
    const st = newReplayState('s1', 'a', [ex(0, { method: 'HEAD', path: '/api/hello' })]);
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'GET'))).toBeNull();
    expect(takeExchange(st, req(null, null, null, '/api/hello', 'HEAD'))?.exchange.seq).toBe(0);
  });
});

describe('parseReplayUrl / parseExchanges', () => {
  it('splits base, instance and the CLI-appended path', () => {
    expect(parseReplayUrl('/r/claude-exc-1-2026/a7/v1/messages?beta=true')).toEqual({ sessionId: 'claude-exc-1-2026', instance: 'a7', rest: MSG });
    expect(parseReplayUrl('/r/s1/a7')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/' });
    expect(parseReplayUrl('/r/s1/a7?x=1')).toEqual({ sessionId: 's1', instance: 'a7', rest: '/?x=1' });
  });

  it('rejects traversal and non-replay urls', () => {
    expect(parseReplayUrl('/r/../a7/v1/messages')).toBeNull();
    expect(parseReplayUrl('/r/..%2Fetc/a7/x')).toBeNull();
    expect(parseReplayUrl('/v1/messages')).toBeNull();
  });

  it('orders exchanges by request seq, not completion order', () => {
    const jsonl = [ex(2), ex(0), ex(1)].map((e) => JSON.stringify(e)).join('\n') + '\n';
    expect(parseExchanges(jsonl).map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

// The recorded checkout and a replay's own: different lengths, so every boundary has to move.
const REC = '/home/u/.cache/agent-capacity/work/claude-x-20261001T003519';
const REP = '/home/u/.cache/agent-capacity/replay-work/R/s3-i0';

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const jsonDelta = (index: number, partial_json: string) => sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } }, 'content_block_delta');
const bodyOf = (e: RecordedExchange) => Buffer.concat(e.chunks.map(decodeChunk)).toString('utf8');

/** Reassemble each streamed field the way a client does. */
function reassemble(e: RecordedExchange): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ev of sseEvents(e.chunks)) {
    const d = ev.data as Record<string, any> | null;
    if (d?.type === 'content_block_delta') out[`cb${d.index}`] = (out[`cb${d.index}`] ?? '') + (d.delta.partial_json ?? d.delta.text ?? '');
    else if (typeof d?.type === 'string' && d.type.endsWith('.delta')) out[d.type] = (out[d.type] ?? '') + d.delta;
  }
  return out;
}

describe('replaceAcross', () => {
  it('replaces a match split over several pieces and keeps the piece count', () => {
    const s = `cat ${REC}/a.txt && ls ${REC}`;
    const m2 = s.lastIndexOf(REC);
    // Cuts: inside match 1, between the matches, inside match 2.
    const cuts = [9, m2 - 6, m2 + 20];
    const pieces = [s.slice(0, cuts[0]), s.slice(cuts[0], cuts[1]), s.slice(cuts[1], cuts[2]), s.slice(cuts[2])];
    const out = replaceAcross(pieces, REC, REP);
    // A cut inside a match moves to the end of its replacement; a cut between matches shifts by
    // the length change of the matches before it.
    expect(out).toEqual([`cat ${REP}`, '/a.txt ', `&& ls ${REP}`, '']);
  });

  it('returns the same array when nothing matches', () => {
    const pieces = ['no ', 'path here'];
    expect(replaceAcross(pieces, REC, REP)).toBe(pieces);
  });
});

describe('rewriteExchange', () => {
  it('rewrites an Anthropic tool input whose path is split across input_json_delta events and chunks', () => {
    const input = JSON.stringify({ file_path: `${REC}/tests/test_x.py`, content: 'x' });
    const cut = input.indexOf(REC) + 17;
    const chunks = [
      encodeChunk(0, Buffer.from(sse({ type: 'message_start' }, 'message_start') + sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', input: {} } }, 'content_block_start'))),
      encodeChunk(40, Buffer.from(jsonDelta(1, input.slice(0, cut)))),
      // An event split across two network chunks: it completes at t=90.
      encodeChunk(70, Buffer.from(jsonDelta(1, input.slice(cut)).slice(0, 25))),
      encodeChunk(90, Buffer.from(jsonDelta(1, input.slice(cut)).slice(25) + sse({ type: 'message_stop' }, 'message_stop'))),
    ];
    const e = ex(0, { chunks, totalMs: 95 });
    const out = rewriteExchange(e, { from: REC, to: REP });
    expect(out).not.toBe(e);
    expect(JSON.parse(reassemble(out).cb1)).toEqual({ file_path: `${REP}/tests/test_x.py`, content: 'x' });
    expect(bodyOf(out)).not.toContain('agent-capacity/work/');
    // Same events, delivered when the recording completed each of them.
    expect(sseEvents(out.chunks)).toHaveLength(sseEvents(chunks).length);
    expect(out.chunks.map((c) => c.t)).toEqual([0, 40, 90]);
    expect(out.totalMs).toBe(95);
  });

  it('rewrites OpenAI Responses deltas and the full strings in their done events', () => {
    const patch = `*** Begin Patch\n*** Update File: ${REC}/src/a.ts\n@@\n-x\n+y\n*** End Patch`;
    const cut = patch.indexOf(REC) + 5;
    const item = { id: 'ctc_1', type: 'custom_tool_call', name: 'apply_patch', input: patch };
    const chunks = [
      encodeChunk(0, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 1, delta: patch.slice(0, cut) }))),
      encodeChunk(10, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_1', output_index: 1, delta: patch.slice(cut) }))),
      encodeChunk(20, Buffer.from(sse({ type: 'response.output_item.done', output_index: 1, item }) + 'data: [DONE]\n\n')),
    ];
    const out = rewriteExchange(ex(0, { chunks }), { from: REC, to: REP });
    const want = patch.replace(REC, REP);
    expect(reassemble(out)['response.custom_tool_call_input.delta']).toBe(want);
    const done = sseEvents(out.chunks).find((e) => (e.data as any)?.type === 'response.output_item.done');
    expect((done?.data as any).item.input).toBe(want);
    expect(bodyOf(out).endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('rewrites a non-streamed JSON body and leaves an untouched exchange as the same object', () => {
    const json = ex(0, { contentType: 'application/json', chunks: [encodeChunk(5, Buffer.from(JSON.stringify({ content: [{ type: 'tool_use', input: { path: REC } }] })))] });
    expect(JSON.parse(bodyOf(rewriteExchange(json, { from: REC, to: REP }))).content[0].input.path).toBe(REP);
    const plain = ex(0);
    expect(rewriteExchange(plain, { from: REC, to: REP })).toBe(plain);
  });
});

// A Codex code-mode poll of a still-running process, as the model streams it.
const POLL = 'text(await tools.write_stdin({session_id:64250,chars:"",yield_time_ms:1000}));\n';
const pollChunks = (cut: number) => {
  const item = { id: 'ctc_2', type: 'custom_tool_call', name: 'exec', call_id: 'c2', input: POLL };
  return [
    encodeChunk(0, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_2', output_index: 0, delta: POLL.slice(0, cut) }))),
    encodeChunk(10, Buffer.from(sse({ type: 'response.custom_tool_call_input.delta', item_id: 'ctc_2', output_index: 0, delta: POLL.slice(cut) }))),
    encodeChunk(20, Buffer.from(sse({ type: 'response.output_item.done', output_index: 0, item }) + 'data: [DONE]\n\n')),
  ];
};
const doneInput = (e: RecordedExchange) => (sseEvents(e.chunks).find((x) => (x.data as any)?.type === 'response.output_item.done')?.data as any).item.input;

describe('exec-session ids', () => {
  it('rewrites a recorded id split across deltas and in the done event, and never a longer id sharing its prefix', () => {
    const cut = POLL.indexOf('64250') + 2; // the id itself is split across the two deltas
    const out = rewriteExchange(ex(0, { chunks: pollChunks(cut) }), execSessionRewriter(new Map([['64250', '52575']])));
    const want = POLL.replace('64250', '52575');
    expect(reassemble(out)['response.custom_tool_call_input.delta']).toBe(want);
    expect(doneInput(out)).toBe(want);
    const prefix = ex(0, { chunks: pollChunks(cut) });
    expect(rewriteExchange(prefix, execSessionRewriter(new Map([['6425', '1']])))).toBe(prefix);
  });

  it('rewrites the JSON-argument spelling a function_call uses', () => {
    const args = JSON.stringify({ session_id: 64250, chars: '' });
    const body = JSON.stringify({ output: [{ type: 'function_call', name: 'write_stdin', arguments: args }] });
    const out = rewriteExchange(ex(0, { contentType: 'application/json', chunks: [encodeChunk(0, Buffer.from(body))] }), execSessionRewriter(new Map([['64250', '7']])));
    expect(JSON.parse(JSON.parse(bodyOf(out)).output[0].arguments)).toEqual({ session_id: 7, chars: '' });
  });

  it('reads ids only from the CLI tool outputs, never from model-written items or quoted command output', () => {
    const body = {
      input: [
        { type: 'custom_tool_call', call_id: 'c0', input: POLL }, // model-written: names a recorded id
        { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'grep says "session_id": 999', session_id: 52575 }) },
        { type: 'function_call_output', call_id: 'c3', output: [{ type: 'input_text', text: 'Process running with session ID 4111' }] },
        { type: 'custom_tool_call_output', call_id: 'c4', output: JSON.stringify({ session_id: 52575 }) },
      ],
    };
    expect(reportedExecSessionIds(Buffer.from(JSON.stringify(body)))).toEqual(['52575', '4111']);
    expect(reportedExecSessionIds(Buffer.from('not json'))).toEqual([]);
    // The recording keeps the same reports WITH the call_id each answered (bodies are not stored).
    expect(fingerprintRequest(Buffer.from(JSON.stringify(body))).execSessions).toEqual([
      { callId: 'c1', id: '52575' },
      { callId: 'c3', id: '4111' },
    ]);
    expect(fingerprintRequest(Buffer.from(JSON.stringify({ input: [] }))).execSessions).toBeUndefined();
  });

  it('pairs through the recorded call_id when the model polls a later process first (order pairing drifts)', () => {
    // Recording: call c1 started process 111, call c2 started 222. The replay reports them in
    // the same call order but the model's first poll names 222.
    const recordedCalls = recordedExecCalls([
      { ...ex(0), req: { ...ex(0).req, execSessions: [{ callId: 'c1', id: '111' }, { callId: 'c2', id: '222' }] } },
    ]);
    const exact: ExecSessionIds = { recorded: [], replay: [] };
    const byOrder: ExecSessionIds = { recorded: [], replay: [] };
    for (const ids of [exact, byOrder]) learnReplayIds(ids, [{ callId: 'c1', id: '9001' }, { callId: 'c2', id: '9002' }]);
    expect(pairFor(exact, ['222'], recordedCalls)).toEqual({ map: new Map([['222', '9002']]), unmapped: [], by: 'call_id' });
    expect(pairFor(byOrder, ['222'], null).map.get('222')).toBe('9001'); // the drift exact pairing removes
  });

  it('leaves a recorded id unmapped when its call reported no replay process, instead of borrowing another', () => {
    const recordedCalls = recordedExecCalls([
      { ...ex(0), req: { ...ex(0).req, execSessions: [{ callId: 'c1', id: '111' }, { callId: 'c2', id: '222' }] } },
    ]);
    const ids: ExecSessionIds = { recorded: [], replay: [] };
    learnReplayIds(ids, [{ callId: 'c2', id: '9002' }]); // c1 finished inside its yield in the replay
    expect(pairFor(ids, ['111', '222'], recordedCalls)).toEqual({ map: new Map([['222', '9002']]), unmapped: ['111'], by: 'call_id' });
    expect(recordedExecCalls([ex(0)])).toBeNull(); // a pre-execSessions recording selects order pairing
  });
});

// A Claude background task, as recorded on the tower (uid 1000) and as a replay on a VM sees it
// (uid 1001, its own checkout, session uuid and task id). Shapes from P-005 claude-mea-typical-2.
const REC_PROJECT = '-home-u--cache-agent-capacity-work-claude-mea-typical-2-20260930T203813';
const REC_SESSION = '4685d102-bfcf-47d6-b575-ea90f1c31351';
const REC_TASK_PATH = `/tmp/claude-1000/${REC_PROJECT}/${REC_SESSION}/tasks/bl4w01qwj.output`;
const REP_PROJECT = '-home-v--cache-agent-capacity-replay-work-p005-n16-s11-i0';
const REP_SESSION = '13c040f4-9316-4271-a506-f486ca49ebb8';
const REP_TASK_PATH = `/tmp/claude-1001/${REP_PROJECT}/${REP_SESSION}/tasks/bofqc99b6.output`;
const TAIL = `sleep 100; tail -5 ${REC_TASK_PATH}`;
const GLOB = 'grep -E "passed|failed" /tmp/claude-1000/*/*/tasks/bl4w01qwj.output | tail -3';
/** A tool_use whose command streams as two input_json_delta events, the path cut at `cut`. */
const bashChunks = (command: string, cut: number) => {
  const input = JSON.stringify({ command });
  return [
    encodeChunk(0, Buffer.from(sse({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }, 'content_block_start'))),
    encodeChunk(10, Buffer.from(jsonDelta(1, input.slice(0, cut)))),
    encodeChunk(20, Buffer.from(jsonDelta(1, input.slice(cut)) + sse({ type: 'message_stop' }, 'message_stop'))),
  ];
};
const backgrounded = (p: string) => `Command did not complete within its 120s timeout and was moved to the background (ID: x). Output is being written to: ${p}. You will be notified when it completes.`;

const taskOutputPath = (ref: { uid: string; project?: string; session?: string; task: string }) =>
  path.join('/tmp', `claude-${ref.uid}`, ref.project!, ref.session!, 'tasks', `${ref.task}.output`);

const cliTaskResult = (toolUseId: string, outputPath: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: backgrounded(outputPath) }] }] },
});

describe('background-task output paths', () => {
  it('parses literal paths with their prefix, and globbed ones with uid and task only', () => {
    expect(taskOutputRefs(`${TAIL}; ${GLOB}`)).toEqual([
      { uid: '1000', task: 'bl4w01qwj', project: REC_PROJECT, session: REC_SESSION },
      { uid: '1000', task: 'bl4w01qwj' },
    ]);
    expect(taskOutputRefs('tail /tmp/claude-1000/tasks.output /tmp/other/tasks/x.output')).toEqual([]);
  });

  it('finds a recorded path the model streamed split across deltas', () => {
    const e = ex(0, { chunks: bashChunks(TAIL, JSON.stringify({ command: TAIL }).indexOf('tasks/') - 9) });
    expect(namedTaskOutputs(e)).toEqual([{ uid: '1000', task: 'bl4w01qwj', project: REC_PROJECT, session: REC_SESSION }]);
    expect(recordedTaskPrefix([ex(1), e])?.session).toBe(REC_SESSION);
    expect(namedTaskOutputs(ex(2))).toEqual([]);
  });

  it('reads reported paths only from user-role content, never from assistant turns or tool_use input', () => {
    const body = {
      messages: [
        { role: 'user', content: 'fix the tests' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: TAIL } }, { type: 'text', text: REC_TASK_PATH }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: [{ type: 'text', text: backgrounded(REP_TASK_PATH) }] }] },
        { role: 'user', content: [{ type: 'tool_use', id: 'odd', input: { command: `tail ${REC_TASK_PATH}` } }] },
      ],
    };
    expect(reportedTaskOutputs(Buffer.from(JSON.stringify(body)))).toEqual([{ uid: '1001', task: 'bofqc99b6', project: REP_PROJECT, session: REP_SESSION, callId: 't0' }]);
    expect(reportedTaskOutputs(Buffer.from('not json /tmp/claude-1/a/b/tasks/x.output'))).toEqual([]);
  });

  it('recovers recorded task ids from the CLI result tool_use_id', () => {
    const cli = [cliTaskResult('call-a', REC_TASK_PATH), cliTaskResult('call-b', REC_TASK_PATH.replace('bl4w01qwj', 'b2nd'))].join('\n');
    expect(recordedTaskCallIds(cli)).toEqual(new Map([['bl4w01qwj', 'call-a'], ['b2nd', 'call-b']]));
  });

  it('never learns a recorded task id the replay quoted back in an error, and pairs ids in order of first appearance', () => {
    const ids: TaskOutputIds = { recorded: [], replay: [] };
    expect(pairTasks(ids, ['bl4w01qwj'])).toEqual({ map: new Map(), unmapped: ['bl4w01qwj'] }); // nothing reported yet
    learnReplayTasks(ids, taskOutputRefs(`tail: cannot open '${REC_TASK_PATH}': No such file or directory`));
    expect(ids.replay).toEqual([]);
    learnReplayTasks(ids, taskOutputRefs(backgrounded(REP_TASK_PATH)));
    learnReplayTasks(ids, taskOutputRefs(backgrounded(REP_TASK_PATH))); // the next request repeats the history
    expect(ids.replay.map((r) => r.task)).toEqual(['bofqc99b6']);
    expect(pairTasks(ids, ['bl4w01qwj', 'b2nd'])).toEqual({ map: new Map([['bl4w01qwj', 'bofqc99b6']]), unmapped: ['b2nd'] });
  });

  it('moves literal paths, globs and bare task ids onto the replay, across delta boundaries', () => {
    const rw = taskOutputRewriter(taskOutputRefs(TAIL)[0], taskOutputRefs(REP_TASK_PATH)[0], new Map([['bl4w01qwj', 'bofqc99b6']]));
    for (const command of [TAIL, GLOB]) {
      const input = JSON.stringify({ command });
      for (const cut of [input.indexOf('claude-') + 3, input.indexOf('bl4w') + 2, input.length - 20]) {
        const out = rewriteExchange(ex(0, { chunks: bashChunks(command, cut) }), rw);
        const want = command.replaceAll('/tmp/claude-1000/', '/tmp/claude-1001/').replace(REC_PROJECT, REP_PROJECT).replace(REC_SESSION, REP_SESSION).replace('bl4w01qwj', 'bofqc99b6');
        expect(JSON.parse(reassemble(out).cb1).command).toBe(want);
      }
    }
    expect(JSON.parse(reassemble(rewriteExchange(ex(0, { chunks: bashChunks(TAIL, 30) }), rw)).cb1).command).toBe(`sleep 100; tail -5 ${REP_TASK_PATH}`);
  });
});

describe('startReplayServer', () => {
  let corpus: string;
  let srv: ReplayServer;
  let externalTaskRoot: string | null = null;
  const logFile = () => path.join(corpus, 'served.jsonl');

  const post = (url: string, body: unknown, method = 'POST') =>
    new Promise<{ status: number; type: string | undefined; body: Buffer; ms: number }>((resolve, reject) => {
      const t0 = Date.now();
      const data = Buffer.from(JSON.stringify(body));
      const r = http.request(url, { method, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(parts), ms: Date.now() - t0 }));
      });
      r.on('error', reject);
      r.end(data);
    });

  const writeSession = (id: string, exchanges: RecordedExchange[]) => {
    mkdirSync(path.join(corpus, id), { recursive: true });
    writeFileSync(path.join(corpus, id, 'exchanges.jsonl'), exchanges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  };

  beforeEach(() => {
    corpus = mkdtempSync(path.join(tmpdir(), 'replay-server-'));
    externalTaskRoot = null;
  });
  afterEach(async () => {
    await srv?.close();
    rmSync(corpus, { recursive: true, force: true });
    if (externalTaskRoot) rmSync(externalTaskRoot, { recursive: true, force: true });
  });

  it('replays recorded bytes, status and content type; answers 400 once the recording is used up', async () => {
    const utf8Split = Buffer.from('data: {"t":"é"}\n\n');
    const chunks = [encodeChunk(0, Buffer.from('event: a\n')), encodeChunk(1, utf8Split.subarray(0, 13)), encodeChunk(2, utf8Split.subarray(13))];
    expect(chunks[1].b64).toBeDefined(); // the split utf8 sequence was recorded as base64
    writeSession('s1', [ex(0, { chunks, messages: 1, tools: 3 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const body = { model: 'm', stream: true, messages: [{}], tools: [{}, {}, {}] };
    const r1 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r1.status).toBe(200);
    expect(r1.type).toBe('text/event-stream; charset=utf-8');
    expect(r1.body.toString('utf8')).toBe('event: a\ndata: {"t":"é"}\n\n');

    const r2 = await post(`${srv.baseUrl('s1', 'a')}${MSG}`, body);
    expect(r2.status).toBe(400);
    expect(JSON.parse(r2.body.toString('utf8')).error.message).toMatch(/replay_exhausted/);

    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(served.map((s) => [s.tier, s.status, s.seq])).toEqual([
      ['exact', 200, 0],
      ['exhausted', 400, null],
    ]);
    expect(served[0].reqBytes).toBe(fingerprintRequest(Buffer.from(JSON.stringify(body))).bytes);
  });

  it('logs redacted current and recorded tool-output metadata for Codex replay requests', async () => {
    const RESP = '/v1/responses';
    const recordedBody = {
      model: 'm', tools: [],
      input: [{ type: 'custom_tool_call_output', call_id: 'nested-call', output: 'recorded private output' }],
    };
    const replayBody = {
      model: 'm', tools: [],
      input: [{ type: 'custom_tool_call_output', call_id: 'nested-call', output: 'replayed private output is longer' }],
    };
    const recorded = ex(0, { path: RESP, messages: 1, tools: 0 });
    recorded.req = { ...recorded.req, ...fingerprintRequest(Buffer.from(JSON.stringify(recordedBody))) };
    writeSession('s1', [recorded]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });

    const response = await post(`${srv.baseUrl('s1', 'a')}${RESP}`, replayBody);
    expect(response.status).toBe(200);
    await srv.close();

    const [served] = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(served.inputToolOutputs).toEqual(fingerprintRequest(Buffer.from(JSON.stringify(replayBody))).inputToolOutputs);
    expect(served.recordedInputToolOutputs).toEqual(recorded.req.inputToolOutputs);
    expect(JSON.stringify(served)).not.toContain('recorded private output');
    expect(JSON.stringify(served)).not.toContain('replayed private output');
  });

  it('keeps separate consumption state per instance of the same recording', async () => {
    writeSession('s1', [ex(0, { messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${MSG}`, body), post(`${srv.baseUrl('s1', 'b')}${MSG}`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(srv.states().map((s) => s.counts.exact).sort()).toEqual([1, 1]);
  });

  it('rewrites the recorded work dir only for the instance registered for it, and logs it', async () => {
    const input = JSON.stringify({ file_path: `${REC}/out.txt` });
    const chunks = [encodeChunk(0, Buffer.from(jsonDelta(0, input.slice(0, 30)))), encodeChunk(5, Buffer.from(jsonDelta(0, input.slice(30))))];
    writeSession('s1', [ex(0, { chunks, messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    srv.rewritePaths('s1', 'a', { from: REC, to: REP });
    const body = { model: 'm', messages: [{}], tools: [] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${MSG}`, body), post(`${srv.baseUrl('s1', 'b')}${MSG}`, body)]);
    const pj = (buf: Buffer) => JSON.parse(reassemble(ex(0, { chunks: [encodeChunk(0, buf)] })).cb0);
    expect(pj(a.body)).toEqual({ file_path: `${REP}/out.txt` });
    expect(pj(b.body)).toEqual({ file_path: `${REC}/out.txt` });
    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(Object.fromEntries(served.map((s) => [s.instance, s.rewritten]))).toEqual({ a: true, b: false });
  });

  it('serves a Codex poll with the exec-session id THIS instance reported, and logs an id it never reported', async () => {
    const RESP = '/v1/responses';
    writeSession('s1', [ex(0, { path: RESP, chunks: pollChunks(30), messages: 2, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const call = { type: 'custom_tool_call', call_id: 'c1', input: 'text(await tools.exec_command({cmd:"yarn test"}))' };
    const running = { model: 'm', tools: [], input: [call, { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: '', session_id: 52575 }) }] };
    const exited = { model: 'm', tools: [], input: [call, { type: 'custom_tool_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ok', exit_code: 0 }) }] };
    const [a, b] = await Promise.all([post(`${srv.baseUrl('s1', 'a')}${RESP}`, running), post(`${srv.baseUrl('s1', 'b')}${RESP}`, exited)]);
    const servedInput = (buf: Buffer) => doneInput(ex(0, { chunks: [encodeChunk(0, buf)] }));
    expect(servedInput(a.body)).toBe(POLL.replace('64250', '52575'));
    expect(servedInput(b.body)).toBe(POLL);
    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    const by = Object.fromEntries(served.map((s) => [s.instance, s]));
    expect(by.a.tier).toBe('exact');
    expect(by.a.execSessionIds).toEqual({ 64250: '52575' });
    expect(by.a.execSessionUnmapped).toBeUndefined();
    expect(by.b.execSessionIds).toBeUndefined();
    expect(by.b.execSessionUnmapped).toEqual(['64250']);
    expect(by.a.execSessionPairing).toBe('order'); // this recording predates execSessions
  });

  it('serves a poll of the SECOND recorded process with the replay id that same call reported', async () => {
    const RESP = '/v1/responses';
    const recorded = ex(0, { path: RESP, chunks: pollChunks(30), messages: 4, tools: 0 });
    recorded.req = { ...recorded.req, execSessions: [{ callId: 'c1', id: '11111' }, { callId: 'c2', id: '64250' }] };
    writeSession('s1', [recorded]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const out = (callId: string, id: number) => ({ type: 'custom_tool_call_output', call_id: callId, output: JSON.stringify({ output: '', session_id: id }) });
    const call = (callId: string) => ({ type: 'custom_tool_call', call_id: callId, input: 'text(await tools.exec_command({cmd:"x"}))' });
    const body = { model: 'm', tools: [], input: [call('c1'), out('c1', 52575), call('c2'), out('c2', 7777)] };
    const r = await post(`${srv.baseUrl('s1', 'a')}${RESP}`, body);
    expect(doneInput(ex(0, { chunks: [encodeChunk(0, r.body)] }))).toBe(POLL.replace('64250', '7777'));
    await srv.close();
    const [rec] = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    expect(rec.tier).toBe('exact');
    expect(rec.execSessionIds).toEqual({ 64250: '7777' });
    expect(rec.execSessionPairing).toBe('call_id');
  });

  it('serves a Claude tail of a background task with the task path THIS instance reported, and logs a task it never reported', async () => {
    const recorded = ex(0, { chunks: bashChunks(TAIL, JSON.stringify({ command: TAIL }).indexOf('tasks/') - 9), messages: 3, tools: 0 });
    writeSession('s1', [recorded]);
    const actualRef = taskOutputRefs(REP_TASK_PATH)[0];
    externalTaskRoot = path.join('/tmp', `claude-${actualRef.uid}`, actualRef.project!);
    mkdirSync(path.dirname(taskOutputPath(actualRef)), { recursive: true });
    writeFileSync(taskOutputPath(actualRef), 'replay output\n');
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const history = (result: string) => ({
      model: 'm',
      tools: [],
      messages: [
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'uv run pytest' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't0', content: result }] },
      ],
    });
    const [a, b] = await Promise.all([
      post(`${srv.baseUrl('s1', 'a')}${MSG}`, history(backgrounded(REP_TASK_PATH))),
      post(`${srv.baseUrl('s1', 'b')}${MSG}`, history('42 passed')), // finished inside its timeout here
    ]);
    const command = (buf: Buffer) => JSON.parse(reassemble(ex(0, { chunks: [encodeChunk(0, buf)] })).cb1).command;
    const replayRef = taskOutputRefs(command(a.body))[0];
    const replayFile = taskOutputPath(replayRef);
    expect(command(a.body)).toBe(`sleep 100; tail -5 ${replayFile}`);
    expect(readFileSync(replayFile, 'utf8')).toBe('replay output\n');
    expect(command(b.body)).toBe(TAIL);
    await srv.close();
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    const by = Object.fromEntries(served.map((s) => [s.instance, s]));
    expect(by.a.tier).toBe('exact');
    expect(by.a.taskOutputIds).toEqual({ bl4w01qwj: 'bofqc99b6' });
    expect(by.a.taskOutputUnmapped).toBeUndefined();
    expect(by.b.taskOutputIds).toBeUndefined();
    expect(by.b.taskOutputUnmapped).toEqual(['bl4w01qwj']);
    expect(existsSync(replayFile)).toBe(false);
  });

  it('materializes an inline recorded task result as a replay-owned output file', async () => {
    const callId = 'toolu-inline-a';
    const recorded = ex(0, { chunks: bashChunks(TAIL, JSON.stringify({ command: TAIL }).indexOf('tasks/') - 9), messages: 3, tools: 0 });
    writeSession('inline', [recorded]);
    writeFileSync(path.join(corpus, 'inline', 'cli.jsonl'), cliTaskResult(callId, REC_TASK_PATH) + '\n');
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const history = {
      model: 'm',
      tools: [],
      messages: [
        { role: 'user', content: 'check the command result' },
        { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Bash', input: { command: 'uv run pytest' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: '42 passed\n' }] }] },
      ],
    };
    const response = await post(`${srv.baseUrl('inline', 'only-inline')}${MSG}`, history);
    const command = JSON.parse(reassemble(ex(0, { chunks: [encodeChunk(0, response.body)] })).cb1).command as string;
    const [replayRef] = taskOutputRefs(command);
    expect(replayRef).toBeDefined();
    const replayFile = taskOutputPath(replayRef);
    expect(command).toContain(replayFile);
    expect(readFileSync(replayFile, 'utf8')).toBe('42 passed\n');
    await srv.close();
    expect(existsSync(replayFile)).toBe(false);
    const [served] = readFileSync(logFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ServedRecord);
    expect(served.taskOutputIds).toEqual({ bl4w01qwj: replayRef.task });
    expect(served.taskOutputUnmapped).toBeUndefined();
  });

  it('pairs inline A and background B by tool_use_id, and removes replay-owned outputs on close', async () => {
    const callA = 'toolu-inline-a';
    const callB = 'toolu-background-b';
    const recordedA = REC_TASK_PATH;
    const recordedB = REC_TASK_PATH.replace('bl4w01qwj', 'b2nd');
    const commandText = `tail -5 ${recordedA}; tail -5 ${recordedB}`;
    const recorded = ex(0, { chunks: bashChunks(commandText, JSON.stringify({ command: commandText }).indexOf('tasks/') + 12), messages: 3, tools: 0 });
    writeSession('mixed', [recorded]);
    writeFileSync(path.join(corpus, 'mixed', 'cli.jsonl'), [cliTaskResult(callA, recordedA), cliTaskResult(callB, recordedB)].join('\n') + '\n');

    const uid = String(typeof process.getuid === 'function' ? process.getuid() : 1000);
    const actualRef = { uid, project: `replay-test-${randomUUID()}`, session: randomUUID(), task: `live-${randomUUID().slice(0, 8)}` };
    const actualFile = taskOutputPath(actualRef);
    externalTaskRoot = path.join('/tmp', `claude-${uid}`, actualRef.project);
    mkdirSync(path.dirname(actualFile), { recursive: true });
    writeFileSync(actualFile, 'background B output\n');

    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile() });
    const history = {
      model: 'm',
      tools: [],
      messages: [
        { role: 'user', content: 'wait for both commands' },
        { role: 'assistant', content: [
          { type: 'tool_use', id: callA, name: 'Bash', input: { command: 'uv run pytest A' } },
          { type: 'tool_use', id: callB, name: 'Bash', input: { command: 'uv run pytest B' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: callA, content: [{ type: 'text', text: 'inline A output\n' }] },
          { type: 'tool_result', tool_use_id: callB, content: [{ type: 'text', text: backgrounded(taskOutputPath(actualRef)) }] },
        ] },
      ],
    };
    const response = await post(`${srv.baseUrl('mixed', 'inline-then-background')}${MSG}`, history);
    const command = JSON.parse(reassemble(ex(0, { chunks: [encodeChunk(0, response.body)] })).cb1).command as string;
    const replayRefs = taskOutputRefs(command);
    expect(replayRefs).toHaveLength(2);
    expect(replayRefs[0].task).not.toBe(actualRef.task);
    expect(replayRefs[1].task).toBe(actualRef.task);
    expect(readFileSync(taskOutputPath(replayRefs[0]), 'utf8')).toBe('inline A output\n');
    expect(readFileSync(taskOutputPath(replayRefs[1]), 'utf8')).toBe('background B output\n');
    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ServedRecord);
    expect(served[0].taskOutputIds).toEqual({ bl4w01qwj: replayRefs[0].task, b2nd: actualRef.task });
    expect(served[0].taskOutputUnmapped).toBeUndefined();

    await srv.close();
    expect(existsSync(taskOutputPath(replayRefs[0]))).toBe(false);
    expect(existsSync(taskOutputPath(replayRefs[1]))).toBe(false);
    expect(readFileSync(actualFile, 'utf8')).toBe('background B output\n');
  });

  it('honours recorded delays scaled by speed', async () => {
    const chunks = [encodeChunk(60, Buffer.from('a')), encodeChunk(180, Buffer.from('b'))];
    writeSession('slow', [ex(0, { chunks, messages: 1, tools: 0 }), ex(1, { chunks, messages: 1, tools: 0 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 1 });
    const body = { model: 'm', messages: [{}], tools: [] };
    const real = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(real.body.toString()).toBe('ab');
    expect(real.ms).toBeGreaterThanOrEqual(170);
    await srv.close();
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    const fast = await post(`${srv.baseUrl('slow', 'a')}${MSG}`, body);
    expect(fast.body.toString()).toBe('ab');
    expect(fast.ms).toBeLessThan(120);
  });

  it('returns 404 for an unknown recording or a non-replay path', async () => {
    srv = await startReplayServer({ corpusDir: corpus, speed: 0 });
    expect((await post(`${srv.url}/r/nope/a${MSG}`, {})).status).toBe(404);
    expect((await post(`${srv.url}/v1/messages`, {})).status).toBe(404);
  });

  // P-015 parked agents: one held reply per matching instance, released for all at once.
  it('holds a parked instance\'s Nth streamed reply behind keepalive comments until releaseHolds, and no one else\'s', async () => {
    writeSession('s1', [ex(0, { messages: 1, tools: 3 }), ex(1, { messages: 1, tools: 3 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, logFile: logFile(), hold: { instancePrefix: 'park-', atRequest: 2, keepaliveMs: 20 } });
    const body = { model: 'm', stream: true, messages: [{}], tools: [{}, {}, {}] };
    const url = (instance: string) => `${srv.baseUrl('s1', instance)}${MSG}`;

    // Request 1 of a parked instance and both requests of an active one are served at once.
    expect((await post(url('park-1'), body)).ms).toBeLessThan(200);
    expect((await post(url('act-1'), body)).ms).toBeLessThan(200);
    expect((await post(url('act-1'), body)).ms).toBeLessThan(200);
    expect(srv.held()).toBe(0);

    // Request 2 of the parked instance waits for the release.
    const pending = post(url('park-1'), body);
    await new Promise((r) => setTimeout(r, 150));
    expect(srv.held()).toBe(1);
    expect(srv.releaseHolds()).toBe(1);
    const r2 = await pending;
    expect(r2.status).toBe(200);
    expect(r2.ms).toBeGreaterThanOrEqual(140);
    const text = r2.body.toString('utf8');
    // Keepalives are SSE comments ahead of the untouched recording.
    expect(text).toMatch(/^(: papercusp-capacity hold\n\n)+event: message_start\ndata: \{"seq":1\}\n\nevent: message_stop\ndata: \{\}\n\n$/);
    expect(srv.held()).toBe(0);
    expect(srv.releaseHolds()).toBe(0); // idempotent

    // After the release nothing is held, even a parked instance reaching its hold point.
    await post(url('park-2'), body);
    expect((await post(url('park-2'), body)).ms).toBeLessThan(200);
    await srv.close();

    const served = readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as ServedRecord);
    const heldRows = served.filter((s) => s.heldMs !== undefined);
    expect(heldRows.map((s) => [s.instance, s.seq])).toEqual([['park-1', 1]]);
    expect(heldRows[0].heldMs).toBeGreaterThanOrEqual(140);
  });

  it('close() never hangs on a reply still held, even with a long keepalive', async () => {
    writeSession('s1', [ex(0, { messages: 1, tools: 3 })]);
    srv = await startReplayServer({ corpusDir: corpus, speed: 0, hold: { instancePrefix: 'park-', atRequest: 1, keepaliveMs: 60_000 } });
    // close() also drops every connection, so the client may see an end or a reset; only the shutdown is asserted.
    const outcome = new Promise<string>((resolve) => {
      const data = Buffer.from(JSON.stringify({ model: 'm', stream: true, messages: [{}], tools: [{}, {}, {}] }));
      const r = http.request(`${srv.baseUrl('s1', 'park-1')}${MSG}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
        res.on('data', () => {});
        res.on('error', () => resolve('error'));
        res.on('end', () => resolve('end'));
        res.on('close', () => resolve('close'));
      });
      r.on('error', () => resolve('request-error'));
      r.end(data);
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(srv.held()).toBe(1);
    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(['end', 'close', 'error', 'request-error']).toContain(await outcome);
  });
});

describe('shouldHold', () => {
  const plan = { instancePrefix: 'T-p', atRequest: 4 };
  const h = { instance: 'T-p0-i0', requestNumber: 4, contentType: 'text/event-stream; charset=utf-8', alreadyHeld: false, released: false };
  it('holds the first streamed reply at or after the hold point of a matching instance', () => {
    expect(shouldHold(plan, h)).toBe(true);
    expect(shouldHold(plan, { ...h, requestNumber: 6 })).toBe(true);
  });
  it('never holds without a plan, before the hold point, twice, after the release, a non-matching instance or a JSON reply', () => {
    expect(shouldHold(undefined, h)).toBe(false);
    expect(shouldHold(plan, { ...h, requestNumber: 3 })).toBe(false);
    expect(shouldHold(plan, { ...h, alreadyHeld: true })).toBe(false);
    expect(shouldHold(plan, { ...h, released: true })).toBe(false);
    expect(shouldHold(plan, { ...h, instance: 'T-s0-i0' })).toBe(false);
    expect(shouldHold(plan, { ...h, contentType: 'application/json' })).toBe(false);
    expect(shouldHold(plan, { ...h, contentType: null })).toBe(false);
  });
});
