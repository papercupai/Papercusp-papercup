/**
 * Pin a repo-files proof to the commit(s) it was measured at (P-018,
 * review-system-rework-reduction-2026-09-23).
 *
 * WHY. A `repo-files` binding's freshness is a content hash of its measured source
 * and test files, re-computed from the live tree on every read. That verdict is
 * correct and stays unchanged: if a measured file really moved, the proof no longer
 * describes the code (R-7 — no check is removed). What was missing is everything
 * AFTER the stale verdict. The binding recorded one opaque digest per dimension, so a
 * reader could see "source-stale" but not WHICH of up to 32 files moved, WHERE (the
 * superproject or a submodule), or WHETHER the move was a committed peer change or an
 * uncommitted edit still in flight. On turn-start-memory-two-class-2026-09-21 that gap
 * cost ~20 tool calls per BAR, spent reverse-engineering what one peer refactor touched.
 *
 * WHAT. At measurement time each file's content hash, its git blob id, the HEAD of the
 * repository that owns it and the gitlink its parent pins (every migration lives in the
 * `libs/papercusp` submodule, where a superproject-relative `git log` is always empty)
 * are recorded under `details.measurementPin`. On read, the per-file hashes name the
 * moved paths exactly; `explainMovedPaths` turns those into the commits that touched
 * each path since the pin, or flags an uncommitted edit.
 *
 * The pin is DIAGNOSTIC. It never makes a stale proof current and never fails a bind:
 * every git probe is best-effort and records its error instead of throwing. It is
 * excluded from the binding fingerprint (see `specEvidenceBindingFingerprint`) because a
 * HEAD sha is not a property of the proof's content: re-binding identical proof after an
 * unrelated commit must still dedupe to `unchanged`.
 */
import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { execFileResult, execFileResultShared, gitReadIsContentAddressed } from '../../sync-exec-replay';

export const MEASUREMENT_PIN_DETAILS_KEY = 'measurementPin';

/** One measured file, hashed from the exact bytes the fingerprint was computed over. */
export interface MeasuredRepoFile {
  path: string;
  dimension: 'source' | 'test' | 'fixture';
  sha256: string;
  /** Git blob id of the working-tree bytes (`git hash-object`), sha1 object format. */
  gitBlob: string;
  /** Set only when this file is measured from a repository root distinct from the default root. */
  rootHarnessSlug?: string;
}

const pinnedFileSchema = z.object({
  path: z.string(),
  dimension: z.enum(['source', 'test', 'fixture']),
  sha256: z.string(),
  rootHarnessSlug: z.string().optional(),
  /** Repo-relative location of the owning repository; `.` is the measurement root. */
  repo: z.string(),
  /** The blob HEAD held for this path when measured; null when untracked or unreadable. */
  headBlob: z.string().nullable(),
  /** Whether the measured bytes equalled HEAD's blob; null when that could not be read. */
  clean: z.boolean().nullable(),
});

const pinnedRepoSchema = z.object({
  repo: z.string(),
  rootHarnessSlug: z.string().optional(),
  head: z.string().nullable(),
  /** The commit the PARENT repository's HEAD pins for this submodule; null for the root. */
  gitlink: z.string().nullable(),
});

export const measurementPinSchema = z.object({
  schemaVersion: z.literal(1),
  files: z.array(pinnedFileSchema),
  repos: z.array(pinnedRepoSchema),
  errors: z.array(z.string()).optional(),
});

export type MeasurementPin = z.infer<typeof measurementPinSchema>;
export type PinnedFile = z.infer<typeof pinnedFileSchema>;

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 5_000;

/**
 * EI-24852529885337741: each fork of the ~1.7 GB operator costs ~160 ms of synchronous
 * main-thread time, and an execve census of :3170 (2026-10-02 08:01-08:12Z) caught
 * `plans:bind-from-test-run` issuing the same `rev-parse --verify --quiet <sha>:<path>` twice
 * within 0.3-0.5 s for each of its paths. Calls that name only immutable objects (a full sha,
 * optionally `:<path>`) therefore go through the process-wide single-flight git-read memo.
 * HEAD-relative reads (`rev-parse HEAD`, `ls-tree HEAD`, `log <pin>..HEAD`) do NOT: this module
 * compares a pin against the CURRENT tree, and a reused answer up to 2 s old reads a commit made
 * in between as an uncommitted edit (the submodule-attribution test catches exactly that).
 * The contract is unchanged: stdout on exit 0, otherwise a thrown `Command failed …` error
 * whose first line names the argv (callers record `errorText(error)`, which reads it).
 */
