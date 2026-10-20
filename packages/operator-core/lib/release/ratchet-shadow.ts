/**
 * RATCHET SHADOW (green-main-ratchet-convergence-2026-10-17 #D-025; wiring of P-007 and P-018).
 *
 * WHY. The new-red ejection planner (P-007, new-red-ejection.ts) and the composed promotion proof
 * (P-018, composed-promotion-proof.ts) both change what reaches main for the whole fleet. A wrong
 * composed proof promotes a red; a wrong ejection drops a good commit. So the gate runs them in
 * SHADOW first: each planner computes what it WOULD do beside the real verdict, and the record
 * goes to `gate_health.ratchetShadow`. Nothing here changes a verdict, builds a candidate, or
 * routes a red to anyone. Acting is a separate switch per planner, after at least 5 recorded
 * shadow runs with no disagreement (D-025 #4).
 *
 * WHAT IS RECORDED.
 *   - composedProof: at a green selective verification of a frozen repair head, the plan (which
 *     tests a composed proof would re-run, which round-1 results it would carry, which changed
 *     files are type-only). After the full canonical run at that head, `compareComposedProofShadow`
 *     composes the verdict from the full run's results for the re-run set plus the carried
 *     round-1 results, and records whether it agrees with the full verdict. `missedByComposed`
 *     is the falsifier: a full-run failure the composition would have carried as passing.
 *   - newRedEjection: on a red run, the radius attribution (step 1) and the ejection plan
 *     (step 3) over the commits since the green pin. The blame check (step 2, D-003) needs a
 *     build without the commit and is NOT run in shadow, so attributions are radius-only.
 *
 * COST. Both planners need the related-test radius of a set of paths, which is one selector run
 * (`affected-tests --changed-paths ... --related --print-affected`). The ejection planner finds
 * the selecting commit per failing test by bisecting the commit range: a range whose radius does
 * not reach a test cannot contain a commit that selects it, so one query clears many commits.
 * Queries are memoized and capped by count and wall clock; when the budget runs out, the
 * commits not yet resolved read as "radius unknown", which never attributes (fail closed).
 */
import {
  composeVerdict,
  emitIdentity,
  planComposedProof,
  type ChangedFile,
  type ComposedProofPlan,
  type EmitIdentity,
  type ProofLintLeg,
  type TestVerdict,
} from './composed-promotion-proof';
import {
  attributeByRadius,
  planEjection,
  type CandidateCommit,
  type FailureAttribution,
} from './new-red-ejection';

/** Test files a set of changed paths can reach; null when the selector widened or failed. */
export type RadiusQuery = (paths: readonly string[]) => Promise<ReadonlySet<string> | null>;

/** Most entries of any list kept in a record, so gate_health stays small. */
export const RATCHET_SHADOW_SAMPLE_CAP = 20;

function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function sample<T>(items: readonly T[]): T[] {
  return items.slice(0, RATCHET_SHADOW_SAMPLE_CAP);
}

/**
 * Test identity across the gate's two spellings of a test path: repo-relative
 * (`packages/x/lib/a.test.ts`) and workspace-relative (`lib/a.test.ts`).
 */
