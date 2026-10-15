/** Kernel placement over cluster-owner-rpc. Caller context never crosses IPC. */
import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import {
  openOrchestrationKernel, inspectOrchestrationKernel, closeOrchestrationKernel,
  runOrchestrationScript, type ToolFacade, type RunScriptOptions, type RunScriptResult,
} from '@papercusp/tooldef';
import { bindOwnerRpcResource, locateOwnerRpcResource, callOwnerProcess, registerOwnerRpcHandler } from '../../cluster-owner-rpc';
import { withBoundedTimeout } from '../../bounded-timeout';

const KIND = 'code-kernel';
const CALLBACK = 'code-kernel-callback';
interface Caller { ownerPid: number; facade: ToolFacade; opts: RunScriptOptions }
const callers = new Map<string, Caller>();
const running = new Map<string, { fromPid: number; controller: AbortController }>();
// node:cluster normally uses JSON IPC. Preserve the structured-clone values
// already supported by the VM boundary, including typed arrays and binary reads.
const pack = (value: unknown) => ({ serialized: serialize(value).toString('base64') });
function unpack(value: unknown): unknown {
  const encoded = (value as { serialized?: unknown })?.serialized;
  if (typeof encoded !== 'string' || !encoded) throw new Error('kernel_owner_protocol_error');
  return deserialize(Buffer.from(encoded, 'base64'));
}
const lost = (id: string, reason: string) => ({ id, state: 'unrecoverable' as const, busy: false,
  language: 'javascript' as const, statePersistence: 'globalThis' as const, restartRecovery: 'unrecoverable' as const, reason });
function unrecoverableCause(error: unknown): string {
  const message = String(error);
  const prefix = 'kernel_unrecoverable:';
  const marker = message.indexOf(prefix);
  return marker < 0 ? message : message.slice(marker + prefix.length);
}

async function owner(id: string, scope: string): Promise<number> {
  const out = await locateOwnerRpcResource(KIND, id, scope);
  if (!out.ok) throw new Error(out.code === 'owner_gone'
    ? `kernel_unrecoverable:${out.message}`
    : `kernel_owner_unreachable:${out.code}:${out.message}`);
  const pid = (out.result as { ownerPid?: number })?.ownerPid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) throw new Error('kernel_owner_protocol_error');
  return pid;
}

export async function openManagedKernel(scope: string) {
  const kernel = await openOrchestrationKernel(scope);
  try { await bindOwnerRpcResource(KIND, kernel.id, scope); }
  catch (error) { closeOrchestrationKernel(kernel.id, scope); throw error; }
  return kernel;
}

export async function controlManagedKernel(op: 'status' | 'close', id: string, scope: string) {
  try {
    const pid = await owner(id, scope);
    if (pid === process.pid) return op === 'status' ? inspectOrchestrationKernel(id, scope) : closeOrchestrationKernel(id, scope);
    const out = await callOwnerProcess({ targetPid: pid, kind: KIND, payload: { op, id, scope } });
    if (!out.ok) {
      if (out.code === 'owner_gone') return lost(id, out.message);
      throw new Error(`kernel_owner_unreachable:${out.code}`);
    }
    return out.result as ReturnType<typeof inspectOrchestrationKernel>;
  } catch (error) {
    if (String(error).includes('kernel_unrecoverable')) return lost(id, unrecoverableCause(error));
    throw error;
  }
}

// The real facade (and its current principal/transaction/envelope/trace) lives
// only on the worker receiving this cell. The VM owner asks it to dispatch.
registerOwnerRpcHandler(CALLBACK, async (payload, source) => {
  const envelope = payload as { token: string; payload: unknown };
  const caller = callers.get(envelope?.token);
  if (!caller || caller.ownerPid !== source.fromPid) throw new Error('kernel_cell_ended');
  const p = unpack(envelope.payload) as { op: string; name?: string; ns?: string; verb?: string; args?: unknown; data?: unknown };
  if (p.op === 'timeout') { await caller.opts.onTimeout?.(); return pack(null); }
  if (caller.opts.signal?.aborted) throw new Error('kernel_cell_ended');
  if (p.op === 'emit') { caller.opts.emit?.(p.name!, p.data); return pack(null); }
  if (p.op !== 'call') throw new Error('kernel_callback_protocol_error');
  if (typeof p.name === 'string') return pack(await caller.facade.call(p.name, p.args));
  const fn = caller.facade[p.ns!]?.[p.verb!];
  if (typeof fn !== 'function') throw new Error('kernel_tool_unavailable');
  return pack(await fn(p.args));
});

