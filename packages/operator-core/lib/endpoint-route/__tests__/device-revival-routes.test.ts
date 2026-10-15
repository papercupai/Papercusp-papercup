/**
 * Tests for the mobile-apps-revival-redesign device routes
 * (mobile-apps-revival-redesign-2026-06-05 D-002 / D-004 backend):
 *
 *   POST /device/push/register
 *   GET  /device/operator/conversation         (+ /turns, + POST converse)
 *   GET  /device/plans                          (+ /:slug, + item status)
 *   GET  /device/attention
 *
 * Like device-routes.test.ts, this drives the handlers directly with a
 * hand-built RouteContext and mocks every DB-touching service module, so
 * it proves the route wiring (principal mapping, param parsing, response
 * shaping, the work_items-native attention filter) without standing up PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@papercusp/agent-mcp';
import type { RouteContext, RouteDefinition } from '../define-route';
import { harnessScopedCtx } from '../../agent-tools/_harness-scope';

/* ─── Mocks for the DB-touching service modules the routes import ───────
 * All mock fns live in a vi.hoisted() bundle so the (hoisted) vi.mock
 * factories below can reference them without the "cannot access before
 * initialization" hoisting trap. */
const m = vi.hoisted(() => ({
  dispatchProjectedToolStream: vi.fn(async function* (..._args: unknown[]) {}),
  upsertPushToken: vi.fn(async (_o: unknown) => {}),
  getOrCreateActiveConversation: vi.fn(async (_workspaceId?: string) => ({
    id: 'conv-1', workspaceId: 'ws-e4', harnessSlug: null, title: null,
    status: 'active' as const, startedAt: 1, endedAt: null, elConversationIds: [], hasAudio: false,
  })),
  getConversationById: vi.fn(async (id: string, _workspaceId?: string) => id === 'missing' ? null : ({
    id, workspaceId: 'ws-e4', harnessSlug: null, title: null, status: 'active' as const,
    startedAt: 1, endedAt: null, elConversationIds: [], hasAudio: false,
  })),
  listTurnsRecent: vi.fn(async () => ({
    turns: [{ id: 't1', conversationId: 'conv-1', seq: 0, role: 'user', text: 'hi', source: 'text_typed', elConvId: null, audioUrl: null, createdAt: 1, tools: null }],
    hasMoreEarlier: false,
  })),
  appendTurn: vi.fn(async () => ({ id: 't2', conversationId: 'conv-1', seq: 1, role: 'assistant', text: 'yo', source: 'text_typed', elConvId: null, audioUrl: null, createdAt: 2, tools: null })),
  listPlanRows: vi.fn(async (_o: unknown) => [
    {
      workspaceId: 'ws-e4', harnessSlug: 'papercup', planSlug: 'p1', content: '', contentHash: '', version: 1,
      title: 'Plan One', status: 'active', created: null, updated: '2026-06-05', owner: 'avi', supersedes: [], supersededBy: null,
      opStatus: null, opStartedAt: null, opUpdatedAt: null, currentWave: null, opPriority: null, archived: false, isLegacy: false,
      updatedAt: '2026-06-05T00:00:00Z',
      items: [{ id: 'P-001', status: 'todo', text: 'a', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null },
              { id: 'P-002', status: 'done', text: 'b', importance: 'normal', blockedBy: [], decisionRefs: [], phase: null }],
      decisions: [], nowState: 'building', nowNext: 'ship it',
    },
  ]),
  readPlanBySlug: vi.fn(async (slug: string) =>
    slug === 'missing'
      ? null
      : {
          parsed: { frontmatter: { title: 'Plan One' }, now: { state: 's', next: 'n' }, items: [], decisions: [] },
          archived: false,
          row: { planSlug: slug, harnessSlug: 'papercup', title: 'Plan One', status: 'active', owner: 'avi' },
        },
  ),
  listHarnessesFor: vi.fn(async (_ws: string) => [{ slug: 'papercup' }, { slug: 'other-pot' }]),
  harnessExistsInWorkspace: vi.fn(async (_ws: string, harness: string) => ['papercup', 'other-pot'].includes(harness)),
  listWorkItems: vi.fn(async (_f: unknown) => [
    { id: 'WI-1', kind: 'feature', family: 'feature', harness: 'papercup', title: 'needs human feat', summary: '', state: 'needs-human', assignee: null, assignedBy: null, severity: null, parent: null, payload: null, createdAt: '', updatedAt: '' },
    { id: 'WI-2', kind: 'feature', family: 'feature', harness: 'papercup', title: 'running feat', summary: '', state: 'todo', assignee: null, assignedBy: null, severity: null, parent: null, payload: null, createdAt: '', updatedAt: '' },
    { id: 'WI-3', kind: 'bug', family: 'issue', harness: 'papercup', title: 'open bug', summary: '', state: 'open', assignee: null, assignedBy: null, severity: 'major', parent: null, payload: null, createdAt: '', updatedAt: '' },
    { id: 'WI-4', kind: 'task', family: 'issue', harness: 'papercup', title: 'delegated task', summary: '', state: 'open', assignee: 'op', assignedBy: 'op', severity: null, parent: null, payload: null, createdAt: '', updatedAt: '' },
  ]),
  readWorkItemsPageFromStore: vi.fn(),
  withWorkspace: vi.fn(async (_workspace: string, fn: (sql: unknown) => unknown) => fn({})),
  releaseGateTile: vi.fn<typeof import('../../device-monitoring').releaseGateTile>(async () => ({ gate: 'green', deploy: 'current', red: false, checkedAtMs: 1 })),
  releaseGateApplicability: vi.fn<typeof import('../../device-monitoring').releaseGateApplicability>(async () => 'configured'),
  poolTile: vi.fn<typeof import('../../device-monitoring').poolTile>(async () => ({
    exhausted: false, healthyCount: 1, walledCount: 0, totalCount: 1,
    accounts: [{ id: 'test-account', provider: 'openai', available: true, usageWalled: false }],
  })),
  dispatchProjectedTool: vi.fn(async (_tool: unknown, name: string,
    _args: { harness?: string; [key: string]: unknown },
    _ctx: { harnessSlug?: string; workspaceId: string }, _options: Record<string, unknown>) => {
    if (name === 'plans:attention') {
      return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ groups: [{ planSlug: 'p1', items: [{ id: 'attention-1' }] }] }) }] } };
    }
    if (name === 'plans:set-status') {
      return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, newStatus: 'done', itemId: 'P-001' }) }] } };
    }
    return { ok: false, error: { code: 'unknown', message: 'no' } };
  }),
}));

