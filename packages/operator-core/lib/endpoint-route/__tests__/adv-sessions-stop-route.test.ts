import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerRoute } from '../define-route';

const fixture = vi.hoisted(() => ({ row: vi.fn(), latest: vi.fn(), host: vi.fn(), supports: vi.fn(), shutdown: vi.fn(), closeWindow: vi.fn(), cookie: vi.fn() }));
vi.mock('../../auth/principal/from-cookie', () => ({ principalFromCookie: fixture.cookie }));
vi.mock('../../connected-apps/principal', () => ({ resolveAppKeyPrincipal: vi.fn(async () => null) }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../adv-sessions', async importOriginal => ({
  ...await importOriginal<typeof import('../../adv-sessions')>(),
  getAdvSessionInWorkspace: fixture.row,
  getLatestActiveAdvSessionByOwner: fixture.latest,
}));
vi.mock('../../workspace-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(), activeWorkspaceId: () => 'authorized-workspace',
}));
vi.mock('../../events/await/psu-pty-discovery', () => ({ findLiveHostAsync: fixture.host, hostSupports: fixture.supports, shutdownViaPty: fixture.shutdown }));
vi.mock('../../adv-session-windows', () => ({ closeWindowId: fixture.closeWindow }));
vi.mock('../../omp-config', () => ({ readOmpConfig: vi.fn(async () => []) }));
vi.mock('../../omp-sessions', () => ({ findOmpSessionNear: vi.fn(), getOmpSessionRowSummary: vi.fn(), getOmpSessionState: vi.fn(), searchOmpSessions: vi.fn() }));
import routes from '../routes/adv/sessions';
const route = routes.find(value => value.method === 'POST' && value.path === '/adv/sessions/close-window')!;
const STARTED_AT = '2026-10-09T17:00:00.000Z';
const body = { ownerId: 'su-selected', managedSessionId: 7, expectedStartedAt: STARTED_AT, confirmed: true };
const call = (value: unknown, origin?: string, hosted = false) => route.handler(new Request('http://127.0.0.1/api/adv/sessions/close-window', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(hosted ? { 'x-papercusp-hosted-user-id': 'private-ticket-user' } : {}) }, body: JSON.stringify(value),
}), { params: {}, principal: { workspaceId: 'authorized-workspace' } } as never) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.cookie.mockImplementation(async (headers: Headers) => {
    const token = headers.get('cookie')?.split('=')[1];
    if (token !== 'own' && token !== 'foreign') return null;
    return { kind: 'user', slug: 'private-user', workspaceId: token === 'own' ? 'authorized-workspace' : 'foreign-workspace',
      authMethod: 'cookie-session', trust: 'verified', capabilities: new Set(['*']) };
  });
  fixture.row.mockResolvedValue({ id: 7, coordOwnerId: 'su-selected', endedAt: null, startedAt: STARTED_AT });
  fixture.latest.mockResolvedValue({ id: 7, startedAt: STARTED_AT });
  fixture.host.mockResolvedValue({ advSessionId: '7', startedAt: 12345 });
  fixture.supports.mockReturnValue(true);
  fixture.shutdown.mockResolvedValue('sent');
});

