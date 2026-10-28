/**
 * The git-subprocess half of the PR pane's local facts. It runs ONLY inside the
 * `harnessPrs.gitFacts` producer (system:precompute-derived-reads), never on a sync
 * read. ./pr-git-facts.ts is the read side and explains why the two are split.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HarnessPrGitFacts } from './pr-git-facts';

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExecFileP: typeof execFile.__promisify__ | undefined;
const execFileP = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExecFileP ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;

/** `github.com/<owner>/<repo>` (the form parseRemote expects) from an origin URL, or null. */
export function parseGithubOriginRemote(url: string): string | null {
  const m = /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `github.com/${m[1]}/${m[2]}` : null;
}

/**
 * #5: harness projects frequently carry no `remote` in their metadata, which left the
 * PR pane empty. Derive one from the checkout's git origin so the pane works for any
 * harness whose project is a GitHub clone. Best-effort: null when the path is not a
 * git repo or origin is not a GitHub remote.
 */
export async function gitOriginRemote(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], { timeout: 3000 });
    return parseGithubOriginRemote(stdout);
  } catch {
    return null;
  }
}

/** The commit at refs/heads/main, or null when the checkout has no promoted commit. */
export async function readPromotedSha(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: repoDir, timeout: 3000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Both facts for one harness: the producer's `compute`. */
export async function computeHarnessPrGitFacts(ctx: { workspaceId: string; harnessSlug: string }): Promise<HarnessPrGitFacts> {
  const [{ resolveProject }, { projectDirForSlug }] = await Promise.all([
    import('../harness-core'),
    import('../operator-notes'),
  ]);
  const project = await resolveProject(ctx.harnessSlug);
  const projectPath = (project as unknown as { path?: string } | null)?.path ?? '';
  const repoDir = await projectDirForSlug(ctx.harnessSlug, ctx.workspaceId);
  const [originRemote, promotedSha] = await Promise.all([
    projectPath ? gitOriginRemote(projectPath) : Promise.resolve(null),
    repoDir ? readPromotedSha(repoDir) : Promise.resolve(null),
  ]);
  return { originRemote, promotedSha };
}
