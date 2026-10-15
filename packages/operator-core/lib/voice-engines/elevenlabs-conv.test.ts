/**
 * askOperatorViaSse — voice path covering the state-snapshot
 * fallbackText surfacing added by the bespoke-card-improvements arc.
 *
 * Plan §6.3 (voice modality) + §4.8 (file scope).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Registry mock drives buildClientTools / buildClientToolCatalog. The
// askOperatorViaSse suite below doesn't touch the registry, so mocking it is
// inert there. `../commands/defs` (a side-effect import in the SUT that would
// register real defs) is stubbed empty so only our mock defs exist.
// `...args` so `.mock.calls[N][i]` indexing in the assertions type-checks (bare `()=>` inferred a 0-arg empty tuple).
const runCommand = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'cmd' }));
const runQuery = vi.fn(async (..._args: unknown[]) => ({ ok: true, ran: 'query' }));
// Only consumed by startElevenLabsConv (not under test). Stub it so the SUT
// module graph resolves cleanly under the mock pipeline.
vi.mock('../browser-workspace', () => ({ wsLocalKey: (k: string) => k }));
vi.mock('../commands/defs', () => ({}));
vi.mock('../commands/registry', () => ({
  list: vi.fn((sel: { kind: string; browser?: string[] }) => {
    if (sel.kind === 'command') {
      // Only browser:'required' (reflexive) commands are exposed as in-page
      // client tools; server-side commands are wired as EL webhook tools and
      // must NOT appear here.
      return sel.browser?.includes('required')
        ? [{ id: 'panel.toggle', description: 'Toggle', promptDescription: 'Toggle the panel', schema: {} }]
        : [];
    }
    return [{ id: 'status.summary', description: 'Status summary', schema: {} }];
  }),
  runCommand: (...a: unknown[]) => runCommand(...(a as [])),
  runQuery: (...a: unknown[]) => runQuery(...(a as [])),
}));

import {
  askOperatorViaSse,
  buildClientTools,
  buildClientToolCatalog,
  createTwoTierTranscript,
  routeVoiceMessageToTranscript,
} from './elevenlabs-conv';
import { VOICE_BRAIN_EMPTY_QUESTION_LINE, VOICE_BRAIN_FAILURE_LINE } from '@papercusp/chat-protocol';
import { list } from '../commands/registry';

/** Build a Response whose body is an SSE stream of the given lines. */
function sseResponse(lines: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of lines) {
        controller.enqueue(enc.encode(block));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  // First call: history fetch. Return empty turns.
  // Subsequent calls: the operator-converse SSE.
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  // Default history response — overridden per test if needed.
  fetchSpy.mockImplementation((url: string) => {
    if (url.startsWith('/api/operator/conversations?')) {
      return Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
});

afterEach(() => fetchSpy.mockReset());

describe('askOperatorViaSse — state-snapshot fallbackText surfacing', () => {
  it('plain delta path: returns the <say>-wrapped body', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>"}\n\n',
          'event: delta\ndata: {"text":"hello there"}\n\n',
          'event: delta\ndata: {"text":"</say>"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('hello there');
  });

  it('state-snapshot with fallbackText appears in the spoken response', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>checking the docs</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r-1',
                version: 1,
                snapshot: {
                  openCards: [
                    {
                      correlationId: 'cid-1',
                      prompt: 'Confirm details',
                      dataSchemaJson: {},
                      fallbackText: 'Pick: yes or no',
                      createdAt: 0,
                    },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toContain('checking the docs');
    expect(out).toContain('Pick: yes or no');
  });

  it('state-snapshot without fallbackText falls back to prompt', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>here</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: {
                  openCards: [
                    {
                      correlationId: 'cid',
                      prompt: 'Which option?',
                      dataSchemaJson: {},
                      createdAt: 0,
                    },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toContain('Which option?');
  });

  it('deduplicates the same card across multiple state-snapshot events (versioned republishes)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: {
                  openCards: [
                    { correlationId: 'c1', prompt: '', dataSchemaJson: {}, fallbackText: 'Pick A or B', createdAt: 0 },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          // Same card republished (e.g. version bumped for another mutation).
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 2,
                snapshot: {
                  openCards: [
                    { correlationId: 'c1', prompt: '', dataSchemaJson: {}, fallbackText: 'Pick A or B', createdAt: 0 },
                  ],
                },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    // 'Pick A or B' appears only once even though state-snapshot was emitted twice.
    const occurrences = out.split('Pick A or B').length - 1;
    expect(occurrences).toBe(1);
  });

  it('state-snapshot ignored when openCards is empty (resolved-card case)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          [
            'event: state-snapshot',
            'data: ' +
              JSON.stringify({
                runId: 'r',
                version: 1,
                snapshot: { openCards: [] },
              }),
            '',
            '',
          ].join('\n'),
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('OK');
  });

  it('malformed state-snapshot payload is ignored (defensive)', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(JSON.stringify({ turns: [] }), { status: 200 }),
      ),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(
        sseResponse([
          'event: delta\ndata: {"text":"<say>OK</say>"}\n\n',
          'event: state-snapshot\ndata: this-is-not-json\n\n',
          'event: state-snapshot\ndata: {"snapshot": null}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    );
    // No crash; voiceCards stays empty; spoken response unchanged.
    const out = await askOperatorViaSse({ text: 'hi' });
    expect(out).toBe('OK');
  });
});

describe('buildClientTools — reflexive client-tool dispatch', () => {
  const endSession = vi.fn(async () => {});

  beforeEach(() => {
    runCommand.mockClear();
    runQuery.mockClear();
    endSession.mockClear();
    vi.mocked(list).mockClear();
  });

  const tools = () => buildClientTools({ workspace: 'ws-1', tabId: 'tab-9', endSession });

  it('exposes end_conversation, ask_operator, ask_papercup, reflexive commands + queries (dotted ids normalized)', () => {
    expect(Object.keys(tools()).sort()).toEqual([
      'ask_operator',
      'ask_papercup',
      'end_conversation',
      'panel_toggle',
      'status_summary',
    ]);
  });

  it('a reflexive command handler routes to runCommand with the browser ctx and returns JSON', async () => {
    const out = await tools().panel_toggle({ open: true });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toBe('panel.toggle');
    expect(runCommand.mock.calls[0][1]).toEqual({ open: true });
    expect(runCommand.mock.calls[0][2]).toMatchObject({
      agent: 'operator',
      workspace: 'ws-1',
      sessionId: 'tab-9',
    });
    expect(out).toBe(JSON.stringify({ ok: true, ran: 'cmd' }));
  });

  it('a query handler routes to runQuery and returns JSON', async () => {
    const out = await tools().status_summary({});
    expect(runQuery).toHaveBeenCalledTimes(1);
    expect(runQuery.mock.calls[0][0]).toBe('status.summary');
    expect(out).toBe(JSON.stringify({ ok: true, ran: 'query' }));
  });

  it('end_conversation triggers teardown and acks ok', async () => {
    const out = await tools().end_conversation({});
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(out).toBe(JSON.stringify({ ok: true }));
  });

  it('only browser:required commands become client tools (server-side stay webhook tools)', () => {
    tools();
    const cmdCall = vi.mocked(list).mock.calls.find(
      (c) => (c[0] as { kind: string }).kind === 'command',
    );
    expect((cmdCall![0] as { browser?: string[] }).browser).toEqual(['required']);
  });
});

describe('ask_papercup — two-tier voice brain tool (voice-two-tier P-003)', () => {
  const tools = () => buildClientTools({ workspace: 'ws-1', tabId: 'tab-9', endSession: async () => {} });
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  it('returns Papercup’s spoken answer for the question, sent to operator-converse with an abort signal', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ turns: [] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(sseResponse([
        'event: delta\ndata: {"text":"<say>You have two meetings today.</say>"}\n\n',
        'event: done\ndata: {}\n\n',
      ])),
    );
    const out = await tools().ask_papercup({ question: 'what is on my calendar' });
    expect(out).toBe('You have two meetings today.');
    const [historyCall, converseCall] = fetchSpy.mock.calls;
    expect(historyCall[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(converseCall[0]).toBe('/api/agent-mcp/operator-converse');
    expect(converseCall[1].signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(converseCall[1].body as string);
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'what is on my calendar' });
    expect(body.modality).toBe('voice');
  });

  it('speaks the shared failure line when operator-converse refuses', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ turns: [] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('nope', { status: 502 })));
    await expect(tools().ask_papercup({ question: 'hi' })).resolves.toBe(VOICE_BRAIN_FAILURE_LINE);
    expect(warn).toHaveBeenCalledWith('[el-conv:ask_papercup] failed');
  });

  it('asks for the question again instead of calling the brain when it is empty', async () => {
    await expect(tools().ask_papercup({ question: '  ' })).resolves.toBe(VOICE_BRAIN_EMPTY_QUESTION_LINE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[el-conv:ask_papercup] empty-question');
  });

  it('leaves ask_operator’s own fallback line unchanged when operator-converse refuses', async () => {
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(new Response(JSON.stringify({ turns: [] }), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('nope', { status: 502 })));
    await expect(askOperatorViaSse({ text: 'hi' })).resolves.toBe('I had trouble just then — say that again?');
  });
});

