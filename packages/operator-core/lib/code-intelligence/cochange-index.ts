/** The commit co-change window as a dependency-free leaf: read the 90-day first-parent log, build
 * the per-path commit populations, and answer Jaccard co-change pairs from them.
 *
 * WI-6554700010030353: this is the half of change-history.ts that the resident index worker
 * (warm-cochange-index.worker.ts) runs in its own process. It must import only node built-ins and
 * history-path.ts, because runtime-worker-bundle-graph.test.ts refuses a worker bundle that reaches
 * host-only packages (change-history.ts imports @papercusp/db-org and typescript for provenance).
 * change-history.ts re-exports everything here, so existing importers are unchanged.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eligibleHistoryPath, safeHistoryPath as safe } from './history-path';

// Deferred to first call, memoized (lint:no-eager-execfile-promisify): a module-scope
// promisify(execFile) runs at import in every transitive importer, including mocked tests.
type RunFile = (file: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
let cachedRun: RunFile | null = null;
const run: RunFile = (file, args, opts) => (cachedRun ??= promisify(execFile) as unknown as RunFile)(file, args, opts);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const DAY = 86_400_000;
const COMMIT_CAP = 1000;
export const CHANGE_HISTORY_VERSION = 'history/first-parent-90d-v1';
export interface HistoryCommit {
  sha: string; parents: string[]; at: string;
  files: { status: string; path: string; from?: string }[];
}
export interface CoChangePair { path: string; partner: string; shared: number; union: number; score: number }
export interface CoChangeReport {
  status: 'measured' | 'unknown'; version: string; commit: string | null;
  window: { start: string; end: string; lineage: 'first-parent' };
  pairs: CoChangePair[]; unknownPaths: string[]; eligibleCommits: number;
  complete: boolean; limitations: string[]; error: string | null;
}

/** One 90-day first-parent window, prepared once: the commits, rename identity and per-path
 * commit populations every co-change query reads. Building it is the expensive part (a sort,
 * the rename and reused-path scans, a digest over every commit), so a caller asking about many
 * path sets (cleanup triage, one family at a time) builds it once and queries it per scope. */
export interface CoChangeIndex {
  readonly end: string;
  readonly start: number;
  readonly commit: string | null;
  readonly complete: boolean;
  readonly version: string;
  readonly eligibleCommits: number;
  readonly unknown: ReadonlySet<string>;
  readonly populations: ReadonlyMap<string, ReadonlySet<string>>;
  canonical(path: string): string;
}

/** Rename chains are evidence; conflicting endpoints/copies are not identity. */
export function buildCoChangeIndex(input: {
  commits: readonly HistoryCommit[]; end: string; commit: string | null; complete: boolean;
}): CoChangeIndex {
  const end = Date.parse(input.end);
  if (!Number.isFinite(end)) throw new Error('Invalid history scope/window');
  const start = end - 90 * DAY;
  const at = new Map<HistoryCommit, number>();
  for (const c of input.commits) at.set(c, Date.parse(c.at));
  const commits = [...new Map(input.commits.filter(c => c.parents.length <= 1
    && at.get(c)! >= start && at.get(c)! < end).map(c => [c.sha, c])).values()]
    .sort((a, b) => at.get(a)! - at.get(b)! || a.sha.localeCompare(b.sha));
  const renames = new Map<string, string>();
  const renameSources = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  for (const c of commits) for (const f of c.files) {
    if (f.status.startsWith('C')) { unknown.add(f.path); if (f.from) unknown.add(f.from); }
    if (!f.status.startsWith('R')) continue;
    if (!f.from || !safe(f.from) || !safe(f.path) || !/^R\d{1,3}$/.test(f.status) || Number(f.status.slice(1)) < 50 || Number(f.status.slice(1)) > 100
      || (renames.has(f.from) && renames.get(f.from) !== f.path)
      || [...(renameSources.get(f.path) ?? [])].some(from => from !== f.from)) {
      unknown.add(f.path); if (f.from) unknown.add(f.from);
    } else {
      renames.set(f.from, f.path);
      const sources = renameSources.get(f.path) ?? new Set<string>(); sources.add(f.from); renameSources.set(f.path, sources);
    }
  }
  const canonical = (path: string) => {
    const seen = new Set<string>();
    while (renames.has(path)) {
      if (seen.has(path)) { for (const p of seen) unknown.add(p); break; }
      seen.add(path); path = renames.get(path)!;
    }
    return path;
  };
  // Reusing a retired pathname breaks identity even when a rename was recorded.
  const renamedAway = new Map<string, number>();
  for (const c of commits) for (const f of c.files) if (f.from && f.status.startsWith('R'))
    renamedAway.set(f.from, Math.min(renamedAway.get(f.from) ?? Infinity, at.get(c)!));
  for (const c of commits) for (const f of c.files) if (f.status === 'A' && renames.has(f.path)
    && (renamedAway.get(f.path) ?? Infinity) < at.get(c)!) unknown.add(f.path);
  for (const path of [...unknown]) unknown.add(canonical(path));
  const populations = new Map<string, Set<string>>();
  let eligibleCommits = 0;
  for (const c of commits) {
    const files = [...new Set(c.files.flatMap(f => [f.path, ...(f.from ? [f.from] : [])]).filter(eligibleHistoryPath).map(canonical))];
    if (files.length > 100) continue;
    const paths = files.filter(path => !unknown.has(path));
    if (!paths.length) continue;
    eligibleCommits++;
    for (const path of paths) {
      const set = populations.get(path) ?? new Set<string>(); set.add(c.sha); populations.set(path, set);
    }
  }
  return { end: input.end, start, commit: input.commit, complete: input.complete,
    version: digest(JSON.stringify([CHANGE_HISTORY_VERSION, input.commit, commits])),
    eligibleCommits, unknown, populations, canonical };
}

