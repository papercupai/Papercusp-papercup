/**
 * WI-6554700010030353: the resident co-change index for ONE repository root.
 *
 * The 90-day first-parent window of this repository is ~37k commits (git-sync commits every few
 * minutes), so the in-process read behind every reuse brief is capped at 1000 commits and can never
 * report a complete window. Measured 2026-10-28 on the Papercusp tree: the full read takes ~64 s and
 * ~110 MiB, building the index ~1.5 s and another ~100 MiB, a query against the built index ~25 ms,
 * and a 20-commit delta read ~0.2 s. So the index lives here, in a child process with its own heap,
 * and the operator only sends it queries (warm-cochange-index.ts).
 *
 * Lifecycle:
 * - **Warm-up.** Load the last snapshot (commits + the HEAD they were read at) and extend it with
 *   the first-parent delta to the current HEAD; without a usable snapshot, read the full window
 *   with FULL_WINDOW_HISTORY_BOUNDS. Then build the index and write a fresh snapshot.
 * - **Refresh.** Event-driven, no timer: fs.watch on the branch ref (and HEAD/packed-refs), settled
 *   for a second, then delta + rebuild. A query whose commit differs from the index also requests a
 *   refresh, so a missed watch event costs one answer, never the index.
 * - **Answers.** Only for the exact commit the index was built at: a query at any other commit is
 *   answered `behind`, never with another commit's pairs. Before the first build it is `not-ready`.
 * - **Exit.** When the parent's IPC channel closes (the operator stopped or restarted).
 *
 * The snapshot is a file, not Postgres: it is derived, rebuildable from git at any time, ~36 MiB,
 * and rewritten every few minutes; its only job is to make a restarted host warm in seconds.
 */
import { execFile } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  buildCoChangeIndex, coChangeFromIndex, FULL_WINDOW_HISTORY_BOUNDS, parseHistoryLog, readHistoryCommits,
  type CoChangeIndex, type CoChangeReport, type HistoryCommit,
} from './cochange-index';

const run = promisify(execFile);
const DAY = 86_400_000;
export const WARM_COCHANGE_SNAPSHOT_VERSION = 1;
/** A longer delta (a long-idle host, a rewritten branch) is read as a full window instead. */
const MAX_DELTA_COMMITS = 5_000;
/** git-sync lands a commit, a merge and a push as one burst; settle before refreshing. */
const REFRESH_SETTLE_MS = 1_000;
/** Rewriting the ~36 MiB snapshot on every commit buys nothing; a few minutes of delta is cheap. */
const SNAPSHOT_EVERY_MS = 10 * 60_000;

export type WarmCoChangeRequest =
  | { kind: 'warm-cochange-init'; root: string; snapshotPath: string | null }
  | { kind: 'warm-cochange-query'; id: number; paths: string[]; commit: string };

export interface WarmCoChangeStatus {
  /** `failed` only while no index exists; a failed refresh keeps serving the previous index. */
  readonly state: 'warming' | 'ready' | 'failed';
  readonly indexCommit: string | null;
  readonly builtAt: string | null;
  readonly source: 'full' | 'snapshot+delta' | 'refresh' | null;
  readonly eligibleCommits: number | null;
  readonly refreshing: boolean;
  readonly error: string | null;
}

export type WarmCoChangeReply =
  | { kind: 'warm-cochange-reply'; id: number; outcome: 'answered'; report: CoChangeReport; status: WarmCoChangeStatus }
  | { kind: 'warm-cochange-reply'; id: number; outcome: 'not-ready' | 'behind' | 'error'; error: string; status: WarmCoChangeStatus };

interface Snapshot { version: number; root: string; head: string; complete: boolean; commits: HistoryCommit[] }

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const validCommit = (c: HistoryCommit) => /^[a-f0-9]{40,64}$/.test(c.sha) && Number.isFinite(Date.parse(c.at));

let root = '';
let snapshotPath: string | null = null;
let commits: HistoryCommit[] = [];
let index: CoChangeIndex | null = null;
let head: string | null = null;
let complete = false;
let lastSnapshotAt = 0;
let refreshing: Promise<void> | null = null;
let dirty = false;
let settle: ReturnType<typeof setTimeout> | undefined;
const watchers: FSWatcher[] = [];
let status: WarmCoChangeStatus = {
  state: 'warming', indexCommit: null, builtAt: null, source: null, eligibleCommits: null, refreshing: false, error: null,
};

const git = async (args: string[]) => (await run('git', ['-C', root, ...args], {
  encoding: 'utf8', timeout: FULL_WINDOW_HISTORY_BOUNDS.timeoutMs, maxBuffer: 64 * 1024 * 1024,
})).stdout;

/** Commits on `to`'s first-parent line above `from`, or null when `from` is not on that line
 *  (then `from`'s window plus a delta is not `to`'s window). */
async function delta(from: string, to: string): Promise<HistoryCommit[] | null> {
  const line = (await git(['rev-list', '--first-parent', `-n${MAX_DELTA_COMMITS + 1}`, to])).split('\n');
  const at = line.indexOf(from);
  if (at < 0) return null;
  if (at === 0) return [];
  const parsed = parseHistoryLog(await git(['log', `${from}..${to}`, '--first-parent', '--no-merges', '-z',
    '--name-status', '-M50%', '--format=%x1e%H%x09%P%x09%cI']));
  return parsed.malformed || !parsed.commits.every(validCommit) ? null : parsed.commits;
}

