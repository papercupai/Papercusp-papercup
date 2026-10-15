/**
 * Parser conformance for the session-transcript ingest adapters
 * (session-search-scope-2026-07-05 P-003). Pure line→turn tests — no PG, no
 * FS: the parsers are the part most likely to silently rot when a client
 * changes its transcript shape, so each client's REAL observed line shapes
 * (sampled 2026-07-05 from live files on the dev box) are pinned here.
 */

import { describe, it, expect } from 'vitest';
import {
  parseClaudeLine,
  parseOmpLine,
  parseCodexLine,
  classifyClaudeLine,
  classifyOmpLine,
  classifyCodexLine,
  textFromContent,
  CLAUDE_OWNER_DIALOG_RESULT_PREFIXES,
} from './session-ingest';
import { OWNER_DIALOG_TURN_MARKER } from '../turn-provenance/turn-ref';
import { promptOriginHash } from './session-ingest';

describe('short user decisions', () => {
  const adapters = [
    { name: 'claude', parse: parseClaudeLine, signal: classifyClaudeLine,
      line: (text: string, role = 'user') => ({ type: role, timestamp: '2026-10-08T01:10:19.604Z', message: { role, content: text } }) },
    { name: 'omp', parse: parseOmpLine, signal: classifyOmpLine,
      line: (text: string, role = 'user') => ({ type: 'message', timestamp: '2026-10-08T01:10:19.604Z', message: { role, content: [{ type: 'text', text }] } }) },
    { name: 'codex', parse: parseCodexLine, signal: classifyCodexLine,
      line: (text: string, role = 'user') => ({ type: 'response_item', timestamp: '2026-10-08T01:10:19.604Z', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } }) },
    { name: 'codex history', parse: parseCodexLine, signal: classifyCodexLine,
      line: (text: string, role = 'user') => role === 'user'
        ? { session_id: 'short-history', ts: 1791421819.604, text }
        : { type: 'response_item', payload: { type: 'message', role, content: [{ type: 'output_text', text }] } } },
  ];
  for (const adapter of adapters) {
    it.each(['A', 'B', 'y', 'no', 'ok'])(`${adapter.name} retains and counts the user decision %s`, (decision) => {
      const raw = ` ${decision}\r\n`;
      const line = JSON.stringify(adapter.line(raw));
      expect(adapter.parse(line)).toMatchObject({ speaker: 'user', text: decision, promptHash: promptOriginHash(raw) });
      expect(adapter.signal(line)?.isPrompt).toBe(true);
      expect(adapter.parse(line, { retainShortUserTurns: false })).toBeNull();
    });
    it(`${adapter.name} still excludes empty turns and short assistant acknowledgements`, () => {
      expect(adapter.parse(JSON.stringify(adapter.line(' \r\n ')))).toBeNull();
      expect(adapter.signal(JSON.stringify(adapter.line(' \r\n ')))?.isPrompt).toBe(false);
      expect(adapter.parse(JSON.stringify(adapter.line('ok', 'assistant')))).toBeNull();
    });
  }
});

describe('textFromContent', () => {
  it('passes strings through and joins text-ish parts', () => {
    expect(textFromContent('hello')).toBe('hello');
    expect(
      textFromContent([
        { type: 'text', text: 'a' },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'input_text', text: 'b' },
        { type: 'output_text', text: 'c' },
        { type: 'thinking', thinking: 'private' },
      ]),
    ).toBe('a\nb\nc');
  });
});

