/**
 * Shipped-evidence trackedness (plan mdenseon-adoption-measurements-2026-10-01,
 * acceptance criterion R-8). Final evidence is reproducible only when every
 * manifest it cites is tracked by git in the repository that OWNS the file.
 * A local-only (untracked, ignored or out-of-repo) manifest passes every
 * fingerprint check on the author's machine and vanishes for everyone else.
 *
 * Ownership is resolved from the file's own directory, so a path inside a
 * submodule (e.g. libs/generic/memory/src/...) is checked INSIDE that
 * submodule. Asking the superproject instead reports a false "untracked",
 * because the superproject only tracks the submodule's gitlink.
 *
 * CLI: npx tsx packages/operator-core/lib/memory/bench/tracked-evidence.ts <manifest>...
 * exits 0 only when every named manifest is tracked.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isCliEntry } from '../../util/cli-entry';

export interface TrackedEvidence {
  /** Real path of the manifest. */
  path: string;
  /** Top level of the innermost repository that owns it. */
  repoRoot: string;
  /** Path relative to that repository, POSIX separators. */
  repoRelative: string;
}

/** Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (set inside git hooks)
 * would override `-C` and answer about a different repository. */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** The tracked identity of `file`, or null when it is missing, not a regular
 * file, outside any repository, or not in its owning repository's index. */
export function trackedEvidence(file: string): TrackedEvidence | null {
  let real: string;
  try {
    real = fs.realpathSync(path.resolve(file));
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(git(path.dirname(real), ['rev-parse', '--show-toplevel']));
  } catch {
    return null;
  }
  const repoRelative = path.relative(repoRoot, real).split(path.sep).join('/');
  if (!repoRelative || repoRelative.startsWith('../')) return null;
  try {
    git(repoRoot, ['ls-files', '--error-unmatch', '--', repoRelative]);
  } catch {
    return null;
  }
  return { path: real, repoRoot, repoRelative };
}

/** Refuse an evidence set that cites nothing or cites any manifest that is not
 * tracked; the error names every offending path, not just the first. */
export function assertTrackedEvidence(files: readonly string[]): TrackedEvidence[] {
  if (!files.length) throw new Error('no evidence manifests cited');
  const tracked: TrackedEvidence[] = [];
  const untracked: string[] = [];
  for (const file of files) {
    const t = trackedEvidence(file);
    if (t) tracked.push(t);
    else untracked.push(file);
  }
  if (untracked.length) throw new Error(`untracked shipped evidence: ${untracked.join(', ')}`);
  return tracked;
}

if (isCliEntry(import.meta.url)) {
  try {
    for (const t of assertTrackedEvidence(process.argv.slice(2))) console.log(`tracked\t${t.repoRoot}\t${t.repoRelative}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
