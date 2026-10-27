/**
 * Tests for /run-cancel — cancels every pending card under a runId.
 * Drives via Hono app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CardResponse } from '@papercusp/agent-mcp';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn(), getSessionUserOrDefault: vi.fn(), resolveSessionToken: vi.fn() }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../agent-tools/operator/converse-card', () => ({ findConverseRunCards: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'workspace-cancel' }));
vi.mock('../../operator-conversations', () => ({ getConversationById: vi.fn() }));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser, getSessionUserOrDefault } from '../../auth';
import { getConversationById } from '../../operator-conversations';
import { findConverseRunCards } from '../../agent-tools/operator/converse-card';
import {
  _resetCardCorrelatorForTests,
  _resetStateChannelForTests,
  openRun,
  registerCard,
} from '@papercusp/agent-mcp';
import { _resetCardResponseRateLimitForTests } from '../../card-response-rate-limit';
import { registerRoute } from '../define-route';
import runCancel from '../routes/operator/run-cancel';

const ws = 'workspace-cancel';
const choiceSchema = z.object({ picks: z.array(z.string()).min(1) });
let app: Hono;

function post(body: unknown) {
  return app.request('/api/operator/conversations/c1/run-cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /run-cancel', () => {
  beforeEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUserOrDefault).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1', username: 'alice', display_name: 'Alice', has_password: true,
      workspace_id: ws, capabilities: ['*'],
    });
    vi.mocked(getConversationById).mockReset();
    vi.mocked(findConverseRunCards).mockReset();
    vi.mocked(findConverseRunCards).mockResolvedValue(null);
    vi.mocked(getConversationById).mockImplementation(async (id, workspaceId) =>
      id === 'c1' && workspaceId === ws ? { id, workspaceId } as never : null);
    app = new Hono().basePath('/api');
    registerRoute(app, runCancel);
  });
  afterEach(() => {
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    _resetCardResponseRateLimitForTests();
  });

  it('401 without session', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await post({ runId: 'r1', workspaceId: ws });
    expect(res.status).toBe(401);
  });

  it('400 on invalid body', async () => {
    expect((await post({ runId: '', workspaceId: ws })).status).toBe(400);
  });

  it('awaits cancellation commits before acknowledging the run', async () => {
    openRun({ workspaceId: ws, runId: 'durable-run' });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const commitResponse = vi.fn(async (response: CardResponse) => { await gate; return { accepted: true, response }; });
    const card = registerCard({ workspaceId: ws, runId: 'durable-run',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseRunCards).mockResolvedValue([{ commitResponse,
      info: () => ({ correlationId: card.correlationId, runId: 'durable-run', workspaceId: ws }) }] as never);
    let acknowledged = false;
    let delivered = false;
    void card.result.then(() => { delivered = true; });
    const running = Promise.resolve(post({ runId: 'durable-run', workspaceId: ws })).then(res => { acknowledged = true; return res; });
    await vi.waitFor(() => expect(commitResponse).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    expect(delivered).toBe(false);
    finish();
    expect((await running).status).toBe(200);
    expect(await card.result).toEqual({ action: 'cancel' });
  });

  it('refuses cancellation success when storage has an unknown outcome', async () => {
    openRun({ workspaceId: ws, runId: 'uncertain-run' });
    const commitResponse = vi.fn(async () => { throw new Error('cancel-ack-lost'); });
    const card = registerCard({ workspaceId: ws, runId: 'uncertain-run',
      spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    vi.mocked(findConverseRunCards).mockResolvedValue([{ commitResponse,
      info: () => ({ correlationId: card.correlationId, runId: 'uncertain-run', workspaceId: ws }) }] as never);
    let delivered = false;
    void card.result.then(() => { delivered = true; });
    expect((await post({ runId: 'uncertain-run', workspaceId: ws })).status).toBe(503);
    expect(delivered).toBe(false);
    expect(commitResponse).toHaveBeenCalledOnce();
  });

  it('P010 scoped atomic decisions: the trusted local desktop can cancel without a browser cookie', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue({ id: 'local-owner', username: 'owner',
      display_name: 'Owner', has_password: false });
    openRun({ workspaceId: ws, runId: 'desktop-run' });
    const own = registerCard({ workspaceId: ws, runId: 'desktop-run',
      spec: { prompt: 'desktop choice', dataSchema: choiceSchema } });
    const response = await app.request('http://localhost/api/operator/conversations/c1/run-cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'desktop-run', workspaceId: ws }),
    });
    expect(response.status).toBe(200);
    expect(getConversationById).toHaveBeenCalledWith('c1', ws);
    expect(await own.result).toEqual({ action: 'cancel' });
  });

  it('404 when runId not present in the claimed workspace', async () => {
    const res = await post({ runId: 'unknown-run', workspaceId: ws });
    expect(res.status).toBe(404);
  });

  it('cancels a recovered durable run without a local snapshot or deferred', async () => {
    const commitResponse = vi.fn(async () => ({ accepted: true, response: { action: 'cancel' } }));
    vi.mocked(findConverseRunCards).mockResolvedValue([{ commitResponse,
      info: () => ({ correlationId: 'remote-card', runId: 'remote-child', workspaceId: ws }) }] as never);
    expect((await post({ runId: 'remote-child', workspaceId: ws })).status).toBe(200);
    expect(findConverseRunCards).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws,
      conversationId: 'c1', runId: 'remote-child', authorizeAdditional: expect.any(Function) }));
    expect(commitResponse).toHaveBeenCalledOnce();
  });

  it('refuses durable legacy fallback after a scoped miss and never invokes a revoked responder hook', async () => {
    openRun({ workspaceId: ws, runId: 'guarded-run' });
    const commitResponse = vi.fn(async (response: CardResponse) => ({ accepted: true, response }));
    registerCard({ workspaceId: ws, runId: 'guarded-run', spec: { prompt: 'choose', dataSchema: choiceSchema, commitResponse } });
    expect((await post({ runId: 'guarded-run', workspaceId: ws })).status).toBe(409);
    expect(commitResponse).not.toHaveBeenCalled();
    vi.mocked(findConverseRunCards).mockRejectedValue(new Error('unauthorized'));
    expect((await post({ runId: 'guarded-run', workspaceId: ws })).status).toBe(403);
    expect(commitResponse).not.toHaveBeenCalled();
  });

  it('cancels every pending card under the run; deferreds resolve with action:cancel', async () => {
    openRun({ workspaceId: ws, runId: 'r-multi' });
    const a = registerCard({
      workspaceId: ws, runId: 'r-multi',
      spec: { prompt: 'a', dataSchema: choiceSchema },
    });
    const b = registerCard({
      workspaceId: ws, runId: 'r-multi',
      spec: { prompt: 'b', dataSchema: choiceSchema },
    });
    openRun({ workspaceId: ws, runId: 'r-other' });
    const c = registerCard({
      workspaceId: ws, runId: 'r-other',
      spec: { prompt: 'c', dataSchema: choiceSchema },
    });

    const res = await post({ runId: 'r-multi', workspaceId: ws });
    expect(res.status).toBe(200);
    expect(await a.result).toEqual({ action: 'cancel' });
    expect(await b.result).toEqual({ action: 'cancel' });
    let cResolved = false;
    void c.result.then(() => { cResolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(cResolved).toBe(false);
  });

  it('cross-workspace runId returns 404 (defense-in-depth)', async () => {
    openRun({ workspaceId: ws, runId: 'r-x' });
    registerCard({
      workspaceId: ws, runId: 'r-x',
      spec: { prompt: 'x', dataSchema: choiceSchema },
    });
    const res = await post({ runId: 'r-x', workspaceId: 'other-ws' });
    expect(res.status).toBe(404);
  });

  it('P010 scoped atomic decisions: a caller cannot cancel a foreign run using its real workspace', async () => {
    openRun({ workspaceId: 'foreign-ws', runId: 'foreign-run' });
    const foreign = registerCard({ workspaceId: 'foreign-ws', runId: 'foreign-run',
      spec: { prompt: 'foreign choice', dataSchema: choiceSchema } });
    let resolved = false;
    void foreign.result.then(() => { resolved = true; });
    expect((await post({ runId: 'foreign-run', workspaceId: 'foreign-ws' })).status).toBe(404);
    expect(resolved).toBe(false);

    openRun({ workspaceId: ws, runId: 'own-run' });
    const own = registerCard({ workspaceId: ws, runId: 'own-run',
      spec: { prompt: 'own choice', dataSchema: choiceSchema } });
    expect((await post({ runId: 'own-run', workspaceId: ws })).status).toBe(200);
    expect(await own.result).toEqual({ action: 'cancel' });
    expect(resolved).toBe(false);
  });

  it('P010 scoped atomic decisions: a missing conversation leaves its pending run intact', async () => {
    openRun({ workspaceId: ws, runId: 'own-run' });
    const own = registerCard({ workspaceId: ws, runId: 'own-run',
      spec: { prompt: 'own choice', dataSchema: choiceSchema } });
    let resolved = false;
    void own.result.then(() => { resolved = true; });
    vi.mocked(getConversationById).mockResolvedValueOnce(null);
    expect((await post({ runId: 'own-run', workspaceId: ws })).status).toBe(404);
    expect(getConversationById).toHaveBeenCalledWith('c1', ws);
    expect(resolved).toBe(false);
    expect((await post({ runId: 'own-run', workspaceId: ws })).status).toBe(200);
    expect(await own.result).toEqual({ action: 'cancel' });
  });
});
