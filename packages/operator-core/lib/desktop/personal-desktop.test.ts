/**
 * personal-cloud-desktop-2026-10-06 — the personal (scope='user') desktop.
 *
 * R-1  the lifecycle reaper never governs a personal desktop.
 * R-8  an agent or pot desktop provisions through the sandbox socket and never dials
 *      the personal worker socket.
 * R-9  a personal desktop provisions through the personal worker socket and never dials
 *      the sandbox socket (and never falls back to any other route).
 *
 * The routing tests run against REAL Unix sockets in a temp dir: the recording `connect`
 * notes which well-known worker path the code asked for, then dials the fake worker that
 * stands in for it — so "never dials X" is an observation of the dial, not of a mock call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameType, encodeJsonFrame } from '@papercusp/ipc-framing';
import { classifyDesktopSession } from './desktop-lifecycle';
import type { DesktopSessionRecord } from './desktop-session-registry';
import { kasmvncWebsocketPort } from './x-server-backend';
import {
  PERSONAL_DESKTOP_ACCOUNT,
  PERSONAL_DESKTOP_SOCKET,
  PersonalDesktopUnavailableError,
  WORKSPACE_DESKTOP_SOCKET,
  provisionPersonalDesktop,
  serializeWorkspaceDesktop,
} from './workspace-desktop-session';
import type { SandboxDesktop } from '../agent-tools/computer/desktop-provisioner';
import {
  desktopLeaseKey,
  desktopProvisionRoute,
  provisionForTarget,
  type DesktopLeaseTarget,
} from '../agent-tools/computer/desktop-lease';
import { desktopAccess, type DesktopCaller } from '../agent-tools/computer/desktop-ownership';
import {
  PERSONAL_DESKTOP_HOME,
  PERSONAL_DISPLAY_RANGE,
  SANDBOX_DISPLAY_RANGE,
  assertPersonalDesktopIdentity,
  assertWorkspaceDesktopIdentity,
  desktopWorkerPaths,
  parseDesktopWorkerArgv,
  personalDesktopEnvironment,
} from './workspace-desktop-session-worker';
import { PassThrough } from 'node:stream';
import { FrameDecoder } from '@papercusp/ipc-framing';
import { serveWorkspaceDesktop, parseWorkspaceDesktop } from './workspace-desktop-session';
import {
  __resetProvisioner,
  __setProvisionerForTests,
  ensurePersonalDesktop,
  leaseOwnerBySessionId,
  leasedDesktopBySessionId,
  listDesktopLeases,
  releaseAllDesktops,
} from '../agent-tools/computer/desktop-lease';
import { createHostedDesktopBackend } from '../workspace-host/hosted-desktop-backend';

/**
 * An in-memory registry for the P-003 lease tests (R-3 / R-22): the lease writes its
 * row here instead of Postgres, and the backend's roster reads the same rows back. Every
 * other registry export stays real.
 */
const registryRows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('./desktop-session-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./desktop-session-registry')>();
  return {
    ...actual,
    registerDesktopSession: vi.fn(async (input: Record<string, unknown>) => {
      const id = `ds-personal-${registryRows.size + 1}`;
      registryRows.set(id, { ...input, id });
      return { id };
    }),
    markDesktopReady: vi.fn(async () => undefined),
    closeDesktopSession: vi.fn(async (id: string) => { registryRows.delete(id); }),
    resolveDesktopForScope: vi.fn(async () => undefined),
  };
});
vi.mock('../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-personal',
}));