export const defaultGitRunner: GitRunner = async (cwd, args) => {
  const argv = ['-C', cwd, ...args];
  // WI-6554700010029986: `git -C <missing dir>` forks and execs a whole git process only to exit
  // 128. About half of recorded test-run roots are deleted disposable clones, and on a large-heap
  // host each fork costs main-thread time. Return that exact outcome without the child. Any other
  // stat failure (permission, not a directory) still goes to git, so its own diagnosis is kept.
  if (cwd && (await isMissingPath(cwd))) {
    throw new Error(
      `Command failed (exit 128): git ${argv.join(' ')}\nfatal: cannot change to '${cwd}': No such file or directory\n`,
    );
  }
  const exec = gitReadIsContentAddressed(argv) ? execFileResultShared : execFileResult;
  const result = await exec('git', argv, { timeout: GIT_TIMEOUT_MS });
  if (result.status === 0) return result.stdout;
  const why = result.status === null
    ? result.error
      ? `no exit status; code=${result.error.code ?? 'none'}, signal=${result.error.signal ?? 'none'}, killed=${result.error.killed}`
      : 'no exit status'
    : `exit ${result.status}`;
  throw new Error(`Command failed (${why}): git ${argv.join(' ')}\n${result.stderr}`);
};

/** Git's sha1 blob id for `content`, identical to `git hash-object`. */
export function gitBlobId(content: Buffer): string {
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** True only when `path` positively does not exist (ENOENT); every other outcome is false. */
async function isMissingPath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
  }
}

