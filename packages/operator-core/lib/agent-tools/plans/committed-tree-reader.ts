/**
 * Read repository files as they exist at ONE commit, from git objects
 * (proof-freshness-pinned-candidate-2026-10-06 P-002, decision D-001).
 *
 * WHY. A repo-files proof binding stores a sha256 fingerprint of the files it measured.
 * Freshness used to be re-measured from the LIVE shared working tree, so any peer's
 * uncommitted edit to any file in a proof's closure (a hub file like work-items.ts is in
 * most closures) made shipped proof read stale within minutes, and binds refused on the
 * same drift. D-001 moves the measurement onto committed bytes: one measurement commit M
 * per evaluation, read from git objects, so uncommitted edits are invisible while a
 * committed change to a closure file still reads stale (nothing is waived).
 *
 * COST. Every read is batched per repository, never per file or per binding: one
 * `ls-tree` per repository (plus one per parent to resolve submodule gitlinks) and one
 * `cat-file --batch` per repository for blob contents not already digested. Blob ids are
 * content addresses, so the blob -> sha256 memo below is correct forever and repeated
 * evaluations of an unchanged commit spawn no `cat-file` at all.
 *
 * The file-set digest lives here so the working-tree measurement and the commit
 * measurement share one canonical formula: a binding stored before this change reads
 * current exactly when its fingerprint equals the closure bytes at M.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, posix, resolve as resolvePath } from 'node:path';
import { minimatch } from 'minimatch';
import { pinModuleState } from '@papercusp/module-singleton';
import { createTextCollector } from '../../child-output';
import {
  gitSidecarEnabled,
  isSidecarInfrastructureFault,
  noteSidecarFallback,
  runGitStdinViaSpawnerSidecar,
  type GitStdinRunResult,
} from '../../fleet/git-via-sidecar';
import { defaultGitRunner, gitBlobId, owningRepo, type GitRunner } from './evidence-measurement-pin';

/** One file as committed: the digest inputs plus the git blob id the bytes came from. */
export interface CommittedFile {
  path: string;
  sha256: string;
  gitBlob: string;
  size: number;
}

/** The route and caller PID at the default reader's process boundary. */
export interface BlobBatchSpawnBoundary {
  route: 'sidecar' | 'local';
  /** PID of the process doing the work; local spawn cost is paid by this process. */
  pid: number;
}

export interface CommittedTreeSpawnBoundaryRecord extends BlobBatchSpawnBoundary {
  requestTraceId: string | null;
  toolName: string;
}

/** Bounded per-request timing for one batched `git ls-tree` call. */
export interface CommittedTreeLsTreeRecord {
  repository: string;
  pathCount: number;
  pathBytes: number;
  argumentBytes: number;
  recursive: boolean;
  includeSizes: boolean;
  durationMs: number;
  outcome: 'success' | 'error';
  failurePhase?: 'git' | 'parse';
  errorCode?: string;
}

export interface CommittedTreeCallerContext {
  requestTraceId?: string | null;
  toolName: string;
}

/** Read blob contents for many ids in ONE process; ids absent from the result are missing. */
export type BlobBatchReader = (
  repoDir: string,
  blobIds: readonly string[],
  onRoute?: (route: 'sidecar' | 'local') => void,
  onSpawnBoundary?: (boundary: BlobBatchSpawnBoundary) => void,
) => Promise<Map<string, Buffer>>;

const MAX_SPAWN_BOUNDARY_RECORDS = 8;
const MAX_LS_TREE_RECORDS = 8;

/** Request-owned counters, never global cache statistics or a cache reset. */
export interface CommittedTreeDiagnostics {
  schemaVersion: 'committed-tree-diagnostics-v1';
  reads: number;
  /** Unique (repository, blob) lookups PER read; repeated reads add observations. */
  memoHits: number;
  memoMisses: number;
  batchAttempts: number;
  /** Success means every requested blob passed content-address validation. */
  batchSucceeded: number;
  batchFailed: number;
  blobsRequested: number;
  blobsReturned: number;
  blobsVerified: number;
  /** Actual default-reader branch; a supplied reader is classified as injected. */
  batchRoutes: { sidecar: number; local: number; injected: number };
  /** Present only for a caller-scoped probe; records are capped per request. */
  requestTraceId?: string | null;
  toolName?: string;
  spawnBoundaryRecords?: CommittedTreeSpawnBoundaryRecord[];
  spawnBoundaryRecordsDropped?: number;
  /** Present only for a caller-scoped probe; records never retain the path list itself. */
  lsTreeRecords?: CommittedTreeLsTreeRecord[];
  lsTreeRecordsDropped?: number;
}