describe('parseClaudeLine', () => {
  it('extracts a user turn (string content) with ts + cwd + sessionId', () => {
    const t = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        uuid: 'claude-owner-1',
        parentUuid: null,
        message: { role: 'user', content: 'fix the login bug please' },
        timestamp: '2026-07-05T01:00:00.000Z',
        cwd: '/repo',
        sessionId: 'abc-123',
      }),
    );
    expect(t).toMatchObject({
      speaker: 'user',
      text: 'fix the login bug please',
      cwd: '/repo',
      sessionId: 'abc-123',
      requestId: 'claude-owner-1',
      messageId: 'claude-owner-1',
      parentMessageId: null,
    });
    expect(t?.ts?.toISOString()).toBe('2026-07-05T01:00:00.000Z');
  });

  it('extracts assistant text parts and skips thinking/tool_use parts', () => {
    const t = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        uuid: 'claude-answer-1',
        parentUuid: 'claude-owner-1',
        message: {
          role: 'assistant',
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'secret reasoning' },
            { type: 'text', text: 'The root cause is the provenance stamp.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        timestamp: '2026-07-05T01:00:01.000Z',
      }),
    );
    expect(t?.speaker).toBe('assistant');
    expect(t?.text).toBe('The root cause is the provenance stamp.');
    expect(t?.text).not.toContain('secret reasoning');
    expect(t).toMatchObject({
      messageId: 'claude-answer-1',
      parentMessageId: 'claude-owner-1',
      responseDisposition: 'delivered',
    });
  });

  it('distinguishes Claude tool progress and API interruption from final delivery', () => {
    const progress = parseClaudeLine(JSON.stringify({
      type: 'assistant',
      uuid: 'a-progress',
      parentUuid: 'u-1',
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'I am checking.' }] },
    }));
    const interrupted = parseClaudeLine(JSON.stringify({
      type: 'assistant',
      uuid: 'a-error',
      parentUuid: 'u-1',
      isApiErrorMessage: true,
      error: 'connection closed',
      message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'Partial output.' }] },
    }));
    expect(progress?.responseDisposition).toBe('progress');
    expect(interrupted?.responseDisposition).toBe('interrupted');
  });

  it('promotes only AskUserQuestion answers from tool_result carriers into searchable user turns', () => {
    const answer = 'The user answered: "Which route?"="Use the visible fleet". Read the answers carefully.';
    const promoted = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_ask', content: answer }],
        },
      }),
    );
    expect(promoted).toMatchObject({ speaker: 'user' });
    expect(promoted?.text).toBe(`${OWNER_DIALOG_TURN_MARKER}\n${answer}`);
    expect(promoted?.text).toContain('Use the visible fleet');

    const ordinary = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'command output' }],
        },
      }),
    );
    expect(ordinary).toBeNull();
  });

  it('promotes the batched AskUserQuestion result shape emitted by current Claude Code', () => {
    const answer =
      'Your questions have been answered: "How far?"="All three, T3 landed last (Recommended)", ' +
      '"Which route?"="I implement it here (Recommended)". You can now continue with these answers in mind.';
    const promoted = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_batched_ask', content: answer }],
        },
      }),
    );

    expect(CLAUDE_OWNER_DIALOG_RESULT_PREFIXES).toContain('Your questions have been answered:');
    expect(promoted).toMatchObject({ speaker: 'user' });
    expect(promoted?.text).toBe(`${OWNER_DIALOG_TURN_MARKER}\n${answer}`);
    expect(promoted?.text).toContain('All three, T3 landed last');
    expect(promoted?.text).toContain('I implement it here');
  });

  it('does not promote a non-dialog tool result that merely contains answer-like prose later', () => {
    const ordinary = parseClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_bash',
            content: 'command output\nYour questions have been answered: not actually a dialog result',
          }],
        },
      }),
    );
    expect(ordinary).toBeNull();
  });

  it('extracts a human mid-turn queued_command attachment as a user turn', () => {
    const t = parseClaudeLine(
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-08-28T05:59:14.172Z',
        sessionId: 'claude-session-1',
        cwd: '/repo',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          prompt: 'Please preserve this owner directive in the transcript.',
          timestamp: '2026-08-28T05:59:14.172Z',
        },
      }),
    );
    expect(t).toMatchObject({
      speaker: 'user',
      text: 'Please preserve this owner directive in the transcript.',
      cwd: '/repo',
      sessionId: 'claude-session-1',
    });
    expect(t?.ts?.toISOString()).toBe('2026-08-28T05:59:14.172Z');
  });

  it('does not promote non-human or non-prompt queued command attachments', () => {
    const base = {
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        prompt: 'keep this out unless the shape is a human prompt',
      },
    };
    expect(
      parseClaudeLine(JSON.stringify({
        ...base,
        attachment: { ...base.attachment, origin: { kind: 'assistant' } },
      })),
    ).toBeNull();
    expect(
      parseClaudeLine(JSON.stringify({
        ...base,
        attachment: { ...base.attachment, commandMode: 'command' },
      })),
    ).toBeNull();
    expect(
      parseClaudeLine(JSON.stringify({
        ...base,
        attachment: { ...base.attachment, type: 'file' },
      })),
    ).toBeNull();
  });

  it('returns null for non-turn lines (queue-operation / summary / system)', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'queue-operation', content: 'ignored' }))).toBeNull();
    expect(parseClaudeLine(JSON.stringify({ type: 'summary', summary: 'ignored' }))).toBeNull();
    expect(parseClaudeLine('not json at all')).toBeNull();
  });

  it('drops injected boilerplate (system-reminder / caveat prefixes)', () => {
    const mk = (text: string) =>
      parseClaudeLine(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }));
    expect(mk('<system-reminder>stuff</system-reminder>')).toBeNull();
    expect(mk('Caveat: The messages below were generated by local commands')).toBeNull();
  });

  it('redacts common secret shapes and caps turn length', () => {
    const key = `sk-${'a'.repeat(24)}`;
    const t = parseClaudeLine(
      JSON.stringify({ type: 'user', message: { role: 'user', content: `my key is ${key} ok` } }),
    );
    expect(t?.text).toBe('my key is [redacted] ok');
    const long = parseClaudeLine(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(20_000) } }),
    );
    expect(long?.text.length).toBeLessThanOrEqual(8000);
  });

  it('skips short assistant acknowledgements', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'y' } }))).toBeNull();
  });
});

