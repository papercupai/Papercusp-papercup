import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { Frame } from '@papercusp/deployment-driver';
import {
  createVncSession,
  consumeTicket,
  bridgeVncSession,
  activeVncSessions,
  vncRemoteCommand,
  vncBridgeScript,
  localVncCommand,
  VNC_TICKET_TTL_MS,
  VNC_STREAM_IDLE_MS,
  _setFrameVncDepsForTests,
  _resetFrameVncForTests,
  type KasmDialPlan,
  type VncBridgeWs,
} from './frame-vnc';
import { hostedDesktopGrant } from '../desktop/hosted-desktop-channel';
import type { HostedDesktopDialInput, HostedDesktopSocket } from '../workspace-host/hosted-session-host';
import {
  DESKTOP_VIEWER_HEARTBEAT_DIVISOR,
  VIEWER_STREAM_TEARDOWN_CEILING_SEC,
  desktopViewerHeartbeatMs,
} from '../desktop/desktop-lifecycle';
import type { DesktopSessionRecord } from '../desktop/desktop-session-registry';

const FRAME: Frame = {
  id: 'lat-1',
  target: 'latitude',
  placement: 'remote',
  host: '203.0.113.7',
  meta: { sshUser: 'ubuntu' },
};

type AuditEv = { action: string; actor: string; subject: string; details: Record<string, unknown> };

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number;
    stdin: { write: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = undefined; // no real process group — endSession falls back to child.kill
  child.stdin = { write: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function fakeWs() {
  const ws = new EventEmitter() as EventEmitter & VncBridgeWs & {
    sent: Uint8Array[];
    send: (d: Uint8Array) => void;
    close: ReturnType<typeof vi.fn> & VncBridgeWs['close'];
  };
  ws.sent = [];
  ws.send = (d) => ws.sent.push(d);
  ws.close = vi.fn() as ReturnType<typeof vi.fn> & VncBridgeWs['close'];
  return ws;
}

function deps(over: Parameters<typeof _setFrameVncDepsForTests>[0] = {}) {
  const audits: AuditEv[] = [];
  _setFrameVncDepsForTests({
    loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
    audit: (ev) => audits.push(ev),
    ...over,
  });
  return audits;
}

afterEach(() => _resetFrameVncForTests());

describe('vncRemoteCommand', () => {
  it('watch mode: localhost-only x11vnc + socat bridge, read-only, on-demand', () => {
    const cmd = vncRemoteCommand(99, 'watch');
    expect(cmd).toContain('-display :99');
    expect(cmd).toContain('-localhost'); // never network-exposed
    expect(cmd).toContain('-once'); // exits when the viewer leaves
    expect(cmd).toContain('-timeout 30'); // self-exit if the bridge never connects
    expect(cmd).toContain('-nopw'); // auth is the ticketed tunnel, not an RFB pw
    expect(cmd).toContain('-viewonly');
    expect(cmd).toContain('socat STDIO TCP:127.0.0.1:$P'); // the stdio bridge
    expect(cmd).not.toContain('-inetd'); // -inetd can't run over an SSH pipe
    expect(cmd).not.toMatch(/0\.0\.0\.0/);
  });

  it('takeover mode drops -viewonly (D-002 explicit takeover)', () => {
    expect(vncRemoteCommand(100, 'takeover')).not.toContain('-viewonly');
    expect(vncRemoteCommand(100, 'takeover')).toContain('-display :100');
  });
});

describe('createVncSession + ticket lifecycle (P-010)', () => {
  it('mints a single-use ticket bound to the frame ssh command + audits the request', async () => {
    const audits = deps();
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:a' });
    expect(t.ticket).toMatch(/^[0-9a-f]{48}$/);
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.watch-requested', subject: 'h1:99' });

    const s = consumeTicket(t.ticket)!;
    expect(s.target).toBe('frame');
    expect(s.spawnCmd.cmd).toBe('ssh');
    expect(s.spawnCmd.args.at(-2)).toBe('ubuntu@203.0.113.7');
    // non-root login → sudo'd bridge command, read-only for watch on :99
    const remote = s.spawnCmd.args.at(-1)!;
    expect(remote.startsWith('sudo -H bash -c ')).toBe(true);
    expect(remote).toContain('-display :99');
    expect(remote).toContain('-viewonly');
    expect(remote).toContain('socat STDIO TCP:127.0.0.1:$P');
    // single-use: second consume fails
    expect(consumeTicket(t.ticket)).toBeUndefined();
  });

  it('expired tickets are not consumable', async () => {
    let nowMs = 1_000_000;
    deps({ now: () => nowMs });
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'u' });
    nowMs += VNC_TICKET_TTL_MS + 1;
    expect(consumeTicket(t.ticket)).toBeUndefined();
  });

  it('no deployed frame → throws', async () => {
    deps({ loadFrame: async () => undefined });
    await expect(
      createVncSession({ slug: 'nope', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'u' }),
    ).rejects.toThrow(/no deployed frame/);
  });

  it('takeover request is audited as takeover (D-002)', async () => {
    const audits = deps();
    await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 100, mode: 'takeover', actor: 'user:b' });
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.takeover-requested', subject: 'h1:100' });
  });
});

