/** A continuous full-root retention census, using the existing managed walk
 * transport. Caller deadlines abandon the wait, never the native measurement.
 * Partial output is not selection evidence. Each completed result is consumed
 * before effects and can never be reused as an after-reclaim measurement. */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { moduleRepoRoot } from '../module-repo-root';
import { z } from 'zod';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { inspectRetentionTrees, type RetentionTreeCensus } from './disk-consumer-census';
import { DetachedWalkAbandoned, readWalkState, runDetachedWalk, waitForWalk, walkAttemptFiles,
  walkProcessAlive, type DetachedWalkOptions } from './disk-census-detached-walk';

export const RETENTION_CENSUS_LIFETIME_MS = 15 * 60_000;
export const RETENTION_CENSUS_PENDING_ERROR = 'retention census pending; managed walk continues for adoption';
/** A wake hint in the existing reclaim receipt, never selection evidence. */
export interface PendingRetentionCensus {
  root: string; dir: string; attempt: number; requestKey: string; launchedAt: number;
}
export type DetachedRetentionCensus = RetentionTreeCensus & { pendingWalk?: PendingRetentionCensus };

/** A recovered workflow waits for the same native attempt without holding the
 * retention mutex. The next reclaim pass still consumes and validates output
 * under fresh admission, policy, pin, lease and holder evidence. */
export async function awaitRetentionCensusCompletion(pending: PendingRetentionCensus, notAfterMs: number,
  deps: Pick<DetachedWalkOptions, 'isAlive' | 'sleep'> = {}): Promise<boolean> {
  if (!Number.isFinite(notAfterMs) || Date.now() >= notAfterMs) return false;
  const matches = (state: Awaited<ReturnType<typeof readWalkState>>) => !!state && state.root === pending.root &&
    state.attempt === pending.attempt && state.requestKey === pending.requestKey && state.launchedAt === pending.launchedAt;
  const available = async () => matches(await readWalkState(pending.dir)) &&
    !await fs.access(join(pending.dir, 'consumed')).then(() => true, () => false);
  const state = await readWalkState(pending.dir);
  if (!state || !matches(state) || !await available()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, notAfterMs - Date.now()));
  try {
    const status = await waitForWalk(state, walkAttemptFiles(pending.dir, pending.attempt).exit, {
      now: Date.now, sleep: deps.sleep ?? (ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))),
      isAlive: deps.isAlive ?? walkProcessAlive, pollMs: 250, graceMs: 0, signal: controller.signal,
    });
    return status === 'exited' && Date.now() < notAfterMs && await available();
  } catch (error) {
    if (error instanceof DetachedWalkAbandoned) return false;
    throw error;
  } finally { clearTimeout(timer); }
}
const retentionMutexBrand = Symbol('retention-mutex');
export type RetentionMutexContext = {
  readonly [retentionMutexBrand]: true;
  hasWaiters: () => Promise<boolean>;
};
const activeRetentionMutexes = new WeakMap<RetentionMutexContext, Set<string>>();

/** Reuse the admission already held by the reclaimer. A context is valid only
 * during this callback; standalone census callers acquire the SAME mutex. */
export async function withRetentionMutex<T>(action: (held: RetentionMutexContext) => Promise<T>,
  options: Parameters<typeof withFsMutex>[2] = {}): Promise<T> {
  return withFsMutex('papercusp-disk-retention', async held => {
    if (!held) throw new Error('retention census requires an enabled retention mutex');
    const context: RetentionMutexContext = { ...held, [retentionMutexBrand]: true };
    activeRetentionMutexes.set(context, new Set());
    try { return await action(context); }
    finally { activeRetentionMutexes.delete(context); }
  }, options);
}
const identity = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() });
const entry = identity.extend({ path: z.string(), newestWriteMs: z.number().finite(), bytes: z.number().int().nonnegative(),
  hardlinks: z.array(identity.extend({ bytes: z.number().int().nonnegative(), paths: z.array(z.string()) })).optional(),
  buildDirs: z.array(identity.extend({ path: z.string() })).optional() });
const census = z.object({ entries: z.array(entry), retained: z.array(z.object({ path: z.string(), reason: z.string(), entry: entry.optional() })),
  inspectedNodes: z.number().int().nonnegative(), retainedRecentTrees: z.number().int().nonnegative(),
  error: z.string().optional(), timing: z.object({ elapsedMs: z.number(), lastProgressAfterMs: z.number().nullable(),
    lastChildPath: z.string().nullable(), timeoutMs: z.number().nullable(), progressTimeoutMs: z.number().nullable(),
    timeoutKind: z.enum(['absolute', 'progress', 'native-signal']).nullable() }).optional() });
