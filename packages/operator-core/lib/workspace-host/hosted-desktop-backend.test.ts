import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  basicAuthHeader,
  createHostedDesktopBackend,
  desktopRecordForLease,
  dialDesktopSocket,
  displayNumber,
  HOSTED_ROSTER_INTENT_MAX_CHARS,
  HOSTED_THUMBNAIL_MAX_AGE_MS,
  KASMVNC_WEBSOCKET_PATH,
  rosterEntryForSession,
  type HostedDesktopWireSocket,
} from './hosted-desktop-backend';
import type { SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import { toRecord, type DesktopSessionRecord } from '../desktop/desktop-session-registry';

class FakeWire implements HostedDesktopWireSocket {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: Buffer[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private readonly listeners: Record<string, Array<(...args: never[]) => void>> = {};

  constructor(readonly url: string, readonly headers: Record<string, string>) {}

  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
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
  emitMessage(data: unknown, isBinary = true): void {
    this.emit('message', data, isBinary);
  }
  emitClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code, '');
  }
  emitError(error: unknown): void {
    this.emit('error', error);
  }
}

function lease(overrides: Partial<SandboxDesktop> = {}): SandboxDesktop {
  return {
    display: ':110',
    width: 1024,
    height: 768,
    xServer: 'kasmvnc',
    endpoint: { host: '127.0.0.1', port: 6910 },
    credentials: {
      passwordFile: '/run/papercusp/desktop/kasmvnc-110.passwd',
      view: { user: 'papercusp-view', secret: 'view-secret' },
      control: { user: 'papercusp-control', secret: 'control-secret' },
      destroy: () => {},
    },
    release: async () => {},
    ...overrides,
  } as unknown as SandboxDesktop;
}

function session(overrides: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds_1',
    display: ':110',
    state: 'ready',
    displayGeometry: { width: 1024, height: 768, depth: 24 },
    lastActiveAt: new Date('2026-08-30T05:00:00.000Z'),
    ...overrides,
  } as unknown as DesktopSessionRecord;
}

describe('displayNumber', () => {
  it('parses an X display string and refuses anything else', () => {
    expect(displayNumber(':110')).toBe(110);
    expect(displayNumber(':0')).toBe(0);
    // A traversal-shaped or malformed value must never reach a capture path.
    expect(displayNumber('110')).toBeNull();
    expect(displayNumber(':../../etc/passwd')).toBeNull();
    expect(displayNumber(':1x')).toBeNull();
    expect(displayNumber(null)).toBeNull();
  });
});

describe('basicAuthHeader', () => {
  it('encodes the grant as HTTP Basic — the one line the privilege boundary rides on', () => {
    expect(basicAuthHeader('papercusp-view', 'sekrit')).toBe(
      `Basic ${Buffer.from('papercusp-view:sekrit').toString('base64')}`,
    );
  });
});

describe('desktopRecordForLease', () => {
  it('passes the endpoint through when this process holds both endpoint and secrets', () => {
    expect(desktopRecordForLease(lease())).toEqual({
      endpoint: { host: '127.0.0.1', port: 6910 },
      credentials: {
        view: { user: 'papercusp-view', secret: 'view-secret' },
        control: { user: 'papercusp-control', secret: 'control-secret' },
      },
    });
  });

  it('refuses an endpoint whose secrets this process does NOT hold', () => {
    // Reachable, not hypothetical: desktop-provisioner sets credentials = null when
    // the caller supplied its own kasmvncPasswordFile. Passing the endpoint through
    // with an empty secret would attempt an UNAUTHENTICATED dial — the one outcome
    // D-020's per-session credential exists to make impossible.
    const record = desktopRecordForLease(lease({ credentials: undefined }));
    expect(record.endpoint).toBeNull();
    expect(record.credentials.control.secret).toBe('');
  });

  it('reports an xvfb desktop as having no endpoint', () => {
    const record = desktopRecordForLease(lease({ endpoint: undefined, credentials: undefined }));
    expect(record.endpoint).toBeNull();
  });
});

