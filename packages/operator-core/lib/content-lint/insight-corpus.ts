/**
 * The agent-insights CORPUS SCOPE — the single definition of "which files are
 * agent-insight docs", shared by every lint that walks them
 * (unified-agent-state-plane-2026-07-27 P-022).
 *
 * Extracted when the corpus grew a SECOND lint (`check-insight-normative.mjs`
 * alongside `check-insight-citations.mjs`). Two scripts each carrying their own
 * copy of the prefix + extension + exclusion rules is precisely the "drifting
 * duplicate" registry.ts warns about: the moment one adds an exclusion the
 * other does not, the lints silently disagree about what the corpus IS, and a
 * doc can pass one gate while being invisible to the next.
 *
 * Deliberately dependency-light (no fs, no git, no MDX compiler) so a thin
 * `.mjs` walker can import it without dragging in registry.ts's detector
 * dependencies.
 */

/** Repo-relative prefix of the agent-insights corpus. */
export const INSIGHT_DOCS_PREFIX = 'apps/operator-docs/src/content/docs/agent-insights/';

/**
 * Shared exclusions — retired trees, vendored code, build output. Mirrors
 * `isExcludedPath` in registry.ts (kept as its own copy here only to preserve
 * this module's zero-dependency property; both encode the same rule).
 */
const isExcluded = (f: string): boolean =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/');

/**
 * True for a repo-relative path that is an agent-insight doc.
 *
 * NOTE the extension check covers BOTH `.mdx` and `.md`: the corpus is
 * overwhelmingly `.mdx` (620 of 625 at the 2026-07-27 sweep) and a glob written
 * as `*.md` alone silently misses ~99% of it.
 */
export function isInsightDoc(file: string): boolean {
  if (!file.startsWith(INSIGHT_DOCS_PREFIX)) return false;
  if (!file.endsWith('.mdx') && !file.endsWith('.md')) return false;
  return !isExcluded(file);
}

/** Repo-relative prefix of the WHOLE operator-docs corpus (every section, agent-insights included). */
export const OPERATOR_DOCS_PREFIX = 'apps/operator-docs/src/content/docs/';

/**
 * True for a repo-relative path that is ANY operator-docs page, whatever its section.
 *
 * `documents:` frontmatter is a corpus-wide drift anchor: reference/, agent-spawning/,
 * privacy/, spec/ … cite repo paths exactly as agent-insights/ does. So the CITATION lint
 * scopes to this, not to `isInsightDoc` (WI-6554700010008908: 11 stale citations in 8
 * non-insight docs accumulated unflagged while that lint scanned agent-insights/ only).
 * Insight-only concepts (the normative classification) keep `isInsightDoc`.
 */
export function isOperatorDoc(file: string): boolean {
  if (!file.startsWith(OPERATOR_DOCS_PREFIX)) return false;
  if (!file.endsWith('.mdx') && !file.endsWith('.md')) return false;
  return !isExcluded(file);
}
