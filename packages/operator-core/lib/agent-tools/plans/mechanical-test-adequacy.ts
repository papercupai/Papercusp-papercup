/**
 * Mechanical test adequacy (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-003 / R-3).
 *
 * WHY. A spec clause projected from a requirement whose verification is
 * `check: { kind: 'tests', files: [...] }` already names the exact proof. Before this module the
 * completion gate still graded such a clause against nine judgment criteria and then demanded a
 * per-clause judge card (a `spec-test-adequacy` scorecard plus its independent grading audit).
 * Most of those criteria read binder-authored booleans (layer, oracle independence, fixture
 * absence), so the card was paperwork restating what the ledger already measures.
 *
 * WHAT. For a test-checked clause, adequacy is decided from server-owned facts only:
 *  1. every test file the requirement names has a bound, ledger-backed `test` row whose run
 *     PASSED (passed > 0, failed = 0, no collection failure) — the rows P-002's autobind keeps;
 *  2. at least one bound mutant from `scripts/mutation-probe.sh` was CAUGHT by one of those
 *     files, with the evaluator's own causal linkage (`hasLinkedMutationBaseline`: same probe
 *     invocation, a passing calibration leg, the mutated subject inside the measured sources);
 *  3. every qualifying row is CURRENT: `listSpecEvidence` server-measures each row's repo-files
 *     fingerprints on every read, so an edit to a named test or a measured source file makes the
 *     row stale and the verdict fails until fresh proof is bound. No re-check is scheduled; the
 *     check runs on every read.
 *
 * No judge card is requested on either verdict. A failing verdict names the missing proof.
 * A clause whose source BAR has another check kind, or whose pin cannot be resolved, is not
 * applicable here and keeps the evaluator + scorecard path.
 */
import { hasLinkedMutationBaseline, latestLogicalEvidence, type SpecEvidenceForAdequacy } from './spec-test-adequacy';
import { hasMatchingDeclaredCaseTitle } from './spec-evidence-store';
import type { SourceBarTestRequirements } from './source-bar-test-requirements';
import { CALIBRATION_LEGS } from '@papercusp/test-config/mutation-descriptor';
import { isRecordedCaseTitle, MAX_RECORDED_PASSED_CASES } from '@papercusp/test-config/execution-details';

export interface MechanicalAdequacyClause {
  planSlug: string;
  specId: string;
  revision: number;
  /** When given, only rows bound to this exact clause content count. */
  contentHash?: string;
}

export type MechanicalTestAdequacy =
  | { applicable: false }
  | {
      applicable: true;
      verdict: 'pass' | 'fail';
      requiredFiles: string[];
      /** Per named file, the binding id of its current passing run (absent when none). */
      passingTestBindingIds: Record<string, number>;
      /** Binding ids of current, causally linked mutants caught by a named file. */
      caughtMutantBindingIds: number[];
      /** Why the verdict is not `pass`; empty on a pass. */
      gaps: string[];
    };

export function normalizeTestPath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

function rowTestFile(row: SpecEvidenceForAdequacy): string | null {
  const path = row.testRunProvenance?.filePath ?? row.testRunExecution?.filePath ?? null;
  return path ? normalizeTestPath(path) : null;
}

function isWithdrawn(row: SpecEvidenceForAdequacy): boolean {
  return Boolean((row as { withdrawal?: unknown }).withdrawal);
}

function staleDetail(row: SpecEvidenceForAdequacy): string {
  const reasons = row.currentness.overall === 'stale' ? row.currentness.staleReasons : row.currentness.unknownReasons;
  return `${row.currentness.overall}${reasons.length ? ` (${reasons.join(', ')})` : ''}`;
}

function isPassingLedgerRun(row: SpecEvidenceForAdequacy): boolean {
  const execution = row.testRunExecution;
  const rawCases = (row.details.adequacy as { testCases?: unknown } | undefined)?.testCases;
  if (rawCases !== undefined && (!Array.isArray(rawCases) ||
    rawCases.length > MAX_RECORDED_PASSED_CASES || !rawCases.every(isRecordedCaseTitle) ||
    new Set(rawCases).size !== rawCases.length)) return false;
  const declaredCases = rawCases as string[] | undefined;
  // Focused runners count outside-filter cases as skipped. A declaration only
  // narrows the claim when the canonical ledger confirms every named case.
  const declaredCasesPassed = declaredCases !== undefined && declaredCases.length > 0 &&
    declaredCases.every(title => hasMatchingDeclaredCaseTitle(title, execution?.passedCaseTitles ?? []));
  if (declaredCases?.length && !declaredCasesPassed) return false;
  return (
    execution != null &&
    execution.status === 'pass' &&
    execution.passed > 0 &&
    execution.failed === 0 &&
    (execution.skipped === 0 || declaredCasesPassed) &&
    execution.collectionFailed === false
  );
}

