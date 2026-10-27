import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../operator-conversations', () => ({
  getConversationById: vi.fn(async (id: string) => ({ id, workspaceId: 'default' })),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'active-conversation', workspaceId: 'default' })),
}));

const budgetMocks = vi.hoisted(() => ({
  checkBudget: vi.fn(),
  shouldBypassOperatorBudget: vi.fn((uiClientId?: string | null) =>
    typeof uiClientId === 'string' && uiClientId.startsWith('llm-testing/')),
}));

const dispatchMocks = vi.hoisted(() => ({
  dispatch: vi.fn(async function* (_tool: unknown, _name: unknown, _args: unknown, ctx: Record<string, unknown>) {
    dispatchMocks.captured = ctx;
  }),
  captured: null as Record<string, unknown> | null,
  done: vi.fn(),
  event: vi.fn(),
  closeCallbacks: [] as Array<() => void>,
}));
const recoveryMocks = vi.hoisted(() => ({ find: vi.fn(), responder: vi.fn() }));
// Recovery obtains the existing SQL handle before handing it to the lookup.
// Keep this route fixture independent of the host database configuration.
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../../agent-tools/operator/converse-turn', () => ({ findConverseTurn: recoveryMocks.find }));
vi.mock('../../session-or-local', () => ({ getSessionUserOrLocalDefaultAuthority: recoveryMocks.responder }));
vi.mock('../../../auth', () => ({ getSessionUserOrDefault: vi.fn(async () => null) }));

vi.mock('@papercusp/sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sse')>()),
  sseResponse: vi.fn((opts: { setup: (sink: unknown) => Promise<void> }) => {
    void opts.setup({
      closed: false,
      event: dispatchMocks.event,
      onClose: (callback: () => void) => { dispatchMocks.closeCallbacks.push(callback); },
      close: vi.fn(),
      done: dispatchMocks.done,
    });
    return new Response('stream-started', { status: 200 });
  }),
}));

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (def: unknown) => def,
  dispatchProjectedToolStream: dispatchMocks.dispatch,
  emitToSseSink: vi.fn(),
  lookupByMcpName: vi.fn(() => ({ name: 'operator:converse' })),
  subscribeWorkspace: vi.fn(() => () => {}),
}));

vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('../../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
}));
vi.mock('../../../operator-budget', () => ({
  checkBudget: budgetMocks.checkBudget,
  shouldBypassOperatorBudget: budgetMocks.shouldBypassOperatorBudget,
}));

import { sseResponse } from '@papercusp/sse';
import route from './operator-converse';

const handler = (body: unknown) =>
  (route as unknown as { handler: (req: Request) => Promise<Response> }).handler(
    new Request('http://localhost/api/agent-mcp/operator-converse', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMocks.dispatch.mockReset();
  dispatchMocks.dispatch.mockImplementation(async function* (_tool, _name, _args, ctx) {
    dispatchMocks.captured = ctx;
  });
  dispatchMocks.captured = null;
  dispatchMocks.closeCallbacks = [];
  recoveryMocks.responder.mockResolvedValue({ user: { id: 'owner', workspace_id: 'default' }, authorize: async () => true });
  recoveryMocks.find.mockReset();
  budgetMocks.checkBudget.mockResolvedValue({
    state: { dailyCapUsd: 5, spend: [] },
    exceeded: true,
    todaySpendUsd: 5.5,
    capUsd: 5,
  } as never);
});

describe('operator-converse route watchdog (EI-110)', () => {
  it('disables the fixed-budget watchdog so a PG-contention-slowed pre-flight never false-408s the stream', () => {
    // route-stack clears the watchdog timer the instant the (synchronous) SSE
    // Response comes back — it never bounds the stream itself, only pre-flight
    // (json/budget/auth). A finite timeoutSec just moves the false-408 to a
    // worse contention storm; `null` (matching every sibling SSE route) is the
    // structural fix. Regression guard for reverting to a magic number.
    expect((route as { timeoutSec?: number | null }).timeoutSec).toBeNull();
  });
});