describe('bridgeVncSession (the RFB byte pipe + lifecycle)', () => {
  async function mintAndConsume(mode: 'watch' | 'takeover', audits: AuditEv[]) {
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode, actor: 'user:a' });
    audits.length = 0; // drop the *-requested event; tests below assert the bridge's events
    return consumeTicket(t.ticket)!;
  }

  it('pipes ws→stdin and stdout→ws; session is registered while open (D-002 indicator)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);

    expect(audits[0]).toMatchObject({ action: 'frame-vnc.watch-started', subject: 'h1:99' });
    expect(activeVncSessions('h1')).toHaveLength(1);
    expect(activeVncSessions('h1')[0]).toMatchObject({ display: 99, mode: 'watch', actor: 'user:a' });

    ws.emit('message', Buffer.from('rfb-client-bytes'));
    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('rfb-client-bytes'));
    child.stdout.emit('data', Buffer.from('rfb-server-bytes'));
    expect(ws.sent[0]).toEqual(Buffer.from('rfb-server-bytes'));
  });

  it('viewer leaving kills the child + audits the end (P-010 idle teardown)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);

    ws.emit('close');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(activeVncSessions('h1')).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'viewer-left' }),
    });
  });

  it('remote side closing tears down the ws + deregisters', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('takeover', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);
    expect(audits[0]).toMatchObject({ action: 'frame-vnc.takeover-started' });

    child.emit('close');
    expect(ws.close).toHaveBeenCalled();
    expect(activeVncSessions()).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'remote-closed', mode: 'takeover' }),
    });
  });

  it('teardown is idempotent (close after close emits one ended event)', async () => {
    const child = fakeChild();
    const audits = deps({ spawn: (() => child) as unknown as typeof import('node:child_process').spawn });
    const session = await mintAndConsume('watch', audits);
    const ws = fakeWs();
    bridgeVncSession(ws, session as never);
    ws.emit('close');
    child.emit('close');
    const ended = audits.filter((a) => a.action === 'frame-vnc.ended');
    expect(ended).toHaveLength(1);
  });
});

// ── P-004: local desktops reuse the same machinery, with an admission gate ────

/** A registry row shaped like the one desktop-lease registers for a pot lease. */
function localRecord(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-local-1',
    workspaceId: 'ws',
    harnessSlug: 'h1',
    kind: 'xvfb-local',
    scope: 'pot',
    scopeRef: 'h1',
    name: null,
    hostRef: null,
    ownerPid: process.pid,
    ownerBootId: 'boot-1',
    display: ':110',
    displayGeometry: { width: 1280, height: 1024, depth: 24 },
    captureGeometry: { width: 1024, height: 768 },
    state: 'ready',
    leaseHolder: null,
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    ttlSec: null,
    taskId: null,
    idleAfterSec: null,
    frozenAt: null,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    releasedAt: null,
    ...over,
  };
}

