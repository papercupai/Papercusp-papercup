/**
 * Build git_sync_commit_attribution rows for the commits a git-sync scope just made
 * (P-004, deterministic-commit-workitem-attribution-2026-06-22).
 *
 * WI-6554700010018199: the recorder used to hardcode `repo: 'superproject'` and let `ts`
 * default to the time of RECORDING. Git-sync runs once per registered scope, and each
 * submodule is its own scope (harness slug `<top>/<submodule path>`), so every row a
 * submodule scope wrote was a submodule commit labelled as a superproject one, and a
 * commit recorded hours late was dated hours late. Both values are now DERIVED from git:
 * `repo` from the scope directory's own repository, `committedAt` from the commit itself.
 *
 * Pure git reads, no PG: the caller decides which shas are already recorded and persists
 * the result. Never throws on a git failure; a commit it cannot read is skipped.
 */
import { relative, sep } from 'node:path';
import type { GitRunner } from '../docs/subject-ref';
import { parsePapercuspTrailers, type CommitAttributionRow } from '../../edit-attribution';

/** The value `repo` takes for a commit in the top-level repository. */
export const SUPERPROJECT_REPO = 'superproject';

/** How many commits back from HEAD one recording pass reads. */
export const ATTRIBUTION_LOG_DEPTH = 50;

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

export interface BuildCommitAttributionRowsInput {
  workspaceId: string;
  harnessSlug: string;
  /** The scope's working directory (the registered project path for the slug). */
  repoRoot: string;
  runGit: GitRunner;
  /** Returns the subset of `shas` that already have rows, so a re-run is idempotent. */
  recordedShas: (shas: string[]) => Promise<Set<string>>;
  /** Defaults to {@link ATTRIBUTION_LOG_DEPTH}. */
  logDepth?: number;
}

/**
 * Read the last `logDepth` commits of the scope, keep the ones carrying Papercusp
 * attribution trailers that are not yet recorded, and return one row per
 * (changed file × work-item) — honest multiplicity (D-003). File paths are relative to
 * the commit's own repository, matching `repo`.
 */
export async function buildCommitAttributionRows(
  input: BuildCommitAttributionRowsInput,
): Promise<CommitAttributionRow[]> {
  const { workspaceId, harnessSlug, repoRoot, runGit } = input;
  const repo = await resolveAttributionRepo(repoRoot, runGit);
  if (!repo) return [];

  const logRes = await runGit(['log', '-n', String(input.logDepth ?? ATTRIBUTION_LOG_DEPTH), '--format=%H'], repoRoot);
  if (logRes.code !== 0) return [];
  const shas = logRes.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (shas.length === 0) return [];

  const seen = await input.recordedShas(shas);
  const rows: CommitAttributionRow[] = [];
  for (const sha of shas) {
    if (seen.has(sha)) continue;
    // First line: committer date (strict ISO 8601); the rest: the full message.
    const showRes = await runGit(['show', '-s', '--format=%cI%n%B', sha], repoRoot);
    if (showRes.code !== 0) continue;
    const newline = showRes.stdout.indexOf('\n');
    const committedAt = (newline === -1 ? showRes.stdout : showRes.stdout.slice(0, newline)).trim() || undefined;
    const body = newline === -1 ? '' : showRes.stdout.slice(newline + 1);
    const t = parsePapercuspTrailers(body);
    // Only OUR attributed git-sync commits carry these — skip everything else.
    if (!t.agent && t.workItems.length === 0) continue;
    const filesRes = await runGit(['show', '--name-only', '--format=', sha], repoRoot);
    if (filesRes.code !== 0) continue;
    const files = filesRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const file of files) {
      const base: CommitAttributionRow = {
        workspaceId,
        harnessSlug,
        repo,
        commitSha: sha,
        file,
        agentId: t.agent,
        sessionId: t.sessionId,
        planSlug: t.planSlug,
        committedAt,
      };
      if (t.workItems.length === 0) {
        rows.push(base);
      } else {
        for (const wi of t.workItems) rows.push({ ...base, workItemId: wi });
      }
    }
  }
  return rows;
}
