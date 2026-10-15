import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedPrincipalResolution } from '../auth/hosted-principal-resolver';
import {
  HostedWorkspaceSessionBroker,
  type HostedWorkspaceRelaySocket,
} from './hosted-workspace-session';
import type { HostedConnectorBinding, HostedConnectorTicketBinding } from './hosted-workspace-connector';
import { DEFAULT_CLOUD_TELEMETRY_CONSENT } from '../telemetry-kinds';

class FakeSocket extends EventEmitter implements HostedWorkspaceRelaySocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: unknown[] = [];
  closed: [number | undefined, string | undefined][] = [];
  send(data: string | Buffer) { this.sent.push(JSON.parse(data.toString())); }
  close(code?: number, reason?: string) {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closed.push([code, reason]);
    this.emit('close');
  }
  message(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false); }
}

const connector: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control', organizationId: 'org-1', customerWorkspaceId: 'workspace-1',
  hostId: 'host-1', routeLabel: 'alpha', generation: 7, transport: 'websocket', state: 'active',
};
const ticket = (session = 'hosted-session-1'): HostedConnectorTicketBinding => ({
  ...connector, kind: 'session', userId: 'user-1', hostedSessionId: session,
  audience: 'workspace-operator', expiresAt: new Date('2026-08-28T03:00:00Z'),
});

