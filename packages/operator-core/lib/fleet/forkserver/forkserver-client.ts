/**
 * Sidecar-side client for the forkserver (see forkserver-source.ts for why).
 *
 * `spawnSidecarChild` returns an object with the slice of the ChildProcess surface
 * that execProcess and processGroupLifetime read: pid, exitCode, signalCode,
 * stdout/stderr Readables, kill(), and the spawn/error/exit/close events in Node's
 * order. The pid is known before the promise resolves, so processGroupLifetime
 * captures the real process-group id. Lifecycle events are delivered on
 * setImmediate, after the caller has attached its listeners; stream data is
 * buffered in the Readables until a consumer reads it.
 *
 * Failure model (R-3): when the forkserver dies, every in-flight child's process
 * group is SIGKILLed and the child emits 'error' with code SIDECAR_FORKSERVER_LOST
 * (an infrastructure fault; it is never re-run). The next spawn starts a fresh
 * forkserver. If the forkserver cannot start at all, spawns fall back to a direct
 * spawn and the fallback is counted in forkserverStats() for the health payload.
 */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { pinModuleState } from '@papercusp/module-singleton';
import { FORKSERVER_SOURCE } from './forkserver-source';
import { managedSpawn, markManagedSpawnTeardown } from '../../task-manager/managed-spawn';
import { newTaskId, scopeUnitForTask } from '../../task-manager/types';
import { captureSidecarContainment, reapDeadSidecar, type SidecarContainment } from '../sidecar-exec-lifetime';

export const FORKSERVER_LOST_CODE = 'SIDECAR_FORKSERVER_LOST';
const START_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 10_000;

export interface SidecarSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  /** Local controls: these are never serialized over IPC. */
  signal?: AbortSignal;
  spawnTimeoutMs?: number;
  /** Exact preflight generation, or null to stay in the sidecar's own scope. */
  forkserverIdentity?: string | null;
  /** Handoff files: the forkserver opens them by path; a direct spawn uses the fd. */
  stdin?: { path: string; fd: number };
  stdout?: { path: string; fd: number };
}

export interface SidecarChild extends EventEmitter {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface ErrorInfo {
  name?: string; message: string; code?: string; errno?: number; syscall?: string; path?: string; spawnargs?: string[];
}

function toError(info: ErrorInfo): NodeJS.ErrnoException {
  const error = new Error(info.message) as NodeJS.ErrnoException & { spawnargs?: string[] };
  for (const key of ['code', 'errno', 'syscall', 'path', 'spawnargs'] as const) {
    if (info[key] !== undefined && info[key] !== null) (error as unknown as Record<string, unknown>)[key] = info[key];
  }
  return error;
}

function toBuffer(d: unknown): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (d instanceof Uint8Array) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  return Buffer.from(String(d));
}

class ForkedChild extends EventEmitter implements SidecarChild {
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout: Readable | null;
  readonly stderr: Readable;
  private closed = false;

  constructor(hasStdoutPipe: boolean) {
    super();
    this.stdout = hasStdoutPipe ? new Readable({ read() {} }) : null;
    this.stderr = new Readable({ read() {} });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.pid === undefined || this.exitCode !== null || this.signalCode !== null) return false;
    try { process.kill(this.pid, signal); return true; } catch { return false; }
  }

  /** Called for each forkserver message addressed to this child. */
  receive(m: { t: string; error?: ErrorInfo; d?: unknown; code?: number | null; signal?: NodeJS.Signals | null }): void {
    switch (m.t) {
      case 'spawn': setImmediate(() => this.emit('spawn')); break;
      case 'error': { const e = toError(m.error ?? { message: 'forkserver child error' }); setImmediate(() => this.emit('error', e)); break; }
      case 'out': this.stdout?.push(toBuffer(m.d)); break;
      case 'err': this.stderr.push(toBuffer(m.d)); break;
      case 'out-end': this.stdout?.push(null); break;
      case 'err-end': this.stderr.push(null); break;
      case 'exit':
        this.exitCode = m.code ?? null;
        this.signalCode = m.signal ?? null;
        setImmediate(() => this.emit('exit', this.exitCode, this.signalCode));
        break;
      case 'close': void this.deliverClose(m.code ?? null, m.signal ?? null); break;
      default: break;
    }
  }

  /** Called only after the owning scope is verified empty. Never signal a stale PID. */
  lose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const error = toError({ message: `spawner sidecar forkserver lost mid-exec (${reason}); not re-run`, code: FORKSERVER_LOST_CODE });
    this.stdout?.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit('error', error));
  }

  private async deliverClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // An IPC batch can acknowledge spawn and close before the promise's caller
    // has attached stream listeners. Let that caller run before flushing unread
    // stdio, or resume() discards a fast child's already-buffered output.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Node emits 'close' only after the stdio streams end; keep that order.
    const ends = [this.stdout, this.stderr].filter((s): s is Readable => s !== null).map((s) => {
      if (s.readableEnded) return Promise.resolve();
      if (!s.readableFlowing && s.listenerCount('data') === 0) s.resume();
      s.push(null);
      return new Promise<void>((resolve) => s.once('end', () => resolve()));
    });
    await Promise.all(ends);
    setImmediate(() => this.emit('close', code, signal));
  }
}