export function createCommittedTreeDiagnostics(caller?: CommittedTreeCallerContext): CommittedTreeDiagnostics {
  const diagnostics: CommittedTreeDiagnostics = {
    schemaVersion: 'committed-tree-diagnostics-v1', reads: 0,
    memoHits: 0, memoMisses: 0, batchAttempts: 0, batchSucceeded: 0, batchFailed: 0,
    blobsRequested: 0, blobsReturned: 0, blobsVerified: 0,
    batchRoutes: { sidecar: 0, local: 0, injected: 0 },
  };
  if (caller) {
    diagnostics.requestTraceId = typeof caller.requestTraceId === 'string'
      ? caller.requestTraceId.slice(0, 120)
      : null;
    diagnostics.toolName = caller.toolName.slice(0, 120);
    diagnostics.spawnBoundaryRecords = [];
    diagnostics.spawnBoundaryRecordsDropped = 0;
    diagnostics.lsTreeRecords = [];
    diagnostics.lsTreeRecordsDropped = 0;
  }
  return diagnostics;
}

function recordLsTree(
  diagnostics: CommittedTreeDiagnostics | undefined,
  record: CommittedTreeLsTreeRecord,
): void {
  const records = diagnostics?.lsTreeRecords;
  if (!records) return;
  if (records.length >= MAX_LS_TREE_RECORDS) {
    diagnostics!.lsTreeRecordsDropped = (diagnostics!.lsTreeRecordsDropped ?? 0) + 1;
    return;
  }
  records.push(record);
}

function gitErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 40);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:^|[;, ])code=([A-Za-z0-9_-]+)/.exec(message)?.[1]?.slice(0, 40);
}

export interface CommittedTreeDeps {
  git?: GitRunner;
  readBlobs?: BlobBatchReader;
  diagnostics?: CommittedTreeDiagnostics;
  /** Whether `<root>/<repo>` is a nested repository; defaults to a `.git` entry probe. */
  exists?: (repo: string) => Promise<boolean>;
}

/** Admission and payload bounds are separate: a corpus need not fit in one batch. */
export interface RepoFileSetReadLimits {
  maxTotalBytes: number;
  maxFileBytes: number;
  maxBatchBytes: number;
}

export const REPO_FILE_SET_READ_LIMITS: Readonly<RepoFileSetReadLimits> = Object.freeze({
  maxTotalBytes: 8 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxBatchBytes: 8 * 1024 * 1024,
});
/** Fixture membership remains bounded by the recipe's existing 4096-match ceiling. */
export const REPO_FIXTURE_READ_LIMITS: Readonly<RepoFileSetReadLimits> = Object.freeze({
  ...REPO_FILE_SET_READ_LIMITS,
  maxTotalBytes: 64 * 1024 * 1024,
});

export interface CommittedGlobLimits {
  maxMatches: number;
  maxDepth: number;
}

const BLOB_BATCH_TIMEOUT_MS = 15_000;
const MAX_MEMOIZED_BLOBS = 50_000;
const COMMIT_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const blobDigests = pinModuleState('@papercusp/operator-core.committed-blob-digests', () => ({
  byBlob: new Map<string, { sha256: string; size: number }>(),
}));

/** The canonical `sha256-file-set-v1` digest over `{ path, sha256 }` entries. */
export function repoFileSetFingerprint(entries: ReadonlyArray<{ path: string; sha256: string }>): string {
  const ordered = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, sha256 }) => ({ path, sha256 }));
  const digest = createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
  return `sha256-file-set-v1:${digest}`;
}

const HEX_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Config that changes where the refs live, or makes the repository bare: only git can answer. */
const UNSUPPORTED_CONFIG_RE = /^\s*refstorage\s*=|^\s*bare\s*=\s*true\b/im;
/** `core.worktree` — set in every submodule's gitdir, pointing back at the checkout. */
const WORKTREE_CONFIG_RE = /^\s*worktree\s*=\s*(.+?)\s*$/gim;

/**
 * HEAD's commit read straight from the repository files, with no git child process
 * (WI-6554700010008489). Every measurement used to spawn `git rev-parse` from the
 * multi-GB bg-host, whose fork cost scales with its RSS. The answer is read fresh on
 * every call, never cached: a reused HEAD would make a commit landed in between read as
 * an uncommitted edit (see evidence-measurement-pin's memo note).
 *
 * Returns the commit only when it is POSITIVELY resolved: `root` holds the `.git` entry
 * (so it is the top level), HEAD is a detached object id or `ref: refs/heads/<b>`, and that
 * ref is a loose or packed id. Anything else returns `undefined` and the caller asks git:
 * GIT_DIR/GIT_WORK_TREE overrides, a repository owned by another user (git's
 * safe.directory refusal), core.worktree / reftable / bare config, an unborn branch, a
 * subdirectory, a non-git directory.
 */
/*
 * Synchronous metadata-only variant of the HEAD reader. Root/commit resolution
 * runs before evidence fan-out; async fs calls would queue every tiny metadata
 * read on libuv's shared threadpool and can stretch them into tens of seconds
 * while the operator is busy. Git metadata is bounded, so keep this path
 * synchronous and read it fresh on every call.
 */
