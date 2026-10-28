/**
 * WI-6554700010030353: the operator side of the resident co-change index.
 *
 * One forked child per repository root holds the full 90-day window
 * (warm-cochange-index.worker.ts explains why it cannot live on the operator heap). This module
 * owns the child's lifetime and turns a question into one IPC round-trip:
 *
 * - The child is spawned on the first question for a root and stays resident. It is a plain
 *   (non-detached) child with an unref'd IPC channel, so it never keeps a host alive and exits
 *   when the host does.
 * - A question carries the caller's current HEAD. The child answers only for the exact commit it
 *   built at; otherwise the caller gets an explicit miss (`not-ready`, `behind`), which the
 *   reuse brief records as unknown with that reason, never as a silent empty.
 * - A child that exits is not respawned for RESPAWN_BACKOFF_MS, so a crashing warm-up cannot
 *   turn every brief into a fork.
 */
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pinModuleState } from '@papercusp/module-singleton';
import { terminateSpawnTree } from '@papercusp/backup/hook';
import { createTextCollector } from '../child-output';
import type { CoChangeReport } from './cochange-index';
import type { WarmCoChangeReply, WarmCoChangeRequest, WarmCoChangeStatus } from './warm-cochange-index.worker';

const run = promisify(execFile);

export const WARM_COCHANGE_WORKER_BUNDLED = 'warm-cochange-index.worker.mjs';
export const WARM_COCHANGE_WORKER_SOURCE = 'warm-cochange-index.worker.dev.mjs';
/** Probe peak was ~290 MiB of heap for the Papercusp window; leave room for growth and a rebuild. */
export const WARM_COCHANGE_HEAP_MB = 1024;
/** Used only when the caller passes no signal; brief callers bring their own (750 ms). */
export const WARM_COCHANGE_DEFAULT_DEADLINE_MS = 5_000;
const RESPAWN_BACKOFF_MS = 60_000;
const MAX_ROOTS = 4;

export interface WarmCoChangeOptions {
  /** Override the worker entry (tests). Default: the bundled `.mjs` beside this module, else the dev shim. */
  readonly workerPath?: string;
  /** Snapshot directory; null disables snapshots. Default ~/.papercusp/cache/cochange-index. */
  readonly snapshotDir?: string | null;
  readonly heapMb?: number;
}

interface Handle {
  readonly child: ChildProcess;
  readonly pending: Map<number, (reply: WarmCoChangeReply | null) => void>;
  nextId: number;
  exited: boolean;
  lastStatus: WarmCoChangeStatus | null;
}

const state = pinModuleState('@papercusp/operator-core.warm-cochange-index', () => ({
  handles: new Map<string, Handle>(),
  failed: new Map<string, { at: number; why: string }>(),
  options: {} as WarmCoChangeOptions,
}));

export function configureWarmCoChange(options: WarmCoChangeOptions): void { state.options = options; }

export function defaultWarmCoChangeWorker(): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const bundled = join(dirname(here), WARM_COCHANGE_WORKER_BUNDLED);
  return existsSync(bundled) ? bundled : join(dirname(here), WARM_COCHANGE_WORKER_SOURCE);
}

function snapshotPathFor(root: string): string | null {
  const dir = state.options.snapshotDir === undefined
    ? join(homedir(), '.papercusp', 'cache', 'cochange-index') : state.options.snapshotDir;
  return dir === null ? null : join(dir, `${createHash('sha256').update(root).digest('hex').slice(0, 16)}.json`);
}

const isReply = (value: unknown): value is WarmCoChangeReply =>
  typeof value === 'object' && value !== null && (value as WarmCoChangeReply).kind === 'warm-cochange-reply'
  && Number.isInteger((value as WarmCoChangeReply).id);