interface Forkserver {
  proc: ChildProcess;
  scopeUnit: string;
  containment: SidecarContainment | null;
  retirement: Promise<void> | null;
  lose: (reason: string) => Promise<void>;
  children: Map<number, ForkedChild>;
  pending: Map<number, { child: ForkedChild; resolve: (c: SidecarChild) => void; reject: (e: Error) => void; cleanup: () => void }>;
  alive: boolean;
}

const state = pinModuleState('@papercusp/operator-core.fleet.forkserver-client', () => ({
  server: null as Forkserver | null,
  starting: null as Promise<Forkserver> | null,
  retiring: Promise.resolve(),
  nextId: 1,
  starts: 0,
  spawns: 0,
  losses: 0,
  fallbacks: 0,
  startFailures: 0,
  lastLossReason: null as string | null,
  /** Set when the forkserver could not be started; spawns go direct until it can. */
  disabledUntil: 0,
}));

function inFlight(server: Forkserver): number {
  return server.children.size + server.pending.size;
}

function refreshRef(server: Forkserver): void {
  // Keep the IPC channel from holding a test process open when nothing is running.
  const channel = server.proc.channel as unknown as { ref?: () => void; unref?: () => void } | undefined;
  if (inFlight(server) > 0) { server.proc.ref(); channel?.ref?.(); }
  else { server.proc.unref(); channel?.unref?.(); }
}

