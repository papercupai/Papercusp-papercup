/**
 * session-timeline-parsers tests — codex rollout + omp session lines → the
 * thinking pane's AgentTimelineEntry vocabulary. Line shapes sampled from real
 * files on the dev box (su-codex-homes rollouts / ~/.omp/agent/sessions).
 */

import { describe, expect, it } from 'vitest';
import { createCodexTimelineParser, createOmpTimelineParser } from './session-timeline-parsers';

describe('createCodexTimelineParser', () => {
  const p = () => createCodexTimelineParser();

  it('maps user_message → prompt and agent_message → text (with ts)', () => {
    expect(p().parseLine(JSON.stringify({
      timestamp: '2026-06-26T10:09:39.704Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'fix the roster' },
    }))).toEqual([{ kind: 'prompt', text: 'fix the roster', ts: '2026-06-26T10:09:39.704Z' }]);

    expect(p().parseLine(JSON.stringify({
      timestamp: 't2',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'On it.' },
    }))).toEqual([{ kind: 'text', text: 'On it.', ts: 't2' }]);
  });

  it('maps current response_item/message rows and skips injected developer text', () => {
    const parser = p();
    expect(parser.parseLine(JSON.stringify({
      timestamp: 't1',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'show the turn history' }],
      },
    }))).toEqual([{ kind: 'prompt', text: 'show the turn history', ts: 't1' }]);

    expect(parser.parseLine(JSON.stringify({
      timestamp: 't2',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'First paragraph.' },
          { type: 'output_text', text: 'Second paragraph.' },
        ],
      },
    }))).toEqual([{
      kind: 'text',
      text: 'First paragraph.\n\nSecond paragraph.',
      ts: 't2',
    }]);

    expect(parser.parseLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'hidden instructions' }],
      },
    }))).toEqual([]);
  });

  it('deduplicates legacy event_msg and canonical response_item copies of one message', () => {
    const parser = p();
    expect(parser.parseLine(JSON.stringify({
      timestamp: 'legacy-ts',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Done.' },
    }))).toEqual([{ kind: 'text', text: 'Done.', ts: 'legacy-ts' }]);
    expect(parser.parseLine(JSON.stringify({
      timestamp: 'canonical-ts',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      },
    }))).toEqual([]);

    // The inverse order occurs in some rollout generations too.
    const inverse = p();
    expect(inverse.parseLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Again' }],
      },
    }))).toHaveLength(1);
    expect(inverse.parseLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Again' },
    }))).toEqual([]);
  });

  it('maps function_call (+namespace, string args) → tool_use with parsed input', () => {
    const [e] = p().parseLine(JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'omp_sessions',
        namespace: 'mcp__papercusp_su',
        arguments: '{"op":"list"}',
        call_id: 'call_1',
      },
    }));
    expect(e).toEqual({
      kind: 'tool_use',
      toolName: 'mcp__papercusp_su.omp_sessions',
      toolInput: { op: 'list' },
      toolId: 'call_1',
      ts: 't',
    });
  });

  it('maps function_call_output / custom_tool_call_output → tool_result', () => {
    expect(p().parseLine(JSON.stringify({
      timestamp: 't',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'done', call_id: 'call_1' },
    }))).toEqual([{ kind: 'tool_result', text: 'done', toolId: 'call_1', ts: 't' }]);
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', output: 'patched', call_id: 'c2' },
    }))[0].kind).toBe('tool_result');
  });

  it('skips encrypted reasoning but surfaces a readable summary as status', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' },
    }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ text: 'plan the fix' }] },
    }))).toEqual([{ kind: 'status', text: '[thinking] plan the fix', ts: undefined }]);
  });

  it('skips meta noise (session_meta, token_count, turn_context) and bad json', () => {
    expect(p().parseLine(JSON.stringify({ type: 'session_meta', payload: {} }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'turn_context', payload: {} }))).toEqual([]);
    expect(p().parseLine('{not json')).toEqual([]);
  });

  it('marks a compaction as a status entry', () => {
    expect(p().parseLine(JSON.stringify({ timestamp: 't', type: 'compacted', payload: {} })))
      .toEqual([{ kind: 'status', text: 'context compacted', ts: 't' }]);
  });
});

