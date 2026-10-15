/** Browser placement uses the existing relay; current policy and principal stay on the receiving worker. */
import { randomUUID } from 'node:crypto';
import { pinModuleState } from '@papercusp/module-singleton';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { bindOwnerRpcResource, locateOwnerRpcResource, callOwnerProcess, registerOwnerRpcHandler } from '../../cluster-owner-rpc';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveConcreteHarnessSlug } from '../_harness-scope';
import { browserScope, browserResponseBytes, defaultBrowserDeps, runBrowserSession, type BrowserDeps, type BrowserSessionArgs } from './browser-session';
import type { PolicyFetchInput } from './fetch-policy';

const KIND = 'capability-browser';
const CALLBACK = 'capability-browser-callback';
type Options = Parameters<typeof runBrowserSession>[3];
type Result = Awaited<ReturnType<typeof runBrowserSession>>;
interface Caller { ownerPid: number; ctx: UnifiedToolContext; deps: BrowserDeps; controller: AbortController }
const { callers, running } = pinModuleState('@papercusp/operator-core.browser-owner', () => ({
  callers: new Map<string, Caller>(), running: new Map<string, { fromPid: number; controller: AbortController }>(),
}));
const failure = (error: string): Result => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error,
  ...(error === 'browser_unrecoverable' ? { restartRecovery: 'unrecoverable' } : {}) }) }] });

registerOwnerRpcHandler(CALLBACK, async (payload, source) => {
  const p = payload as { token: string; op: string; input?: Omit<PolicyFetchInput, 'signal'> };
  const caller = callers.get(p?.token);
  if (!caller || caller.ownerPid !== source.fromPid) throw new Error('browser_operation_ended');
  if (p.op === 'abort') { caller.controller.abort(); return null; }
  if (caller.ctx.signal?.aborted || caller.controller.signal.aborted) throw new Error('browser_operation_aborted');
  if (p.op === 'profile') return caller.deps.profile(caller.ctx);
  if (p.op !== 'fetch' || !p.input) throw new Error('browser_callback_protocol_error');
  // Resolve the boundary again at the actual caller-local network boundary.
  const profile = await caller.deps.profile(caller.ctx);
  if (JSON.stringify(profile) !== JSON.stringify(p.input.profile)) {
    caller.controller.abort(); throw new Error('browser_authority_changed');
  }
  const fetched = await caller.deps.fetch({ ...p.input, profile,
    signal: caller.ctx.signal ? AbortSignal.any([caller.ctx.signal, caller.controller.signal]) : caller.controller.signal });
  try {
    const bytes = await browserResponseBytes(fetched.response, { controller: caller.controller, profile, bytes: 0, requests: 0, failures: [] });
    return { status: fetched.response.status, statusText: fetched.response.statusText,
      headers: [...fetched.response.headers], body: bytes.toString('base64') };
  } finally { await fetched.release(); }
});

