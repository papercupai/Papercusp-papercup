/**
 * P-007 (gate-throughput-shift-left-2026-10-06, R-6, D-003): AUTO-PROPOSE staging fixes for the
 * failing legs of a frozen repair queue. It proposes; it NEVER admits.
 *
 * For each failing leg:
 *   1. find the staging commits since the freeze (candidate..tip) that touch the leg's failing
 *      test files;
 *   2. choose the admission paths: the failing files those commits changed, plus co-changed paths
 *      from narrow commits, plus same-directory co-changes from wide (git-sync sweep) commits;
 *   3. build a DRY-RUN admission of those paths from the pinned tip onto repairHead (the same
 *      primitive the admit door uses — the commit is proved but never published); an
 *      `admission-incomplete` refusal adds the named imports present at the tip and rebuilds,
 *      a bounded number of times;
 *   4. run the existing admission pre-check (`admission-fix-precheck`) at that built commit;
 *   5. surface the proposal as a ready one-call admission ONLY when the pre-check ran, measured
 *      every file, fixed at least one signature file and imported no new red.
 *
 * A failing, unmeasured or not-run pre-check is reported in `notSurfaced`, never in `ready`.
 * D-003: an automated admitter racing the live queue holder's verification runs can destroy that
 * run's per-leg detail and mutates state the holder owns, so admission stays an explicit call —
 * the deps seam has no publishing method, and the real deps hard-code `dryRun: true`.
 *
 * Layering: `proposeStagingFixes` is pure over `StagingFixProposalDeps`;
 * `createStagingFixProposalDeps` is the real git + pre-check wiring.
 */
import path from 'node:path';
import {
  evaluateFixPrecheck,
  precheckPopulation,
  type FixPrecheckFileResult,
  type FixPrecheckRunner,
  type SignatureLike,
} from './admission-fix-precheck';
import {
  admitPathsOntoRepairHead,
  normalizeAdmissionPath,
  realAdmissionGit,
  type AdmissionGitRunner,
  type AdmissionMissingImport,
  type AdmitPathsInput,
} from './repair-head-admission';

/** Default cap on the paths one proposal may admit — beyond it the proposal is too wide to review. */
export const STAGING_FIX_MAX_PATHS = 24;
/** A commit touching more paths than this is treated as a sweep: only near co-changes ride along. */
export const STAGING_FIX_SWEEP_THRESHOLD = 12;
/** How many `admission-incomplete` rounds may add the named imports before giving up. */
export const STAGING_FIX_MAX_COMPLETION_ROUNDS = 2;
/** At most this many commits per leg are inspected (newest first). */
export const STAGING_FIX_MAX_COMMITS = 40;

export interface FailingLeg {
  /** Display id of the leg (a workspace task, a lint leg, …). */
  leg: string;
  /** The leg's red signature entries. Only `test-file` entries are measurable by the pre-check. */
  signature: readonly SignatureLike[];
}

export interface StagingCommitTouch {
  sha: string;
  /** Every repo-relative path the commit changed (not only the matched ones). */
  paths: string[];
}

export type DryRunAdmissionResult =
  | { ok: true; commit: string; diff: string[] }
  | { ok: false; code: string; detail: string; missing?: readonly Pick<AdmissionMissingImport, 'wanted' | 'atProbeRef'>[] };

export interface StagingFixProposalDeps {
  /** Commits in candidate..tip that touch ANY of `paths`, newest first, each with its full changed-path set. */
  commitsTouching(input: { candidate: string; tip: string; paths: readonly string[] }): Promise<StagingCommitTouch[]>;
  /** Build and prove an UNPUBLISHED admission of `paths` from `sourceCommit` onto repairHead. */
  buildDryRunAdmission(input: { paths: readonly string[]; sourceCommit: string }): Promise<DryRunAdmissionResult>;
  /** The admission pre-check runner (measure `files` at `commit`). */
  precheck: FixPrecheckRunner;
}

export interface StagingFixProposalInput {
  candidate: string;
  repairHead: string;
  /** The integration tip sha, read ONCE by the caller. Every proposal admits from exactly this sha. */
  tip: string;
  legs: readonly FailingLeg[];
  maxPaths?: number;
  sweepThreshold?: number;
}

export interface ReadyStagingFix {
  leg: string;
  paths: string[];
  sourceCommits: string[];
  /** Signature test files that PASS at the built admission commit. */
  fixes: string[];
  /** Signature test files still red at the built commit (a partial fix still helps; they were red already). */
  stillFailing: string[];
  builtCommit: string;
  results: FixPrecheckFileResult[];
  /** The single explicit call that admits this proposal. Nothing is admitted until someone makes it. */
  admitCall: {
    op: 'admit';
    paths: string[];
    wholeBlob: true;
    sourceCommit: string;
    reason: string;
    expectedCandidate: string;
    expectedRepairHead: string;
    confirm: true;
  };
}