async function hasGitEntry(root: string, repo: string): Promise<boolean> {
  try {
    await lstat(join(root, repo, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The innermost repository that owns `path`, as a root-relative directory (`.` for the
 * root). A submodule's working directory carries a `.git` FILE, so the deepest ancestor
 * holding a `.git` entry is the owner. Pure filesystem, no git process.
 */
export async function owningRepo(
  root: string,
  path: string,
  exists: (repo: string) => Promise<boolean> = (repo) => hasGitEntry(root, repo),
): Promise<string> {
  const segments = path.split('/');
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const candidate = segments.slice(0, depth).join('/');
    if (await exists(candidate)) return candidate;
  }
  return '.';
}

const relativeTo = (repo: string, path: string) => (repo === '.' ? path : path.slice(repo.length + 1));

function parseLsTree(output: string): Map<string, { type: string; object: string }> {
  const entries = new Map<string, { type: string; object: string }>();
  for (const line of output.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [, type, object] = line.slice(0, tab).split(' ');
    if (type && object) entries.set(line.slice(tab + 1), { type, object });
  }
  return entries;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 200);

/**
 * Record, for each measured file, the repository and commit it was measured against.
 * Never throws: a probe that fails leaves a null field and an entry in `errors`.
 */
export async function buildMeasurementPin(
  root: string,
  files: readonly MeasuredRepoFile[],
  options: {
    git?: GitRunner;
    exists?: (repo: string, root?: string) => Promise<boolean>;
    roots?: Readonly<Record<string, string>>;
  } = {},
): Promise<MeasurementPin> {
  const git = options.git ?? defaultGitRunner;
  const errors: string[] = [];
  const fileKey = (file: Pick<MeasuredRepoFile, 'path' | 'rootHarnessSlug'>) =>
    `${file.rootHarnessSlug ?? ''}\0${file.path}`;
  const rootFor = (rootHarnessSlug: string | undefined): string | null => {
    if (!rootHarnessSlug) return root;
    return options.roots?.[rootHarnessSlug] ?? null;
  };
  const repoOf = new Map<string, { repo: string; root: string | null; rootHarnessSlug?: string }>();
  for (const file of files) {
    const fileRoot = rootFor(file.rootHarnessSlug);
    if (!fileRoot) {
      errors.push(`root:${file.rootHarnessSlug}:unavailable`);
      repoOf.set(fileKey(file), { repo: '.', root: null, rootHarnessSlug: file.rootHarnessSlug });
      continue;
    }
    const exists = (repo: string) => options.exists
      ? options.exists(repo, fileRoot)
      : hasGitEntry(fileRoot, repo);
    repoOf.set(fileKey(file), {
      repo: await owningRepo(fileRoot, file.path, exists),
      root: fileRoot,
      ...(file.rootHarnessSlug ? { rootHarnessSlug: file.rootHarnessSlug } : {}),
    });
  }

  const groupKey = (group: { repo: string; rootHarnessSlug?: string }) =>
    `${group.rootHarnessSlug ?? ''}\0${group.repo}`;
  const repoGroups = new Map<string, { repo: string; root: string | null; rootHarnessSlug?: string }>();
  for (const value of repoOf.values()) repoGroups.set(groupKey(value), value);
  const repos = [...repoGroups.entries()].sort(([a], [b]) => a.localeCompare(b));
  const heads = new Map<string, string | null>();
  const blobs = new Map<string, Map<string, { type: string; object: string }>>();
  await Promise.all(
    repos.map(async ([key, group]) => {
      if (!group.root) {
        heads.set(key, null);
        return;
      }
      const cwd = join(group.root, group.repo);
      try {
        heads.set(key, (await git(cwd, ['rev-parse', 'HEAD'])).trim() || null);
      } catch (error) {
        heads.set(key, null);
        errors.push(`head:${group.rootHarnessSlug ?? 'default'}:${group.repo}:${errorText(error)}`);
        return;
      }
      const paths = files
        .filter((file) => groupKey(repoOf.get(fileKey(file))!) === key)
        .map((file) => relativeTo(group.repo, file.path));
      try {
        blobs.set(key, parseLsTree(await git(cwd, ['ls-tree', 'HEAD', '--', ...new Set(paths)])));
      } catch (error) {
        errors.push(`ls-tree:${group.rootHarnessSlug ?? 'default'}:${group.repo}:${errorText(error)}`);
      }
    }),
  );

  const pinnedRepos = await Promise.all(
    repos.map(async ([key, group]) => {
      const identity = group.rootHarnessSlug ? { rootHarnessSlug: group.rootHarnessSlug } : {};
      if (group.repo === '.' || !group.root) return { ...identity, repo: group.repo, head: heads.get(key) ?? null, gitlink: null };
      const exists = (repo: string) => options.exists
        ? options.exists(repo, group.root!)
        : hasGitEntry(group.root!, repo);
      const parent = await owningRepo(group.root, group.repo, exists);
      let gitlink: string | null = null;
      try {
        const entry = parseLsTree(await git(join(group.root, parent), ['ls-tree', 'HEAD', '--', relativeTo(parent, group.repo)])).get(
          relativeTo(parent, group.repo),
        );
        gitlink = entry?.type === 'commit' ? entry.object : null;
      } catch (error) {
        errors.push(`gitlink:${group.rootHarnessSlug ?? 'default'}:${group.repo}:${errorText(error)}`);
      }
      return { ...identity, repo: group.repo, head: heads.get(key) ?? null, gitlink };
    }),
  );

  const pinnedFiles = files.map((file) => {
    const group = repoOf.get(fileKey(file))!;
    const identity = file.rootHarnessSlug ? { rootHarnessSlug: file.rootHarnessSlug } : {};
    const key = groupKey(group);
    const tree = blobs.get(key);
    const entry = tree?.get(relativeTo(group.repo, file.path));
    const headBlob = entry?.type === 'blob' ? entry.object : null;
    // Only a sha1 repository's blob id is comparable with `gitBlobId`; a sha256 object
    // format would read as permanently dirty, which is a wrong answer, so say unknown.
    const clean = tree === undefined ? null : headBlob === null ? false : headBlob.length === 40 ? headBlob === file.gitBlob : null;
    return { ...identity, path: file.path, dimension: file.dimension, sha256: file.sha256, repo: group.repo, headBlob, clean };
  });

  return {
    schemaVersion: 1,
    files: pinnedFiles,
    repos: pinnedRepos,
    ...(errors.length > 0 ? { errors: errors.sort() } : {}),
  };
}

export function readMeasurementPin(details: Record<string, unknown> | null | undefined): MeasurementPin | null {
  const parsed = measurementPinSchema.safeParse(details?.[MEASUREMENT_PIN_DETAILS_KEY]);
  return parsed.success ? parsed.data : null;
}

export interface MovedPath {
  path: string;
  dimension: 'source' | 'test' | 'fixture';
  rootHarnessSlug?: string;
  /** `changed` = bytes differ; `added` = measured now but absent from the pin; `removed` = pinned but no longer measured. */
  change: 'changed' | 'added' | 'removed';
}

/**
 * Exactly which measured files differ from what the proof was measured against.
 * `pinned:false` means the binding predates the pin, so only the aggregate stale
 * verdict is available for it — never read that as "nothing moved".
 */
export function diffMeasuredFiles(
  pin: MeasurementPin | null,
  current: readonly Pick<MeasuredRepoFile, 'path' | 'dimension' | 'sha256' | 'rootHarnessSlug'>[],
): { pinned: false } | { pinned: true; moved: MovedPath[] } {
  if (!pin) return { pinned: false };
  const key = (file: { path: string; dimension: string; rootHarnessSlug?: string }) =>
    `${file.rootHarnessSlug ?? ''}\0${file.dimension}\0${file.path}`;
  const before = new Map(pin.files.map((file) => [key(file), file]));
  const after = new Map(current.map((file) => [key(file), file]));
  const moved: MovedPath[] = [];
  for (const [id, file] of after) {
    const prior = before.get(id);
    if (!prior) moved.push({ path: file.path, dimension: file.dimension, ...(file.rootHarnessSlug ? { rootHarnessSlug: file.rootHarnessSlug } : {}), change: 'added' });
    else if (prior.sha256 !== file.sha256) moved.push({ path: file.path, dimension: file.dimension, ...(file.rootHarnessSlug ? { rootHarnessSlug: file.rootHarnessSlug } : {}), change: 'changed' });
  }
  for (const [id, file] of before) {
    if (!after.has(id)) moved.push({ path: file.path, dimension: file.dimension, ...(file.rootHarnessSlug ? { rootHarnessSlug: file.rootHarnessSlug } : {}), change: 'removed' });
  }
  return { pinned: true, moved: moved.sort((a, b) =>
    (a.rootHarnessSlug ?? '').localeCompare(b.rootHarnessSlug ?? '') || a.path.localeCompare(b.path) || a.dimension.localeCompare(b.dimension)) };
}

export interface MovedPathExplanation extends MovedPath {
  repo: string;
  pinnedHead: string | null;
  /** Commits in the owning repo that touched the path since the pin, newest first (bounded). */
  commits: Array<{ sha: string; committedAt: string; subject: string }>;
  /** True when the live bytes differ from the owning repo's CURRENT HEAD blob: an edit still in flight. */
  uncommitted: boolean | null;
  errors?: string[];
}

const MAX_COMMITS_PER_PATH = 5;

/**
 * Attribute each moved path to the commits that changed it since the pin, per owning
 * repository — so a submodule path is logged INSIDE the submodule, where its history
 * actually lives. Bounded and best-effort; used on the re-measure path, not every read.
 */
export async function explainMovedPaths(
  root: string,
  pin: MeasurementPin,
  moved: readonly MovedPath[],
  current: ReadonlyMap<string, Pick<MeasuredRepoFile, 'gitBlob'>>,
  options: { git?: GitRunner; exists?: (repo: string, root?: string) => Promise<boolean>; roots?: Readonly<Record<string, string>> } = {},
): Promise<MovedPathExplanation[]> {
  const git = options.git ?? defaultGitRunner;
  const groupKey = (repo: { repo: string; rootHarnessSlug?: string }) => `${repo.rootHarnessSlug ?? ''}\0${repo.repo}`;
  const pinnedHead = new Map(pin.repos.map((repo) => [groupKey(repo), repo.head]));
  const pinnedRepoOf = new Map(pin.files.map((file) => [`${file.rootHarnessSlug ?? ''}\0${file.path}`, file.repo]));
  return Promise.all(
    moved.map(async (entry) => {
      const entryRoot = entry.rootHarnessSlug ? options.roots?.[entry.rootHarnessSlug] : root;
      const errors: string[] = [];
      if (!entryRoot) {
        errors.push(`root:${entry.rootHarnessSlug}:unavailable`);
        return { ...entry, repo: '.', pinnedHead: null, commits: [], uncommitted: null, errors };
      }
      const exists = (repo: string) => options.exists
        ? options.exists(repo, entryRoot)
        : hasGitEntry(entryRoot, repo);
      const repo = pinnedRepoOf.get(`${entry.rootHarnessSlug ?? ''}\0${entry.path}`) ?? (await owningRepo(entryRoot, entry.path, exists));
      const head = pinnedHead.get(groupKey({ repo, rootHarnessSlug: entry.rootHarnessSlug })) ?? null;
      const rel = relativeTo(repo, entry.path);
      const cwd = join(entryRoot, repo);
      let commits: MovedPathExplanation['commits'] = [];
      if (head) {
        try {
          const log = await git(cwd, ['log', `-n${MAX_COMMITS_PER_PATH}`, '--format=%H%x09%cI%x09%s', `${head}..HEAD`, '--', rel]);
          commits = log
            .split('\n')
            .filter((line) => line.trim() !== '')
            .map((line) => {
              const [sha = '', committedAt = '', ...subject] = line.split('\t');
              return { sha, committedAt, subject: subject.join('\t').slice(0, 160) };
            });
        } catch (error) {
          errors.push(`log:${errorText(error)}`);
        }
      }
      let uncommitted: boolean | null = null;
      const live = current.get(`${entry.rootHarnessSlug ?? ''}\0${entry.path}`) ?? current.get(entry.path);
      if (live && entry.change !== 'removed') {
        try {
          const tree = parseLsTree(await git(cwd, ['ls-tree', 'HEAD', '--', rel]));
          const blob = tree.get(rel);
          uncommitted = blob?.type === 'blob' && blob.object.length === 40 ? blob.object !== live.gitBlob : blob ? null : true;
        } catch (error) {
          errors.push(`ls-tree:${errorText(error)}`);
        }
      }
      return { ...entry, repo, pinnedHead: head, commits, uncommitted, ...(errors.length > 0 ? { errors } : {}) };
    }),
  );
}