vi.mock('../../device-store', () => ({ upsertPushToken: m.upsertPushToken }));
vi.mock('../../operator-conversations', () => ({
  getOrCreateActiveConversation: m.getOrCreateActiveConversation,
  getConversationById: m.getConversationById,
  listTurnsRecent: m.listTurnsRecent,
  appendTurn: m.appendTurn,
}));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../../voice-prefs', () => ({ loadVoicePrefs: vi.fn(async () => ({ humanFacingRole: 'operator' })) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-e4' }));
vi.mock('../../agent-tools/plans/source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/plans/source')>()),
  listPlanRows: m.listPlanRows,
  listPlanIndexRows: m.listPlanRows,
  listPlanIndexRowsForWorkspace: m.listPlanRows,
  readPlanBySlug: m.readPlanBySlug,
}));
vi.mock('../../device-harnesses', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device-harnesses')>()),
  listHarnessesFor: m.listHarnessesFor,
  harnessExistsInWorkspace: m.harnessExistsInWorkspace,
}));
// GET /device/plans now ALWAYS prepends the operator-home harness to the
// All-Pots fan-out (deduped) — a papercup→papercusp migration fix (plans.ts:75).
// Pin it to a slug already in the listHarnessesFor mock so the Set dedups back to
// the 2 pots (and the dedup itself is exercised). importOriginal-spread keeps the
// module's other exports for any sibling route in the graph.
vi.mock('../../harness/operator-home-harness', async (orig) => ({
  ...(await orig<typeof import('../../harness/operator-home-harness')>()),
  operatorHomeHarnessSlug: () => 'papercup',
}));
vi.mock('../../work-items', () => ({ listWorkItems: m.listWorkItems }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  withWorkspace: m.withWorkspace,
}));
vi.mock('../../sync-resolver/work-items-list-query', async (original) => ({
  ...(await original<typeof import('../../sync-resolver/work-items-list-query')>()),
  readWorkItemsPageFromStore: m.readWorkItemsPageFromStore,
}));
vi.mock('../../device-monitoring', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../device-monitoring')>()),
  releaseGateTile: m.releaseGateTile,
  releaseGateApplicability: m.releaseGateApplicability,
  poolTile: m.poolTile,
}));
// Side-effect tool-registry import in the routes — no-op for the unit test.
vi.mock('../../agent-tools/index', () => ({}));
// Override the in-process dispatch + lookup; keep the rest of agent-mcp real
// (defineTool, sseResponse helpers, types) so the route modules load.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/agent-mcp')>();
  return {
    ...actual,
    dispatchProjectedTool: m.dispatchProjectedTool,
    dispatchProjectedToolStream: m.dispatchProjectedToolStream,
    lookupByMcpName: (name: string) => ({ name }),
  };
});