/** Co-change pairs for `paths` from a prepared window. `partners` restricts the partner side
 * (triage asks only whether a family's own files change together, so a member file with many
 * stronger outside partners cannot push its in-family links out of the result); `limit`
 * bounds the sorted pairs (default 100). */
export function coChangeFromIndex(index: CoChangeIndex, paths: readonly string[],
  options: { partners?: readonly string[]; limit?: number } = {}): CoChangeReport {
  if (paths.length > 50 || !paths.every(safe)) throw new Error('Invalid history scope/window');
  const limit = options.limit ?? 100;
  if (!(limit >= 0)) throw new Error('Co-change limit must be non-negative');
  const scope = options.partners
    ? [...new Set(options.partners.map(index.canonical))].flatMap(p => {
      const population = index.populations.get(p);
      return population ? [[p, population] as const] : [];
    })
    : index.populations;
  const pairs: CoChangePair[] = [];
  for (const requested of [...new Set(paths)]) {
    const path = index.canonical(requested), own = index.populations.get(path);
    if (index.unknown.has(requested) || index.unknown.has(path) || !own) continue;
    for (const [partner, other] of scope) {
      if (partner === path) continue;
      const [small, large] = own.size <= other.size ? [own, other] : [other, own];
      let shared = 0;
      for (const sha of small) if (large.has(sha)) shared++;
      const union = own.size + other.size - shared;
      if (shared >= 3) pairs.push({ path: requested, partner, shared, union, score: shared / union });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.partner.localeCompare(b.partner) || a.path.localeCompare(b.path));
  return { status: index.complete ? 'measured' : 'unknown', version: index.version,
    commit: index.commit, window: { start: new Date(index.start).toISOString(), end: index.end, lineage: 'first-parent' },
    pairs: pairs.slice(0, limit), unknownPaths: [...index.unknown].sort(), eligibleCommits: index.eligibleCommits,
    complete: index.complete,
    limitations: ['90-day first-parent eligible commits only; generated/vendor/retired and >100-file changes excluded.',
      'Jaccard = shared eligible commits / union eligible commits; minimum three shared; association does not prove dependency.',
      ...(!index.complete ? ['History is truncated/unavailable; scores are not complete-window measurements.'] : []),
      ...(index.unknown.size ? ['Conflicting rename/copy/reused-path identity remains unknown.'] : []),
      ...(options.partners ? ['Partners restricted to the requested scope.'] : [])], error: null };
}

export function coChangeFromCommits(input: {
  commits: readonly HistoryCommit[]; paths: readonly string[]; end: string;
  commit: string | null; complete: boolean;
}): CoChangeReport {
  if (!Number.isFinite(Date.parse(input.end)) || input.paths.length > 50 || !input.paths.every(safe)) {
    throw new Error('Invalid history scope/window');
  }
  return coChangeFromIndex(buildCoChangeIndex(input), input.paths);
}

/** How much of the window a read may take: commit cap, git timeout and output buffer. */
export interface HistoryReadBounds { cap: number; timeoutMs: number; maxBufferBytes: number }
/** In-process reads (reuse briefs, graph:query) must stay cheap. On a repository that commits
 * every few minutes the window outgrows the cap, and such a read honestly reports incomplete. */
export const IN_PROCESS_HISTORY_BOUNDS: HistoryReadBounds = { cap: COMMIT_CAP, timeoutMs: 3000, maxBufferBytes: 4 * 1024 * 1024 };
/** For a managed child with its own heap and budget (the cleanup-campaign round, the resident
 * co-change index), never the operator host. Sized from the Papercusp tree on 2026-10-27: 36,851
 * first-parent commits in the 90-day window, a 26.7 MB name-status log, read in 41 s. */
export const FULL_WINDOW_HISTORY_BOUNDS: HistoryReadBounds = { cap: 250_000, timeoutMs: 300_000, maxBufferBytes: 512 * 1024 * 1024 };

const NAME_STATUS = /^[ACDMRTUXB]\d{0,3}$/;

/** Parse `git log -z --name-status --format=%x1e%H%x09%P%x09%cI`. Each field ends in NUL and a
 * path is printed raw (no C-quoting), so a path may hold any byte but NUL. A token is therefore
 * read as a header, a status or a path by its POSITION, never by its content: the first status
 * of a commit carries a leading newline, a rename or copy is followed by two paths, every other
 * status by one. `malformed` means the record structure itself did not parse. */
export function parseHistoryLog(log: string): { commits: HistoryCommit[]; malformed: boolean } {
  const tokens = log.split('\0');
  const commits: HistoryCommit[] = [];
  let current: HistoryCommit | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith('\x1e')) {
      const fields = token.slice(1).split('\t');
      if (fields.length !== 3) return { commits, malformed: true };
      const [sha, parents, at] = fields as [string, string, string];
      current = { sha, parents: parents ? parents.split(' ') : [], at, files: [] };
      commits.push(current);
      continue;
    }
    if (!token && i === tokens.length - 1) break;
    const status = current?.files.length ? token : token.replace(/^\n/, '');
    if (!current || !NAME_STATUS.test(status)) return { commits, malformed: true };
    const arity = /^[RC]/.test(status) ? 2 : 1;
    const paths = tokens.slice(i + 1, i + 1 + arity);
    if (paths.length < arity || paths.some(path => !path)) return { commits, malformed: true };
    i += arity;
    current.files.push(arity === 2 ? { status, from: paths[0]!, path: paths[1]! } : { status, path: paths[0]! });
  }
  return { commits, malformed: false };
}

