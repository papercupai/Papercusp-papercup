/**
 * The `repo` label git-sync attribution uses for a repository, derived from git
 * (WI-6554700010018199), and the mapping of run-git-sync's per-install scope labels onto it
 * (WI-6554700010018409).
 *
 * Kept free of PG and edit-ledger imports: run-git-sync labels its per-tick attribution
 * tallies with these helpers, and that module must not pull the database layer in.
 */
import { relative, sep } from 'node:path';
import type { GitRunner } from '../docs/subject-ref';

/** The value `repo` takes for a commit in the top-level repository. */
export const SUPERPROJECT_REPO = 'superproject';

/** Nesting bound for the walk up through superprojects (a cycle is impossible; this is a backstop). */
const MAX_SUPERPROJECT_DEPTH = 8;

/**
 * The `repo` label for commits made in `dir`'s repository: `'superproject'` when that
 * repository is the top level, otherwise its path relative to the top-level superproject
 * (POSIX separators), e.g. `libs/papercusp`. Walks nested submodules to the outermost root
 * so the label matches the scope slug suffix. Returns null when `dir` is not in a git
 * repository.
 */
export async function resolveAttributionRepo(dir: string, runGit: GitRunner): Promise<string | null> {
  const topRes = await runGit(['rev-parse', '--show-toplevel'], dir);
  const repoTop = topRes.code === 0 ? topRes.stdout.trim() : '';
  if (!repoTop) return null;
  let outer = repoTop;
  for (let i = 0; i < MAX_SUPERPROJECT_DEPTH; i++) {
    const sp = await runGit(['rev-parse', '--show-superproject-working-tree'], outer);
    const parent = sp.code === 0 ? sp.stdout.trim() : '';
    if (!parent || parent === outer) break;
    outer = parent;
  }
  if (outer === repoTop) return SUPERPROJECT_REPO;
  const rel = relative(outer, repoTop).split(sep).join('/');
  return rel && !rel.startsWith('..') ? rel : SUPERPROJECT_REPO;
}

/**
 * Map a run-git-sync scope label onto the attribution `repo` label.
 *
 * run-git-sync labels scopes relative to the repository it was pointed at: `'superproject'`
 * for that repository itself and a submodule path for each submodule under it. That is
 * only the attribution label when the install IS the top-level repository. A submodule
 * install (harness slug `<top>/<submodule path>`) syncs a submodule as its own root, so its
 * root scope must be labelled with the install's own attribution repo, and anything under
 * it is prefixed with that path.
 *
 * `installRepo` is {@link resolveAttributionRepo} of the install's directory; null (not
 * resolvable) leaves the scope unchanged.
 */
export function attributionScopeLabel(installRepo: string | null, scope: string): string {
  if (!installRepo || installRepo === SUPERPROJECT_REPO) return scope;
  return scope === SUPERPROJECT_REPO ? installRepo : `${installRepo}/${scope}`;
}
