/** Process-local Playwright sessions behind capability:fetch, not a second network/job authority. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ramTmpRoot } from '@papercusp/orchestrator';
import { z } from 'zod';
import { pinModuleState } from '@papercusp/module-singleton';
import type { Browser, BrowserContext, BrowserServer, Page, Route } from 'playwright-core';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { capabilityExecSandboxPolicy, buildCapabilitySandboxCommand, assertCapabilitySandboxAvailable, scrubExecEnv } from './exec-sandbox';
import type { OperationBoundaryProfile } from './boundary-profile';
import { fetchWithCapabilityPolicy, parseAndValidateUrl } from './fetch-policy';
import { registerTask, markSpawned, closeTask } from '../../task-manager/store';
import { readProcessIdentity } from '../../process-identity';

export const browserSessionArg = z.object({
  op: z.enum(['open', 'navigate', 'observe', 'close']),
  id: z.string().uuid().optional(),
  selector: z.string().min(1).max(1000).optional().describe('CSS selector to wait for/observe; no arbitrary JavaScript.'),
  screenshot: z.boolean().optional().describe('Return a bounded viewport PNG as an MCP image.'),
  max_text_chars: z.number().int().positive().max(20_000).optional().describe('DOM text character ceiling; default 10000. Result-door byte policy still applies.'),
}).strict().superRefine((args, ctx) => {
  if (args.op !== 'open' && !args.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'existing browser operation requires id' });
  if (args.op === 'open' && args.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'open creates its own id' });
});
export type BrowserSessionArgs = z.infer<typeof browserSessionArg>;
const IDLE_MS = 5 * 60_000;
const PER_SCOPE = 2;
const MAX_LIVE = 16;
const RESOURCE_BYTES = 2 * 1024 * 1024;
const OPERATION_BYTES = 16 * 1024 * 1024;
const MAX_REQUESTS = 100;

interface ActiveOperation {
  controller: AbortController;
  ctx?: UnifiedToolContext;
  deps?: BrowserDeps;
  profile: OperationBoundaryProfile;
  bytes: number;
  requests: number;
  failures: string[];
}
interface Session {
  id: string; scope: string; authority: string; taskId: string; root: string;
  server: BrowserServer; browser: Browser; context: BrowserContext; page: Page;
  sandbox: { mode: string; sandboxed: boolean };
  terminalRecorded?: Promise<void>;
  busy: boolean; active?: ActiveOperation; idle?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  state: 'live' | 'closing' | 'closed' | 'lost'; reason?: string; endedAt?: number; processEnded: boolean;
}
const { sessions, openings } = pinModuleState('@papercusp/operator-core.browser-sessions', () => ({
  sessions: new Map<string, Session>(), openings: new Map<string, number>(),
}));

export function browserScope(ctx: UnifiedToolContext): string {
  if (!ctx.workspaceId?.trim()) throw new Error('browser_workspace_required');
  const harnessSlug = resolveConcreteHarnessSlug(undefined, ctx);
  return JSON.stringify([ctx.workspaceId, resolveAgentIdentity(ctx).ownerId, harnessSlug]);
}
function status(session: Session) {
  return { id: session.id, task_id: session.taskId, state: session.state, busy: session.busy,
    restartRecovery: 'unrecoverable', networkBetweenOperations: 'blocked', sandbox: session.sandbox,
    ...(session.reason ? { reason: session.reason } : {}) };
}
function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Emit before awaiting so a stalled startup retains its exact unfinished stage. */
async function browserStartupStage<T>(ctx: UnifiedToolContext, stage: string, run: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  ctx.log(`browser startup ${JSON.stringify({ stage, state: 'started' })}`);
  try {
    const result = await run();
    ctx.log(`browser startup ${JSON.stringify({ stage, state: 'completed', elapsedMs: Math.round(performance.now() - started) })}`);
    return result;
  } catch (error) {
    ctx.log(`browser startup ${JSON.stringify({ stage, state: 'failed', elapsedMs: Math.round(performance.now() - started) })}`);
    throw error;
  }
}

