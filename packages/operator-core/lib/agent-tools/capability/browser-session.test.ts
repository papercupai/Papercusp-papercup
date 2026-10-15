import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import type { Route } from 'playwright-core';
import { existsSync } from 'node:fs';
import { browserScope, browserSessionArg, browserResponseBytes, runBrowserSession, type BrowserDeps } from './browser-session';
import fetchTool from './fetch';

const trusted = { kind: 'trusted', reason: 'superuser' } as const;
const ctx = (owner = 'browser-test-owner', workspace = 'browser-test-workspace') => ({
  uiClientId: owner, workspaceId: workspace, harnessSlug: 'papercusp', role: 'operator',
  signal: new AbortController().signal, log: vi.fn(),
  isSuperuser: true,
}) as unknown as UnifiedToolContext;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });
function fixture() {
  let relay!: (route: Route) => Promise<void>;
  const page = { goto: vi.fn(async () => {}), locator: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
    evaluate: vi.fn(async () => ({ url: 'https://example.com/', title: 'page', text: 'rendered', links: [], truncated: false })),
    screenshot: vi.fn(async () => Buffer.from('png')) };
  const context = { route: vi.fn(async (_pattern, handler) => { relay = handler; }), routeWebSocket: vi.fn(async () => {}),
    newPage: vi.fn(async () => page), on: vi.fn() };
  const server = { close: vi.fn(async () => {}), kill: vi.fn(async () => {}), on: vi.fn<(event: string, handler: () => void) => void>() };
  const profile = vi.fn<BrowserDeps['profile']>(async () => trusted);
  const release = vi.fn(async () => {});
  const deps = {
    profile,
    launch: vi.fn(async () => ({ server, browser: { newContext: vi.fn(async () => context) }, taskId: 'browser-fixture-task', profile: trusted, sandbox: { mode: 'bwrap', sandboxed: true } })),
    fetch: vi.fn(async () => ({ response: new Response('safe'), release })),
  } as unknown as BrowserDeps;
  async function call(args: Parameters<typeof runBrowserSession>[0], owner = ctx(), url?: string) {
    const result = await runBrowserSession(args, url, owner, { timeoutMs: 1000, maxText: 500 }, deps);
    return { result, payload: JSON.parse(result.content[0].text!) };
  }
  async function open(owner = ctx()) {
    const { payload } = await call({ op: 'open' }, owner);
    expect(payload.ok).toBe(true); const id = payload.browser.id as string;
    cleanup.push(() => call({ op: 'close', id }, owner)); return id;
  }
  return { deps, page, server, profile, context, release, call, open, relay: () => relay };
}
function request(url = 'https://example.com/', method = 'GET') {
  return { request: () => ({ url: () => url, method: () => method, headers: () => ({ accept: 'text/html' }), redirectedFrom: () => null }),
    abort: vi.fn(async () => {}), fulfill: vi.fn(async () => {}) } as unknown as Route;
}

