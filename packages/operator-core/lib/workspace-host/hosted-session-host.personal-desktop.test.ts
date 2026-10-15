/**
 * Relay authorization for a person's own desktop (plan personal-cloud-desktop-2026-10-06,
 * P-004 — bars R-4, R-10, R-11, R-12, R-13, R-14).
 *
 * The adapter is driven exactly as the relay drives it, over a REAL
 * `createHostedDesktopBackend`: who owns a desktop comes from the lease that backend
 * reads (`leaseOwner`), and the roster is filtered by the backend's own rule. Only the
 * two seams that would touch a machine are faked — the KasmVNC socket (`dial`) and the
 * lease/registry reads — so these tests prove the relay and the backend agree, not
 * that a fake agrees with itself.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  HostedWorkspaceHostSessionAdapter,
  type HostedDesktopBackend,
  type HostedDesktopDialInput,
  type HostedDesktopSocket,
  type HostedHostOutboundEnvelope,
  type HostedHostPty,
} from './hosted-session-host';
import { createHostedDesktopBackend } from './hosted-desktop-backend';
import type { HostedConnectorBinding } from '../endpoint-route/hosted-workspace-connector';
import type { DesktopSessionRecord } from '../desktop/desktop-session-registry';
import type { SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';

const binding: HostedConnectorBinding = {
  controlPlaneWorkspaceId: 'control-1',
  organizationId: 'org-1',
  customerWorkspaceId: 'workspace-1',
  hostId: 'host-1',
  routeLabel: 'alpha',
  generation: 4,
  transport: 'websocket',
  state: 'active',
};

const credentials = {
  view: { user: 'pc-view', secret: 'view-secret' },
  control: { user: 'pc-control', secret: 'control-secret' },
};

const AVI = 'user-avi';
const BEA = 'user-bea';

class FakeSocket implements HostedDesktopSocket {
  readonly sent: Buffer[] = [];
  private readonly events = new EventEmitter();
  send(data: Buffer) {
    this.sent.push(data);
    return true;
  }
  close() {
    this.events.emit('close', 'closed');
  }
  onData(listener: (data: Buffer) => void) {
    this.events.on('data', listener);
    return () => this.events.off('data', listener);
  }
  onClose(listener: (reason: string) => void) {
    this.events.on('close', listener);
    return () => this.events.off('close', listener);
  }
  emitData(data: Buffer) {
    this.events.emit('data', data);
  }
}

class IdlePty extends EventEmitter implements HostedHostPty {
  write() {
    return true;
  }
  resize() {
    return true;
  }
  signal() {
    return true;
  }
  kill() {}
  snapshot() {
    return Promise.resolve('');
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onExit(listener: (code: number, signal: number) => void) {
    this.on('exit', listener);
    return () => this.off('exit', listener);
  }
}

type Scope = DesktopSessionRecord['scope'];

function row(id: string, scope: Scope, scopeRef: string, display: number): DesktopSessionRecord {
  return {
    id,
    scope,
    scopeRef,
    state: 'ready',
    display: `:${display}`,
    displayGeometry: { width: 1280, height: 800, depth: 24 },
    lastActiveAt: null,
    name: null,
  } as unknown as DesktopSessionRecord;
}

function leaseFor(display: number): SandboxDesktop {
  return {
    display: `:${display}`,
    endpoint: { host: '127.0.0.1', port: 6900 + display },
    credentials,
  } as unknown as SandboxDesktop;
}

/**
 * One workspace machine serving an agent desktop, a pot desktop, the workspace desktop
 * and two people's own desktops (Avi's and Bea's).
 */
