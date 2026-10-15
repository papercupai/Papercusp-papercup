#!/usr/bin/env node
/**
 * check-shell-syntax.mjs — fail-loud guard for a syntactically BROKEN tracked
 * `.sh` script (EI-13192).
 *
 * A corrupted shell script — e.g. a concurrent shared-tree edit interleave
 * that duplicates/truncates lines mid-file — is a HARD `bash -n` parse
 * failure. This caught the ~475-duplicated-line corruption of
 * papercusp-desktop/bin/build-windows-on-vm.sh only after `git status` looked
 * clean and git-sync had already committed it (EI-13192).
 *
 *   node scripts/check-shell-syntax.mjs
 *
 * D-003 (git-sync-content-guard): the pure detector (a real `bash -n`, not a
 * regex) lives in ONE importable module shared by this CI lint and the
 * git-sync content guard — the two can never disagree. Run via `tsx`
 * (package.json `lint:shell-syntax`) so this .mjs can import the TS module.
 *
 * Scope: tracked `.sh`. Excludes _retired/, node_modules, dist.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Node 25 (the repository's pinned runtime) can strip types from an explicit
// `.ts` import. Keep the extension here: plain `node scripts/check-shell-syntax.mjs`
// is the documented/shebang entrypoint, and Node's ESM resolver never guesses
// `.ts` for an extensionless specifier (the old import died before scanning).
import {
  findShellSyntaxError,
  ShellSyntaxCheckUnavailableError,
} from '../packages/operator-core/lib/content-lint/shell-syntax.ts';
import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

export { findShellSyntaxError };

// The detector's 5s default bounds git-sync's tick. This CI lint has no tick to
// protect, and under gate load `bash -n` on one script has exceeded 5s
// (WI-10008204), so it allows longer per file before calling a file unverified.
const CLI_BASH_TIMEOUT_MS = 20_000;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const isExcluded = (f) =>
  f.startsWith('_retired/') || f.includes('/_retired/') || f.includes('/node_modules/') || f.includes('/dist/');

function main() {
  // Explicit repo-relative paths (`node scripts/check-shell-syntax.mjs a.sh b.sh`)
  // narrow the scan to just those files. The entrypoint test uses this to prove
  // the plain-Node import resolves without paying for a whole-tree scan, which
  // ran past its 30s spawn timeout under gate load (WI-10004913). With no
  // arguments the guard scans the whole tree as before.
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  // WI-6730: enumerate via the shared helper, which recurses into submodules. A
  // bare `git ls-files` does not — it emits one gitlink entry per submodule — so
  // this guard never parsed a single .sh inside any of the 39, and printed ✓
  // regardless. `unscanned` is reported below rather than silently dropped.
  const { files: tracked, unscanned } =
    explicit.length > 0 ? { files: explicit, unscanned: [] } : listTrackedFiles(ROOT);

  const offenders = [];
  const unverified = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (!f.endsWith('.sh')) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}/`), 'utf8');
    } catch {
      continue;
    }
    try {
      const hit = findShellSyntaxError(text, { timeoutMs: CLI_BASH_TIMEOUT_MS });
      if (hit) offenders.push(`${f}:${hit.line ?? '?'}  ${hit.reason}`);
    } catch (err) {
      // No verdict (timeout / spawn failure) is NOT a parse failure (WI-10008204).
      if (!(err instanceof ShellSyntaxCheckUnavailableError)) throw err;
      unverified.push(`${f}  ${err.message}`);
    }
  }

  if (offenders.length > 0) {
    console.error('✗ syntactically BROKEN shell script(s) — a hard `bash -n` parse failure:\n');
    for (const o of offenders) console.error('    ' + o);
    console.error(`\n  ${offenders.length} offender(s). See EI-13192.`);
    process.exit(1);
  }

  if (unverified.length > 0) {
    // Exit 2, distinct from 1: these files were NOT shown broken, and they were
    // not shown clean either, so this run must not print the ✓ line.
    console.error('? could not verify shell script(s) — `bash -n` gave no verdict:\n');
    for (const u of unverified) console.error('    ' + u);
    console.error(`\n  ${unverified.length} unverified. Re-run when the host is less loaded. See WI-10008204.`);
    process.exit(2);
  }

  console.log(`✓ every tracked .sh script parses cleanly (bash -n).${describeUnscanned(unscanned)}`);
  process.exit(0);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) main();
