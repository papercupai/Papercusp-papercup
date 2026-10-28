/**
 * Pure GitHub-URL parsing, split out of `clone-github.ts` (WI-6554700010030738).
 *
 * This module must stay free of `node:child_process` and other heavy I/O:
 * sync-resolver read paths (potIntegration.createQuestion) import it to validate a
 * URL, and `no-heavy-io-on-read-path.test.ts` fails any module reachable from the
 * sync-resolver registry that can spawn a subprocess. `clone-github.ts` shells out
 * to `git clone`, so reading the parser from there dragged that into the read path.
 */

/**
 * Accepted GitHub URL shapes:
 *   - https://github.com/<owner>/<repo>
 *   - https://github.com/<owner>/<repo>.git
 *   - git@github.com:<owner>/<repo>
 *   - git@github.com:<owner>/<repo>.git
 *
 * Owner + repo segments are restricted to GitHub's actual rules:
 *   - 1-39 chars
 *   - alphanum, hyphen, underscore, dot
 *   - cannot start/end with separator (we allow it for owner since
 *     GitHub does too in practice; repo regex is strict)
 *
 * Anything else (other hosts, paths with extra segments, query strings,
 * fragments) is rejected to keep this helper exclusively for the
 * GitHub-URL create-harness flow.
 */
const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
const GITHUB_SSH_RE =
  /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;

export interface ParsedGithubUrl {
  owner: string;
  repo: string;
  /** Normalized HTTPS URL we'll actually invoke `git clone` with. */
  cloneUrl: string;
}

export function parseGithubUrl(url: string): ParsedGithubUrl | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let m = GITHUB_HTTPS_RE.exec(trimmed);
  if (!m) m = GITHUB_SSH_RE.exec(trimmed);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  // Final guard: catch a few owner/repo strings the broad regex would
  // accept but GitHub doesn't allow. Owner can't be all dots; repo
  // can't be just '.' or '..'.
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo)) return null;
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
  };
}
