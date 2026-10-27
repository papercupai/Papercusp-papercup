import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  row: { id: 'turn-a', tools: [] as Array<Record<string, unknown>>, chat_state: null as unknown },
  unsafe: vi.fn(), authorize: vi.fn(), responder: vi.fn(), findCard: vi.fn(),
  deliver: vi.fn(), conversation: vi.fn(), invalidate: vi.fn(),
}));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: { begin: async (run: (tx: unknown) => unknown) => run({ unsafe: h.unsafe }) } }),
}));
vi.mock('@papercusp/agent-mcp', async original => ({
  ...(await original<typeof import('@papercusp/agent-mcp')>()), deliverCommittedCardResponse: h.deliver,
}));
vi.mock('../session-or-local', () => ({ getSessionUserOrLocalDefaultAuthority: h.responder }));
vi.mock('../../agent-tools/operator/converse-card', () => ({ findConverseCard: h.findCard }));
vi.mock('../../operator-conversations', () => ({ getConversationById: h.conversation }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-a' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: h.invalidate }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn(async () => {}) }));
import { registerRoute } from '../define-route';
import turnAnswer from '../routes/operator/turn-answer';

let app: Hono;
const body = { assistantSeq: 2, toolIndex: 0, picks: [{ option_id: 'a', label: 'Spoofed label' }] };
const commitResponse = vi.fn();
function post(value: unknown = body) {
  return app.request('/api/operator/conversations/conv-a/turn-answer', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
}
function modern(native = false) {
  h.row.tools[0].callId = native ? 'native-a' : 'dispatch-a';
  h.row.chat_state = { schemaVersion: 1, interactionBindings: {
    'card-a': { dispatchCallId: 'dispatch-a', nativeCallId: 'native-a' },
  } };
  h.findCard.mockResolvedValue({ commitResponse,
    info: () => ({ correlationId: 'card-a', runId: 'child-a', workspaceId: 'ws-a' }) });
}
function writes() { return h.unsafe.mock.calls.filter(([query]) => /^\s*(UPDATE|INSERT)\b/.test(query)); }

beforeEach(() => {
  vi.clearAllMocks();
  h.row = { id: 'turn-a', tools: [{ name: 'chat:ask_choice', input: {
    options: [{ id: 'a', label: 'Actual A' }],
  } }], chat_state: null };
  h.authorize.mockResolvedValue(true);
  h.responder.mockResolvedValue({ user: { id: 'u-a', workspace_id: 'ws-a' }, authorize: h.authorize });
  h.conversation.mockResolvedValue({ id: 'conv-a', workspaceId: 'ws-a' });
  h.findCard.mockReset();
  commitResponse.mockReset().mockImplementation(async response => ({ accepted: true, response }));
  h.unsafe.mockImplementation(async (query: string) => {
    if (query.includes('SELECT id, tools')) return [structuredClone(h.row)];
    if (query.includes('MAX(seq)')) return [{ s: 3 }];
    if (query.includes('INSERT')) return [{ id: 'user-a', seq: 3 }];
    return [{ id: 'conv-a' }];
  });
  h.invalidate.mockResolvedValue(undefined);
  app = new Hono().basePath('/api');
  registerRoute(app, turnAnswer);
});

describe('historical turn-answer and durable card recovery', () => {
  it('requires a current responder before reading or writing a turn', async () => {
    h.responder.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
    expect(h.unsafe).not.toHaveBeenCalled();
  });
  it('scopes conversation and locked turn lookup to the responder workspace', async () => {
    expect((await post()).status).toBe(200);
    expect(h.conversation).toHaveBeenCalledWith('conv-a', 'ws-a');
    const lookup = h.unsafe.mock.calls.find(([query]) => query.includes('SELECT id, tools'))!;
    expect(lookup[0]).toContain('workspace_id = $3');
    expect(lookup[1]).toEqual(['conv-a', 2, 'ws-a']);
    expect(h.authorize).toHaveBeenCalledOnce();
  });
  it('rejects a revoked responder inside the transaction before a legacy mutation', async () => {
    h.authorize.mockResolvedValue(false);
    expect((await post()).status).toBe(403);
    expect(writes()).toEqual([]);
  });
  it.each([NaN, 0.5, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid turn positions %s', async value => {
    expect((await post({ ...body, assistantSeq: value })).status).toBe(400);
    expect((await post({ ...body, toolIndex: value })).status).toBe(400);
    expect(writes()).toEqual([]);
  });
  it('preserves the historical unversioned card answer transaction', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, userSeq: 3, userId: 'user-a' });
    expect(writes()).toHaveLength(2);
    expect(h.findCard).not.toHaveBeenCalled();
  });
  it.each([null, 'native'])('recovers exact dispatch/native binding without legacy writes (%s)', async native => {
    modern(!!native);
    expect((await post()).status).toBe(200);
    expect(h.findCard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a',
      conversationId: 'conv-a', correlationId: 'card-a', authorizeAdditional: h.authorize }));
    expect(commitResponse).toHaveBeenCalledWith({ action: 'submit', payload: { picks: ['a'] } },
      { correlationId: 'card-a', runId: 'child-a', workspaceId: 'ws-a' }, 'response');
    expect(writes()).toEqual([]);
    expect(h.deliver).toHaveBeenCalledOnce();
  });
  it('commits decline through the resolver', async () => {
    modern();
    expect((await post({ assistantSeq: 2, toolIndex: 0, declined: true })).status).toBe(200);
    expect(commitResponse.mock.calls[0][0]).toEqual({ action: 'decline' });
    expect(writes()).toEqual([]);
  });
  it('awaits the committed receipt before acknowledging or waking a waiter', async () => {
    modern();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    commitResponse.mockImplementation(async response => { await gate; return { accepted: true, response }; });
    let acknowledged = false;
    const running = Promise.resolve(post()).then(response => { acknowledged = true; return response; });
    await vi.waitFor(() => expect(commitResponse).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(h.deliver).not.toHaveBeenCalled();
    finish();
    expect((await running).status).toBe(200);
    expect(h.deliver).toHaveBeenCalledOnce();
  });
  it.each(['commit-ack-lost', 'unauthorized', 'invalid-answer'])('refuses unsafe recovery: %s', async code => {
    modern();
    commitResponse.mockRejectedValue(new Error(code));
    expect((await post()).status).toBe(code === 'unauthorized' ? 403 : code === 'invalid-answer' ? 400 : 503);
    expect(commitResponse).toHaveBeenCalledOnce();
    expect(h.deliver).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('returns the winning conflict without another write', async () => {
    modern();
    commitResponse.mockResolvedValue({ accepted: false, response: { action: 'decline' } });
    expect((await post()).status).toBe(409);
    expect(commitResponse).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledWith(expect.objectContaining({ response: { action: 'decline' } }));
    expect(writes()).toEqual([]);
  });
  it.each([{}, { schemaVersion: 2 }, { schemaVersion: 1 },
    { schemaVersion: 1, interactionBindings: {} },
    { schemaVersion: 1, interactionBindings: { a: { dispatchCallId: 'unrelated' } } },
  ])('never falls back to legacy mutations for unknown or incomplete durable state: %j', async state => {
    h.row.chat_state = state;
    expect((await post()).status).toBe(503);
    expect(writes()).toEqual([]);
    expect(h.findCard).not.toHaveBeenCalled();
  });
  it('rejects ambiguous bindings and missing recovered cards without a legacy fallback', async () => {
    modern();
    (h.row.chat_state as { interactionBindings: Record<string, unknown> }).interactionBindings['card-b'] = {
      dispatchCallId: 'dispatch-a',
    };
    expect((await post()).status).toBe(503);
    expect(h.findCard).not.toHaveBeenCalled();
    modern();
    h.findCard.mockResolvedValue(null);
    expect((await post()).status).toBe(503);
    expect(writes()).toEqual([]);
  });
});
