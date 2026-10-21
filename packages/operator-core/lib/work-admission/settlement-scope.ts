import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompletionSettlementManifest } from '../coord-lifecycle/records';

// Lazily promisified + memoized, never at module scope (lint:no-eager-execfile-promisify,
// EI-10161): a narrow node:child_process mock reaching this module transitively must not
// crash the importing test file at module-eval time (promisify(undefined)).
type ExecGit = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;
let cachedExec: ExecGit | null = null;
function exec(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  cachedExec ??= promisify(execFile) as unknown as ExecGit;
  return cachedExec(file, args, options);
}

export type SettlementScopeGit = (root: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultGit: SettlementScopeGit = async (root, args) => {
  try {
    const result = await exec('git', ['-C', root, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout: result.stdout.trim() };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout?.trim() ?? '' };
  }
};

type Entry = CompletionSettlementManifest['contentIdentity'][number];

/**
 * The content part of a settlement manifest, expressed in ONE repository's coordinates.
 * Close-time HEAD shas are deliberately absent: they name commits of the checkout the
 * close ran in, which is not the scoped repository when the receipt was rebased.
 */
export interface ScopedSettlementContent {
  repositoryRoot: string;
  normalizedPaths: string[];
  contentIdentity: Array<Omit<Entry, 'headSha' | 'repositoryRoot'> & { repositoryRoot: string }>;
  residualPaths: CompletionSettlementManifest['residualPaths'];
}

/**
 * Re-express a completion settlement manifest in `repositoryRoot`'s coordinates.
 *
 * A fix closed in the canonical superproject records superproject-relative paths
 * under the superproject root, even when the fixing pot's repository is a submodule
 * of it (WI-6554700010018378: apps/slack-asana-bug-drill). Git blob ids are
 * content-addressed, so each identity is equally valid inside the submodule once its
 * path is made submodule-relative. Every consumer that judges delivery in the pot's
 * own repository must read the receipt through this view: a raw `repositoryRoot`
 * equality check silently skips every submodule-hosted harness.
 *
 * Returns the content unchanged when it is already rooted at `repositoryRoot`, the
 * rebased content when `repositoryRoot` is a submodule checkout that owns EVERY entry,
 * and null otherwise (a cross-repository receipt). The submodule relation is verified
 * with git, never inferred from path containment: a plain subdirectory shares its
 * parent's object store and path namespace, so rebasing into it would be wrong.
 */
export async function scopeSettlementManifestToRepository(
  manifest: Pick<CompletionSettlementManifest, 'repositoryRoot' | 'normalizedPaths' | 'contentIdentity' | 'residualPaths'>,
  repositoryRoot: string,
  git: SettlementScopeGit = defaultGit,
): Promise<ScopedSettlementContent | null> {
  const target = path.resolve(repositoryRoot);
  const rootOf = (entry: Entry) => path.resolve(entry.repositoryRoot ?? manifest.repositoryRoot);
  const prefixes = new Map<string, string>();
  for (const root of new Set(manifest.contentIdentity.map(rootOf))) {
    if (root === target) continue;
    const rel = path.relative(root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    prefixes.set(root, `${rel.split(path.sep).join('/')}/`);
  }
  if (prefixes.size) {
    const [top, parent] = await Promise.all([
      git(target, ['rev-parse', '--show-toplevel']),
      git(target, ['rev-parse', '--show-superproject-working-tree']),
    ]);
    if (top.code !== 0 || parent.code !== 0 || path.resolve(top.stdout) !== target || !parent.stdout) return null;
    const superproject = path.resolve(parent.stdout);
    // Only the direct superproject's receipt is rebased; a grand-parent's paths would
    // cross an intermediate repository boundary.
    if ([...prefixes.keys()].some((root) => root !== superproject)) return null;
  }
  const scope = (entry: Entry): ScopedSettlementContent['contentIdentity'][number] | null => {
    const { headSha: _closeHead, repositoryRoot: _root, ...rest } = entry;
    const prefix = prefixes.get(rootOf(entry));
    if (prefix === undefined) return { ...rest, repositoryRoot: target };
    if (!entry.path.startsWith(prefix) || entry.path.length === prefix.length) return null;
    return { ...rest, path: entry.path.slice(prefix.length), repositoryRoot: target };
  };
  const contentIdentity: ScopedSettlementContent['contentIdentity'] = [];
  const renamed = new Map<string, string>();
  for (const entry of manifest.contentIdentity) {
    const scoped = scope(entry);
    if (!scoped) return null;
    contentIdentity.push(scoped);
    if (!renamed.has(entry.path)) renamed.set(entry.path, scoped.path);
  }
  return {
    repositoryRoot: target,
    // A normalized path with no identity stays as-is, so the caller's coverage
    // check still rejects the receipt.
    normalizedPaths: manifest.normalizedPaths.map((p) => renamed.get(p) ?? p),
    contentIdentity,
    residualPaths: manifest.residualPaths,
  };
}
