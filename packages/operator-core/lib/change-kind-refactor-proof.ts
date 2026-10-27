/**
 * The 'refactor' change-kind proof (plan code-cleanup-campaigns-2026-10-26, P-004 / R-4, D-006).
 *
 * A refactor promises unchanged behavior. The 'logic' proof (a passing test run) is not enough:
 * a refactor that edits its own tests to fit would still pass it. So a 'refactor' close must show:
 *
 *   - a passing test_runs row for every covering test file at the landing change's PARENT, and a
 *     passing row for exactly the same file set AT the landing change (clean tree, both sides);
 *   - covering files computed by the gate (coverage map + git), not taken from the agent's
 *     filesChanged — every touched member is covered, and no covering file changed in the landing;
 *   - the targeted finding absent from the detector's output after the change;
 *   - clean typecheck and lint:behavioural-strands.
 *
 * D-006: this proof refuses at close regardless of CHANGE_KIND_GATE_CUTOVER.
 *
 * This module is pure: the facts (rows, git diff, coverage, re-scan) are resolved by an injected
 * resolver (ChangeKindProofDeps.resolveRefactorFacts) so the rules are testable without I/O.
 */
import type { ChangeKindEvidence } from './change-kind-catalog';

/** One test_runs row the close cites, as the resolver read it. */
export interface RefactorRunRow {
  id: number;
  filePath: string;
  commitSha: string | null;
  status: string;
  /** True when the run recorded a dirty working tree, so it did not measure `commitSha` alone. */
  worktreeDirty?: boolean | null;
}

export interface RefactorFactsQuery {
  landingCommit: string;
  beforeRunIds: readonly number[];
  afterRunIds: readonly number[];
  finding: string;
}

/** What the resolver established about the landing change. `null` means it could not tell. */
export interface RefactorFacts {
  /** The landing commit, resolved to a full sha; null when it does not resolve. */
  landingCommit: string | null;
  /** The landing commit's first parent; null when it does not resolve. */
  landingParent: string | null;
  /** Rows found for the cited before-run ids (an id with no row is simply absent). */
  beforeRuns: readonly RefactorRunRow[];
  afterRuns: readonly RefactorRunRow[];
  /** Repo-relative paths the landing change touched (git diff parent..landing). */
  changedFiles: readonly string[] | null;
  /** Source members the landing change touched, each with the test files that cover it. */
  touchedMembers: ReadonlyArray<{ member: string; coveringFiles: readonly string[] }> | null;
  /** Whether the detector still reports the targeted finding after the change. */
  findingStillReported: boolean | null;
  /** Resolver-side failures worth surfacing verbatim (a failed git call, a failed query). */
  errors?: readonly string[];
}

export type RefactorFactsResolver = (query: RefactorFactsQuery) => Promise<RefactorFacts>;

const TYPECHECK_CLEAN_RE = /\bstatus=clean\b|\bexit(?:\s*code)?\s*[=:]?\s*0\b|\b0 errors?\b|\bno (?:type )?errors\b/i;
const TYPECHECK_DIRTY_RE = /\bstatus=(?:partial|dirty|errors?|failed|fail)\b|\bexit(?:\s*code)?\s*[=:]?\s*[1-9]\d*\b|\b[1-9]\d* errors?\b/i;
const STRANDS_CLEAN_RE = /\bexit(?:\s*code)?\s*[=:]?\s*0\b|\bno (?:behavioural )?strands\b|\b0 strands\b/i;
const STRANDS_DIRTY_RE = /\bexit(?:\s*code)?\s*[=:]?\s*[12]\b|\b[1-9]\d* strands?\b|\bnot checked\b/i;
const PASS_STATUS = 'pass';

const sameSha = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b) && (a!.startsWith(b!) || b!.startsWith(a!)) && Math.min(a!.length, b!.length) >= 7;

/** The proof fields a 'refactor' entry must name, before any facts are resolved. */
export function refactorEvidenceGaps(e: Partial<ChangeKindEvidence>): string[] {
  const gaps: string[] = [];
  if (!e.landingCommit?.trim()) gaps.push('`landingCommit` — the sha of the commit that landed the refactor');
  if (!e.beforeRuns?.length) {
    gaps.push("`beforeRuns` — test_runs row ids for the covering test files at the landing change's parent");
  }
  if (!e.afterRuns?.length) gaps.push('`afterRuns` — test_runs row ids for the same test files at the landing change');
  if (!e.finding?.trim()) gaps.push('`finding` — the targeted finding (for example the clone-family key) the refactor removes');
  const typecheck = e.typecheck?.trim();
  if (!typecheck) {
    gaps.push('`typecheck` — the lint:tsc result for the changed files');
  } else if (TYPECHECK_DIRTY_RE.test(typecheck) || !TYPECHECK_CLEAN_RE.test(typecheck)) {
    gaps.push(`\`typecheck\` is not clean ("${typecheck.slice(0, 120)}") — a refactor needs a clean typecheck`);
  }
  const strands = e.behaviouralStrands?.trim();
  if (!strands) {
    gaps.push('`behaviouralStrands` — the lint:behavioural-strands result (exit 0)');
  } else if (STRANDS_DIRTY_RE.test(strands) || !STRANDS_CLEAN_RE.test(strands)) {
    gaps.push(`\`behaviouralStrands\` is not clean ("${strands.slice(0, 120)}") — it must report exit 0 with no strands`);
  }
  return gaps;
}