describe('two-tier transcript — every voice turn reaches the conversation (voice-two-tier P-005, D-008)', () => {
  const historyOk = () =>
    Promise.resolve(new Response(JSON.stringify({ turns: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => warn.mockRestore());

  /** The turn bodies posted to the conversation, with the conversation id they went to. */
  function postedTurns(): Array<{ conversationId: string; role: string; text: string; source: string; elConvId: unknown }> {
    return fetchSpy.mock.calls
      .filter(([url, init]) => typeof url === 'string' && /\/api\/operator\/conversations\/[^/]+\/turns$/.test(url) && init?.method === 'POST')
      .map(([url, init]) => ({
        conversationId: (url as string).split('/')[4]!,
        ...JSON.parse(init.body as string),
      }));
  }

  it('hands Papercup’s answer to the transcript hook, but never a failure line', async () => {
    const answered: string[] = [];
    const tools = buildClientTools({
      workspace: 'ws-1',
      tabId: 'tab-9',
      endSession: async () => {},
      onBrainAnswer: (say) => answered.push(say),
    });
    fetchSpy.mockImplementationOnce(historyOk);
    fetchSpy.mockImplementationOnce(() =>
      Promise.resolve(sseResponse(['event: delta\ndata: {"text":"<say>Standup is at nine.</say>"}\n\n'])),
    );
    await expect(tools.ask_papercup({ question: 'when is standup' })).resolves.toBe('Standup is at nine.');
    fetchSpy.mockImplementationOnce(historyOk);
    fetchSpy.mockImplementationOnce(() => Promise.resolve(new Response('nope', { status: 502 })));
    await expect(tools.ask_papercup({ question: 'and lunch?' })).resolves.toBe(VOICE_BRAIN_FAILURE_LINE);
    expect(answered).toEqual(['Standup is at nine.']);
  });

  it('routes the user’s words and the front’s replies, ignoring empty or unknown messages', () => {
    const calls: string[] = [];
    const transcript = {
      userSaid: async (t: string) => { calls.push(`user:${t}`); },
      frontSaid: async (t: string) => { calls.push(`front:${t}`); },
      brainAnswered: async () => {},
      noteBrainAnswer: () => {},
    };
    routeVoiceMessageToTranscript(transcript, { message: 'What time is it?', source: 'user' });
    routeVoiceMessageToTranscript(transcript, { message: 'Let me check.', source: 'ai' });
    routeVoiceMessageToTranscript(transcript, { message: '', source: 'user' });
    routeVoiceMessageToTranscript(transcript, { message: 'debug', source: 'system' });
    routeVoiceMessageToTranscript(transcript, { message: 42, source: 'ai' });
    expect(calls).toEqual(['user:What time is it?', 'front:Let me check.']);
  });

  it('writes the user turn, the front reply and the brain answer once each into the pinned conversation', async () => {
    fetchSpy.mockImplementation((url: string) =>
      /\/turns$/.test(url)
        ? Promise.resolve(new Response('{}', { status: 201 }))
        : Promise.reject(new Error(`unexpected fetch: ${url}`)),
    );
    const transcript = createTwoTierTranscript({ conversationId: 'conv-pinned', elConvId: () => 'el-77' });
    routeVoiceMessageToTranscript(transcript, { message: 'Is the build green?', source: 'user' });
    routeVoiceMessageToTranscript(transcript, { message: 'One moment, asking Papercup.', source: 'ai' });
    await transcript.brainAnswered('Yes, the build passed ten minutes ago.');
    routeVoiceMessageToTranscript(transcript, { message: 'Yes, the build passed ten minutes ago.', source: 'ai' });
    await transcript.frontSaid('');
    expect(postedTurns()).toEqual([
      { conversationId: 'conv-pinned', role: 'user', text: 'Is the build green?', source: 'voice_stt', elConvId: 'el-77' },
      { conversationId: 'conv-pinned', role: 'assistant', text: 'One moment, asking Papercup.', source: 'voice_tts', elConvId: 'el-77' },
      { conversationId: 'conv-pinned', role: 'assistant', text: 'Yes, the build passed ten minutes ago.', source: 'voice_tts', elConvId: 'el-77' },
    ]);
  });

  it('drops a turn rather than writing it into another conversation when the pinned one is gone', async () => {
    fetchSpy.mockImplementation((url: string) =>
      /\/turns$/.test(url)
        ? Promise.resolve(new Response('gone', { status: 404 }))
        : Promise.reject(new Error(`unexpected fetch: ${url}`)),
    );
    const transcript = createTwoTierTranscript({ conversationId: 'conv-archived', elConvId: () => null });
    await transcript.userSaid('Hello?');
    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(['/api/operator/conversations/conv-archived/turns']);
  });
});

describe('buildClientToolCatalog — EL agent tool-sync catalog', () => {
  it('normalizes names, applies the description fallback, sets expects_response, excludes server-side commands', () => {
    const catalog = buildClientToolCatalog();
    const byName = Object.fromEntries(catalog.map((c) => [c.name, c]));
    // reflexive command → promptDescription wins
    expect(byName.panel_toggle).toMatchObject({ description: 'Toggle the panel', expects_response: true });
    // query without promptDescription → falls back to description
    expect(byName.status_summary).toMatchObject({ description: 'Status summary', expects_response: true });
    // EL tool names are simple identifiers — no dots or dashes
    for (const c of catalog) expect(c.name).not.toMatch(/[.-]/);
  });
});
