/**
 * Registered TREE instruments for repo-files evidence (WI-6554700010018633).
 *
 * A repo-files measurement fingerprints a bounded file set. That is a false witness for a
 * test whose subject is a whole repository tree (a shrink-only census): a module planted
 * anywhere under the scanned roots changes the test's verdict without touching any measured
 * file, and the binding keeps reading current. sourceGlobs cannot help: a census scans
 * ~8,600 files (glob cap 128), and the shared tree commits every few minutes, so any
 * tree-id or membership basis would read stale almost always (measured 2026-10-21: 89 of 98
 * commits in 6h touched the census roots).
 *
 * An instrument re-runs the test's own census over the files COMMITTED at the measurement
 * commit and folds a digest of its OUTPUT into the source fingerprint. Unrelated commits
 * leave the output, and so the fingerprint, unchanged; a planted module changes it. The
 * census logic is shared with the test (integrations/provider-census.ts), so the digest
 * describes what the test asserts. A registered key, not caller-supplied code, so the
 * server alone decides what is measured (the same shape as nativeInstrumentKey).
 *
 * Instruments run on committed trees only. A working-tree read refuses: an uncommitted file
 * set is not a basis a later read can reproduce.
 */
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  APP_ROOTS,
  contentVerdictKey,
  isCensusSourcePath,
  providerCensusOutput,
  strictContentKindsAfterAllowance,
  type StrictKind,
} from '../../integrations/provider-census';
import { defaultBlobBatchReader, locateCommittedBlobs, type CommittedTreeDeps } from './committed-tree-reader';
import { defaultGitRunner } from './evidence-measurement-pin';
import { censusSources, inScope as isNotificationSourcePath } from '../../../../../scripts/check-fire-and-forget-classification.mjs';
import {
  KIND_SCAN_ROOTS,
  isKindScanPath,
  kindBranchCensusOutput,
  mayHoldKindBranch,
  reconcileKindBranchFindings,
  scanSourceForKindBranches,
  type KindBranchFinding,
} from '../../plan-types/kind-branch-census';

export const TREE_INSTRUMENT_KEYS = ['provider-specific-census', 'deliverable-kind-branch-census', 'notification-classification-census'] as const;
export const treeInstrumentKeySchema = z.enum(TREE_INSTRUMENT_KEYS);
export type TreeInstrumentKey = z.infer<typeof treeInstrumentKeySchema>;

/** One regular file committed under a scanned root. */
export interface CommittedTreeFile {
  /** Root-relative path. */
  path: string;
  /** Owning repository, root-relative (`.` for the root itself). */
  repo: string;
  blob: string;
  size: number;
}

const MAX_MEMOIZED_VERDICTS = 50_000;
const MAX_MEMOIZED_OUTPUTS = 16;
/** Per cat-file batch; each batch is one git process under its own 15s timeout. */
const MAX_BLOB_BATCH_BYTES = 8 * 1024 * 1024;

const memo = pinModuleState('@papercusp/operator-core.tree-instrument-memo', () => ({
  /** Content verdicts by blob id (plus path for allowance paths); a blob's bytes never change. */
  verdicts: new Map<string, StrictKind[]>(),
  /** Kind-branch findings by [path, blob]: findings carry the path, so the key does too. */
  kindFindings: new Map<string, KindBranchFinding[]>(),
  /** Instrument outputs by [key, root, commit]; a commit's tree never changes. */
  outputs: new Map<string, Promise<unknown>>(),
}));

/** Test seam: forget memoized verdicts and outputs. */
export function __resetTreeInstrumentMemoForTest(): void {
  memo.verdicts.clear();
  memo.kindFindings.clear();
  memo.outputs.clear();
}

