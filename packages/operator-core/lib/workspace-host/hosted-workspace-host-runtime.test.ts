import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createHostedWorkspaceHostRuntime,
  ensureHostedWorkspaceHostRuntime,
  readHostedWorkspaceHostConfig,
  registerHostedCustomerWorkspace,
  __resetHostedWorkspaceHostRuntime,
  defaultHostedAudit,
  defaultRelayUsageReport,
  defaultMembershipReport,
} from './hosted-workspace-host-runtime';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRegistry } from '../workspace-registry';
import { hostedDesktopAuditRow, isHostedDesktopAuditAction } from '../desktop/desktop-audit';
import * as desktopAudit from '../desktop/desktop-audit';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { HostedWorkspaceConnectorClient, type HostedConnectorClientSocket } from './hosted-connector-client';
import { HOSTED_HOST_SESSION_IDLE_MS, type HostedHostAuditEvent, type HostedHostPty } from './hosted-session-host';
import SecretStream from '@hyperswarm/secret-stream';
import { ByocSealedChannel } from './byoc-sealed-channel';

vi.mock('../connected-apps/alert-sweep', () => ({
  onRelayUsageReported: () => Promise.reject(new Error('CUSTOMER_REPORT_CONTENT_5e18')),
}));
vi.mock('../connected-apps/membership-report', () => ({
  onMembershipReported: () => Promise.reject(new Error('CUSTOMER_REPORT_CONTENT_5e18')),
}));

it('keeps default audit and report failure consoles free of database binding and arbitrary error content', async () => {
  const marker = 'CUSTOMER_AUDIT_CONTENT_a7bf';
  const error = new DrizzleQueryError('insert into audit_log values ($1)', [marker], new Error(marker));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const audit = vi.spyOn(desktopAudit, 'recordDesktopAudit').mockImplementation((_event, deps) => { deps!.onError!(error); });
  try {
    defaultHostedAudit({ action: 'desktop_watch_started', organizationId: 'org_1', customerWorkspaceId: 'cust_1',
      hostId: 'host_1', generation: 1, detail: marker });
    defaultRelayUsageReport('cust_1', { bytes: 42 });
    defaultMembershipReport({ customerWorkspaceId: 'cust_1' });
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(3));
    expect(warning.mock.calls).toEqual(expect.arrayContaining([
      ['[hosted-workspace-host] audit write failed:', 'desktop_audit_write_failed'],
      ['[hosted-workspace-host] relay usage report failed:', 'relay_usage_report_failed'],
      ['[hosted-workspace-host] membership report failed:', 'membership_report_failed'],
    ]));
    expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(warning.mock.calls)).not.toContain('CUSTOMER_REPORT_CONTENT_5e18');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('insert into');
  } finally { audit.mockRestore(); warning.mockRestore(); }
});

class FakePty extends EventEmitter implements HostedHostPty {
  killed = false;
  write() {
    return !this.killed;
  }
  resize() {
    return !this.killed;
  }
  signal() {
    return !this.killed;
  }
  kill() {
    this.killed = true;
  }
  snapshot(): Promise<string | null> {
    return Promise.resolve(null);
  }
  onData(listener: (data: Buffer) => void) {
    this.on('data', listener);
    return () => this.off('data', listener);
  }
  onExit(listener: (code: number, signal: number) => void) {
    this.on('exit', listener);
    return () => this.off('exit', listener);
  }
  output(value: string) {
    this.emit('data', Buffer.from(value));
  }
}

class FakeSocket implements HostedConnectorClientSocket {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {};
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  on(event: string, listener: (...args: never[]) => void): unknown {
    (this.listeners[event] ??= []).push(listener);
    return this;
  }
  private emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
  emitOpen(): void {
    this.readyState = this.OPEN;
    this.emit('open');
  }
  emitMessage(value: unknown): void {
    this.emit('message', JSON.stringify(value), false);
  }
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code, '');
  }
  /** The control plane's keepalive ping (it sends one every 30s on a healthy link). */
  emitPing(): void {
    this.emit('ping');
  }
}

const BINDING = {
  controlPlaneWorkspaceId: 'cp',
  organizationId: 'org_1',
  customerWorkspaceId: 'cust_1',
  hostId: 'host_1',
  routeLabel: 'acme',
  generation: 3,
  transport: 'websocket',
  state: 'active',
};