export const retentionCensusRequest = z.object({ version: z.literal(1), root: z.string(), rootIdentity: identity,
  excludedPaths: z.array(z.string()), collectBuildDirs: z.boolean(), progressTimeoutMs: z.number().positive(),
  requirePrivilege: z.boolean() });
type Request = z.infer<typeof retentionCensusRequest>;
const envelope = z.object({ version: z.literal(1), requestKey: z.string(), startedAt: z.number(), finishedAt: z.number(), result: census });
const keyFor = (request: Request) => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
const incomplete = (error: string): RetentionTreeCensus => ({ entries: [], retained: [], inspectedNodes: 0, retainedRecentTrees: 0, error });

/** The maintained worker runs this function once; no cross-run child cache is
 * used (direct-child timestamps cannot detect writes to nested files). */
export async function runRetentionCensusWorker(input: unknown) {
  const request = retentionCensusRequest.parse(input);
  if (resolve(request.root) !== request.root) throw new Error('noncanonical retention census root');
  const before = await fs.lstat(request.root);
  // Only the root's identity is pinned, never its mtime/ctime: an actively written
  // root (repo scratch gains a direct child every few seconds) could otherwise never
  // yield an adoptable census (EI-26925507003255681). Removal safety does not rest on
  // this listing: disk-reclaim reinspects identity, newest write, bytes, hardlinks and
  // holders of every entry immediately before its effect.
  if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, request.rootIdentity)) throw new Error('retention census root changed');
  const startedAt = Date.now();
  const result = await inspectRetentionTrees(request.root, { retainAfterMs: Infinity, includeRecent: true,
    excludedPaths: request.excludedPaths, collectBuildDirs: request.collectBuildDirs,
    progressTimeoutMs: request.progressTimeoutMs, timeoutMs: RETENTION_CENSUS_LIFETIME_MS,
    requirePrivilege: request.requirePrivilege });
  const after = await fs.lstat(request.root);
  if (!sameIdentity(after, before)) {
    return { version: 1, requestKey: keyFor(request), startedAt, finishedAt: Date.now(), result: incomplete('retention census root changed during walk') };
  }
  return { version: 1, requestKey: keyFor(request), startedAt, finishedAt: Date.now(), result };
}

export type RetentionCensusWalkOptions = Omit<DetachedWalkOptions, 'command' | 'signal' | 'timeoutMs'> & {
  /** Production supplies the configured checkout root; bundling changes the
   * module location but must never change which maintained worker is run. */
  workerPath?: string;
  /** Caller wait, separate from the fixed native lifetime. */
  waitMs: number;
  /** Scoped proof of the outer retention admission, never a boolean bypass. */
  retentionMutex?: RetentionMutexContext;
};