describe('operator-converse isolated tutorial transport', () => {
  const identity = { conversationId: '11111111-1111-4111-8111-111111111111', turnId: '22222222-2222-4222-8222-222222222222' };
  it('P010 versioned disconnect detaches while legacy0 disconnect still cancels its producer', async () => {
    await handler({ chatProtocolVersion: 1, uiClientId: 'llm-testing/detach', messages: [] });
    await vi.waitFor(() => expect(dispatchMocks.captured).not.toBeNull());
    for (const close of dispatchMocks.closeCallbacks) close();
    expect((dispatchMocks.captured!.signal as AbortSignal).aborted).toBe(false);
    dispatchMocks.closeCallbacks = [];
    await handler({ uiClientId: 'llm-testing/legacy', messages: [] });
    for (const close of dispatchMocks.closeCallbacks) close();
    expect((dispatchMocks.captured!.signal as AbortSignal).aborted).toBe(true);
  });

  it('P010 reconnect subscribes to committed replay without budget admission or another provider launch', async () => {
    const event = { schemaVersion: 1, ...identity, eventId: 'event-one', sequence: 1, event: { type: 'delta', text: 'Saved' } };
    const stop = vi.fn();
    recoveryMocks.find.mockResolvedValue({ identity, receipt: { ...identity, seq: 4 },
      recovery: { replay: vi.fn(async () => ({ ok: true, value: [event] })) },
      watch: vi.fn(async onChange => { await onChange({ state: { phase: 'completed' } }); return { stop }; }) });
    expect((await handler({ chatProtocolVersion: 1, operation: 'reconnect', ...identity, afterSequence: 0 })).status).toBe(200);
    await vi.waitFor(() => expect(dispatchMocks.done).toHaveBeenCalledWith({ persistedTurn: { ...identity, seq: 4 }, phase: 'completed' }));
    expect(dispatchMocks.event).toHaveBeenCalledWith('chat-event', event);
    expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
    expect(budgetMocks.checkBudget).not.toHaveBeenCalled();
    for (const close of dispatchMocks.closeCallbacks) close();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('P010 explicit cancellation returns only the committed cancellation state', async () => {
    const state = { ...identity, phase: 'cancelled' };
    const cancel = vi.fn(async () => ({ ok: true, value: { state } }));
    recoveryMocks.find.mockResolvedValue({ identity, recovery: { cancel } });
    const response = await handler({ chatProtocolVersion: 1, operation: 'cancel', ...identity });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(identity);
    expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
  });

  it('P010 real HTTP reconnect detaches, resumes the exact cursor and acknowledges explicit cancellation after commit', async () => {
    const { serve } = await import('@hono/node-server');
    const actual = await vi.importActual<typeof import('@papercusp/sse')>('@papercusp/sse');
    const mockedSse = vi.mocked(sseResponse).getMockImplementation()!;
    vi.mocked(sseResponse).mockImplementation(actual.sseResponse);
    const events = [{ schemaVersion: 1, ...identity, eventId: 'one', sequence: 1,
      event: { type: 'delta', text: 'First' } }];
    let phase = 'running';
    const subscribers = new Set<(checkpoint: { state: { phase: string } }) => Promise<void>>();
    const stops = vi.fn();
    let commit!: () => void;
    const committed = new Promise<void>(resolve => { commit = resolve; });
    const replay = vi.fn(async (_turn, after: number) => ({ ok: true, value: events.filter(event => event.sequence > after) }));
    const cancel = vi.fn(async () => {
      await committed;
      phase = 'cancelled';
      await Promise.all([...subscribers].map(change => change({ state: { phase } })));
      return { ok: true, value: { state: { ...identity, phase } } };
    });
    recoveryMocks.find.mockResolvedValue({ identity, receipt: { ...identity, seq: 4 }, recovery: { replay, cancel },
      watch: async (change: (checkpoint: { state: { phase: string } }) => Promise<void>) => {
        subscribers.add(change);
        await change({ state: { phase } });
        return { stop: () => { subscribers.delete(change); stops(); } };
      } });
    const server = serve({ fetch: req => (route as unknown as { handler(req: Request): Promise<Response> }).handler(req),
      hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    const controls: AbortController[] = [];
    const post = (body: object) => {
      const controller = new AbortController(); controls.push(controller);
      return fetch(origin, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatProtocolVersion: 1, ...identity, ...body }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    };
    const readThrough = async (reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) => {
      let text = '';
      while (!text.includes(marker)) {
        const frame = await reader.read();
        if (frame.done) throw new Error(`stream closed before ${marker}`);
        text += new TextDecoder().decode(frame.value);
      }
      return text;
    };
    try {
      const first = await post({ operation: 'reconnect', afterSequence: 0 });
      expect(first.status).toBe(200);
      const firstReader = first.body!.getReader();
      expect(await readThrough(firstReader, 'First')).toContain('event: chat-event');
      controls[0].abort();
      await firstReader.cancel().catch(() => {});
      await vi.waitFor(() => expect(subscribers.size).toBe(0));
      expect(phase).toBe('running'); expect(cancel).not.toHaveBeenCalled();

      events.push({ ...events[0], eventId: 'two', sequence: 2, event: { type: 'delta', text: 'Second' } });
      const second = await post({ operation: 'reconnect', afterSequence: 1 });
      const reader = second.body!.getReader();
      const resumed = await readThrough(reader, 'Second');
      expect(resumed).not.toContain('First');
      expect(replay).toHaveBeenCalledWith(identity, 1);
      let acknowledged = false;
      const cancelling = post({ operation: 'cancel' }).then(async response => {
        const body = await response.json(); acknowledged = true; return { status: response.status, body };
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(acknowledged).toBe(false); expect(phase).toBe('running');
      commit();
      expect(await cancelling).toEqual({ status: 200, body: { ok: true, state: { ...identity, phase: 'cancelled' } } });
      expect(await readThrough(reader, 'event: done')).toContain('cancelled');
      await reader.cancel();
      await vi.waitFor(() => expect(subscribers.size).toBe(0));
      expect(stops).toHaveBeenCalledTimes(2);
      recoveryMocks.responder.mockResolvedValueOnce(null);
      expect((await post({ operation: 'reconnect' })).status).toBe(401);
      expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
      expect(budgetMocks.checkBudget).not.toHaveBeenCalled();
    } finally {
      commit(); controls.forEach(controller => controller.abort());
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      vi.mocked(sseResponse).mockImplementation(mockedSse);
    }
  });

  it.each([
    { operation: 'cancel' }, { chatProtocolVersion: 2 }, { chatProtocolVersion: 1, turnId: 'unowned' },
    { chatProtocolVersion: 1, operation: 'reconnect', ...identity, afterSequence: -1 },
    { chatProtocolVersion: 1, operation: 'reconnect', ...identity, messages: [] },
  ])('P010 rejects invalid recovery controls without dispatch %j', async body => {
    expect((await handler(body)).status).toBe(400);
    expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
    expect(recoveryMocks.find).not.toHaveBeenCalled();
  });

  it('P010 recovery denies an expired responder and reports expired replay without launching a replacement', async () => {
    recoveryMocks.responder.mockResolvedValueOnce(null);
    expect((await handler({ chatProtocolVersion: 1, operation: 'reconnect', ...identity })).status).toBe(401);
    recoveryMocks.find.mockResolvedValue({ identity, recovery: { replay: async () => ({ ok: false, code: 'replay-expired' }) } });
    const expired = await handler({ chatProtocolVersion: 1, operation: 'reconnect', ...identity });
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: 'replay-expired' });
    expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
  });

  it('P010 forwards the committed assistant receipt and supplies the current scoped conversation on first owner use', async () => {
    const persistedTurn = { conversationId: 'active-conversation', turnId: 'admitted-turn', seq: 4 };
    dispatchMocks.dispatch.mockImplementationOnce(async function* () {
      yield { kind: 'done', result: { content: [{ type: 'text', text: JSON.stringify({ assembled: '<say>Saved</say>', persistedTurn }) }] } } as never;
    });
    const response = await handler({ uiClientId: 'llm-testing/receipt', messages: [] });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatchMocks.done).toHaveBeenCalledWith({ costUsd: 0, persistedTurn }));
    expect(dispatchMocks.dispatch.mock.calls[0][2]).toMatchObject({ conversationId: 'active-conversation' });
  });
  it.each([
    { hostTrust: 'owner' }, { principalToken: 'borrowed' }, { conversationId: 'private' },
    { role: 'papercup' }, { lessonContext: { version: 3, step: 'billing', transcript: 'private' } },
  ])('rejects lesson authority or context expansion before dispatch %j', async extra => {
    const response = await handler({ hostTrust: 'public', lessonContext: { version: 3, step: 'billing', status: 'ready' }, ...extra });
    expect(response.status).toBe(400);
    expect(dispatchMocks.dispatch).not.toHaveBeenCalled();
  });

  it('forwards the validated lesson into the tool-less brain seam', async () => {
    dispatchMocks.dispatch.mockImplementationOnce(async function* () {
      yield { kind: 'done', result: { content: [{ type: 'text', text: JSON.stringify({ assembled: 'Your provider bills infrastructure.', totalCost: 0.01 }) }] } } as never;
    });
    const context = { version: 3, step: 'billing', status: 'ready' };
    const response = await handler({ hostTrust: 'public', role: 'operator', lessonContext: context,
      uiClientId: 'llm-testing/tutorial-transport', messages: [{ role: 'user', content: 'Who charges cloud resources?' }] });
    expect(response.status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dispatchMocks.dispatch.mock.calls[0][2]).toMatchObject({ hostTrust: 'public', lessonContext: context, sessionUser: null });
    expect(dispatchMocks.done).toHaveBeenCalledWith({ costUsd: 0.01, answer: 'Your provider bills infrastructure.' });
  });
});

describe('operator-converse route budget preflight', () => {
  it('keeps the owner-facing daily budget gate for normal clients', async () => {
    const res = await handler({ messages: [], uiClientId: 'desktop-client' });
    expect(res.status).toBe(402);
    expect(await res.text()).toContain('Papercup daily budget reached');
    expect(budgetMocks.shouldBypassOperatorBudget).toHaveBeenCalledWith('desktop-client');
    expect(budgetMocks.checkBudget).toHaveBeenCalledTimes(1);
    expect(sseResponse).not.toHaveBeenCalled();
  });

  it('lets LLM scenario runs bypass the owner-facing daily budget gate', async () => {
    const res = await handler({
      messages: [],
      uiClientId: 'llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('stream-started');
    expect(budgetMocks.shouldBypassOperatorBudget).toHaveBeenCalledWith('llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(budgetMocks.checkBudget).not.toHaveBeenCalled();
    expect(sseResponse).toHaveBeenCalledTimes(1);
  });

  it('marks the in-process chat context as an interactive-card responder', async () => {
    const res = await handler({
      messages: [],
      uiClientId: 'llm-testing/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatchMocks.captured?.interactiveCardCapability).toBe(true);
  });
});
