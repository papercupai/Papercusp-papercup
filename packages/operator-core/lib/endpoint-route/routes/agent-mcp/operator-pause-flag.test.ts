import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@papercusp/agent-mcp', async orig => ({
  ...await orig<typeof import('@papercusp/agent-mcp')>(), defineTool: (definition: unknown) => definition,
}));
vi.mock('../../../auth', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../../device-operator-actions', async orig => ({
  ...await orig<typeof import('../../../device-operator-actions')>(),
  assertBackgroundActivityAuthority: vi.fn(), setFeatureBackgroundActivityPolicy: vi.fn(),
  setPaused: vi.fn(), setResumed: vi.fn(),
}));
import routes from './operator-pause-flag';
import { getSessionUser } from '../../../auth';
import { assertBackgroundActivityAuthority, setFeatureBackgroundActivityPolicy, setPaused, setResumed } from '../../../device-operator-actions';

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
});
describe('existing pause endpoint feature controls', () => {
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
    expect(setPaused).not.toHaveBeenCalled();
    expect(setResumed).not.toHaveBeenCalled();
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
});