function isOriginalTestRun(row: SpecEvidenceForAdequacy): boolean {
  const provenance = row.testRunProvenance;
  if (provenance?.source !== 'mutation-probe') return true;
  // Calibration runs execute the original source. A mutant, historical or
  // unidentifiable probe leg can never stand in for that passing control.
  return provenance.mutation !== undefined &&
    provenance.mutationPhase === provenance.mutation.leg &&
    CALIBRATION_LEGS.includes(provenance.mutation.leg);
}

function isCurrent(row: SpecEvidenceForAdequacy): boolean {
  return row.currentness.overall === 'current' && row.currentness.provenance === 'server-measured';
}

function isCaughtMutant(row: SpecEvidenceForAdequacy): boolean {
  const execution = row.testRunExecution;
  return (
    row.testRunProvenance?.source === 'mutation-probe' &&
    row.testRunProvenance.mutationPhase === 'mutant' &&
    execution != null &&
    execution.status === 'fail' &&
    execution.failed > 0 &&
    execution.collectionFailed === false &&
    hasLinkedMutationBaseline(row)
  );
}

export function evaluateMechanicalTestAdequacy(input: {
  clause: MechanicalAdequacyClause;
  evidence: readonly SpecEvidenceForAdequacy[];
  sourceBarTestRequirements: SourceBarTestRequirements;
}): MechanicalTestAdequacy {
  const { clause, sourceBarTestRequirements } = input;
  if (sourceBarTestRequirements.status !== 'required') return { applicable: false };

  const requiredFiles = [...new Set(sourceBarTestRequirements.files.map(normalizeTestPath))].sort();
  const required = new Set(requiredFiles);
  const clauseRows = latestLogicalEvidence(
    input.evidence.filter(
      (row) =>
        row.planSlug === clause.planSlug &&
        row.specId === clause.specId &&
        row.specRevision === clause.revision &&
        (clause.contentHash === undefined || row.specFingerprint === clause.contentHash) &&
        !isWithdrawn(row),
    ),
  );

  const gaps: string[] = [];
  const passingTestBindingIds: Record<string, number> = {};
  const testRows = clauseRows.filter(
    (row) =>
      row.evidenceKind === 'test' &&
      row.testRunId !== null &&
      isOriginalTestRun(row),
  );
  for (const file of requiredFiles) {
    const bound = testRows.filter((row) => rowTestFile(row) === file);
    const qualifying = bound.find(
      (row) => row.id !== undefined && isPassingLedgerRun(row) && isCurrent(row),
    );
    if (qualifying) {
      passingTestBindingIds[file] = qualifying.id!;
      continue;
    }
    if (bound.length === 0) {
      gaps.push(`${file}: no ledger-backed test run is bound (autobind binds its next passing run at a committed tree)`);
    } else if (!bound.some(isPassingLedgerRun)) {
      gaps.push(`${file}: the bound run did not pass (binding ${bound.map((row) => row.id ?? '?').join(', ')})`);
    } else {
      const passing = bound.filter(isPassingLedgerRun);
      gaps.push(
        `${file}: the passing run is no longer current — ${passing.map((row) => `binding ${row.id ?? '?'} ${staleDetail(row)}`).join('; ')}`,
      );
    }
  }

  const mutantRows = clauseRows.filter(
    (row) => (row.evidenceKind === 'mutation' || row.evidenceKind === 'counterexample') && row.testRunId !== null,
  );
  const fromNamedTests = mutantRows.filter((row) => {
    const file = rowTestFile(row);
    return file !== null && required.has(file);
  });
  const caught = fromNamedTests.filter(isCaughtMutant);
  const caughtMutantBindingIds = caught
    .filter((row) => isCurrent(row) && row.id !== undefined)
    .map((row) => row.id!)
    .sort((a, b) => a - b);
  if (caughtMutantBindingIds.length === 0) {
    if (caught.length > 0) {
      gaps.push(
        `caught mutant is no longer current — ${caught.map((row) => `binding ${row.id ?? '?'} ${staleDetail(row)}`).join('; ')}; re-run scripts/mutation-probe.sh against a named test`,
      );
    } else if (fromNamedTests.length > 0) {
      gaps.push(
        `no bound mutant was caught with verified calibration linkage (bindings ${fromNamedTests.map((row) => row.id ?? '?').join(', ')}); re-run scripts/mutation-probe.sh against a named test`,
      );
    } else {
      gaps.push(
        `no caught mutation probe is bound for a named test (${requiredFiles.join(', ')}); run scripts/mutation-probe.sh against one and bind it with plans:bind-spec-evidence { fromTestRun }`,
      );
    }
  }

  return {
    applicable: true,
    verdict: gaps.length === 0 ? 'pass' : 'fail',
    requiredFiles,
    passingTestBindingIds,
    caughtMutantBindingIds,
    gaps,
  };
}
