import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../auth', () => ({
  getSessionUser: vi.fn(),
  getSessionUserOrDefault: vi.fn(),
  resolveSessionToken: vi.fn(),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: vi.fn(() => 'ws-local') }));
vi.mock('../operator-chat-store', () => ({ operatorChatSessionAuthority: vi.fn(() => vi.fn(async () => true)) }));
import { getSessionUser, getSessionUserOrDefault, resolveSessionToken } from '../auth';
import { activeWorkspaceId } from '../workspace-registry';
import { operatorChatSessionAuthority } from '../operator-chat-store';
import { getSessionUserOrLocalDefault, getSessionUserOrLocalDefaultAuthority } from './session-or-local';

const user = (id: string) => ({
  id,
  username: 'u',
  display_name: 'U',
  has_password: false,
  workspace_id: 'ws-session',
  capabilities: ['*'],
});

/** The helper only reads req.headers — a headers-bearing stub suffices. */
function reqWithHost(host: string | null): Request {
  const headers = new Headers();
  if (host) headers.set('host', host);
  return { headers } as unknown as Request;
}

describe('getSessionUserOrLocalDefault (WI-5044)', () => {
  beforeEach(() => {
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUserOrDefault).mockReset();
    vi.mocked(resolveSessionToken).mockReset();
    vi.mocked(activeWorkspaceId).mockReturnValue('ws-local');
    vi.mocked(operatorChatSessionAuthority).mockClear();
  });

  it('returns the session user when a session cookie resolves', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(user('real'));
    const got = await getSessionUserOrLocalDefault(reqWithHost('example.com'));
    expect(got?.id).toBe('real');
    expect(got).toHaveProperty('workspace_id', 'ws-session');
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('falls back to the seeded default user for a LOOPBACK caller with no session (the desktop webview)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    for (const host of ['127.0.0.1:33700', 'localhost:3270', 'tauri.localhost', '[::1]:3070']) {
      const got = await getSessionUserOrLocalDefault(reqWithHost(host));
      expect(got?.id, host).toBe('default');
      expect(got).toHaveProperty('workspace_id', 'ws-local');
    }
  });

  it('stays strict-session for a NON-loopback caller (no perimeter change)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    for (const host of ['192.168.1.20:3070', 'evil.example.com', null]) {
      const got = await getSessionUserOrLocalDefault(reqWithHost(host));
      expect(got, String(host)).toBeNull();
    }
    expect(getSessionUserOrDefault).not.toHaveBeenCalled();
  });

  it('degrades to null (401) when both resolutions fail', async () => {
    vi.mocked(getSessionUser).mockRejectedValue(new Error('pg down'));
    vi.mocked(getSessionUserOrDefault).mockRejectedValue(new Error('pg down'));
    const got = await getSessionUserOrLocalDefault(reqWithHost('127.0.0.1:3070'));
    expect(got).toBeNull();
  });

  it('captures cookie authority and delegates current permissions to the decision transaction', async () => {
    vi.mocked(resolveSessionToken).mockResolvedValue('opaque-session');
    vi.mocked(getSessionUser).mockResolvedValue(user('real'));
    const result = await getSessionUserOrLocalDefaultAuthority(reqWithHost('example.com'));
    expect(operatorChatSessionAuthority).toHaveBeenLastCalledWith({ workspaceId: 'ws-session',
      principalId: 'real', credential: { kind: 'user-session', token: 'opaque-session', userId: 'real' },
      capability: 'chat:write', toolName: 'chat:ask_choice' });
    const tx = {} as Parameters<NonNullable<typeof result>['authorize']>[0];
    expect(await result!.authorize(tx)).toBe(true);
    expect(vi.mocked(operatorChatSessionAuthority).mock.results.at(-1)!.value).toHaveBeenCalledWith(tx);
  });

  it('never promotes a presented expired cookie into desktop authority', async () => {
    vi.mocked(resolveSessionToken).mockResolvedValue('revoked');
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    await getSessionUserOrLocalDefaultAuthority(reqWithHost('localhost'));
    expect(operatorChatSessionAuthority).toHaveBeenLastCalledWith(expect.objectContaining({
      credential: { kind: 'user-session', token: 'revoked', userId: 'default' },
    }));
  });

  it('captures desktop authority only inside the perimeter and refuses a later workspace switch', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    vi.mocked(getSessionUserOrDefault).mockResolvedValue(user('default'));
    const result = await getSessionUserOrLocalDefaultAuthority(reqWithHost('tauri.localhost'));
    const tx = {} as Parameters<NonNullable<typeof result>['authorize']>[0];
    expect(operatorChatSessionAuthority).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'ws-local', credential: { kind: 'local-desktop', userId: 'default' },
    }));
    expect(await result!.authorize(tx)).toBe(true);
    vi.mocked(activeWorkspaceId).mockReturnValue('different-workspace');
    expect(await result!.authorize(tx)).toBe(false);
  });

  it('does not construct desktop authority for an off-box unauthenticated request', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    expect(await getSessionUserOrLocalDefaultAuthority(reqWithHost('example.com'))).toBeNull();
    expect(operatorChatSessionAuthority).not.toHaveBeenCalled();
  });
});
