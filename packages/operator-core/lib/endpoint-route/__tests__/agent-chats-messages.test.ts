/**
 * Route-level tests for `POST /api/harness/:slug/agent-chats/:chatId/messages`
 * — Phase A2 (endpoint-hono-elimination-2026-05-21). Migrated from the
 * `registerAgentChats` block of `_hono/chat-shim-routes.test.ts` when the
 * agent-chats router moved off Hono onto `defineTool`
 * (`routes/agent-chats/index.ts`).
 *
 * The load-bearing assertion is `closed === true`: the SSE stream must
 * terminate on its own after the turn (the audit-round-10 regression
 * class). Drives the route handler directly with a hand-built
 * `RouteContext`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteContext, RouteDefinition } from '../define-route';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

// WI-3634: the real route (routes/agent-chats/index.ts) resolves this module
// via a DYNAMIC `await import(...)` fired at request-handling time (inside the
// handler body), not a static top-level import. The rest of this file's mocks
// use `vi.doMock` (per-test, order-dependent — safe because each is re-armed
// via resetModules() immediately before the SAME test's dynamic route import),
// but pairing a per-test doMock with a callee-side dynamic import is a known
// Vitest footgun: doMock's guarantee only holds for imports issued strictly
// after it runs in the same module graph, which is fragile against a runtime
// `import()` when this file shares a worker's module cache with a sibling test
// (e.g. messages-spawn-tracking.test.ts, which targets the SAME dynamic import
// and already uses the safer hoisted form below). A missed intercept here falls
// through to the REAL beginChatSpawnTracking, which opens a live org-pool PG
// connection and inserts a real harness_shared.spawned_agents row (the
// occasional-leak symptom this WI reported) instead of the fully-mocked
// vi.fn stub. Hoisting removes the ordering dependency entirely instead of relying
// on per-test re-arming — this mock now always wins regardless of import
// timing or worker-level module-cache sharing.
// WI-7139: grant the PG-backed per-chat streaming lock (agent-chat-lock.ts). It
// fails CLOSED — any PG error reads as "already locked" and the route 409s — so an
// unsatisfied lock turns every assertion here into 409. These tests exercise the
// ROUTE, not the lock (which has its own coverage); mocking the lock also keeps
// them independent of @papercusp/db-org's export surface, which is what broke
// them (a new `getOrgPg` import stranded every db-org mock that did not list it).
vi.mock('../../agent-chat-lock', () => ({
  AGENT_CHAT_LOCK_TTL_MS: 10 * 60_000,
  acquireAgentChatLock: async (chatId: string) => ({ chatId, token: 'test-lock-token' }),
  releaseAgentChatLock: async () => {},
  isAgentChatLocked: async () => false,
  __resetAgentChatLocks: async () => {},
}));

vi.mock('../../fleet/chat-spawn-tracking', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    beginChatSpawnTracking: vi.fn(async () => ({
      spawnId: 'agent_chats-test-spawn',
      finish: vi.fn(async () => {}),
    })),
  };
});

async function drainSse(
  body: ReadableStream<Uint8Array> | null,
  maxMs: number,
): Promise<{ text: string; closed: boolean }> {
  if (!body) return { text: '', closed: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + maxMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { text, closed: false };
      const step = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
      ]);
      if (step === 'timeout') return { text, closed: false };
      if (step.done) return { text, closed: true };
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function* gen(events: Array<Record<string, unknown>>) {
  for (const ev of events) yield ev;
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/harness/x/agent-chats/x/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const MOCKED_MODULES = [
  '../../agent-chat-stream',
  '../../agent-tools',
  '../../workspace-registry',
  '../../memory/injection',
  '../../harness-registry',
  '../../sync-sse',
  '../../operator-notes',
  '@papercusp/orchestrator/role-prompt',
  '../../agent-chats-data',
  '@papercusp/db-org',
];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
});

const SLUG = 'test-harness';
const CHAT = 'CHAT-1';

const baseRow = {
  id: CHAT,
  role: 'worker',
  feature_id: null,
  archived_at: null,
  transcript: [] as unknown[],
  total_cost_usd_cents: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
};

function ctxFor(chatId: string): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: { slug: SLUG, chatId },
    log: () => {},
    signal: new AbortController().signal,
  };
}

/**
 * Set up the mocked deps, register the real agent_chats:chat tool, return
 * the messages-route handler + a capture of the SQL UPDATEs run.
 */
