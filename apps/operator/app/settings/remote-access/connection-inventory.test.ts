import { describe, expect, it } from 'vitest';
import {
  connectionConfirmationCopy,
  normalizeConnectedAppDevice,
  normalizeBrowserSession,
  normalizeConnectionInventory,
  normalizeHostedConnector,
  normalizeHostedConnectorStatus,
  normalizeMobileDevice,
  normalizePortalRelay,
  normalizePortalRelayStatus,
  normalizeRemoteAccessEntry,
  normalizeSshProfile,
} from './connection-inventory';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');

describe('connection inventory normalization', () => {
  it('never represents app or service keys as authenticated browser sessions', () => {
    const app = normalizeRemoteAccessEntry({ id: 'app-1', kind: 'app' }, { now: NOW });
    const service = normalizeRemoteAccessEntry({ id: 'service-1', kind: 'service' }, { now: NOW });
    const browser = normalizeBrowserSession({ id: 'session-1', state: 'active' }, { now: NOW });
    expect([app.class, service.class, browser.class]).toEqual(['app-key', 'service-key', 'browser-session']);
    expect([app.sourceRef, service.sourceRef, browser.sourceRef]).toEqual([
      'connected_apps:app-1', 'connected_apps:service-1', 'browser-session:session-1',
    ]);
    expect([app.authoritySummary, service.authoritySummary, browser.authoritySummary]).toEqual([
      'User app key access', 'Workspace service key access', 'Authenticated browser session',
    ]);
  });

  it('normalizes every supported class with safe source references and class actions', () => {
    const entries = normalizeConnectionInventory({
      sshProfiles: [{ id: 'laptop', host: 'laptop.example', state: 'active' }],
      portalRelays: [{ workspaceId: 'ws-1', state: 'linked', available: true, health: 'up' }],
      hostedConnectors: [{ id: 'host-1', label: 'Research', state: 'connected', lastSeen: '2026-10-16T11:59:00.000Z' }],
      browserSessions: [{ id: 'session-1', state: 'active', lastSeen: '2026-10-16T11:58:00.000Z' }],
      mobileDevices: [{ id: 'phone-1', creator: 'Maya', lastSeen: '2026-10-16T11:57:00.000Z' }],
    }, { now: NOW });

    expect(entries.map((entry) => entry.class)).toEqual([
      'ssh-profile', 'portal-relay', 'hosted-connector', 'browser-session', 'mobile-device',
    ]);
    expect(entries.map((entry) => entry.actions)).toEqual([
      ['forget-local', 'revoke-remote-key'],
      ['disconnect-relay'],
      ['revoke-connector'],
      ['revoke-session'],
      ['pause-device', 'revoke-device'],
    ]);
    expect(entries.map((entry) => entry.sourceRef)).toEqual([
      'ssh-profile:laptop', 'portal-relay:workspace-ws-1', 'hosted-connector:host-1',
      'browser-session:session-1', 'mobile-device:phone-1',
    ]);
    expect(entries.every((entry) => !('token' in entry) && !('secret' in entry))).toBe(true);
  });

  it('keeps mobile lifecycle distinct from liveness and credential authority', () => {
    const entry = normalizeMobileDevice({
      id: 'phone-1', label: 'Maya phone', pausedAt: '2026-10-16T10:00:00.000Z',
      expiresAt: '2026-10-17T10:00:00.000Z', lastSeen: '2026-10-16T11:59:00.000Z',
      sourceRef: 'connected_apps:phone-1',
    }, { now: NOW });
    expect(entry).toMatchObject({
      class: 'mobile-device', state: 'paused', health: 'degraded',
      sourceRef: 'connected_apps:phone-1', lastSeen: '2026-10-16T11:59:00.000Z',
    });
    expect(entry.authoritySummary).toBe('Paired mobile device');
  });

  it('marks stale connector and terminal session states without rewriting source timestamps', () => {
    expect(normalizeHostedConnector({ id: 'host-1', state: 'connected', lastSeen: '2026-10-16T11:00:00.000Z' }, { now: NOW })).toMatchObject({
      state: 'active', health: 'degraded', lastSeen: '2026-10-16T11:00:00.000Z',
    });
    expect(normalizeBrowserSession({ id: 'session-1', state: 'expired', lastSeen: '2026-10-16T11:59:00.000Z' }, { now: NOW })).toMatchObject({
      state: 'expired', health: 'offline', lastSeen: '2026-10-16T11:59:00.000Z',
    });
  });

  it('does not present an unavailable relay as a healthy connection', () => {
    expect(normalizePortalRelay({ state: 'off', available: false })).toMatchObject({
      state: 'unavailable', health: 'offline', actions: ['disconnect-relay'],
    });
  });

  it('adapts the live relay status projection without copying approval details', () => {
    const entry = normalizePortalRelayStatus({
      workspaceId: 'ws-1', state: 'linked', available: true, health: 'up',
      linked: { linkedAt: '2026-10-16T11:45:00.000Z' },
    });
    expect(entry).toMatchObject({
      class: 'portal-relay', state: 'active', health: 'healthy',
      sourceRef: 'portal-relay:workspace-ws-1', lastSeen: '2026-10-16T11:45:00.000Z',
    });
    expect(entry).not.toHaveProperty('pending');
  });

  it('uses connector heartbeat freshness as liveness while retaining the route label', () => {
    const entry = normalizeHostedConnectorStatus({
      id: 'host-1', routeLabel: 'workspace-relay', transport: 'websocket', state: 'connected',
      lastSeenAt: '2026-10-16T11:00:00.000Z',
    }, { now: NOW });
    expect(entry).toMatchObject({
      class: 'hosted-connector', label: 'workspace-relay', health: 'degraded',
      state: 'active', lastSeen: '2026-10-16T11:00:00.000Z',
    });
  });

  it('keeps connected-app device authority separate from key material', () => {
    const entry = normalizeConnectedAppDevice({
      id: 'phone-1', kind: 'mobile', label: 'Maya phone', creator: 'Maya',
      lastSeen: '2026-10-16T11:59:00.000Z', sourceRef: 'connected_apps:phone-1',
    }, { now: NOW });
    expect(entry).toMatchObject({ class: 'mobile-device', authoritySummary: 'Paired mobile device' });
    expect(Object.keys(entry).sort()).toEqual([
      'actions', 'authoritySummary', 'class', 'health', 'id', 'label', 'lastSeen', 'scope', 'sourceRef', 'state', 'transport',
    ]);
  });

  it('gives destructive confirmation copy the authority-specific verb', () => {
    const phone = normalizeMobileDevice({ id: 'phone-1', label: 'Maya phone' });
    const app = normalizeRemoteAccessEntry({ id: 'app-1', kind: 'app', label: 'Calendar' });
    expect(connectionConfirmationCopy(phone)).toMatchObject({ titleVerb: 'Unpair', confirmLabel: 'Unpair phone' });
    expect(connectionConfirmationCopy(app)).toMatchObject({ titleVerb: 'Revoke', confirmLabel: 'Revoke app access' });
  });

  it('uses stable fallbacks for incomplete SSH profiles', () => {
    expect(normalizeSshProfile({ id: 'profile-1' })).toMatchObject({
      id: 'profile-1', label: 'SSH profile · profile-1', scope: 'Local machine',
      state: 'unknown', health: 'unknown', sourceRef: 'ssh-profile:profile-1',
    });
  });
});

