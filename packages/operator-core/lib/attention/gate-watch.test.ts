import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { defaultGateWatchRoots, extractGateQuestion, gateTranscriptIdentity, parseGateChunk } from './gate-watch';

const assistantToolUse = (id: string, name: string, input: unknown): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

const userToolResult = (toolUseId: string, content: unknown = 'ok'): string =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });

const askInput = (question: string, options: Array<{ label: string; description?: string }>) => ({
  questions: [{ question, header: 'h', multiSelect: false, options }],
});

describe('extractGateQuestion', () => {
  it('flattens AskUserQuestion questions + options', () => {
    const { question, options } = extractGateQuestion(
      'AskUserQuestion',
      askInput('Pick one?', [{ label: 'A', description: 'a desc' }, { label: 'B' }]),
    );
    expect(question).toBe('Pick one?');
    expect(options).toEqual([{ label: 'A', description: 'a desc' }, { label: 'B', description: undefined }]);
  });

  it('joins multiple questions and falls back to a stub when empty', () => {
    const { question } = extractGateQuestion('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }] });
    expect(question).toBe('Q1 / Q2');
    expect(extractGateQuestion('AskUserQuestion', {}).question).toBe('AskUserQuestion');
  });

  it('best-effort extracts an ExitPlanMode plan summary', () => {
    const { question, options } = extractGateQuestion('ExitPlanMode', { plan: 'Do the thing' });
    expect(question).toContain('approve this plan?');
    expect(question).toContain('Do the thing');
    expect(options).toBeNull();
    expect(extractGateQuestion('ExitPlanMode', {}).question).toBe('Exit plan mode — approve?');
  });
});

describe('parseGateChunk', () => {
  it('reports a gate tool_use with no matching tool_result as open', () => {
    const chunk = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [{ label: 'yes' }])) + '\n';
    const { opens, closes, consumedBytes } = parseGateChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect(opens).toEqual([{ toolUseId: 'toolu_1', toolName: 'AskUserQuestion', question: 'Q?', options: [{ label: 'yes', description: undefined }] }]);
    expect(closes).toEqual([]);
  });

  it('cancels out an ask resolved within the same chunk (never surfaced as open)', () => {
    const chunk =
      [assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])), userToolResult('toolu_1')].join('\n') + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('reports a close candidate for a tool_result whose tool_use was in a prior chunk', () => {
    const chunk = userToolResult('toolu_prev') + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([{ toolUseId: 'toolu_prev' }]);
  });

  it('ignores non-gate tool_use names', () => {
    const chunk = assistantToolUse('toolu_1', 'Bash', { command: 'ls' }) + '\n';
    const { opens, closes } = parseGateChunk(chunk);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('leaves a trailing partial line unconsumed', () => {
    const complete = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])) + '\n';
    const partial = '{"type":"assistant","message":{"content":[{"type":"tool_us';
    const { opens, consumedBytes } = parseGateChunk(complete + partial);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
    expect(opens).toHaveLength(1);
  });

  it('consumes nothing when there is no complete line', () => {
    const { opens, closes, consumedBytes } = parseGateChunk('{"type":"assist');
    expect(consumedBytes).toBe(0);
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
  });

  it('tolerates torn/garbage lines', () => {
    const chunk = ['not-json-at-all', assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', []))].join('\n') + '\n';
    const { opens, consumedBytes } = parseGateChunk(chunk);
    expect(consumedBytes).toBe(Buffer.byteLength(chunk, 'utf8'));
    expect(opens).toHaveLength(1);
  });

  it('handles two independent open gates in one chunk', () => {
    const chunk =
      [
        assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q1?', [])),
        assistantToolUse('toolu_2', 'ExitPlanMode', { plan: 'p' }),
      ].join('\n') + '\n';
    const { opens } = parseGateChunk(chunk);
    expect(opens.map((o) => o.toolUseId).sort()).toEqual(['toolu_1', 'toolu_2']);
  });

  it('reports an in-chunk ask/answer pair as `resolved` — closing evidence the store may still need', () => {
    const chunk =
      [assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])), userToolResult('toolu_1')].join('\n') + '\n';
    const { opens, closes, resolved } = parseGateChunk(chunk);
    // Still correctly absent from BOTH: it was never observably open, and its
    // tool_use was not in a prior chunk.
    expect(opens).toEqual([]);
    expect(closes).toEqual([]);
    // WI-10002079: dropping it (the previous behaviour) left a gate minted by
    // a turn-end hook, whose answer is already in the transcript, permanently
    // unclosable — and on a cold-start full-file replay EVERY historical pair
    // takes this shape, so it was the only evidence available.
    expect(resolved).toEqual([{ toolUseId: 'toolu_1' }]);
  });

  it('leaves `resolved` empty when nothing was answered in-chunk', () => {
    const chunk = assistantToolUse('toolu_1', 'AskUserQuestion', askInput('Q?', [])) + '\n';
    expect(parseGateChunk(chunk).resolved).toEqual([]);
    expect(parseGateChunk('{"type":"assist').resolved).toEqual([]);
  });
});