describe('confirmed managed session stop', () => {
  const mounted = async (token?: string, value: unknown = body) => {
    const app = new Hono();
    registerRoute(app, route as never);
    return app.request('http://127.0.0.1/adv/sessions/close-window', {
      method: 'POST', headers: { host: '127.0.0.1', 'content-type': 'application/json',
        'x-papercusp-workspace': 'authorized-workspace', ...(token === undefined ? {} : { cookie: 'papercusp_session=' + token }) },
      body: JSON.stringify(value),
    });
  };
  it('resolves the foreign cookie workspace through the actual route stack before a native stop', async () => {
    fixture.row.mockImplementation(async (_id: number, workspace: string) => workspace === 'authorized-workspace'
      ? { id: 7, coordOwnerId: 'su-selected', endedAt: null, startedAt: STARTED_AT } : null);
    expect((await mounted('foreign')).status).toBe(403);
    expect(fixture.row).toHaveBeenCalledExactlyOnceWith(7, 'foreign-workspace');
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('admits the own cookie workspace and preserves credential-free local native compatibility', async () => {
    expect((await mounted('own')).status).toBe(200);
    expect(fixture.row).toHaveBeenCalledWith(7, 'authorized-workspace');
    expect((await mounted()).status).toBe(200);
    expect(fixture.shutdown).toHaveBeenCalledTimes(2);
  });
  it.each(['expired', ''])('refuses a presented invalid cookie rather than falling back to loopback: %j', async token => {
    expect((await mounted(token)).status).toBe(401);
    expect(fixture.row).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('cannot submit legacy OS handles with an authenticated cookie', async () => {
    expect((await mounted('own', { id: 7, pid: 42, windowId: '0xbeef' })).status).toBe(400);
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.closeWindow).not.toHaveBeenCalled();
  });
  it('binds the exact authorized row and host incarnation and reports request acceptance only', async () => {
    const response = await call(body);
    expect(fixture.row).toHaveBeenCalledWith(7, 'authorized-workspace');
    expect(fixture.host).toHaveBeenCalledWith('su-selected');
    expect(fixture.shutdown).toHaveBeenCalledExactlyOnceWith('su-selected', {
      reason: 'Confirmed stop from the portal roster', expectedHost: { startedAt: 12345, advSessionId: '7' },
    });
    expect(fixture.closeWindow).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ ok: true, ownerId: 'su-selected', managedSessionId: 7, sessionStartedAt: STARTED_AT, status: 'stop-requested' });
  });
  it.each([{ ...body, confirmed: false }, { ...body, pid: 42 }, { ...body, windowId: '0xbeef' }, { ...body, managedSessionId: '7' }])('refuses cancellation or arbitrary handles %j', async value => {
    expect((await call(value)).status).toBe(400);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('refuses a cross-origin request before reading or stopping a session', async () => {
    expect((await call(body, 'https://foreign.example')).status).toBe(403);
    expect(fixture.row).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('cannot use legacy OS handles through an authenticated hosted relay', async () => {
    expect((await call({ id: 7, pid: 42, windowId: '0xbeef' }, undefined, true)).status).toBe(400);
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.closeWindow).not.toHaveBeenCalled();
  });
  it('keeps credential-free legacy window control behind the same cross-origin backstop', async () => {
    expect((await call({ id: 7, pid: 42, windowId: '0xbeef' }, 'https://foreign.example')).status).toBe(403);
    expect(fixture.row).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
    expect(fixture.closeWindow).not.toHaveBeenCalled();
  });
  it.each([null, { id: 7, coordOwnerId: 'su-foreign', endedAt: null }, { id: 7, coordOwnerId: 'su-selected', endedAt: 'ended' }])('leaves neighboring sessions untouched for a foreign/stale row %j', async row => {
    fixture.row.mockResolvedValue(row);
    expect((await call(body)).status).toBe(403);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('cannot replay an old row against a replacement incarnation', async () => {
    fixture.latest.mockResolvedValue({ id: 8 });
    expect((await call(body)).status).toBe(409);
    expect(fixture.host).not.toHaveBeenCalled();
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('refuses a host bound to a different managed session', async () => {
    fixture.host.mockResolvedValue({ advSessionId: '8', startedAt: 23456 });
    expect((await call(body)).status).toBe(409);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('cannot replay an old start time when reactivation reuses the same row id', async () => {
    fixture.row.mockResolvedValue({ id: 7, coordOwnerId: 'su-selected', endedAt: null, startedAt: '2026-10-09T18:00:00.000Z' });
    expect((await call(body)).status).toBe(403);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('refuses reactivation that occurs while the host is being resolved', async () => {
    fixture.row.mockResolvedValueOnce({ id: 7, coordOwnerId: 'su-selected', endedAt: null, startedAt: STARTED_AT })
      .mockResolvedValueOnce({ id: 7, coordOwnerId: 'su-selected', endedAt: null, startedAt: '2026-10-09T18:00:00.000Z' });
    expect((await call(body)).status).toBe(409);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it('refuses older hosts without the incarnation guard', async () => {
    fixture.supports.mockReturnValue(false);
    expect((await call(body)).status).toBe(422);
    expect(fixture.shutdown).not.toHaveBeenCalled();
  });
  it.each(['refused-human-attended', 'refused-not-agent-launched', 'refused-agent-busy', 'refused-stale-host'])('preserves the host refusal %s', async refusal => {
    fixture.shutdown.mockResolvedValue(refusal);
    const response = await call(body);
    expect(response.ok).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: refusal });
    expect(fixture.closeWindow).not.toHaveBeenCalled();
  });
});