function ensure(root: string): Handle | string {
  const live = state.handles.get(root);
  if (live && !live.exited) return live;
  const failed = state.failed.get(root);
  if (failed && Date.now() - failed.at < RESPAWN_BACKOFF_MS) return `co-change index worker exited (${failed.why}); not respawned yet`;
  if (state.handles.size >= MAX_ROOTS) return `co-change index is already resident for ${MAX_ROOTS} repository roots`;
  const workerPath = state.options.workerPath ?? defaultWarmCoChangeWorker();
  let child: ChildProcess;
  try {
    child = fork(workerPath, [], {
      execArgv: [`--max-old-space-size=${state.options.heapMb ?? WARM_COCHANGE_HEAP_MB}`],
      serialization: 'advanced', silent: true,
    });
  } catch (error) {
    const why = `could not start ${workerPath}: ${error instanceof Error ? error.message : String(error)}`;
    state.failed.set(root, { at: Date.now(), why });
    return why;
  }
  const stderr = createTextCollector(child.stderr, { maxChars: 2_000 });
  child.stdout?.resume();
  const handle: Handle = { child, pending: new Map(), nextId: 1, exited: false, lastStatus: null };
  const gone = (why: string) => {
    if (handle.exited) return;
    handle.exited = true;
    if (state.handles.get(root) === handle) state.handles.delete(root);
    const tail = stderr.peek().trim().split(/\r?\n/).filter(Boolean).pop();
    state.failed.set(root, { at: Date.now(), why: tail ? `${why}: ${tail.slice(0, 300)}` : why });
    for (const done of handle.pending.values()) done(null);
    handle.pending.clear();
  };
  child.on('message', (message: unknown) => {
    if (!isReply(message)) return;
    handle.lastStatus = message.status;
    const done = handle.pending.get(message.id);
    handle.pending.delete(message.id);
    done?.(message);
  });
  child.once('exit', (code, signal) => gone(`exit ${signal ?? code}`));
  child.once('error', (error) => gone(error.message));
  child.unref();
  child.channel?.unref();
  const init: WarmCoChangeRequest = { kind: 'warm-cochange-init', root, snapshotPath: snapshotPathFor(root) };
  child.send(init, (error) => { if (error) gone(`init not delivered: ${error.message}`); });
  state.handles.set(root, handle);
  return handle;
}

/** Ask the resident index for `paths` at the current HEAD of `root`. Never rejects. */
export async function queryWarmCoChange(root: string, paths: readonly string[], signal?: AbortSignal):
  Promise<{ report: CoChangeReport } | { error: string }> {
  const deadline = signal ? null : AbortSignal.timeout(WARM_COCHANGE_DEFAULT_DEADLINE_MS);
  const abort = signal ?? deadline!;
  try {
    const real = await realpath(root);
    const commit = (await run('git', ['-C', real, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5_000, signal: abort })).stdout.trim();
    const handle = ensure(real);
    if (typeof handle === 'string') return { error: handle };
    const id = handle.nextId++;
    const reply = await new Promise<WarmCoChangeReply | null>((resolve) => {
      const finish = (value: WarmCoChangeReply | null) => { abort.removeEventListener('abort', onAbort); resolve(value); };
      const onAbort = () => { handle.pending.delete(id); finish(null); };
      if (abort.aborted) return finish(null);
      abort.addEventListener('abort', onAbort, { once: true });
      handle.pending.set(id, finish);
      const query: WarmCoChangeRequest = { kind: 'warm-cochange-query', id, paths: [...paths], commit };
      handle.child.send(query, (error) => { if (error) { handle.pending.delete(id); finish(null); } });
    });
    if (!reply) {
      return { error: abort.aborted ? 'co-change index did not answer before the deadline'
        : `co-change index worker unavailable (${state.failed.get(real)?.why ?? 'no reply'})` };
    }
    return reply.outcome === 'answered' ? { report: reply.report } : { error: reply.error };
  } catch (error) {
    return { error: abort.aborted ? 'co-change index read aborted at the deadline'
      : `co-change index unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The last status the resident index for `root` reported, or null before its first answer. */
export async function warmCoChangeStatus(root: string): Promise<WarmCoChangeStatus | null> {
  return state.handles.get(await realpath(root))?.lastStatus ?? null;
}

/** Stop every resident index (tests, host shutdown). The next question respawns immediately. */
export function stopWarmCoChange(): void {
  for (const handle of state.handles.values()) {
    handle.exited = true;
    for (const done of handle.pending.values()) done(null);
    handle.pending.clear();
    terminateSpawnTree(handle.child, false);
  }
  state.handles.clear();
  state.failed.clear();
}
