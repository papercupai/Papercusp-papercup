/**
 * WI-10006543: run a first-party callers question OFF the operator's event loop.
 *
 * `firstPartyCallers` is synchronous (ripgrep via spawnSync, then a TypeScript
 * program built from disk) and measured 1-8 s and 0.7-1.5 GB per question on
 * this repo. On the main thread that would freeze every MCP session on the host
 * and keep the heap. So each question forks one child process
 * (`first-party-callers.worker`), which answers and exits:
 *
 * - **Hard deadline.** The child runs in its own process group; on the deadline
 *   the whole group is killed (as mutation-probe-fence does for its compiler
 *   worker) and the answer is an error, never a bare empty.
 * - **Bounded heap.** `--max-old-space-size` caps the child, so a pathological
 *   question fails in the child instead of growing the host.
 * - **No state.** Each question builds its own program from disk, so there is
 *   nothing to cache, idle-reap, or invalidate between questions.
 *
 * Entry resolution mirrors mutation-probe-fence: a bundled host (`node
 * dist-host/hono-host.mjs`) has `first-party-callers.worker.mjs` staged beside
 * it by bundle-host-common.sh; an unbundled run forks the `.ts` source, which
 * Node's native type stripping loads.
 */
import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateSpawnTree } from '@papercusp/backup/hook';
import { createTextCollector } from '../child-output';
import { failedCallersAnswer, type FirstPartyCallersAnswer } from './first-party-callers';
import type { FirstPartyCallersJob, FirstPartyCallersProgress } from './first-party-callers.worker';

export const FIRST_PARTY_CALLERS_WORKER_BUNDLED = 'first-party-callers.worker.mjs';
export const FIRST_PARTY_CALLERS_WORKER_SOURCE = 'first-party-callers.worker.ts';

/** Below graph:query's 90 s dispatch budget, so the tool answers before the dispatcher gives up. */
export const FIRST_PARTY_CALLERS_BUDGET_MS = 60_000;
/** Peak measured 1.43 GB RSS (createOrgTestDb, 251 candidate files); twice that leaves headroom. */
export const FIRST_PARTY_CALLERS_HEAP_MB = 3072;

export interface FirstPartyCallersRunOptions {
  /** Override the worker entry (tests). Default: the bundled `.mjs` beside this module, else the `.ts` source. */
  readonly workerPath?: string;
  readonly budgetMs?: number;
  readonly heapMb?: number;
  /** Source-only jobs whose module graph needs the workspace TypeScript loader. */
  readonly sourceLoader?: boolean;
}

export function defaultFirstPartyCallersWorker(preferSource = false): string {
  const here = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const source = join(dirname(here), FIRST_PARTY_CALLERS_WORKER_SOURCE);
  if (preferSource && existsSync(source)) return source;
  const bundled = join(dirname(here), FIRST_PARTY_CALLERS_WORKER_BUNDLED);
  return existsSync(bundled) ? bundled : source;
}

const isAnswer = (value: unknown): value is FirstPartyCallersAnswer =>
  typeof value === 'object' &&
  value !== null &&
  (value as FirstPartyCallersAnswer).backend === 'typescript-service' &&
  Array.isArray((value as FirstPartyCallersAnswer).sites);

const isProgress = (value: unknown): value is FirstPartyCallersProgress => {
  if (typeof value !== 'object' || value === null) return false;
  const progress = value as FirstPartyCallersProgress;
  return progress.kind === 'first-party-callers-progress'
    && ['job-received', 'typescript-load', 'compiler-query', 'source-tree', 'source-capture',
      'source-diff', 'source-clones', 'source-calls'].includes(progress.phase)
    && Number.isFinite(progress.elapsedMs) && progress.elapsedMs >= 0;
};

/** Who calls `job.name`, answered in a forked worker process. Never rejects. */
export async function firstPartyCallersOffthread(
  job: FirstPartyCallersJob,
  options: FirstPartyCallersRunOptions = {},
): Promise<FirstPartyCallersAnswer> {
  const started = Date.now();
  const fail = (why: string): FirstPartyCallersAnswer => failedCallersAnswer(job.name, why, started, Date.now(), job);
  return codeIntelWorkerRequest(job, { accept: isAnswer, fail }, options);
}

/** Shared finite code-intelligence worker lifecycle. Callers and reuse census
 * use the same heap, deadline, stderr capture and whole-process-group cleanup.
 */
export async function codeIntelWorkerRequest<T>(job: Serializable,
  contract: { accept(value: unknown): value is T; fail(reason: string): T },
  options: FirstPartyCallersRunOptions = {}): Promise<T> {
  const fail = contract.fail;
  const budgetMs = options.budgetMs ?? FIRST_PARTY_CALLERS_BUDGET_MS;
  const workerPath = options.workerPath ?? defaultFirstPartyCallersWorker(options.sourceLoader);
  const detached = process.platform !== 'win32';
  let child: ChildProcess;
  try {
    child = fork(workerPath, [], {
      execArgv: [`--max-old-space-size=${options.heapMb ?? FIRST_PARTY_CALLERS_HEAP_MB}`,
        ...(options.sourceLoader && workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [])],
      serialization: 'advanced',
      silent: true,
      detached,
    });
  } catch (error) {
    return fail(`could not start the callers worker (${workerPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const stderr = createTextCollector(child.stderr, { maxChars: 2_000 });
  child.stdout?.resume();
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    // A failed spawn emits 'error' without 'exit'.
    child.once('error', () => {
      if (!child.pid) resolve();
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastProgress: FirstPartyCallersProgress | null = null;
  try {
    return await new Promise<T>((resolve) => {
      timer = setTimeout(
        () => resolve(fail(`the callers worker exceeded its ${budgetMs} ms deadline and was killed; `
          + (lastProgress ? `last measured phase=${lastProgress.phase}, workerElapsedMs=${lastProgress.elapsedMs}`
            : 'no worker progress received (startup or delivery is unmeasured)'))),
        budgetMs,
      );
      child.on('message', (message: unknown) => {
        if (isProgress(message)) { lastProgress = message; return; }
        resolve(contract.accept(message) ? message : fail('the callers worker returned something that is not an answer'
          + ` (entry=${workerPath}, keys=${message && typeof message === 'object' ? Object.keys(message).join(',') : typeof message}`
          + `, kind=${message && typeof message === 'object' && 'kind' in message ? String(message.kind) : 'absent'})`));
      });
      child.once('error', (error) => resolve(fail(`callers worker error: ${error.message}`)));
      child.once('exit', (code, signal) => {
        const stderrText = stderr.peek();
        const cause = stderrText.split(/\r?\n/).find((line) => /(?:Error|FATAL)\b.*:/.test(line))?.trim();
        resolve(
          fail(
            `the callers worker exited (${signal ?? code}) before answering` +
              (cause ? `: ${cause.slice(0, 300)}` : stderrText.trim() ? `: ${stderrText.trim().slice(-300)}` : ''),
          ),
        );
      });
      child.send(job, (error) => {
        if (error) resolve(fail(`could not send the question to the callers worker: ${error.message}`));
      });
    });
  } finally {
    clearTimeout(timer);
    terminateSpawnTree(child, detached);
    await exited;
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