/** The 90-day first-parent window ending at `end`, as full commit file lists — never a
 * pathspec-pruned log, which would hide co-change partners. `complete` is false when the
 * window was truncated at the commit cap, a record was malformed, or the clone is shallow.
 * Paths are raw (`-z`). A path that is not a safe history path (a backslash, a newline) is
 * kept as recorded and is ineligible downstream; it never voids the window. Before `-z`, git
 * C-quoted such a name and one junk file voided all 36,620 commits of the Papercusp window. */
export async function readHistoryCommits(root: string, end = new Date().toISOString(), signal?: AbortSignal,
  bounds: HistoryReadBounds = IN_PROCESS_HISTORY_BOUNDS): Promise<{
  commits: HistoryCommit[]; commit: string; complete: boolean;
}> {
  if (!Number.isInteger(bounds.cap) || bounds.cap < 1 || !(bounds.timeoutMs > 0) || !(bounds.maxBufferBytes > 0)) {
    throw new Error('History read bounds need a positive integer cap, timeout and buffer');
  }
  const start = new Date(Date.parse(end) - 90 * DAY).toISOString();
  const git = async (args: string[], limits = IN_PROCESS_HISTORY_BOUNDS) => (await run('git', ['-C', root, ...args],
    { encoding: 'utf8', timeout: limits.timeoutMs, maxBuffer: limits.maxBufferBytes, signal })).stdout;
  const commit = (await git(['rev-parse', 'HEAD'])).trim();
  const shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false';
  const log = await git(['log', commit, '--first-parent', '--no-merges', '-z',
    '--name-status', '-M50%', '--format=%x1e%H%x09%P%x09%cI', `--since=${start}`, `--until=${end}`, `-n${bounds.cap + 1}`], bounds);
  const parsed = parseHistoryLog(log);
  const commits = parsed.commits;
  const malformed = parsed.malformed
    || commits.some(c => !/^[a-f0-9]{40,64}$/.test(c.sha) || !Number.isFinite(Date.parse(c.at)));
  return { commits: commits.slice(0, bounds.cap), commit, complete: commits.length <= bounds.cap && !malformed && !shallow };
}