describe('parseOmpLine', () => {
  it('parses the live message shape', () => {
    // Real shape sampled from ~/.omp/agent/sessions (2026-07-05).
    const t = parseOmpLine(
      JSON.stringify({
        type: 'message',
        id: '2cd589cb',
        parentId: null,
        timestamp: '2026-07-04T14:59:05.995Z',
        message: { role: 'user', content: [{ type: 'text', text: 'tools list please' }], attribution: 'user' },
      }),
    );
    expect(t).toMatchObject({
      speaker: 'user',
      text: 'tools list please',
      requestId: '2cd589cb',
      messageId: '2cd589cb',
      parentMessageId: null,
    });
  });

  it('uses OMP stop/toolUse/error as delivered/progress/interrupted wire evidence', () => {
    const line = (id: string, stopReason: string, errorMessage?: string) => parseOmpLine(JSON.stringify({
      type: 'message',
      id,
      parentId: 'omp-owner-1',
      message: {
        role: 'assistant',
        stopReason,
        ...(errorMessage ? { errorMessage } : {}),
        content: [{ type: 'text', text: `${stopReason} output` }],
      },
    }));
    expect(line('a-stop', 'stop')?.responseDisposition).toBe('delivered');
    expect(line('a-tool', 'toolUse')?.responseDisposition).toBe('progress');
    expect(line('a-error', 'error', 'provider failed')?.responseDisposition).toBe('interrupted');
  });

  it('ignores non-message lines (title / session / thinking)', () => {
    expect(parseOmpLine(JSON.stringify({ type: 'title', title: '' }))).toBeNull();
    expect(parseOmpLine(JSON.stringify({ type: 'session', id: 'x', cwd: '/' }))).toBeNull();
    expect(parseOmpLine(JSON.stringify({ type: 'thinking', text: 'private' }))).toBeNull();
  });
});