/* ─── Imports AFTER the mocks (vi.mock is hoisted, so order is cosmetic) ─ */
import devicePush from '../routes/device/push';
import deviceConverse from '../routes/device/operator-converse';
import devicePlans from '../routes/device/plans';
import deviceAttention from '../routes/device/attention';

const MOBILE_PRINCIPAL: Principal = {
  kind: 'device',
  slug: 'device-e4',
  workspaceId: 'ws-e4',
  authMethod: 'jwt',
  trust: 'verified',
  capabilities: new Set(['device:*']),
  label: 'dev@example.com',
};

function ctx(overrides: Partial<RouteContext<any>> = {}): RouteContext<any> {
  return {
    principal: MOBILE_PRINCIPAL,
    input: undefined,
    params: {},
    log: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

function routeByPath(routes: RouteDefinition<any>[], method: string, path: string): RouteDefinition<any> {
  const def = routes.find((r) => r.method === method && r.path === path);
  if (!def) throw new Error(`no ${method} ${path}`);
  return def;
}

beforeEach(() => {
  m.readWorkItemsPageFromStore.mockImplementation(async () => ({
    rows: await m.listWorkItems({}), hasMore: false, nextCursor: null,
  }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  m.readWorkItemsPageFromStore.mockReset();
});

describe('device/push/register', () => {
  it('declares device auth + cors', () => {
    const def = (devicePush as RouteDefinition<never>[])[0];
    expect((def.auth as { kind: string[] }).kind).toContain('device');
    expect(def.cors).toBe(true);
  });

  it('upserts the token scoped to the device principal', async () => {
    const def = routeByPath(devicePush as RouteDefinition<any>[], 'POST', '/device/push/register');
    const res = await def.handler(
      new Request('http://x.test/api/device/push/register', { method: 'POST' }),
      ctx({ input: { platform: 'fcm', token: 'tok-123' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(m.upsertPushToken).toHaveBeenCalledWith({
      deviceId: 'device-e4',
      workspaceId: 'ws-e4',
      platform: 'fcm',
      token: 'tok-123',
    });
  });
});

describe('device/operator/conversation', () => {
  it('all routes declare device auth + cors', () => {
    for (const def of deviceConverse as RouteDefinition<any>[]) {
      expect((def.auth as { kind: string[] }).kind).toContain('device');
      expect(def.cors).toBe(true);
    }
  });

  it('GET conversation returns the active thread + recent turns', async () => {
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'GET', '/device/operator/conversation');
    const res = await def.handler(new Request('http://x.test/api/device/operator/conversation?limit=10'), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversation: { id: string }; turns: unknown[]; hasMoreEarlier: boolean };
    expect(body.conversation.id).toBe('conv-1');
    expect(body.turns).toHaveLength(1);
    expect(body.hasMoreEarlier).toBe(false);
  });

  it('GET conversation/turns requires conversationId', async () => {
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'GET', '/device/operator/conversation/turns');
    const res = await def.handler(new Request('http://x.test/api/device/operator/conversation/turns'), ctx());
    expect(res.status).toBe(400);
  });

  it('GET conversation/turns scopes archived history to the verified device workspace', async () => {
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'GET', '/device/operator/conversation/turns');
    const res = await def.handler(new Request('http://x.test/api/device/operator/conversation/turns?conversationId=archived&beforeSeq=12&limit=5'), ctx());
    expect(res.status).toBe(200);
    expect(m.getConversationById).toHaveBeenCalledWith('archived', 'ws-e4');
    expect(m.listTurnsRecent).toHaveBeenCalledWith({ conversationId: 'archived', beforeSeq: 12, limit: 5 });
  });

  it('GET conversation/turns refuses a conversation outside the paired workspace', async () => {
    m.getConversationById.mockResolvedValueOnce(null);
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'GET', '/device/operator/conversation/turns');
    const res = await def.handler(new Request('http://x.test/api/device/operator/conversation/turns?conversationId=foreign'), ctx());
    expect(res.status).toBe(404);
    expect(m.getConversationById).toHaveBeenCalledWith('foreign', 'ws-e4');
    expect(m.listTurnsRecent).not.toHaveBeenCalled();
  });

  it('GET conversation reads the paired workspace when the desktop workspace differs', async () => {
    let selectedWorkspace: string | undefined;
    m.getOrCreateActiveConversation.mockImplementationOnce(async (workspaceId?: string) => {
      selectedWorkspace = workspaceId ?? 'desktop-home';
      return {
        id: `conv-${selectedWorkspace}`, workspaceId: selectedWorkspace, harnessSlug: null,
        title: null, status: 'active' as const, startedAt: 1, endedAt: null,
        elConversationIds: [], hasAudio: false,
      };
    });
    m.listTurnsRecent.mockImplementationOnce(async () => ({
      turns: selectedWorkspace === 'ws-e4'
        ? ['user', 'assistant'].map((role, seq) => ({
            id: `owned-${seq}`, conversationId: 'conv-ws-e4', seq, role,
            text: `owned ${role}`, source: 'text_typed', elConvId: null,
            audioUrl: null, createdAt: 1, tools: null,
          }))
        : [],
      hasMoreEarlier: false,
    }));
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'GET', '/device/operator/conversation');
    const res = await def.handler(new Request('http://x.test/api/device/operator/conversation', {
      headers: { 'x-papercusp-workspace': 'foreign-header' },
    }), ctx());
    const body = await res.json();
    expect(body.turns).toHaveLength(2);
    expect(body.conversation.workspaceId).toBe('ws-e4');
    expect(m.getOrCreateActiveConversation).toHaveBeenCalledWith('ws-e4');
    expect(m.listTurnsRecent).toHaveBeenCalledWith({ conversationId: 'conv-ws-e4', limit: 50 });
  });

  it('POST converse rejects an empty message', async () => {
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'POST', '/device/operator/converse');
    const res = await def.handler(
      new Request('http://x.test/api/device/operator/converse', {
        method: 'POST',
        body: JSON.stringify({ text: '   ' }),
        headers: { 'content-type': 'application/json' },
      }),
      ctx(),
    );
    expect(res.status).toBe(400);
  });

  it('POST converse persists and dispatches in the verified device workspace', async () => {
    const def = routeByPath(deviceConverse as RouteDefinition<any>[], 'POST', '/device/operator/converse');
    const res = await def.handler(new Request('http://x.test/api/device/operator/converse', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'foreign-header' },
      body: JSON.stringify({ text: 'paired workspace message' }),
    }), ctx({ principal: { ...MOBILE_PRINCIPAL, workspaceId: 'paired-workspace' } }));
    await res.text();
    expect(m.getOrCreateActiveConversation).toHaveBeenCalledWith('paired-workspace');
    expect(m.appendTurn).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv-1', role: 'user', text: 'paired workspace message',
    }));
    expect(m.dispatchProjectedToolStream).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), expect.anything(),
      expect.objectContaining({ workspaceId: 'paired-workspace' }), {},
    );
  });
});

