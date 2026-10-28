/**
 * Tests for /card-response — H3 audit + plan §4.9. Drives via Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CardResponse } from '@papercusp/agent-mcp';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn(), resolveSessionToken: vi.fn(async () => 'current') }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../agent-tools/operator/converse-card', () => ({ findConverseCard: vi.fn(async () => null) }));
vi.mock('../../operator-conversations', () => ({ getConversationById: vi.fn() }));
const nativeCards = vi.hoisted(() => ({ route: vi.fn() }));
vi.mock('../../su-session-owner-routing', () => ({ routeSuNativeCard: nativeCards.route }));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser } from '../../auth';
import { getConversationById } from '../../operator-conversations';
import { findConverseCard } from '../../agent-tools/operator/converse-card';
import {
  _resetCardCorrelatorForTests,
  registerCard,
  _resetStateChannelForTests,
  openRun,
} from '@papercusp/agent-mcp';
import { _resetCardResponseRateLimitForTests } from '../../card-response-rate-limit';
import { registerRoute } from '../define-route';
import cardResponse from '../routes/operator/card-response';

const ws = 'workspace-T';
const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });
let app: Hono;

function post(body: unknown) {
  return app.request('/api/operator/conversations/c1/card-response', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/operator/conversations/:id/card-response', () => {
  beforeEach(() => {
    nativeCards.route.mockReset();
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1', username: 'alice', display_name: 'Alice', has_password: true,
      workspace_id: ws, capabilities: ['*'],
    });
    vi.mocked(getConversationById).mockReset();
    vi.mocked(findConverseCard).mockReset();
    vi.mocked(findConverseCard).mockResolvedValue(null);
    vi.mocked(getConversationById).mockImplementation(async (id, workspaceId) =>
      id === 'c1' && workspaceId === ws ? { id, workspaceId } as never : null);
    app = new Hono().basePath('/api');
    registerRoute(app, cardResponse);
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  function legacyPendingCard() {
    openRun({ workspaceId: ws, runId: 'r1' });
    return registerCard({
      workspaceId: ws, runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema },
    });
  }

  function scopedPendingCard(commitResponse = async (response: CardResponse) => ({ accepted: true, response })) {
    openRun({ workspaceId: ws, runId: 'r1' });
    const reg = registerCard({ workspaceId: ws, runId: 'r1',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: reg.correlationId, runId: 'r1', workspaceId: ws }) } as never);
    return reg;
  }

  it('forwards a native private answer under authenticated agent-chat scope without conversation persistence', async () => {
    nativeCards.route.mockResolvedValue({ kind: 'response', ok: true });
    const correlationId = 'su-card.79.1.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const res = await post({ correlationId, workspaceId: ws, action: 'submit', payload: { value: 'PRIVATE_NATIVE' } });
    expect(res.status).toBe(200);
    expect(nativeCards.route).toHaveBeenCalledWith({ workspaceId: ws, agentChatId: 'c1',
      request: { kind: 'response', correlationId, action: 'submit', payload: { value: 'PRIVATE_NATIVE' } } });
    expect(getConversationById).not.toHaveBeenCalled(); expect(findConverseCard).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain('PRIVATE_NATIVE');
  });

  it('rejects foreign native workspace and redacts unknown relay failures without legacy fallback', async () => {
    const correlationId = 'su-card.79.1.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect((await post({ correlationId, workspaceId: 'foreign', action: 'submit', payload: { value: 'PRIVATE' } })).status).toBe(404);
    expect(nativeCards.route).not.toHaveBeenCalled();
    nativeCards.route.mockRejectedValue(new Error('PRIVATE transport error'));
    const res = await post({ correlationId, workspaceId: ws, action: 'submit', payload: { value: 'PRIVATE' } });
    expect(res.status).toBe(503); expect(await res.text()).not.toContain('PRIVATE');
    expect(getConversationById).not.toHaveBeenCalled(); expect(findConverseCard).not.toHaveBeenCalled();
  });

  it('401 when session cookie is missing (H3)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post({ correlationId: 'x', workspaceId: ws, action: 'submit', payload: { picks: ['a'] } });
    expect(res.status).toBe(401);
  });

  it('400 when body shape invalid', async () => {
    const res = await post({ correlationId: '', action: 'submit' });
    expect(res.status).toBe(400);
  });

  it('submit happy-path: commits a conversation-bound card, returns 200', async () => {
    const reg = scopedPendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] },
    });
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('awaits the host decision commit before HTTP success and waiter delivery', async () => {
    openRun({ workspaceId: ws, runId: 'durable-http' });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const commitResponse = vi.fn(async (response: CardResponse) => { await gate; return { accepted: true, response }; });
    const reg = registerCard({ workspaceId: ws, runId: 'durable-http',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: reg.correlationId, runId: 'durable-http', workspaceId: ws }) } as never);
    let acknowledged = false;
    let delivered = false;
    void reg.result.then(() => { delivered = true; });
    const running = Promise.resolve(post({ correlationId: reg.correlationId, workspaceId: ws, action: 'submit', payload: { picks: ['a'] } }))
      .then(res => { acknowledged = true; return res; });
    await vi.waitFor(() => expect(commitResponse).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(delivered).toBe(false);
    finish();
    expect((await running).status).toBe(200);
    expect(await reg.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('refuses HTTP success when the host decision commit is uncertain', async () => {
    openRun({ workspaceId: ws, runId: 'uncertain-http' });
    const commitResponse = vi.fn(async () => { throw new Error('commit-ack-lost'); });
    const reg = registerCard({ workspaceId: ws, runId: 'uncertain-http',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: reg.correlationId, runId: 'uncertain-http', workspaceId: ws }) } as never);
    let delivered = false;
    void reg.result.then(() => { delivered = true; });
    const res = await post({ correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } });
    expect(res.status).toBe(503);
    expect(delivered).toBe(false);
    expect(commitResponse).toHaveBeenCalledOnce();
  });

  it('submit validation failure returns 400 from the scoped card adapter', async () => {
    const reg = scopedPendingCard(async () => { throw new Error('invalid-answer'); });
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: [] },
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: string; details?: unknown };
    expect(j.error).toBe('invalid-answer');
  });

  it('commits a recovered scoped card without a process-local waiter', async () => {
    const commitResponse = vi.fn(async (response: CardResponse) => ({ accepted: true, response }));
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: 'recovered', runId: 'child', workspaceId: ws }) } as never);
    expect((await post({ correlationId: 'recovered', workspaceId: ws, action: 'submit',
      payload: { picks: ['a'] } })).status).toBe(200);
    expect(findConverseCard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws,
      conversationId: 'c1', correlationId: 'recovered', authorizeAdditional: expect.any(Function) }));
    expect(commitResponse).toHaveBeenCalledOnce();
  });

  it('refuses a revoked responder and never falls back to its live durable hook', async () => {
    openRun({ workspaceId: ws, runId: 'revoked' });
    const commitResponse = vi.fn(async (response: CardResponse) => ({ accepted: true, response }));
    const reg = registerCard({ workspaceId: ws, runId: 'revoked',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseCard).mockRejectedValue(new Error('unauthorized'));
    expect((await post({ correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(403);
    expect(commitResponse).not.toHaveBeenCalled();
    vi.mocked(findConverseCard).mockResolvedValue(null);
    expect((await post({ correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(409);
    expect(commitResponse).not.toHaveBeenCalled();
  });

  it('returns conflict for a losing proposal while delivering the committed winner', async () => {
    openRun({ workspaceId: ws, runId: 'winner' });
    const winner = { action: 'submit' as const, payload: { picks: ['b'] } };
    const commitResponse = vi.fn(async () => ({ accepted: false, response: winner }));
    const reg = registerCard({ workspaceId: ws, runId: 'winner',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseCard).mockResolvedValue({ commitResponse,
      info: () => ({ correlationId: reg.correlationId, runId: 'winner', workspaceId: ws }) } as never);
    expect((await post({ correlationId: reg.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(409);
    expect(await reg.result).toEqual(winner);
  });

  it('decline path resolves with action:decline', async () => {
    const reg = scopedPendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: ws,
      action: 'decline', reason: 'nope',
    });
    expect(res.status).toBe(200);
    expect(await reg.result).toEqual({ action: 'decline', reason: 'nope' });
  });

  it('cross-workspace correlationId returns 404 (defense-in-depth)', async () => {
    const reg = legacyPendingCard();
    const res = await post({
      correlationId: reg.correlationId, workspaceId: 'other-ws',
      action: 'submit', payload: { picks: ['a'] },
    });
    expect(res.status).toBe(404);
  });

  it('P010 scoped atomic decisions: a foreign card workspace supplied by the caller grants no authority', async () => {
    openRun({ workspaceId: 'foreign-ws', runId: 'foreign-run' });
    const foreign = registerCard({ workspaceId: 'foreign-ws', runId: 'foreign-run',
      spec: { prompt: 'foreign choice', dataSchema: choiceSchema } });
    let resolved = false;
    void foreign.result.then(() => { resolved = true; });
    const denied = await post({ correlationId: foreign.correlationId, workspaceId: 'foreign-ws',
      action: 'submit', payload: { picks: ['a'] } });
    expect(denied.status).toBe(404);
    expect(resolved).toBe(false);

    const own = scopedPendingCard();
    expect((await post({ correlationId: own.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(200);
    expect(await own.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
    expect(resolved).toBe(false);
  });

  it('P010 scoped atomic decisions: missing or foreign conversation refuses before resolving a card', async () => {
    const own = scopedPendingCard();
    let resolved = false;
    void own.result.then(() => { resolved = true; });
    vi.mocked(getConversationById).mockResolvedValueOnce(null);
    const denied = await post({ correlationId: own.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } });
    expect(denied.status).toBe(404);
    expect(getConversationById).toHaveBeenCalledWith('c1', ws);
    expect(resolved).toBe(false);
    expect((await post({ correlationId: own.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(200);
    expect(await own.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('P010 scoped atomic decisions: failed scope storage never acknowledges or resolves an answer', async () => {
    const own = scopedPendingCard();
    let resolved = false;
    void own.result.then(() => { resolved = true; });
    vi.mocked(getConversationById).mockRejectedValueOnce(new Error('scope-storage-unavailable'));
    expect((await post({ correlationId: own.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(500);
    expect(resolved).toBe(false);
    expect((await post({ correlationId: own.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } })).status).toBe(200);
    expect(await own.result).toEqual({ action: 'submit', payload: { picks: ['a'] } });
  });

  it('rejects a same-workspace legacy card without a durable conversation/run binding', async () => {
    const foreign = legacyPendingCard();
    let resolved = false;
    void foreign.result.then(() => { resolved = true; });
    const res = await post({ correlationId: foreign.correlationId, workspaceId: ws,
      action: 'submit', payload: { picks: ['a'] } });
    expect(res.status).toBe(404);
    expect(resolved).toBe(false);
    expect(findConverseCard).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws,
      conversationId: 'c1', correlationId: foreign.correlationId }));
  });

  it('429 after 30 RPS for the same session user (H3)', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await post({
        correlationId: 'doesntmatter', workspaceId: 'rate-ws', action: 'cancel',
      });
      responses.push(res.status);
    }
    expect(responses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(responses[0]).not.toBe(429);
    expect(responses[31]).toBe(429);
  });

  it('audit: rate limit is per session user, NOT per caller-supplied workspaceId', async () => {
    const responses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await post({
        correlationId: 'x', workspaceId: `attacker-ws-${i}`, action: 'cancel',
      });
      responses.push(res.status);
    }
    expect(responses[31]).toBe(429);
  });

  it('audit: a different session user has its own bucket', async () => {
    for (let i = 0; i < 30; i++) {
      await post({ correlationId: 'x', workspaceId: 'w', action: 'cancel' });
    }
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u2', username: 'bob', display_name: 'Bob', has_password: true,
      workspace_id: ws, capabilities: ['*'],
    });
    const res = await post({ correlationId: 'x', workspaceId: 'w', action: 'cancel' });
    expect(res.status).not.toBe(429);
  });
});