describe('R-2 — the personal worker runs only as the customer account', () => {
  const customer = { uid: 1001, username: 'papercusp-workspace', home: '/home/papercusp-workspace' };
  it('accepts exactly the customer workspace account and its home', () => {
    expect(PERSONAL_DESKTOP_HOME).toBe('/home/papercusp-workspace');
    expect(() => assertPersonalDesktopIdentity(customer)).not.toThrow();
  });
  it('refuses root, the sandbox desktop user, the operator, the agent and a substituted home', () => {
    for (const identity of [
      { ...customer, uid: 0 },
      { uid: 902, username: 'papercusp-desktop', home: '/var/lib/papercusp-desktop' },
      { uid: 900, username: 'papercusp', home: '/var/lib/papercusp' },
      { uid: 901, username: 'papercusp-agent', home: '/home/papercusp-agent' },
      { ...customer, home: '/var/lib/papercusp-desktop' },
    ]) expect(() => assertPersonalDesktopIdentity(identity), JSON.stringify(identity)).toThrow(/customer workspace account/);
  });
  it('control: the sandbox assertion still refuses the customer account, so the two modes never accept each other', () => {
    expect(() => assertWorkspaceDesktopIdentity(customer)).toThrow();
  });
  it('selects personal mode only from a leading --personal flag', () => {
    expect(parseDesktopWorkerArgv(['--personal', '--stdio'])).toEqual({ mode: 'personal', rest: ['--stdio'] });
    expect(parseDesktopWorkerArgv(['--stdio'])).toEqual({ mode: 'sandbox', rest: ['--stdio'] });
    expect(parseDesktopWorkerArgv(['--stdio', '--personal'])).toEqual({ mode: 'sandbox', rest: ['--stdio', '--personal'] });
  });
  it('gives the session the customer HOME and login names, never an inherited credential', () => {
    const env = personalDesktopEnvironment({ ANTHROPIC_API_KEY: 'secret', DATABASE_URL: 'postgres://x', HOME: '/root', DISPLAY: ':210' });
    expect(env).toEqual({
      HOME: '/home/papercusp-workspace', USER: 'papercusp-workspace', LOGNAME: 'papercusp-workspace',
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', SHELL: '/bin/bash', DISPLAY: ':210',
    });
  });
  it('keeps its locks and KasmVNC passwords in the customer home on a display range disjoint from the sandbox', () => {
    const personal = desktopWorkerPaths('personal');
    expect(personal.locks.startsWith('/home/papercusp-workspace/')).toBe(true);
    expect(personal.credentials.startsWith('/home/papercusp-workspace/')).toBe(true);
    expect(desktopWorkerPaths('sandbox').locks.startsWith('/var/lib/papercusp-desktop/')).toBe(true);
    expect(PERSONAL_DISPLAY_RANGE.first).toBeGreaterThan(SANDBOX_DISPLAY_RANGE.last);
    // Both ranges stay inside the reply schema's display bounds, so either reply parses.
    expect(SANDBOX_DISPLAY_RANGE.first).toBe(110);
    expect(PERSONAL_DISPLAY_RANGE.last).toBe(250);
  });
  it('reports its account in the provision reply so the operator can verify it (and the sandbox reply carries none)', async () => {
    const reply = async (account?: string) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const desktop = {
        display: ':210', number: 210, width: 1280, height: 800, xServer: 'kasmvnc',
        gl: { id: 'none', tier: 'none', launchPrefix: [], reason: 'test', env: {}, renderer: null }, glProbeSandboxed: false,
        endpoint: { host: '127.0.0.1', port: kasmvncWebsocketPort(210) },
        credentials: { view: { user: 'v', secret: 's' }, control: { user: 'c', secret: 's' } },
        release: async () => {},
      } as unknown as SandboxDesktop;
      const serving = serveWorkspaceDesktop(input, output, async () => desktop, () => {}, account);
      input.write(encodeJsonFrame(FrameType.REQUEST, { protocol: 'papercusp-desktop-session-v1', action: 'provision', options: {} }));
      const decoder = new FrameDecoder();
      const frame = await new Promise<{ payload: Buffer }>((resolve) => output.on('data', (chunk: Buffer) => {
        decoder.push(chunk);
        const [first] = decoder.drain();
        if (first) resolve(first);
      }));
      input.end();
      await serving;
      return parseWorkspaceDesktop(JSON.parse(frame.payload.toString('utf8')));
    };
    expect((await reply('papercusp-workspace')).account).toBe('papercusp-workspace');
    expect((await reply()).account).toBeUndefined();
  });
});

// ── R-1: the reaper ──────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ago = (sec: number) => new Date(NOW - sec * 1000);
const DAY = 86_400;