describe('managed browser authority and lifecycle', () => {
  it('keeps HTTP input compatible and validates lifecycle without model-authored authority', () => {
    expect(fetchTool.effect).toBe('write');
    expect(fetchTool.args.safeParse({ url: 'https://example.com' }).success).toBe(true);
    expect(fetchTool.args.safeParse({}).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open' } }).success).toBe(true);
    expect(fetchTool.args.safeParse({ browser: { op: 'navigate' } }).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open', scope: 'foreign' } }).success).toBe(false);
    expect(fetchTool.args.safeParse({ browser: { op: 'open' }, headers: { cookie: 'secret' } }).success).toBe(false);
    expect(browserSessionArg.safeParse({ op: 'open', id: crypto.randomUUID() }).success).toBe(false);
    expect(browserScope(ctx('a:b', 'c'))).not.toBe(browserScope(ctx('b', 'c:a')));
    expect(browserScope({ ...ctx(), harnessSlug: '*' } as UnifiedToolContext))
      .toBe(browserScope({ ...ctx(), harnessSlug: undefined } as UnifiedToolContext));
    expect(() => browserScope({ workspaceId: 'unattributed' } as UnifiedToolContext)).toThrow();
  });
  it('refuses file and credential URLs before launching any browser', async () => {
    const f = fixture();
    expect((await f.call({ op: 'open' }, ctx(), 'file:///etc/passwd')).payload.ok).toBe(false);
    expect((await f.call({ op: 'open' }, ctx(), 'https://user:password@example.com')).payload.ok).toBe(false);
    expect(f.deps.launch).not.toHaveBeenCalled();
  });
  it('denies another owner/workspace, closes explicitly, and reports ended handles unrecoverable', async () => {
    const f = fixture(); const id = await f.open();
    expect((await f.call({ op: 'observe', id }, ctx('foreign'))).payload.error).toBe('browser_unrecoverable');
    expect((await f.call({ op: 'close', id }, ctx('browser-test-owner', 'foreign'))).payload.ok).toBe(false);
    expect(f.server.close).not.toHaveBeenCalled();
    expect((await f.call({ op: 'close', id })).payload.browser.state).toBe('closed');
    expect((await f.call({ op: 'observe', id })).payload.error).toBe('browser_unrecoverable');
  });
  it('refuses cached authority after a role/profile change before another navigation', async () => {
    const f = fixture(); const id = await f.open();
    f.profile.mockResolvedValueOnce({ kind: 'confined', reason: 'autonomous-caller' });
    expect((await f.call({ op: 'navigate', id }, ctx(), 'https://example.com')).payload.error).toBe('browser_authority_changed');
    expect(f.page.goto).not.toHaveBeenCalled(); expect(f.server.close).toHaveBeenCalledOnce();
  });
  it('relays read requests only during a current operation and never caches its authority', async () => {
    const f = fixture(); const id = await f.open(); const idle = request();
    await f.relay()(idle); expect(idle.abort).toHaveBeenCalled(); expect(f.deps.fetch).not.toHaveBeenCalled();
    f.page.goto.mockImplementationOnce(async () => {
      const read = request(); await f.relay()(read); expect(read.fulfill).toHaveBeenCalled();
      const write = request('https://example.com/', 'POST'); await f.relay()(write); expect(write.abort).toHaveBeenCalled();
    });
    const { payload } = await f.call({ op: 'navigate', id }, ctx(), 'https://example.com/');
    expect(payload.network.refused).toContain('browser_remote_write_forbidden');
    expect(f.deps.fetch).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.deps.fetch).toHaveBeenCalledWith(expect.objectContaining({ profile: trusted, redirectMode: 'manual' }));
  });
  it('rejects overlapping calls, bounds media, and resets output between observations', async () => {
    const f = fixture(); const id = await f.open();
    let resume!: () => void; const held = new Promise<void>((resolve) => { resume = resolve; });
    let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
    f.page.goto.mockImplementationOnce(async () => { entered(); await held; });
    const first = f.call({ op: 'navigate', id, screenshot: true }, ctx(), 'https://example.com'); await entry;
    expect((await f.call({ op: 'observe', id })).payload.error).toBe('browser_busy');
    resume(); expect((await first).result.content[1].type).toBe('image');
    expect((await f.call({ op: 'observe', id })).result.content).toHaveLength(1);
  });
  it('uses the current operation callbacks rather than those that opened the browser', async () => {
    const f = fixture(); const id = await f.open();
    const current = { ...f.deps, profile: vi.fn(async () => trusted),
      fetch: vi.fn(async () => ({ response: new Response('current'), release: vi.fn(async () => {}) })) } as unknown as BrowserDeps;
    f.page.goto.mockImplementationOnce(async () => {
      const route = request(); await f.relay()(route); expect(route.fulfill).toHaveBeenCalled();
    });
    const result = await runBrowserSession({ op: 'navigate', id }, 'https://example.com/', ctx(), { timeoutMs: 1000, maxText: 500 }, current);
    expect(JSON.parse(result.content[0].text!).ok).toBe(true);
    expect(current.fetch).toHaveBeenCalledOnce(); expect(f.deps.fetch).not.toHaveBeenCalled();
    expect(current.profile).toHaveBeenCalledTimes(2);
  });
  it('fails closed on launch/confinement failure and releases pending capacity', async () => {
    const f = fixture(); vi.mocked(f.deps.launch).mockRejectedValueOnce(new Error('capability_exec_confinement_unavailable'));
    expect((await f.call({ op: 'open' })).payload).toMatchObject({ ok: false, launchAttempted: true });
    await f.open(); await f.open();
    expect((await f.call({ op: 'open' })).payload.error).toBe('browser_scope_limit');
  });
  it('records an unfinished startup stage before awaiting it and retains the original setup failure', async () => {
    const f = fixture(); const owner = ctx();
    let reject!: (error: Error) => void;
    f.context.newPage.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const opening = f.call({ op: 'open' }, owner);
    const stages = () => vi.mocked(owner.log).mock.calls
      .map(([text]) => String(text)).filter(text => text.startsWith('browser startup '))
      .map(text => JSON.parse(text.slice('browser startup '.length)));
    await vi.waitFor(() => expect(stages()).toContainEqual({ stage: 'browser-page', state: 'started' }));
    expect(stages().some(stage => stage.stage === 'browser-page' && stage.state === 'completed')).toBe(false);
    reject(new Error('fixture-page-start-failed'));
    expect((await opening).payload).toMatchObject({ ok: false, error: 'fixture-page-start-failed', launchAttempted: true });
    expect(stages()).toContainEqual({ stage: 'browser-page', state: 'failed', elapsedMs: expect.any(Number) });
    expect(f.server.kill).toHaveBeenCalledOnce();
    expect(existsSync(vi.mocked(f.deps.launch).mock.calls[0][1])).toBe(false);
  });
  it('serializes explicit close with active cancellation and never reports closure early', async () => {
    const f = fixture(); const owner = ctx(); const id = await f.open(owner);
    let entered!: () => void; const entry = new Promise<void>((resolve) => { entered = resolve; });
    let stop!: () => void;
    f.page.goto.mockImplementationOnce(async () => { entered(); await new Promise<void>((resolve) => { stop = resolve; }); throw new Error('closed'); });
    f.server.close.mockImplementationOnce(async () => { stop(); });
    const running = f.call({ op: 'navigate', id }, owner, 'https://example.com'); await entry;
    const closed = await f.call({ op: 'close', id }, owner);
    expect(closed.payload.browser.state).toBe('closed');
    expect((await running).payload.ok).toBe(false);
    expect(f.server.close).toHaveBeenCalledOnce();
  });
  it('waits for asynchronous terminal recording before reporting close complete', async () => {
    const f = fixture(); const launch = vi.mocked(f.deps.launch).getMockImplementation()!;
    let record!: () => void; const terminalRecorded = new Promise<void>(resolve => { record = resolve; });
    vi.mocked(f.deps.launch).mockImplementation(async (...args) => ({ ...await launch(...args), terminalRecorded }));
    const id = await f.open(); let completed = false;
    const close = f.call({ op: 'close', id }).then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(f.server.close).toHaveBeenCalledOnce());
    // The SDK is already closed, but the durable terminal callback is held.
    const early = await Promise.race([close.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
    record(); const closed = await close;
    expect(early).toBe(false); expect(completed).toBe(true);
    expect(closed.payload.browser.state).toBe('closed');
  });
  it('checks changing authority at the actual request boundary', async () => {
    const f = fixture(); const id = await f.open();
    f.page.goto.mockImplementationOnce(async () => {
      f.profile.mockResolvedValueOnce({ kind: 'confined', reason: 'autonomous-caller' });
      const route = request(); await f.relay()(route); expect(route.abort).toHaveBeenCalled();
    });
    expect((await f.call({ op: 'navigate', id }, ctx(), 'https://example.com')).payload.ok).toBe(false);
    expect(f.deps.fetch).not.toHaveBeenCalled(); expect(f.server.close).toHaveBeenCalledOnce();
  });
  it('counts pending launches so simultaneous opens cannot exceed capacity', async () => {
    const f = fixture(); const original = vi.mocked(f.deps.launch).getMockImplementation()!;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let both!: () => void; const entered = new Promise<void>((resolve) => { both = resolve; }); let count = 0;
    vi.mocked(f.deps.launch).mockImplementation(async (...args) => { if (++count === 2) both(); await gate; return original(...args); });
    const first = f.open(); const second = f.open(); await entered;
    expect((await f.call({ op: 'open' })).payload.error).toBe('browser_scope_limit');
    release(); await Promise.all([first, second]); expect(f.deps.launch).toHaveBeenCalledTimes(2);
  });
  it('retires idle sessions using existing explicit cleanup and truthful lifetime state', async () => {
    const f = fixture(); const id = await f.open();
    vi.useFakeTimers(); await f.call({ op: 'observe', id });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    const closed = await f.call({ op: 'close', id });
    expect(closed.payload.browser).toMatchObject({ state: 'closed', reason: 'idle-expired', restartRecovery: 'unrecoverable' });
    expect(f.server.close).toHaveBeenCalledOnce();
  });
  it('cleans an unexpectedly ended idle process and retains loss truth after explicit cleanup', async () => {
    const f = fixture(); const id = await f.open();
    const root = vi.mocked(f.deps.launch).mock.calls[0][1];
    expect(existsSync(root)).toBe(true);
    const ended = f.server.on.mock.calls.find(([event]) => event === 'close')![1] as () => void;
    ended();
    await vi.waitFor(() => expect(existsSync(root)).toBe(false));
    const lost = await f.call({ op: 'observe', id });
    expect(lost.payload).toMatchObject({ error: 'browser_unrecoverable', browser: {
      state: 'lost', reason: 'browser-process-ended', restartRecovery: 'unrecoverable',
    } });
    const closed = await f.call({ op: 'close', id });
    expect(closed.payload.browser).toMatchObject({ state: 'lost', reason: 'browser-process-ended' });
    expect(f.server.close).not.toHaveBeenCalled();
  });
  it('retains one browser registry when the module is evaluated again', async () => {
    const f = fixture(); const id = await f.open();
    vi.resetModules();
    const reloaded = await import('./browser-session');
    const result = await reloaded.runBrowserSession({ op: 'observe', id }, undefined, ctx(), { timeoutMs: 1000, maxText: 500 }, f.deps);
    expect(JSON.parse(result.content[0].text!).ok).toBe(true);
    expect(f.deps.launch).toHaveBeenCalledOnce();
  });
  it('preserves binary resources and cancels oversized or aggregate-exhausting streams', async () => {
    const active = () => ({ controller: new AbortController(), profile: trusted, requests: 0, bytes: 0, failures: [] as string[] });
    expect(await browserResponseBytes(new Response(new Uint8Array([0, 127, 255])), active())).toEqual(Buffer.from([0, 127, 255]));
    await expect(browserResponseBytes(new Response('large', { headers: { 'content-length': String(3 * 1024 * 1024) } }), active())).rejects.toThrow('browser_resource_size_limit');
    const aggregate = active(); aggregate.bytes = 16 * 1024 * 1024 - 1;
    await expect(browserResponseBytes(new Response('more'), aggregate)).rejects.toThrow('browser_resource_size_limit');
  });
});