export function sameTest(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** Whether a radius set reaches a test, under either spelling. */
export function radiusHasTest(radius: ReadonlySet<string>, test: string): boolean {
  if (radius.has(test)) return true;
  for (const r of radius) if (sameTest(r, test)) return true;
  return false;
}

/**
 * A failingTests entry that names a test FILE, as opposed to a workspace task
 * (`<ws> :: test`), a lint leg (`lint:tsc`) or a generator check. Anything else is treated as a
 * leg, which a composed proof always re-runs (the conservative direction).
 */
export function isTestFileId(id: string): boolean {
  const s = id.trim();
  if (!s || s.includes('::') || s.startsWith('lint:') || s.startsWith('gen:') || s.startsWith('@')) return false;
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(s) || s.includes('/');
}

// ---------------------------------------------------------------------------------------------
// P-018: composed promotion proof, in shadow
// ---------------------------------------------------------------------------------------------

export interface ComposedProofComparison {
  fullGreen: boolean;
  composedGreen: boolean;
  /** Same promotion decision AND no full-run failure the composition would have missed. */
  agree: boolean;
  /** Full-run failures the composed proof would have carried as passing: a wrong promotion. */
  missedByComposed: string[];
  /** Composed failures the full run did not report: a needless hold. */
  extraInComposed: string[];
  /** Re-run entries read as passing because the full run did not report them failing. */
  rerunReadFrom: 'full-run-failing-set';
}

export interface ComposedProofShadowRecord {
  schemaVersion: 1;
  /** The frozen candidate whose round-1 results are carried. */
  candidate: string;
  /** The repair head the full run judged. */
  repairHead: string;
  atMs: number;
  status: 'planned' | 'skipped' | 'error';
  reason?: string;
  mode?: ComposedProofPlan['mode'];
  round1Failing?: number;
  rerunCount?: number;
  rerunSample?: string[];
  carriedFailing?: string[];
  rerunLegs?: string[];
  typeOnlyFileCount?: number;
  typeOnlySample?: string[];
  runtimeFileCount?: number;
  uncomputableRadius?: string[];
  comparison?: ComposedProofComparison;
  /** Why no comparison was recorded after the full run, when none was. */
  comparisonSkipped?: string;
}

export interface ComposedProofShadow {
  record: ComposedProofShadowRecord;
  /** The in-memory plan the comparison composes from; null when nothing was planned. */
  plan: ComposedProofPlan | null;
  round1Tests: Readonly<Record<string, TestVerdict>>;
}

export interface ComposedProofShadowInput {
  candidate: string;
  repairHead: string;
  /** The frozen candidate's round-1 failing set; null when no round was recorded at it. */
  round1: { failingTests: readonly string[]; failingCount: number } | null;
  /** Every file the lineage changed between the candidate and the repair head; null = unreadable. */
  changedFiles: readonly ChangedFile[] | null;
  radius: RadiusQuery;
  emitOf?: (file: ChangedFile) => EmitIdentity;
  nowMs: number;
}

/** Plan the composed proof beside a green selective verification. Never throws. */
export async function planComposedProofShadow(input: ComposedProofShadowInput): Promise<ComposedProofShadow> {
  const base: ComposedProofShadowRecord = {
    schemaVersion: 1,
    candidate: input.candidate,
    repairHead: input.repairHead,
    atMs: input.nowMs,
    status: 'skipped',
  };
  const skipped = (reason: string): ComposedProofShadow => ({ record: { ...base, reason }, plan: null, round1Tests: {} });
  try {
    if (!input.round1) return skipped('no round-1 failing set is recorded at the frozen candidate');
    if (input.round1.failingTests.length < input.round1.failingCount) {
      // A capped round-1 set cannot be carried: the uncarried failures would read as passing.
      return skipped(
        `round-1 failing set is capped (${input.round1.failingTests.length} of ${input.round1.failingCount} recorded)`,
      );
    }
    if (!input.changedFiles) return skipped('the lineage changes between candidate and repair head are unreadable');

    const emitOf = input.emitOf ?? ((f: ChangedFile) => emitIdentity(f.path, f.before, f.after));
    const identity = new Map<string, EmitIdentity>();
    for (const f of input.changedFiles) identity.set(f.path, emitOf(f));
    const runtimePaths = input.changedFiles.filter((f) => identity.get(f.path) !== 'identical').map((f) => f.path);

    const round1Tests: Record<string, TestVerdict> = {};
    const lintLegs: ProofLintLeg[] = [];
    for (const raw of input.round1.failingTests) {
      const id = raw.trim();
      if (!id) continue;
      if (isTestFileId(id)) round1Tests[id] = 'fail';
      // Which inputs a leg covers is not known here, so every red leg is re-run.
      else lintLegs.push({ id, passed: false, covers: () => true });
    }

    const radius = runtimePaths.length > 0 ? await input.radius(runtimePaths) : new Set<string>();
    // Round-1 ids are matched to the radius under either spelling, so a carried test is one the
    // radius truly misses, never a spelling difference.
    const rerunList =
      radius === null
        ? null
        : [...new Set([...radius, ...Object.keys(round1Tests).filter((t) => radiusHasTest(radius, t))])];
    const runtime = new Set(runtimePaths);
    const plan = planComposedProof({
      round1Tests,
      lintLegs,
      admissions: [{ id: 'lineage', changedFiles: input.changedFiles }],
      dependentTestsOf: (p) => (runtime.has(p) ? rerunList : []),
      emitOf: (f) => identity.get(f.path) ?? 'uncomputable',
    });
    const round1Failing = Object.keys(round1Tests).length + lintLegs.length;
    if (plan.mode === 'full-gate') {
      return {
        record: {
          ...base,
          status: 'planned',
          mode: 'full-gate',
          reason: plan.reason,
          round1Failing,
          uncomputableRadius: sample(plan.uncomputableRadius),
          runtimeFileCount: runtimePaths.length,
        },
        plan,
        round1Tests,
      };
    }
    return {
      record: {
        ...base,
        status: 'planned',
        mode: 'composed',
        round1Failing,
        rerunCount: plan.rerunTests.length,
        rerunSample: sample(plan.rerunTests),
        carriedFailing: sample(plan.carriedTests.filter((t) => round1Tests[t] === 'fail')),
        rerunLegs: sample(plan.rerunLegs),
        typeOnlyFileCount: plan.typeOnlyFiles.length,
        typeOnlySample: sample(plan.typeOnlyFiles),
        runtimeFileCount: plan.runtimeFiles.length,
      },
      plan,
      round1Tests,
    };
  } catch (e) {
    return { record: { ...base, status: 'error', reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, plan: null, round1Tests: {} };
  }
}

/**
 * After the full canonical run at the repair head: compose the verdict the proof would have
 * reached and compare it with the full verdict. A full-gate plan would have run this same full
 * run, so it agrees by construction.
 */
export function compareComposedProofShadow(
  shadow: ComposedProofShadow,
  full: { green: boolean; failingTests: readonly string[] },
): ComposedProofShadowRecord {
  const { plan, record } = shadow;
  if (!plan) return { ...record, comparisonSkipped: 'nothing was planned' };
  const fullFailing = full.green ? [] : full.failingTests.map((t) => t.trim()).filter(Boolean);
  if (plan.mode === 'full-gate') {
    return {
      ...record,
      comparison: {
        fullGreen: full.green,
        composedGreen: full.green,
        agree: true,
        missedByComposed: [],
        extraInComposed: [],
        rerunReadFrom: 'full-run-failing-set',
      },
    };
  }
  const failsInFull = (id: string) => fullFailing.some((f) => f === id || sameTest(f, id));
  const rerunResults: Record<string, TestVerdict> = {};
  for (const id of [...plan.rerunTests, ...plan.rerunLegs]) rerunResults[id] = failsInFull(id) ? 'fail' : 'pass';
  const composed = composeVerdict(plan, shadow.round1Tests, rerunResults);
  const inComposed = (id: string) => composed.failing.some((c) => c === id || sameTest(c, id));
  const missedByComposed = fullFailing.filter((f) => !inComposed(f));
  const extraInComposed = composed.failing.filter((c) => !failsInFull(c));
  const composedGreen = composed.failing.length === 0;
  return {
    ...record,
    comparison: {
      fullGreen: full.green,
      composedGreen,
      agree: composedGreen === full.green && missedByComposed.length === 0,
      missedByComposed: sample(missedByComposed),
      extraInComposed: sample(extraInComposed),
      rerunReadFrom: 'full-run-failing-set',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// P-007: new-red ejection, in shadow
// ---------------------------------------------------------------------------------------------

export interface NewRedEjectionShadowRecord {
  schemaVersion: 1;
  candidate: string;
  /** The green pin the commit range starts from. */
  base: string | null;
  atMs: number;
  status: 'planned' | 'nothing-new' | 'skipped' | 'error';
  reason?: string;
  commitCount?: number;
  newFailureCount?: number;
  plan?: 'none' | 'freeze' | 'eject';
  ejected?: string[];
  attributions?: Array<{ test: string; kind: FailureAttribution['kind']; commit?: string; reason?: string; commits?: string[] }>;
  unattributableByReason?: Record<string, number>;
  radiusQueries?: number;
  budgetExhausted?: boolean;
  /** D-003's blame check needs a build without the commit; shadow mode never builds. */
  blameCheck: 'not-run';
}

export interface NewRedEjectionShadowInput {
  candidate: string;
  base: string | null;
  /** Repo-relative test files still blocking after quarantine and downgrades. */
  newFailures: readonly string[];
  /** Commits since the green pin, oldest first; null when the range is unreadable. */
  commits: readonly CandidateCommit[] | null;
  radius: RadiusQuery;
  /** Most selector runs this shadow may spend. */
  maxQueries: number;
  /** Wall-clock budget; past it, no further query starts. */
  budgetMs: number;
  /** Ranges larger than this are skipped outright (an over-long --changed-paths list). */
  maxCommits?: number;
  now?: () => number;
}

/**
 * For each test, the commits whose radius selects it (by bisection) and the commits whose
 * radius could not be computed. Exported for tests.
 */
export async function bisectSelectingCommits(input: {
  tests: readonly string[];
  commits: readonly CandidateCommit[];
  radius: RadiusQuery;
  maxQueries: number;
  budgetMs: number;
  now?: () => number;
}): Promise<{
  selecting: Map<string, Set<string>>;
  unknown: Map<string, Set<string>>;
  leafRadius: Map<string, ReadonlySet<string> | null>;
  queries: number;
  exhausted: boolean;
}> {
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  const cache = new Map<string, ReadonlySet<string> | null>();
  const selecting = new Map<string, Set<string>>();
  const unknown = new Map<string, Set<string>>();
  const leafRadius = new Map<string, ReadonlySet<string> | null>();
  let queries = 0;
  let exhausted = false;
  const add = (m: Map<string, Set<string>>, t: string, sha: string) => {
    let s = m.get(t);
    if (!s) m.set(t, (s = new Set()));
    s.add(sha);
  };
  // A commit that changed the test file itself selects it without any query.
  const direct = (c: CandidateCommit, t: string) => c.paths.some((p) => sameTest(p, t));

  async function rangeRadius(lo: number, hi: number): Promise<ReadonlySet<string> | null | undefined> {
    const key = `${lo}:${hi}`;
    if (cache.has(key)) return cache.get(key);
    if (queries >= input.maxQueries || now() >= deadline) {
      exhausted = true;
      return undefined;
    }
    queries += 1;
    const paths = [...new Set(input.commits.slice(lo, hi).flatMap((c) => c.paths.map(norm)))].filter(Boolean);
    let r: ReadonlySet<string> | null;
    try {
      r = paths.length === 0 ? new Set() : await input.radius(paths);
    } catch {
      r = null;
    }
    cache.set(key, r);
    if (hi - lo === 1) leafRadius.set(input.commits[lo]!.sha, r);
    return r;
  }

  async function walk(lo: number, hi: number, tests: readonly string[]): Promise<void> {
    if (tests.length === 0 || lo >= hi) return;
    const r = await rangeRadius(lo, hi);
    if (r === undefined) {
      // Budget gone: direct hits still count, every other commit here is unknown for these tests.
      for (let i = lo; i < hi; i++) {
        const c = input.commits[i]!;
        for (const t of tests) add(direct(c, t) ? selecting : unknown, t, c.sha);
      }
      return;
    }
    if (hi - lo === 1) {
      const c = input.commits[lo]!;
      for (const t of tests) {
        if (direct(c, t) || (r !== null && radiusHasTest(r, t))) add(selecting, t, c.sha);
        else if (r === null) add(unknown, t, c.sha);
      }
      return;
    }
    // A computed range radius that misses a test clears every commit in the range for it.
    // A widened (null) range radius says nothing, so the range splits with every test.
    const next =
      r === null
        ? tests
        : tests.filter((t) => radiusHasTest(r, t) || input.commits.slice(lo, hi).some((c) => direct(c, t)));
    const mid = lo + Math.floor((hi - lo) / 2);
    await walk(lo, mid, next);
    await walk(mid, hi, next);
  }

  await walk(0, input.commits.length, input.tests);
  return { selecting, unknown, leafRadius, queries, exhausted };
}

/** Attribute and plan beside a red verdict. Never throws, never builds, never routes. */
export async function planNewRedEjectionShadow(input: NewRedEjectionShadowInput): Promise<NewRedEjectionShadowRecord> {
  const now = input.now ?? Date.now;
  const base: NewRedEjectionShadowRecord = {
    schemaVersion: 1,
    candidate: input.candidate,
    base: input.base,
    atMs: now(),
    status: 'skipped',
    blameCheck: 'not-run',
  };
  try {
    const tests = [...new Set(input.newFailures.map(norm).filter(Boolean))].sort();
    if (tests.length === 0) {
      return { ...base, status: 'nothing-new', reason: 'no file-level blocking failure (task or guard reds only, or none)' };
    }
    if (!input.commits) return { ...base, newFailureCount: tests.length, reason: 'the commit range since the green pin is unreadable' };
    const commits = input.commits.filter((c) => c.paths.length > 0);
    const maxCommits = input.maxCommits ?? 2_000;
    if (commits.length > maxCommits) {
      return { ...base, newFailureCount: tests.length, commitCount: commits.length, reason: `commit range too long (${commits.length} > ${maxCommits})` };
    }
    if (commits.length === 0) {
      return { ...base, newFailureCount: tests.length, commitCount: 0, reason: 'no commit with changed paths since the green pin' };
    }
    const walk = await bisectSelectingCommits({
      tests,
      commits,
      radius: input.radius,
      maxQueries: input.maxQueries,
      budgetMs: input.budgetMs,
      now,
    });
    const selectsTest = (c: CandidateCommit, t: string): boolean | null => {
      if (walk.selecting.get(t)?.has(c.sha)) return true;
      if (walk.unknown.get(t)?.has(c.sha)) return null;
      return false;
    };
    const attributions = attributeByRadius({ newFailures: tests, commits, selectsTest });
    const plan = planEjection({
      confirmed: attributions,
      commits,
      radiusOf: (c) => {
        const r = walk.leafRadius.get(c.sha);
        return r ? [...r] : null;
      },
    });
    const unattributableByReason: Record<string, number> = {};
    const unattr = plan.kind === 'none' ? [] : plan.unattributable;
    for (const a of unattr) unattributableByReason[a.reason] = (unattributableByReason[a.reason] ?? 0) + 1;
    return {
      ...base,
      status: 'planned',
      commitCount: commits.length,
      newFailureCount: tests.length,
      plan: plan.kind,
      ...(plan.kind === 'eject' ? { ejected: sample(plan.ejected) } : {}),
      attributions: sample(
        attributions.map((a) =>
          a.kind === 'attributed'
            ? { test: a.test, kind: a.kind, commit: a.commit }
            : { test: a.test, kind: a.kind, reason: a.reason, commits: sample(a.commits) },
        ),
      ),
      unattributableByReason,
      radiusQueries: walk.queries,
      budgetExhausted: walk.exhausted,
    };
  } catch (e) {
    return { ...base, status: 'error', reason: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/**
 * `git log --reverse --format=%x1e%H --name-only <base>..<candidate>` → commits, oldest first.
 * Authors are not read: git-sync commits the whole tree under one identity, so a git author
 * names nobody (shadow mode routes nothing anyway).
 */
export function parseCommitPathLog(stdout: string): CandidateCommit[] {
  const out: CandidateCommit[] = [];
  for (const block of stdout.split('\x1e')) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const sha = lines[0]!;
    if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
    out.push({ sha, author: null, paths: lines.slice(1).map(norm) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// gate_health record
// ---------------------------------------------------------------------------------------------

export interface RatchetShadowHealth {
  composedProof?: ComposedProofShadowRecord;
  newRedEjection?: NewRedEjectionShadowRecord;
}

/**
 * The form carried in the one-line result marker, which must stay under PIPE_BUF (4096 bytes)
 * beside every other field: counts, the verdict comparison and at most 3 short samples. The full
 * record stays in the stderr result dump.
 */
export function compactRatchetShadow(h: RatchetShadowHealth): RatchetShadowHealth {
  const cap = (xs: readonly string[] | undefined) => (xs ?? []).slice(0, 3).map((s) => s.slice(0, 128));
  const out: RatchetShadowHealth = {};
  const cp = h.composedProof;
  if (cp) {
    out.composedProof = {
      schemaVersion: 1,
      candidate: cp.candidate.slice(0, 12),
      repairHead: cp.repairHead.slice(0, 12),
      atMs: cp.atMs,
      status: cp.status,
      ...(cp.reason ? { reason: cp.reason.slice(0, 160) } : {}),
      ...(cp.mode ? { mode: cp.mode } : {}),
      ...(cp.round1Failing !== undefined ? { round1Failing: cp.round1Failing } : {}),
      ...(cp.rerunCount !== undefined ? { rerunCount: cp.rerunCount } : {}),
      ...(cp.typeOnlyFileCount !== undefined ? { typeOnlyFileCount: cp.typeOnlyFileCount } : {}),
      ...(cp.runtimeFileCount !== undefined ? { runtimeFileCount: cp.runtimeFileCount } : {}),
      ...(cp.comparison
        ? {
            comparison: {
              ...cp.comparison,
              missedByComposed: cap(cp.comparison.missedByComposed),
              extraInComposed: cap(cp.comparison.extraInComposed),
            },
          }
        : {}),
      ...(cp.comparisonSkipped ? { comparisonSkipped: cp.comparisonSkipped.slice(0, 160) } : {}),
    };
  }
  const nr = h.newRedEjection;
  if (nr) {
    out.newRedEjection = {
      schemaVersion: 1,
      candidate: nr.candidate.slice(0, 12),
      base: nr.base ? nr.base.slice(0, 12) : null,
      atMs: nr.atMs,
      status: nr.status,
      blameCheck: 'not-run',
      ...(nr.reason ? { reason: nr.reason.slice(0, 160) } : {}),
      ...(nr.commitCount !== undefined ? { commitCount: nr.commitCount } : {}),
      ...(nr.newFailureCount !== undefined ? { newFailureCount: nr.newFailureCount } : {}),
      ...(nr.plan ? { plan: nr.plan } : {}),
      ...(nr.ejected ? { ejected: cap(nr.ejected).map((s) => s.slice(0, 12)) } : {}),
      ...(nr.unattributableByReason ? { unattributableByReason: nr.unattributableByReason } : {}),
      ...(nr.radiusQueries !== undefined ? { radiusQueries: nr.radiusQueries } : {}),
      ...(nr.budgetExhausted !== undefined ? { budgetExhausted: nr.budgetExhausted } : {}),
    };
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Re-validate a `ratchetShadow` value read back out of JSON (the result marker) before it is
 * stored in gate_health. Keeps only the two known sub-records with schemaVersion 1 and a known
 * status; anything else is dropped rather than stored.
 */
export function parseRatchetShadowHealth(value: unknown): RatchetShadowHealth | undefined {
  if (!isRecord(value)) return undefined;
  const out: RatchetShadowHealth = {};
  const cp = value.composedProof;
  if (
    isRecord(cp) &&
    cp.schemaVersion === 1 &&
    typeof cp.candidate === 'string' &&
    typeof cp.repairHead === 'string' &&
    (cp.status === 'planned' || cp.status === 'skipped' || cp.status === 'error')
  ) {
    out.composedProof = cp as unknown as ComposedProofShadowRecord;
  }
  const nr = value.newRedEjection;
  if (
    isRecord(nr) &&
    nr.schemaVersion === 1 &&
    typeof nr.candidate === 'string' &&
    (nr.status === 'planned' || nr.status === 'nothing-new' || nr.status === 'skipped' || nr.status === 'error')
  ) {
    out.newRedEjection = nr as unknown as NewRedEjectionShadowRecord;
  }
  return out.composedProof || out.newRedEjection ? out : undefined;
}