registerOwnerRpcHandler(KIND, async (payload, source) => {
  const p = payload as { op: string; id: string; scope: string; token?: string; script?: string;
    options?: Pick<RunScriptOptions, 'timeoutMs' | 'timeoutGraceMs' | 'inputs' | 'maxLogLines' | 'sleepMaxMs'> };
  if (!p || typeof p.id !== 'string' || typeof p.scope !== 'string') throw new Error('kernel_owner_protocol_error');
  if (p.op === 'status') return inspectOrchestrationKernel(p.id, p.scope);
  if (p.op === 'close') return closeOrchestrationKernel(p.id, p.scope);
  if (p.op === 'abort') {
    const cell = running.get(p.token!);
    if (cell?.fromPid === source.fromPid) cell.controller.abort();
    return null;
  }
  if (p.op !== 'run' || typeof p.token !== 'string' || typeof p.script !== 'string') throw new Error('kernel_owner_protocol_error');
  const token = p.token;
  const controller = new AbortController();
  running.set(token, { fromPid: source.fromPid, controller });
  const callback = async (args: Record<string, unknown>) => {
    const out = await callOwnerProcess({ targetPid: source.fromPid, kind: CALLBACK, payload: { token, payload: pack(args) }, timeoutMs: (p.options?.timeoutMs ?? 30_000) + 2_000 });
    if (!out.ok) throw new Error(`kernel_callback_failed:${out.code}:${out.message}`);
    return unpack(out.result);
  };
  const facade = new Proxy({ call: (name: string, args?: unknown) => callback({ op: 'call', name, args }) } as ToolFacade, {
    get(target, ns: string) {
      if (ns === 'call') return target.call;
      return new Proxy({}, { get: (_target, verb: string) => (args: unknown) => callback({ op: 'call', ns, verb, args }) });
    },
  });
  try {
    return pack(await runOrchestrationScript(p.script, facade, {
      kernel: { id: p.id, scope: p.scope }, timeoutMs: p.options?.timeoutMs,
      timeoutGraceMs: p.options?.timeoutGraceMs, inputs: p.options?.inputs,
      maxLogLines: p.options?.maxLogLines, sleepMaxMs: p.options?.sleepMaxMs,
      signal: controller.signal,
      onTimeout: async () => { await callback({ op: 'timeout' }); },
      emit: (name, data) => { void callback({ op: 'emit', name, data }).catch(() => {}); },
    }));
  } finally { running.delete(token); }
});

export const runManagedKernelScript: typeof runOrchestrationScript = async (script, facade, opts = {}) => {
  if (!opts.kernel) return runOrchestrationScript(script, facade, opts);
  const { id, scope } = opts.kernel;
  let pid: number;
  try { pid = await owner(id, scope); }
  catch (error) { return { ok: false, error: String(error), logs: [],
    ...(String(error).includes('kernel_unrecoverable') ? { kernel: lost(id, unrecoverableCause(error)) } : {}) }; }
  if (pid === process.pid) return runOrchestrationScript(script, facade, opts);
  if (opts.signal?.aborted) return { ok: false, error: 'script_aborted', logs: [] };
  const token = randomUUID();
  callers.set(token, { ownerPid: pid, facade, opts });
  const abort = () => { void callOwnerProcess({ targetPid: pid, kind: KIND, payload: { op: 'abort', id, scope, token } }); };
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    const out = await callOwnerProcess({ targetPid: pid, kind: KIND,
      payload: { op: 'run', id, scope, token, script, options: { timeoutMs: opts.timeoutMs, timeoutGraceMs: opts.timeoutGraceMs, inputs: opts.inputs,
        maxLogLines: opts.maxLogLines, sleepMaxMs: opts.sleepMaxMs } },
      timeoutMs: (opts.timeoutMs ?? 30_000) + (opts.timeoutGraceMs ?? 1_000) + 3_000 });
    if (out.ok) return unpack(out.result) as RunScriptResult;
    abort();
    await withBoundedTimeout(() => Promise.resolve(opts.onTimeout?.()), { fallback: undefined, timeoutMs: opts.timeoutGraceMs ?? 1_000 });
    return { ok: false, error: `kernel_owner_${out.code}`, logs: [],
      ...(out.code === 'owner_gone' ? { kernel: lost(id, out.message) } : {}) };
  } finally { callers.delete(token); opts.signal?.removeEventListener('abort', abort); }
};