describe('device/plans', () => {
  it('GET /device/plans reads the workspace index once and summarises item counts', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'GET', '/device/plans');
    const res = await def.handler(new Request('http://x.test/api/device/plans'), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: Array<{ slug: string; itemCounts: Record<string, number>; nowNext: string }> };
    expect(m.listPlanRows).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'ws-e4', includeArchived: false, includeInstances: true, heavyFields: true,
    });
    expect(m.listHarnessesFor).not.toHaveBeenCalled();
    expect(body.plans.length).toBe(1);
    expect(body.plans[0].itemCounts).toEqual({ todo: 1, done: 1 });
    expect(body.plans[0].nowNext).toBe('ship it');
  });

  it('GET /device/plans scopes a selected harness to the device workspace', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'GET', '/device/plans');
    const res = await def.handler(new Request('http://x.test/api/device/plans?harness=papercup'), ctx());
    expect(res.status).toBe(200);
    expect(m.harnessExistsInWorkspace).toHaveBeenCalledExactlyOnceWith('ws-e4', 'papercup');
    expect(m.listPlanRows).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'ws-e4', harnessSlug: 'papercup', includeArchived: false, includeInstances: true, heavyFields: true,
    });
  });

  it('GET /device/plans refuses a foreign harness before reading its index', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'GET', '/device/plans');
    const res = await def.handler(new Request('http://x.test/api/device/plans?harness=foreign-pot'), ctx());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'harness_not_in_workspace' });
    expect(m.harnessExistsInWorkspace).toHaveBeenCalledExactlyOnceWith('ws-e4', 'foreign-pot');
    expect(m.listPlanRows).not.toHaveBeenCalled();
  });

  it('GET /device/plans/:slug returns 404 for a missing plan', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'GET', '/device/plans/:slug');
    const res = await def.handler(new Request('http://x.test/api/device/plans/missing'), ctx({ params: { slug: 'missing' } }));
    expect(res.status).toBe(404);
  });

  it('GET /device/plans/:slug returns the parsed structure', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'GET', '/device/plans/:slug');
    const res = await def.handler(new Request('http://x.test/api/device/plans/p1'), ctx({ params: { slug: 'p1' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; now: unknown; items: unknown[] };
    expect(body.slug).toBe('p1');
    expect(body.now).toEqual({ state: 's', next: 'n' });
  });

  it('POST item status dispatches plans:set-status in-process', async () => {
    const def = routeByPath(devicePlans as RouteDefinition<any>[], 'POST', '/device/plans/:slug/items/:itemId/status');
    const res = await def.handler(
      new Request('http://x.test/api/device/plans/p1/items/P-001/status', { method: 'POST' }),
      ctx({ params: { slug: 'p1', itemId: 'P-001' }, input: { status: 'done' } }),
    );
    expect(res.status).toBe(200);
    expect(m.dispatchProjectedTool).toHaveBeenCalledWith(
      expect.anything(),
      'plans:set-status',
      expect.objectContaining({ slug: 'p1', item: 'P-001', status: 'done' }),
      expect.anything(),
      {},
    );
    expect((await res.json()) as { newStatus: string }).toMatchObject({ newStatus: 'done' });
  });
});