async function retire(server: Forkserver, reason: string): Promise<void> {
  if (server.retirement) return server.retirement;
  server.retirement = (async () => {
    server.alive = false;
    if (state.server === server) state.server = null;
    if (inFlight(server) > 0) { state.losses += 1; state.lastLossReason = reason; }
    // PID acknowledgement is not a birth boundary: a command can already have
    // forked descendants. Kill the pre-declared scope, including unknown PIDs,
    // and prove it empty BEFORE releasing any execution's caller/lease.
    markManagedSpawnTeardown(server.proc);
    try { server.proc.kill('SIGKILL'); } catch { /* already gone */ }
    const { killScopeUnit } = await import('../../task-manager/control');
    await killScopeUnit(server.scopeUnit, { signal: 'SIGKILL' }).catch(() => undefined);
    if (server.containment) {
      while (!(await reapDeadSidecar(server.containment))) {
        // Fail closed on unavailable kernel proof. A signal receipt alone must
        // never release a repository lease or permit a replacement generation.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const entry of server.pending.values()) {
      entry.cleanup();
      entry.reject(toError({ message: `forkserver execution outcome unknown (${reason}); not re-run`, code: FORKSERVER_LOST_CODE }));
    }
    server.pending.clear();
    for (const child of server.children.values()) child.lose(reason);
    server.children.clear();
    refreshRef(server);
  })();
  state.retiring = server.retirement;
  return server.retirement;
}

function attachForkserver(proc: ChildProcess, scopeUnit: string, ready: () => void, failed: (e: Error) => void): Forkserver {
  state.starts += 1;
  const server: Forkserver = { proc, scopeUnit, containment: null, retirement: null,
    children: new Map(), pending: new Map(), alive: true, lose: (reason) => retire(server, reason) };
  const lose = (reason: string): void => {
    failed(new Error(reason));
    void server.lose(reason);
  };
  proc.on('message', (raw: unknown) => {
    const m = raw as { t?: string; id?: number; pid?: number | null; error?: ErrorInfo };
    if (!server.alive) return;
    if (m?.t === 'ready') {
      server.containment = m.pid === proc.pid ? captureSidecarContainment(scopeUnit, proc.pid) : null;
      if (server.containment) ready();
      else lose('forkserver confinement could not be verified');
      return;
    }
    if (!m || typeof m.id !== 'number') return;
    if (m.t === 'spawned') {
      const entry = server.pending.get(m.id);
      if (!entry) return;
      server.pending.delete(m.id);
      entry.cleanup();
      entry.child.pid = typeof m.pid === 'number' ? m.pid : undefined;
      if (m.error) {
        // spawn() threw before a ChildProcess existed. Keep that distinct from
        // the child's later error event so execProcess preserves its thrown-
        // spawn result and admission-cancellation contract.
        refreshRef(server);
        entry.reject(toError(m.error));
        return;
      }
      server.children.set(m.id, entry.child);
      refreshRef(server);
      entry.resolve(entry.child);
      return;
    }
    const child = server.children.get(m.id);
    if (!child) return;
    child.receive(m as Parameters<ForkedChild['receive']>[0]);
    if (m.t === 'close') { server.children.delete(m.id); refreshRef(server); }
  });
  proc.on('error', (e) => {
    state.startFailures += 1;
    state.disabledUntil = Date.now() + 60_000;
    lose(`forkserver process error: ${String(e)}`);
  });
  proc.on('exit', (code, signal) => lose(`forkserver exited code=${code} signal=${signal}`));
  proc.on('disconnect', () => lose('forkserver IPC disconnected'));
  refreshRef(server);
  return server;
}

async function startForkserver(): Promise<Forkserver> {
  await state.retiring;
  const taskId = newTaskId();
  const scopeUnit = scopeUnitForTask(taskId);
  let server: Forkserver | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const ready = new Promise<Forkserver>((resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      if (server) void server.lose('forkserver startup deadline');
      reject(new Error('forkserver startup deadline'));
    }, START_TIMEOUT_MS);
    // No env option: managedSpawn's exact-env runner would consume Node's IPC
    // descriptor. env(1) execs in place and strips only the inherited loader.
    void managedSpawn('/usr/bin/env', ['-u', 'NODE_OPTIONS', process.execPath, '-e', FORKSERVER_SOURCE], {
      class: 'sidecar', title: 'spawner forkserver', argv: [], launchedBy: 'system:spawner-forkserver',
    }, { taskId, spawnOptions: { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' },
      onSpawn: (proc) => {
        server = attachForkserver(proc, scopeUnit, () => resolve(server!), reject);
        if (expired) void server.lose('late forkserver startup');
      },
    }).then((managed) => {
      if (!managed.confined) {
        expired = true;
        if (server) void server.lose('forkserver confinement unavailable');
        reject(new Error('forkserver confinement unavailable'));
      }
    }, reject);
  });
  try {
    const result = await ready;
    if (!result.alive) throw new Error('forkserver died during startup');
    // Publish even if the caller abandoned startup; otherwise a late ready
    // process is leaked and the next caller creates a second generation.
    state.server = result;
    return result;
  } catch (error) {
    expired = true;
    if (server) await server.lose('forkserver startup failed');
    state.startFailures += 1;
    state.disabledUntil = Date.now() + 60_000;
    throw error;
  } finally {
    clearTimeout(timer!);
  }
}

function directSpawn(req: SidecarSpawnRequest): SidecarChild {
  state.fallbacks += 1;
  return spawn(req.command, req.args, {
    cwd: req.cwd,
    env: req.env,
    stdio: [req.stdin ? req.stdin.fd : 'ignore', req.stdout ? req.stdout.fd : 'pipe', 'pipe'],
    detached: req.detached,
  }) as unknown as SidecarChild;
}

function ensureForkserver(): Promise<Forkserver> {
  if (state.server?.alive) return Promise.resolve(state.server);
  if (state.starting) return state.starting;
  const starting = state.starting = startForkserver();
  const clear = () => { if (state.starting === starting) state.starting = null; };
  void starting.then(clear, clear);
  return starting;
}

export function forkserverContainmentIdentity(snapshot: SidecarContainment): string {
  return `${snapshot.scopeUnit}:${snapshot.identity}`;
}

/** Preflight captures the scope BEFORE a fenced command can be dispatched. A
 * failed startup pins direct execution in the original sidecar scope instead. */
export async function prepareForkserverContainment(): Promise<SidecarContainment | null> {
  if (!forkserverApplies() || Date.now() < state.disabledUntil) return null;
  try {
    const server = await ensureForkserver();
    return server.alive ? server.containment : null;
  } catch { return null; }
}

/** A caller can abandon startup safely: it has sent no user command yet. The
 * shared startup keeps its own deadline and reaps even a late managed spawn. */
function awaitStartup(starting: Promise<Forkserver>, req: SidecarSpawnRequest, deadline: number): Promise<Forkserver> {
  let cleanup = () => {};
  return new Promise<Forkserver>((resolve, reject) => {
    const fail = (code: string) => reject(toError({ message: `spawn ${code} before dispatch`, code }));
    const onAbort = () => fail('ABORT_ERR');
    const timer = setTimeout(() => fail('ETIMEDOUT'), Math.max(1, deadline - Date.now()));
    cleanup = () => { clearTimeout(timer); req.signal?.removeEventListener('abort', onAbort); };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    if (req.signal?.aborted) onAbort();
    starting.then(resolve, reject);
  }).finally(() => cleanup());
}