export type StagingFixNotSurfacedReason =
  | 'no-measurable-signature'
  | 'no-candidate-commits'
  | 'too-wide'
  | 'admission-refused'
  | 'precheck-not-run'
  | 'precheck-unmeasured'
  | 'precheck-failed';

export interface StagingFixNotSurfaced {
  leg: string;
  reason: StagingFixNotSurfacedReason;
  detail: string;
  paths?: string[];
  sourceCommits?: string[];
}

export interface StagingFixProposalResult {
  ready: ReadyStagingFix[];
  notSurfaced: StagingFixNotSurfaced[];
}

function norm(p: string): string | null {
  return normalizeAdmissionPath(p.replace(/\\/g, '/'));
}

/**
 * The admission path set for one leg: failing files the commits changed, every co-changed path of a
 * narrow commit, and only the same-directory co-changes of a wide (sweep) commit — a sweep carries
 * unrelated peer work, and a same-directory sibling is where a test's fix usually lives.
 */
export function chooseProposalPaths(input: {
  failing: readonly string[];
  commits: readonly StagingCommitTouch[];
  sweepThreshold: number;
}): string[] {
  const failing = new Set(input.failing);
  const dirs = new Set(input.failing.map((f) => path.posix.dirname(f)));
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p)) out.push(p);
  };
  for (const c of input.commits) {
    const changed = c.paths.map(norm).filter((p): p is string => p !== null);
    const wide = changed.length > input.sweepThreshold;
    for (const p of changed) {
      if (failing.has(p)) add(p);
      else if (!wide || dirs.has(path.posix.dirname(p))) add(p);
    }
  }
  return out;
}

export async function proposeStagingFixes(
  input: StagingFixProposalInput,
  deps: StagingFixProposalDeps,
): Promise<StagingFixProposalResult> {
  const maxPaths = input.maxPaths ?? STAGING_FIX_MAX_PATHS;
  const sweepThreshold = input.sweepThreshold ?? STAGING_FIX_SWEEP_THRESHOLD;
  const ready: ReadyStagingFix[] = [];
  const notSurfaced: StagingFixNotSurfaced[] = [];

  for (const leg of input.legs) {
    const signaturePop = precheckPopulation({ signature: leg.signature, admittedPaths: [] });
    const failing = signaturePop.signatureTestFiles;
    if (failing.length === 0) {
      notSurfaced.push({
        leg: leg.leg,
        reason: 'no-measurable-signature',
        detail: 'the leg has no test-file signature entries, so no pre-check can prove a staging change fixes it',
      });
      continue;
    }
    const commits = (await deps.commitsTouching({ candidate: input.candidate, tip: input.tip, paths: failing })).slice(
      0,
      STAGING_FIX_MAX_COMMITS,
    );
    if (commits.length === 0) {
      notSurfaced.push({
        leg: leg.leg,
        reason: 'no-candidate-commits',
        detail: `no staging commit since the freeze (${input.candidate.slice(0, 12)}..${input.tip.slice(0, 12)}) touches ${failing.join(', ')}`,
      });
      continue;
    }
    const sourceCommits = commits.map((c) => c.sha);
    let paths = chooseProposalPaths({ failing, commits, sweepThreshold });
    if (paths.length === 0) {
      notSurfaced.push({
        leg: leg.leg,
        reason: 'no-candidate-commits',
        detail: 'the touching commits changed no admissible path',
        sourceCommits,
      });
      continue;
    }

    let built: DryRunAdmissionResult | null = null;
    let tooWide = paths.length > maxPaths;
    for (let round = 0; !tooWide && round <= STAGING_FIX_MAX_COMPLETION_ROUNDS; round += 1) {
      built = await deps.buildDryRunAdmission({ paths, sourceCommit: input.tip });
      if (built.ok || built.code !== 'admission-incomplete') break;
      const addable = (built.missing ?? [])
        .filter((m) => m.atProbeRef === 'present')
        .map((m) => norm(m.wanted))
        .filter((p): p is string => p !== null && !paths.includes(p));
      if (addable.length === 0) break;
      paths = [...paths, ...addable];
      tooWide = paths.length > maxPaths;
    }
    if (tooWide) {
      notSurfaced.push({
        leg: leg.leg,
        reason: 'too-wide',
        detail: `the proposal grew to ${paths.length} paths (cap ${maxPaths}) — too wide to propose as one reviewed admission`,
        paths,
        sourceCommits,
      });
      continue;
    }
    if (!built || !built.ok) {
      notSurfaced.push({
        leg: leg.leg,
        reason: 'admission-refused',
        detail: built ? `${built.code}: ${built.detail}` : 'no admission was built',
        paths,
        sourceCommits,
      });
      continue;
    }

    const population = precheckPopulation({ signature: leg.signature, admittedPaths: paths });
    const run = await deps.precheck({ commit: built.commit, files: population.files });
    const verdict = evaluateFixPrecheck(population, run);
    const common = { leg: leg.leg, paths, sourceCommits };
    if (!verdict.ran) {
      notSurfaced.push({
        ...common,
        reason: 'precheck-not-run',
        detail: 'detail' in verdict ? verdict.detail : 'the pre-check had nothing to run',
      });
      continue;
    }
    if (!verdict.ok) {
      notSurfaced.push({
        ...common,
        reason: verdict.code === 'admission-precheck-unavailable' ? 'precheck-unmeasured' : 'precheck-failed',
        detail: `${verdict.code}: ${verdict.detail}`,
      });
      continue;
    }
    if (verdict.unmeasured.length > 0) {
      notSurfaced.push({
        ...common,
        reason: 'precheck-unmeasured',
        detail: `${verdict.unmeasured.length} file(s) were not measured (${verdict.unmeasured.join(', ')}) — an unmeasured file never counts as passing`,
      });
      continue;
    }
    if (verdict.fixes.length === 0) {
      notSurfaced.push({
        ...common,
        reason: 'precheck-failed',
        detail: `none of the leg's signature test files pass at the built admission commit ${built.commit.slice(0, 12)}`,
      });
      continue;
    }
    const stillFailing = population.signatureTestFiles.filter((f) => verdict.failing.includes(f));
    ready.push({
      ...common,
      fixes: verdict.fixes,
      stillFailing,
      builtCommit: built.commit,
      results: verdict.results,
      admitCall: {
        op: 'admit',
        paths,
        wholeBlob: true,
        sourceCommit: input.tip,
        reason:
          `auto-proposed staging fix for leg ${leg.leg}: pre-check passed at ${built.commit.slice(0, 12)} ` +
          `(fixes ${verdict.fixes.join(', ')}) from staging ${input.tip.slice(0, 12)}`,
        expectedCandidate: input.candidate,
        expectedRepairHead: input.repairHead,
        confirm: true,
      },
    });
  }
  return { ready, notSurfaced };
}