describe('createOmpTimelineParser', () => {
  const p = () => createOmpTimelineParser();

  it('maps user text → prompt, assistant text → text, thinking → status', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't1',
      message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    }))).toEqual([{ kind: 'prompt', text: 'do the thing', ts: 't1' }]);

    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't2',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Done.' },
        ],
      },
    }))).toEqual([
      { kind: 'status', text: '[thinking] hmm', ts: 't2' },
      { kind: 'text', text: 'Done.', ts: 't2' },
    ]);
  });

  it('maps assistant toolCall → tool_use and toolResult-role text → tool_result', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'search_tool_bm25', arguments: { query: 'orient' } }],
      },
    }))).toEqual([{
      kind: 'tool_use', toolName: 'search_tool_bm25', toolInput: { query: 'orient' }, toolId: 'call_1', ts: 't',
    }]);

    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: { role: 'toolResult', content: [{ type: 'text', text: '{"match_count":0}' }] },
    }))).toEqual([{ kind: 'tool_result', text: '{"match_count":0}', ts: 't' }]);
  });

  it('skips non-message records (session/title/model_change) and bad json', () => {
    expect(p().parseLine(JSON.stringify({ type: 'session', id: 'x' }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'title', title: '' }))).toEqual([]);
    expect(p().parseLine(JSON.stringify({ type: 'model_change', model: 'm' }))).toEqual([]);
    expect(p().parseLine('nope')).toEqual([]);
  });

  it('accepts plain-string message content as one block', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: { role: 'user', content: 'plain' },
    }))).toEqual([{ kind: 'prompt', text: 'plain', ts: 't' }]);
  });

  // A failed turn writes `content: []`, so the block loop emits nothing. Before
  // WI-41660 that made a rate-limited session render as a BLANK timeline while the
  // provider's reason sat unread on the wire. Shapes below are the live omp wire.
  it('surfaces an errored turn whose content array is EMPTY', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorStatus: 402,
        errorMessage: '402 Insufficient credits. This account never purchased credits.',
      },
    }))).toEqual([{
      kind: 'status',
      text: '[error] (402) 402 Insufficient credits. This account never purchased credits.',
      ts: 't',
    }, { kind: 'result', outcome: 'failed', text: '', ts: 't' }]);
  });

  it('omits the parenthetical when the failure carries no HTTP status', () => {
    // Retry-budget exhaustion has no errorStatus — 9 of 68 sampled records.
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: {
        role: 'assistant', content: [], stopReason: 'error',
        errorMessage: 'Retry budget exhausted after 10 retries: 429 Provider returned error',
      },
    }))).toEqual([{
      kind: 'status',
      text: '[error] Retry budget exhausted after 10 retries: 429 Provider returned error',
      ts: 't',
    }, { kind: 'result', outcome: 'failed', text: '', ts: 't' }]);
  });

  it('still reports the error when the turn produced text BEFORE failing', () => {
    // The regression that matters: a partial turn must not read as a success.
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'starting on the resolver' }],
        stopReason: 'error', errorStatus: 429, errorMessage: '429 Provider returned error',
      },
    }))).toEqual([
      { kind: 'text', text: 'starting on the resolver', ts: 't' },
      { kind: 'status', text: '[error] (429) 429 Provider returned error', ts: 't' },
      { kind: 'result', outcome: 'failed', text: '', ts: 't' },
    ]);
  });

  it('does not invent an error entry for an ordinary empty or non-errored turn', () => {
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't', message: { role: 'assistant', content: [] },
    }))).toEqual([]);
    // An error without displayable text still attests failure, never success.
    expect(p().parseLine(JSON.stringify({
      type: 'message', timestamp: 't',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '   ' },
    }))).toEqual([{ kind: 'result', outcome: 'failed', text: '', ts: 't' }]);
  });
});

describe('native terminal outcomes used by the Cloud lesson', () => {
  const timestamp = '2026-10-01T12:00:00.000Z';
  it('distinguishes Codex completion, commentary, interruption and a malformed terminal row', () => {
    const parser = createCodexTimelineParser();
    const row = (payload: unknown) => parser.parseLine(JSON.stringify({ type: 'event_msg', timestamp, payload }));
    expect(row({ type: 'agent_message', message: 'Working.' })).toEqual([{ kind: 'text', text: 'Working.', ts: timestamp }]);
    expect(row({ type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'Tools: read, search.' })).toEqual([{ kind: 'result', outcome: 'succeeded', text: 'Tools: read, search.', ts: timestamp }]);
    expect(row({ type: 'task_complete', turn_id: 'turn-1', status: 'failed' })[0]?.outcome).toBe('failed');
    expect(row({ type: 'turn_aborted' })[0]?.outcome).toBe('failed');
    expect(row({ type: 'task_complete', last_agent_message: 'Unknown identity' })).toEqual([]);
  });
  it('attests OMP stop success while tool continuation and truncated answers remain nonterminal', () => {
    const parser = createOmpTimelineParser();
    const row = (stopReason: string) => parser.parseLine(JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', stopReason, content: [{ type: 'text', text: 'Tools: read.' }] } }));
    expect(row('stop').at(-1)?.outcome).toBe('succeeded');
    expect(row('toolUse').some(entry => entry.outcome)).toBe(false);
    expect(row('length').some(entry => entry.outcome)).toBe(false);
  });
});