function personalHost(
  options: {
    ensurePersonalError?: Error;
    withoutPersonalWorker?: boolean;
  } = {},
) {
  const sessions: DesktopSessionRecord[] = [
    row('desktop-agent', 'agent', 'su-agent-1', 21),
    row('desktop-pot', 'pot', 'pot-alpha', 22),
    row('desktop-workspace', 'workspace', 'workspace-1', 23),
    row('desktop-avi', 'user', AVI, 24),
    row('desktop-bea', 'user', BEA, 25),
  ];
  const leases = new Map<string, SandboxDesktop>(
    sessions.map((session) => [session.id, leaseFor(Number(session.display.slice(1)))]),
  );
  const ensured: string[] = [];
  const real = createHostedDesktopBackend({
    leasedDesktop: (id) => leases.get(id),
    leaseOwner: (id) => {
      const session = sessions.find((entry) => entry.id === id);
      return session ? { scope: session.scope, scopeRef: session.scopeRef } : undefined;
    },
    listSessions: async () => sessions,
    touchSession: async () => {},
    ensureDesktop: async () => 'desktop-workspace',
    ...(options.withoutPersonalWorker
      ? {}
      : {
          ensurePersonalDesktop: async (userId: string) => {
            ensured.push(userId);
            if (options.ensurePersonalError) throw options.ensurePersonalError;
            return `desktop-${userId.replace(/^user-/, '')}`;
          },
        }),
    captureDir: '/nonexistent-personal-desktop-capture',
    grabThumbnail: async (display) => Buffer.from(`jpeg-display-${display}`),
  });
  const dials: HostedDesktopDialInput[] = [];
  const sockets: FakeSocket[] = [];
  // Only the dial is replaced: lookup, roster, thumbnail and startPersonal are the real
  // backend's, so ownership is decided by the same code the host runs.
  const backend: HostedDesktopBackend = {
    ...real,
    dial: async (input) => {
      dials.push(input);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  };

  const sent: HostedHostOutboundEnvelope[] = [];
  const audit = vi.fn();
  const warnings = vi.fn();
  const adapter = new HostedWorkspaceHostSessionAdapter({
    binding,
    workspaceRoot: '/nonexistent-personal-desktop-root',
    send: (message) => sent.push(message),
    onAudit: audit,
    onWarning: warnings,
    createPty: () => new IdlePty(),
    desktop: backend,
  });

  const openDesktop = (channelId: string, userId: string, role: 'controller' | 'observer', desktopSessionId: string) =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId,
      hostedSessionId: `session-${userId}`,
      audience: 'workspace-operator',
      role,
      kind: 'desktop',
      desktopSessionId,
    });
  const openTerminal = (channelId: string, userId: string, role: 'controller' | 'observer' = 'controller') =>
    adapter.accept({
      type: 'relay.open',
      channelId,
      userId,
      hostedSessionId: `session-${userId}`,
      audience: 'workspace-operator',
      role,
    });
  const relay = (channelId: string, payload: unknown) => adapter.accept({ type: 'relay', channelId, payload });
  const payloads = (channelId: string) =>
    sent
      .filter((message) => message.type === 'relay' && message.channelId === channelId)
      .map((message) => (message as { payload: unknown }).payload);
  const closes = (channelId: string) =>
    sent.filter((message) => message.type === 'relay.close' && message.channelId === channelId);
  const auditEvents = () =>
    audit.mock.calls.map((call) => call[0] as { action: string; userId: string; channelId?: string; detail?: string });

  return { adapter, sent, dials, sockets, ensured, openDesktop, openTerminal, relay, payloads, closes, auditEvents, warnings };
}