function runtime(overrides: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const audits: HostedHostAuditEvent[] = [];
  const terminal: Array<{ reason: string; detail: string }> = [];
  const value = createHostedWorkspaceHostRuntime({
    url: 'wss://cp/api/hosted/connectors/socket',
    bearer: 'b',
    workspaceRoot: '/srv/workspace',
    onAudit: (event) => audits.push(event),
    onTerminal: (reason, detail) => terminal.push({ reason, detail }),
    onWarning: () => {},
    createClient: (options) =>
      new HostedWorkspaceConnectorClient({
        ...options,
        minBackoffMs: 10,
        random: () => 1,
        createSocket: (url, headers) => {
          const socket = new FakeSocket(url, headers);
          sockets.push(socket);
          return socket;
        },
      }),
    ...overrides,
  });
  return { value, sockets, audits, terminal };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('readHostedWorkspaceHostConfig', () => {
  const full = {
    PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b',
    PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
    PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/workspace',
  };

  it('derives the socket url from a bare origin and forces a secure transport', () => {
    expect(readHostedWorkspaceHostConfig(full as NodeJS.ProcessEnv)).toEqual({
      url: 'wss://app.papercusp.com/api/hosted/connectors/socket',
      bearer: 'b',
      workspaceRoot: '/srv/workspace',
    });
  });

  it('keeps an explicitly configured path', () => {
    const config = readHostedWorkspaceHostConfig({
      ...full,
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com/api/hosted/connectors/socket',
    } as NodeJS.ProcessEnv);
    expect(config?.url).toBe('wss://app.papercusp.com/api/hosted/connectors/socket');
  });

  it('is null — not an error — when this host is simply not enrolled', () => {
    // The normal answer on a dev box and on the control plane itself. Absence of an
    // enrollment is not a misconfiguration, so it must not throw or warn.
    expect(readHostedWorkspaceHostConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readHostedWorkspaceHostConfig({ ...full, PAPERCUSP_HOSTED_CONNECTOR_BEARER: '  ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('is null for an unparseable url rather than dialling something wrong', () => {
    expect(
      readHostedWorkspaceHostConfig({ ...full, PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'not a url' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('hostedDesktopAuditRow', () => {
  const base: HostedHostAuditEvent = {
    action: 'desktop_takeover_started',
    organizationId: 'org_1',
    customerWorkspaceId: 'cust_1',
    hostId: 'host_1',
    generation: 3,
    userId: 'user_7',
    hostedSessionId: 's1',
    channelId: 'c1',
    detail: 'desktop=ds_1',
  };

  it('files a hosted takeover in the SHARED desktop namespace', () => {
    // The whole point: one `frame-vnc.takeover-started` filter must find frame,
    // local AND hosted takeovers. A hosted-only namespace would silently answer for
    // part of the population, which looks identical to a quiet week.
    const row = hostedDesktopAuditRow(base);
    expect(row.action).toBe('frame-vnc.takeover-started');
    expect(row.subject).toBe('hosted:host_1:c1');
    expect(row.details).toMatchObject({ target: 'hosted', generation: 3, userId: 'user_7' });
  });

  it('files a hosted watch in the same namespace', () => {
    expect(hostedDesktopAuditRow({ ...base, action: 'desktop_watch_started' }).action).toBe('frame-vnc.watch-started');
  });

  it('attributes the row to the browser principal, keeping the host in details', () => {
    expect(hostedDesktopAuditRow(base).actor).toBe('user_7');
    const { userId: _drop, ...withoutUser } = base;
    expect(hostedDesktopAuditRow(withoutUser).actor).toBe('host:host_1');
  });

  it('keeps NON-desktop relay events out of the desktop namespace', () => {
    // A PTY attach is a different population; folding it in would pollute the very
    // filter the shared namespace protects.
    expect(hostedDesktopAuditRow({ ...base, action: 'pty_attached' }).action).toBe('hosted-relay.pty_attached');
    expect(hostedDesktopAuditRow({ ...base, action: 'desktop_denied' }).action).toBe('hosted-relay.desktop_denied');
  });

  it('recognises only the two desktop viewer events, never an inherited key', () => {
    expect(isHostedDesktopAuditAction('desktop_takeover_started')).toBe(true);
    expect(isHostedDesktopAuditAction('desktop_watch_started')).toBe(true);
    expect(isHostedDesktopAuditAction('pty.input')).toBe(false);
    expect(isHostedDesktopAuditAction('constructor')).toBe(false);
    expect(hostedDesktopAuditRow({ ...base, action: 'constructor' }).action).toBe('hosted-relay.constructor');
  });
});

describe('createHostedWorkspaceHostRuntime', () => {
  it.each(['default', 'custom'] as const)(
    'keeps supported hosted customer filesystem faults out of the %s warning sink',
    async (sink) => {
      vi.useRealTimers();
      const marker = 'BYOC_CUSTOMER_PATH_6ae2';
      const root = mkdtempSync(join(tmpdir(), 'byoc-warning-'));
      const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const customWarning = vi.fn();
      const faults: NodeJS.ErrnoException[] = [];
      const hostKey = SecretStream.keyPair(Buffer.alloc(32, 51));
      let releaseSnapshot!: () => void;
      const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
      // An actual OS fault, not an Error marker injected into adapter.accept.
      const customerFile = async (path: string) => {
        try { return await readFile(join(root, path), 'utf8'); }
        catch (error) { faults.push(error as NodeJS.ErrnoException); throw error; }
      };
      const pty = new FakePty();
      const snapshot = vi.spyOn(pty, 'snapshot').mockImplementation(async () => {
        await snapshotReady;
        return customerFile(marker);
      });
      const lookup = vi.fn(async (id: string) => { await customerFile(id); return null; });
      const { value, sockets } = runtime({
        workspaceRoot: root,
        onWarning: sink === 'default' ? undefined : customWarning,
        createPty: () => pty,
        loadMachineNoiseKeyPair: async () => hostKey,
        desktop: { lookup, thumbnail: async () => null },
      });
      try {
        value.start();
        await new Promise<void>((resolve) => setImmediate(resolve));
        const socket = sockets[0]!;
        socket.emitOpen();
        socket.emitMessage({ type: 'bound', role: 'connector', binding: { ...BINDING, hosting: 'byoc' } });
        const open = { type: 'relay.open', channelId: 'warning-ch', userId: 'u', hostedSessionId: 's',
          audience: 'workspace-operator', role: 'controller', kind: 'pty' };
        socket.emitMessage(open);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: 'relay.close', channelId: 'warning-ch', reason: 'byoc_plaintext_relay_refused',
        });
        expect(snapshot).not.toHaveBeenCalled();
        expect(faults).toEqual([]);

        // The production composition root currently supplies a paired-phone key
        // resolver only for device-http. Do not claim this PTY is a usable BYOC
        // content path (installed-path follow-up EI-25861548830571123).
        socket.emitMessage({ ...open, sealed: true });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(socket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
          type: 'relay.close', channelId: 'warning-ch', reason: 'sealed_channel_unavailable',
        });
        expect(snapshot).not.toHaveBeenCalled();
        expect(faults).toEqual([]);

        // The same runtime/warning writer serves a supported hosted customer
        // channel. Only the filesystem dependency is faulted, not accept().
        socket.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
        socket.emitMessage(open);
        releaseSnapshot();
        const warning = sink === 'default' ? consoleWarning : customWarning;
        await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
        // The second fault is derived from the customer's actual request.
        socket.emitMessage({ type: 'relay', channelId: 'warning-ch', payload: {
          type: 'desktop.thumbnail', requestId: 'r1', desktopSessionId: marker,
        } });
        await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2));
        expect(lookup).toHaveBeenCalledWith(marker);
        expect(faults).toHaveLength(2);
        for (const fault of faults) {
          expect(fault.code).toBe('ENOENT');
          expect(fault.message).toContain(marker);
        }
        expect(warning.mock.calls).toEqual(sink === 'default' ? [
          ['[hosted-workspace-host] envelope_failed'],
          ['[hosted-workspace-host] desktop_query_failed'],
        ] : [['envelope_failed'], ['desktop_query_failed']]);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(marker);
        expect(JSON.stringify(warning.mock.calls)).not.toContain(root);
      } finally {
        releaseSnapshot();
        value.stop();
        snapshot.mockRestore();
        consoleWarning.mockRestore();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('has no adapter until the control plane says who we are', () => {
    const { value, sockets } = runtime();
    expect(value.adapter).toBeNull();
    value.start();
    sockets[0]!.emitOpen();
    // An envelope arriving before `bound` has no binding to be audited against and
    // must be dropped, not served by an adapter with a guessed identity.
    sockets[0]!.emitMessage({ type: 'relay.open', channelId: 'c1', userId: 'u', hostedSessionId: 's', audience: 'workspace-operator', role: 'controller' });
    expect(value.adapter).toBeNull();
    expect(value.binding).toBeNull();
  });

  it('builds the adapter on bound and adopts the control plane binding', () => {
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    expect(value.adapter).not.toBeNull();
    expect(value.binding).toMatchObject({ generation: 3, hostId: 'host_1' });
  });

  it('REBUILDS the adapter on a reconnect that carries a new generation', () => {
    // An adapter outliving its binding would keep stamping channels with a
    // superseded generation — exactly what the generation exists to prevent.
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    const first = value.adapter;
    sockets[0]!.emitClose(1006);
    expect(value.adapter).toBeNull();
    vi.advanceTimersByTime(10);
    sockets[1]!.emitOpen();
    sockets[1]!.emitMessage({ type: 'bound', role: 'connector', binding: { ...BINDING, generation: 4 } });
    expect(value.adapter).not.toBe(first);
    expect(value.binding).toMatchObject({ generation: 4 });
  });

  it('drops the adapter and reports terminal when the binding is revoked', () => {
    const { value, sockets, terminal } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    sockets[0]!.emitClose(4001);
    vi.advanceTimersByTime(60_000);
    expect(value.adapter).toBeNull();
    expect(value.binding).toBeNull();
    expect(terminal).toEqual([{ reason: 'revoked', detail: '4001' }]);
    expect(sockets).toHaveLength(1);
  });

  it('sends the adapter output back over the connector socket', async () => {
    const { value, sockets } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    // No desktop backend was supplied, so a desktop open is REFUSED rather than
    // opening a channel that could never carry pixels.
    await value.adapter!.accept({
      type: 'relay.open',
      channelId: 'c1',
      userId: 'u',
      hostedSessionId: 's',
      audience: 'workspace-operator',
      role: 'controller',
      kind: 'desktop',
      desktopSessionId: 'ds_1',
    });
    const frames = sockets[0]!.sent.map((raw) => JSON.parse(raw));
    expect(frames).toContainEqual({ type: 'relay.close', channelId: 'c1', reason: 'desktop_unsupported' });
  });

  it('is wired into boot: ensure() dials once, is idempotent, and no-ops when unenrolled', () => {
    // The point of this test is the WIRING, not the config parse. WI-1064431 was
    // exactly this defect one layer down — a correct adapter that nothing ever
    // constructed — so a runtime with no live caller would just move the gap up.
    __resetHostedWorkspaceHostRuntime();
    const sockets: FakeSocket[] = [];
    const env = {
      PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b',
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
      PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/workspace',
    } as NodeJS.ProcessEnv;
    const overrides = {
      // Supplied so the composition root does not reach for the live registry.
      desktop: {
        lookup: async () => null,
        dial: async () => {
          throw new Error('unused');
        },
        heartbeat: () => {},
        roster: async () => [],
        thumbnail: async () => null,
        start: async () => null,
      },
      createClient: (options: ConstructorParameters<typeof HostedWorkspaceConnectorClient>[0]) =>
        new HostedWorkspaceConnectorClient({
          ...options,
          minBackoffMs: 10,
          random: () => 1,
          createSocket: (url, headers) => {
            const socket = new FakeSocket(url, headers);
            sockets.push(socket);
            return socket;
          },
        }),
    };

    // Unenrolled is the normal state on a dev box and the control plane: silent null.
    expect(ensureHostedWorkspaceHostRuntime({} as NodeJS.ProcessEnv, overrides)).toBeNull();
    expect(sockets).toHaveLength(0);

    const first = ensureHostedWorkspaceHostRuntime(env, overrides);
    expect(first).not.toBeNull();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.headers.Authorization).toBe('Bearer b');

    // Idempotent: a second boot-path call (or a module re-evaluation) must not open a
    // SECOND connector under one enrollment — the broker keys connectors by binding,
    // so two would silently evict each other rather than erroring.
    expect(ensureHostedWorkspaceHostRuntime(env, overrides)).toBe(first);
    expect(sockets).toHaveLength(1);
    __resetHostedWorkspaceHostRuntime();
  });

  describe('a control-plane outage does not kill the customer PTY (P-318 J5, D-392)', () => {
    const openPty = (channelId: string) => ({
      type: 'relay.open',
      channelId,
      userId: 'u',
      hostedSessionId: 's',
      audience: 'workspace-operator',
      role: 'controller',
    });

    function withPtys(overrides: Record<string, unknown> = {}) {
      const ptys: FakePty[] = [];
      const harness = runtime({
        createPty: () => {
          const pty = new FakePty();
          ptys.push(pty);
          return pty;
        },
        ...overrides,
      });
      return { ...harness, ptys };
    }

    /** The control plane is DOWN: every reconnect attempt made during `ms` fails. */
    function outage(sockets: FakeSocket[], ms: number): void {
      sockets.at(-1)!.emitClose(1006);
      for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
        vi.advanceTimersByTime(5_000);
        const latest = sockets.at(-1)!;
        if (latest.readyState === 0) latest.emitClose(1006);
      }
    }

    /** The control plane is back: the next attempt connects and is bound. */
    function recover(sockets: FakeSocket[], binding: Record<string, unknown> = BINDING): FakeSocket {
      const before = sockets.length;
      for (let i = 0; i < 200 && sockets.length === before; i += 1) vi.advanceTimersByTime(1_000);
      const socket = sockets.at(-1)!;
      expect(sockets.length).toBeGreaterThan(before);
      socket.emitOpen();
      socket.emitMessage({ type: 'bound', role: 'connector', binding });
      return socket;
    }

    /**
     * Keep a connected link healthy for `ms`: the control plane pings every 30s, and
     * the connector's liveness watchdog (P-002) drops a link that stays silent for 75s.
     */
    function liveFor(socket: FakeSocket, ms: number): void {
      for (let elapsed = 0; elapsed < ms; ) {
        const step = Math.min(30_000, ms - elapsed);
        vi.advanceTimersByTime(step);
        elapsed += step;
        socket.emitPing();
      }
    }

    it('keeps a running PTY alive through an outage longer than the idle window and resumes it', async () => {
      const { value, sockets, ptys } = withPtys();
      value.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
      await value.adapter!.accept(openPty('c1'));
      expect(ptys).toHaveLength(1);

      outage(sockets, HOSTED_HOST_SESSION_IDLE_MS * 4);
      // The agent in the terminal kept working the whole time; its output has nowhere to go.
      expect(() => ptys[0]!.output('still working')).not.toThrow();
      expect(ptys[0]!.killed).toBe(false);

      const socket = recover(sockets, { ...BINDING, generation: 4 });
      await value.adapter!.accept(openPty('c2'));
      // RESUMED, not respawned: the same process, re-attached under the new generation.
      expect(ptys).toHaveLength(1);
      const frames = () => socket.sent.map((raw) => JSON.parse(raw));
      expect(frames()).toContainEqual(
        expect.objectContaining({ type: 'relay', channelId: 'c2', payload: expect.objectContaining({ type: 'pty.ready', resumed: true }) }),
      );
      ptys[0]!.output('done');
      expect(frames()).toContainEqual({
        type: 'relay',
        channelId: 'c2',
        payload: { type: 'pty.output', data: Buffer.from('done').toString('base64') },
      });
    });

    it('restarts the idle window on adoption: an unclaimed PTY expires idleMs after the control plane returns', async () => {
      const { value, sockets, ptys } = withPtys();
      value.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
      await value.adapter!.accept(openPty('c1'));
      outage(sockets, HOSTED_HOST_SESSION_IDLE_MS * 2);
      const socket = recover(sockets);
      liveFor(socket, HOSTED_HOST_SESSION_IDLE_MS - 1);
      expect(ptys[0]!.killed).toBe(false);
      vi.advanceTimersByTime(2);
      expect(ptys[0]!.killed).toBe(true);
    });

    it('kills held PTYs when the returning binding names a DIFFERENT connector identity', async () => {
      const { value, sockets, ptys } = withPtys();
      value.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
      await value.adapter!.accept(openPty('c1'));
      outage(sockets, 30_000);
      recover(sockets, { ...BINDING, hostId: 'host_2' });
      expect(ptys[0]!.killed).toBe(true);
      await value.adapter!.accept(openPty('c2'));
      expect(ptys).toHaveLength(2);
    });

    it('kills held PTYs when the binding is revoked during the outage', async () => {
      const { value, sockets, ptys, terminal } = withPtys();
      value.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
      await value.adapter!.accept(openPty('c1'));
      sockets[0]!.emitClose(1006);
      expect(ptys[0]!.killed).toBe(false);
      vi.advanceTimersByTime(1_000);
      sockets.at(-1)!.emitClose(4001);
      expect(terminal).toEqual([{ reason: 'revoked', detail: '4001' }]);
      expect(ptys[0]!.killed).toBe(true);
    });

    it('does not adopt a PTY that exited while nobody was bound', async () => {
      const { value, sockets, ptys } = withPtys();
      value.start();
      sockets[0]!.emitOpen();
      sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
      await value.adapter!.accept(openPty('c1'));
      outage(sockets, 30_000);
      ptys[0]!.emit('exit', 0, 0);
      recover(sockets);
      await value.adapter!.accept(openPty('c2'));
      expect(ptys).toHaveLength(2);
    });
  });

  it('stop() closes the adapter and never reconnects', () => {
    const { value, sockets, terminal } = runtime();
    value.start();
    sockets[0]!.emitOpen();
    sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    value.stop('host_stopped');
    expect(value.adapter).toBeNull();
    expect(terminal).toEqual([{ reason: 'stopped', detail: 'host_stopped' }]);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

// D-013 #6: the runtime hands every adapter it builds the machine Noise key (the one the pair
// QR advertises) and a device lookup scoped to the BOUND customer workspace, which is where
// pairing stored the phone. Without this wiring the session-host's sealed channel is dead code.
describe('sealed device-http channel wiring (D-013 #6)', () => {
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 31));
  const phoneKey = SecretStream.keyPair(Buffer.alloc(32, 41));
  const OPEN = { type: 'relay.open', channelId: 'dev-ch', kind: 'device-http', audience: 'device', sealed: true } as const;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => vi.useRealTimers());

  async function boundRuntime(overrides: Record<string, unknown>) {
    const r = runtime(overrides);
    r.value.start();
    await tick(); // the machine key load settles before the binding arrives
    r.sockets[0]!.emitOpen();
    r.sockets[0]!.emitMessage({ type: 'bound', role: 'connector', binding: BINDING });
    const frames = () =>
      r.sockets[0]!.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>).filter((f) => f.channelId === 'dev-ch');
    return { ...r, frames };
  }

  it('serves no sealed channel when the machine key is disabled', async () => {
    const find = vi.fn(async () => 'dev-a');
    const { value, frames } = await boundRuntime({ loadMachineNoiseKeyPair: null, findDeviceIdByNoiseKey: find });
    await value.adapter!.accept(OPEN);
    expect(frames()).toContainEqual({ type: 'relay.close', channelId: 'dev-ch', reason: 'sealed_channel_unavailable' });
    expect(find).not.toHaveBeenCalled();
    value.stop();
  });

  it("completes the phone's handshake with the machine key and resolves the device in the BOUND workspace", async () => {
    const find = vi.fn(async (_workspaceId: string, key: string) =>
      (key === phoneKey.publicKey.toString('base64') ? 'dev-a' : null));
    const { value, frames } = await boundRuntime({ loadMachineNoiseKeyPair: async () => hostKey, findDeviceIdByNoiseKey: find });
    const errors: Error[] = [];
    const phone = new ByocSealedChannel({
      initiator: true,
      localKeyPair: phoneKey,
      expectedRemotePublicKey: hostKey.publicKey,
      sendPacket: (packet) => { void value.adapter!.accept({ type: 'relay', channelId: 'dev-ch', payload: packet as never }); },
      onFrame: () => {},
      onError: (error) => errors.push(error),
    });
    let opened = false;
    void phone.opened.then(() => { opened = true; }, () => {});
    await value.adapter!.accept(OPEN);
    // Deliver the host's packets to the phone one per event, as the websocket relay does.
    let delivered = 0;
    for (let i = 0; i < 200 && (!opened || find.mock.calls.length === 0); i++) {
      const relayed = frames().filter((f) => f.type === 'relay');
      if (delivered < relayed.length) phone.receive(relayed[delivered++]!.payload as never);
      await tick();
    }
    expect(errors).toEqual([]);
    expect(opened).toBe(true);
    expect(find).toHaveBeenCalledWith('cust_1', phoneKey.publicKey.toString('base64'));
    expect(frames()).not.toContainEqual(expect.objectContaining({ type: 'relay.close' }));
    value.stop();
  });
});

// WI-10003163: a hosted host has no desktop shell to run first-run `ensure_initialized()`,
// so the bound customer workspace must become the operator's registered, current workspace.
describe('hosted customer workspace registration (WI-10003163)', () => {
  let root: string;
  let prevRoot: string | undefined;
  beforeEach(() => {
    prevRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
    root = mkdtempSync(join(tmpdir(), 'hosted-ws-registration-'));
    process.env.PAPERCUSP_WORKSPACES_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  const bind = (sockets: FakeSocket[], index: number, binding: Record<string, unknown>) => {
    sockets[index]!.emitOpen();
    sockets[index]!.emitMessage({ type: 'bound', role: 'connector', binding });
  };

  it('registers the bound customer workspace as the current "Default" workspace, once, across rebinds', () => {
    const { value, sockets } = runtime({ onBinding: registerHostedCustomerWorkspace });
    value.start();
    expect(readRegistry()).toEqual({ workspaces: [] });
    bind(sockets, 0, BINDING);
    let reg = readRegistry();
    expect(reg.current).toBe('cust_1');
    expect(reg.workspaces).toEqual([expect.objectContaining({ id: 'cust_1', name: 'Default' })]);
    // The registry entry and its data dir are one invariant (desktop switch() refuses a missing dir).
    expect(existsSync(join(root, 'cust_1'))).toBe(true);

    sockets[0]!.emitClose(1006);
    vi.advanceTimersByTime(10);
    bind(sockets, 1, { ...BINDING, generation: 4 });
    reg = readRegistry();
    expect(reg.workspaces).toHaveLength(1);
    expect(reg.current).toBe('cust_1');
  });

  it.each(['../escape', 'default', 'a/b'])(
    'refuses customer workspace id %j without writing, and still binds the connector',
    (customerWorkspaceId) => {
      const warnings: string[] = [];
      const { value, sockets } = runtime({
        onBinding: registerHostedCustomerWorkspace,
        onWarning: (message: string) => warnings.push(message),
      });
      value.start();
      bind(sockets, 0, { ...BINDING, customerWorkspaceId });
      expect(value.adapter).not.toBeNull();
      expect(readRegistry()).toEqual({ workspaces: [] });
      expect(warnings).toEqual(['binding_hook_failed']);
    },
  );

  it('is the boot default: ensure() registers the workspace on bind without any override', () => {
    __resetHostedWorkspaceHostRuntime();
    const sockets: FakeSocket[] = [];
    const env = {
      PAPERCUSP_HOSTED_CONNECTOR_BEARER: 'b',
      PAPERCUSP_HOSTED_CONTROL_PLANE_URL: 'https://app.papercusp.com',
      PAPERCUSP_HOSTED_WORKSPACE_ROOT: '/srv/workspace',
    } as NodeJS.ProcessEnv;
    const runtimeValue = ensureHostedWorkspaceHostRuntime(env, {
      desktop: {
        lookup: async () => null,
        dial: async () => {
          throw new Error('unused');
        },
        heartbeat: () => {},
        roster: async () => [],
        thumbnail: async () => null,
        start: async () => null,
      },
      onWarning: () => {},
      createClient: (options: ConstructorParameters<typeof HostedWorkspaceConnectorClient>[0]) =>
        new HostedWorkspaceConnectorClient({
          ...options,
          minBackoffMs: 10,
          random: () => 1,
          createSocket: (url, headers) => {
            const socket = new FakeSocket(url, headers);
            sockets.push(socket);
            return socket;
          },
        }),
    });
    expect(runtimeValue).not.toBeNull();
    bind(sockets, 0, BINDING);
    expect(readRegistry().current).toBe('cust_1');
    __resetHostedWorkspaceHostRuntime();
  });
});