/** Real deps: git history + the dry-run admission primitive + an injected pre-check runner. */
export function createStagingFixProposalDeps(opts: {
  root: string;
  candidate: string;
  repairHead: string;
  actor: string;
  precheck: FixPrecheckRunner;
  preflight?: AdmitPathsInput['preflight'];
  git?: AdmissionGitRunner;
  nowMs?: () => number;
}): StagingFixProposalDeps {
  const git = opts.git ?? realAdmissionGit;
  return {
    async commitsTouching({ candidate, tip, paths }) {
      const log = git(['log', '--format=%H', `${candidate}..${tip}`, '--', ...paths], { cwd: opts.root });
      if (log.status !== 0) throw new Error(`git log ${candidate}..${tip} failed: ${log.stderr.trim()}`);
      const shas = log.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{40,64}$/.test(s))
        .slice(0, STAGING_FIX_MAX_COMMITS);
      return shas.map((sha) => {
        const tree = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', sha], {
          cwd: opts.root,
        });
        if (tree.status !== 0) throw new Error(`git diff-tree ${sha} failed: ${tree.stderr.trim()}`);
        return { sha, paths: [...new Set(tree.stdout.split('\n').map((s) => s.trim()).filter(Boolean))] };
      });
    },
    async buildDryRunAdmission({ paths, sourceCommit }) {
      const out = admitPathsOntoRepairHead({
        root: opts.root,
        candidate: opts.candidate,
        repairHead: opts.repairHead,
        paths,
        source: { ref: sourceCommit, recordAsRef: 'staging' },
        actor: opts.actor,
        reason: 'staging-fix proposal (dry run)',
        nowMs: opts.nowMs?.() ?? Date.now(),
        git,
        // D-003: a proposal is never published.
        dryRun: true,
        ...(opts.preflight ? { preflight: opts.preflight } : {}),
      });
      if (out.ok) return { ok: true, commit: out.commit, diff: out.diff };
      return { ok: false, code: out.code, detail: out.detail, ...(out.missing ? { missing: out.missing } : {}) };
    },
    precheck: opts.precheck,
  };
}