/** Whether execs on this host go through the forkserver (Linux, where fork is the cost). */
export function forkserverApplies(): boolean {
  return process.platform === 'linux';
}

/**
 * Spawn one child through the forkserver. Resolves once the forkserver has run
 * spawn(), with pid set. Rejects with code SIDECAR_FORKSERVER_LOST if the forkserver
 * dies before acknowledging.
 */
export async function spawnSidecarChild(req: SidecarSpawnRequest): Promise<SidecarChild> {
  const deadline = Date.now() + (req.spawnTimeoutMs && req.spawnTimeoutMs > 0 ? req.spawnTimeoutMs : START_TIMEOUT_MS + ACK_TIMEOUT_MS);
  if (req.signal?.aborted) throw toError({ message: 'spawn aborted before dispatch', code: 'ABORT_ERR' });
  if (req.forkserverIdentity === null) return directSpawn(req);
  if (req.forkserverIdentity !== undefined) {
    const pinned = state.server;
    if (!pinned?.alive || !pinned.containment ||
        forkserverContainmentIdentity(pinned.containment) !== req.forkserverIdentity) {
      throw toError({ message: 'forkserver generation changed before dispatch', code: 'SIDECAR_FORKSERVER_FENCE' });
    }
  }
  if (!forkserverApplies() || Date.now() < state.disabledUntil) return directSpawn(req);
  let server = state.server;
  if (!server || !server.alive) {
    const starting = ensureForkserver();
    try { server = await awaitStartup(starting, req, deadline); }
    catch (error) {
      if (['ABORT_ERR', 'ETIMEDOUT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
      if (req.signal?.aborted) throw toError({ message: 'spawn aborted before dispatch', code: 'ABORT_ERR' });
      if (Date.now() >= deadline) throw toError({ message: 'spawn deadline before fallback dispatch', code: 'ETIMEDOUT' });
      return directSpawn(req); // no user command was dispatched
    }
    state.server = server;
  }
  if (req.signal?.aborted) throw toError({ message: 'spawn aborted before dispatch', code: 'ABORT_ERR' });
  if (Date.now() >= deadline) throw toError({ message: 'spawn deadline before dispatch', code: 'ETIMEDOUT' });
  if (!server.alive) throw toError({ message: 'forkserver lost before dispatch; not re-run', code: FORKSERVER_LOST_CODE });
  const id = state.nextId++;
  const child = new ForkedChild(!req.stdout);
  state.spawns += 1;
  const acked = new Promise<SidecarChild>((resolve, reject) => {
    const onAbort = () => { void server!.lose('spawn acknowledgement aborted'); };
    const timer = setTimeout(() => { void server!.lose('spawn acknowledgement deadline'); },
      Math.min(ACK_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
    const cleanup = () => { clearTimeout(timer); req.signal?.removeEventListener('abort', onAbort); };
    server!.pending.set(id, { child, resolve, reject, cleanup });
    req.signal?.addEventListener('abort', onAbort, { once: true });
  });
  refreshRef(server);
  try { server.proc.send({
    t: 'spawn', id, command: req.command, args: req.args, cwd: req.cwd, env: req.env, detached: req.detached,
    stdinPath: req.stdin?.path ?? null, stdoutPath: req.stdout?.path ?? null,
  }, (error) => { if (error) void server!.lose(`spawn IPC send failed: ${error.message}`); }); }
  catch (error) { void server.lose(`spawn IPC send threw: ${String(error)}`); }
  return acked;
}

export interface ForkserverStats {
  applies: boolean;
  pid: number | null;
  inFlight: number;
  starts: number;
  spawns: number;
  losses: number;
  fallbacks: number;
  startFailures: number;
  lastLossReason: string | null;
}

export function forkserverStats(): ForkserverStats {
  const server = state.server;
  return {
    applies: forkserverApplies(),
    pid: server?.alive ? server.proc.pid ?? null : null,
    inFlight: server ? inFlight(server) : 0,
    starts: state.starts,
    spawns: state.spawns,
    losses: state.losses,
    fallbacks: state.fallbacks,
    startFailures: state.startFailures,
    lastLossReason: state.lastLossReason,
  };
}

/** Test seam: the live forkserver process (null when none is running). */
export function currentForkserverProcess(): ChildProcess | null {
  return state.server?.alive ? state.server.proc : null;
}