export async function inspectDetachedRetentionTrees(root: string,
  options: Parameters<typeof inspectRetentionTrees>[1], walk: RetentionCensusWalkOptions): Promise<DetachedRetentionCensus> {
  // Only the initial complete capped-root census uses this route. Fresh effect
  // inspections, expiry compaction and exact-pin predicates remain inline.
  if (!options.includeRecent || options.paths || options.coversPinnedPath || options.spawn) throw new Error('unsupported detached retention census input');
  root = resolve(root);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return incomplete('retention root is not a plain directory');
  const request: Request = { version: 1, root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    excludedPaths: [...new Set(options.excludedPaths ?? [])].sort(), collectBuildDirs: options.collectBuildDirs ?? false,
    progressTimeoutMs: options.progressTimeoutMs ?? 60_000, requirePrivilege: options.requirePrivilege ?? false };
  const requestKey = keyFor(request);
  const remaining = () => deadline - Date.now();
  const deadline = Date.now() + Math.max(1, Math.min(walk.waitMs, options.timeoutMs ?? walk.waitMs));
  const inspect = async (held: RetentionMutexContext) => {
    const state = await readWalkState(walk.dir);
    // The wrapper may die before it writes exit.<attempt>. A consumed or
    // obsolete measurement can be retired once its process identity is dead;
    // requiring the missing exit file would wedge this slot permanently.
    const terminal = !!state && !(walk.isAlive ?? walkProcessAlive)(state);
    const consumed = join(walk.dir, 'consumed');
    const used = await fs.access(consumed).then(() => true, () => false);
    if (state && (used || state.requestKey !== requestKey)) {
      if (!terminal) return incomplete('retention census previous measurement still active');
      if (!used) {
        // Report the obsolete terminal attempt before starting another walk.
        // Otherwise a busy root stays "pending" on every pass and pins the
        // retention cursor ahead of roots that can make progress. Its output
        // remains ineligible for selection, and the next visit may replace it.
        await fs.writeFile(consumed, 'consumed\n');
        return incomplete('retention census input changed since previous measurement');
      }
      await fs.rm(walk.dir, { recursive: true, force: true });
    } else if (!state && await fs.readdir(walk.dir).then(names => names.length > 0, () => false)) {
      return incomplete('retention census slot has unreadable state');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, remaining()));
    // EI-26942454413534533: waiting for the detached walk held the retention
    // mutex for the caller's whole remaining run budget without consulting the
    // FIFO queue, so a concurrent pass (or a pin/lease writer) queued behind it
    // spent its entire budget in reacquisition. The walk is detached and is
    // adopted by a later visit, so a queued writer abandons only this WAIT —
    // with the same pending outcome a caller deadline produces.
    let watching = true;
    const pollMs = Math.max(1, Math.min(walk.pollMs ?? 250, 250));
    const watchWaiters = (async () => {
      while (watching && !controller.signal.aborted) {
        await new Promise(resolveSleep => setTimeout(resolveSleep, pollMs));
        if (!watching || controller.signal.aborted) return;
        if (await held.hasWaiters().catch(() => false)) { controller.abort(); return; }
      }
    })();
    try {
      const worker = walk.workerPath ?? join(moduleRepoRoot(import.meta.url), 'scripts/retention-census-worker.mjs');
      return await runDetachedWalk(root, { ...walk, timeoutMs: RETENTION_CENSUS_LIFETIME_MS, maxAttempts: 1,
        attribution: { launchedBy: 'system:disk-retention-reclaim', workItemId: 'EI-26925507003255681', title: `retention metadata ${root}` },
        pollMs: Math.min(walk.pollMs ?? 250, 250), signal: controller.signal,
        command: () => [process.execPath, ['--import', 'tsx', worker, JSON.stringify(request)]] }, [], async (finished, code, overdue, failure) => {
        // Consume before parsing/returning. A crash, error or removal can never
        // make this terminal before-reclaim result eligible on a later pass.
        await fs.writeFile(consumed, 'consumed\n');
        if (code !== 0 || overdue || failure) {
          const files = walkAttemptFiles(walk.dir, finished.attempt);
          const err = await fs.open(files.err, 'r').catch(() => null);
          let diagnostic = '';
          if (err) try {
            const size = (await err.stat()).size;
            const buffer = Buffer.alloc(Math.min(size, 4096));
            const { bytesRead } = await err.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
            diagnostic = buffer.subarray(0, bytesRead).toString('utf8').trim();
          } finally { await err.close(); }
          return incomplete(`${failure ?? `retention census worker exited ${code}`}${diagnostic ? `: ${diagnostic}` : ''}`);
        }
        const parsed = envelope.safeParse(JSON.parse(await fs.readFile(walkAttemptFiles(walk.dir, finished.attempt).out, 'utf8')));
        if (!parsed.success) return incomplete('invalid retention census worker result');
        const value = parsed.data;
        const current = await fs.lstat(root);
        if (value.requestKey !== requestKey || value.startedAt < finished.launchedAt || value.finishedAt < value.startedAt ||
            value.finishedAt > Date.now() || Date.now() - value.finishedAt > RETENTION_CENSUS_LIFETIME_MS ||
            !sameIdentity(current, rootStat)) {
          return incomplete('stale or changed retention census result');
        }
        const paths = [...value.result.entries.map(e => e.path), ...value.result.retained.map(e => e.path)];
        if (paths.some(path => dirname(path) !== root || resolve(path) !== path) || new Set(paths).size !== paths.length) {
          return incomplete('retention census result has invalid direct children');
        }
        return value.result.error ? { ...value.result, entries: [], retained: [] } : value.result;
      }, requestKey);
    } catch (error) {
      if (error instanceof DetachedWalkAbandoned) {
        const pending = await readWalkState(walk.dir);
        return { ...incomplete(RETENTION_CENSUS_PENDING_ERROR),
          ...(pending?.root === root && pending.requestKey === requestKey ? { pendingWalk: {
            root, dir: walk.dir, attempt: pending.attempt, requestKey, launchedAt: pending.launchedAt,
          } } : {}) };
      }
      return incomplete(`retention census: ${String(error)}`);
    } finally { watching = false; clearTimeout(timer); await watchWaiters; }
  };
  const underLease = async (held: RetentionMutexContext) => {
    const slots = activeRetentionMutexes.get(held);
    if (!slots) throw new Error('retention mutex context is not active');
    const slot = resolve(walk.dir);
    if (slots.has(slot)) throw new Error('retention census slot already in use');
    if (remaining() <= 0) return incomplete('retention census caller budget exhausted before slot access');
    slots.add(slot);
    try { return await inspect(held); }
    finally { slots.delete(slot); }
  };
  return walk.retentionMutex ? underLease(walk.retentionMutex) : withRetentionMutex(underLease,
    { timeoutMs: Math.max(1, Math.min(1000, remaining())), retryMs: 25 });
}
