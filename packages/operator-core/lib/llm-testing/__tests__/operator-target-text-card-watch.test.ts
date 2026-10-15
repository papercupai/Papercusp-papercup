/**
 * WI-5023 regression — TEXT-mode chat:ask_choice observability.
 *
 * Root cause: POST /api/agent-mcp/operator-converse only forwards
 * state-snapshot card events onto its OWN SSE stream when modality==='voice'
 * (a deliberate cross-conversation-isolation choice — see
 * agent-mcp-operator-converse.test.ts). A TEXT-mode scenario whose brain
 * calls chat:ask_choice therefore never observed the card at all: the tool
 * blocked inside ctx.askUser until its own handler timeout, and the judge
 * saw an empty `cards` array (falsely reported as "the question was
 * truncated" — op-S10).
 *
 * Fix: OperatorTarget now also watches the SEPARATE, production
 * GET /operator/state-snapshot channel (same one the real desktop text UI
 * subscribes to) for a TEXT turn, scoped to this turn's own runId (learned
 * from the new `run-meta` event both modalities now receive), and
 * auto-resolves the first card it sees via POST /card-response — mirroring
 * a real user's click instead of riding out the handler's timeout.
 *
 * This test proves BOTH halves without a live server: the card is folded
 * into `result.cards`, and the auto-resolve POST fires — gating the mocked
 * turn's own `done` event — so the turn only completes AFTER the resolve,
 * never by waiting out a timeout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OperatorTarget } from '../targets/operator';

function sseChunk(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A ReadableStream whose controller stays reachable so a test can push
 *  more chunks AFTER the stream has already been handed to a `Response`. */
function controllableSseStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    push: (event: string, data: unknown) => ctrl.enqueue(sseChunk(event, data)),
    end: () => ctrl.close(),
  };
}

const RADIO_CARD = {
  correlationId: 'cid-1',
  prompt: 'What should I focus on next?',
  dataSchemaJson: {},
  presentation: {
    kind: 'radio',
    options: [
      { id: 'opt-a', label: 'Option A' },
      { id: 'opt-b', label: 'Option B' },
    ],
  },
  fallbackText: 'What should I focus on next?\n\nOptions:\n  1. Option A\n  2. Option B',
  createdAt: 0,
};