/** Enrol the SDK-owned process before launch; its maintained launcher closes the whole process group. */
export async function launchBrowserProcess(ctx: UnifiedToolContext, root: string, id: string, timeoutMs: number): Promise<{
  server: BrowserServer; browser: Browser; taskId: string; profile: OperationBoundaryProfile;
  sandbox: { mode: string; sandboxed: boolean }; terminalRecorded?: Promise<void>;
}> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0 || ctx.signal?.aborted) throw new Error('browser_operation_aborted'); return ms; };
  const { chromium } = await browserStartupStage(ctx, 'sdk-import', () => import('playwright-core'));
  const policy = await browserStartupStage(ctx, 'sandbox-policy', () => capabilityExecSandboxPolicy(ctx));
  // HTTP is relayed by fetch-policy. A confined Chromium needs no independent host egress.
  const sandbox = buildCapabilitySandboxCommand({ cmd: [chromium.executablePath()], cwd: root },
    { enabled: policy.enabled, required: policy.required, srtBin: null, denyAllEgress: true });
  await browserStartupStage(ctx, 'sandbox-preflight', () => assertCapabilitySandboxAvailable(sandbox, root));
  const wrapper = join(root, 'launch-browser');
  // Playwright allocates its profile before invoking this wrapper, outside cwd.
  // The fresh /dev or /tmp sandbox mount can hide that SDK-owned directory.
  // Bind only the SDK's exact generated profile, retaining SDK cleanup ownership.
  const script = sandbox.mode === 'bwrap'
    ? '#!/bin/sh\nprofile=\nfor arg do\ncase "$arg" in --user-data-dir=*) profile="${arg#--user-data-dir=}";; esac\ndone\n' +
      '[ -n "$profile" ] || exit 64\nexec ' + [sandbox.binary, ...sandbox.argv.slice(0, -2)].map(quote).join(' ') +
      ' --bind "$profile" "$profile" -- ' + quote(sandbox.argv.at(-1)!) + ' "$@"\n'
    : '#!/bin/sh\nexec ' + [sandbox.binary, ...sandbox.argv].map(quote).join(' ') + ' "$@"\n';
  await browserStartupStage(ctx, 'launcher-write', () => writeFile(wrapper, script, { mode: 0o700 }));
  const ownerId = resolveAgentIdentity(ctx).ownerId;
  const row = await browserStartupStage(ctx, 'task-register', () => registerTask({ class: 'browser', title: 'Managed browser session', argv: [sandbox.binary, ...sandbox.argv],
    cwd: root, launchedBy: ownerId, sessionId: ownerId, harnessSlug: resolveConcreteHarnessSlug(undefined, ctx) ?? undefined,
    detail: { surface: 'capability:fetch', browserSessionId: id, restartRecovery: 'unrecoverable' } }, { workspaceId: ctx.workspaceId }));
  let server: BrowserServer | undefined;
  try {
    // The reconciler survives a request-worker SIGKILL. Bind its cleanup
    // receipt to this exact directory and ledger row before starting Chromium.
    await writeFile(join(root, '.browser-task.json'), JSON.stringify({
      taskId: row.taskId, browserSessionId: id, workspaceId: ctx.workspaceId,
    }), { flag: 'wx', mode: 0o600 });
    server = await browserStartupStage(ctx, 'chromium-launch', () => chromium.launchServer({ executablePath: wrapper, headless: true, host: '127.0.0.1', timeout: remaining(),
      env: { ...scrubExecEnv(process.env), TMPDIR: root },
      args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-features=WebTransport', '--enable-logging=stderr'] }));
    const child = server.process();
    const spawned = markSpawned(row.taskId, { pid: child.pid, processIdentity: child.pid ? readProcessIdentity(child.pid) : null,
      confined: false, unconfinedReason: 'SDK process group; execution sandbox is reported separately' });
    let terminalResolve!: () => void; let terminalReject!: (error: unknown) => void;
    const terminalRecorded = new Promise<void>((resolve, reject) => { terminalResolve = resolve; terminalReject = reject; });
    // Register before awaiting enrollment, including a process that exits during
    // that write. Serialize terminal recording behind the spawned identity.
    server.on('close', () => {
      void spawned.then(() => closeTask(row.taskId, {
        state: 'exited', exitCode: child.exitCode, exitReason: 'browser-process-ended',
      })).then(() => terminalResolve(), terminalReject);
    });
    void terminalRecorded.catch((error) => ctx.log(`browser terminal ledger failed: ${String(error)}`));
    await browserStartupStage(ctx, 'task-spawned', () => spawned);
    const endpoint = server.wsEndpoint();
    const browser = await browserStartupStage(ctx, 'chromium-connect', () => chromium.connect(endpoint, { timeout: remaining() }));
    return { server, browser, taskId: row.taskId, profile: policy.profile,
      sandbox: { mode: sandbox.mode, sandboxed: sandbox.sandboxed }, terminalRecorded };
  } catch (error) {
    if (server) await server.kill();
    await closeTask(row.taskId, { state: 'exited', exitCode: server?.process().exitCode ?? null, exitReason: 'browser-launch-failed' });
    throw error;
  }
}

export interface BrowserDeps {
  launch: typeof launchBrowserProcess;
  profile: (ctx: UnifiedToolContext) => Promise<OperationBoundaryProfile>;
  fetch: typeof fetchWithCapabilityPolicy;
}
export const defaultBrowserDeps: BrowserDeps = {
  launch: launchBrowserProcess,
  profile: async (ctx) => (await capabilityExecSandboxPolicy(ctx)).profile,
  fetch: fetchWithCapabilityPolicy,
};

/** Stream binary resources with a per-resource and aggregate hard ceiling. */
export async function browserResponseBytes(response: Response, active: ActiveOperation): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESOURCE_BYTES) {
    await response.body?.cancel(); throw new Error('browser_resource_size_limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      if (active.controller.signal.aborted) throw new Error('browser_operation_aborted');
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; active.bytes += next.value.byteLength;
      if (size > RESOURCE_BYTES || active.bytes > OPERATION_BYTES) throw new Error('browser_resource_size_limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

export async function closeBrowserSession(session: Session, reason: string): Promise<void> {
  if (session.closing) return session.closing;
  const lost = session.state === 'lost';
  if (!lost) { session.reason = reason; session.state = 'closing'; }
  if (session.idle) clearTimeout(session.idle);
  // Assign before aborting: abort's listener may request this same cleanup.
  session.closing = Promise.resolve().then(async () => {
    session.active?.controller.abort();
    if (!session.processEnded) {
      try { await session.server.close(); }
      catch { await session.server.kill(); }
    }
    await session.terminalRecorded;
    session.processEnded = true; session.state = lost ? 'lost' : 'closed'; session.endedAt ??= Date.now();
    await rm(session.root, { recursive: true, force: true });
  }).catch((error) => { session.state = 'lost'; session.reason = 'cleanup-unconfirmed'; throw error; });
  return session.closing;
}
function armIdle(session: Session): void {
  if (session.idle) clearTimeout(session.idle);
  if (session.state !== 'live') return;
  session.idle = setTimeout(() => { void closeBrowserSession(session, 'idle-expired').catch(() => { session.state = 'lost'; }); }, IDLE_MS);
  session.idle.unref?.();
}

async function relay(session: Session, route: Route): Promise<void> {
  const active = session.active;
  if (!active?.deps || active.controller.signal.aborted) { await route.abort('blockedbyclient').catch(() => {}); return; }
  const deps = active.deps;
  let release: (() => Promise<void>) | undefined;
  try {
    if (active.ctx) {
      const latest = await deps.profile(active.ctx);
      if (JSON.stringify([latest, active.ctx.role ?? null]) !== session.authority) {
        active.controller.abort(); throw new Error('browser_authority_changed');
      }
    }
    if (++active.requests > MAX_REQUESTS) throw new Error('browser_request_limit');
    const request = route.request();
    // DOM observation never authorizes remote writes, even for trusted callers.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) throw new Error('browser_remote_write_forbidden');
    let hops = 0; for (let prior = request.redirectedFrom(); prior; prior = prior.redirectedFrom()) hops++;
    if (hops > 5) throw new Error('browser_redirect_limit');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers())) {
      if (['accept', 'accept-language', 'content-type', 'cookie'].includes(key.toLowerCase())) headers[key] = value;
    }
    const response = await deps.fetch({ url: request.url(), method: request.method(), headers,
      signal: active.controller.signal, profile: active.profile, redirectMode: 'manual' });
    release = response.release;
    const bytes = await browserResponseBytes(response.response, active);
    if (session.active !== active || active.controller.signal.aborted) throw new Error('browser_operation_aborted');
    const outputHeaders: Record<string, string> = {};
    response.response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key)) outputHeaders[key] = value;
    });
    await route.fulfill({ status: response.response.status, headers: outputHeaders, body: bytes });
  } catch (error) {
    if (String(error).includes('browser_authority_changed')) active.controller.abort();
    if (active.failures.length < 10) active.failures.push(error instanceof Error ? error.message : String(error));
    await route.abort('blockedbyclient').catch(() => {});
  } finally { await release?.(); }
}

