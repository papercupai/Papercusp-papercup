/**
 * The hosted `relay` base URL (android-public-release D-013 #1/#3, D-017): an enrolled
 * hosted machine advertises ONLY `<portal>/api/workspaces/<id>`, and the phone's client
 * appends `/api/device/<route>` to it — the exact path the portal device relay matches.
 */
import { describe, expect, it } from 'vitest';
import { advertisedBaseUrls, hostedDeviceRelayBaseUrl } from './device-base-urls';

const LAN_IFACES = {
  eth0: [{ address: '10.0.0.7', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '10.0.0.7/24' }],
} as unknown as NonNullable<Parameters<typeof advertisedBaseUrls>[0]>['ifaces'];

const HOSTED_ENV = {
  PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'bearer',
  PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
  PORT: '3055',
};

describe('hostedDeviceRelayBaseUrl', () => {
  it('is the portal origin plus /api/workspaces/<id> on an enrolled hosted machine', () => {
    expect(hostedDeviceRelayBaseUrl('ws-1', HOSTED_ENV)).toBe('https://app.papercusp.com/api/workspaces/ws-1');
  });

  it('normalises a wss socket-path control-plane URL to its https origin', () => {
    const env = { ...HOSTED_ENV, PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'wss://app.papercusp.com/api/hosted/connectors/socket' };
    expect(hostedDeviceRelayBaseUrl('ws-1', env)).toBe('https://app.papercusp.com/api/workspaces/ws-1');
  });

  it('is null on a desktop/local install (no connector bearer or control plane)', () => {
    expect(hostedDeviceRelayBaseUrl('ws-1', { PORT: '3055' })).toBeNull();
    expect(hostedDeviceRelayBaseUrl('ws-1', { PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com' })).toBeNull();
  });

  it('refuses a workspace id that is not a plain slug', () => {
    expect(hostedDeviceRelayBaseUrl('../mcp', HOSTED_ENV)).toBeNull();
    expect(hostedDeviceRelayBaseUrl('', HOSTED_ENV)).toBeNull();
    expect(hostedDeviceRelayBaseUrl(null, HOSTED_ENV)).toBeNull();
  });
});

describe('advertisedBaseUrls on a hosted machine', () => {
  it('advertises only the relay — VM-private LAN addresses are unreachable from a phone', () => {
    expect(advertisedBaseUrls({ env: HOSTED_ENV, ifaces: LAN_IFACES, workspaceId: 'ws-1' })).toEqual([
      { kind: 'relay', url: 'https://app.papercusp.com/api/workspaces/ws-1' },
    ]);
  });

  it('keeps the desktop order when no workspace is named or the host is not hosted', () => {
    expect(advertisedBaseUrls({ env: HOSTED_ENV, ifaces: LAN_IFACES })).toEqual([{ kind: 'lan', url: 'http://10.0.0.7:3055' }]);
    expect(advertisedBaseUrls({ env: { PORT: '3055' }, ifaces: LAN_IFACES, workspaceId: 'ws-1' })).toEqual([
      { kind: 'lan', url: 'http://10.0.0.7:3055' },
    ]);
  });

  it('composes with the client path into exactly the relayed device path', () => {
    const [relay] = advertisedBaseUrls({ env: HOSTED_ENV, ifaces: LAN_IFACES, workspaceId: 'ws-1' });
    expect(new URL(`${relay.url}/api/device/runtime-config`).pathname).toBe('/api/workspaces/ws-1/api/device/runtime-config');
  });
});