function session(over: Partial<DesktopSessionRecord> = {}): DesktopSessionRecord {
  return {
    id: 'ds-user-1',
    workspaceId: 'ws',
    harnessSlug: null,
    kind: 'xvfb-local',
    scope: 'user',
    scopeRef: 'user-avi',
    name: null,
    hostRef: null,
    ownerPid: 4242,
    ownerBootId: 'boot-1',
    display: ':120',
    displayGeometry: { width: 1920, height: 1080, depth: 24 },
    captureGeometry: { width: 1920, height: 1080 },
    state: 'ready',
    leaseHolder: 'user-avi',
    viewerMode: 'none',
    viewerActor: null,
    capabilities: {},
    // An expired TTL AND weeks of idleness: every clock the reaper has says "reap".
    ttlSec: 60,
    taskId: null,
    idleAfterSec: null,
    frozenAt: null,
    createdAt: ago(30 * DAY),
    lastActiveAt: ago(14 * DAY),
    releasedAt: null,
    ...over,
  };
}

describe('R-1 — the reaper never governs a personal desktop', () => {
  it('refuses a scope=user desktop even when its TTL expired and it sat idle for weeks', () => {
    const verdict = classifyDesktopSession(session(), NOW);
    expect(verdict.action).toBe('keep');
    expect(verdict.refused).toBe(true);
    expect(verdict.reason).toContain("scope='user'");
  });

  it('refuses a frozen personal desktop too, so nothing escalates it to a kill', () => {
    const verdict = classifyDesktopSession(session({ state: 'frozen', frozenAt: ago(7 * DAY) }), NOW);
    expect(verdict.action).toBe('keep');
    expect(verdict.refused).toBe(true);
  });

  it('control: the identical session as an agent desktop IS reaped, so the refusal above is not vacuous', () => {
    const verdict = classifyDesktopSession(session({ scope: 'agent', scopeRef: 'su-agent' }), NOW);
    expect(verdict.action).not.toBe('keep');
    expect(verdict.refused).toBeFalsy();
  });
});

// ── R-8 / R-9: routing ───────────────────────────────────────────────────────

const fakeDesktop = (number = 120): SandboxDesktop => ({
  display: `:${number}`, number, width: 1920, height: 1080, taskId: null, xServer: 'kasmvnc',
  gl: { id: 'mesa-software', tier: 'software', renderer: 'llvmpipe', launchPrefix: [], env: {}, reason: 'measured' },
  glProbeSandboxed: true,
  endpoint: { host: '127.0.0.1', port: kasmvncWebsocketPort(number) },
  credentials: { passwordFile: '/private/passwords', view: { user: 'view', secret: 'v' }, control: { user: 'control', secret: 'c' }, destroy: vi.fn() },
  appDiagnostics: () => [], release: vi.fn(async () => {}),
});

const roots: string[] = [];
const servers: Server[] = [];
const released: SandboxDesktop[] = [];
afterEach(async () => {
  await Promise.all(released.splice(0).map((d) => d.release().catch(() => {})));
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake desktop worker: replies with one ready frame (optionally naming its account), ends on EOF. */
async function fakeWorker(account?: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'pc-personal-desktop-')); roots.push(root);
  const path = join(root, 'session.sock');
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    socket.once('data', () => socket.write(encodeJsonFrame(FrameType.EVENT_JSON, serializeWorkspaceDesktop(fakeDesktop(), account))));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return path;
}

/**
 * A host with BOTH workers installed. `dialed` records the well-known path each dial
 * asked for; the dial itself goes to the fake worker standing in for that path.
 */
async function hostWithBothWorkers(personalAccount: string | undefined = PERSONAL_DESKTOP_ACCOUNT) {
  const sandbox = await fakeWorker();
  const personal = await fakeWorker(personalAccount);
  const dialed: string[] = [];
  const local = vi.fn(async () => fakeDesktop(130));
  const deps = {
    exists: (p: string) => p === WORKSPACE_DESKTOP_SOCKET || p === PERSONAL_DESKTOP_SOCKET,
    connect: (p: string) => {
      dialed.push(p);
      if (p === WORKSPACE_DESKTOP_SOCKET) return connect(sandbox);
      if (p === PERSONAL_DESKTOP_SOCKET) return connect(personal);
      throw new Error(`unexpected dial ${p}`);
    },
    local,
  };
  return { dialed, local, deps };
}

const agentTarget: DesktopLeaseTarget = { scope: 'agent', ownerId: 'su-agent', name: 'main' };
const potTarget: DesktopLeaseTarget = { scope: 'pot', pot: 'papercusp' };
const userTarget: DesktopLeaseTarget = { scope: 'user', userId: 'user-avi' };

