/**
 * COMPOSED PROMOTION PROOF (green-main-ratchet-convergence-2026-10-17 P-018, R-15/R-16; D-008).
 *
 * WHY. After a green selective step on the frozen repair lineage, the gate used to re-run the
 * full suite before promoting. The candidate's round-1 results (P-016 measures the full failing
 * set) already cover everything an admission did not touch, and each admission's radius is
 * re-run when it lands (P-006). Re-running all of it again buys nothing and costs a full suite.
 *
 * THE PROOF. Compose instead of re-running:
 *   - a runtime test is RE-RUN only when it is in the radius of a changed file whose
 *     transpiled JavaScript changed; every other round-1 result is CARRIED;
 *   - a file whose emit is byte-identical before and after (a type-only change: annotations,
 *     `import type`, interfaces) contributes NO runtime re-runs (R-16);
 *   - a lint/typecheck leg re-runs only if it failed in round 1 or one of its inputs changed;
 *   - the full gate is kept only when a runtime-changing file's radius cannot be computed.
 *
 * FAIL-CLOSED. An emit that cannot be computed (a parse error, a non-script file) is treated as
 * a runtime change, never as type-only. A re-run test with no result counts as failing.
 *
 * Pure apart from `emitIdentity`, which calls the TypeScript compiler in-process. Not yet wired
 * into green-checkpoint: see green-main-ratchet-convergence-2026-10-17#D-021 (follow-up item).
 */
import ts from 'typescript';

export type EmitIdentity = 'identical' | 'changed' | 'uncomputable';

const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

function emitOrNull(fileName: string, source: string): string | null {
  try {
    const out = ts.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
        removeComments: true,
        isolatedModules: true,
      },
    });
    if ((out.diagnostics ?? []).some((d) => d.category === ts.DiagnosticCategory.Error)) return null;
    return out.outputText;
  } catch {
    return null;
  }
}

/**
 * Compare the JavaScript a file transpiles to before and after a change. `null` content means
 * the file was added or deleted, which always changes runtime behaviour.
 */
export function emitIdentity(path: string, before: string | null, after: string | null): EmitIdentity {
  if (!SCRIPT_FILE.test(path)) return 'uncomputable';
  if (before === null || after === null) return 'changed';
  const a = emitOrNull(path, before);
  const b = emitOrNull(path, after);
  if (a === null || b === null) return 'uncomputable';
  return a === b ? 'identical' : 'changed';
}

export interface ChangedFile {
  path: string;
  before: string | null;
  after: string | null;
}

export interface ProofAdmission {
  id: string;
  changedFiles: readonly ChangedFile[];
}

export interface ProofLintLeg {
  id: string;
  /** Round-1 verdict of the leg on the candidate. */
  passed: boolean;
  /** Whether a changed path is one of this leg's inputs. */
  covers: (path: string) => boolean;
}

export type TestVerdict = 'pass' | 'fail';

export interface ComposedProofInput {
  /** Round-1 results on the candidate, keyed by repo-relative test file. */
  round1Tests: Readonly<Record<string, TestVerdict>>;
  lintLegs: readonly ProofLintLeg[];
  admissions: readonly ProofAdmission[];
  /** Runtime test files that depend on a path; null when the radius cannot be computed. */
  dependentTestsOf: (path: string) => readonly string[] | null;
  /** Override for tests; defaults to {@link emitIdentity}. */
  emitOf?: (file: ChangedFile) => EmitIdentity;
}

export type ComposedProofPlan =
  | { mode: 'full-gate'; reason: string; uncomputableRadius: string[] }
  | {
      mode: 'composed';
      rerunTests: string[];
      carriedTests: string[];
      rerunLegs: string[];
      carriedLegs: string[];
      typeOnlyFiles: string[];
      runtimeFiles: string[];
    };

export function planComposedProof(input: ComposedProofInput): ComposedProofPlan {
  const emitOf = input.emitOf ?? ((f: ChangedFile) => emitIdentity(f.path, f.before, f.after));
  const rerun = new Set<string>();
  const typeOnly = new Set<string>();
  const runtime = new Set<string>();
  const uncomputable = new Set<string>();
  const changedPaths = new Set<string>();

  for (const admission of input.admissions) {
    for (const file of admission.changedFiles) {
      changedPaths.add(file.path);
      if (emitOf(file) === 'identical') {
        typeOnly.add(file.path);
        continue;
      }
      runtime.add(file.path);
      const dependents = input.dependentTestsOf(file.path);
      if (dependents === null) {
        uncomputable.add(file.path);
        continue;
      }
      for (const t of dependents) rerun.add(t);
    }
  }

  if (uncomputable.size > 0) {
    return {
      mode: 'full-gate',
      reason: 'a runtime-changing file has no computable radius',
      uncomputableRadius: [...uncomputable].sort(),
    };
  }

  const rerunLegs: string[] = [];
  const carriedLegs: string[] = [];
  for (const leg of input.lintLegs) {
    const inputsChanged = [...changedPaths].some((p) => leg.covers(p));
    (leg.passed && !inputsChanged ? carriedLegs : rerunLegs).push(leg.id);
  }

  return {
    mode: 'composed',
    rerunTests: [...rerun].sort(),
    carriedTests: Object.keys(input.round1Tests).filter((t) => !rerun.has(t)).sort(),
    rerunLegs: rerunLegs.sort(),
    carriedLegs: carriedLegs.sort(),
    typeOnlyFiles: [...typeOnly].sort(),
    runtimeFiles: [...runtime].sort(),
  };
}

export interface ComposedVerdict {
  /** Failing tests and legs after composition: carried failures plus re-run failures. */
  failing: string[];
  /** Re-run tests or legs with no result; counted as failing. */
  unmeasured: string[];
}

/** Combine carried round-1 results with the re-run results of a composed plan. */
export function composeVerdict(
  plan: Extract<ComposedProofPlan, { mode: 'composed' }>,
  round1Tests: Readonly<Record<string, TestVerdict>>,
  rerunResults: Readonly<Record<string, TestVerdict>>,
): ComposedVerdict {
  const failing = new Set<string>();
  const unmeasured: string[] = [];
  for (const t of plan.carriedTests) if (round1Tests[t] === 'fail') failing.add(t);
  for (const id of [...plan.rerunTests, ...plan.rerunLegs]) {
    const v = rerunResults[id];
    if (v === undefined) {
      unmeasured.push(id);
      failing.add(id);
    } else if (v === 'fail') {
      failing.add(id);
    }
  }
  return { failing: [...failing].sort(), unmeasured: unmeasured.sort() };
}