describe('rosterEntryForSession', () => {
  it('projects a registry row onto what the picker renders', () => {
    expect(rosterEntryForSession(session())).toEqual({
      desktopSessionId: 'ds_1',
      state: 'ready',
      displayNumber: 110,
      geometry: '1024x768',
      lastActiveAt: '2026-08-30T05:00:00.000Z',
    });
  });

  it('omits a display number it cannot parse rather than emitting a wrong one', () => {
    expect(rosterEntryForSession(session({ display: 'guest' }))).not.toHaveProperty('displayNumber');
  });

  // Plan agent-multi-desktops-grid P-006 / D-009: each grid tile names its owner and
  // the work-item that owner is on now.
  it('labels an agent desktop with its owner, name and the live claim it was handed', () => {
    const entry = rosterEntryForSession(session({ scope: 'agent', scopeRef: 'su-abc', name: 'browser' }), {
      workItemId: 'WI-7',
      intent: `  ${'x'.repeat(HOSTED_ROSTER_INTENT_MAX_CHARS + 40)}  `,
    });
    expect(entry).toMatchObject({ scope: 'agent', owner: 'su-abc', name: 'browser', workItemId: 'WI-7' });
    expect(entry.workItemIntent).toHaveLength(HOSTED_ROSTER_INTENT_MAX_CHARS);
  });

  it('names a pot desktop by its pot and gives the workspace desktop no owner', () => {
    expect(rosterEntryForSession(session({ scope: 'pot', scopeRef: 'my-pot' }))).toMatchObject({
      scope: 'pot',
      owner: 'my-pot',
    });
    const workspaceDesktop = rosterEntryForSession(session({ scope: 'workspace', scopeRef: 'ws-1' }));
    expect(workspaceDesktop.scope).toBe('workspace');
    expect(workspaceDesktop).not.toHaveProperty('owner');
    expect(workspaceDesktop).not.toHaveProperty('workItemId');
  });

  it('carries no work-item when the claim has no intent text, only the id', () => {
    const entry = rosterEntryForSession(session({ scope: 'agent', scopeRef: 'su-abc' }), {
      workItemId: 'WI-8',
      intent: '   ',
    });
    expect(entry.workItemId).toBe('WI-8');
    expect(entry).not.toHaveProperty('workItemIntent');
  });

  // D-405: the production client returns timestamptz as TEXT, so the first real row
  // threw here and failed every desktop.start on a hosted machine whose desktop was up.
  it('renders a registry row whose timestamps arrived from Postgres as text', () => {
    const record = toRecord({
      id: 'ds_text',
      workspace_id: 'ws',
      kind: 'kasmvnc',
      scope: 'pot',
      scope_ref: 'hosted-workspace',
      display: ':110',
      display_width: 1024,
      display_height: 768,
      display_depth: 24,
      capture_width: 1024,
      capture_height: 768,
      state: 'ready',
      viewer_mode: 'none',
      created_at: '2026-09-23 16:02:43.5+00',
      last_active_at: '2026-09-23 16:02:46.25+00',
      frozen_at: null,
      released_at: '2026-09-23 17:00:00+00',
    });

    expect(record.lastActiveAt).toBeInstanceOf(Date);
    expect(record.createdAt.toISOString()).toBe('2026-09-23T16:02:43.500Z');
    expect(record.releasedAt?.toISOString()).toBe('2026-09-23T17:00:00.000Z');
    expect(record.frozenAt).toBeNull();
    expect(rosterEntryForSession(record)).toMatchObject({
      desktopSessionId: 'ds_text',
      lastActiveAt: '2026-09-23T16:02:46.250Z',
    });
  });
});

