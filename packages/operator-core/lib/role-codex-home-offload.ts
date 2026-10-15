/** Bounded worker-thread dispatch for Codex-home filesystem materialization. */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export type CodexHomeMaterializerOperation = 'role-write' | 'su-write' | 'su-ensure-config';

export interface CodexHomeMaterializerJob {
  operation: CodexHomeMaterializerOperation;
  options: object;
  priorSid?: string | null;
  /** The caller's resolved user home. The worker materializes against this
   *  rather than its own os.homedir(), so caller and worker cannot disagree
   *  (WI-6554700010009552). */
  homeDir?: string;
}

export interface CodexHomeWorkerLike {
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

type WorkerFactory = (job: CodexHomeMaterializerJob) => CodexHomeWorkerLike;

interface PendingJob {
  job: CodexHomeMaterializerJob;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerReply {
  ok: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; stack?: string };
}

export const CODEX_HOME_WORKER_MAX_ACTIVE = 2;
export const CODEX_HOME_WORKER_MAX_QUEUED = 32;

export class CodexHomeWorkerQueueFullError extends Error {
  readonly code = 'CODEX_HOME_WORKER_QUEUE_FULL';

  constructor(readonly maxQueued: number) {
    super(`Codex-home materializer queue is full (${maxQueued} queued jobs)`);
    this.name = 'CodexHomeWorkerQueueFullError';
  }
}

/**
 * A materialization can block in the kernel while the filesystem journal is
 * stalled. Bound both worker concurrency and queued requests so that such a
 * stall cannot create an unbounded thread or memory backlog on the host.
 */
export class BoundedCodexHomeWorkerQueue {
  private readonly pending: PendingJob[] = [];
  private active = 0;

  constructor(
    private readonly createWorker: WorkerFactory,
    readonly maxActive = CODEX_HOME_WORKER_MAX_ACTIVE,
    readonly maxQueued = CODEX_HOME_WORKER_MAX_QUEUED,
  ) {
    if (!Number.isInteger(maxActive) || maxActive < 1) throw new Error('maxActive must be a positive integer');
    if (!Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('maxQueued must be a non-negative integer');
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.pending.length; }

  enqueue<T>(job: CodexHomeMaterializerJob): Promise<T> {
    if (this.pending.length >= this.maxQueued && this.active >= this.maxActive) {
      return Promise.reject(new CodexHomeWorkerQueueFullError(this.maxQueued));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        job,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxActive && this.pending.length > 0) {
      const pending = this.pending.shift()!;
      this.active += 1;
      let worker: CodexHomeWorkerLike;
      try {
        worker = this.createWorker(pending.job);
      } catch (error) {
        this.active -= 1;
        pending.reject(asError(error));
        continue;
      }

      let receivedMessage = false;
      let reply: unknown;
      let workerError: Error | null = null;
      worker.on('message', (message) => {
        if (receivedMessage) return;
        receivedMessage = true;
        reply = message;
      });
      worker.on('error', (error) => { workerError = error; });
      worker.on('exit', (code) => {
        this.active -= 1;
        if (workerError) pending.reject(workerError);
        else if (code !== 0) pending.reject(new Error(`Codex-home worker exited with code ${code}`));
        else if (!receivedMessage) pending.reject(new Error('Codex-home worker exited without a result'));
        else this.resolveReply(pending, reply);
        this.pump();
      });
    }
  }

  private resolveReply(pending: PendingJob, value: unknown): void {
    if (!value || typeof value !== 'object' || typeof (value as WorkerReply).ok !== 'boolean') {
      pending.reject(new Error('Codex-home worker returned an invalid response'));
      return;
    }
    const reply = value as WorkerReply;
    if (reply.ok) {
      pending.resolve(reply.value);
      return;
    }
    const remote = reply.error;
    const error = new Error(typeof remote?.message === 'string' ? remote.message : 'Codex-home worker failed');
    if (typeof remote?.name === 'string') error.name = remote.name;
    if (typeof remote?.stack === 'string') error.stack = remote.stack;
    pending.reject(error);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function workerEntryPath(): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const bundled = resolve(dir, 'role-codex-home.worker.mjs');
  return existsSync(bundled) ? bundled : resolve(dir, 'role-codex-home.worker.dev.mjs');
}

function workerExecArgv(): string[] {
  const parentOnlyValueFlags = ['--input-type', '--report-directory', '--report-filename'];
  return process.execArgv.filter((arg, index, args) =>
    !parentOnlyValueFlags.some((flag) =>
      arg === flag || arg.startsWith(`${flag}=`) || (index > 0 && args[index - 1] === flag),
    ) && arg !== '--report-on-fatalerror' && arg !== '--no-report-on-fatalerror',
  );
}

const codexHomeWorkerQueue = new BoundedCodexHomeWorkerQueue(
  (job) => new Worker(workerEntryPath(), { workerData: job, execArgv: workerExecArgv() }),
);

export function runCodexHomeMaterializerJob<T>(job: CodexHomeMaterializerJob): Promise<T> {
  return codexHomeWorkerQueue.enqueue<T>(job);
}