function runSideGaps(
  side: 'before' | 'after',
  citedIds: readonly number[],
  rows: readonly RefactorRunRow[],
  expectedSha: string | null,
): string[] {
  const gaps: string[] = [];
  const where = side === 'before' ? "the landing change's parent" : 'the landing change';
  const byId = new Map(rows.map((r) => [r.id, r]));
  const absent = citedIds.filter((id) => !byId.has(id));
  if (absent.length) gaps.push(`${side}-run row(s) ${absent.join(', ')} not found in test_runs`);
  for (const row of rows) {
    if (row.status !== PASS_STATUS) gaps.push(`${side}-run ${row.id} (${row.filePath}) has status '${row.status}', not '${PASS_STATUS}'`);
    if (!sameSha(row.commitSha, expectedSha)) {
      gaps.push(
        `${side}-run ${row.id} (${row.filePath}) ran at ${row.commitSha ?? 'an unrecorded commit'}, not at ${where} ` +
          `(${expectedSha ?? 'unresolved'})`,
      );
    } else if (row.worktreeDirty) {
      gaps.push(`${side}-run ${row.id} (${row.filePath}) ran on a dirty tree, so it did not measure ${where} alone`);
    }
  }
  return gaps;
}

/**
 * Every reason the resolved facts do not prove behavior preservation. Empty means the proof holds.
 * Pure: the caller resolves `facts` for `e` first.
 */
export function refactorFactGaps(e: Partial<ChangeKindEvidence>, facts: RefactorFacts): string[] {
  const gaps: string[] = [...(facts.errors ?? []).map((err) => `the refactor proof could not be resolved: ${err}`)];
  if (!facts.landingCommit) gaps.push(`the landing commit '${e.landingCommit ?? ''}' does not resolve in the repository`);
  if (!facts.landingParent) gaps.push("the landing commit's parent could not be resolved");

  gaps.push(...runSideGaps('before', e.beforeRuns ?? [], facts.beforeRuns, facts.landingParent));
  gaps.push(...runSideGaps('after', e.afterRuns ?? [], facts.afterRuns, facts.landingCommit));

  const beforeFiles = new Set(facts.beforeRuns.map((r) => r.filePath));
  const afterFiles = new Set(facts.afterRuns.map((r) => r.filePath));
  const onlyBefore = [...beforeFiles].filter((f) => !afterFiles.has(f));
  const onlyAfter = [...afterFiles].filter((f) => !beforeFiles.has(f));
  if (onlyBefore.length || onlyAfter.length) {
    gaps.push(
      'the before and after runs cover different test sets' +
        (onlyBefore.length ? ` (only before: ${onlyBefore.join(', ')})` : '') +
        (onlyAfter.length ? ` (only after: ${onlyAfter.join(', ')})` : ''),
    );
  }

  if (facts.touchedMembers === null) {
    gaps.push('the coverage map could not say which members the landing change touched');
  } else if (facts.touchedMembers.length === 0) {
    gaps.push('the landing change touched no source member the coverage map knows, so nothing shows the refactor is covered');
  } else {
    const covering = new Set<string>();
    for (const m of facts.touchedMembers) {
      if (m.coveringFiles.length === 0) gaps.push(`touched member ${m.member} has no covering test`);
      for (const f of m.coveringFiles) covering.add(f);
    }
    const unrun = [...covering].filter((f) => !beforeFiles.has(f) || !afterFiles.has(f));
    if (unrun.length) gaps.push(`covering test file(s) without a cited before and after run: ${unrun.join(', ')}`);
  }

  if (facts.changedFiles === null) {
    gaps.push('the files changed by the landing change could not be read from git');
  } else {
    const changed = new Set(facts.changedFiles);
    const coveringFiles = new Set<string>([...beforeFiles, ...afterFiles]);
    for (const m of facts.touchedMembers ?? []) for (const f of m.coveringFiles) coveringFiles.add(f);
    const edited = [...coveringFiles].filter((f) => changed.has(f));
    if (edited.length) gaps.push(`covering test file(s) changed in the landing change: ${edited.join(', ')}`);
  }

  if (facts.findingStillReported === null) {
    gaps.push(`the detector could not re-scan for the targeted finding '${e.finding ?? ''}' after the change`);
  } else if (facts.findingStillReported) {
    gaps.push(`the targeted finding '${e.finding ?? ''}' is still reported after the change`);
  }
  return gaps;
}

/** The full 'refactor' check: required fields, then resolved facts. Fails closed without a resolver. */
export async function missingRefactorProof(
  e: Partial<ChangeKindEvidence>,
  resolve: RefactorFactsResolver | undefined,
): Promise<string[]> {
  const gaps = refactorEvidenceGaps(e);
  if (!e.landingCommit?.trim() || !e.beforeRuns?.length || !e.afterRuns?.length || !e.finding?.trim()) return gaps;
  if (!resolve) {
    return [...gaps, 'the refactor proof resolver is unavailable here, so the before/after runs, coverage and re-scan cannot be checked'];
  }
  let facts: RefactorFacts;
  try {
    facts = await resolve({
      landingCommit: e.landingCommit.trim(),
      beforeRunIds: e.beforeRuns,
      afterRunIds: e.afterRuns,
      finding: e.finding.trim(),
    });
  } catch (err) {
    return [...gaps, `the refactor proof could not be resolved: ${err instanceof Error ? err.message : String(err)}`];
  }
  return [...gaps, ...refactorFactGaps(e, facts)];
}
