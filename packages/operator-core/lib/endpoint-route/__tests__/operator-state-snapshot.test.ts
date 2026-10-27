/**
 * Tests for the /state-snapshot SSE route. Drains the SSE wire stream
 * and asserts initial-dump + live-update shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth', () => ({ getSessionUser: vi.fn(), getSessionUserOrDefault: vi.fn(), resolveSessionToken: vi.fn(async () => 'current') }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }),
}));
vi.mock('../../agent-tools/operator/converse-card', () => ({
  snapshotConverseCards: vi.fn(async () => ({ snapshots: [], nextExpiryAt: null })),
}));
vi.mock('../../pg-listen-hub', () => ({ hubListen: vi.fn(async () => vi.fn()) }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(),
  // backup seam (pulled in transitively) reads workspacesRoot at import.
  workspacesRoot: vi.fn(() => '/tmp/papercusp-test-ws'),
}));
vi.mock('../telemetry', () => ({
  recordRouteInvocation: vi.fn(async () => {}),
}));

import { Hono } from 'hono';
import { getSessionUser, getSessionUserOrDefault } from '../../auth';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  _resetStateChannelForTests,
  openRun,
  setOpenCards,
} from '@papercusp/agent-mcp';
import type { OpenCardSnapshot } from '@papercusp/agent-mcp';
import { snapshotConverseCards } from '../../agent-tools/operator/converse-card';
import { hubListen } from '../../pg-listen-hub';
import { registerRoute } from '../define-route';
import stateSnapshot from '../routes/operator/state-snapshot';

const ws = 'ws-test';

function card(id: string): OpenCardSnapshot {
  return {
    correlationId: id,
    prompt: `q-${id}`,
    dataSchemaJson: { type: 'object' },
    createdAt: Date.now(),
  };
}

let app: Hono;

function openSseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  async function next(timeoutMs: number, event = 'snapshot'): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = buf.indexOf('\n\n');
      if (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.includes(`event: ${event}`)) return block;
        continue;
      }
      const readPromise = reader.read();
      const timed = await Promise.race([
        readPromise,
        new Promise<null>((r) => setTimeout(() => r(null), deadline - Date.now())),
      ]);
      if (!timed) return null;
      if (timed.done) return null;
      buf += decoder.decode(timed.value, { stream: true });
    }
    return null;
  }

  async function close() { await reader.cancel().catch(() => {}); }
  return { next, close };
}

describe('GET /api/operator/state-snapshot', () => {
  beforeEach(() => {
    _resetStateChannelForTests();
    vi.mocked(getSessionUser).mockReset();
    vi.mocked(getSessionUserOrDefault).mockReset();
    vi.mocked(activeWorkspaceId).mockReset();
    vi.mocked(getSessionUser).mockResolvedValue({
      id: 'u1',
      username: 'alice',
      display_name: 'Alice',
      has_password: true,
      workspace_id: ws,
      capabilities: ['*'],
    });
    vi.mocked(getSessionUserOrDefault).mockResolvedValue({
      id: 'u0',
      username: 'default',
      display_name: 'User',
      has_password: false,
    });
    vi.mocked(activeWorkspaceId).mockReturnValue(ws);
    vi.mocked(snapshotConverseCards).mockReset();
    vi.mocked(snapshotConverseCards).mockImplementation(async input => ({ snapshots: input.live, nextExpiryAt: null }));
    vi.mocked(hubListen).mockReset();
    vi.mocked(hubListen).mockResolvedValue(vi.fn());
    app = new Hono().basePath('/api');
    registerRoute(app, stateSnapshot);
  });
  afterEach(() => _resetStateChannelForTests());

  it('401 without session for a NON-loopback caller (perimeter preserved, WI-5044)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    const res = await app.request('/api/operator/state-snapshot', {
      headers: { host: 'evil.example.com' },
    });
    expect(res.status).toBe(401);
  });

  it('LOOPBACK caller without a session gets the seeded default user — the desktop webview path (WI-5044)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);
    openRun({ workspaceId: ws, runId: 'rDesk' });
    setOpenCards('rDesk', [card('d1')]);

    // Hono test requests resolve to http://localhost/… — a loopback host.
    const res = await app.request('/api/operator/state-snapshot');
    expect(res.status).toBe(200);
    const r = openSseReader(res);
    const first = await r.next(1000);
    await r.close();
    expect(first).not.toBeNull();
    expect(JSON.parse(first!.split('data: ')[1]).runId).toBe('rDesk');
  });

  it('initial dump: streams every currently-open run snapshot on connect', async () => {
    openRun({ workspaceId: ws, runId: 'rA' });
    openRun({ workspaceId: ws, runId: 'rB' });
    setOpenCards('rA', [card('a1')]);
    setOpenCards('rB', [card('b1'), card('b2')]);
    openRun({ workspaceId: 'other-ws', runId: 'rOther' });
    setOpenCards('rOther', [card('o1')]);

    const res = await app.request('/api/operator/state-snapshot');
    const r = openSseReader(res);
    const a = await r.next(1000);
    const b = await r.next(1000);
    await r.close();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const runIds = [a!, b!].map((e) => JSON.parse(e.split('data: ')[1]).runId);
    expect(new Set(runIds)).toEqual(new Set(['rA', 'rB']));
  });

  it('live updates: a setOpenCards after connect produces a snapshot event', async () => {
    openRun({ workspaceId: ws, runId: 'rLive' });
    setOpenCards('rLive', [card('first')]);

    const res = await app.request('/api/operator/state-snapshot');
    const r = openSseReader(res);
    const initial = await r.next(1000);
    expect(initial).not.toBeNull();

    setOpenCards('rLive', [card('first'), card('second')]);
    const live = await r.next(1000);
    await r.close();
    expect(live).not.toBeNull();
    const payload = JSON.parse(live!.split('data: ')[1]);
    expect(payload.snapshot.openCards.length).toBe(2);
    expect(payload.version).toBeGreaterThan(1);
  });

  it('uses the authenticated workspace when the host active workspace differs', async () => {
    vi.mocked(activeWorkspaceId).mockReturnValue('other-ws');
    openRun({ workspaceId: ws, runId: 'session-run' });
    setOpenCards('session-run', [card('session-card')]);
    openRun({ workspaceId: 'other-ws', runId: 'foreign-run' });
    setOpenCards('foreign-run', [card('foreign-card')]);
    const r = openSseReader(await app.request('/api/operator/state-snapshot'));
    const first = await r.next(1000);
    await r.close();
    expect(JSON.parse(first!.split('data: ')[1]).runId).toBe('session-run');
  });

  it('hydrates durable cards without a local run and emits a reconnect reset first', async () => {
    vi.mocked(snapshotConverseCards).mockResolvedValue({ snapshots: [{ runId: 'recovered',
      workspaceId: ws, version: 0, snapshot: { openCards: [card('durable')] } }], nextExpiryAt: null });
    const r = openSseReader(await app.request('/api/operator/state-snapshot'));
    expect(await r.next(1000, 'reset')).toContain(ws);
    expect(JSON.parse((await r.next(1000))!.split('data: ')[1]).snapshot.openCards[0].correlationId).toBe('durable');
    await r.close();
    expect(snapshotConverseCards).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: ws,
      authorizeAdditional: expect.any(Function) }));
  });

  it('rereads committed notifications and clears a removed durable run', async () => {
    let wake!: () => void;
    const off = vi.fn();
    vi.mocked(hubListen).mockImplementation(async (_channel, cb) => { wake = () => cb('changed'); return off; });
    vi.mocked(snapshotConverseCards).mockResolvedValue({ snapshots: [{ runId: 'recovered',
      version: 0, snapshot: { openCards: [card('durable')] } }], nextExpiryAt: null });
    const r = openSseReader(await app.request('/api/operator/state-snapshot'));
    await r.next(1000);
    vi.mocked(snapshotConverseCards).mockResolvedValue({ snapshots: [], nextExpiryAt: null });
    wake();
    const cleared = JSON.parse((await r.next(1000))!.split('data: ')[1]);
    expect(cleared).toMatchObject({ runId: 'recovered', snapshot: { openCards: [] } });
    await r.close();
    expect(off).toHaveBeenCalledOnce();
  });

  it.each([['unauthorized', 403], ['storage-unavailable', 503]])('refuses %s without falling back to local cards', async (error, status) => {
    openRun({ workspaceId: ws, runId: 'local' });
    setOpenCards('local', [card('secret')]);
    vi.mocked(snapshotConverseCards).mockRejectedValue(new Error(error));
    const res = await app.request('/api/operator/state-snapshot');
    if (res.body && res.status === 200) await res.body.cancel();
    expect(res.status).toBe(status);
  });
});