export function readHeadCommitFromFilesSync(root: string): string | undefined {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) return undefined;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && lstatSync(root).uid !== uid) return undefined;
    const dotGit = join(root, '.git');
    const entry = lstatSync(dotGit);
    let gitDir: string;
    if (entry.isDirectory()) {
      gitDir = dotGit;
    } else if (entry.isFile()) {
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      if (!pointer) return undefined;
      gitDir = resolvePath(root, pointer[1]);
    } else {
      return undefined;
    }
    let commonDir = gitDir;
    try {
      commonDir = resolvePath(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim());
    } catch { /* regular checkout: the git dir is its common dir */ }
    let config = '';
    let worktreeConfig = '';
    try { config = readFileSync(join(commonDir, 'config'), 'utf8'); } catch { /* git answers below */ }
    try { worktreeConfig = readFileSync(join(gitDir, 'config.worktree'), 'utf8'); } catch { /* optional */ }
    if (UNSUPPORTED_CONFIG_RE.test(config) || UNSUPPORTED_CONFIG_RE.test(worktreeConfig)) return undefined;
    // A core.worktree is accepted only when it names `root` itself (the submodule layout);
    // one pointing anywhere else moves the work tree, and git must answer.
    const worktrees = [...`${config}\n${worktreeConfig}`.matchAll(WORKTREE_CONFIG_RE)].map((m) => m[1]);
    if (worktrees.length > 0) {
      const realRoot = realpathSync(root);
      for (const worktree of worktrees) {
        let target: string | null;
        try {
          target = realpathSync(resolvePath(gitDir, worktree.replace(/^"(.*)"$/, '$1')));
        } catch {
          target = null;
        }
        if (target !== realRoot) return undefined;
      }
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (HEX_OID_RE.test(head)) return head;
    const ref = /^ref:\s*(refs\/heads\/\S+)$/.exec(head)?.[1];
    if (!ref || ref.includes('..')) return undefined;
    let loose: string | null;
    try { loose = readFileSync(join(commonDir, ref), 'utf8').trim(); } catch { loose = null; }
    if (loose !== null) return HEX_OID_RE.test(loose) ? loose : undefined;
    let packed: string | null;
    try { packed = readFileSync(join(commonDir, 'packed-refs'), 'utf8'); } catch { packed = null; }
    if (packed === null) return undefined;
    for (const line of packed.split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0 && line.slice(space + 1).trimEnd() === ref) {
        const oid = line.slice(0, space);
        return HEX_OID_RE.test(oid) ? oid : undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Async compatibility wrapper; the default resolver uses the sync metadata path. */
export async function readHeadCommitFromFiles(root: string): Promise<string | undefined> {
  return readHeadCommitFromFilesSync(root);
}

/**
 * The commit a measurement root's HEAD points at, or null when the root is not the TOP
 * LEVEL of a git checkout. A non-git root, a root with no commit yet, and a root that is a
 * subdirectory of a larger repository all return null and keep the working-tree
 * measurement: every committed read below addresses paths relative to the repository top
 * level, so a subdirectory root would silently read the wrong objects.
 */
export async function resolveMeasurementCommit(root: string, git: GitRunner = defaultGitRunner): Promise<string | null> {
  // The in-process read is the DEFAULT runner's fast path only (WI-6554700010008489): an
  // injected runner is a test double or a deliberate route and keeps exact git semantics.
  if (git === defaultGitRunner) {
    const fromFiles = readHeadCommitFromFilesSync(root);
    if (fromFiles !== undefined) return fromFiles;
  }
  try {
    const [top, commit] = (await git(root, ['rev-parse', '--show-toplevel', 'HEAD^{commit}'])).trim().split('\n');
    if (!top || !commit || !COMMIT_RE.test(commit)) return null;
    const [realTop, realRoot] = await Promise.all([realpath(top), realpath(root)]);
    return realTop === realRoot ? commit : null;
  } catch {
    return null;
  }
}

/**
 * Binary-safe `git cat-file --batch`: one process for every id. An enabled
 * offload route must fail explicitly rather than fork from the operator on a
 * sidecar timeout (EI-25372596942307171). The local route is disabled-mode only.
 */
export const defaultBlobBatchReader: BlobBatchReader = async (repoDir, blobIds, onRoute, onSpawnBoundary) => {
  const stdin = `${blobIds.join('\n')}\n`;
  if (gitSidecarEnabled('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR')) {
    onRoute?.('sidecar');
    onSpawnBoundary?.({ pid: process.pid, route: 'sidecar' });
    let sidecarResult: GitStdinRunResult;
    try {
      sidecarResult = await runGitStdinViaSpawnerSidecar(
        ['cat-file', '--batch'],
        repoDir,
        stdin,
        BLOB_BATCH_TIMEOUT_MS,
        process.env,
      );
    } catch (error) {
      noteSidecarFallback('committed-tree-reader', error, undefined, 'rejected');
      throw error;
    }
    if (isSidecarInfrastructureFault(sidecarResult)) {
      const error = Object.assign(new Error(sidecarResult.stderr), sidecarResult.error);
      noteSidecarFallback('committed-tree-reader', error, undefined, 'rejected');
      throw error;
    }
    if (sidecarResult.code !== 0) {
      const why = sidecarResult.code < 0
        ? sidecarResult.error
          ? `no exit status; code=${sidecarResult.error.code ?? 'none'}, signal=${sidecarResult.error.signal ?? 'none'}, killed=${sidecarResult.error.killed}`
          : 'no exit status'
        : `exit ${sidecarResult.code}`;
      throw Object.assign(new Error(
        `Command failed (${why}): git -C ${repoDir} cat-file --batch\n${sidecarResult.stderr}`,
      ), sidecarResult.error);
    }
    return parseCatFileBatch(sidecarResult.stdout);
  }

  onRoute?.('local');
  onSpawnBoundary?.({ pid: process.pid, route: 'local' });
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['-C', repoDir, 'cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const stderr = createTextCollector(child.stderr);
    const timer = setTimeout(() => child.kill('SIGKILL'), BLOB_BATCH_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Command failed (${signal ?? `exit ${code}`}): git -C ${repoDir} cat-file --batch\n${stderr.text()}`));
        return;
      }
      try {
        resolvePromise(parseCatFileBatch(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(stdin);
  });
};

/** Parse `cat-file --batch` output: `<oid> <type> <size>\n<bytes>\n` or `<oid> missing\n`. */
export function parseCatFileBatch(output: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('cat_file_batch_truncated_header');
    const header = output.subarray(offset, newline).toString('utf8').split(' ');
    offset = newline + 1;
    if (header[1] === 'missing' || header.length < 3) continue;
    const size = Number(header[2]);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > output.length) {
      throw new Error('cat_file_batch_truncated_body');
    }
    if (header[1] === 'blob') blobs.set(header[0]!, Buffer.from(output.subarray(offset, offset + size)));
    offset += size + 1;
  }
  return blobs;
}

function normalizedRepoPath(path: string): string {
  const normalized = posix.normalize(path);
  if (posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    throw new Error(`repo_measurement_path_outside_root:${path}`);
  }
  return normalized;
}

const relativeTo = (repo: string, path: string) => (repo === '.' ? path : path.slice(repo.length + 1));
const repoDir = (root: string, repo: string) => (repo === '.' ? root : posix.join(root, repo));

/** `ls-tree -z` entries keyed by the path relative to the listed repository. */
function parseLsTreeZ(output: string): Map<string, { mode: string; type: string; object: string; size?: number }> {
  const entries = new Map<string, { mode: string; type: string; object: string; size?: number }>();
  // An empty, successful listing proves absence. A damaged reply does not.
  if (output && !output.endsWith('\0')) throw new Error('repo_measurement_invalid_ls_tree:unterminated_record');
  for (const record of output.split('\0').slice(0, -1)) {
    const tab = record.indexOf('\t');
    if (tab < 0 || tab === record.length - 1) throw new Error('repo_measurement_invalid_ls_tree:missing_path');
    const header = /^(040000|100644|100755|120000|160000) +(blob|tree|commit) +([a-f0-9]{40}|[a-f0-9]{64})(?: +([0-9]+|-))?$/.exec(record.slice(0, tab));
    if (!header) throw new Error('repo_measurement_invalid_ls_tree:invalid_header');
    const [, mode, type, object, bytes] = header;
    const expectedType = mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
    if (type !== expectedType) throw new Error('repo_measurement_invalid_ls_tree:invalid_type');
    const size = bytes && bytes !== '-' ? Number(bytes) : undefined;
    if (size !== undefined && !Number.isSafeInteger(size)) throw new Error('repo_measurement_invalid_ls_tree:invalid_size');
    entries.set(record.slice(tab + 1), { mode: mode!, type: type!, object: object!, ...(size === undefined ? {} : { size }) });
  }
  return entries;
}

async function lsTree(
  git: GitRunner,
  dir: string,
  commit: string,
  paths: readonly string[],
  recursive = false,
  includeSizes = false,
  diagnostics?: CommittedTreeDiagnostics,
  repository = '.',
) {
  if (paths.length === 0) return new Map<string, { mode: string; type: string; object: string; size?: number }>();
  const args = ['ls-tree', '-z', ...(includeSizes ? ['-l'] : []), ...(recursive ? ['-r'] : []), commit, '--', ...paths];
  const details = {
    repository: repository.slice(0, 160),
    pathCount: paths.length,
    pathBytes: paths.reduce((total, path) => total + Buffer.byteLength(path, 'utf8'), 0),
    argumentBytes: args.reduce((total, arg) => total + Buffer.byteLength(arg, 'utf8') + 1, 0),
    recursive,
    includeSizes,
  };
  const startedAt = performance.now();
  let output: string;
  try {
    output = await git(dir, args);
  } catch (error) {
    const errorCode = gitErrorCode(error);
    recordLsTree(diagnostics, {
      ...details,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome: 'error',
      failurePhase: 'git',
      ...(errorCode ? { errorCode } : {}),
    });
    throw error;
  }
  const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
  try {
    const entries = parseLsTreeZ(output);
    recordLsTree(diagnostics, { ...details, durationMs, outcome: 'success' });
    return entries;
  } catch (error) {
    const errorCode = gitErrorCode(error);
    recordLsTree(diagnostics, {
      ...details,
      durationMs,
      outcome: 'error',
      failurePhase: 'parse',
      ...(errorCode ? { errorCode } : {}),
    });
    throw error;
  }
}

/**
 * Resolve the repository and commit that own each current checkout boundary under the
 * historical superproject commit. A boundary is a submodule only when that commit records
 * a gitlink there. If it records an ordinary tree (for example, after a submodule was
 * removed), keep resolving paths through the parent repository; stale `.git` metadata in
 * the working tree must not override ownership at the measured commit.
 */
async function resolveRepoCommits(
  root: string,
  commit: string,
  repos: ReadonlySet<string>,
  git: GitRunner,
  exists: (repo: string) => Promise<boolean>,
  diagnostics?: CommittedTreeDiagnostics,
): Promise<Map<string, { repo: string; commit: string }>> {
  const commits = new Map<string, { repo: string; commit: string }>([['.', { repo: '.', commit }]]);
  const parentOf = new Map<string, string>();
  const pending = new Set<string>();
  const enqueue = async (repo: string): Promise<void> => {
    if (commits.has(repo) || pending.has(repo)) return;
    pending.add(repo);
    const parent = await owningRepo(root, repo, exists);
    parentOf.set(repo, parent);
    await enqueue(parent);
  };
  for (const repo of repos) await enqueue(repo);
  while (pending.size > 0) {
    // Resolve every repository whose parent is already resolved, one ls-tree per parent.
    const ready = new Map<string, string[]>();
    for (const repo of pending) {
      const parent = parentOf.get(repo)!;
      if (!commits.has(parent)) continue;
      ready.set(parent, [...(ready.get(parent) ?? []), repo]);
    }
    if (ready.size === 0) throw new Error('committed_tree_repo_cycle');
    for (const [parent, children] of ready) {
      const parentResolution = commits.get(parent)!;
      const entries = await lsTree(
        git,
        repoDir(root, parentResolution.repo),
        parentResolution.commit,
        children.map((child) => relativeTo(parentResolution.repo, child)),
        false,
        false,
        diagnostics,
        parentResolution.repo,
      );
      for (const child of children) {
        const entry = entries.get(relativeTo(parentResolution.repo, child));
        commits.set(
          child,
          entry?.mode === '160000' ? { repo: child, commit: entry.object } : parentResolution,
        );
        pending.delete(child);
      }
    }
  }
  return commits;
}

function rememberDigest(blob: string, content: Buffer): { sha256: string; size: number } {
  const digest = { sha256: createHash('sha256').update(content).digest('hex'), size: content.length };
  if (blobDigests.byBlob.size >= MAX_MEMOIZED_BLOBS) blobDigests.byBlob.clear();
  blobDigests.byBlob.set(blob, digest);
  return digest;
}

/** Where a root-relative path lives at a commit: its owning repository and tree entry. */
export interface CommittedBlobLocation {
  /** Owning repository, root-relative (`.` for the root itself). */
  repo: string;
  /** The commit pinned for the owning repository by the requested superproject commit. */
  commitSha: string;
  /** The tree entry's object id (a blob id for a regular file). */
  object: string;
  mode: string;
  type: string;
  /** Available when a caller requests size admission before payload reads. */
  size?: number;
  /** True only for a regular file (a blob that is not a symlink). */
  isFile: boolean;
}

/**
 * Locate `paths` (root-relative) at superproject commit `commit` WITHOUT reading their
 * bytes: one `ls-tree` per owning repository, plus one per parent for submodule gitlinks.
 * Keys are the normalized paths; a path absent at that commit maps to null. This is the
 * blob-id-only read for callers that compare git object ids (P-019: audit citations),
 * and the first half of `readCommittedFiles`.
 */
export async function locateCommittedBlobs(
  root: string,
  commit: string,
  paths: readonly string[],
  deps: CommittedTreeDeps = {},
  includeSizes = false,
): Promise<Map<string, CommittedBlobLocation | null>> {
  const git = deps.git ?? defaultGitRunner;
  const probeRepo = deps.exists ?? ((repo: string) => hasRepo(root, repo));
  // Sibling files share ancestors. Reuse boundary observations within this read,
  // but recheck on the next read so changes to submodule metadata remain visible.
  const repoProbes = new Map<string, boolean>();
  const exists = async (repo: string): Promise<boolean> => {
    const cached = repoProbes.get(repo);
    if (cached !== undefined) return cached;
    const present = await probeRepo(repo);
    repoProbes.set(repo, present);
    return present;
  };
  const candidateOf = new Map<string, string>();
  for (const normalized of new Set(paths.map(normalizedRepoPath))) {
    candidateOf.set(normalized, await owningRepo(root, normalized, exists));
  }
  const repoCommits = await resolveRepoCommits(root, commit, new Set(candidateOf.values()), git, exists, deps.diagnostics);
  const ownerOf = new Map<string, string>();
  const committedRepos = new Map<string, string>();
  for (const resolution of repoCommits.values()) committedRepos.set(resolution.repo, resolution.commit);
  for (const [path, candidate] of candidateOf) ownerOf.set(path, repoCommits.get(candidate)!.repo);

  const byRepo = new Map<string, string[]>();
  for (const [normalized, repo] of ownerOf) byRepo.set(repo, [...(byRepo.get(repo) ?? []), normalized]);
  const located = new Map<string, CommittedBlobLocation | null>();
  for (const [repo, repoPaths] of byRepo) {
    const repoCommit = committedRepos.get(repo) ?? null;
    if (!repoCommit) {
      for (const path of repoPaths) located.set(path, null);
      continue;
    }
    const entries = await lsTree(
      git,
      repoDir(root, repo),
      repoCommit,
      repoPaths.map((path) => relativeTo(repo, path)),
      false,
      includeSizes,
      deps.diagnostics,
      repo,
    );
    for (const path of repoPaths) {
      const entry = entries.get(relativeTo(repo, path));
      located.set(
        path,
        entry
          ? { repo, commitSha: repoCommit, object: entry.object, mode: entry.mode, type: entry.type,
              ...(entry.size === undefined ? {} : { size: entry.size }), isFile: entry.type === 'blob' && entry.mode !== '120000' }
          : null,
      );
    }
  }
  return located;
}

/**
 * Read `paths` (root-relative) as committed at superproject commit `commit`. A path that
 * does not exist at that commit maps to null; a path that is a tree, gitlink or symlink
 * there throws `repo_measurement_not_file`.
 */
export async function readCommittedFiles(
  root: string,
  commit: string,
  paths: readonly string[],
  deps: CommittedTreeDeps = {},
  limits?: Readonly<RepoFileSetReadLimits>,
): Promise<Map<string, CommittedFile | null>> {
  const readBlobs = deps.readBlobs ?? defaultBlobBatchReader;
  const diagnostics = deps.diagnostics;
  if (diagnostics) diagnostics.reads += 1;
  const declared = [...new Set(paths)];
  const normalizedOf = new Map(declared.map((path) => [path, normalizedRepoPath(path)] as const));
  const locations = await locateCommittedBlobs(root, commit, [...new Set(normalizedOf.values())], deps, Boolean(limits));
  const blobOf = new Map<string, { repo: string; blob: string } | null>();
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  for (const [path, location] of locations) {
    if (!location) {
      blobOf.set(path, null);
    } else if (!location.isFile) {
      throw new Error(`repo_measurement_not_file:${path}`);
    } else {
      if (limits) {
        if (!Number.isSafeInteger(location.size) || location.size! < 0) {
          throw new Error(`repo_measurement_blob_size_unknown:${path}`);
        }
        const size = location.size!;
        if (size > Math.min(limits.maxFileBytes, limits.maxBatchBytes)) {
          throw new Error(`repo_measurement_too_large:${size}>${Math.min(limits.maxFileBytes, limits.maxBatchBytes)}`);
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new Error(`repo_measurement_too_large:${totalBytes}>${limits.maxTotalBytes}`);
        }
        sizes.set(location.object, size);
      }
      blobOf.set(path, { repo: location.repo, blob: location.object });
    }
  }

  const unread = new Map<string, Set<string>>();
  const observed = new Map<string, Set<string>>();
  for (const located of blobOf.values()) {
    if (!located || observed.get(located.repo)?.has(located.blob)) continue;
    observed.set(located.repo, (observed.get(located.repo) ?? new Set()).add(located.blob));
    if (blobDigests.byBlob.has(located.blob)) {
      if (diagnostics) diagnostics.memoHits += 1;
      continue;
    }
    if (diagnostics) diagnostics.memoMisses += 1;
    unread.set(located.repo, (unread.get(located.repo) ?? new Set()).add(located.blob));
  }
  const onSpawnBoundary = diagnostics?.spawnBoundaryRecords
    ? (boundary: BlobBatchSpawnBoundary) => {
        const records = diagnostics.spawnBoundaryRecords!;
        if (records.length >= MAX_SPAWN_BOUNDARY_RECORDS) {
          diagnostics.spawnBoundaryRecordsDropped = (diagnostics.spawnBoundaryRecordsDropped ?? 0) + 1;
          return;
        }
        records.push({
          requestTraceId: diagnostics.requestTraceId ?? null,
          toolName: diagnostics.toolName ?? 'unknown',
          ...boundary,
        });
      }
    : undefined;
  for (const [repo, blobs] of unread) {
    const batches: string[][] = [];
    let batch: string[] = [];
    let batchBytes = 0;
    for (const blob of blobs) {
      const bytes = sizes.get(blob) ?? 0;
      if (limits && batch.length && batchBytes + bytes > limits.maxBatchBytes) {
        batches.push(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(blob);
      batchBytes += bytes;
    }
    if (batch.length) batches.push(batch);
    for (const batch of batches) {
      if (diagnostics) {
        diagnostics.batchAttempts += 1;
        diagnostics.blobsRequested += batch.length;
        if (readBlobs !== defaultBlobBatchReader) diagnostics.batchRoutes.injected += 1;
      }
      try {
        const contents = await (diagnostics && readBlobs === defaultBlobBatchReader
          ? readBlobs(repoDir(root, repo), batch, (route) => { diagnostics.batchRoutes[route] += 1; }, onSpawnBoundary)
          : readBlobs(repoDir(root, repo), batch));
        if (diagnostics) diagnostics.blobsReturned += batch.filter((blob) => contents.has(blob)).length;
        for (const blob of batch) {
          const content = contents.get(blob);
          if (!content) throw new Error(`repo_measurement_blob_missing:${blob}`);
          if (gitBlobId(content) !== blob) throw new Error(`repo_measurement_blob_mismatch:${blob}`);
          if (limits && content.length !== sizes.get(blob)) throw new Error(`repo_measurement_blob_size_mismatch:${blob}`);
          rememberDigest(blob, content);
          if (diagnostics) diagnostics.blobsVerified += 1;
        }
        if (diagnostics) diagnostics.batchSucceeded += 1;
      } catch (error) {
        if (diagnostics) diagnostics.batchFailed += 1;
        throw error;
      }
    }
  }

  const result = new Map<string, CommittedFile | null>();
  for (const [path, normalized] of normalizedOf) {
    const located = blobOf.get(normalized) ?? null;
    if (!located) {
      result.set(path, null);
      continue;
    }
    const digest = blobDigests.byBlob.get(located.blob)!;
    result.set(path, { path, sha256: digest.sha256, gitBlob: located.blob, size: digest.size });
  }
  return result;
}

async function hasRepo(root: string, repo: string): Promise<boolean> {
  const { lstat } = await import('node:fs/promises');
  try {
    await lstat(posix.join(root, repo, '.git'));
    return true;
  } catch {
    return false;
  }
}

const GLOB_SYNTAX_RE = /[*?[\]{}()!+@]/;

/** The static leading directory of a glob (`packages/x/**\/*.ts` -> `packages/x`). */
function globBase(glob: string): string {
  const segments = glob.split('/');
  const fixed: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (GLOB_SYNTAX_RE.test(segment)) break;
    fixed.push(segment);
  }
  return fixed.join('/');
}

/**
 * The base each glob's depth bound is counted from, mirroring fast-glob's task grouping
 * (measured against fast-glob on a fixture tree, committed-tree-reader.test.ts):
 * a STATIC pattern is stat'ed directly and has no depth bound (null); DYNAMIC patterns are
 * grouped by base directory, except that when any of them is rooted at the cwd they all
 * merge into one cwd task, so every dynamic pattern then counts depth from the root ('').
 */
function depthBases(globs: readonly string[]): Map<string, string | null> {
  const dynamic = globs.filter((glob) => GLOB_SYNTAX_RE.test(glob));
  const mergedAtRoot = dynamic.some((glob) => globBase(glob) === '');
  return new Map(globs.map((glob) => [glob, !GLOB_SYNTAX_RE.test(glob) ? null : mergedAtRoot ? '' : globBase(glob)]));
}

/**
 * fast-glob's `deep` bound: a file is listed when it sits directly in the base directory
 * or its parent directory is fewer than `maxDepth` levels below it.
 */
function withinDepth(path: string, base: string | null, maxDepth: number): boolean {
  if (base === null) return true;
  const baseSegments = base === '' ? 0 : base.split('/').length;
  const parentLevel = path.split('/').length - 1 - baseSegments;
  return parentLevel < Math.max(maxDepth, 1);
}

/**
 * Expand source globs against the files committed at `commit` (the commit-side twin of
 * the working-tree fast-glob expansion: dot files included, symlinks not followed, the
 * same depth and match-count bounds). Submodules under a glob's base are descended at
 * the gitlink their parent records.
 */
export async function listCommittedGlobMatches(
  root: string,
  commit: string,
  globs: readonly string[],
  limits: CommittedGlobLimits,
  deps: CommittedTreeDeps = {},
): Promise<string[]> {
  if (globs.length === 0) return [];
  const git = deps.git ?? defaultGitRunner;
  const exists = deps.exists ?? ((repo: string) => hasRepo(root, repo));
  const bases = [...new Set(globs.map(globBase))];
  // A base inside a submodule is listed INSIDE that submodule: a superproject pathspec
  // below a gitlink matches nothing, so resolve each base's owning repository first.
  const candidateOf = new Map<string, string>();
  for (const base of bases) candidateOf.set(base, base === '' ? '.' : await owningRepo(root, `${base}/_`, exists));
  const repoCommits = await resolveRepoCommits(root, commit, new Set(candidateOf.values()), git, exists);
  const ownerOf = new Map<string, string>();
  const committedRepos = new Map<string, string>();
  for (const resolution of repoCommits.values()) committedRepos.set(resolution.repo, resolution.commit);
  for (const [base, candidate] of candidateOf) ownerOf.set(base, repoCommits.get(candidate)!.repo);
  const queue: Array<{ repo: string; commit: string; prefixes: string[] }> = [];
  for (const repo of new Set(ownerOf.values())) {
    const repoCommit = committedRepos.get(repo);
    if (!repoCommit) continue;
    const owned = bases.filter((base) => ownerOf.get(base) === repo);
    const whole = owned.some((base) => base === '' || base === repo);
    queue.push({ repo, commit: repoCommit, prefixes: whole ? [] : owned.map((base) => relativeTo(repo, base)) });
  }
  const listed = new Set<string>();
  // Per repository, what has been listed: 'all' or the listed prefixes. A later, wider
  // request (a gitlink reached from a parent's base) lists only what is not yet covered.
  const listedPrefixes = new Map<string, 'all' | Set<string>>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    const done = listedPrefixes.get(next.repo);
    if (done === 'all') continue;
    const prefixes = next.prefixes.length === 0 ? [] : next.prefixes.filter((prefix) => !done?.has(prefix));
    if (next.prefixes.length > 0 && prefixes.length === 0) continue;
    listedPrefixes.set(next.repo, prefixes.length === 0 ? 'all' : new Set([...(done ?? []), ...prefixes]));
    const args = ['ls-tree', '-z', '-r', next.commit, ...(prefixes.length ? ['--', ...prefixes] : [])];
    const entries = parseLsTreeZ(await git(repoDir(root, next.repo), args));
    for (const [relPath, entry] of entries) {
      const path = next.repo === '.' ? relPath : `${next.repo}/${relPath}`;
      if (entry.mode === '160000') {
        const covered = bases.filter((base) => base === '' || path.startsWith(`${base}/`) || base.startsWith(`${path}/`));
        if (covered.length) {
          queue.push({
            repo: path,
            commit: entry.object,
            prefixes: covered.some((base) => !base.startsWith(`${path}/`)) ? [] : covered.map((base) => relativeTo(path, base)),
          });
        }
      } else if (entry.type === 'blob' && entry.mode !== '120000') {
        listed.add(path);
      }
    }
  }
  const matches = new Set<string>();
  const baseOf = depthBases(globs);
  for (const path of listed) {
    if (globs.some((glob) => minimatch(path, glob, { dot: true }) && withinDepth(path, baseOf.get(glob) ?? null, limits.maxDepth))) {
      matches.add(path);
      if (matches.size > limits.maxMatches) {
        throw new Error(`repo_measurement_too_many_glob_files:${matches.size}>${limits.maxMatches}`);
      }
    }
  }
  return [...matches].sort();
}

/**
 * The commit-side twin of the working-tree file-set fingerprint: same digest, same
 * per-file `{ path, sha256, gitBlob }`, computed from the bytes committed at `commit`.
 */
export async function fingerprintRepoFileSetAtCommit(
  root: string,
  commit: string,
  declaredPaths: readonly string[],
  deps: CommittedTreeDeps = {},
  limits: Readonly<RepoFileSetReadLimits> = REPO_FILE_SET_READ_LIMITS,
): Promise<{ fingerprint: string; files: Array<{ path: string; sha256: string; gitBlob: string }> }> {
  const paths = [...new Set(declaredPaths)].sort();
  const read = await readCommittedFiles(root, commit, paths, deps, limits);
  const files: Array<{ path: string; sha256: string; gitBlob: string }> = [];
  for (const path of paths) {
    const file = read.get(path);
    if (!file) throw new Error(`repo_measurement_absent_at_commit:${path}@${commit.slice(0, 12)}`);
    files.push({ path, sha256: file.sha256, gitBlob: file.gitBlob });
  }
  return { fingerprint: repoFileSetFingerprint(files), files };
}

/** Test seam: forget memoized blob digests. */
export function __resetCommittedBlobDigestsForTest(): void {
  blobDigests.byBlob.clear();
}