describe('desktopProvisionRoute — the pure routing rule', () => {
  it('sends a user lease to the personal socket whether or not the sandbox worker exists', () => {
    expect(desktopProvisionRoute(userTarget, true)).toBe('personal-socket');
    expect(desktopProvisionRoute(userTarget, false)).toBe('personal-socket');
  });
  it('never sends an agent or pot lease to the personal socket', () => {
    for (const t of [agentTarget, potTarget]) {
      expect(desktopProvisionRoute(t, true)).toBe('sandbox-socket');
      expect(desktopProvisionRoute(t, false)).toBe('local');
    }
  });
  it('keys a personal lease apart from an agent lease with the same id', () => {
    expect(desktopLeaseKey(userTarget)).not.toBe(desktopLeaseKey({ scope: 'agent', ownerId: 'user-avi', name: 'main' }));
  });
});

describe('R-8 — sandbox desktops never reach the personal worker', () => {
  it.each([['agent', agentTarget], ['pot', potTarget]] as const)('%s desktop dials only the sandbox socket', async (_label, target) => {
    const { dialed, local, deps } = await hostWithBothWorkers();
    const desktop = await provisionForTarget(target, {}, deps);
    released.push(desktop);
    expect(dialed).toEqual([WORKSPACE_DESKTOP_SOCKET]);
    expect(dialed).not.toContain(PERSONAL_DESKTOP_SOCKET);
    expect(local).not.toHaveBeenCalled();
    expect(desktop.isAlive?.()).toBe(true);
  });
});

describe('R-9 — a personal desktop dials only the personal worker', () => {
  it('provisions through the personal socket and never dials the sandbox socket', async () => {
    const { dialed, local, deps } = await hostWithBothWorkers();
    const desktop = await provisionForTarget(userTarget, {}, deps);
    released.push(desktop);
    expect(dialed).toEqual([PERSONAL_DESKTOP_SOCKET]);
    expect(dialed).not.toContain(WORKSPACE_DESKTOP_SOCKET);
    expect(local).not.toHaveBeenCalled();
    expect(desktop.isAlive?.()).toBe(true);
  });

  it('refuses with personal_desktop_unavailable when the host has no personal worker — no fallback dial, no local desktop', async () => {
    const { dialed, local, deps } = await hostWithBothWorkers();
    const sandboxOnly = { ...deps, exists: (p: string) => p === WORKSPACE_DESKTOP_SOCKET };
    const attempt = provisionForTarget(userTarget, {}, sandboxOnly);
    await expect(attempt).rejects.toBeInstanceOf(PersonalDesktopUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 'personal_desktop_unavailable' });
    expect(dialed).toEqual([]);
    expect(local).not.toHaveBeenCalled();
  });

  it('refuses a personal worker that reports a different Unix account', async () => {
    const { deps } = await hostWithBothWorkers('papercusp-desktop');
    await expect(provisionForTarget(userTarget, {}, deps)).rejects.toThrow(/reported account papercusp-desktop, expected papercusp-workspace/);
  });

  it('refuses a personal worker that reports no account at all', async () => {
    const path = await fakeWorker(undefined);
    await expect(
      provisionPersonalDesktop({}, { exists: () => true, connect: () => connect(path) }),
    ).rejects.toThrow(/reported account \(none\)/);
  });
});

// ── R-3 / R-22: starting a person's desktop through the hosted backend ───────

const asRecord = (row: Record<string, unknown>): DesktopSessionRecord => ({
  state: 'ready', name: null, lastActiveAt: null, ...row,
  displayGeometry: { width: 1920, height: 1080, depth: 24, ...(row.displayGeometry as object) },
} as unknown as DesktopSessionRecord);

/** The hosted backend composed over the REAL lease module and the in-memory registry. */
function personalBackend() {
  return createHostedDesktopBackend({
    leasedDesktop: leasedDesktopBySessionId,
    listSessions: async () => [...registryRows.values()].map(asRecord),
    touchSession: async () => {},
    ensureDesktop: async () => undefined,
    ensurePersonalDesktop: (userId) => ensurePersonalDesktop(userId),
    leaseOwner: leaseOwnerBySessionId,
  });
}