describe('personal desktop relay authorization (personal-cloud-desktop-2026-10-06 P-004)', () => {
  describe('R-10 — the owner can watch their own desktop', () => {
    it("accepts the owner's watch open with the view credential and streams the desktop", async () => {
      const host = personalHost();
      await host.openDesktop('watch-avi', AVI, 'observer', 'desktop-avi');

      expect(host.dials).toHaveLength(1);
      expect(host.dials[0]).toMatchObject({ desktopSessionId: 'desktop-avi' });
      expect(host.dials[0].grant).toMatchObject({ action: 'watch', user: 'pc-view', inputAllowed: false });
      expect(host.payloads('watch-avi')).toContainEqual({ type: 'desktop.ready', action: 'watch', inputAllowed: false });
      expect(host.closes('watch-avi')).toEqual([]);

      // "Streams": a frame from the desktop reaches the owner's viewer byte-exactly.
      host.sockets[0].emitData(Buffer.from('rfb-frame'));
      expect(host.payloads('watch-avi')).toContainEqual({
        type: 'desktop.data',
        data: Buffer.from('rfb-frame').toString('base64'),
      });
    });
  });

  describe('R-11 — the owner can take control of their own desktop', () => {
    it("accepts the owner's takeover open with the CONTROL credential, not downgraded to watch", async () => {
      const host = personalHost();
      await host.openDesktop('take-avi', AVI, 'controller', 'desktop-avi');

      expect(host.dials).toHaveLength(1);
      expect(host.dials[0].grant).toMatchObject({ action: 'takeover', user: 'pc-control', inputAllowed: true });
      expect(host.payloads('take-avi')).toContainEqual({ type: 'desktop.ready', action: 'takeover', inputAllowed: true });

      // Input flows from the owner to the desktop.
      await host.relay('take-avi', { type: 'desktop.data', data: Buffer.from('rfb-key').toString('base64') });
      expect(host.sockets[0].sent.map((buffer) => buffer.toString())).toEqual(['rfb-key']);
    });
  });

  describe('R-4 — nobody else can open (watch) a personal desktop', () => {
    it("refuses another person's watch open with desktop_not_owner and never dials", async () => {
      const host = personalHost();
      await host.openDesktop('watch-bea', BEA, 'observer', 'desktop-avi');

      expect(host.dials).toEqual([]);
      expect(host.closes('watch-bea')).toEqual([{ type: 'relay.close', channelId: 'watch-bea', reason: 'desktop_not_owner' }]);
      expect(host.payloads('watch-bea')).not.toContainEqual(expect.objectContaining({ type: 'desktop.ready' }));
    });
  });

  describe('R-12 — nobody else can take control of a personal desktop', () => {
    it("refuses another person's takeover open with desktop_not_owner; the control secret never leaves", async () => {
      const host = personalHost();
      await host.openDesktop('take-bea', BEA, 'controller', 'desktop-avi');

      expect(host.dials).toEqual([]);
      expect(host.closes('take-bea')).toEqual([{ type: 'relay.close', channelId: 'take-bea', reason: 'desktop_not_owner' }]);
      expect(JSON.stringify(host.sent)).not.toContain('control-secret');
    });

    it('refuses a non-owner even when the desktop is already open for its owner', async () => {
      const host = personalHost();
      await host.openDesktop('take-avi', AVI, 'controller', 'desktop-avi');
      await host.openDesktop('take-bea', BEA, 'controller', 'desktop-avi');

      expect(host.dials).toHaveLength(1);
      expect(host.closes('take-bea')).toEqual([{ type: 'relay.close', channelId: 'take-bea', reason: 'desktop_not_owner' }]);
      expect(host.closes('take-avi')).toEqual([]);
    });
  });

  describe('R-13 — a refused personal-desktop open is audited', () => {
    it('emits operation_denied naming the channel and the refused operation, for watch and takeover alike', async () => {
      const host = personalHost();
      await host.openDesktop('watch-bea', BEA, 'observer', 'desktop-avi');
      await host.openDesktop('take-bea', BEA, 'controller', 'desktop-avi');

      const denied = host.auditEvents().filter((event) => event.action === 'operation_denied');
      expect(denied).toEqual([
        expect.objectContaining({
          userId: BEA,
          channelId: 'watch-bea',
          detail: 'desktop.watch desktop=desktop-avi desktop_not_owner',
        }),
        expect.objectContaining({
          userId: BEA,
          channelId: 'take-bea',
          detail: 'desktop.takeover desktop=desktop-avi desktop_not_owner',
        }),
      ]);
      // A refusal never also records a session start.
      expect(host.auditEvents().map((event) => event.action)).not.toContain('desktop_watch_started');
      expect(host.auditEvents().map((event) => event.action)).not.toContain('desktop_takeover_started');
    });
  });

  describe('R-14 — rosters hide other people\'s personal desktops', () => {
    it("lists agent, pot and workspace desktops plus the viewer's own, and nobody else's", async () => {
      const host = personalHost();
      await host.openTerminal('term-avi', AVI);
      await host.openTerminal('term-bea', BEA);
      await host.relay('term-avi', { type: 'desktop.roster', requestId: 'r-avi' });
      await host.relay('term-bea', { type: 'desktop.roster', requestId: 'r-bea' });

      const rosterIds = (channelId: string) => {
        const result = host
          .payloads(channelId)
          .find((payload) => (payload as { type?: string }).type === 'desktop.roster.result') as
          | { desktops: Array<{ desktopSessionId: string }> }
          | undefined;
        return result?.desktops.map((desktop) => desktop.desktopSessionId).sort();
      };
      expect(rosterIds('term-avi')).toEqual(['desktop-agent', 'desktop-avi', 'desktop-pot', 'desktop-workspace']);
      expect(rosterIds('term-bea')).toEqual(['desktop-agent', 'desktop-bea', 'desktop-pot', 'desktop-workspace']);
    });

    it("refuses another person's thumbnail with desktop_not_owner and serves the owner's", async () => {
      const host = personalHost();
      await host.openTerminal('term-avi', AVI);
      await host.openTerminal('term-bea', BEA);
      await host.relay('term-bea', { type: 'desktop.thumbnail', requestId: 't-bea', desktopSessionId: 'desktop-avi' });
      await host.relay('term-avi', { type: 'desktop.thumbnail', requestId: 't-avi', desktopSessionId: 'desktop-avi' });

      expect(host.payloads('term-bea')).toContainEqual({
        type: 'operation.error',
        requestId: 't-bea',
        operation: 'desktop.thumbnail',
        code: 'desktop_not_owner',
      });
      expect(host.payloads('term-avi')).toContainEqual(
        expect.objectContaining({ type: 'desktop.thumbnail.result', requestId: 't-avi', desktopSessionId: 'desktop-avi' }),
      );
      expect(host.auditEvents()).toContainEqual(
        expect.objectContaining({ action: 'operation_denied', channelId: 'term-bea', detail: 'desktop.thumbnail desktop=desktop-avi desktop_not_owner' }),
      );
    });
  });

  describe('control: non-personal desktops are unaffected', () => {
    it('lets any member of the workspace watch and take over an agent desktop', async () => {
      const host = personalHost();
      await host.openDesktop('watch-bea', BEA, 'observer', 'desktop-agent');
      await host.openDesktop('take-avi', AVI, 'controller', 'desktop-agent');

      expect(host.dials.map((dial) => dial.grant.action)).toEqual(['watch', 'takeover']);
      expect(host.closes('watch-bea')).toEqual([]);
      expect(host.closes('take-avi')).toEqual([]);
    });
  });

  describe('desktop.start { personal: true }', () => {
    it("starts the CALLER's own desktop — whose it is comes from the channel, never the payload", async () => {
      const host = personalHost();
      await host.openTerminal('term-avi', AVI);
      await host.relay('term-avi', { type: 'desktop.start', requestId: 's-1', personal: true, userId: BEA });

      expect(host.ensured).toEqual([AVI]);
      expect(host.payloads('term-avi')).toContainEqual({
        type: 'desktop.start.result',
        requestId: 's-1',
        desktop: expect.objectContaining({ desktopSessionId: 'desktop-avi', scope: 'user', owner: AVI }),
      });
      expect(host.auditEvents()).toContainEqual(
        expect.objectContaining({ action: 'desktop_started', userId: AVI, detail: 'desktop=desktop-avi personal' }),
      );
    });

    it('refuses an observer — watching never starts a desktop, personal or not', async () => {
      const host = personalHost();
      await host.openTerminal('term-avi', AVI, 'observer');
      await host.relay('term-avi', { type: 'desktop.start', requestId: 's-1', personal: true });

      expect(host.ensured).toEqual([]);
      expect(host.payloads('term-avi')).toContainEqual({
        type: 'operation.error',
        requestId: 's-1',
        operation: 'desktop.start',
        code: 'controller_required',
      });
    });

    it('reports personal_desktop_unavailable when the machine has no personal desktop worker', async () => {
      const unavailable = Object.assign(new Error('no personal worker'), { code: 'personal_desktop_unavailable' });
      const host = personalHost({ ensurePersonalError: unavailable });
      await host.openTerminal('term-avi', AVI);
      await host.relay('term-avi', { type: 'desktop.start', requestId: 's-1', personal: true });

      expect(host.payloads('term-avi')).toContainEqual({
        type: 'operation.error',
        requestId: 's-1',
        operation: 'desktop.start',
        code: 'personal_desktop_unavailable',
      });
      expect(host.warnings).not.toHaveBeenCalled();
    });

    it('reports personal_desktop_unavailable when the backend serves no personal desktops at all', async () => {
      const host = personalHost({ withoutPersonalWorker: true });
      await host.openTerminal('term-avi', AVI);
      await host.relay('term-avi', { type: 'desktop.start', requestId: 's-1', personal: true });

      expect(host.payloads('term-avi')).toContainEqual({
        type: 'operation.error',
        requestId: 's-1',
        operation: 'desktop.start',
        code: 'personal_desktop_unavailable',
      });
    });
  });
});
