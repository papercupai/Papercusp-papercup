/**
 * Item kind 'cleanup' (code-cleanup-campaigns-2026-10-26 P-003, R-3, D-003).
 *
 * A cleanup item is issue-family for routing: it appears in every issue-family kind
 * enumeration through the ONE exported list, ISSUE_FAMILY_ROUTE_KINDS
 * (work-nature/agent-work-predicate.ts). The database copies of that list (trigger
 * functions, views, partial-index predicates) were extended by migration 1590.
 *
 * This module also owns the census that finds hand-maintained copies of the list in
 * source. A copy is the literal issue-family triple ('bug', 'change', 'task') not followed
 * by 'cleanup'. cleanup-item-kind.test.ts ratchets the census against a shrink-only
 * baseline until every copy routes through the shared constant.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ISSUE_FAMILY_ROUTE_KINDS } from '../work-nature/agent-work-predicate';

export const CLEANUP_ITEM_KIND = 'cleanup' as const;
export type CleanupItemKind = typeof CLEANUP_ITEM_KIND;

export function isCleanupKind(kind: string | null | undefined): kind is CleanupItemKind {
  return kind === CLEANUP_ITEM_KIND;
}

/** Compile-time and runtime proof that cleanup is routed with the issue family. */
export const CLEANUP_IS_ISSUE_FAMILY: boolean = (ISSUE_FAMILY_ROUTE_KINDS as readonly string[]).includes(
  CLEANUP_ITEM_KIND,
);

/**
 * The bare three-kind list in any quoting/spacing a source file or SQL text uses, when it is
 * NOT already followed by 'cleanup'. Matches `'bug', 'change', 'task'`, `'bug','change','task'`,
 * `"bug", "change", "task"` and the `::text` cast form pg_get_*def renders.
 */
export const BARE_ISSUE_FAMILY_TRIPLE_RE =
  /(['"])bug\1(?:::text)?,\s*(['"])change\2(?:::text)?,\s*(['"])task\3(?:::text)?(?!(?:::text)?\s*,\s*['"]cleanup['"])/g;

/** Count bare triples in one text, ignoring whole-line `//` and `*` comments. */
export function countBareIssueFamilyTriples(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--')) continue;
    n += line.match(BARE_ISSUE_FAMILY_TRIPLE_RE)?.length ?? 0;
  }
  return n;
}

/** Source roots the census walks, relative to the repo root. */
export const CENSUS_ROOTS: readonly string[] = [
  'packages',
  'apps/operator/app',
  'apps/operator/lib',
  'apps/operator/bin',
  'apps/operator/components',
  'libs/papercusp/packages',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.vitest-tmp', 'sidecar', '.papercusp', '.next']);
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts)$|\/test\/|\/__tests__\//;
/**
 * Generated from a real database, not hand-maintained: the index manifest legitimately keeps
 * the three-kind list in the feature-family `<> ALL` predicates migration 1590 left as is.
 * The DB side is guarded by migration 1590's post-conditions and the test's SQL leg.
 */
const GENERATED_FILES = new Set(['packages/operator-core/lib/db-schema-reference/index-manifest.ts']);

/** Map of repo-relative source file to its count of bare issue-family triples (non-zero only). */
export function censusHardcodedIssueFamilyLists(repoRoot: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith('dist-')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(repoRoot, full).split('\\').join('/');
      if (!SOURCE_RE.test(name) || TEST_RE.test(rel) || GENERATED_FILES.has(rel)) continue;
      const n = countBareIssueFamilyTriples(readFileSync(full, 'utf8'));
      if (n > 0) out[rel] = n;
    }
  };
  for (const root of CENSUS_ROOTS) walk(join(repoRoot, root));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
