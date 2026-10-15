import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  known: new Set(['su-selected', 'su-control']) as Set<string> | null,
  read: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('./proxy-host-extras', () => ({ ADMIN_PROXY_HOST_EXTRAS: {} }));
vi.mock('../../../agent-tools/coordination/recipient-resolve', () => ({
  knownOwnerIdSet: (workspace: string) => { fixture.read(workspace); return Promise.resolve(fixture.known); },
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ambient-workspace' }));
vi.mock('@papercusp/agent-mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/agent-mcp')>(),
  handleHttpToolRequest: (...args: unknown[]) => fixture.dispatch(...args),
}));
import routes from './coord';
import { buildHttpSpawnContext } from '@papercusp/agent-mcp';
import { currentRequestWorkspaceId } from '../../../workspace-als';

beforeEach(() => {
  fixture.known = new Set(['su-selected', 'su-control']);
  fixture.read.mockClear();
  fixture.dispatch.mockReset().mockImplementation(async request => {
    // Exercise the real projection's header-over-query precedence and the
    // ambient scope inside dispatch; a canned 200 misses workspace drift.
    expect(buildHttpSpawnContext(request).workspaceId).toBe('authorized-workspace');
    expect(currentRequestWorkspaceId()).toBe('authorized-workspace');
    return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({
    ok: true, results: [{ ok: true, to: ['su-selected'], msg_id: 'private-receipt', wake: { queued: 1, pickupConfirmed: false } }],
    counts: { total: 1, ok: 1, failed: 0 },
    }) }] } };
  });
});

const send = (to: unknown, wake = false) => routes[0].handler(new Request('http://127.0.0.1/api/admin/coord/send?workspace=forged-query', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'forged-workspace' },
  body: JSON.stringify({ to, summary: 'private canary', body: [{ text: 'private canary' }], expects: 'none', ...(wake ? { wake: 'required' } : {}) }),
}), { params: { verb: 'send' }, principal: { workspaceId: 'authorized-workspace' } } as never) as Promise<Response>;

describe('GUI coordination roster boundary', () => {
  it.each([false, true])('dispatches exactly the authorized selection, preserving its receipt (wake=%s)', async wake => {
    const response = await send(['su-selected'], wake);
    expect(response.status).toBe(200);
    expect(fixture.read).toHaveBeenCalledWith('authorized-workspace');
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0][0].body).toMatchObject({ to: ['su-selected'], body: [{ text: 'private canary' }] });
    await expect(response.json()).resolves.toMatchObject({ results: [{ to: ['su-selected'], msg_id: 'private-receipt', wake: { queued: 1, pickupConfirmed: false } }] });
  });
  it.each(['resolve', 'ack', 'message-agent', 'wake-mode'])('keeps the admitted workspace for %s dispatch too', async verb => {
    const response = await routes[0].handler(new Request(`http://127.0.0.1/api/admin/coord/${verb}?workspace=forged-query`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-papercusp-workspace': 'forged-workspace' },
      body: JSON.stringify({ msg_id: 'private-receipt' }),
    }), { params: { verb }, principal: { workspaceId: 'authorized-workspace' } } as never) as Response;
    expect(response.status).toBe(200);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('refuses foreign or stale concrete identities before any dispatch (wake=%s)', async wake => {
    for (const to of [['su-foreign'], ['su-selected', 'su-foreign'], ['su-selec']]) {
      const response = await send(to, wake);
      expect(response.status).toBe(403);
    }
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it('fails closed when current recipient inventory cannot be read', async () => {
    fixture.known = null;
    expect((await send(['su-selected'])).status).toBe(503);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
  it.each([[], 7, [7], null])('refuses malformed selection %j before dispatch', async to => {
    expect((await send(to)).status).toBe(400);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
