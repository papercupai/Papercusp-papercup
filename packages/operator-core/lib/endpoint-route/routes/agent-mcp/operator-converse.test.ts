import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('@papercusp/sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/sse')>()),
  sseResponse: vi.fn((opts: { setup: (sink: unknown) => Promise<void> }) => {
    void opts.setup({
      closed: false,
      event: vi.fn(),
      onClose: vi.fn(),
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
  (route as { handler: (req: Request) => Promise<Response> }).handler(
    new Request('http://localhost/api/agent-mcp/operator-converse', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMocks.captured = null;
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