/** Current transport authority is required on every operation; no caller-supplied scope or profile. */
export async function runBrowserSession(
  args: BrowserSessionArgs, url: string | undefined, ctx: UnifiedToolContext,
  opts: { timeoutMs: number; maxText: number }, deps: BrowserDeps = defaultBrowserDeps,
  // Internal owner-RPC route has already resolved the actual transport identity.
  // This is never part of the tool schema or model-authored arguments.
  resolvedScope?: string,
) {
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = () => { const ms = deadline - Date.now(); if (ms <= 0 || ctx.signal?.aborted) throw new Error('browser_operation_aborted'); return ms; };
  const scope = resolvedScope ?? browserScope(ctx);
  const reply = (payload: unknown, image?: Buffer) => ({ content: [
    { type: 'text' as const, text: JSON.stringify(payload) },
    ...(image ? [{ type: 'image' as const, data: image.toString('base64'), mimeType: 'image/png' }] : []),
  ] });
  if (url) {
    try { parseAndValidateUrl(url); }
    catch (error) { return reply({ ok: false, error: error instanceof Error ? error.message : String(error), executed: false }); }
  }
  let session = args.id ? sessions.get(args.id) : undefined;
  if (args.id && (!session || session.scope !== scope)) return reply({ ok: false, error: 'browser_unrecoverable', restartRecovery: 'unrecoverable' });
  if (args.op === 'close' && session) { await closeBrowserSession(session, 'explicit-close'); return reply({ ok: true, browser: status(session) }); }
  if (session?.state !== undefined && session.state !== 'live') return reply({ ok: false, error: 'browser_unrecoverable', browser: status(session) });
  const profile = args.op === 'open'
    ? await browserStartupStage(ctx, 'caller-profile', () => deps.profile(ctx))
    : await deps.profile(ctx);
  const authority = JSON.stringify([profile, ctx.role ?? null]);
  if (session && session.authority !== authority) { await closeBrowserSession(session, 'authority-changed'); return reply({ ok: false, error: 'browser_authority_changed', browser: status(session) }); }
  if (session?.busy) return reply({ ok: false, error: 'browser_busy', browser: status(session) });
  if (args.op === 'open') {
    for (const [key, old] of sessions) if (old.endedAt && Date.now() - old.endedAt > IDLE_MS) sessions.delete(key);
    const live = [...sessions.values()].filter((s) => !s.processEnded);
    const pending = openings.get(scope) ?? 0;
    const totalPending = [...openings.values()].reduce((sum, count) => sum + count, 0);
    if (live.length + totalPending >= MAX_LIVE || live.filter((s) => s.scope === scope).length + pending >= PER_SCOPE) return reply({ ok: false, error: 'browser_scope_limit' });
    openings.set(scope, pending + 1);
    let root: string | undefined; const id = randomUUID();
    let launched: Awaited<ReturnType<BrowserDeps['launch']>> | undefined;
    try {
      // Chromium creates Unix sockets below its child TMPDIR. Nesting it under
      // an isolated runtime's long TMPDIR can exceed sun_path and cause SIGTRAP.
      // Reuse the orchestrator's short scratch root; this session still owns
      // its unique directory and the existing serialized close removes it.
      remaining(); root = await browserStartupStage(ctx, 'session-directory', () => mkdtemp(join(ramTmpRoot(), 'pc-browser-')));
      launched = await deps.launch(ctx, root, id, remaining());
      if (JSON.stringify([launched.profile, ctx.role ?? null]) !== authority) throw new Error('browser_authority_changed');
      const setupServer = launched.server;
      const stopSetup = () => { void setupServer.kill().catch(() => {}); };
      ctx.signal?.addEventListener('abort', stopSetup, { once: true });
      const setupTimer = setTimeout(stopSetup, remaining());
      let context: BrowserContext; let page: Page;
      try {
        context = await browserStartupStage(ctx, 'browser-context', () => launched!.browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block', acceptDownloads: false }));
        const setupContext = context;
        await browserStartupStage(ctx, 'websocket-route', () => setupContext.routeWebSocket('**/*', (socket) => socket.close()));
        page = await browserStartupStage(ctx, 'browser-page', () => setupContext.newPage()); remaining();
        if (JSON.stringify([await browserStartupStage(ctx, 'authority-recheck', () => deps.profile(ctx)), ctx.role ?? null]) !== authority) throw new Error('browser_authority_changed');
      } finally { clearTimeout(setupTimer); ctx.signal?.removeEventListener('abort', stopSetup); }
      session = { ...launched, id, root, scope, authority, context, page, state: 'live', busy: false, processEnded: false };
      const current = session;
      await context.route('**/*', (route) => relay(current, route));
      context.on('page', (extra) => { if (extra !== page) void extra.close(); });
      launched.server.on('close', () => {
        current.processEnded = true;
        if (current.state === 'live') {
          current.state = 'lost'; current.reason = 'browser-process-ended'; current.endedAt = Date.now();
          // Idle exits have no operation finally-block to release the directory.
          // Use the same serialized cleanup, retaining the unexpected-loss state.
          void closeBrowserSession(current, current.reason).catch(() => {});
        }
      });
      sessions.set(id, session);
    } catch (error) {
      if (launched) await launched.server.kill();
      if (root) await rm(root, { recursive: true, force: true });
      return reply({ ok: false, error: error instanceof Error ? error.message : String(error), launchAttempted: true });
    } finally {
      const count = (openings.get(scope) ?? 1) - 1;
      if (count) openings.set(scope, count); else openings.delete(scope);
    }
  }
  if (!session) return reply({ ok: false, error: 'browser_unrecoverable' });
  session.busy = true; if (session.idle) clearTimeout(session.idle);
  const active: ActiveOperation = { controller: new AbortController(), ctx, deps, profile, requests: 0, bytes: 0, failures: [] };
  session.active = active;
  const abort = () => active.controller.abort();
  if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
  const cancelPage = () => { void closeBrowserSession(session!, 'operation-aborted').catch(() => {}); };
  active.controller.signal.addEventListener('abort', cancelPage, { once: true });
  try {
    if (active.controller.signal.aborted) throw new Error('browser_operation_aborted');
    if (url) await session.page.goto(url, { timeout: remaining(), waitUntil: 'domcontentloaded' });
    if (args.selector) await session.page.locator(args.selector).waitFor({ state: 'attached', timeout: remaining() });
    const observation = await session.page.evaluate(({ selector, max }) => {
      const element = selector ? document.querySelector(selector) : document.body;
      const text = (element instanceof HTMLElement ? element.innerText : element?.textContent ?? '').slice(0, max + 1);
      return { url: location.href, title: document.title.slice(0, 1000), text: text.slice(0, max), truncated: text.length > max,
        links: Array.from((element ?? document).querySelectorAll('a[href]')).slice(0, 50).map((link) => ({ text: (link.textContent ?? '').slice(0, 200), href: (link as HTMLAnchorElement).href.slice(0, 2000) })) };
    }, { selector: args.selector, max: Math.min(opts.maxText, 20_000) });
    const image = args.screenshot ? await session.page.screenshot({ type: 'png', fullPage: false, timeout: remaining() }) : undefined;
    if (image && image.length > RESOURCE_BYTES) throw new Error('browser_screenshot_size_limit');
    if (active.controller.signal.aborted) throw new Error('browser_operation_aborted');
    return reply({ ok: true, browser: { ...status(session), busy: false }, observation,
      network: { requests: active.requests, bytes: active.bytes, refused: active.failures },
      provenance: { kind: 'browser', trust: 'external-untrusted' } }, image);
  } catch (error) {
    await closeBrowserSession(session, 'operation-failed');
    return reply({ ok: false, error: error instanceof Error ? error.message : String(error), browser: status(session), networkFailures: active.failures });
  } finally {
    clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort);
    active.controller.signal.removeEventListener('abort', cancelPage);
    session.active = undefined; active.controller.abort(); session.busy = false; armIdle(session);
  }
}