/** `ls-tree -z -l` entries: `<mode> <type> <object> <size|->\t<path>`. */
function parseLsTreeLong(output: string): Array<{ mode: string; type: string; object: string; size: number | null; path: string }> {
  const entries: Array<{ mode: string; type: string; object: string; size: number | null; path: string }> = [];
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
    if (!mode || !type || !object) continue;
    entries.push({ mode, type, object, size: size && /^\d+$/.test(size) ? Number(size) : null, path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Every regular file committed under `prefixes` at superproject commit `commit`. A prefix
 * absent at that commit lists nothing (the working-tree walk skips a missing root the same
 * way). The walk descends into directories and follows symlinks, which a committed listing
 * cannot reproduce, so a submodule gitlink or a symlink the census would reach refuses
 * instead of being silently dropped.
 */
export async function listCommittedFilesUnder(
  root: string,
  commit: string,
  prefixes: readonly string[],
  reaches: (path: string) => boolean,
  deps: CommittedTreeDeps = {},
): Promise<CommittedTreeFile[]> {
  const git = deps.git ?? defaultGitRunner;
  const located = await locateCommittedBlobs(root, commit, prefixes, deps);
  const byRepo = new Map<string, { commitSha: string; paths: string[] }>();
  for (const [prefix, location] of located) {
    if (!location) continue;
    if (location.type !== 'tree') throw new Error(`tree_instrument_root_not_directory:${prefix}:${location.type}`);
    const rel = location.repo === '.' ? prefix : prefix.slice(location.repo.length + 1);
    const group = byRepo.get(location.repo) ?? { commitSha: location.commitSha, paths: [] };
    group.paths.push(rel);
    byRepo.set(location.repo, group);
  }
  const files: CommittedTreeFile[] = [];
  for (const [repo, { commitSha, paths }] of byRepo) {
    const dir = repo === '.' ? root : join(root, repo);
    const entries = parseLsTreeLong(await git(dir, ['ls-tree', '-r', '-z', '-l', commitSha, '--', ...paths]));
    for (const entry of entries) {
      const path = repo === '.' ? entry.path : `${repo}/${entry.path}`;
      const descends = reaches(`${path}/_.ts`);
      if (entry.mode === '160000') {
        if (descends) throw new Error(`tree_instrument_nested_submodule_unsupported:${path}`);
        continue;
      }
      if (entry.mode === '120000') {
        if (descends || reaches(path)) throw new Error(`tree_instrument_symlink_unsupported:${path}`);
        continue;
      }
      if (entry.type !== 'blob') continue;
      if (entry.size === null) throw new Error(`tree_instrument_blob_size_unknown:${path}`);
      files.push({ path, repo, blob: entry.object, size: entry.size });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Read `files`' bodies in bounded cat-file batches, one repository at a time. */
async function forEachCommittedBody(
  root: string,
  files: readonly CommittedTreeFile[],
  visit: (file: CommittedTreeFile, body: string) => void,
  deps: CommittedTreeDeps,
): Promise<void> {
  const readBlobs = deps.readBlobs ?? defaultBlobBatchReader;
  const byRepo = new Map<string, CommittedTreeFile[]>();
  for (const file of files) byRepo.set(file.repo, [...(byRepo.get(file.repo) ?? []), file]);
  for (const [repo, repoFiles] of byRepo) {
    const batches: CommittedTreeFile[][] = [];
    let batch: CommittedTreeFile[] = [];
    let bytes = 0;
    for (const file of repoFiles) {
      if (batch.length && bytes + file.size > MAX_BLOB_BATCH_BYTES) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(file);
      bytes += file.size;
    }
    if (batch.length) batches.push(batch);
    for (const group of batches) {
      const contents = await readBlobs(repo === '.' ? root : join(root, repo), [...new Set(group.map((f) => f.blob))]);
      for (const file of group) {
        const content = contents.get(file.blob);
        if (!content) throw new Error(`tree_instrument_blob_missing:${file.blob}`);
        if (content.length !== file.size) throw new Error(`tree_instrument_blob_size_mismatch:${file.blob}`);
        visit(file, content.toString('utf8'));
      }
    }
  }
}

/** The provider-specific census (integrations/provider-census.ts) over a committed tree. */
async function providerCensusAtCommit(root: string, commit: string, deps: CommittedTreeDeps): Promise<unknown> {
  const files = (await listCommittedFilesUnder(root, commit, APP_ROOTS, isCensusSourcePath, deps))
    .filter((file) => isCensusSourcePath(file.path));
  // Verdicts are collected locally first: the shared memo may be cleared while this runs.
  const kinds = new Map<string, StrictKind[]>();
  const unread: CommittedTreeFile[] = [];
  for (const file of files) {
    const known = memo.verdicts.get(contentVerdictKey(file.path, file.blob));
    if (known) kinds.set(file.path, known);
    else unread.push(file);
  }
  await forEachCommittedBody(root, unread, (file, body) => {
    const verdict = strictContentKindsAfterAllowance(file.path, body);
    kinds.set(file.path, verdict);
    if (memo.verdicts.size >= MAX_MEMOIZED_VERDICTS) memo.verdicts.clear();
    memo.verdicts.set(contentVerdictKey(file.path, file.blob), verdict);
  }, deps);
  return providerCensusOutput(files.map((file) => file.path), (path) => kinds.get(path) ?? []);
}

/**
 * The R-7 deliverable-kind branch census (plan-types/kind-branch-census.ts) over a committed
 * tree: the rules plan-verification-profile-boundary.test.ts asserts, line-free, so an edit
 * that moves a baselined site without changing it leaves the output unchanged.
 */
async function kindBranchCensusAtCommit(root: string, commit: string, deps: CommittedTreeDeps): Promise<unknown> {
  const files = (await listCommittedFilesUnder(root, commit, KIND_SCAN_ROOTS, isKindScanPath, deps))
    .filter((file) => isKindScanPath(file.path));
  // Findings are collected locally first: the shared memo may be cleared while this runs.
  const byPath = new Map<string, KindBranchFinding[]>();
  const unread: CommittedTreeFile[] = [];
  for (const file of files) {
    const known = memo.kindFindings.get(`${file.path}\0${file.blob}`);
    if (known) byPath.set(file.path, known);
    else unread.push(file);
  }
  await forEachCommittedBody(root, unread, (file, body) => {
    const found = mayHoldKindBranch(body) ? scanSourceForKindBranches(file.path, body) : [];
    byPath.set(file.path, found);
    if (memo.kindFindings.size >= MAX_MEMOIZED_VERDICTS) memo.kindFindings.clear();
    memo.kindFindings.set(`${file.path}\0${file.blob}`, found);
  }, deps);
  // Same order as the working-tree census (path order), so baseline matching is identical.
  const findings = files.flatMap((file) => byPath.get(file.path) ?? []);
  return kindBranchCensusOutput(reconcileKindBranchFindings(findings));
}

/** Same resolution inputs as scanRepository; package/tsconfig changes can redirect aliases. */
function isNotificationInput(path: string): boolean {
  return isNotificationSourcePath(path)
    || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path)
      && !/(?:^|\/)(?:node_modules|env-sidecars|dist[^/]*|storybook-static|\.papercusp)(?:\/|$)/.test(path);
}

/**
 * Reuse the notification detector over committed bytes, including every gitlink at
 * its parent's pin. The working checkout's index and submodule HEAD are never inputs.
 * Missing repositories/objects and reachable symlinks refuse instead of shrinking
 * the population. This measures classification inputs, never delivery durability.
 */
async function notificationCensusAtCommit(root: string, commit: string, deps: CommittedTreeDeps): Promise<unknown> {
  const git = deps.git ?? defaultGitRunner;
  const pending = [{ repo: '.', commit }];
  const visitedRepos = new Set<string>();
  const files: CommittedTreeFile[] = [];
  const submodules: string[] = [];
  const declared: string[] = [];
  while (pending.length) {
    const next = pending.shift()!;
    const dir = next.repo === '.' ? root : join(root, next.repo);
    if (next.repo !== '.') {
      const available = deps.exists ? await deps.exists(next.repo)
        : await lstat(join(dir, '.git')).then(entry => entry.isFile() || entry.isDirectory(), () => false);
      if (!available) throw new Error(`tree_instrument_submodule_unavailable:${next.repo}`);
    }
    const repoKey = JSON.stringify([await realpath(dir), next.commit]);
    if (visitedRepos.has(repoKey)) throw new Error('tree_instrument_submodule_cycle_or_alias:' + next.repo);
    visitedRepos.add(repoKey);
    const entries = parseLsTreeLong(await git(dir, ['ls-tree', '-r', '-z', '-l', next.commit]));
    if (entries.some(entry => entry.path === '.gitmodules' && entry.type === 'blob')) {
      // Read Git's own parser from this commit, never the working .gitmodules.
      const config = await git(dir, ['config', '--blob', `${next.commit}:.gitmodules`, '--list']);
      for (const line of config.split('\n')) {
        const match = /^submodule\..*\.path=(.*)$/.exec(line);
        if (!match) continue;
        const path = match[1];
        if (!path || posix.isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) {
          throw new Error(`tree_instrument_invalid_submodule_path:${path}`);
        }
        declared.push(next.repo === '.' ? path : `${next.repo}/${path}`);
      }
    }
    for (const entry of entries) {
      const path = next.repo === '.' ? entry.path : `${next.repo}/${entry.path}`;
      if (entry.mode === '160000') {
        submodules.push(path);
        pending.push({ repo: path, commit: entry.object });
      } else if (isNotificationInput(path)) {
        if (entry.mode === '120000') throw new Error(`tree_instrument_symlink_unsupported:${path}`);
        if (entry.type !== 'blob' || entry.size === null) throw new Error(`tree_instrument_blob_size_unknown:${path}`);
        files.push({ path, repo: next.repo, blob: entry.object, size: entry.size });
      }
    }
  }
  const sources: Record<string, string> = {};
  await forEachCommittedBody(root, files.sort((a, b) => a.path.localeCompare(b.path)), (file, body) => {
    sources[file.path] = body;
  }, deps);
  const census = censusSources(sources);
  if (!census.files.length) throw new Error('tree_instrument_empty_notification_population');
  const missingGitlinks = declared.filter(path => !submodules.includes(path));
  return {
    schemaVersion: 1,
    files: census.files.length,
    sites: census.sites.length,
    sourceDigest: createHash('sha256').update(JSON.stringify(census.files)).digest('hex'),
    siteDigest: createHash('sha256').update(JSON.stringify(census.sites)).digest('hex'),
    gaps: [...census.gaps, ...missingGitlinks.map(path => ({ path, kind: 'declared-submodule-without-gitlink' }))],
    declaredSubmodules: declared.sort(),
    submodules: submodules.sort(),
  };
}

const TREE_INSTRUMENTS: Record<TreeInstrumentKey, (root: string, commit: string, deps: CommittedTreeDeps) => Promise<unknown>> = {
  'provider-specific-census': providerCensusAtCommit,
  'deliverable-kind-branch-census': kindBranchCensusAtCommit,
  'notification-classification-census': notificationCensusAtCommit,
};

/**
 * Run instrument `key` over the tree committed at superproject commit `commit` of `root`
 * (a realpath). Memoized per (key, root, commit); a failed run is not memoized.
 */
export function measureTreeInstrumentAtCommit(
  key: TreeInstrumentKey,
  root: string,
  commit: string,
  deps: CommittedTreeDeps = {},
): Promise<unknown> {
  const memoKey = JSON.stringify([key, root, commit]);
  const known = memo.outputs.get(memoKey);
  if (known) return known;
  const run = TREE_INSTRUMENTS[key](root, commit, deps);
  if (memo.outputs.size >= MAX_MEMOIZED_OUTPUTS) memo.outputs.clear();
  memo.outputs.set(memoKey, run);
  run.catch(() => { if (memo.outputs.get(memoKey) === run) memo.outputs.delete(memoKey); });
  return run;
}

/** The source fingerprint of a binding whose subject includes instrument `key`'s output. */
export function foldTreeInstrumentFingerprint(sourceFingerprint: string, key: TreeInstrumentKey, output: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify([sourceFingerprint, key, output])).digest('hex');
  return `sha256-tree-instrument-v1:${digest}`;
}