describe('device/attention', () => {
  it('does not count an empty pagination metadata carrier as actionable attention', async () => {
    m.dispatchProjectedTool.mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({
      groups: [{ items: [], _meta: { total: 0, returned: 0, hasMore: false, nextOffset: null } }],
    }) }] } });
    m.readWorkItemsPageFromStore.mockResolvedValueOnce({ rows: [], hasMore: false, nextCursor: null });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: [], workItems: [], systemAlerts: [], counts: { groups: 0, workItems: 0, systemAlerts: 0 },
    });
  });

  it('retains real content after empty metadata carriers across canonical pages', async () => {
    const items = [{ id: 'first' }, { id: 'second' }];
    m.dispatchProjectedTool
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ groups: [
        { items: [], _meta: { total: 2, returned: 1, hasMore: true, nextOffset: 1 } },
        { key: 'p1', planSlug: 'p1', items: items.slice(0, 1) },
      ] }) }] } })
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ groups: [
        { items: [], _meta: { total: 2, returned: 1, hasMore: false, nextOffset: null } },
        { key: 'p1', planSlug: 'p1', items: items.slice(1) },
      ] }) }] } });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).groups).toEqual([{ key: 'p1', planSlug: 'p1', items }]);
    expect(m.dispatchProjectedTool.mock.calls[1]?.[2]).toEqual({ limit: 100, offset: 1, payloadTier: 'full' });
  });

  it('satisfies the real canonical harness gate while preserving the paired workspace', async () => {
    // The prior permissive dispatch mock hid the live harness_required 503.
    // Exercise the exact resolver used by plans:attention, before any source
    // can fabricate a successful empty feed.
    expect(() => harnessScopedCtx(undefined, {})).toThrow();
    m.dispatchProjectedTool.mockImplementationOnce(async (_tool, name, args, toolCtx) => {
      expect(name).toBe('plans:attention');
      const scoped = harnessScopedCtx(args.harness, toolCtx);
      expect(scoped).toMatchObject({ harnessSlug: 'papercup', workspaceId: 'ws-e4' });
      return { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({
        groups: [{ planSlug: 'scope-guard', items: [{ id: 'real-scope-item' }] }],
      }) }] } };
    });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).groups[0].items).toEqual([{ id: 'real-scope-item' }]);
  });

  it('retains a failed canonical dispatch cause without reporting an empty healthy inbox', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.dispatchProjectedTool.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_input', message: 'invalid page' } });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'attention_unavailable' });
    expect(warning).toHaveBeenCalledWith('[device/attention] unavailable:', 'canonical_dispatch_failed', { code: 'invalid_input' });
    expect(m.readWorkItemsPageFromStore).not.toHaveBeenCalled();
  });

  it('keeps older actionable work beyond 200 recent non-attention rows and drains source pages', async () => {
    const recent = Array.from({ length: 200 }, (_, i) => ({
      id: `recent-${i}`, kind: 'task', family: 'issue', state: 'open', title: 'Delegated task',
    }));
    const actionable = Array.from({ length: 203 }, (_, i) => ({
      id: `action-${i}`, kind: 'bug', family: 'issue', state: 'open', title: 'Needs triage',
      harness: 'papercup', summary: 'Keep the existing mobile description',
    }));
    const cursor1 = JSON.stringify({ updatedTs: 2, id: 'recent-199' });
    const cursor2 = JSON.stringify({ updatedTs: 1, id: 'action-199' });
    m.readWorkItemsPageFromStore
      .mockResolvedValueOnce({ rows: recent, hasMore: true, nextCursor: cursor1 })
      .mockResolvedValueOnce({ rows: actionable.slice(0, 200), hasMore: true, nextCursor: cursor2 })
      .mockResolvedValueOnce({ rows: actionable.slice(200), hasMore: false, nextCursor: null });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workItems.map((w: { id: string }) => w.id)).toEqual(actionable.map(w => w.id));
    expect(body.counts.workItems).toBe(203);
    expect(m.withWorkspace).toHaveBeenCalledWith('ws-e4', expect.any(Function));
    expect(m.readWorkItemsPageFromStore).toHaveBeenCalledTimes(3);
    expect(m.readWorkItemsPageFromStore.mock.calls[1]?.[2].args.cursor).toEqual(JSON.parse(cursor1));
    expect(m.readWorkItemsPageFromStore.mock.calls[0]?.[2].args).toMatchObject({
      harnessSlugs: ['other-pot', 'papercup'], limit: 200,
      filters: { states: ['blocked', 'failing', 'needs-human', 'open'] },
    });
    expect(body.workItems[202]).toMatchObject({ harness: 'papercup', summary: 'Keep the existing mobile description' });
  });

  it('drains canonical group pages and merges a group split at the default page boundary', async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ id: `attention-${i}` }));
    m.dispatchProjectedTool
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ groups: [{
        key: 'p1', planSlug: 'p1', items: items.slice(0, 100),
        _meta: { total: 101, returned: 100, hasMore: true, nextOffset: 100 },
      }] }) }] } })
      .mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ groups: [{
        key: 'p1', planSlug: 'p1', items: items.slice(100),
        _meta: { total: 101, returned: 1, hasMore: false, nextOffset: null },
      }] }) }] } });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toEqual([{ key: 'p1', planSlug: 'p1', items }]);
    expect(body.counts.groups).toBe(1);
    expect(m.dispatchProjectedTool.mock.calls[1]?.[2]).toEqual({ limit: 100, offset: 100, payloadTier: 'full' });
  });

  it('returns unavailable when a source cannot continue its incomplete work-item page', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.readWorkItemsPageFromStore.mockResolvedValueOnce({ rows: [{ kind: 'bug', family: 'issue', state: 'open' }], hasMore: true, nextCursor: null });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'attention_unavailable' });
    expect(warning).toHaveBeenCalledWith('[device/attention] work-item pages failed:', 'Incomplete work-item attention page');
  });

  it.each([
    [{ groups: [], _projection: { truncated: true } }, 'canonical_page_unavailable'],
    [{ groups: [{ items: [], _meta: { total: 1, returned: 0, hasMore: false } }] }, 'canonical_total_mismatch'],
    [{ groups: [{ items: [], _meta: { total: 0, returned: 1, hasMore: false } }] }, 'canonical_returned_mismatch'],
    [{ groups: [{ items: [], _meta: { total: 1, returned: 0, hasMore: true, nextOffset: 1 } }] }, 'canonical_page_cannot_advance'],
    [{ groups: [{ items: [{ id: 'a' }], _meta: { total: 2, returned: 1, hasMore: true, nextOffset: 0 } }] }, 'canonical_page_cannot_advance'],
  ])('returns unavailable for a truncated or inconsistent canonical group page %#', async (page, reason) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.dispatchProjectedTool.mockResolvedValueOnce({ ok: true, result: { content: [{ type: 'text', text: JSON.stringify(page) }] } });
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'attention_unavailable' });
    expect(warning).toHaveBeenCalledWith('[device/attention] unavailable:', reason, expect.any(Object));
  });

  it('declares device auth + cors', () => {
    const def = (deviceAttention as RouteDefinition<any>[])[0];
    expect((def.auth as { kind: string[] }).kind).toContain('device');
    expect(def.cors).toBe(true);
  });

  it('returns canonical groups + work_items-native attention items', async () => {
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: unknown[];
      workItems: Array<{ id: string }>;
      systemAlerts: unknown[];
      counts: { groups: number; workItems: number; systemAlerts: number };
    };
    expect(body.groups).toHaveLength(1);
    // WI-1 (needs-human feature) + WI-3 (open bug) qualify; WI-2 (todo) and
    // WI-4 (delegated task) are filtered out.
    expect(body.workItems.map((w) => w.id).sort()).toEqual(['WI-1', 'WI-3']);
    // Explicitly measured healthy snapshots produce an empty alert section.
    expect(body.systemAlerts).toEqual([]);
    expect(body.counts).toEqual({ groups: 1, workItems: 2, systemAlerts: 0 });
  });

  it.each(['releaseGateTile', 'poolTile'] as const)('returns unavailable when %s is unmeasured', async (source) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m[source].mockResolvedValueOnce(null);
    const def = routeByPath(deviceAttention as RouteDefinition<any>[], 'GET', '/device/attention');
    const res = await def.handler(new Request('http://x.test/api/device/attention'), ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'attention_unavailable' });
    expect(warning).toHaveBeenCalledWith('[device/attention] unavailable:', 'system_source_unmeasured', {
      gateMeasured: source !== 'releaseGateTile', poolMeasured: source !== 'poolTile',
    });
  });
});
