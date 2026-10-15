/**
 * RECURRENCE GUARD — WI-10002448: every reader of the work-scope policy cache must PRIME it.
 *
 * `workScopePolicy()` is a SYNCHRONOUS read of a cache that an async refresh fills. An empty
 * cache reads as "not enforced", and `isHarnessInScope` / `classifyForRehome` default their
 * policy argument to that read. So any code path that consults them before the first refresh
 * completes FAILS OPEN: it treats every harness as in scope for roughly the first minute of a
 * process. Measured instances: `readDelegationCounts` reported 52 plans awaiting delegation
 * on a cold read and 51 thereafter (D-014); `work_items:rehome` classified a `calendar` item
 * as in-scope after a :3170 restart while the stored policy excluded it (2026-09-05).
 *
 * The fix is one awaited, memoised `primeWorkScopePolicy()` before the read. It is a no-op
 * under VITEST (the cache IS the fixture there), which is exactly why no behavioural unit test
 * can observe this race — so the guard is structural: a module that READS the cache must also
 * PRIME it (or refresh it, or route through `gateWorkScope`, which primes).
 *
 * Granularity is per FILE, not per call site. That is deliberately coarse: it cannot prove the
 * prime runs before every read, but it makes an unprimed NEW reader impossible to land without
 * either priming or a named, reasoned allowlist entry below.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const POLICY_MODULE = 'work-scope-policy.ts';

/** A sync read of the policy cache: the two defaulting predicates, or the bare cache read. */
const READER = /\b(?:isHarnessInScope|classifyForRehome)\s*\(|\bworkScopePolicy\s*\(\s*\)/;
/** Anything that loads the cache first. `gateWorkScope` awaits the prime itself. */
const PRIMED = /\b(?:primeWorkScopePolicy|refreshPotControlPolicy|gateWorkScope)\b/;

/**
 * Files allowed to read without priming, each with the reason. A legitimate entry passes an
 * EXPLICIT policy it obtained asynchronously, so it never touches the default cache read.
 * Empty today: every reader primes.
 */
const ALLOWLIST: Record<string, string> = {};

// A code identifier cannot appear after masking unless it already exists in
// the source. Keep the full file inventory, but avoid parsing unrelated files.
const POLICY_IDENTIFIER = /workScopePolicy|isHarnessInScope|classifyForRehome/;

function unprimedReaders(files: ReadonlyArray<{ path: string; source: string }>): string[] {
  return files
    .filter(({ source }) => POLICY_IDENTIFIER.test(source))
    .filter(({ path, source }) => {
      const code = stripCommentsAndStrings(source, path);
      return READER.test(code) && !PRIMED.test(code);
    })
    .map(({ path }) => path);
}

function libSources(): Array<{ path: string; source: string }> {
  return (readdirSync(LIB_DIR, { recursive: true }) as string[])
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts') && !/\.test\.ts$/.test(p))
    .filter((p) => !p.split(/[\\/]/).some((seg) => seg === 'node_modules' || seg === 'dist'))
    .map((p) => ({ path: relative(LIB_DIR, join(LIB_DIR, p)), source: readFileSync(join(LIB_DIR, p), 'utf8') }));
}

describe('work-scope policy cache: every reader primes it (WI-10002448)', () => {
  it('CALIBRATION: flags an unprimed reader, passes a primed one, ignores prose mentions', () => {
    const flagged = unprimedReaders([
      { path: 'cold.ts', source: 'export const f = (s: string) => isHarnessInScope(s);' },
      { path: 'cold-rehome.ts', source: 'export const v = classifyForRehome({ harness: h });' },
      { path: 'cold-cache.ts', source: 'export const p = workScopePolicy();' },
      { path: 'comment-separated.ts', source: 'isHarnessInScope /* between name and call */ (scope);' },
      { path: 'interpolation.ts', source: 'const text = `${workScopePolicy()}`;' },
      { path: 'primed.ts', source: 'await primeWorkScopePolicy();\nexport const ok = isHarnessInScope(s);' },
      { path: 'gated.ts', source: 'const v = await gateWorkScope(site, subj); workScopePolicy();' },
      { path: 'prose.ts', source: '// isHarnessInScope(x) fails open\nconst m = "call isHarnessInScope(s)";' },
    ]);
    // If the helper stopped stripping, `prose.ts` would appear here and this would fail —
    // that is the property that keeps the WI-10002448 comments in the fixed files from
    // self-matching.
    expect(flagged).toEqual(['cold.ts', 'cold-rehome.ts', 'cold-cache.ts', 'comment-separated.ts', 'interpolation.ts']);
  });

  it('NON-VACUOUS: the walk reaches the policy module and finds real readers', () => {
    const files = libSources();
    expect(files.some((f) => f.path === POLICY_MODULE)).toBe(true);
    // 6 reader modules measured on 2026-09-22. A drop to ~0 means the walker broke, not
    // that the codebase stopped reading the policy.
    const readers = files.filter((f) => f.path !== POLICY_MODULE && POLICY_IDENTIFIER.test(f.source) && READER.test(stripCommentsAndStrings(f.source, f.path)));
    expect(readers.length).toBeGreaterThanOrEqual(3);
  });

  it('no module outside work-scope-policy.ts reads the policy cache without priming it', () => {
    const offenders = unprimedReaders(libSources().filter((f) => f.path !== POLICY_MODULE)).filter(
      (p) => !(p in ALLOWLIST),
    );
    expect(
      offenders,
      'These modules read the work-scope policy cache (isHarnessInScope / classifyForRehome / ' +
        'workScopePolicy()) without priming it, so they FAIL OPEN for ~60s after a process ' +
        'starts. Add `await primeWorkScopePolicy()` before the read (memoised; no-op under ' +
        'VITEST). If the module passes an explicit policy it loaded asynchronously, add it to ' +
        'ALLOWLIST with that reason instead.',
    ).toEqual([]);
  });
});
