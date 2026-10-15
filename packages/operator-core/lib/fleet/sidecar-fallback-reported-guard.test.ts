/**
 * Guard test for `scripts/check-sidecar-fallback-reported.mjs`
 * (EI-20281745253229841).
 *
 * The guard blocks the build, so the only thing that makes it trustworthy is
 * proof that it BOTH fires on a real offender and stays quiet on a compliant
 * site. A guard that has never failed is a guard nobody has tested — and a
 * guard that fires on compliant code gets disabled, which is worse than not
 * having one.
 *
 * These cases run against the guard's exported predicate on SYNTHETIC source
 * strings, so nothing in the shared tree is ever mutated (CLAUDE.md's tier-2
 * discipline: the subject is reachable as a pure function, so there is no
 * reason to touch a tracked file to prove falsifiability).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

// prettier-ignore
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs guard, no type declarations by design (same treatment as the sibling live-tree guards). Keep this import on ONE line: TS7016 is reported at the module-specifier, so a multi-line import moves the error off the line @ts-ignore covers.
import { findUnreportedFallbacks, scanTree } from '../../../../scripts/check-sidecar-fallback-reported.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/check-sidecar-fallback-reported.mjs');

/**
 * Measured 2026-08-12: 5,434 eligible tracked .ts files ENUMERATED. The floor sits well
 * under that on purpose — it catches a COLLAPSE of the scan (wrong root, broken
 * `git ls-files`, a submodule boundary), not ordinary census movement.
 *
 * Note this is asserted against `enumerated`, NOT `scanned`. The guard prefilters with
 * `git grep` and only READS the handful of files that mention a sidecar entrypoint, so
 * `scanned` is legitimately ~6 and would make a useless floor. `enumerated` is the number
 * that proves the guard is looking at a repository at all.
 */
const MIN_ENUMERATED = 3_000;

const compliant = `
  if (gitSidecarEnabled('PAPERCUSP_X_SPAWN_SIDECAR')) {
    try {
      return await runGitViaSpawnerSidecar(args, cwd, 1000, process.env);
    } catch (e) {
      noteSidecarFallback('x', e);
    }
  }
  return runGitLocal(args, cwd);
`;

