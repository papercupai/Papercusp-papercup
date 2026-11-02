import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/agent-mcp', async orig => ({
  ...await orig<typeof import('@papercusp/agent-mcp')>(), defineTool: (definition: unknown) => definition,
}));
vi.mock('../../../auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../device-operator-actions', async orig => ({
  ...await orig<typeof import('../../../device-operator-actions')>(),
  assertBackgroundActivityAuthority: vi.fn(), setFeatureBackgroundActivityPolicy: vi.fn(),
  setWorkspaceBackgroundActivityPolicy: vi.fn(),
  stopFeatureBackgroundActivity: vi.fn(),
}));
import routes from './operator-pause-flag';
import { getSessionUser } from '../../../auth';
import { assertBackgroundActivityAuthority, setFeatureBackgroundActivityPolicy, setWorkspaceBackgroundActivityPolicy, stopFeatureBackgroundActivity } from '../../../device-operator-actions';

const featureId = `activity-${'a'.repeat(64)}`;
const body = { featureId, revision: 2, change: { action: 'automatic', automatic: false } };
const user = { id: '03ffddab-83cb-44a2-93e5-d16429c72a2f', username: 'private-user', display_name: 'Private',
  has_password: false, workspace_id: 'test', capabilities: ['*'] };
type Route = { method: string; handler: (request: Request) => Promise<Response> };
const request = (method = 'PATCH', payload: unknown = body) => new Request('http://localhost/api/agent-mcp/operator-pause-flag',
  { method, body: JSON.stringify(payload) });
const handle = (req: Request) => (routes as unknown as Route[]).find(route => route.method === req.method)!.handler(req);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUser).mockResolvedValue(user);
  vi.mocked(assertBackgroundActivityAuthority).mockReturnValue('test');
  vi.mocked(setFeatureBackgroundActivityPolicy).mockResolvedValue({ automatic: false, pausedUntil: null, revision: 3 });
  vi.mocked(setWorkspaceBackgroundActivityPolicy).mockResolvedValue({ automatic: false, pausedUntil: null, revision: 3 });
});
describe('existing pause endpoint feature controls', () => {
  it('routes a one-time stop separately from durable preferences and preserves pending acknowledgment', async () => {
    vi.mocked(stopFeatureBackgroundActivity).mockResolvedValueOnce({ status: 'pending',
      policy: { automatic: true, pausedUntil: null, revision: 2 } });
    const response = await handle(request('PATCH', { featureId, action: 'stop' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'pending', policy: { automatic: true } });
    expect(stopFeatureBackgroundActivity).toHaveBeenCalledWith(featureId, user,
      { headers: expect.any(Headers), runtimePid: undefined });
    expect(setFeatureBackgroundActivityPolicy).not.toHaveBeenCalled();
    expect(setWorkspaceBackgroundActivityPolicy).not.toHaveBeenCalled();
    vi.mocked(stopFeatureBackgroundActivity).mockResolvedValueOnce({ status: 'unavailable',
      reason: 'runtime-control-unavailable', policy: { automatic: true, pausedUntil: null, revision: 2 } });
    const unsupported = await handle(request('PATCH', { featureId, action: 'stop' }));
    expect(unsupported.status).toBe(503);
    expect(await unsupported.json()).toMatchObject({ ok: false, status: 'unavailable' });
  });
  it('forwards a runtime selector with the authenticated request headers', async () => {
    vi.mocked(stopFeatureBackgroundActivity).mockResolvedValueOnce({ status: 'draining',
      policy: { automatic: true, pausedUntil: null, revision: 2 } });
    const req = request('PATCH', { featureId, action: 'stop', runtimePid: 12345 });
    req.headers.set('cookie', 'papercusp_session=original-session');
    expect((await handle(req)).status).toBe(200);
    expect(stopFeatureBackgroundActivity).toHaveBeenCalledWith(featureId, user, { headers: req.headers, runtimePid: 12345 });
    for (const runtimePid of [0, -1, 1.5, '12345']) {
      expect((await handle(request('PATCH', { featureId, action: 'stop', runtimePid }))).status).toBe(400);
    }
  });
  it('binds an authenticated identity to the strict feature request and returns the saved revision', async () => {
    const response = await handle(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, policy: { automatic: false, pausedUntil: null, revision: 3 } });
    expect(setFeatureBackgroundActivityPolicy).toHaveBeenCalledWith(featureId, body.change, 2, user);
  });
  it('rejects missing identity and scope/capability denial before mutations', async () => {
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    expect((await handle(request())).status).toBe(401);
    vi.mocked(assertBackgroundActivityAuthority).mockImplementation(() => { throw Object.assign(new Error('private'), { code: 'startup_policy_forbidden' }); });
    for (const method of ['PATCH', 'POST', 'DELETE']) expect((await handle(request(method))).status).toBe(403);
    expect(setFeatureBackgroundActivityPolicy).not.toHaveBeenCalled();
    expect(setWorkspaceBackgroundActivityPolicy).not.toHaveBeenCalled();
  });
  it.each([
    { ...body, workspaceId: 'foreign' }, { ...body, revision: -1 }, { ...body, featureId: '/private/path' },
    { ...body, change: { ...body.change, command: 'private-command' } },
  ])('rejects malformed or widened payloads', async payload => {
    expect((await handle(request('PATCH', payload))).status).toBe(400);
    expect(setFeatureBackgroundActivityPolicy).not.toHaveBeenCalled();
  });
  it('returns conflicts separately from unavailable storage, without error payloads', async () => {
    vi.mocked(setFeatureBackgroundActivityPolicy).mockRejectedValueOnce(Object.assign(new Error('private-body'), { code: 'startup_policy_conflict' }));
    const conflict = await handle(request());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: 'startup_policy_conflict' });
    vi.mocked(setFeatureBackgroundActivityPolicy).mockRejectedValueOnce(new Error('secret-provider-body'));
    const failed = await handle(request());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ ok: false, error: 'startup_policy_unavailable' });
  });
  it('binds workspace changes and legacy pause/resume to the authenticated principal', async () => {
    const change = { action: 'pause', until: '2099-01-01T00:00:00Z' };
    expect((await handle(request('PATCH', { scope: 'workspace', revision: 2, change }))).status).toBe(200);
    expect(setWorkspaceBackgroundActivityPolicy).toHaveBeenLastCalledWith(change, 2, user);
    expect((await handle(request('POST'))).status).toBe(200);
    expect(setWorkspaceBackgroundActivityPolicy).toHaveBeenLastCalledWith({ action: 'pause', until: null }, undefined, user);
    expect((await handle(request('DELETE'))).status).toBe(200);
    expect(setWorkspaceBackgroundActivityPolicy).toHaveBeenLastCalledWith({ action: 'resume' }, undefined, user);
    expect(setFeatureBackgroundActivityPolicy).not.toHaveBeenCalled();
  });
  it.each([
    { scope: 'workspace', revision: 0, change: body.change, workspaceId: 'foreign' },
    { scope: 'workspace', revision: 0, change: body.change, featureId },
    { scope: 'workspace', change: body.change },
    { scope: 'device', revision: 0, change: body.change },
  ])('rejects widened or unversioned workspace requests', async payload => {
    expect((await handle(request('PATCH', payload))).status).toBe(400);
    expect(setWorkspaceBackgroundActivityPolicy).not.toHaveBeenCalled();
    expect(setFeatureBackgroundActivityPolicy).not.toHaveBeenCalled();
  });
});