registerOwnerRpcHandler(KIND, async (payload, source) => {
  const p = payload as { op: string; token: string; scope: string; args: BrowserSessionArgs; url?: string;
    opts: Options; caller: { workspaceId: string; ownerId: string; harnessSlug?: string; role?: UnifiedToolContext['role'] } };
  if (p?.op === 'abort') {
    const operation = running.get(p.token);
    if (operation?.fromPid === source.fromPid) operation.controller.abort();
    return null;
  }
  if (p?.op !== 'run' || !p.args?.id || typeof p.token !== 'string' || !p.caller) throw new Error('browser_owner_protocol_error');
  const controller = new AbortController();
  // Only scope/role metadata crosses IPC. No transport context, principal or credential does.
  const ctx = { workspaceId: p.caller.workspaceId, uiClientId: p.caller.ownerId,
    harnessSlug: p.caller.harnessSlug, role: p.caller.role, signal: controller.signal, log: () => {} } as unknown as UnifiedToolContext;
  if (JSON.stringify([p.caller.workspaceId, p.caller.ownerId, p.caller.harnessSlug ?? null]) !== p.scope) throw new Error('browser_owner_scope_mismatch');
  running.set(p.token, { fromPid: source.fromPid, controller });
  const callback = async (op: string, input?: unknown) => {
    const out = await callOwnerProcess({ targetPid: source.fromPid, kind: CALLBACK,
      payload: { token: p.token, op, input }, timeoutMs: p.opts.timeoutMs + 1000 });
    if (!out.ok) throw new Error(`browser_callback_failed:${out.code}:${out.message}`);
    return out.result;
  };
  const abort = () => { void callback('abort').catch(() => {}); };
  controller.signal.addEventListener('abort', abort, { once: true });
  const deps: BrowserDeps = {
    launch: async () => { throw new Error('browser_followup_cannot_launch'); },
    profile: async () => await callback('profile') as Awaited<ReturnType<BrowserDeps['profile']>>,
    fetch: async ({ signal: _signal, ...input }) => {
      const out = await callback('fetch', input) as { status: number; statusText: string; headers: [string, string][]; body: string };
      const response = new Response([101, 204, 205, 304].includes(out.status) ? null : Buffer.from(out.body, 'base64'),
        { status: out.status, statusText: out.statusText, headers: out.headers });
      return { response, release: async () => {}, finalUrl: input.url, finalMethod: input.method,
        redirectCount: 0, resolvedAddress: { address: '', family: 4 } };
    },
  };
  try { return await runBrowserSession(p.args, p.url, ctx, p.opts, deps, p.scope); }
  finally { running.delete(p.token); controller.abort(); controller.signal.removeEventListener('abort', abort); }
});

export async function runManagedBrowserSession(args: BrowserSessionArgs, url: string | undefined, ctx: UnifiedToolContext,
  opts: Options, deps: BrowserDeps = defaultBrowserDeps): Promise<Result> {
  const scope = browserScope(ctx);
  if (args.op === 'open') {
    const result = await runBrowserSession(args, url, ctx, opts, deps);
    const body = JSON.parse(result.content[0].text!);
    if (body.ok && body.browser?.id) {
      try { await bindOwnerRpcResource(KIND, body.browser.id, scope); }
      catch (error) { await runBrowserSession({ op: 'close', id: body.browser.id }, undefined, ctx, opts, deps); throw error; }
    }
    return result;
  }
  const placement = await locateOwnerRpcResource(KIND, args.id!, scope);
  if (!placement.ok) return failure(placement.code === 'owner_gone' ? 'browser_unrecoverable' : `browser_owner_unreachable:${placement.code}`);
  const pid = (placement.result as { ownerPid?: number })?.ownerPid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return failure('browser_owner_protocol_error');
  if (pid === process.pid) return runBrowserSession(args, url, ctx, opts, deps);
  if (ctx.signal?.aborted) return failure('browser_operation_aborted');
  const token = randomUUID(); const controller = new AbortController();
  callers.set(token, { ownerPid: pid, ctx, deps, controller });
  const abort = () => { controller.abort(); void callOwnerProcess({ targetPid: pid, kind: KIND, payload: { op: 'abort', token } }); };
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    const out = await callOwnerProcess({ targetPid: pid, kind: KIND, timeoutMs: opts.timeoutMs + 3000,
      payload: { op: 'run', token, scope, args, url, opts,
        caller: { workspaceId: ctx.workspaceId, ownerId: resolveAgentIdentity(ctx).ownerId,
          harnessSlug: resolveConcreteHarnessSlug(undefined, ctx) ?? undefined, role: ctx.role } } });
    if (out.ok) return out.result as Result;
    abort();
    return failure(out.code === 'owner_gone' ? 'browser_unrecoverable' : `browser_owner_unreachable:${out.code}`);
  } finally { controller.abort(); callers.delete(token); ctx.signal?.removeEventListener('abort', abort); }
}
