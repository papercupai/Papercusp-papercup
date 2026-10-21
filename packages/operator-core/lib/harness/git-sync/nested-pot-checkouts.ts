/**
 * WI-6554700010018602: a registered pot can live INSIDE another pot's checkout as a
 * submodule (the drill app `apps/slack-asana-bug-drill` is both a submodule of the
 * canonical papercusp superproject and the checkout of the `slack-asana-bug-drill`
 * pot). That nested pot runs its own git-sync, which publishes through its own delivery
 * route (a working-copy pot pushes ONLY its fork and delivers through a standing PR).
 *
 * If the enclosing pot's git-sync also treats the directory as an ordinary submodule,
 * it commits, merges and PUSHES the nested pot's work to the submodule's origin — a
 * second publisher that bypasses the nested pot's PR route entirely (measured
 * 2026-10-20: the canonical tick pushed BD004's red + fix commits to upstream staging
 * 37 minutes before the PR merged, so the delivery audit correctly refused the merge).
 *
 * The enclosing pot must leave such a checkout to its owner. This module only DECIDES
 * which paths are nested pot checkouts; run-git-sync applies the decision.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface NestedPotProject {
  slug: string;
  path?: string | null;
}

/** `child` relative to `root` as a POSIX path, or null unless strictly inside it. */
function strictlyInside(root: string, child: string): string | null {
  const rel = relative(resolve(root), resolve(child));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

/**
 * Repo-relative POSIX paths of every OTHER project whose checkout sits strictly inside
 * `repoPath` and which runs its own active git-sync. Two kinds of nested project are NOT
 * returned, because the enclosing pot stays their only publisher and skipping them would
 * strand their commits:
 *  - a nested project with no git-sync of its own;
 *  - this pot's OWN submodule entry, qualified `${slug}/${rel}` by classify-tree
 *    (e.g. `papercusp/libs/papercusp`). Its git-sync install is a commit-only sub-sync
 *    with no delivery route of its own, so treating it as an independent pot left
 *    nobody pushing its origin and froze its gitlink (WI-6554700010018697).
 */
export function nestedPotCheckoutPaths(
  slug: string,
  repoPath: string,
  projects: readonly NestedPotProject[],
  ownGitSyncSlugs: ReadonlySet<string>,
): string[] {
  const out = new Set<string>();
  for (const project of projects) {
    if (project.slug === slug || !project.path || !ownGitSyncSlugs.has(project.slug)) continue;
    const rel = strictlyInside(repoPath, project.path);
    if (!rel || project.slug === `${slug}/${rel}`) continue;
    out.add(rel);
  }
  return [...out].sort();
}

/** True when `path` is one of `roots` or nested under one. */
export function isUnderAnyPath(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

type RunGitLike = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/**
 * The nested checkouts (among `nested`, repo-relative to `repo`) whose HEAD no
 * `refs/remotes/origin/*` ref contains. A checkout that is not present is skipped: there
 * is no moved gitlink to hold. A failed probe counts as unpublished (fail closed — holding
 * a gitlink one more tick is harmless; pinning an unfetchable commit is not).
 */
export async function unpublishedNestedPotCheckouts(
  runGit: RunGitLike,
  repo: string,
  nested: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const path of nested) {
    const dir = join(repo, path);
    if (!existsSync(join(dir, '.git'))) continue;
    const contained = await runGit(
      ['for-each-ref', '--contains', 'HEAD', '--count=1', '--format=%(refname)', 'refs/remotes/origin/'],
      dir,
    ).catch(() => ({ code: 1, stdout: '' }));
    if (contained.code !== 0 || !contained.stdout.trim()) out.push(path);
  }
  return out;
}

export interface ResolveNestedPotCheckoutsDeps {
  loadProjects: () => Promise<readonly NestedPotProject[]>;
  /** Slugs (among `candidates`) with an ACTIVE git-sync routine install. */
  activeGitSyncSlugs: (candidates: readonly string[]) => Promise<ReadonlySet<string>>;
}

/**
 * Resolve the nested pot checkouts for `slug`'s tick. Fails OPEN to `[]` (the
 * pre-WI-6554700010018602 behaviour) when the registry or the routine table cannot be
 * read, and says so through `log`, so an unreadable registry never stops a tick.
 */
export async function resolveNestedPotCheckouts(
  slug: string,
  repoPath: string | null | undefined,
  deps: ResolveNestedPotCheckoutsDeps,
  log: (line: string) => void = () => {},
): Promise<string[]> {
  if (!repoPath) return [];
  try {
    const inside = (await deps.loadProjects()).filter(
      (p) => p.slug !== slug && !!p.path && strictlyInside(repoPath, p.path) !== null,
    );
    if (!inside.length) return [];
    const active = await deps.activeGitSyncSlugs(inside.map((p) => p.slug));
    return nestedPotCheckoutPaths(slug, repoPath, inside, active);
  } catch (err) {
    log(
      `[git-sync] ${slug}: could not resolve nested pot checkouts (${err instanceof Error ? err.message : String(err)}) — treating every submodule as this pot's own this tick`,
    );
    return [];
  }
}