/**
 * EI-9970 recurrence guard — classifyXLine + the readNewLines dedup contract
 * documented on LineSignal. Real transcripts show a single logical Claude
 * response can be split across MULTIPLE 'assistant' JSONL lines sharing one
 * message.id (thinking-only stub → tool_use → text) — a naive per-line
 * count double/triple-counts that as separate responses, reproducing the
 * exact bug sessions:list's undocumented `turns` field caused (2026-07-12
 * fleet retrospective). These pin the classifier contract directly; the
 * dedup-across-lines behavior itself is exercised via readNewLines in
 * session-ingest-fixture.test.ts (needs the shared dedup cursor, so it
 * belongs with the PG-touching ingest tests, not this pure-parser file).
 */
describe('classifyClaudeLine (EI-9970)', () => {
  it('classifies a real user prompt as isPrompt, not a response', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the login bug please' } }),
    );
    expect(sig).toMatchObject({ isPrompt: true, isResponsePayload: false, toolCallCount: 0 });
  });

  it('does NOT count a tool_result-carrying synthetic user line as a prompt', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      }),
    );
    expect(sig).toMatchObject({ isPrompt: false, isResponsePayload: false });
  });

  it('counts a human queued_command attachment as a prompt', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          prompt: 'continue the implementation from here',
        },
      }),
    );
    expect(sig).toMatchObject({ isPrompt: true, isResponsePayload: false, toolCallCount: 0 });
  });

  it('a pure-thinking-only assistant line is NOT a response payload (the split-response class)', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_1', content: [{ type: 'thinking', thinking: 'reasoning...' }] },
      }),
    );
    expect(sig).toMatchObject({ isResponsePayload: false, inferenceId: null, toolCallCount: 0 });
  });

  it('a tool_use-only assistant line IS a response payload, carries the tool call, and its id is captured for dedup', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
      }),
    );
    expect(sig).toMatchObject({ isResponsePayload: true, inferenceId: 'msg_1', toolCallCount: 1 });
  });

  it('a text-bearing assistant line sharing the SAME message.id as a prior tool_use line is a response payload with the SAME id (dedup keys them together)', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'done — deployed' }] },
      }),
    );
    expect(sig).toMatchObject({ isResponsePayload: true, inferenceId: 'msg_1', toolCallCount: 0 });
  });

  it('falls back to requestId when message.id is absent', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'assistant',
        requestId: 'req_1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there friend' }] },
      }),
    );
    expect(sig?.inferenceId).toBe('req_1');
  });

  it('multiple tool_use blocks on one line count each', () => {
    const sig = classifyClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          id: 'msg_2',
          content: [
            { type: 'tool_use', name: 'Read', input: {} },
            { type: 'tool_use', name: 'Bash', input: {} },
          ],
        },
      }),
    );
    expect(sig?.toolCallCount).toBe(2);
  });

  it('returns null for non-turn lines', () => {
    expect(classifyClaudeLine(JSON.stringify({ type: 'summary', summary: 'x' }))).toBeNull();
    expect(classifyClaudeLine('not json')).toBeNull();
  });
});