function install(next: HistoryCommit[], commit: string, nextComplete: boolean, source: NonNullable<WarmCoChangeStatus['source']>): void {
  const end = new Date().toISOString();
  const upper = Date.parse(end), lower = upper - 90 * DAY;
  commits = next.filter((c) => { const at = Date.parse(c.at); return at >= lower && at <= upper; });
  index = buildCoChangeIndex({ commits, end, commit, complete: nextComplete });
  head = commit;
  complete = nextComplete;
  status = { state: 'ready', indexCommit: commit, builtAt: end, source, eligibleCommits: index.eligibleCommits,
    refreshing: status.refreshing, error: null };
}

async function loadSnapshot(): Promise<Snapshot | null> {
  if (!snapshotPath) return null;
  try {
    const raw = JSON.parse(await readFile(snapshotPath, 'utf8')) as Partial<Snapshot>;
    return raw.version === WARM_COCHANGE_SNAPSHOT_VERSION && raw.root === root && typeof raw.head === 'string'
      && typeof raw.complete === 'boolean' && Array.isArray(raw.commits) ? raw as Snapshot : null;
  } catch { return null; }
}

async function writeSnapshot(): Promise<void> {
  if (!snapshotPath || !head) return;
  lastSnapshotAt = Date.now();
  const snapshot: Snapshot = { version: WARM_COCHANGE_SNAPSHOT_VERSION, root, head, complete, commits };
  const tmp = `${snapshotPath}.${process.pid}.tmp`;
  try {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(tmp, JSON.stringify(snapshot));
    await rename(tmp, snapshotPath);
  } catch (error) {
    // A missing snapshot only slows the next restart; the live index is unaffected.
    status = { ...status, error: `snapshot not written: ${message(error)}` };
  }
}

async function refreshOnce(): Promise<void> {
  const current = (await git(['rev-parse', 'HEAD'])).trim();
  if (index && head === current) return;
  const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false';
  if (index && head) {
    const added = await delta(head, current);
    if (added) {
      install([...added, ...commits], current, complete && !shallow, 'refresh');
      if (Date.now() - lastSnapshotAt >= SNAPSHOT_EVERY_MS) await writeSnapshot();
      return;
    }
  } else {
    const snapshot = await loadSnapshot();
    const added = snapshot ? await delta(snapshot.head, current) : null;
    if (snapshot && added) {
      install([...added, ...snapshot.commits.filter(validCommit)], current, snapshot.complete && !shallow, 'snapshot+delta');
      await writeSnapshot();
      return;
    }
  }
  const full = await readHistoryCommits(root, new Date().toISOString(), undefined, FULL_WINDOW_HISTORY_BOUNDS);
  install(full.commits, full.commit, full.complete, 'full');
  await writeSnapshot();
}

function requestRefresh(): void {
  if (refreshing) { dirty = true; return; }
  status = { ...status, refreshing: true };
  refreshing = (async () => {
    do {
      dirty = false;
      try { await refreshOnce(); } catch (error) {
        status = { ...status, state: index ? 'ready' : 'failed', error: message(error) };
      }
    } while (dirty);
  })().finally(() => { refreshing = null; status = { ...status, refreshing: false }; });
}

function scheduleRefresh(): void {
  clearTimeout(settle);
  settle = setTimeout(requestRefresh, REFRESH_SETTLE_MS);
}

async function watchRefs(): Promise<void> {
  const gitDir = resolve(root, (await git(['rev-parse', '--git-dir'])).trim());
  const commonDir = resolve(root, (await git(['rev-parse', '--git-common-dir'])).trim());
  const ref = (await git(['symbolic-ref', '-q', 'HEAD']).catch(() => '')).trim();
  const refName = ref ? ref.split('/').pop()! : null;
  // Only ref-bearing names: `.git/index` changes on every `git status` and must not rebuild anything.
  const relevant = new Set(['HEAD', 'packed-refs', ...(refName ? [refName, `${refName}.lock`] : [])]);
  const dirs = new Set([gitDir, commonDir, ...(ref ? [dirname(join(commonDir, ref))] : [])]);
  for (const dir of dirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, file) => {
        if (!file || relevant.has(String(file))) scheduleRefresh();
      });
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch { /* an unwatchable dir leaves the query-triggered refresh as the only trigger */ }
  }
}

function answer(query: Extract<WarmCoChangeRequest, { kind: 'warm-cochange-query' }>): WarmCoChangeReply {
  const base = { kind: 'warm-cochange-reply' as const, id: query.id };
  if (!index || !head) {
    requestRefresh();
    return { ...base, outcome: 'not-ready', status,
      error: `co-change index not ready (${status.state}${status.error ? `: ${status.error}` : ''})` };
  }
  if (head !== query.commit) {
    requestRefresh();
    return { ...base, outcome: 'behind', status,
      error: `co-change index is at ${head.slice(0, 12)}, the request is at ${query.commit.slice(0, 12)}; refresh requested` };
  }
  try { return { ...base, outcome: 'answered', report: coChangeFromIndex(index, query.paths), status }; }
  catch (error) { return { ...base, outcome: 'error', error: message(error), status }; }
}

if (process.send) {
  process.on('disconnect', () => process.exit(0));
  process.on('message', (raw: unknown) => {
    const request = raw as WarmCoChangeRequest | null;
    if (request?.kind === 'warm-cochange-init') {
      if (root) return;
      root = request.root;
      snapshotPath = request.snapshotPath;
      void watchRefs().catch(() => undefined);
      requestRefresh();
    } else if (request?.kind === 'warm-cochange-query') {
      process.send?.(answer(request));
    }
  });
}
