/**
 * mobile-agent-sessions-2026-10-12 P-001: the owner's send and end actions on
 * an agent session are ONE server implementation. The desktop admin routes
 * (`/admin/coord/send`, `/admin/coordination/fleet/kill`) and the shared
 * owner-sessions actions the device routes call must produce the SAME tool
 * dispatch, and the send must be classified the same way the desktop reports it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  known: new Set(['su-target']) as Set<string> | null,
  dispatch: vi.fn(),
  response: {} as unknown,
}));
vi.mock('../agent-tools/index', () => ({}));
vi.mock('../endpoint-route/routes/admin/proxy-host-extras', () => ({ ADMIN_PROXY_HOST_EXTRAS: {} }));
vi.mock('../agent-tools/coordination/recipient-resolve', () => ({
  knownOwnerIdSet: () => Promise.resolve(fixture.known),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'ambient-workspace' }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  handleHttpToolRequest: (...args: unknown[]) => fixture.dispatch(...args),
}));

import { ADMIN_COORD_UI_OWNER } from '../agent-tools/coordination/identity';
import coordRoutes from '../endpoint-route/routes/admin/coord';
import coordinationRoutes from '../endpoint-route/routes/admin/coordination';
import { endOwnerSession, sendOwnerSessionMessage } from './actions';
import { ownerMessageSendArgs } from './delivery';

type DispatchedRequest = {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Record<string, unknown>;
};

function lastDispatch(): DispatchedRequest {
  return fixture.dispatch.mock.calls.at(-1)![0] as DispatchedRequest;
}

/** The fields of a dispatch that decide what the tool does and as whom. */
function decisive(request: DispatchedRequest) {
  return {
    method: request.method,
    pathname: request.pathname,
    superuser: request.searchParams.get('superuser'),
    client: request.searchParams.get('client'),
    workspace: request.headers['x-papercusp-workspace'],
    body: request.body,
  };
}

beforeEach(() => {
  fixture.known = new Set(['su-target']);
  fixture.response = { ok: true, results: [{ ok: true, to: ['su-target'], wake: { queued: 1 } }] };
  fixture.dispatch.mockReset().mockImplementation(async () => ({
    status: 200,
    body: { content: [{ type: 'text', text: JSON.stringify(fixture.response) }] },
  }));
});

describe('owner send — one implementation (P-001, R-3)', () => {
  it('does not report an HTTP-200 logical refusal as an accepted send', async () => {
    fixture.response = { ok: false, results: [{ ok: false, error: 'recipient unavailable' }] };
    expect(await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-target', text: 'hi' }))
      .toEqual({ ok: false, status: 502, error: 'coord:send refused' });
  });
  it('labels a verified phone, scopes retries and keeps it outside human UI provenance', async () => {
    await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-target', text: 'hi',
      idempotencyKey: 'device-a:key', pairedDevice: { id: 'phone-a', label: 'Owner' } });
    const request = lastDispatch() as DispatchedRequest & { idempotencyKey: string };
    expect(request.idempotencyKey).toBe('device-a:key');
    expect(request.searchParams.get('client')).toMatch(/^paired-device-/);
    expect(request.searchParams.get('client')).not.toBe(ADMIN_COORD_UI_OWNER);
    expect(request.body).toMatchObject({ to: ['su-target'], wake: 'required', body: [
      expect.objectContaining({ text: '[Owner — sent from a paired device]\nhi' }),
    ] });
  });
  it('dispatches exactly what the desktop /admin/coord/send route dispatches for the same message', async () => {
    const text = 'please rebase onto staging and rerun the failing test';
    const desktop = await coordRoutes[0].handler(
      new Request('http://127.0.0.1/api/admin/coord/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(ownerMessageSendArgs('su-target', text)),
      }),
      { params: { verb: 'send' }, principal: { workspaceId: 'ws-a' } } as never,
    ) as Response;
    expect(desktop.status).toBe(200);
    const desktopDispatch = decisive(lastDispatch());

    const shared = await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-target', text });
    expect(shared.ok).toBe(true);
    const sharedDispatch = decisive(lastDispatch());

    expect(sharedDispatch).toEqual(desktopDispatch);
    expect(sharedDispatch).toMatchObject({
      pathname: '/api/agent-tools/coord/send',
      superuser: '1',
      client: ADMIN_COORD_UI_OWNER,
      workspace: 'ws-a',
      // The P-033 owner-message defaults turn the text into a structured section.
      body: { to: ['su-target'], wake: 'required', body: [expect.objectContaining({ text })] },
    });
  });

  it.each([
    [{ results: [{ wake: { queued: 1 } }] }, { kind: 'queued' }],
    [{ results: [{ wake: { woken: 2 } }] }, { kind: 'woken', count: 2 }],
    [{ results: [{ wake: { staged: true } }] }, { kind: 'staged' }],
    [{ results: [{ recipient_absent: true }] }, { kind: 'absent' }],
  ])('reports the coord:send outcome %j as %j', async (response, delivery) => {
    fixture.response = response;
    const result = await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-target', text: 'hi' });
    expect(result).toEqual({ ok: true, delivery, response });
  });

  it('refuses a recipient outside the workspace before any dispatch', async () => {
    const result = await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-foreign', text: 'hi' });
    expect(result).toEqual({ ok: false, status: 403, error: 'recipient is no longer available in this workspace' });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed when the recipient inventory cannot be read', async () => {
    fixture.known = null;
    const result = await sendOwnerSessionMessage({ workspaceId: 'ws-a', ownerId: 'su-target', text: 'hi' });
    expect(result).toEqual({ ok: false, status: 503, error: 'recipient inventory unavailable' });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});

describe('owner end — one implementation (P-001, D-008)', () => {
  it('dispatches exactly what the desktop Stop agent call to /admin/coordination/fleet/kill dispatches', async () => {
    const reason = 'owner ended the session';
    const desktop = await coordinationRoutes[0].handler(
      new Request('http://127.0.0.1/api/admin/coordination/fleet/kill', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: 'su-target', close_terminal: true, reason }),
      }),
      { params: { group: 'fleet', verb: 'kill' } } as never,
    ) as Response;
    expect(desktop.status).toBe(200);
    const desktopDispatch = decisive(lastDispatch());

    await endOwnerSession({ ownerId: 'su-target', reason });
    const sharedDispatch = decisive(lastDispatch());

    expect(sharedDispatch).toEqual(desktopDispatch);
    expect(sharedDispatch).toMatchObject({
      pathname: '/api/agent-tools/fleet/kill',
      superuser: '1',
      client: ADMIN_COORD_UI_OWNER,
      body: { owner: 'su-target', close_terminal: true, reason },
    });
  });
});
