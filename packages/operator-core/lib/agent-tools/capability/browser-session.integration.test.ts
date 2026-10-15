/** Real Chromium + real task ledger, isolated PostgreSQL; no operator or fleet mutation. */
import { createServer, type Server } from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../capability-envelope/session-confinement-store', () => ({
  ensureSessionConfinementsReady: async () => {}, sessionConfinementFor: () => null,
}));
// Trusted flag defaults are fixture-local. The real policy still forces confined callers on.
vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));

import { runBrowserSession } from './browser-session';
import { capabilityBwrapWorks } from './exec-sandbox';
import { getTask } from '../../task-manager/store';
import { readProcessIdentity } from '../../process-identity';
import { setAutoPumpEnabledForTests } from '../../events/await/engine';
import { taskTerminalEventKey } from '../../task-manager/task-terminal-events';
import { startPrimaryOwnerRpcRelay, type OwnerRpcWorkerLike } from '../../cluster-owner-rpc';
import { reconcileTick } from '../../task-manager/reconcile-tick';

describe('managed browser process enrollment and loss (real PG/Chromium)', () => {
  let db: OrgTestDb; let server: Server; let base = '';
  const handles: Array<{ id: string; ctx: UnifiedToolContext }> = [];
  const context = (suffix: string, confined = false) => ({
    workspaceId: 'browser-ledger-workspace', uiClientId: `browser-ledger-${suffix}`,
    harnessSlug: 'papercusp', role: 'operator', isSuperuser: !confined, sigVerifiedSpawn: confined,
    signal: new AbortController().signal, log: vi.fn(),
  }) as unknown as UnifiedToolContext;
  async function call(args: Parameters<typeof runBrowserSession>[0], ctx: UnifiedToolContext, url?: string) {
    const result = await runBrowserSession(args, url, ctx, { timeoutMs: 20_000, maxText: 1000 });
    return { result, body: JSON.parse(result.content[0].text!) };
  }
  async function open(ctx: UnifiedToolContext) {
    const opened = await call({ op: 'open', selector: '#ready', screenshot: true }, ctx, base);
    if (opened.body.ok) handles.push({ id: opened.body.browser.id, ctx });
    return opened;
  }
  beforeAll(async () => {
    db = await createOrgTestDb(); h.sql = db.adminSql;
    // Preserve real terminal-event persistence; host delivery is outside this
    // private fixture and must not race database teardown.
    setAutoPumpEnabledForTests(false);
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>enrolled browser</title></head><body><p id="ready">real managed page</p></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP fixture required');
    base = `http://127.0.0.1:${address.port}/`;
  }, 60_000);
  afterAll(async () => {
    for (const handle of handles) await call({ op: 'close', id: handle.id }, handle.ctx);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.cleanup();
  });
  it('enrolls exact workspace/owner/kernel identity and closes the real row and directory', async () => {
    const ctx = context('trusted'); const { body, result } = await open(ctx);
    expect(body.ok, JSON.stringify({ body, startup: vi.mocked(ctx.log).mock.calls })).toBe(true);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const row = (await getTask(body.browser.task_id))!;
    expect(row).toMatchObject({ class: 'browser', state: 'running', workspaceId: ctx.workspaceId,
      launchedBy: ctx.uiClientId, sessionId: ctx.uiClientId, harnessSlug: 'papercusp',
      detail: { browserSessionId: body.browser.id } });
    expect(row.processIdentity).toBe(readProcessIdentity(row.pid!));
    expect(row.processIdentity).toBeTruthy(); expect(existsSync(row.cwd!)).toBe(true);
    expect((await call({ op: 'close', id: body.browser.id }, context('foreign'))).body.ok).toBe(false);
    expect((await getTask(row.taskId))!.state).toBe('running');
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('closed');
    // The reply must await closeTask's terminal bridge, not merely its earlier UPDATE.
    const [fire] = await h.sql`SELECT fire_count FROM harness_shared.event_key_fires
      WHERE event_key = ${taskTerminalEventKey(row.taskId)}`;
    expect(Number(fire?.fire_count)).toBe(1);
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
    expect(existsSync(row.cwd!)).toBe(false); expect(readProcessIdentity(row.pid!)).toBeNull();
  }, 30_000);
  it('cleans unexpected real Chromium death without claiming recoverable page state', async () => {
    const ctx = context('lost'); const { body } = await open(ctx);
    expect(body.ok, JSON.stringify({ body, startup: vi.mocked(ctx.log).mock.calls })).toBe(true);
    const row = (await getTask(body.browser.task_id))!;
    expect(readProcessIdentity(row.pid!)).toBe(row.processIdentity);
    process.kill(row.pid!, 'SIGKILL'); // Exact freshly enrolled test child only.
    await vi.waitFor(() => expect(existsSync(row.cwd!)).toBe(false), { timeout: 5000 });
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
    expect((await call({ op: 'observe', id: body.browser.id }, ctx)).body).toMatchObject({
      ok: false, error: 'browser_unrecoverable', browser: { state: 'lost', reason: 'browser-process-ended' },
    });
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('lost');
    expect(readProcessIdentity(row.pid!)).toBeNull();
  }, 30_000);
  it('cleans real Chromium, its directory and ledger after owner worker SIGKILL', async () => {
    const workers: Record<string, OwnerRpcWorkerLike> = {};
    const listeners = new Set<(worker: OwnerRpcWorkerLike, message: unknown) => void>();
    const relay = startPrimaryOwnerRpcRelay({ cluster: { workers,
      on: (_event, listener) => listeners.add(listener), off: (_event, listener) => listeners.delete(listener) } });
    const children: ChildProcess[] = []; let row: Awaited<ReturnType<typeof getTask>> = null;
    let seq = 0;
    async function start() {
      const child = fork(fileURLToPath(new URL('./__fixtures__/browser-owner-worker.mts', import.meta.url)), [], {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
      });
      children.push(child);
      const worker: OwnerRpcWorkerLike = { process: { pid: child.pid }, send: message => child.send(message as never),
        isDead: () => child.exitCode !== null || child.signalCode !== null, isConnected: () => child.connected };
      workers[String(child.pid)] = worker;
      child.on('message', message => { for (const listener of listeners) listener(worker, message); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('real browser worker startup timed out')), 15_000);
        child.on('message', (message: any) => { if (message.type === 'fixture:ready') { clearTimeout(timer); resolve(); } });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('real browser worker exited before ready')); });
      });
      return child;
    }
    async function request(child: ChildProcess, args: Record<string, unknown>) {
      const callSeq = ++seq;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', receive); reject(new Error('real browser worker call timed out')); }, 25_000);
        const receive = (message: any) => {
          if (message.type !== 'fixture:result' || message.seq !== callSeq) return;
          clearTimeout(timer); child.off('message', receive);
          if (message.error) reject(new Error(message.error)); else resolve(JSON.parse(message.result.content[0].text));
        };
        child.on('message', receive);
        child.send({ type: 'fixture:call', seq: callSeq, enrolled: true, workspace: 'browser-ledger-workspace',
          owner: 'browser-ledger-worker-death', ...args });
      });
    }
    try {
      const owner = await start(); const sibling = await start();
      const opened = await request(owner, { args: { op: 'open', selector: '#ready' }, url: base });
      expect(opened.ok, JSON.stringify(opened)).toBe(true);
      row = await getTask(opened.browser.task_id);
      expect(row).toMatchObject({ state: 'running', launchedBy: 'browser-ledger-worker-death' });
      expect(readProcessIdentity(row!.pid!)).toBe(row!.processIdentity);
      expect(existsSync(row!.cwd!)).toBe(true);
      const died = once(owner, 'exit'); owner.kill('SIGKILL'); await died;
      expect(await request(sibling, { args: { op: 'observe', id: opened.browser.id } }))
        .toMatchObject({ error: 'browser_unrecoverable', restartRecovery: 'unrecoverable' });
      await vi.waitFor(() => expect(readProcessIdentity(row!.pid!)).toBeNull(), { timeout: 5000 });
      // Exercise the maintained periodic path with only this private ledger row.
      // The absent child was measured above; other host processes are out of scope.
      const reconciled = await reconcileTick({ listLive: async () => [row!], graceMs: 0,
        notify: async () => {}, scan: () => ({ processes: [], ownedRootAbs: '/sys/fs/cgroup/private-test',
          ownedRootExists: true, userManagerRoot: null, ownedTruncated: false, foreignTruncated: false,
          unlistedIdentityByPid: new Map() }) });
      expect(reconciled.degraded).toBe(false); expect(reconciled.strandedCount).toBe(1);
      await vi.waitFor(() => expect(existsSync(row!.cwd!)).toBe(false), { timeout: 5000 });
      expect((await getTask(row!.taskId))!.state).toBe('stranded');
      const [fire] = await h.sql`SELECT fire_count FROM harness_shared.event_key_fires
        WHERE event_key = ${taskTerminalEventKey(row!.taskId)}`;
      expect(Number(fire?.fire_count)).toBe(1);
    } finally {
      relay.stop();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) {
        const died = once(child, 'exit'); child.kill(); await died;
      }
      // Drain only the fresh fixture child if a regression leaves it alive.
      if (row?.pid && readProcessIdentity(row.pid) === row.processIdentity) {
        try { process.kill(-row.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
      }
      if (row?.cwd) await rm(row.cwd, { recursive: true, force: true });
    }
  }, 60_000);
  it(capabilityBwrapWorks()
    ? 'forces real bwrap network confinement for verified autonomous callers'
    : 'refuses unavailable OS confinement before autonomous process enrollment', async () => {
    // Confined HTTP intentionally refuses loopback targets. Open about:blank to
    // measure OS containment independently of the fixture server's trusted URL.
    const ctx = context('confined', true); const { body } = await call({ op: 'open' }, ctx);
    if (body.ok) handles.push({ id: body.browser.id, ctx });
    if (!capabilityBwrapWorks()) {
      expect(body).toMatchObject({ ok: false, error: 'capability_exec_confinement_unavailable' });
      const rows = await h.sql`SELECT task_id FROM harness_shared.task_ledger WHERE launched_by = ${ctx.uiClientId!}`;
      expect(rows).toHaveLength(0); return;
    }
    expect(body.ok, JSON.stringify({ body, startup: vi.mocked(ctx.log).mock.calls })).toBe(true);
    expect(body.browser.sandbox).toMatchObject({ mode: 'bwrap', sandboxed: true });
    const row = (await getTask(body.browser.task_id))!;
    const args = row.argv as string[];
    expect(args).toContain('--unshare-net'); expect(args).toContain('--ro-bind');
    // launchServer.process() is bwrap's host-side supervisor, whose namespace
    // is not Chromium's. Follow only this freshly enrolled child's descendants.
    const pending = [row.pid!]; let browserPid: number | undefined;
    while (pending.length) {
      const pid = pending.pop()!;
      try {
        const executable = readlinkSync(`/proc/${pid}/exe`);
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (/\/(chrome|chrome-headless-shell)$/.test(executable) && !argv.includes('--type=')) {
          browserPid = pid; break;
        }
        pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
      } catch { /* A short-lived intermediate child may have exited. */ }
    }
    expect(browserPid, 'live Chromium must exist under the enrolled supervisor').toBeDefined();
    const hostNet = readFileSync('/proc/self/net/dev', 'utf8');
    const childNet = readFileSync(`/proc/${browserPid}/net/dev`, 'utf8');
    expect(childNet.trim().split('\n')).toHaveLength(3);
    expect(hostNet.trim().split('\n').length).toBeGreaterThan(3);
    expect(body.observation.url).toBe('about:blank');
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('closed');
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
  }, 30_000);
});
