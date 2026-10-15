/**
 * Batched argv-mode `git check-ignore` — the one place that knows how to ask Git
 * about many paths in ONE process and map the answer back losslessly.
 *
 * Why argv mode with no `-z`: Git 2.43 rejects `-z` unless `--stdin` is also given
 * (`fatal: -z only makes sense with --stdin`), and the `RunGit` seam has no stdin
 * channel. wholesale-deletion-guard passed `-z` with argv for months; every call
 * exited 128 and the guard silently failed open (WI-6554700010010783). A fake
 * RunGit in its unit test accepted the flag, which is why nothing noticed: the
 * REAL-git tests beside each caller are what pin this now.
 *
 * Why only "verbatim" names are batched: in argv mode Git prints each ignored path
 * on its own line exactly as given, C-quoting only names that hold `"`, `\`, a
 * control character, or (under the default core.quotePath) a non-ASCII byte.
 * Printable-ASCII names without `"`/`\` therefore map back byte-for-byte; every
 * other name is returned as `unresolved` so the caller probes it alone, where the
 * exit status is the whole answer.
 *
 * Why batching matters at all: each Git call waits in bg-host's git admission
 * queue (measured 10-24s per `check-ignore` under load on 2026-10-12/13), so one
 * call per path turned a ~40-path preflight into minutes (WI-6554700010010584).
 */
import type { RunGit } from './run-git-sync';

/** Paths per batched `check-ignore` argv — far below ARG_MAX for repo-relative paths. */
export const CHECK_IGNORE_BATCH_SIZE = 256;

/**
 * True when argv-mode `git check-ignore` prints this path back byte-for-byte:
 * printable ASCII with no `"` or `\` (the only printable characters Git C-quotes).
 */
export function isVerbatimCheckIgnorePath(path: string): boolean {
  return /^[\x20-\x7e]+$/.test(path) && !/["\\]/.test(path);
}

export interface CheckIgnoreBatchResult {
  /** Paths Git reported as ignored, from batches whose answer mapped back. */
  ignored: Set<string>;
  /**
   * Paths with no answer yet: every non-verbatim name, plus every name in a batch
   * that failed or whose output did not map back. Probe these one at a time.
   */
  unresolved: string[];
  /** Batches that exited with something other than 0/1 (a real Git error or a
   *  symlink-descendant pathspec). Their paths are also in `unresolved`. */
  failedBatches: { code: number; stderr: string }[];
}

/**
 * Ask `git check-ignore <flags> -- <paths>` about every verbatim path in batches.
 * Exit 0 = at least one listed path matched, 1 = none matched (an answer, not a
 * failure). `--` keeps leading dashes literal.
 */
export async function checkIgnoreVerbatimBatches(
  runGit: RunGit,
  repoPath: string,
  paths: readonly string[],
  flags: readonly string[] = [],
): Promise<CheckIgnoreBatchResult> {
  const ignored = new Set<string>();
  const unresolved: string[] = [];
  const failedBatches: { code: number; stderr: string }[] = [];
  const verbatim: string[] = [];
  for (const path of paths) (isVerbatimCheckIgnorePath(path) ? verbatim : unresolved).push(path);
  for (let i = 0; i < verbatim.length; i += CHECK_IGNORE_BATCH_SIZE) {
    const chunk = verbatim.slice(i, i + CHECK_IGNORE_BATCH_SIZE);
    const result = await runGit(['check-ignore', ...flags, '--', ...chunk], repoPath);
    if (result.code === 1) continue;
    if (result.code === 0) {
      const asked = new Set(chunk);
      const echoed = result.stdout.split('\n').filter((line) => line !== '');
      if (echoed.every((line) => asked.has(line))) {
        for (const line of echoed) ignored.add(line);
        continue;
      }
    } else {
      failedBatches.push({ code: result.code, stderr: result.stderr });
    }
    unresolved.push(...chunk);
  }
  return { ignored, unresolved, failedBatches };
}
