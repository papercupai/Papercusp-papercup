/**
 * Tests-first cleanup executor — sequencing core (code-cleanup-campaigns-2026-10-26 P-006, R-6).
 *
 * A triaged batch (P-005) is refactored only when the coverage map reports every member covered.
 * An uncovered member is never refactored:
 *   - under `safe` (the default, D-007) the batch is excluded;
 *   - under `standard` / `thorough` (R-12) the executor first emits a characterization-test change
 *     for the uncovered members, then refuses the refactor until a coverage map taken AT OR AFTER
 *     that change landed reports each of those members covered by the characterization's own test
 *     files.
 * Characterization tests and the refactor are always separate changes: the step model never emits
 * both at once, and `validateExecutorChange` refuses a change that mixes them.
 *
 * The core is pure: coverage arrives as a `CoverageView` and commit ordering through
 * `ExecutorDeps`. `coverageViewFromScope` and `nativeExecutorDeps` are the production adapters.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CoverageScopeData } from '../code-intelligence/test-coverage-map';
import type { TriageBatch, TriageLocation } from './triage';

// Promisified lazily on first call, never at module scope (EI-10161): an eager
// promisify(execFile) throws at import time under a narrow node:child_process test mock.
let cachedExecFileAsync: typeof execFile.__promisify__ | undefined;
const execFileAsync = ((...args: Parameters<typeof execFile.__promisify__>) =>
  (cachedExecFileAsync ??= promisify(execFile))(...args)) as typeof execFile.__promisify__;

/** Campaign aggressiveness (R-12). `safe` is the default for a new campaign (D-007). */
export type CleanupAggressiveness = 'safe' | 'standard' | 'thorough';
export const DEFAULT_CLEANUP_AGGRESSIVENESS: CleanupAggressiveness = 'safe';

/** A clone-family member the batch would edit. `endLine` widens the coverage question past `line`. */
export interface ExecutorMember extends TriageLocation { endLine?: number }
export interface ExecutorBatch { id: string; members: readonly ExecutorMember[] }

/** One coverage map, captured once. */
export interface CoverageView {
  /** When the map was taken: the candidate commit it ran on, and/or the observation time. */
  takenAt: { commit: string | null; observedAt: string | null };
  /**
   * Test files that executed the member's lines. `[]` = the map knows the member and no test runs
   * it; `null` = the map cannot answer (no execution evidence). Both count as uncovered.
   */
  coveringTests(member: ExecutorMember): readonly string[] | null;
}

/** The characterization-test change the executor emitted earlier for one batch. */
export interface CharacterizationRecord {
  batchId: string;
  /** The members it was written for (the batch's uncovered members at the time). */
  members: readonly ExecutorMember[];
  testFiles: readonly string[];
  /** The commit it landed in; null while it has not landed. */
  landedCommit: string | null;
}

export interface ExecutorDeps {
  /**
   * Was `view` taken at or after `commit` landed? null = cannot tell, which is treated as stale:
   * the executor never proceeds on a map it cannot place after the characterization change.
   */
  coverageTakenAtOrAfter(view: CoverageView, commit: string): Promise<boolean | null>;
}

export type ExecutorStep =
  | { kind: 'refactor'; batchId: string; members: ExecutorMember[] }
  | { kind: 'characterize'; batchId: string; members: ExecutorMember[]; detail: string }
  | { kind: 'exclude'; batchId: string; reason: 'uncovered-under-safe'; members: ExecutorMember[]; detail: string }
  | { kind: 'wait'; batchId: string; reason: 'characterization-unlanded' | 'coverage-map-stale'; detail: string }
  | { kind: 'refuse'; batchId: string; reason: 'characterization-did-not-cover'; members: ExecutorMember[]; detail: string };

export interface ExecutorInput {
  batch: ExecutorBatch;
  aggressiveness: CleanupAggressiveness;
  coverage: CoverageView;
  /** The characterization change already emitted for this batch, if any. */
  characterization?: CharacterizationRecord | null;
}

const memberLabel = (m: ExecutorMember) => `${m.path}:${m.line}${m.endLine ? `-${m.endLine}` : ''} ${m.symbol}`;

/** A batch id stable across runs: the triage area plus the batch's index in it. */
export function executorBatchFromTriage(batch: TriageBatch, endLine?: (m: TriageLocation) => number | undefined): ExecutorBatch {
  const members = batch.families.flatMap(f => f.members.map(m => ({ ...m, endLine: endLine?.(m) ?? m.endLine })));
  return { id: `${batch.area}#${batch.index}`, members };
}

