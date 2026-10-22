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

export const FORKSERVER_LOST_CODE = 'SIDECAR_FORKSERVER_LOST';

export interface SidecarSpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
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

  /** The forkserver is gone: kill this child's group and settle it as an infrastructure fault. */
  lose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pid !== undefined) {
      try { process.kill(-this.pid, 'SIGKILL'); } catch { try { process.kill(this.pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    const error = toError({ message: `spawner sidecar forkserver lost mid-exec (${reason}); not re-run`, code: FORKSERVER_LOST_CODE });
    setImmediate(() => this.emit('error', error));
  }

  private async deliverClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.closed) return;
    this.closed = true;
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
  children: Map<number, ForkedChild>;
  pending: Map<number, { child: ForkedChild; resolve: (c: SidecarChild) => void; reject: (e: Error) => void }>;
  alive: boolean;
}

const state = pinModuleState('@papercusp/operator-core.fleet.forkserver-client', () => ({
  server: null as Forkserver | null,
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

function startForkserver(): Forkserver {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // the forkserver loads no loaders; children get their own env per request
  const proc = spawn(process.execPath, ['-e', FORKSERVER_SOURCE], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    serialization: 'advanced',
    env,
  });
  state.starts += 1;
  const server: Forkserver = { proc, children: new Map(), pending: new Map(), alive: true };
  const lose = (reason: string): void => {
    if (!server.alive) return;
    server.alive = false;
    if (state.server === server) state.server = null;
    if (inFlight(server) > 0) { state.losses += 1; state.lastLossReason = reason; }
    for (const entry of server.pending.values()) {
      entry.reject(toError({ message: `spawner sidecar forkserver lost before spawn (${reason})`, code: FORKSERVER_LOST_CODE }));
    }
    server.pending.clear();
    for (const child of server.children.values()) child.lose(reason);
    server.children.clear();
  };
  proc.on('message', (raw: unknown) => {
    const m = raw as { t?: string; id?: number; pid?: number | null; error?: ErrorInfo };
    if (!m || typeof m.id !== 'number') return;
    if (m.t === 'spawned') {
      const entry = server.pending.get(m.id);
      if (!entry) return;
      server.pending.delete(m.id);
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

function directSpawn(req: SidecarSpawnRequest): SidecarChild {
  state.fallbacks += 1;
  return spawn(req.command, req.args, {
    cwd: req.cwd,
    env: req.env,
    stdio: [req.stdin ? req.stdin.fd : 'ignore', req.stdout ? req.stdout.fd : 'pipe', 'pipe'],
    detached: req.detached,
  }) as unknown as SidecarChild;
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
  if (!forkserverApplies() || Date.now() < state.disabledUntil) return directSpawn(req);
  let server = state.server;
  if (!server || !server.alive) {
    server = startForkserver();
    state.server = server;
  }
  const id = state.nextId++;
  const child = new ForkedChild(!req.stdout);
  state.spawns += 1;
  const acked = new Promise<SidecarChild>((resolve, reject) => {
    server!.pending.set(id, { child, resolve, reject });
  });
  refreshRef(server);
  server.proc.send({
    t: 'spawn', id, command: req.command, args: req.args, cwd: req.cwd, env: req.env, detached: req.detached,
    stdinPath: req.stdin?.path ?? null, stdoutPath: req.stdout?.path ?? null,
  });
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