describe('defaultGateWatchRoots (WI-10002079/R1)', () => {
  it('includes the native Codex and OMP transcript trees', () => {
    expect(defaultGateWatchRoots('/home/agent')).toEqual(expect.arrayContaining([
      '/home/agent/.codex/sessions', '/home/agent/.omp/agent/sessions',
    ]));
  });
  it('includes the psu transcript root, not only the native CLI root', () => {
    const roots = defaultGateWatchRoots('/home/agent');
    // Watching only ~/.claude/projects made the tick tail a tree that does not
    // contain the sessions it exists to watch.
    expect(roots).toContain(path.join('/home/agent', '.papercusp', 'session-claude'));
    expect(roots).toContain(path.join('/home/agent', '.claude', 'projects'));
  });

  it('orders the psu root first — it holds the overwhelming majority of transcripts', () => {
    expect(defaultGateWatchRoots('/home/agent')[0]).toBe(path.join('/home/agent', '.papercusp', 'session-claude'));
  });
});

describe('native question correlation across clients', () => {
  const question = askInput('Which route?', [{ label: 'Direct', description: 'This session' }]);
  const codexCall = (id: string, name = 'functions.request_user_input', args = JSON.stringify(question)) =>
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: id, name, arguments: args } });
  const codexResult = (id: string) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: 'Direct' } });
  const ompCall = (id: string) => JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name: 'AskUserQuestion', arguments: question }] } });
  const ompResult = (id: string) => JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'Direct' }] } });

  it.each([
    { client: 'codex', call: codexCall, result: codexResult, name: 'request_user_input' },
    { client: 'omp', call: ompCall, result: ompResult, name: 'AskUserQuestion' },
  ])('$client opens, resolves in the same delta, and correlates a later answer by call id', ({ call, result, name }) => {
    expect(parseGateChunk(call('native-ask') + '\n').opens).toEqual([{
      toolUseId: 'native-ask', toolName: name, question: 'Which route?',
      options: [{ label: 'Direct', description: 'This session' }],
    }]);
    const together = parseGateChunk(call('native-ask') + '\n' + result('native-ask') + '\n');
    expect(together.resolved).toEqual([{ toolUseId: 'native-ask' }]);
    expect(together.opens).toHaveLength(0);
    expect(parseGateChunk(result('native-ask') + '\n').closes).toEqual([{ toolUseId: 'native-ask' }]);
  });

  it('ignores a non-question call and malformed arguments beside a real question', () => {
    const parsed = parseGateChunk([
      'null', '[]', '42',
      codexCall('shell', 'exec_command'), codexCall('broken', 'request_user_input', '{'), codexCall('valid'),
    ].join('\n') + '\n');
    expect(parsed.opens.map((g) => g.toolUseId)).toEqual(['valid']);
  });

  it('leaves a partial native answer for the next watermark delta', () => {
    const first = codexCall('split') + '\n';
    const answer = codexResult('split');
    const parsed = parseGateChunk(first + answer.slice(0, 30));
    expect(parsed.consumedBytes).toBe(Buffer.byteLength(first));
    expect(parsed.opens[0].toolUseId).toBe('split');
    expect(parseGateChunk(answer + '\n').closes).toEqual([{ toolUseId: 'split' }]);
  });

  it.each([
    { header: { type: 'session_meta', payload: { id: 'codex-native-id' } }, client: 'codex', id: 'codex-native-id' },
    { header: { type: 'session', id: 'omp-native-id' }, client: 'omp', id: 'omp-native-id' },
    { header: { type: 'assistant', sessionId: 'claude-native-id' }, client: 'claude', id: 'claude-native-id' },
  ])('uses the $client header instead of an unrelated filename', ({ header, client, id }) => {
    expect(gateTranscriptIdentity(JSON.stringify(header) + '\n', '/tmp/timestamp_rollout.jsonl')).toEqual({ client, sessionId: id });
  });
});

