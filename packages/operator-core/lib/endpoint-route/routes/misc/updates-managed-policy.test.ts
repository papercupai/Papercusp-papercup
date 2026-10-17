import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../operator-state-pg', () => ({
  readOperatorState: vi.fn(async () => ({ update_channel: 'alpha' })),
}));
vi.mock('../../../managed-update-policy', async importOriginal => ({
  ...(await importOriginal<object>()), readManagedUpdateChannel: vi.fn(() => 'stable'),
}));
vi.mock('./updates-github', () => ({
  GITHUB_DESKTOP_REPO: 'example/desktop', githubApiHeaders: () => ({}),
  releaseHostBase: () => 'https://releases.example',
  resolveGithubToken: vi.fn(async () => null), fetchAssetText: vi.fn(),
}));

import manifest from './updates-manifest';
import history from './updates-history';
import type { StaticHistoryRelease } from './updates-history';
import rollback from './updates-rollback';
import { ManagedUpdatePolicyError, readManagedUpdateChannel } from '../../../managed-update-policy';
import { resolveGithubToken } from './updates-github';

const fetchMock = vi.fn();
const releases: StaticHistoryRelease[] = [
  { tag: 'desktop-v1.2.0-alpha', version: '1.2.0-alpha', channel: 'alpha', pub_date: '2026-10-15T00:00:00Z', notes: '', prerelease: true, artifacts: [] },
  { tag: 'desktop-v1.1.0', version: '1.1.0', channel: 'stable', pub_date: '2026-10-14T00:00:00Z', notes: '', prerelease: false, artifacts: [{ product: 'gui', platform: 'linux-x86_64', name: 'stable.AppImage', url: 'stable.AppImage', size: 1, sha256: 'fixture' }] },
];
async function call(route: unknown, params = 'channel=alpha&tag=desktop-v1.2.0-alpha'): Promise<Response> {
  return (route as { handler: (request: Request, context: unknown) => Promise<Response> })
    .handler(new Request(`http://fixture/api/updates?${params}`), {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readManagedUpdateChannel).mockReset().mockReturnValue('stable');
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('.sig')) return new Response('SIGNATURE');
    if (url.endsWith('/history.json')) return Response.json({ generated_at: '2026-10-15T00:00:00Z', releases });
    return Response.json({
      version: '1.2.0-alpha', channel: 'alpha', pub_date: '2026-10-15T00:00:00Z',
      platforms: { 'linux-x86_64': { signature: 'SIGNATURE', url: 'https://releases.example/alpha.AppImage' } },
    });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('managed update policy across release endpoints', () => {
  it('offers a signed stable update on the managed lane', async () => {
    fetchMock.mockResolvedValue(Response.json({
      version: '1.1.0', channel: 'stable', pub_date: '2026-10-14T00:00:00Z',
      platforms: { 'linux-x86_64': { signature: 'SIGNATURE', url: 'https://releases.example/stable.AppImage' } },
    }));
    const response = await call(manifest);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: '1.1.0' });
  });

  it('allows a signed rollback within the managed lane', async () => {
    const response = await call(rollback, 'channel=alpha&tag=desktop-v1.1.0');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, channel: 'stable', version: '1.1.0', signature: 'SIGNATURE' });
  });

  it('does not offer an alpha manifest when both query and saved preference try to override stable policy', async () => {
    const response = await call(manifest);
    expect(response.status).toBe(204);
    expect(response.headers.get('X-Update-Reason')).toBe('no_candidate');
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it('filters history to the managed channel despite query and saved preference', async () => {
    const response = await call(history);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ channel: 'stable', releases: [{ tag: 'desktop-v1.1.0' }] });
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it('refuses a rollback into an alpha release without falling through to another source', async () => {
    const response = await call(rollback);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'channel_hidden' });
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });

  it.each([['manifest', manifest], ['history', history], ['rollback', rollback]])('%s reports invalid policy before fetching releases', async (_name, route) => {
    vi.mocked(readManagedUpdateChannel).mockImplementation(() => {
      throw new ManagedUpdatePolicyError('managed_policy_invalid', 'Invalid administrator policy');
    });
    const response = await call(route);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'managed_policy_invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveGithubToken).not.toHaveBeenCalled();
  });
});