describe('OperatorTarget — WI-5023 text-mode card observe + auto-resolve', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('observes a chat:ask_choice card via /operator/state-snapshot and auto-resolves it — the turn only finishes AFTER the resolve, not a timeout', async () => {
    const conv = controllableSseStream();
    const snap = controllableSseStream();
    const cardResponseCalls: Array<Record<string, unknown>> = [];
    let stateSnapshotFetched = false;

    // run-meta arrives first, exactly as production now emits it on every
    // modality (agent-mcp/operator-converse.ts).
    conv.push('run-meta', { runId: 'run-abc' });

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/agent-mcp/operator-converse')) {
        return new Response(conv.stream, { status: 200 });
      }
      if (u.includes('/operator/state-snapshot')) {
        stateSnapshotFetched = true;
        // Deliver the card once the watcher has actually connected — proves
        // observability doesn't depend on timing luck.
        queueMicrotask(() => {
          snap.push('snapshot', {
            runId: 'run-abc',
            workspaceId: 'default',
            snapshot: { openCards: [RADIO_CARD] },
          });
        });
        return new Response(snap.stream, { status: 200 });
      }
      if (u.includes('/card-response')) {
        const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        cardResponseCalls.push(parsed);
        // Mirrors production: the brain's ctx.askUser call only returns (and
        // the turn only reaches `done`) once the card is resolved — NEVER
        // before. Gating `done` on this call is what the "does not wait for
        // the handler timeout" assertion below actually proves.
        conv.push('delta', { text: 'Got it, focusing on that.' });
        conv.push('done', { costUsd: 0 });
        conv.end();
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch in WI-5023 regression: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const target = new OperatorTarget({ baseUrl: 'http://127.0.0.1:9999' });
    const session = await target.open({
      runId: 'scenario-run-1',
      workspaceMode: 'real',
      transport: 'http-sse',
    });

    const result = await session.send({
      messages: [{ role: 'user', content: 'What should I focus on next? Give me a few options.' }],
      trigger: 'user_message',
      meta: { modality: 'text' },
    });

    expect(stateSnapshotFetched).toBe(true);

    // The auto-resolve fired, targeting the right card with a real pick —
    // this IS what unblocks the (simulated) handler instead of it riding
    // out its own timeout.
    expect(cardResponseCalls).toHaveLength(1);
    expect(cardResponseCalls[0]).toMatchObject({
      correlationId: 'cid-1',
      action: 'submit',
      payload: { picks: ['opt-a'] },
    });

    // The card was OBSERVED (the op-S10 assert this whole bug broke).
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].kind).toBe('chat:ask_choice');
    expect(result.cards[0].options).toEqual([
      { id: 'opt-a', label: 'Option A' },
      { id: 'opt-b', label: 'Option B' },
    ]);
    expect(result.finishReason).toBe('done');

    await session.close();
  });

  it('VOICE mode never opens the state-snapshot watcher (it already gets cards on the primary stream)', async () => {
    const conv = controllableSseStream();
    conv.push('run-meta', { runId: 'run-voice-1' });
    conv.push('done', { costUsd: 0 });
    conv.end();

    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/agent-mcp/operator-converse')) {
        return new Response(conv.stream, { status: 200 });
      }
      throw new Error(`unexpected fetch for voice mode: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const target = new OperatorTarget({ baseUrl: 'http://127.0.0.1:9999' });
    const session = await target.open({
      runId: 'scenario-run-2',
      workspaceMode: 'real',
      transport: 'http-sse',
    });
    const result = await session.send({
      messages: [{ role: 'user', content: 'hi' }],
      trigger: 'user_message',
      meta: { modality: 'voice' },
    });

    expect(result.finishReason).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(1); // converse only — no state-snapshot watcher opened
    await session.close();
  });

  it('public Papercup forwards its boundary and reads cards only from its own text stream', async () => {
    const conv = controllableSseStream();
    conv.push('run-meta', { runId: 'public-run' });
    conv.push('state-snapshot', { snapshot: { openCards: [RADIO_CARD] } });
    conv.push('done', { costUsd: 0 });
    conv.end();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(conv.stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('PAPERCUSP_LLM_TEST_WORKSPACE', 'owner-default');
    const target = new OperatorTarget({
      baseUrl: 'http://127.0.0.1:9999', role: 'papercup', hostTrust: 'public',
      principalToken: 'public-boundary-test-token', workspaceId: 'public-test-workspace',
      conversationId: 'existing-public-conversation',
    });
    const session = await target.open({ runId: 'public-test', workspaceMode: 'real', transport: 'http-sse' });
    const result = await session.send({ messages: [{ role: 'user', content: 'Where does work run?' }], trigger: 'user_message' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/agent-mcp/operator-converse');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      role: 'papercup', hostTrust: 'public', principalToken: 'public-boundary-test-token',
      conversationId: 'existing-public-conversation', modality: 'text',
    });
    expect(init.headers).toMatchObject({ 'x-papercusp-workspace': 'public-test-workspace' });
    expect(result.cards).toHaveLength(1);
    expect(result.finishReason).toBe('done');
    await session.close();
  });

  it.each(['public', 'owner'] as const)('does not substitute a credential when %s has no public bearer', async (hostTrust) => {
    const conv = controllableSseStream();
    conv.push('done', { costUsd: 0 });
    conv.end();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(conv.stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const target = new OperatorTarget({
      baseUrl: 'http://127.0.0.1:9999', role: 'papercup', hostTrust,
      // Even an accidentally supplied public token must not enter owner turns.
      ...(hostTrust === 'owner' ? { principalToken: 'irrelevant-public-token' } : {}),
    });
    const session = await target.open({ runId: 'boundary-test', workspaceMode: 'real', transport: 'http-sse' });
    await session.send({ messages: [{ role: 'user', content: 'Help me' }], trigger: 'user_message' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.hostTrust).toBe(hostTrust);
    expect(body).not.toHaveProperty('principalToken');
    if (hostTrust === 'public') expect(body).not.toHaveProperty('conversationId');
    else expect(body.conversationId).toBe('boundary-test');
    await session.close();
  });

  it('keeps the existing desktop request free of public boundary fields', async () => {
    const conv = controllableSseStream();
    conv.push('done', { costUsd: 0 });
    conv.end();
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response(conv.stream, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const session = await new OperatorTarget({ baseUrl: 'http://127.0.0.1:9999' }).open({
      runId: 'desktop-test', workspaceMode: 'real', transport: 'http-sse',
    });
    await session.send({ messages: [{ role: 'user', content: 'Hello' }], trigger: 'user_message' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty('hostTrust');
    expect(body).not.toHaveProperty('principalToken');
    expect(body).not.toHaveProperty('role');
    expect(body.conversationId).toBe('desktop-test');
    await session.close();
  });
});