describe('native Codex asynchronous questions (WI-6554700010025999)', () => {
  // Codex 0.163.0: request_user_input_async.rs acknowledges with accepted:true.
  // tui/async_questions/state.rs uses JSON.stringify([tool name, call id, index]);
  // tui/async_question_reply.rs reads this envelope from a later USER message.
  const ref = (index = 0) => JSON.stringify(['request_user_input_async', 'async-ask', index]);
  const call = (name = 'functions.request_user_input_async') => JSON.stringify({
    type: 'response_item', payload: { type: 'function_call', call_id: 'async-ask', name,
      arguments: JSON.stringify({ questions: [
        { title: 'Which route?', options: ['Direct', 'Fleet'] }, { title: 'What deadline?' },
      ] }),
    },
  });
  const ack = JSON.stringify({ type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'async-ask', output: '{"accepted":true}',
  } });
  const envelope = (payload: unknown) => `<send_user_message_question_reply>${JSON.stringify(payload)}</send_user_message_question_reply>`;
  const reply = (questionItemId = ref()) => ({ questionItemId, question: 'Which route?', answer: 'Direct' });
  const message = (text: string, role = 'user') => JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role, content: [{ type: 'input_text', text }],
  } });
  const chunk = (...lines: string[]) => lines.join('\n') + '\n';

  it('extracts native title/string options, including a free-text question', () => {
    expect(extractGateQuestion('request_user_input_async', { questions: [
      { title: 'Which route?', options: ['Direct', 'Fleet'] }, { title: 'What deadline?' },
    ] })).toEqual({ question: 'Which route? / What deadline?', options: [{ label: 'Direct' }, { label: 'Fleet' }] });
  });

  it.each(['request_user_input_async', 'functions.request_user_input_async', 'functions__request_user_input_async'])(
    'keeps each %s question open after its immediate acknowledgement', (name) => {
      expect(parseGateChunk(chunk(call(name), ack)).opens).toEqual([
        { toolUseId: ref(), toolName: 'request_user_input_async', question: 'Which route?', options: [{ label: 'Direct' }, { label: 'Fleet' }] },
        { toolUseId: ref(1), toolName: 'request_user_input_async', question: 'What deadline?', options: null },
      ]);
      expect(parseGateChunk(chunk(call(name), ack)).resolved).toEqual([]);
      expect(parseGateChunk(chunk(ack)).closes).toEqual([]);
    },
  );

  it('closes only the answered question and leaves its sibling open', () => {
    const parsed = parseGateChunk(chunk(call(), ack, message(envelope(reply()))));
    expect(parsed.opens.map(g => g.toolUseId)).toEqual([ref(1)]);
    expect(parsed.resolved).toEqual([{ toolUseId: ref() }]);
    expect(parseGateChunk(chunk(message(envelope(reply())))).closes).toEqual([{ toolUseId: ref() }]);
  });

  it('recognizes a batched reply and the standard IDE context prefix', () => {
    const text = '# Context from my IDE setup:\nfile.ts\n## My request for Codex:\n' + envelope([reply(), reply(ref(1))]);
    expect(parseGateChunk(chunk(call(), message(text))).resolved).toEqual([{ toolUseId: ref() }, { toolUseId: ref(1) }]);
    expect(parseGateChunk(chunk(call(), message(text))).opens).toEqual([]);
  });

  it.each([
    'Direct',
    'Quoted: ' + envelope(reply()),
    envelope(reply()) + ' trailing text',
    envelope([]),
    envelope([reply(), null]),
    envelope({ questionItemId: ref(), question: 'Which route?' }),
    '<send_user_message_question_reply>{</send_user_message_question_reply>',
  ])('does not infer a correlated answer from ordinary or malformed text: %s', (text) => {
    expect(parseGateChunk(chunk(message(text))).closes).toEqual([]);
  });

  it('ignores reply envelopes in assistant messages and unrelated call results', () => {
    const unrelated = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'other', output: 'Direct' } });
    const parsed = parseGateChunk(chunk(call(), message(envelope(reply()), 'assistant'), unrelated));
    expect(parsed.opens.map(g => g.toolUseId)).toEqual([ref(), ref(1)]);
    expect(parsed.resolved).toEqual([]);
  });

  it('preserves a partial answer line for the next watermark delta', () => {
    const first = chunk(call(), ack);
    const answer = message(envelope(reply()));
    const parsed = parseGateChunk(first + answer.slice(0, 50));
    expect(parsed.consumedBytes).toBe(Buffer.byteLength(first));
    expect(parsed.opens).toHaveLength(2);
    expect(parseGateChunk(answer + '\n').closes).toEqual([{ toolUseId: ref() }]);
  });
});