async function agentChatsMessagesHandler(
  chatEvents: Array<Record<string, unknown>>,
  chatRow: Record<string, unknown> | null,
): Promise<{
  handler: (req: Request, chatId: string) => Promise<Response>;
  updates: string[];
  updateArgs: unknown[][];
}> {
  const updates: string[] = [];
  const updateArgs: unknown[][] = [];
  vi.doMock('../../agent-chat-stream', () => ({ runAgentChat: () => gen(chatEvents) }));
  vi.doMock('../../agent-tools', () => ({}));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
  vi.doMock('../../memory/injection', () => ({ buildMemoryContextBlock: vi.fn(async () => null) }));
  vi.doMock('../../harness-registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../harness-registry')>();
    return { ...actual, loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) };
  });
  vi.doMock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
  vi.doMock('../../operator-notes', () => ({ projectDirForSlug: vi.fn(async () => '/tmp/proj') }));
  vi.doMock('@papercusp/orchestrator/role-prompt', () => ({
    assembleRolePrompt: () => ({ text: 'ROLE PROMPT', meta: { runId: 'run-test' } }),
  }));
  vi.doMock('../../agent-chats-data', () => ({
    readFeatureLockState: vi.fn(async () => null),
    rowToChat: (row: Record<string, unknown>) => row,
  }));
  // EI-259 nursery tracking is PG-backed — WI-3634 moved its mock to a
  // hoisted `vi.mock` at the top of this file (see the comment there): a
  // per-test doMock here raced the route's runtime dynamic `import()` of
  // this same module and could occasionally fall through to a LIVE org-pool
  // connection pre-stream (the 2026-06-11 15s-timeout flap under fleet load,
  // and the occasional harness_shared.spawned_agents row leak this WI
  // reported). Its own coverage lives in fleet/chat-spawn-tracking tests.
  vi.doMock('@papercusp/db-org', async (orig) => {
    const actual = await vi.importActual<Record<string, unknown>>('@papercusp/db-org');
    return {
      ...(await orig<typeof import('@papercusp/db-org')>()),
      ...actual,
      // The route reads and writes agent_chats through `harnessQuery(slug, sql =>
      // sql.unsafe(text, params))` — this double is the ONLY thing standing between the
      // route and a live pool. Left real (the `...actual` spread above), harnessQuery hits
      // the PAPERCUSP_FORBID_REAL_PG rail inside the route's own preflight catch and every
      // case here reads 500 "failed to load chat: A UNIT test tried to open a REAL Postgres
      // connection" (gate red on the frozen candidate, WI-212675). Same contract as the
      // legacy double below: the chat SELECT answers `chatRow`, the cost aggregate answers
      // a zero total, and every other statement (the transcript UPDATEs the assertions
      // below count) lands on `updates` / `updateArgs`.
      harnessQuery: async (
        _slug: string,
        fn: (sql: { unsafe: (text: string, params?: unknown[]) => Promise<unknown[]> }) => unknown,
      ) =>
        fn({
          unsafe: async (text: string, params: unknown[] = []) => {
            const q = text.trim();
            if (/^SELECT \* FROM agent_chats/.test(q)) return [chatRow];
            if (/^SELECT COALESCE\(SUM\(/.test(q)) return [{ total: 0 }];
            updates.push(q);
            updateArgs.push(params);
            return [];
          },
        }),
      getLegacyClient: () => ({
        prepare: (sql: string) => ({
          get: async () => (/^SELECT \* FROM agent_chats/.test(sql.trim()) ? chatRow : { total: 0 }),
          run: async (...args: unknown[]) => { updates.push(sql.trim()); updateArgs.push(args); },
        }),
      }),
    };
  });

  await import('../../agent-tools/agent_chats/chat');
  const routes = (await import('../routes/agent-chats/index')).default as RouteDefinition<undefined>[];
  const messages = routes.find(
    (r) => r.method === 'POST' && r.path === '/harness/:slug/agent-chats/:chatId/messages',
  );
  if (!messages) throw new Error('agent-chats messages route not found');
  return {
    handler: (req: Request, chatId: string) => Promise.resolve(messages.handler(req, ctxFor(chatId))),
    updates,
    updateArgs,
  };
}

describe('POST /harness/:slug/agent-chats/:chatId/messages — route handler', () => {
  // Generous budgets on this one: the guard is "the stream CLOSES", not
  // "the stream is fast" — under full-suite parallel load on a busy box the
  // 5s drain + file-level 15s budget flaked while the test passes in ~2s
  // isolated (2026-06-11, twice in consecutive test:affected runs).
  it('streams delta + terminal done and CLOSES the stream (round-10 guard)', async () => {
    const { handler, updates } = await agentChatsMessagesHandler(
      [
        { type: 'delta', text: 'Hi ' },
        { type: 'delta', text: 'there' },
        { type: 'result', tokensIn: 12, tokensOut: 4, costUsd: 0.003, finalText: 'Hi there' },
      ],
      { ...baseRow },
    );
    const res = await handler(postReq({ content: 'hello' }), CHAT);
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 20_000);
    expect(closed, 'agent_chats SSE stream must close after the turn').toBe(true);
    expect(text).toContain('event: delta');
    expect(text).toContain('Hi ');
    expect(text).toContain('event: done');
    // Both the user-turn and assistant-turn UPDATEs must have persisted.
    expect(updates.length).toBe(2);
  }, 45_000);

  it('on a failed turn (rate-limit/backend error): emits SSE error, closes, AND persists a failure-marker turn', async () => {
    // The runner yields a terminal `error` event (e.g. the rate-limited path)
    // instead of a delta/result. The route must surface it AND persist a marker
    // turn so a reload / second viewer sees the failure, not a silent gap.
    const msg = 'anthropic-direct: rate-limited — paused until 2026-06-14T08:50:00.000Z';
    const { handler, updates, updateArgs } = await agentChatsMessagesHandler(
      [{ type: 'error', message: msg }],
      { ...baseRow },
    );
    const res = await handler(postReq({ content: 'what happened?' }), CHAT);
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 20_000);
    expect(closed, 'SSE stream must close after a failed turn').toBe(true);
    expect(text).toContain('event: error');
    expect(text).toContain(msg);
    expect(text).not.toContain('event: done');

    // Two UPDATEs: the user turn, then the failure-marker assistant turn.
    expect(updates.length).toBe(2);
    const markerTranscript = JSON.parse(updateArgs[1][0] as string) as Array<{
      role: string; content: string; error?: boolean;
    }>;
    const last = markerTranscript[markerTranscript.length - 1];
    expect(last).toMatchObject({ role: 'assistant', content: 'That turn did not complete. Try asking again.', error: true });
    expect(last.content).not.toContain(msg);
  }, 45_000);

  it('404s when the chat row does not exist', async () => {
    const { handler } = await agentChatsMessagesHandler([], null);
    const res = await handler(postReq({ content: 'hello' }), 'missing');
    expect(res.status).toBe(404);
  });

  it('400s on empty content', async () => {
    const { handler } = await agentChatsMessagesHandler([], { ...baseRow });
    const res = await handler(postReq({ content: '   ' }), CHAT);
    expect(res.status).toBe(400);
  });
});