describe('classifyOmpLine (EI-9970)', () => {
  it('a toolResult-role line is neither a prompt nor a response', () => {
    const sig = classifyOmpLine(
      JSON.stringify({
        type: 'message',
        id: 'tr_1',
        message: { role: 'toolResult', toolCallId: 'tc_1', content: 'ok' },
      }),
    );
    expect(sig).toMatchObject({ isPrompt: false, isResponsePayload: false });
  });

  it('an assistant toolCall content item counts as a tool call + response payload', () => {
    const sig = classifyOmpLine(
      JSON.stringify({
        type: 'message',
        id: 'a_1',
        message: { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', input: {} }] },
      }),
    );
    expect(sig).toMatchObject({ isResponsePayload: true, inferenceId: 'a_1', toolCallCount: 1 });
  });

  it('a real user text line is a prompt', () => {
    const sig = classifyOmpLine(
      JSON.stringify({
        type: 'message',
        id: 'u_1',
        message: { role: 'user', content: [{ type: 'text', text: 'tools list please' }] },
      }),
    );
    expect(sig).toMatchObject({ isPrompt: true, isResponsePayload: false });
  });

  it('non-message lines classify as null', () => {
    expect(classifyOmpLine(JSON.stringify({ type: 'session', id: 'x' }))).toBeNull();
  });
});

describe('classifyCodexLine (EI-9970)', () => {
  it('a function_call / custom_tool_call payload is a tool call, not a prompt or response', () => {
    for (const kind of ['function_call', 'custom_tool_call']) {
      const sig = classifyCodexLine(
        JSON.stringify({ type: 'response_item', payload: { type: kind, id: 'c_1', call_id: 'cc_1', name: 'shell' } }),
      );
      expect(sig).toMatchObject({ isPrompt: false, isResponsePayload: false, toolCallCount: 1 });
    }
  });

  it('an assistant message payload is a response payload keyed by its own id (already atomic — no split-line dedup needed)', () => {
    const sig = classifyCodexLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', id: 'msg_5', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      }),
    );
    expect(sig).toMatchObject({ isResponsePayload: true, inferenceId: 'msg_5', toolCallCount: 0 });
  });

  it('a user message payload is a prompt', () => {
    const sig = classifyCodexLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] },
      }),
    );
    expect(sig).toMatchObject({ isPrompt: true, isResponsePayload: false });
  });

  it('a reasoning payload classifies as null (not a message, not a tool call)', () => {
    expect(
      classifyCodexLine(JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', id: 'r_1' } })),
    ).toBeNull();
  });
});

describe('parseCodexLine', () => {
  it('parses response_item message turns (input_text/output_text parts)', () => {
    const t = parseCodexLine(
      JSON.stringify({
        timestamp: '2026-07-05T04:26:13.877Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'codex-answer-1',
          role: 'assistant',
          phase: 'final_answer',
          internal_chat_message_metadata_passthrough: { turn_id: 'codex-turn-1' },
          content: [{ type: 'output_text', text: 'done — deployed' }],
        },
      }),
    );
    expect(t).toMatchObject({
      speaker: 'assistant',
      text: 'done — deployed',
      requestId: 'codex-turn-1',
      messageId: 'codex-answer-1',
      responseDisposition: 'delivered',
    });
  });

  it('keeps Codex commentary as progress on the same typed turn id', () => {
    const t = parseCodexLine(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'codex-commentary-1',
        role: 'assistant',
        phase: 'commentary',
        internal_chat_message_metadata_passthrough: { turn_id: 'codex-turn-1' },
        content: [{ type: 'output_text', text: 'I am checking.' }],
      },
    }));
    expect(t).toMatchObject({ requestId: 'codex-turn-1', responseDisposition: 'progress' });
  });

  it('skips developer-role instruction blobs and non-message payloads', () => {
    expect(
      parseCodexLine(
        JSON.stringify({
          timestamp: 't',
          type: 'response_item',
          payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] },
        }),
      ),
    ).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'session_meta', payload: {} }))).toBeNull();
  });

  it('parses Codex history.jsonl fallback prompts with second timestamps', () => {
    const line = JSON.stringify({
      session_id: '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f',
      ts: 1_783_926_209,
      text: 'implement the full operability audit now',
    });
    const turn = parseCodexLine(line);
    expect(turn).toMatchObject({
      sessionId: '019f4fa9-4a09-78c0-8a35-d7e3382d1f8f',
      speaker: 'user',
      text: 'implement the full operability audit now',
    });
    expect(turn?.ts?.getUTCFullYear()).toBeGreaterThan(2025);
    expect(classifyCodexLine(line)).toMatchObject({ isPrompt: true, isResponsePayload: false });
  });
});