describe('dialDesktopSocket', () => {
  const dialInput = {
    desktopSessionId: 'ds_1',
    endpoint: { host: '127.0.0.1', port: 6910 },
    grant: {
      action: 'watch' as const,
      user: 'papercusp-view',
      secret: 'view-secret',
      inputAllowed: false,
      auditAction: 'desktop_watch_started' as const,
    },
  };

  it('dials the loopback websockify path with the grant as BasicAuth', async () => {
    let wire: FakeWire | undefined;
    const dial = dialDesktopSocket(dialInput, {
      createSocket: (url, headers) => {
        wire = new FakeWire(url, headers);
        queueMicrotask(() => wire!.emitOpen());
        return wire;
      },
    });
    await dial;
    expect(wire!.url).toBe(`ws://127.0.0.1:6910${KASMVNC_WEBSOCKET_PATH}`);
    expect(wire!.headers.Authorization).toBe(basicAuthHeader('papercusp-view', 'view-secret'));
  });

  it('does NOT resolve until the socket is open', async () => {
    // The adapter treats the returned value as live immediately, so resolving a
    // still-connecting socket would drop the viewer's first writes and report a
    // dial success for an endpoint that may still refuse the credential.
    const wire = new FakeWire('ws://x', {});
    let resolved = false;
    void dialDesktopSocket(dialInput, { createSocket: () => wire }).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    wire.emitOpen();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('rejects when the upgrade closes before opening — how a refused BasicAuth surfaces', async () => {
    const wire = new FakeWire('ws://x', {});
    const dial = dialDesktopSocket(dialInput, {
      createSocket: () => {
        queueMicrotask(() => wire.emitClose(1006));
        return wire;
      },
    });
    await expect(dial).rejects.toMatchObject({ code: 'desktop_dial_failed' });
  });

  it('rejects on a socket error', async () => {
    const wire = new FakeWire('ws://x', {});
    const dial = dialDesktopSocket(dialInput, {
      createSocket: () => {
        queueMicrotask(() => wire.emitError(new Error('ECONNREFUSED')));
        return wire;
      },
    });
    await expect(dial).rejects.toMatchObject({ code: 'desktop_dial_failed' });
  });

  it('rejects an upgrade that never opens at the deadline and aborts the pending socket (WI-10004214)', async () => {
    // A stalled KasmVNC upgrade used to leave the dial pending forever, so the host
    // never sent desktop.ready and the viewer sat on "Opening your desktop…".
    vi.useFakeTimers();
    try {
      const wire = new FakeWire('ws://x', {});
      const dial = dialDesktopSocket(dialInput, { createSocket: () => wire, dialTimeoutMs: 5_000 });
      const outcome = dial.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(wire.closedWith).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        code: 'desktop_dial_failed',
        message: 'dial_timeout_5000ms',
      });
      expect(wire.closedWith).toEqual({ code: 1000, reason: 'dial_timeout' });
      // A late open after the deadline must not resurrect the dial.
      wire.emitOpen();
      await expect(outcome).resolves.not.toBe('resolved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pumps sandbox→viewer bytes and viewer→sandbox writes', async () => {
    const wire = new FakeWire('ws://x', {});
    const socket = await dialDesktopSocket(dialInput, {
      createSocket: () => {
        queueMicrotask(() => wire.emitOpen());
        return wire;
      },
    });
    const seen: Buffer[] = [];
    socket.onData((data) => seen.push(data));
    wire.emitMessage(Buffer.from([1, 2, 3]));
    // An empty frame is not data — forwarding it would make the viewer repaint for nothing.
    wire.emitMessage(Buffer.from([]));
    expect(seen).toEqual([Buffer.from([1, 2, 3])]);
    expect(socket.send(Buffer.from([9]))).toBe(true);
    expect(wire.sent).toEqual([Buffer.from([9])]);
  });

  it('reports send failure once the pipe is gone, so the adapter can close the channel', async () => {
    const wire = new FakeWire('ws://x', {});
    const socket = await dialDesktopSocket(dialInput, {
      createSocket: () => {
        queueMicrotask(() => wire.emitOpen());
        return wire;
      },
    });
    const reasons: string[] = [];
    socket.onClose((reason) => reasons.push(reason));
    wire.emitClose(1006);
    expect(reasons).toEqual(['desktop_socket_closed_1006']);
    expect(socket.send(Buffer.from([1]))).toBe(false);
    // The close is fired exactly once even if the peer closes again.
    wire.emitClose(1006);
    expect(reasons).toHaveLength(1);
  });

  it('brackets an IPv6 loopback literal so the url parses', async () => {
    let url = '';
    await dialDesktopSocket(
      { ...dialInput, endpoint: { host: '::1', port: 6910 } },
      {
        createSocket: (value) => {
          url = value;
          const wire = new FakeWire(value, {});
          queueMicrotask(() => wire.emitOpen());
          return wire;
        },
      },
    );
    expect(url).toBe(`ws://[::1]:6910${KASMVNC_WEBSOCKET_PATH}`);
  });
});

describe('createHostedDesktopBackend', () => {
  function backend(overrides: Partial<Parameters<typeof createHostedDesktopBackend>[0]> = {}) {
    return createHostedDesktopBackend({
      leasedDesktop: (id) => (id === 'ds_1' ? lease() : undefined),
      listSessions: async () => [session()],
      touchSession: async () => {},
      ensureDesktop: async () => 'ds_1',
      ...overrides,
    });
  }

  it('start returns the leased desktop as a roster entry the viewer can open', async () => {
    const ensureDesktop = vi.fn(async () => 'ds_1');
    expect(await backend({ ensureDesktop }).start()).toMatchObject({ desktopSessionId: 'ds_1', displayNumber: 110 });
    expect(ensureDesktop).toHaveBeenCalledTimes(1);
  });

  it('start returns null — never an unopenable id — when the row or the live lease is missing', async () => {
    // Desktop running but never registered: nothing can name it.
    expect(await backend({ ensureDesktop: async () => undefined }).start()).toBeNull();
    // Registered but this process holds no lease: `lookup` could not dial it.
    expect(await backend({ leasedDesktop: () => undefined }).start()).toBeNull();
    // Leased and named, but the registry no longer lists it.
    expect(await backend({ listSessions: async () => [] }).start()).toBeNull();
  });

  // WI-10002797: after an upgrade the pre-upgrade row still read `ready`, blocked the
  // new desktop's row, and `start` answered null. Reconcile must precede the ensure.
  // WI-10004206: and it must run on EVERY call — a desktop that died after the first
  // roster stayed `ready` because the reconcile never ran again.
  it('reconciles before every start and roster touches the registry', async () => {
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push('reconcile');
      return 0;
    });
    const b = backend({
      reconcile,
      ensureDesktop: async () => {
        order.push('ensure');
        return 'ds_1';
      },
      listSessions: async () => {
        order.push('list');
        return [session()];
      },
    });
    await b.roster();
    await b.start();
    await b.roster();
    expect(order).toEqual(['reconcile', 'list', 'reconcile', 'ensure', 'list', 'reconcile', 'list']);
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('labels agent desktops with each owner claim, read once per owner, and survives a failed read', async () => {
    const activeClaimFor = vi.fn(async (owner: string) => {
      if (owner === 'su-broken') throw new Error('pg down');
      if (owner === 'su-a') return { workItemId: 'WI-1', intent: 'build the grid' };
      return null;
    });
    const warnings: string[] = [];
    const b = backend({
      activeClaimFor,
      onWarning: (m) => warnings.push(m),
      listSessions: async () => [
        session({ id: 'a1', scope: 'agent', scopeRef: 'su-a', display: ':111' }),
        session({ id: 'a2', scope: 'agent', scopeRef: 'su-a', display: ':112' }),
        session({ id: 'b1', scope: 'agent', scopeRef: 'su-b', display: ':113' }),
        session({ id: 'x1', scope: 'agent', scopeRef: 'su-broken', display: ':114' }),
        session({ id: 'p1', scope: 'pot', scopeRef: 'my-pot', display: ':115' }),
      ],
    });
    const roster = await b.roster();
    // Every desktop is listed, whatever the claim reads did.
    expect(roster.map((e) => e.desktopSessionId)).toEqual(['a1', 'a2', 'b1', 'x1', 'p1']);
    expect(roster.find((e) => e.desktopSessionId === 'a1')).toMatchObject({ workItemId: 'WI-1', workItemIntent: 'build the grid' });
    expect(roster.find((e) => e.desktopSessionId === 'a2')).toMatchObject({ workItemId: 'WI-1' });
    expect(roster.find((e) => e.desktopSessionId === 'b1')).not.toHaveProperty('workItemId');
    expect(roster.find((e) => e.desktopSessionId === 'x1')).not.toHaveProperty('workItemId');
    // A pot desktop is never looked up as an agent.
    expect(roster.find((e) => e.desktopSessionId === 'p1')).toMatchObject({ owner: 'my-pot' });
    expect(activeClaimFor.mock.calls.map(([owner]) => owner).sort()).toEqual(['su-a', 'su-b', 'su-broken']);
    expect(warnings).toEqual(['hosted-desktop-backend — claim lookup for su-broken failed: Error: pg down']);
  });

  it('a roster read after a desktop dies no longer lists it', async () => {
    let alive = true;
    const rows = [session()];
    const warnings: string[] = [];
    const b = backend({
      onWarning: (m) => warnings.push(m),
      listSessions: async () => [...rows],
      reconcile: async () => {
        if (alive) return 0;
        rows.length = 0;
        return 1;
      },
    });
    expect(await b.roster()).toHaveLength(1);
    alive = false;
    expect(await b.roster()).toEqual([]);
    expect(warnings).toEqual(['hosted-desktop-backend — retired 1 desktop row(s) no live lease backs']);
  });

  it('concurrent callers share the reconcile in flight', async () => {
    let finish!: (reaped: number) => void;
    const reconcile = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    const b = backend({ reconcile });
    const first = b.roster();
    const second = b.roster();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    finish(0);
    await Promise.all([first, second]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('a failed reconcile is warned and retried on the next call, and never blocks start', async () => {
    const warnings: string[] = [];
    const reconcile = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('pg down'))
      .mockResolvedValue(0);
    const b = backend({ reconcile, onWarning: (m) => warnings.push(m) });
    expect(await b.start()).toMatchObject({ desktopSessionId: 'ds_1' });
    expect(warnings.some((w) => w.includes('reconcile failed'))).toBe(true);
    await b.roster();
    await b.roster();
    expect(reconcile).toHaveBeenCalledTimes(3);
  });

  it('warns when the desktop runs but has no registry row — the failure that was silent', async () => {
    const warnings: string[] = [];
    expect(await backend({ ensureDesktop: async () => undefined, onWarning: (m) => warnings.push(m) }).start()).toBeNull();
    expect(warnings).toEqual(['hosted-desktop-backend — desktop.start: the desktop has no registry row']);
  });

  it('start propagates a provisioning failure so the relay reports it', async () => {
    await expect(
      backend({
        ensureDesktop: async () => {
          throw new Error('isolated desktop did not become ready');
        },
      }).start(),
    ).rejects.toThrow('isolated desktop did not become ready');
  });

  it('resolves a live lease and refuses an unknown id', async () => {
    expect(await backend().lookup('ds_1')).toMatchObject({ endpoint: { port: 6910 } });
    expect(await backend().lookup('ds_missing')).toBeNull();
  });

  it('lists the registry, not the leases — a roster must show desktops this process did not provision', async () => {
    const entries = await backend({
      leasedDesktop: () => undefined,
      listSessions: async () => [session(), session({ id: 'ds_2', display: ':111' })],
    }).roster();
    expect(entries.map((e) => e.desktopSessionId)).toEqual(['ds_1', 'ds_2']);
  });

  it('an empty roster is a valid answer, not a failure', async () => {
    expect(await backend({ listSessions: async () => [] }).roster()).toEqual([]);
  });

  it('heartbeats without awaiting, and survives a failing touch', async () => {
    const warnings: string[] = [];
    const touchSession = vi.fn(async () => {
      throw new Error('pg down');
    });
    backend({ touchSession, onWarning: (m) => warnings.push(m) }).heartbeat('ds_1');
    expect(touchSession).toHaveBeenCalledWith('ds_1');
    await new Promise((r) => setTimeout(r, 0));
    expect(warnings).toHaveLength(1);
  });

  it('serves a fresh capture jpeg and returns null for a stale one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    await writeFile(join(dir, 'display-110.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    const fresh = await backend({ captureDir: dir }).thumbnail('ds_1');
    expect(fresh).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

    // A stale-but-present file means the capture LOOP stopped — the loop deletes
    // the jpeg for an inactive display on purpose, so serving this as live is the
    // exact "dead screen shown as live" failure that delete-on-skip prevents.
    const old = new Date(Date.now() - HOSTED_THUMBNAIL_MAX_AGE_MS - 60_000);
    await utimes(join(dir, 'display-110.jpg'), old, old);
    expect(await backend({ captureDir: dir }).thumbnail('ds_1')).toBeNull();
  });

  it('returns null — never an error — when no capture exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    expect(await backend({ captureDir: dir }).thumbnail('ds_1')).toBeNull();
  });

  it('falls back to the registry display for a desktop this process did not lease', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    await writeFile(join(dir, 'display-111.jpg'), Buffer.from([1]));
    const image = await backend({
      captureDir: dir,
      leasedDesktop: () => undefined,
      listSessions: async () => [session({ id: 'ds_2', display: ':111' })],
    }).thumbnail('ds_2');
    expect(image).toEqual(Buffer.from([1]));
  });

  it('P-005: grabs a leased desktop on demand when the capture loop has no fresh frame for it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    const grabThumbnail = vi.fn(async (display: number) => Buffer.from([0xff, 0xd8, display]));
    // Absent: an agent-started desktop the bootstrap-time capture loop never lists.
    expect(await backend({ captureDir: dir, grabThumbnail }).thumbnail('ds_1')).toEqual(Buffer.from([0xff, 0xd8, 110]));
    expect(grabThumbnail).toHaveBeenCalledWith(110);

    // Stale: the loop stopped. The on-demand frame replaces it rather than serving it.
    await writeFile(join(dir, 'display-110.jpg'), Buffer.from([9]));
    const old = new Date(Date.now() - HOSTED_THUMBNAIL_MAX_AGE_MS - 60_000);
    await utimes(join(dir, 'display-110.jpg'), old, old);
    expect(await backend({ captureDir: dir, grabThumbnail }).thumbnail('ds_1')).toEqual(Buffer.from([0xff, 0xd8, 110]));
    expect(grabThumbnail).toHaveBeenCalledTimes(2);
  });

  it('P-005: a fresh capture-loop frame wins, with no on-demand grab', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    await writeFile(join(dir, 'display-110.jpg'), Buffer.from([0xff, 0xd8, 1]));
    const grabThumbnail = vi.fn(async () => Buffer.from([2]));
    expect(await backend({ captureDir: dir, grabThumbnail }).thumbnail('ds_1')).toEqual(Buffer.from([0xff, 0xd8, 1]));
    expect(grabThumbnail).not.toHaveBeenCalled();
  });

  it('P-005: never grabs a display known only from a registry row (it may not be this host’s X server)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    const grabThumbnail = vi.fn(async () => Buffer.from([2]));
    const image = await backend({
      captureDir: dir,
      grabThumbnail,
      leasedDesktop: () => undefined,
      listSessions: async () => [session({ id: 'ds_2', display: ':111' })],
    }).thumbnail('ds_2');
    expect(image).toBeNull();
    expect(grabThumbnail).not.toHaveBeenCalled();
  });

  it('P-005: a failing on-demand grab is a warned null, never an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    const warnings: string[] = [];
    const image = await backend({
      captureDir: dir,
      grabThumbnail: async () => {
        throw new Error('ffmpeg missing');
      },
      onWarning: (m) => warnings.push(m),
    }).thumbnail('ds_1');
    expect(image).toBeNull();
    expect(warnings).toEqual([expect.stringContaining('ffmpeg missing')]);
  });

  it('returns null for a desktop whose display it cannot resolve', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hosted-thumb-'));
    expect(
      await backend({ captureDir: dir, leasedDesktop: () => undefined, listSessions: async () => [] }).thumbnail('ds_9'),
    ).toBeNull();
  });
});
