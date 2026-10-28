/**
 * `remoteAccess.overview` — the one row Settings → Remote access renders (external-app-access P-010,
 * D-025) with both of the install's routes: its own tunnel (P-009) and the opt-in Papercusp relay
 * (P-008, D-031). A failure reading either route is reported on the row, never thrown, so the list
 * of phones and keys and the kill switch still render when a route's store is unreachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  getRemoteAccess: vi.fn(),
  listRemoteAccessEntries: vi.fn(),
  ownTunnelStatus: vi.fn(),
  portalRelayStatus: vi.fn(),
  loadPsuConnectionStore: vi.fn(),
  readWorkspaceHostControl: vi.fn(),
}));

vi.mock('../connected-apps/remote-access', () => ({
  getRemoteAccess: H.getRemoteAccess,
  listRemoteAccessEntries: H.listRemoteAccessEntries,
}));
vi.mock('../own-tunnel/service', () => ({ ownTunnelStatus: H.ownTunnelStatus }));
vi.mock('../remote-access/relay-opt-in', () => ({ portalRelayStatus: H.portalRelayStatus }));
// The resolver reads the store module directly, not the front-controller CLI (WI-6554700010030748).
vi.mock('../../../../apps/operator/scripts/psu-connection-store.mjs', () => ({ loadPsuConnectionStore: H.loadPsuConnectionStore }));
vi.mock('../workspace-host/observability-store', () => ({ readWorkspaceHostControl: H.readWorkspaceHostControl }));

import { knownQueryNamesV2, resolveNamedQueryV2 } from './index';

const SWITCH = { workspaceId: 'ws1', enabled: true, changedAt: null, changedBy: null };
const RELAY = { state: 'linked', available: true, health: 'up' };

describe('remoteAccess.overview named query', () => {
  beforeEach(() => {
    H.getRemoteAccess.mockReset().mockResolvedValue(SWITCH);
    H.listRemoteAccessEntries.mockReset().mockResolvedValue([{ id: 'pcapp_1' }]);
    H.ownTunnelStatus.mockReset().mockResolvedValue({ configured: false });
    H.portalRelayStatus.mockReset().mockResolvedValue(RELAY);
    H.loadPsuConnectionStore.mockReset().mockReturnValue({ profiles: [] });
    H.readWorkspaceHostControl.mockReset().mockResolvedValue([]);
  });

  it('returns the switch, the entries and both routes for the workspace', async () => {
    expect(knownQueryNamesV2()).toContain('remoteAccess.overview');
    await expect(resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })).resolves.toEqual([
      {
        workspaceId: 'ws1',
        remoteAccess: SWITCH,
        entries: [{ id: 'pcapp_1' }],
        ownTunnel: { configured: false },
        ownTunnelError: null,
        portalRelay: RELAY,
        portalRelayError: null,
        sshProfiles: [], sshProfilesError: null, hostedConnectors: [], hostedConnectorsError: null,
      },
    ]);
    expect(H.getRemoteAccess).toHaveBeenCalledWith('ws1');
    expect(H.listRemoteAccessEntries).toHaveBeenCalledWith('ws1');
  });

  it('reports an unreadable relay on the row and still returns everything else (P-008)', async () => {
    H.portalRelayStatus.mockRejectedValue(new Error('relay store unreachable'));
    const [row] = (await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      portalRelay: null,
      portalRelayError: 'relay store unreachable',
      ownTunnel: { configured: false },
      entries: [{ id: 'pcapp_1' }],
    });
  });

  it('reports an unreadable tunnel without hiding the relay', async () => {
    H.ownTunnelStatus.mockRejectedValue(new Error('tunnel row unreadable'));
    const [row] = (await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' })) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ ownTunnel: null, ownTunnelError: 'tunnel row unreadable', portalRelay: RELAY, portalRelayError: null });
  });

  it('reads actual SSH profiles and scoped hosts while excluding login and provider credentials', async () => {
    H.loadPsuConnectionStore.mockReturnValue({ profiles: [
      { kind: 'ssh', name: 'laptop', host: 'laptop.private', sshUser: 'avi', identityFile: 'PRIVATE_KEY_PATH' },
      { kind: 'papercusp-hosted', name: 'portal', token: 'HOSTED_LOGIN_SECRET' },
    ] });
    const connector = { customerWorkspaceId: 'customer-ws', routeLabel: 'route', state: 'active',
      transport: 'websocket', generation: 7, lastSeenAt: '2026-10-17T20:00:00Z', liveUntil: 1792267350000 };
    H.readWorkspaceHostControl.mockResolvedValue([
      { kind: 'connection', id: 'provider', credentialRef: 'PROVIDER_CREDENTIAL' },
      { kind: 'workspace', id: 'host1', name: 'Desktop', observedState: 'running', hostedConnector: connector, endpoint: 'PRIVATE_ENDPOINT' },
      { kind: 'workspace', id: 'deleted', name: 'Gone', observedState: 'absent' },
      { kind: 'workspace', id: 'unknown', name: 'No heartbeat authority', observedState: 'running' },
    ]);
    const [row] = await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' }) as Array<Record<string, unknown>>;
    expect(H.readWorkspaceHostControl).toHaveBeenCalledWith('ws1');
    expect(row.sshProfiles).toEqual([{ id: 'laptop', label: 'laptop', host: 'laptop.private', scope: 'This computer',
      state: 'unknown', health: 'unknown', sourceRef: 'psu-ssh:laptop' }]);
    expect(row.hostedConnectors).toEqual([
      { id: 'host1', label: 'Desktop', connector },
      { id: 'unknown', label: 'No heartbeat authority', connector: null },
    ]);
    for (const secret of ['PRIVATE_KEY_PATH', 'HOSTED_LOGIN_SECRET', 'PROVIDER_CREDENTIAL', 'PRIVATE_ENDPOINT']) {
      expect(JSON.stringify(row)).not.toContain(secret);
    }
  });

  it('keeps phones, keys and routes visible when either machine source is unavailable', async () => {
    H.loadPsuConnectionStore.mockImplementation(() => { throw new Error('secret local path'); });
    H.readWorkspaceHostControl.mockRejectedValue(new Error('private database details'));
    const [row] = await resolveNamedQueryV2('remoteAccess.overview', { workspaceId: 'ws1' }) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ entries: [{ id: 'pcapp_1' }], portalRelay: RELAY,
      sshProfiles: [], sshProfilesError: 'Saved SSH profiles could not be read.',
      hostedConnectors: [], hostedConnectorsError: 'Hosted connector status could not be read.' });
    expect(JSON.stringify(row)).not.toContain('secret local path');
    expect(JSON.stringify(row)).not.toContain('private database details');
  });
});