describe('check-sidecar-fallback-reported guard', () => {
  it('is QUIET on a compliant site (no false positive)', () => {
    expect(findUnreportedFallbacks(compliant)).toHaveLength(0);
  });

  it('FIRES on a bare `catch {}` that swallows the fallback entirely', () => {
    const bad = `
      if (gitSidecarEnabled('X')) {
        try {
          const r = await runGitViaSpawnerSidecar(args, root, 5000, process.env);
          return r.code === 0 ? r.stdout : null;
        } catch {
          // silently fall through
        }
      }
      return localFallback();
    `;
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('FIRES on a hand-rolled console.warn that does not route through the reporter', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", "console.warn('sidecar down: ' + e);");
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('FIRES on a private warn-once helper — the idiom that hid the outage', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", 'warnSidecarFallbackOnce(e);');
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
  });

  it('covers the stdin variant too, not just runGitViaSpawnerSidecar', () => {
    const bad = `
      try {
        return await runGitStdinViaSpawnerSidecar(args, cwd, stdin, 1000, process.env);
      } catch (e) {
        console.warn(e);
      }
    `;
    const good = bad.replace('console.warn(e);', "noteSidecarFallback('x', e);");
    expect(findUnreportedFallbacks(bad).length).toBeGreaterThan(0);
    expect(findUnreportedFallbacks(good)).toHaveLength(0);
  });

  it('does not fire on import lines that merely NAME the sidecar entrypoints', () => {
    const importOnly = `
      import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
    `;
    expect(findUnreportedFallbacks(importOnly)).toHaveLength(0);
  });

  it('reports a line number so the failure is actionable', () => {
    const bad = compliant.replace("noteSidecarFallback('x', e);", 'console.warn(e);');
    const [first] = findUnreportedFallbacks(bad);
    expect(first?.line).toBeGreaterThan(0);
    expect(first?.call).toBe('runGitViaSpawnerSidecar');
  });

  it('accepts an injected callback whose production default calls the reporter', () => {
    const source = `
      function run(seams = {}) {
        const report = seams.onFallback ?? ((e: unknown) => noteSidecarFallback('x', e));
        try { return await runGitViaSpawnerSidecar(args, cwd); }
        catch (e) { report(e); }
      }
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(0);
    expect(findUnreportedFallbacks(source.replace('noteSidecarFallback', 'console.warn'))).toHaveLength(1);
  });

  it('accepts a const reporter alias in the governing lexical scope', () => {
    const source = `
      function run() {
        const report = noteSidecarFallback;
        try { return await runGitStdinViaSpawnerSidecar(args, cwd); }
        catch (e) { report('x', e); }
      }
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(0);
    expect(findUnreportedFallbacks(source.replace('const report =', 'let report ='))).toHaveLength(1);
  });

  it('does not trust an unrelated or shadowed callback with the same name', () => {
    const source = `
      const report = noteSidecarFallback;
      function run(report) {
        try { return await runGitViaSpawnerSidecar(args, cwd); }
        catch (e) { report(e); }
      }
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(1);
  });

  it('does not count a reporter after the catch or inside an uncalled callback', () => {
    const source = `
      try { return await runGitViaSpawnerSidecar(args, cwd); }
      catch (e) { const unused = () => noteSidecarFallback('x', e); }
      noteSidecarFallback('other', new Error());
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(1);
  });

  it('recognizes the maintained watchdog callback and detects removal of its default reporter', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'packages/operator-core/lib/release/worktree-coverage-watchdog.ts'), 'utf8');
    expect(findUnreportedFallbacks(source)).toHaveLength(0);
    expect(findUnreportedFallbacks(source.replace("noteSidecarFallback('worktree-coverage', e)", 'console.warn(e)'))).toHaveLength(1);
  });

  // WI-10006774: an injected seam with a sidecar DEFAULT reaches the sidecar through an
  // indirect callee — `(seams.viaSidecar ?? runGitViaSpawnerSidecar)(...)`. The callee is
  // a ParenthesizedExpression, not an Identifier, and the guard used to skip it entirely,
  // so swapping the reporter for console.warn passed. Each shape must be policed exactly
  // like a direct call: FIRE without the reporter, stay QUIET with it.
  it.each([
    ['parenthesized ?? default', '(seams.viaSidecar ?? runGitViaSpawnerSidecar)(args, cwd)'],
    ['parenthesized || default', '(seams.viaSidecar || runGitViaSpawnerSidecar)(args, cwd)'],
    ['ternary branch', '(useLocal ? runLocal : runGitStdinViaSpawnerSidecar)(args, cwd)'],
    ['type-asserted callee', '(runGitViaSpawnerSidecar as typeof runLocal)(args, cwd)'],
    ['const alias of an indirect default', 'viaSidecar(args, cwd)'],
  ])('polices an indirect sidecar callee: %s', (_label, call) => {
    const source = `
      async function run(seams = {}, useLocal = false) {
        const viaSidecar = seams.viaSidecar ?? runGitViaSpawnerSidecar;
        try { return await ${call}; }
        catch (e) { console.warn(e); }
      }
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(1);
    expect(findUnreportedFallbacks(source.replace('console.warn(e)', "noteSidecarFallback('x', e)"))).toHaveLength(0);
  });

  it('does not treat a let-bound or parameter callee as a sidecar call (no false positive)', () => {
    const source = `
      async function run(viaParam) {
        let viaLet = runGitViaSpawnerSidecar;
        viaLet = runLocal;
        try { await viaLet(args, cwd); await viaParam(args, cwd); }
        catch (e) { console.warn(e); }
      }
    `;
    expect(findUnreportedFallbacks(source)).toHaveLength(0);
  });
});

/**
 * The cases above prove the PREDICATE works; they run it over fixtures. That is
 * classified ADVISORY (`logic-test`) by check-lint-guard-reachability.mjs, and
 * deliberately so: a green logic test and a rotting guard are perfectly
 * compatible states — the predicate can be flawless while nothing ever points it
 * at the repository.
 *
 * These cases are what put the guard on a BLOCKING path (WI-38312). Without them
 * the guard shipped enforcing nothing, and the reachability check went red for
 * every agent whose change mapped into @papercusp/operator-core.
 */
describe('sidecar-fallback-reported guard — live verdict over the real tree', () => {
  it('REACHED the tree: the enumeration covered a plausible number of files', () => {
    const { enumerated } = scanTree() as { enumerated: number };
    // Asserted BEFORE the silence below, so a collapsed scan cannot masquerade as
    // a compliant repository.
    expect(enumerated).toBeGreaterThan(MIN_ENUMERATED);
  });

  it('found the call sites it exists to police — the prefilter is not discarding them all', () => {
    // The `git grep` prefilter is the one component that could silently reduce this
    // guard to a no-op while every other assertion stayed green: a broken pattern
    // yields zero candidates, zero violations, and a confident ✓. This is the check
    // that fails when that happens.
    const { considered } = scanTree() as { considered: number };
    expect(considered).toBeGreaterThan(0);
  });

  it('every sidecar-git fallback in the repository reports via noteSidecarFallback()', () => {
    // Executes the guard exactly as the gate does. This invocation is what the
    // reachability taxonomy counts as enforcement, and it is also the honest test:
    // it asserts the SHIPPED entrypoint's verdict, not a re-implementation of it.
    const out = execFileSync('node', [GUARD], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    expect(out).toMatch(/✓ every sidecar-git fallback reports via noteSidecarFallback\(\)/);
  });
});