describe('HostedWorkspaceSessionBroker', () => {
  it('returns fresh diagnostic consent only to an authenticated customer-host authority request', async () => {
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'org-1',
      selectedWorkspaceId: 'workspace-1', userId: 'user-1', sessionId: 'hosted-session-1',
      sessionVersion: 3, permissions: ['workspace:operate'] });
    const consent = vi.fn(async () => DEFAULT_CLOUD_TELEMETRY_CONSENT);
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0,
      resolveChannelPrincipal: async () => ({ ok: true, principal } as HostedPrincipalResolution), readMonitoringConsent: consent });
    const host = new FakeSocket(), browser = new FakeSocket();
    try {
      broker.attachConnector(connector, host); broker.attachBrowser(ticket(), browser, { kind: 'operator-http' });
      const open = host.sent.find(m => (m as { type: string }).type === 'relay.open') as { channelId: string };
      const requestId = '11111111-1111-4111-8111-111111111111';
      browser.message({ type: 'session.authorize', channelId: open.channelId, requestId, diagnostics: true });
      expect(consent).not.toHaveBeenCalled();
      host.message({ type: 'session.authorize', channelId: open.channelId, requestId });
      await vi.waitFor(() => expect(host.sent).toContainEqual(expect.objectContaining({ type: 'session.authorized', requestId })));
      expect(consent).not.toHaveBeenCalled();
      host.sent = [];
      host.message({ type: 'session.authorize', channelId: open.channelId, requestId, diagnostics: true });
      await vi.waitFor(() => expect(host.sent).toContainEqual(expect.objectContaining({ type: 'session.authorized',
        authority: expect.objectContaining({ monitoringConsent: DEFAULT_CLOUD_TELEMETRY_CONSENT }) })));
      expect(consent).toHaveBeenCalledWith(principal);
      expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.authorized' }));
      host.sent = []; consent.mockRejectedValue(new Error('PRIVATE_DATABASE_CONNECTION'));
      host.message({ type: 'session.authorize', channelId: open.channelId, requestId, diagnostics: true });
      await vi.waitFor(() => expect(host.sent).toContainEqual(expect.objectContaining({ authority: expect.objectContaining({ monitoringConsent: null }) })));
      expect(JSON.stringify(host.sent)).not.toContain('PRIVATE_DATABASE_CONNECTION');
    } finally { browser.close(); host.close(); broker.dispose(); }
  });
  it('rechecks ticket-bound authority over the connector without trusting frame labels', async () => {
    const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'org-1',
      selectedWorkspaceId: 'workspace-1', userId: 'user-1', sessionId: 'hosted-session-1',
      sessionVersion: 3, permissions: ['workspace:operate'] });
    const resolve = vi.fn(async (): Promise<HostedPrincipalResolution> => ({ ok: true, principal } as HostedPrincipalResolution));
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0, resolveChannelPrincipal: resolve });
    const host = new FakeSocket(); const browser = new FakeSocket();
    broker.attachConnector(connector, host); broker.attachBrowser(ticket(), browser, { kind: 'operator-http' });
    const open = host.sent.find(m => (m as { type: string }).type === 'relay.open') as { channelId: string };
    const requestId = '11111111-1111-4111-8111-111111111111';
    host.message({ type: 'session.authorize', channelId: open.channelId, requestId,
      userId: 'forged', hostedSessionId: 'forged', permissions: ['*'] });
    await vi.waitFor(() => expect(host.sent).toContainEqual(expect.objectContaining({
      type: 'session.authorized', requestId, authority: expect.objectContaining({ userId: 'user-1',
        sessionVersion: 3, permissions: ['workspace:operate'] }) })));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', hostedSessionId: 'hosted-session-1' }));
    expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.authorized' }));
    resolve.mockResolvedValue({ ok: false, reason: 'membership_not_active' });
    host.message({ type: 'session.authorize', channelId: open.channelId, requestId });
    await vi.waitFor(() => expect(host.sent).toContainEqual({ type: 'session.authorized',
      channelId: open.channelId, requestId, authority: null }));
    browser.close(); host.close(); broker.dispose();
  });

  it('never returns stale authority after a channel closes during the read', async () => {
    let finish!: (v: HostedPrincipalResolution) => void;
    const resolve = vi.fn(() => new Promise<HostedPrincipalResolution>(r => { finish = r; }));
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0, resolveChannelPrincipal: resolve });
    const host = new FakeSocket(); const browser = new FakeSocket();
    broker.attachConnector(connector, host); broker.attachBrowser(ticket(), browser, { kind: 'operator-http' });
    const open = host.sent.find(m => (m as { type: string }).type === 'relay.open') as { channelId: string };
    host.message({ type: 'session.authorize', channelId: open.channelId,
      requestId: '11111111-1111-4111-8111-111111111111' });
    expect(resolve).toHaveBeenCalledTimes(1); browser.close();
    finish({ ok: false, reason: 'session_not_found' }); await Promise.resolve(); await Promise.resolve();
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'session.authorized' }));
    host.close(); broker.dispose();
  });
  it.each(['unconfigured', 'fault', 'foreign', 'view-only'])(
    'denies %s authority without exposing internal details', async mode => {
      const principal = createHostedPrincipal({ workspaceId: 'control', activeOrganizationId: 'org-1',
        selectedWorkspaceId: 'workspace-1', userId: mode === 'foreign' ? 'different' : 'user-1',
        sessionId: 'hosted-session-1', sessionVersion: 3,
        permissions: [mode === 'view-only' ? 'workspace:view' : 'workspace:operate'] });
      const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0,
        ...(mode === 'unconfigured' ? {} : { resolveChannelPrincipal: async () => {
          if (mode === 'fault') throw new Error('PRIVATE_AUTHORITY_FAILURE');
          return { ok: true, principal } as HostedPrincipalResolution;
        } }) });
      const host = new FakeSocket(); const browser = new FakeSocket();
      broker.attachConnector(connector, host); broker.attachBrowser(ticket(), browser, { kind: 'operator-http' });
      const open = host.sent.find(m => (m as { type: string }).type === 'relay.open') as { channelId: string };
      const requestId = '11111111-1111-4111-8111-111111111111';
      host.message({ type: 'session.authorize', channelId: open.channelId, requestId });
      await vi.waitFor(() => expect(host.sent).toContainEqual({ type: 'session.authorized',
        channelId: open.channelId, requestId, authority: null }));
      expect(JSON.stringify(host.sent)).not.toContain('PRIVATE_AUTHORITY_FAILURE');
      browser.close(); host.close(); broker.dispose();
    });

  it('refuses browser-authored and stale-connector authority requests', async () => {
    const resolve = vi.fn(async (): Promise<HostedPrincipalResolution> => ({ ok: false, reason: 'session_not_found' }));
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0, resolveChannelPrincipal: resolve });
    const host = new FakeSocket(); const browser = new FakeSocket();
    broker.attachConnector(connector, host); broker.attachBrowser(ticket(), browser, { kind: 'operator-http' });
    const open = host.sent.find(m => (m as { type: string }).type === 'relay.open') as { channelId: string };
    const req = { type: 'session.authorize', channelId: open.channelId,
      requestId: '11111111-1111-4111-8111-111111111111' };
    browser.message(req); expect(resolve).not.toHaveBeenCalled();
    const replacement = new FakeSocket(); broker.attachConnector(connector, replacement);
    host.message(req); expect(resolve).not.toHaveBeenCalled();
    replacement.close(); broker.dispose();
  });
  it('drops non-allowlisted BYOC connector control frames and audits type only', () => {
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0, onAudit: audit });
    const host = new FakeSocket();
    broker.attachConnector({ ...connector, hosting: 'byoc' }, host);
    host.message({ type: 'session.claim-control', payload: { secret: 'BYOC_SECRET' } });
    host.message({ type: 'BYOC_SECRET', payload: { secret: 'BYOC_SECRET' } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'byoc_control_frame_dropped', detail: 'session.claim-control',
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'byoc_control_frame_dropped', detail: 'unknown',
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('BYOC_SECRET');
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'relay.open' }));
    broker.dispose();
  });

  it.each(['pty', 'psu', 'operator-http', 'desktop'] as const)(
    'refuses a BYOC %s plaintext channel before opening it', (kind) => {
      const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'forbidden' });
      const host = new FakeSocket();
      const browser = new FakeSocket();
      broker.attachConnector({ ...connector, hosting: 'byoc' }, host);
      broker.attachBrowser(ticket(), browser, { kind, ...(kind === 'desktop' ? { desktopSessionId: 'desktop-1' } : {}) });
      expect(browser.sent).toContainEqual({
        type: 'session.denied', reason: 'byoc_plaintext_relay_refused',
        alternatives: ['customer_controlled_ingress', 'sealed_channel'],
      });
      expect(browser.closed).toEqual([[4403, 'byoc_plaintext_relay_refused']]);
      expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'relay.open' }));
      broker.dispose();
    },
  );

  it('refuses both portal app channel kinds for BYOC', () => {
    const broker = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
    const host = new FakeSocket();
    const byoc = { ...connector, hosting: 'byoc' as const };
    broker.attachConnector(byoc, host);
    const app = broker.appConnector(byoc.customerWorkspaceId)!;
    for (const kind of ['app-http', 'app-key-mint'] as const) {
      expect(broker.openAppChannel(app, { onFrame: () => {}, onClose: () => {} }, kind)).toBeNull();
    }
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'relay.open' }));
    broker.dispose();
  });

  it('relays only through the exact generation-bound outbound connector', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);

    expect(host.sent).toContainEqual(expect.objectContaining({ type: 'relay.open', channelId: 'channel-1' }));
    expect(browser.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', role: 'controller' }));
    browser.message({ type: 'pty.input', data: 'aGVsbG8=' });
    expect(host.sent).toContainEqual({ type: 'relay', channelId: 'channel-1', payload: { type: 'pty.input', data: 'aGVsbG8=' } });
    host.message({ type: 'relay', channelId: 'channel-1', payload: { type: 'pty.output', data: 'd29ybGQ=' } });
    expect(browser.sent).toContainEqual({ type: 'pty.output', data: 'd29ybGQ=' });

    broker.closeGeneration(connector, 4001, 'connector_rotated');
    expect(host.closed).toContainEqual([4001, 'connector_rotated']);
    expect(browser.closed).toContainEqual([4001, 'connector_rotated']);
  });

  it('makes later tabs observers until they explicitly claim control', () => {
    let id = 0;
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++id}`, onAudit: audit });
    const host = new FakeSocket();
    const first = new FakeSocket();
    const second = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), first);
    broker.attachBrowser(ticket(), second);

    expect(second.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', role: 'observer' }));
    second.message({ type: 'pty.input', data: 'blocked' });
    expect(second.sent).toContainEqual({ type: 'session.denied', reason: 'observer_read_only', requestType: 'pty.input' });
    second.message({ type: 'session.claim-control' });
    expect(first.sent).toContainEqual({ type: 'session.role', role: 'observer', reason: 'control_claimed_elsewhere' });
    expect(second.sent).toContainEqual({ type: 'session.role', role: 'controller' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'control_claimed', channelId: 'channel-2' }));
  });

  it('expires idle browser sessions and notifies the host without logging content', () => {
    vi.useFakeTimers();
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({ idleMs: 100, randomId: () => 'idle', onAudit: audit });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);
    vi.advanceTimersByTime(101);
    expect(browser.closed).toContainEqual([4000, 'session_idle_expired']);
    expect(host.sent).toContainEqual({ type: 'relay.close', channelId: 'idle', reason: 'session_idle_expired' });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('terminal secret');
    vi.useRealTimers();
  });
});

describe('HostedWorkspaceSessionBroker — desktop channels (P-013 / D-023, D-024)', () => {
  const ids = () => {
    let n = 0;
    return () => `channel-${++n}`;
  };

  function attached(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2] = {}) {
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1' });
    const host = new FakeSocket();
    const browser = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser, attach);
    return { broker, host, browser };
  }

  const opens = (host: FakeSocket) =>
    host.sent.filter((m) => (m as { type: string }).type === 'relay.open') as Array<Record<string, unknown>>;

  it('forwards the kind + desktopSessionId the host needs to open a desktop', () => {
    // Gap A: before this, relay.open carried six fields and NONE could express a
    // desktop, so P-013's host-side discriminator was unreachable from the browser.
    const { host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    expect(host.sent).toContainEqual(
      expect.objectContaining({ type: 'relay.open', kind: 'desktop', desktopSessionId: 'ds_1' }),
    );
  });

  it('omits the discriminator entirely for a pty, so a host predating it still opens terminals', () => {
    const { host } = attached();
    expect(opens(host)[0]).not.toHaveProperty('kind');
    expect(opens(host)[0]).not.toHaveProperty('desktopSessionId');
  });

  it('refuses a desktop attach with no session id rather than opening a blank viewer', () => {
    const { browser, host } = attached({ kind: 'desktop' });
    expect(browser.closed).toContainEqual([4403, 'desktop_session_required']);
    expect(opens(host)).toHaveLength(0);
  });

  it('takes watch/takeover from the REQUEST, never from arrival order', () => {
    // Role IS the credential (D-024 ruling 1): electing the first arrival controller
    // would hand INPUT to a user who asked only to watch, silently.
    expect(opens(attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' }).host)[0]!.role).toBe('observer');
    expect(opens(attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' }).host)[0]!.role).toBe('controller');
  });

  it('lets two takeover viewers coexist — the pairing IS the feature (-AlwaysShared 1)', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: ids() });
    const host = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    // A desktop channel never enters the controller map, so the second viewer is NOT
    // demoted to observer just because someone else is already attached.
    expect(opens(host).map((m) => m.role)).toEqual(['controller', 'controller']);
  });

  it('a desktop attach does not steal the pty controller slot', () => {
    const broker = new HostedWorkspaceSessionBroker({ randomId: ids() });
    const host = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
    broker.attachBrowser(ticket(), new FakeSocket());
    const pty = opens(host).filter((m) => m.kind === undefined);
    expect(pty).toHaveLength(1);
    expect(pty[0]!.role).toBe('controller');
  });

  it('REFUSES in-place promotion on a desktop channel instead of lying about it', () => {
    // D-024 ruling 2: the privilege IS the credential, consumed by the dial. Flipping
    // the broker role would tell the browser it has control while KasmVNC went on
    // dropping its input — a viewer that believes it has the keyboard and does not.
    const { browser, host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    browser.message({ type: 'session.claim-control' });
    expect(browser.sent).toContainEqual(
      expect.objectContaining({ type: 'session.denied', reason: 'desktop_role_fixed_at_open' }),
    );
    expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.role', role: 'controller' }));
    expect(host.sent).not.toContainEqual(expect.objectContaining({ type: 'relay.role' }));
  });

  it('still allows a PTY channel to claim control', () => {
    const { browser } = attached();
    browser.message({ type: 'session.claim-control' });
    expect(browser.sent).not.toContainEqual(expect.objectContaining({ type: 'session.denied' }));
  });

  describe('the control plane records the viewer start itself (WI-10004167)', () => {
    // The host audits into ITS database, which the control plane cannot read, so the
    // P-318 customer-acceptance receipt could never find a hosted takeover. The broker
    // records its own row once the host confirms the dial.
    function audited(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2]) {
      const audit = vi.fn();
      const broker = new HostedWorkspaceSessionBroker({ randomId: () => 'channel-1', onAudit: audit });
      const host = new FakeSocket();
      const browser = new FakeSocket();
      broker.attachConnector(connector, host);
      broker.attachBrowser(ticket(), browser, attach);
      const starts = () =>
        audit.mock.calls.map(([event]) => event).filter((event) => String(event.action).startsWith('desktop_'));
      return { host, browser, starts };
    }
    const ready = (action: string) => ({ type: 'relay', channelId: 'channel-1', payload: { type: 'desktop.ready', action, inputAllowed: action === 'takeover' } });

    it('records a takeover start with the broker\'s own identity once the host confirms the dial', () => {
      const { host, browser, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
      expect(starts()).toEqual([]);
      host.message(ready('takeover'));
      expect(starts()).toEqual([{
        action: 'desktop_takeover_started',
        controlPlaneWorkspaceId: 'control',
        organizationId: 'org-1',
        customerWorkspaceId: 'workspace-1',
        hostId: 'host-1',
        generation: 7,
        userId: 'user-1',
        hostedSessionId: 'hosted-session-1',
        channelId: 'channel-1',
        detail: 'desktop=ds_1',
      }]);
      // Still relayed: the viewer needs the frame to start drawing.
      expect(browser.sent).toContainEqual({ type: 'desktop.ready', action: 'takeover', inputAllowed: true });
    });

    it('records a watch start for an observer channel', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
      host.message(ready('watch'));
      expect(starts().map((event) => event.action)).toEqual(['desktop_watch_started']);
    });

    it('records one start per channel, however many ready frames the host sends', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'takeover' });
      host.message(ready('takeover'));
      host.message(ready('takeover'));
      expect(starts()).toHaveLength(1);
    });

    it('never records a takeover the broker did not open, whatever the host reports', () => {
      const { host, starts } = audited({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
      host.message(ready('takeover'));
      expect(starts().map((event) => event.action)).toEqual(['desktop_ready_mode_mismatch']);
    });

    it('ignores a desktop.ready frame on a terminal channel', () => {
      const { host, starts } = audited({});
      host.message(ready('takeover'));
      expect(starts()).toEqual([]);
    });
  });

  it('does NOT gate desktop.data on the controller role — the credential is the enforcement', () => {
    // D-024 explicitly forbids a byte filter here: an observer legitimately SENDS
    // FramebufferUpdateRequest/SetEncodings, which is how a VNC client gets pixels at
    // all. KasmVNC drops the input messages server-side against the view-only user.
    const { browser, host } = attached({ kind: 'desktop', desktopSessionId: 'ds_1', desktopMode: 'watch' });
    browser.message({ type: 'desktop.data', data: 'AQID' });
    expect(host.sent).toContainEqual(
      expect.objectContaining({ type: 'relay', payload: { type: 'desktop.data', data: 'AQID' } }),
    );
  });
});

describe('HostedWorkspaceSessionBroker — operator-http channels (D-418 / WI-10002873)', () => {
  function attached(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2]) {
    let n = 0;
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++n}` });
    const host = new FakeSocket();
    const client = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), client, attach);
    return { broker, host, client };
  }
  const request = { type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/harness/portal/agent-chats' };

  it('opens with kind operator-http, echoes the kind, and is always controller', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    expect(host.sent).toContainEqual(expect.objectContaining({ type: 'relay.open', kind: 'operator-http', role: 'controller' }));
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'operator-http', role: 'controller' }));
  });

  it('does not take the PTY controller slot', () => {
    let n = 0;
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++n}` });
    broker.attachConnector(connector, new FakeSocket());
    broker.attachBrowser(ticket(), new FakeSocket(), { kind: 'operator-http' });
    const tab = new FakeSocket();
    broker.attachBrowser(ticket(), tab);
    expect(tab.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'pty', role: 'controller' }));
  });

  it('forwards request frames and relays host response frames back', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    client.message(request);
    expect(host.sent).toContainEqual({ type: 'relay', channelId: 'channel-1', payload: request });
    host.message({ type: 'relay', channelId: 'channel-1', payload: { type: 'http.response', requestId: 'r1', status: 200, headers: {} } });
    expect(client.sent).toContainEqual({ type: 'http.response', requestId: 'r1', status: 200, headers: {} });
  });

  it('refuses non-http frames on an operator-http channel', () => {
    const { host, client } = attached({ kind: 'operator-http' });
    client.message({ type: 'pty.input', data: 'aGk=' });
    client.message({ type: 'desktop.start' });
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'pty.input' });
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'desktop.start' });
    expect(host.sent.filter((m) => (m as { type: string }).type === 'relay')).toEqual([]);
  });

  it('refuses http frames on a PTY channel, so a terminal ticket cannot call the operator API', () => {
    const { host, client } = attached({});
    client.message(request);
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'http.request' });
    expect(host.sent.filter((m) => (m as { type: string }).type === 'relay')).toEqual([]);
  });

  it('refuses in-place control claims on an operator-http channel', () => {
    const { client } = attached({ kind: 'operator-http' });
    client.message({ type: 'session.claim-control' });
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'session.denied', reason: 'operator_http_role_fixed' }));
  });
});

// D-002 / P-007 (psu-cloud-connector-liveness-multi-signin-2026-09-29): psu started by the host.
describe('HostedWorkspaceSessionBroker — psu channels (D-002)', () => {
  function attached(attach: Parameters<HostedWorkspaceSessionBroker['attachBrowser']>[2]) {
    let n = 0;
    const broker = new HostedWorkspaceSessionBroker({ randomId: () => `channel-${++n}` });
    const host = new FakeSocket();
    const client = new FakeSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), client, attach);
    return { broker, host, client };
  }
  const opens = (host: FakeSocket) =>
    host.sent.filter((m) => (m as { type: string }).type === 'relay.open') as Array<Record<string, unknown>>;

  it('opens with kind psu and the NORMALISED argv, and echoes the kind', () => {
    const { host, client } = attached({ kind: 'psu', argv: ['--agent', 'codex', '--no-picker'] });
    expect(opens(host)).toEqual([expect.objectContaining({ kind: 'psu', argv: ['--agent=codex', '--no-picker'], role: 'controller' })]);
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'psu', role: 'controller' }));
  });

  it('opens psu with an empty argv when the client sent none', () => {
    const { host } = attached({ kind: 'psu' });
    expect(opens(host)[0]).toMatchObject({ kind: 'psu', argv: [] });
  });

  it('refuses an argv outside the allowlist before anything reaches the machine', () => {
    for (const argv of [['--', 'rm'], ['--dangerously-skip-permissions'], 'not-a-list', ['--agent', 'bash']]) {
      const { host, client } = attached({ kind: 'psu', argv });
      expect(client.closed).toEqual([[4403, 'psu_argv_refused']]);
      expect(opens(host)).toEqual([]);
    }
  });

  it('never sends argv on a pty open, whatever the client attached', () => {
    const { host } = attached({ argv: ['--agent', 'codex'] });
    expect(opens(host)[0]).not.toHaveProperty('argv');
    expect(opens(host)[0]).not.toHaveProperty('kind');
  });

  it('elects roles like a terminal: a second tab is an observer until it claims control', () => {
    const { broker, host } = attached({ kind: 'psu' });
    const second = new FakeSocket();
    broker.attachBrowser(ticket(), second, { kind: 'psu' });
    expect(second.sent).toContainEqual(expect.objectContaining({ type: 'session.bound', kind: 'psu', role: 'observer' }));
    second.message({ type: 'pty.input', data: 'aGk=' });
    expect(second.sent).toContainEqual({ type: 'session.denied', reason: 'observer_read_only', requestType: 'pty.input' });
    second.message({ type: 'session.claim-control' });
    expect(second.sent).toContainEqual({ type: 'session.role', role: 'controller' });
    second.message({ type: 'pty.input', data: 'aGk=' });
    expect(host.sent).toContainEqual({ type: 'relay', channelId: 'channel-2', payload: { type: 'pty.input', data: 'aGk=' } });
  });

  it('refuses http frames on a psu channel', () => {
    const { host, client } = attached({ kind: 'psu' });
    client.message({ type: 'http.request', requestId: 'r1', method: 'GET', path: '/api/health' });
    expect(client.sent).toContainEqual({ type: 'session.denied', reason: 'channel_kind_mismatch', requestType: 'http.request' });
    expect(host.sent.filter((m) => (m as { type: string }).type === 'relay')).toEqual([]);
  });
});

/** A socket that answers pings the way `ws` does, unless told the link is dead. */
class PingableSocket extends FakeSocket {
  pings = 0;
  terminated = false;
  answersPings = true;
  ping() {
    this.pings += 1;
    if (this.answersPings) queueMicrotask(() => this.emit('pong'));
  }
  terminate() {
    if (this.readyState !== this.OPEN) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}

// P-001 (psu-cloud-connector-liveness-multi-signin-2026-09-29). avi-test, 2026-09-29: the VM kept a
// silent, half-open connector for ~2h; this broker had no socket for it and nothing on either side
// noticed, so every attach closed 4411 connector_unavailable while the cloud said "reachable".
describe('HostedWorkspaceSessionBroker — relay liveness (P-001)', () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function liveBroker() {
    const liveness: [number, boolean][] = [];
    const audit = vi.fn();
    const broker = new HostedWorkspaceSessionBroker({
      pingIntervalMs: 0,
      randomId: () => 'channel-1',
      onAudit: audit,
      onConnectorLiveness: (binding, alive) => liveness.push([binding.generation, alive]),
    });
    return { broker, liveness, audit };
  }

  it('keeps a connector that answers pings and reports each pong as liveness', async () => {
    const { broker, liveness } = liveBroker();
    const host = new PingableSocket();
    broker.attachConnector(connector, host);
    expect(liveness).toEqual([[7, true]]);

    for (let sweep = 0; sweep < 3; sweep += 1) {
      broker.sweepLiveness();
      await flush();
    }
    expect(host.pings).toBe(3);
    expect(host.terminated).toBe(false);
    expect(liveness).toEqual([[7, true], [7, true], [7, true], [7, true]]);
  });

  it('terminates a connector that missed a pong, detaches its browsers with 4412, and reports it gone', async () => {
    const { broker, liveness, audit } = liveBroker();
    const host = new PingableSocket();
    const browser = new PingableSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);

    host.answersPings = false;
    broker.sweepLiveness();
    await flush();
    expect(host.terminated).toBe(false); // one missed pong is only suspicion
    broker.sweepLiveness();

    expect(host.terminated).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector_heartbeat_missed', generation: 7 }));
    expect(browser.closed).toContainEqual([4412, 'connector_disconnected']);
    expect(liveness.at(-1)).toEqual([7, false]);

    // The next attach is refused truthfully instead of relaying into a dead socket.
    const late = new PingableSocket();
    broker.attachBrowser(ticket('hosted-session-2'), late);
    expect(late.closed).toContainEqual([4411, 'connector_unavailable']);
  });

  it('treats any inbound frame as proof of life', async () => {
    const { broker } = liveBroker();
    const host = new PingableSocket();
    host.answersPings = false;
    broker.attachConnector(connector, host);
    broker.sweepLiveness();
    host.message({ type: 'relay', channelId: 'none', payload: {} });
    broker.sweepLiveness();
    expect(host.terminated).toBe(false);
  });

  it('pings browsers too and drops one that stopped answering, without touching connector liveness', async () => {
    const { broker, liveness } = liveBroker();
    const host = new PingableSocket();
    const browser = new PingableSocket();
    broker.attachConnector(connector, host);
    broker.attachBrowser(ticket(), browser);
    browser.answersPings = false;
    broker.sweepLiveness();
    await flush();
    broker.sweepLiveness();
    expect(browser.terminated).toBe(true);
    expect(host.terminated).toBe(false);
    expect(host.sent).toContainEqual({ type: 'relay.close', channelId: 'channel-1', reason: 'browser_disconnected' });
    expect(liveness.every(([, alive]) => alive)).toBe(true);
  });

  it('does not report a replaced connector socket as gone', () => {
    const { broker, liveness } = liveBroker();
    const first = new PingableSocket();
    const second = new PingableSocket();
    broker.attachConnector(connector, first);
    // Real `ws` delivers the replaced socket's close asynchronously, after the new one is bound.
    first.close = function (this: PingableSocket, code?: number, reason?: string) {
      this.closed.push([code, reason]);
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    };
    broker.attachConnector(connector, second);
    return flush().then(() => {
      expect(first.closed).toContainEqual([4002, 'connector_replaced']);
      expect(liveness).toEqual([[7, true], [7, true]]);
    });
  });
});

describe('HostedWorkspaceSessionBroker membership reports (WI-10004257)', () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const report = (removedEmails: string[]) => ({ type: 'membership.report', organizationId: 'org-1', removedEmails });
  const reports = (socket: FakeSocket) =>
    socket.sent.filter((frame) => (frame as { type?: string }).type === 'membership.report');

  it("sends the connector's organization report right after bound, and nothing without a loader", async () => {
    const reads: string[] = [];
    const broker = new HostedWorkspaceSessionBroker({
      pingIntervalMs: 0,
      membershipReport: async (binding) => {
        reads.push(binding.organizationId);
        return report(['gone@example.test']);
      },
    });
    const host = new FakeSocket();
    broker.attachConnector(connector, host);
    await tick();
    expect(host.sent[0]).toMatchObject({ type: 'bound', role: 'connector' });
    expect(host.sent[1]).toEqual(report(['gone@example.test']));
    expect(reads).toEqual(['org-1']);

    const plain = new HostedWorkspaceSessionBroker({ pingIntervalMs: 0 });
    const other = new FakeSocket();
    plain.attachConnector(connector, other);
    await tick();
    expect(other.sent.map((frame) => (frame as { type: string }).type)).toEqual(['bound']);
  });

  it('re-reads on its cadence, once per organization, and re-sends only a changed report', async () => {
    let clock = 0;
    let removed = ['gone@example.test'];
    const reads: string[] = [];
    const broker = new HostedWorkspaceSessionBroker({
      pingIntervalMs: 0,
      now: () => clock,
      membershipRefreshMs: 1_000,
      membershipReport: async (binding) => {
        reads.push(binding.organizationId);
        return report(removed);
      },
    });
    const a = new FakeSocket();
    const b = new FakeSocket();
    broker.attachConnector(connector, a);
    broker.attachConnector({ ...connector, customerWorkspaceId: 'workspace-2', hostId: 'host-2' }, b);
    await tick();
    reads.length = 0;

    clock = 999;
    broker.sweepLiveness();
    await tick();
    expect(reads).toEqual([]);

    clock = 1_000;
    broker.sweepLiveness();
    await tick();
    expect(reads).toEqual(['org-1']);
    expect(reports(a)).toHaveLength(1);
    expect(reports(b)).toHaveLength(1);

    removed = ['gone@example.test', 'left@example.test'];
    clock = 2_000;
    broker.sweepLiveness();
    await tick();
    expect(reports(a)).toEqual([report(['gone@example.test']), report(['gone@example.test', 'left@example.test'])]);
    expect(reports(b)).toHaveLength(2);
  });

  it('keeps the connector and sends nothing when the report cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broker = new HostedWorkspaceSessionBroker({
        pingIntervalMs: 0,
        membershipReport: async () => { throw new Error('database unavailable: member-log-canary@example.test'); },
      });
      const host = new FakeSocket();
      broker.attachConnector(connector, host);
      await tick();
      await broker.refreshMembership();
      expect(host.sent.map((frame) => (frame as { type: string }).type)).toEqual(['bound']);
      expect(host.closed).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('membership report'), {
        code: 'connector_unavailable', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('member-log-canary@example.test');
    } finally {
      warn.mockRestore();
    }
  });
});