describe('P-003 — a person starts their own desktop through the hosted backend', () => {
  afterEach(async () => {
    await releaseAllDesktops();
    __resetProvisioner();
    registryRows.clear();
  });

  it('R-3: starting twice for the same person returns the same scope=user desktop session', async () => {
    const { dialed, deps } = await hostWithBothWorkers();
    __setProvisionerForTests((opts, target) => provisionForTarget(target, opts, deps));
    const backend = personalBackend();
    const first = await backend.startPersonal!('user-avi');
    const second = await backend.startPersonal!('user-avi');
    expect(first).toMatchObject({ scope: 'user', owner: 'user-avi', state: 'ready' });
    expect(second?.desktopSessionId).toBe(first?.desktopSessionId);
    // ONE desktop: one dial to the personal worker, one registry row.
    expect(dialed).toEqual([PERSONAL_DESKTOP_SOCKET]);
    expect(registryRows.size).toBe(1);
  });

  it('control: a different person gets a different desktop, so the sameness above is not vacuous', async () => {
    const { deps } = await hostWithBothWorkers();
    __setProvisionerForTests((opts, target) => provisionForTarget(target, opts, deps));
    const backend = personalBackend();
    const avi = await backend.startPersonal!('user-avi');
    const bea = await backend.startPersonal!('user-bea');
    expect(bea?.desktopSessionId).not.toBe(avi?.desktopSessionId);
    expect(bea).toMatchObject({ scope: 'user', owner: 'user-bea' });
  });

  it('R-22: a host without the desktop pack refuses with personal_desktop_unavailable and starts nothing', async () => {
    const dialed: string[] = [];
    const local = vi.fn(async () => fakeDesktop(130));
    __setProvisionerForTests((opts, target) => provisionForTarget(target, opts, {
      exists: () => false,
      connect: (path: string) => { dialed.push(path); throw new Error(`unexpected dial ${path}`); },
      local,
    }));
    const backend = personalBackend();
    const attempt = backend.startPersonal!('user-avi');
    await expect(attempt).rejects.toBeInstanceOf(PersonalDesktopUnavailableError);
    await expect(attempt).rejects.toMatchObject({ code: 'personal_desktop_unavailable' });
    expect(dialed).toEqual([]);
    expect(local).not.toHaveBeenCalled();
    expect(listDesktopLeases()).toEqual([]);
    expect(registryRows.size).toBe(0);
    expect(await backend.roster({ userId: 'user-avi' })).toEqual([]);
  });

  it('lists a person\'s desktop only to its owner, and names the owner on lookup', async () => {
    const { deps } = await hostWithBothWorkers();
    __setProvisionerForTests((opts, target) => provisionForTarget(target, opts, deps));
    const backend = personalBackend();
    const avi = await backend.startPersonal!('user-avi');
    expect((await backend.roster({ userId: 'user-avi' })).map((e) => e.desktopSessionId)).toEqual([avi!.desktopSessionId]);
    expect(await backend.roster({ userId: 'user-bea' })).toEqual([]);
    // No viewer: personal desktops are withheld (fail closed).
    expect(await backend.roster()).toEqual([]);
    expect(await backend.lookup(avi!.desktopSessionId)).toMatchObject({ personalOwner: 'user-avi' });
  });
});

// ── agent access to a personal desktop ───────────────────────────────────────

const caller = (over: Partial<DesktopCaller> = {}): DesktopCaller => ({
  ownerId: 'su-agent', harnessSlug: 'papercusp', role: 'engineer', isOperator: false, mayManagePots: false, ...over,
});

describe('desktopAccess — a personal desktop is not an agent desktop', () => {
  const personal = { scope: 'user' as const, scopeRef: 'user-avi' };
  it('refuses a non-operator agent to drive or release it', () => {
    expect(desktopAccess(personal, caller(), 'drive')).toMatchObject({ ok: false, code: 'desktop_not_owned' });
    expect(desktopAccess(personal, caller({ mayManagePots: true }), 'release')).toMatchObject({ ok: false, code: 'desktop_not_owned' });
  });
  it('does not fall through to the pot rule when the harness slug equals the userId', () => {
    expect(desktopAccess(personal, caller({ harnessSlug: 'user-avi' }), 'drive')).toMatchObject({ ok: false });
  });
  it('lets an operator door through, matching the workspace-desktop precedent', () => {
    expect(desktopAccess(personal, caller({ isOperator: true }), 'drive')).toEqual({ ok: true });
  });
});