/** The next thing the executor may do for one batch. Never a refactor that touches an uncovered member. */
export async function nextExecutorStep(input: ExecutorInput, deps: ExecutorDeps): Promise<ExecutorStep> {
  const { batch, coverage } = input;
  const characterization = input.characterization ?? null;
  if (characterization && characterization.batchId !== batch.id) {
    throw new Error(`characterization record belongs to batch ${characterization.batchId}, not ${batch.id}`);
  }

  if (characterization) {
    if (!characterization.landedCommit) {
      return { kind: 'wait', batchId: batch.id, reason: 'characterization-unlanded',
        detail: 'the characterization-test change has not landed; the refactor waits for it' };
    }
    const fresh = await deps.coverageTakenAtOrAfter(coverage, characterization.landedCommit);
    if (fresh !== true) {
      return { kind: 'wait', batchId: batch.id, reason: 'coverage-map-stale',
        detail: fresh === null
          ? `cannot place the coverage map after characterization commit ${characterization.landedCommit}; it is treated as stale`
          : `the coverage map predates characterization commit ${characterization.landedCommit}` };
    }
    const own = new Set(characterization.testFiles);
    const notCovered = characterization.members.filter(m => !(coverage.coveringTests(m) ?? []).some(t => own.has(t)));
    if (notCovered.length) {
      return { kind: 'refuse', batchId: batch.id, reason: 'characterization-did-not-cover', members: [...notCovered],
        detail: `the coverage map does not show the characterization tests (${[...own].join(', ')}) executing `
          + notCovered.map(memberLabel).join('; ') };
    }
  }

  const uncovered = batch.members.filter(m => (coverage.coveringTests(m) ?? []).length === 0);
  if (!uncovered.length) return { kind: 'refactor', batchId: batch.id, members: [...batch.members] };

  if (input.aggressiveness === 'safe') {
    return { kind: 'exclude', batchId: batch.id, reason: 'uncovered-under-safe', members: uncovered,
      detail: `aggressiveness 'safe' excludes batches with uncovered members: ${uncovered.map(memberLabel).join('; ')}` };
  }
  // A passed characterization's members are covered by now, so `uncovered` holds only members it
  // did not include (for example ones added to the batch since): characterize those next.
  return { kind: 'characterize', batchId: batch.id, members: uncovered,
    detail: `write characterization tests for ${uncovered.length} uncovered member(s) and land them before any refactor: `
      + uncovered.map(memberLabel).join('; ') };
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Violations for landing `files` as the change for `step`. Empty means the change may land.
 * A characterization change holds test files only; a refactor change holds no test files (its
 * covering tests stay unchanged — R-4), so the two can never land together.
 */
export function validateExecutorChange(step: ExecutorStep, files: readonly string[],
  characterization?: CharacterizationRecord | null): string[] {
  if (step.kind !== 'refactor' && step.kind !== 'characterize') {
    return [`a '${step.kind}' step lands no change`];
  }
  if (!files.length) return [`the ${step.kind} change has no files`];
  if (step.kind === 'characterize') {
    return files.filter(f => !TEST_FILE_RE.test(f))
      .map(f => `characterization change touches non-test file ${f}; the refactor must land in a separate change`);
  }
  const own = new Set(characterization?.testFiles ?? []);
  return files.filter(f => TEST_FILE_RE.test(f)).map(f => own.has(f)
    ? `refactor change also edits characterization test file ${f}; characterization tests and the refactor must land in separate changes`
    : `refactor change edits test file ${f}; a refactor's covering tests must stay unchanged`);
}

/**
 * Production coverage view over loaded coverage scope data (readNativeCoverageScope).
 * Only execution-backed answers count as coverage; a static fallback answers `null`.
 */
export async function coverageViewFromScope(root: string, scope: CoverageScopeData): Promise<CoverageView> {
  const { queryTestCoverage, sourceBoundCoverageSnapshots } = await import('../code-intelligence/test-coverage-map');
  const bound = sourceBoundCoverageSnapshots(root, scope.snapshots, scope.currentHashes);
  const newest = [...bound].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
  return {
    takenAt: { commit: newest?.provenance?.candidate ?? null, observedAt: newest?.observedAt ?? null },
    coveringTests(member) {
      const answer = queryTestCoverage({ root, question: { path: member.path, line1: member.line, endLine1: member.endLine ?? member.line },
        snapshots: scope.snapshots, currentHashes: scope.currentHashes, currentPopulation: scope.population });
      return answer.basis === 'execution' ? answer.tests : null;
    },
  };
}

/** git-backed ordering: commit ancestry when the map names its candidate, else observation time vs commit time. */
export function nativeExecutorDeps(root: string): ExecutorDeps {
  const git = (args: string[]) => execFileAsync('git', ['-C', root, ...args], { timeout: 15_000 });
  return {
    async coverageTakenAtOrAfter(view, commit) {
      if (view.takenAt.commit) {
        try {
          await git(['merge-base', '--is-ancestor', commit, view.takenAt.commit]);
          return true;
        } catch (e) {
          return (e as { code?: unknown }).code === 1 ? false : null;
        }
      }
      if (!view.takenAt.observedAt) return null;
      try {
        const { stdout } = await git(['show', '-s', '--format=%cI', commit]);
        const committed = Date.parse(stdout.trim());
        const observed = Date.parse(view.takenAt.observedAt);
        return Number.isFinite(committed) && Number.isFinite(observed) ? observed >= committed : null;
      } catch {
        return null;
      }
    },
  };
}
