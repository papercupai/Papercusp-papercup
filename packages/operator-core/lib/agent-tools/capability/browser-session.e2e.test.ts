/** Real Chromium/HTTP journey; ledger adapter mocked, no PostgreSQL writes.
 * Uses the maintained e2e config; actual ledger persistence/API acceptance stays separate. */
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';

const ledger = vi.hoisted(() => ({ register: vi.fn(async (_spec: { cwd: string }, _scope: unknown) => ({ taskId: 'browser-integration-task' })), mark: vi.fn(async () => {}), close: vi.fn(async () => true) }));
vi.mock('../../task-manager/store', () => ({ registerTask: ledger.register, markSpawned: ledger.mark, closeTask: ledger.close }));
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('./exec-sandbox')>(),
  capabilityExecSandboxPolicy: async () => ({ enabled: false, required: false, profile: { kind: 'trusted', reason: 'superuser' } }),
}));
import { runBrowserSession, launchBrowserProcess } from './browser-session';
import { fetchWithCapabilityPolicy } from './fetch-policy';

describe('browser DOM session against real Chromium and HTTP', () => {
  let server: Server; let base = ''; let id = ''; let writes = 0;
  const ctx = { uiClientId: 'browser-private-integration', workspaceId: 'browser-private-workspace', harnessSlug: 'papercusp', role: 'operator',
    isSuperuser: true,
    signal: new AbortController().signal, log: vi.fn() } as unknown as UnifiedToolContext;
  const deps = { launch: launchBrowserProcess, profile: async () => ({ kind: 'trusted', reason: 'superuser' } as const), fetch: fetchWithCapabilityPolicy };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'POST') writes++;
      if (req.url === '/redirect') { res.writeHead(302, { location: '/page' }); res.end(); return; }
      if (req.url === '/data') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hydrated DOM'); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>browser fixture</title></head><body><a href="/next">next</a><script>fetch("/data").then(r=>r.text()).then(t=>{let n=document.createElement("p");n.id="ready";n.textContent=t;document.body.append(n)});fetch("/write",{method:"POST"}).catch(()=>{});</script></body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP fixture required');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    if (id) await runBrowserSession({ op: 'close', id }, undefined, ctx, { timeoutMs: 5000, maxText: 500 }, deps);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });
  it('preserves dynamic DOM and redirect location, refuses remote writes, returns real PNG and closes its process', async () => {
    const opened = await runBrowserSession({ op: 'open', selector: '#ready', screenshot: true }, `${base}/redirect`, ctx, { timeoutMs: 20_000, maxText: 500 }, deps);
    const payload = JSON.parse(opened.content[0].text!);
    expect(payload.ok, JSON.stringify(payload)).toBe(true); id = payload.browser.id;
    expect(payload.observation).toMatchObject({ url: `${base}/page`, title: 'browser fixture', text: 'hydrated DOM' });
    expect(opened.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(writes).toBe(0); expect(payload.network.refused).toContain('browser_remote_write_forbidden');
    const again = await runBrowserSession({ op: 'observe', id, selector: '#ready' }, undefined, ctx, { timeoutMs: 5000, maxText: 5 }, deps);
    expect(JSON.parse(again.content[0].text!).observation).toMatchObject({ text: 'hydra', truncated: true });
    const closed = await runBrowserSession({ op: 'close', id }, undefined, ctx, { timeoutMs: 5000, maxText: 500 }, deps);
    expect(JSON.parse(closed.content[0].text!).browser.state).toBe('closed');
    expect(ledger.register).toHaveBeenCalledWith(expect.objectContaining({ launchedBy: 'browser-private-integration', class: 'browser' }), expect.anything());
    expect(ledger.mark).toHaveBeenCalled(); expect(ledger.close).toHaveBeenCalled();
    id = '';
  }, 30_000);
  it.each(['browser-private-home-', 'browser-private-home-with-long-temporary-path-'])(
    'launches with private HOME and TMPDIR (%s) without inheriting a host browser profile', async prefix => {
    const root = await mkdtemp(join(tmpdir(), prefix));
    const home = join(root, 'home'); const temp = join(root, 'tmp');
    await Promise.all([mkdir(home), mkdir(temp)]);
    const privateCtx = { ...ctx, uiClientId: 'browser-private-home', log: vi.fn() } as UnifiedToolContext;
    let privateId: string | undefined;
    let browserRoot: string | undefined;
    vi.stubEnv('HOME', home); vi.stubEnv('TMPDIR', temp);
    try {
      const opened = await runBrowserSession({ op: 'open' }, undefined, privateCtx, { timeoutMs: 20_000, maxText: 500 }, deps);
      const payload = JSON.parse(opened.content[0].text!);
      expect(payload.ok, JSON.stringify({ payload, startup: vi.mocked(privateCtx.log).mock.calls })).toBe(true);
      privateId = payload.browser.id;
      browserRoot = ledger.register.mock.calls.at(-1)![0].cwd;
      expect(existsSync(browserRoot)).toBe(true);
      expect(payload.observation.url).toBe('about:blank');
    } finally {
      if (privateId) await runBrowserSession({ op: 'close', id: privateId }, undefined, privateCtx, { timeoutMs: 5000, maxText: 500 }, deps);
      if (browserRoot) expect(existsSync(browserRoot)).toBe(false);
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