/**
 * Wire the local deps: a registry that admits exactly `admitted` displays, and a
 * recording viewer-setter. Deliberately NOT a blanket "resolve always succeeds"
 * stub — the whole point of the gate is which displays it refuses.
 */
function localDeps(admitted: Record<string, DesktopSessionRecord>, over: Parameters<typeof _setFrameVncDepsForTests>[0] = {}) {
  const audits: AuditEv[] = [];
  const viewerWrites: { id: string; mode: string; actor: string | null | undefined }[] = [];
  _setFrameVncDepsForTests({
    // A frame loader that would SUCCEED — so a test proving the local path was
    // taken cannot pass merely because the frame path was unavailable.
    loadFrame: async () => ({ frame: FRAME, config: { target: 'latitude' } }),
    audit: (ev) => audits.push(ev),
    resolveLocalDesktop: async ({ display }) => admitted[display],
    setViewer: async (id, viewer) => {
      viewerWrites.push({ id, mode: viewer.mode, actor: viewer.actor });
      return true;
    },
    // No KasmVNC lease in this process unless a test says so (D-015) — keeps the
    // x11vnc cases off the real lease/backends modules.
    resolveKasmDesktop: async () => null,
    ...over,
  });
  return { audits, viewerWrites };
}

describe('local desktop VNC target (P-004)', () => {
  it('localVncCommand is the SAME bridge script as the frame path, minus ssh and sudo', () => {
    const local = localVncCommand(110, 'watch');
    expect(local.cmd).toBe('bash');
    expect(local.args[0]).toBe('-c');
    // Identical script text — this is what "reuse, do not fork the bridge" means,
    // and it fails the moment someone gives local its own divergent command.
    expect(local.args[1]).toBe(vncBridgeScript(110, 'watch'));
    expect(local.args[1]).toContain('-display :110');
    expect(local.args[1]).toContain('-localhost'); // never network-exposed
    expect(local.args[1]).toContain('-viewonly'); // watch is read-only server-side
    expect(local.args[1]).not.toContain('sudo'); // we already own this Xvfb
    expect(local.args[1]).not.toMatch(/0\.0\.0\.0/);
  });

  it('takeover drops -viewonly on the local path too', () => {
    expect(localVncCommand(110, 'takeover').args[1]).not.toContain('-viewonly');
  });

  it('a registered local display mints a ticket bound to a LOCAL spawn (no ssh hop)', async () => {
    const { audits } = localDeps({ ':110': localRecord() });
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    expect(t.target).toBe('local');
    expect(t.desktopSessionId).toBe('ds-local-1');

    const s = consumeTicket(t.ticket)!;
    expect(s.spawnCmd.cmd).toBe('bash'); // NOT 'ssh' — the hop is gone
    expect(s.spawnCmd.args.at(-1)).toContain('-display :110');
    expect(audits[0]).toMatchObject({
      action: 'frame-vnc.watch-requested',
      subject: 'local:h1:110', // distinguishable from a frame's 'h1:110'
      details: expect.objectContaining({ target: 'local', desktopSessionId: 'ds-local-1' }),
    });
  });

  // ── the admission gate. These are the tests that matter. ──
  it('REFUSES an unregistered display — the owner\'s real desktop is not viewable', async () => {
    localDeps({ ':110': localRecord() }); // :110 is an agent desktop; :0 is the human's
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 0, mode: 'takeover', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow(/not a registered local agent desktop/);
  });

  it('refusal happens BEFORE any process is spawned, and is audited as nothing', async () => {
    const spawn = vi.fn();
    const { audits } = localDeps({}, { spawn: spawn as unknown as typeof import('node:child_process').spawn });
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 1, mode: 'watch', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow();
    expect(spawn).not.toHaveBeenCalled();
    // no ticket was minted, so nothing is consumable and nothing was audited as granted
    expect(audits).toHaveLength(0);
  });

  it('a RELEASED desktop stops being viewable (resolver excludes terminal rows)', async () => {
    // The resolver's own query filters terminal states; here the stub mirrors that
    // by simply not admitting the display, which is what a released row produces.
    localDeps({});
    await expect(
      createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
      }),
    ).rejects.toThrow(/not a registered local agent desktop/);
  });

  it('default target stays FRAME — a caller that says nothing keeps pre-P-004 behaviour', async () => {
    localDeps({ ':110': localRecord() });
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a',
    });
    expect(t.target).toBe('frame');
    expect(consumeTicket(t.ticket)!.spawnCmd.cmd).toBe('ssh');
  });

  it('records the REGISTRY\'s harness, not the caller\'s slug — audit attribution', async () => {
    // Admission is keyed on workspace + display, so the URL slug is unverified
    // input. Trusting it would let a caller file a takeover audit entry against
    // a harness that has nothing to do with the desktop they actually opened.
    const { audits } = localDeps({ ':110': localRecord({ harnessSlug: 'the-real-owner' }) });
    const t = await createVncSession({
      slug: 'some-other-harness', workspaceId: 'ws', display: 110, mode: 'takeover', actor: 'user:a', target: 'local',
    });
    expect(t.slug).toBe('the-real-owner');
    expect(audits[0]).toMatchObject({
      subject: 'local:the-real-owner:110',
      details: expect.objectContaining({ slug: 'the-real-owner' }),
    });
  });

  it('falls back to the caller slug when the registry row has no harness', async () => {
    const { audits } = localDeps({ ':110': localRecord({ harnessSlug: null }) });
    await createVncSession({
      slug: 'fallback', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    expect(audits[0]).toMatchObject({ subject: 'local:fallback:110' });
  });

  // ── the cross-process viewer indicator ──
  it('binds the viewer on the registry row while open and CLEARS it on teardown', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'takeover', actor: 'user:a', target: 'local',
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    expect(viewerWrites).toEqual([{ id: 'ds-local-1', mode: 'takeover', actor: 'user:a' }]);

    ws.emit('close');
    await Promise.resolve();
    expect(viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('clears the viewer on EVERY teardown reason, not just the viewer leaving', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    bridgeVncSession(fakeWs(), consumeTicket(t.ticket)! as never);
    child.emit('close'); // the desktop side went away, not the viewer
    await Promise.resolve();
    expect(viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('a failing viewer write does not break the session (indicator is cosmetic)', async () => {
    const child = fakeChild();
    const { audits } = localDeps(
      { ':110': localRecord() },
      {
        spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
        setViewer: async () => {
          throw new Error('row vanished mid-session');
        },
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = await createVncSession({
        slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
      });
      const ws = fakeWs();
      expect(() => bridgeVncSession(ws, consumeTicket(t.ticket)! as never)).not.toThrow();
      await Promise.resolve();
      // the session is live and byte-piping regardless
      child.stdout.emit('data', Buffer.from('rfb'));
      expect(ws.sent[0]).toEqual(Buffer.from('rfb'));
      expect(audits.some((a) => a.action === 'frame-vnc.watch-started')).toBe(true);
      // swallowed, but NOT silently: a lost indicator write is still reported.
      expect(warn).toHaveBeenCalledWith(
        '[frame-vnc] viewer indicator write failed:',
        expect.objectContaining({ message: 'row vanished mid-session' }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('frame sessions write NO viewer row (they have none) — negative control', async () => {
    const child = fakeChild();
    const { viewerWrites } = localDeps(
      { ':110': localRecord() },
      { spawn: (() => child) as unknown as typeof import('node:child_process').spawn },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:a', target: 'frame',
    });
    bridgeVncSession(fakeWs(), consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    expect(viewerWrites).toEqual([]);
  });

  it('local and frame sessions coexist in activeVncSessions, tagged by target', async () => {
    const { audits } = localDeps({ ':110': localRecord() }, {
      spawn: (() => fakeChild()) as unknown as typeof import('node:child_process').spawn,
    });
    const a = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode: 'watch', actor: 'user:a', target: 'local',
    });
    const b = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:b', target: 'frame',
    });
    bridgeVncSession(fakeWs(), consumeTicket(a.ticket)! as never);
    bridgeVncSession(fakeWs(), consumeTicket(b.ticket)! as never);
    const live = activeVncSessions('h1');
    expect(live.map((s) => s.target).sort()).toEqual(['frame', 'local']);
    expect(audits.filter((x) => x.action.endsWith('-started'))).toHaveLength(2);
  });
});

/**
 * P-014 — connected-viewer heartbeat + idle-stream teardown on the LOCAL lane.
 *
 * Why this suite exists at all: `VIEWER_HOLD_SEC` used to be six hours precisely
 * because this lane wrote the registry row twice — open, close — and nothing in
 * between, so a binding could not be read as liveness. These tests are what make
 * the shorter hold safe, and each is written so it would FAIL against the old
 * behaviour rather than merely describe the new one.
 *
 * The timer is injected rather than armed: `managedSetInterval` is deliberately
 * inert under Vitest, so a test that armed a real one would assert on a timer
 * that never fires and pass for the wrong reason.
 */
describe('viewer heartbeat + idle-stream teardown (P-014 / D-008 rule 4)', () => {
  /** Wire a local session with a captured tick and a controllable clock. */
  async function bridgedLocalSession(mode: 'watch' | 'takeover' = 'watch') {
    const child = fakeChild();
    const beats: string[] = [];
    let clock = 1_000_000;
    let tick: (() => void) | null = null;
    let armedIntervalMs: number | null = null;
    let stopped = 0;
    const { audits, viewerWrites } = localDeps(
      { ':110': localRecord() },
      {
        spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
        now: () => clock,
        touchSession: async (id: string) => {
          beats.push(id);
        },
        armHeartbeat: (intervalMs: number, fn: () => void) => {
          armedIntervalMs = intervalMs;
          tick = fn;
          return { stop: () => { stopped += 1; } };
        },
      },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode, actor: 'user:a', target: 'local',
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    return {
      ws,
      child,
      beats,
      audits,
      viewerWrites,
      advance: (ms: number) => { clock += ms; },
      tick: async () => { tick?.(); await Promise.resolve(); },
      get armedIntervalMs() { return armedIntervalMs; },
      get stopped() { return stopped; },
    };
  }

  it('touches the registry row on every tick while the stream is live', async () => {
    const s = await bridgedLocalSession();
    await s.tick();
    await s.tick();
    // The old lane produced ZERO writes here — the binding was written at open and
    // then never again, which is the whole reason the hold had to be six hours.
    expect(s.beats).toEqual(['ds-local-1', 'ds-local-1']);
  });

  it('arms at the cadence derived from the lifecycle policy, not a local constant', async () => {
    // Pinned to the shared derivation so the two lanes cannot drift apart: the
    // hosted adapter arms from the same function.
    const s = await bridgedLocalSession();
    expect(s.armedIntervalMs).toBe(desktopViewerHeartbeatMs());
  });

  it('ends a stream that has carried no viewer bytes for longer than the idle window', async () => {
    const s = await bridgedLocalSession();
    s.advance(VNC_STREAM_IDLE_MS + 1);
    await s.tick();
    expect(s.audits.at(-1)).toMatchObject({ action: 'frame-vnc.ended', details: { why: 'stream-idle' } });
    // And the binding is CLEARED, which is what actually lets the governor act —
    // a teardown that left the row advertising a watcher would just move the leak.
    expect(s.viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('does NOT heartbeat on the tick that tears the stream down', async () => {
    // The ordering guard. Beating first and checking idle second would keep
    // asserting "a human is watching" for a viewer already known to be gone —
    // survivable under a six-hour hold, not under a twenty-minute one.
    const s = await bridgedLocalSession();
    s.advance(VNC_STREAM_IDLE_MS + 1);
    await s.tick();
    expect(s.beats).toEqual([]);
  });

  it('a byte FROM the viewer resets the idle clock', async () => {
    // RFB is client-pull, so this is the signal that a viewer is genuinely there:
    // a live one keeps requesting framebuffer updates, a wedged one stops.
    const s = await bridgedLocalSession();
    s.advance(VNC_STREAM_IDLE_MS - 1);
    s.ws.emit('message', Buffer.from([0x03]));
    s.advance(VNC_STREAM_IDLE_MS - 1);
    await s.tick();
    expect(s.beats).toEqual(['ds-local-1']);
    expect(s.audits.some((a) => a.action === 'frame-vnc.ended')).toBe(false);
  });

  it('server→viewer traffic alone does NOT keep the stream alive', async () => {
    // The negative control for the test above, and the reason the direction is
    // specified rather than "any traffic": x11vnc keeps writing into a half-open
    // socket long after the human is gone, so counting outbound bytes as liveness
    // would resurrect exactly the stale-binding leak this suite exists to close.
    const s = await bridgedLocalSession();
    s.advance(VNC_STREAM_IDLE_MS - 1);
    // A desktop that keeps repainting: frames flow OUT continuously even though
    // nobody is receiving them.
    s.child.stdout?.emit('data', Buffer.from([0x00, 0x01, 0x02]));
    s.advance(2);
    await s.tick();
    expect(s.ws.sent.length).toBeGreaterThan(0); // the frames really were sent
    expect(s.audits.at(-1)).toMatchObject({ details: { why: 'stream-idle' } });
  });

  it('stops the heartbeat on teardown, whatever ended the session', async () => {
    // A per-connection timer that outlives its connection is a leak that scales
    // with viewers; `instanced` timers all share one display name, so a leaked one
    // hides in the inventory rather than standing out.
    const s = await bridgedLocalSession();
    s.ws.emit('close');
    await Promise.resolve();
    expect(s.stopped).toBe(1);
    await s.tick();
    expect(s.beats).toEqual([]);
  });

  it('a frame session (no registry row) arms the timer but writes nothing', async () => {
    // Frame displays have no DesktopSession row of their own; beating for them
    // would touch a row that does not exist.
    const child = fakeChild();
    const beats: string[] = [];
    // A holder rather than a bare `let`: TS narrows a let assigned only inside a
    // callback back to `null` at the call site below.
    const armed: { tick: (() => void) | null } = { tick: null };
    deps({
      spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
      touchSession: async (id: string) => { beats.push(id); },
      armHeartbeat: (_ms: number, fn: () => void) => { armed.tick = fn; return { stop: () => undefined }; },
    });
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'user:a', target: 'frame',
    });
    bridgeVncSession(fakeWs(), consumeTicket(t.ticket)! as never);
    await Promise.resolve();
    expect(armed.tick, 'the timer must be armed — otherwise this asserts nothing').toBeTruthy();
    armed.tick?.();
    await Promise.resolve();
    expect(beats).toEqual([]);
  });

  it('the idle window fits inside the ceiling the governor derives its hold from', async () => {
    // The pin. `VIEWER_HOLD_SEC` is computed from that ceiling, so lengthening
    // this lane's window without raising the ceiling would silently make the hold
    // too short for it — freezing a desktop this lane had not yet given up on.
    expect(VNC_STREAM_IDLE_MS / 1000).toBeLessThanOrEqual(VIEWER_STREAM_TEARDOWN_CEILING_SEC);
    // And the window must be long enough to survive the missed beats the cadence
    // is explicitly sized to tolerate, or the teardown would fire first and the
    // tolerance would be fiction.
    expect(VNC_STREAM_IDLE_MS).toBeGreaterThan(
      desktopViewerHeartbeatMs() * DESKTOP_VIEWER_HEARTBEAT_DIVISOR,
    );
  });
});

// ── D-015: a KasmVNC desktop this process leases is dialled, not x11vnc'd ─────

const KASM_CREDS = {
  view: { user: 'kasm-view', secret: 'view-secret' },
  control: { user: 'kasm-control', secret: 'control-secret' },
};

function kasmPlan(mode: 'watch' | 'takeover'): KasmDialPlan {
  return {
    endpoint: { host: '127.0.0.1', port: 6901 },
    grant: hostedDesktopGrant(mode === 'takeover' ? 'controller' : 'observer', KASM_CREDS),
  };
}

/** A HostedDesktopSocket the test drives by hand. */
function fakeKasmSocket() {
  const listeners: { data: ((d: Buffer) => void) | null; close: ((r: string) => void) | null } = {
    data: null,
    close: null,
  };
  const sock = {
    sent: [] as Buffer[],
    closed: 0,
    send(d: Buffer) {
      sock.sent.push(d);
      return true;
    },
    close() {
      sock.closed += 1;
    },
    onData(l: (d: Buffer) => void) {
      listeners.data = l;
      return () => { listeners.data = null; };
    },
    onClose(l: (r: string) => void) {
      listeners.close = l;
      return () => { listeners.close = null; };
    },
    emitData: (d: Buffer) => listeners.data?.(d),
    emitClose: (r: string) => listeners.close?.(r),
  };
  return sock;
}

/** A dial whose outcome the test releases, so pre-dial behaviour is observable. */
function deferredDial() {
  const calls: HostedDesktopDialInput[] = [];
  let resolveDial: (s: HostedDesktopSocket) => void = () => undefined;
  let rejectDial: (e: unknown) => void = () => undefined;
  const dialKasm = (input: HostedDesktopDialInput) => {
    calls.push(input);
    return new Promise<HostedDesktopSocket>((res, rej) => {
      resolveDial = res;
      rejectDial = rej;
    });
  };
  return {
    calls,
    dialKasm,
    resolve: (s: HostedDesktopSocket) => resolveDial(s),
    reject: (e: unknown) => rejectDial(e),
  };
}

/** Let the dial's .then() run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('KasmVNC upstream for leased local desktops (D-015)', () => {
  async function mintLocal(mode: 'watch' | 'takeover', over: Parameters<typeof _setFrameVncDepsForTests>[0]) {
    const spawn = vi.fn(() => fakeChild());
    const ctx = localDeps(
      { ':110': localRecord() },
      { spawn: spawn as unknown as typeof import('node:child_process').spawn, ...over },
    );
    const t = await createVncSession({
      slug: 'h1', workspaceId: 'ws', display: 110, mode, actor: 'user:a', target: 'local',
    });
    return { ...ctx, spawn, t };
  }

  it('a desktop this process leases mints an rfb:kasmvnc ticket carrying the mode-matched grant', async () => {
    const asked: [string, string][] = [];
    const { t } = await mintLocal('watch', {
      resolveKasmDesktop: async (id, mode) => {
        asked.push([id, mode]);
        return kasmPlan(mode);
      },
    });
    expect(t.rfb).toBe('kasmvnc');
    expect(asked).toEqual([['ds-local-1', 'watch']]);
    const s = consumeTicket(t.ticket)!;
    expect(s.kasm?.grant).toMatchObject({ action: 'watch', user: 'kasm-view', inputAllowed: false });
    // One secret only: a watcher's plan never carries the control secret.
    expect(JSON.stringify(s.kasm)).not.toContain('control-secret');
  });

  it('no lease here (resolver null) or a resolver failure keeps the x11vnc path: rfb:standard', async () => {
    const none = await mintLocal('watch', { resolveKasmDesktop: async () => null });
    expect(none.t.rfb).toBe('standard');
    _resetFrameVncForTests();
    const failing = await mintLocal('watch', {
      resolveKasmDesktop: async () => {
        throw new Error('lease module unavailable');
      },
    });
    expect(failing.t.rfb).toBe('standard');
    expect(consumeTicket(failing.t.ticket)!.kasm).toBeNull();
  });

  it('frame sessions never ask for a KasmVNC plan', async () => {
    const resolveKasmDesktop = vi.fn(async () => kasmPlan('watch'));
    deps({ resolveKasmDesktop });
    const t = await createVncSession({ slug: 'h1', workspaceId: 'ws', display: 99, mode: 'watch', actor: 'u' });
    expect(t.rfb).toBe('standard');
    expect(resolveKasmDesktop).not.toHaveBeenCalled();
  });

  it('bridges over the dialled socket: no spawn, pre-dial bytes flushed in order, then both directions', async () => {
    const dial = deferredDial();
    const { t, spawn, audits, viewerWrites } = await mintLocal('takeover', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    const child = bridgeVncSession(ws, consumeTicket(t.ticket)! as never);

    expect(child).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(dial.calls).toHaveLength(1);
    expect(dial.calls[0]).toMatchObject({
      desktopSessionId: 'ds-local-1',
      endpoint: { host: '127.0.0.1', port: 6901 },
      grant: { action: 'takeover', user: 'kasm-control', inputAllowed: true },
    });
    expect(audits.at(-1)).toMatchObject({ action: 'frame-vnc.takeover-started', subject: 'local:h1:110' });

    // The viewer speaks before the dial lands; those bytes must not be lost.
    ws.emit('message', Buffer.from('a'));
    ws.emit('message', Buffer.from('b'));
    const sock = fakeKasmSocket();
    dial.resolve(sock);
    await settle();
    expect(sock.sent.map(String)).toEqual(['a', 'b']);

    ws.emit('message', Buffer.from('c'));
    expect(sock.sent.map(String)).toEqual(['a', 'b', 'c']);
    sock.emitData(Buffer.from('server-frame'));
    expect(ws.sent.map((d) => Buffer.from(d).toString())).toEqual(['server-frame']);
    expect(activeVncSessions('h1')).toHaveLength(1);
    expect(viewerWrites).toContainEqual({ id: 'ds-local-1', mode: 'takeover', actor: 'user:a' });
  });

  it('the pre-dial queue is bounded', async () => {
    const dial = deferredDial();
    const { t } = await mintLocal('watch', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    for (let i = 0; i < 100; i++) ws.emit('message', Buffer.from(String(i)));
    const sock = fakeKasmSocket();
    dial.resolve(sock);
    await settle();
    expect(sock.sent).toHaveLength(64);
    expect(String(sock.sent[0])).toBe('0');
  });

  it('the desktop closing its socket ends the session and clears the viewer', async () => {
    const dial = deferredDial();
    const { t, audits, viewerWrites } = await mintLocal('watch', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    const sock = fakeKasmSocket();
    dial.resolve(sock);
    await settle();

    sock.emitClose('kasmvnc-exited');
    expect(ws.close).toHaveBeenCalled();
    expect(activeVncSessions()).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'remote-closed', target: 'local' }),
    });
    await settle();
    expect(viewerWrites.at(-1)).toEqual({ id: 'ds-local-1', mode: 'none', actor: null });
  });

  it('a failed dial ends the session with kasmvnc-dial-failed and never falls back to spawning', async () => {
    const dial = deferredDial();
    const { t, spawn, audits } = await mintLocal('watch', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dial.reject(new Error('ECONNREFUSED 127.0.0.1:6901'));
    await settle();
    warn.mockRestore();

    expect(ws.close).toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(audits.at(-1)).toMatchObject({
      action: 'frame-vnc.ended',
      details: expect.objectContaining({ why: 'kasmvnc-dial-failed' }),
    });
  });

  it('a viewer that leaves before the dial lands closes the late socket and sends it nothing', async () => {
    const dial = deferredDial();
    const { t, audits } = await mintLocal('watch', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    ws.emit('message', Buffer.from('early'));
    ws.emit('close');
    expect(audits.at(-1)).toMatchObject({ details: expect.objectContaining({ why: 'viewer-left' }) });

    const sock = fakeKasmSocket();
    dial.resolve(sock);
    await settle();
    expect(sock.closed).toBe(1);
    expect(sock.sent).toEqual([]);
  });

  it('a viewer leaving after the dial closes the socket', async () => {
    const dial = deferredDial();
    const { t } = await mintLocal('watch', {
      resolveKasmDesktop: async (_id, mode) => kasmPlan(mode),
      dialKasm: dial.dialKasm,
    });
    const ws = fakeWs();
    bridgeVncSession(ws, consumeTicket(t.ticket)! as never);
    const sock = fakeKasmSocket();
    dial.resolve(sock);
    await settle();
    ws.emit('close');
    expect(sock.closed).toBe(1);
  });
});
