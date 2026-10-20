/**
 * NEW-RED EJECTION (green-main-ratchet-convergence-2026-10-17 P-007, R-6; decisions D-002, D-003).
 *
 * WHY. Under the ratchet, a candidate whose round 1 shows a failure that was not failing at the
 * previous promotion used to freeze the whole candidate, so one commit's break held every other
 * commit in the batch. When the new failure can be pinned on one commit, that commit is removed
 * from the candidate instead, the rest promotes, and the red goes back to the commit's author.
 * Only failures nobody can be blamed for still freeze the candidate.
 *
 * The rule, in order (each step fails closed):
 *   1. ATTRIBUTE by radius. A new failure is attributed to a commit only when exactly one commit
 *      in the candidate selects the failing test (`affected-tests --changed-paths <commit's
 *      paths> --related`). No commit, several commits, or a radius that cannot be computed
 *      leaves it unattributable.
 *   2. BLAME CHECK (D-003). Re-run the test on the candidate WITHOUT that commit. Only a pass
 *      there confirms the commit as the cause. A fail means the test was broken before the
 *      commit (a test outside every earlier radius failing first against an unrelated change),
 *      so the commit is innocent and is NOT ejected. An unreadable result confirms nothing.
 *   3. EJECT every confirmed commit together, then RE-TEST the affected radius of the ejected
 *      candidate: the failing tests plus every test the ejected commits' radius selects.
 *   4. PROMOTE the ejected candidate only when that re-test is fully measured and no test in it
 *      fails that was not already failing at the previous promotion. Unattributable failures
 *      (and anything the re-test turns up) freeze the ejected candidate, never the original.
 *   5. ROUTE each ejection to its commit's author, naming the tests; an unknown author is
 *      reported as such, never silently dropped.
 *
 * PURE apart from the `NewRedEjectionDeps` seam (building a candidate without some commits,
 * running tests at a sha, routing to an author), which `runNewRedEjection` drives. Every
 * decision is unit-tested in new-red-ejection.test.ts.
 */

/** One commit in the candidate since the previous promotion (oldest first). */
export interface CandidateCommit {
  sha: string;
  /** The author the red is routed to; null when the commit carries no resolvable author. */
  author: string | null;
  /** Repo-relative paths the commit changed. */
  paths: readonly string[];
}

export type UnattributableReason =
  | 'no-commit-selects-test'
  | 'several-commits-select-test'
  | 'radius-unknown'
  | 'fails-without-commit'
  | 'blame-check-undetermined'
  | 'candidate-without-commit-unbuildable';

export type FailureAttribution =
  | { test: string; kind: 'attributed'; commit: string }
  | { test: string; kind: 'unattributable'; reason: UnattributableReason; commits: string[] };

/** Whether a commit's radius selects a test: true / false, or null when the radius cannot be computed. */
export type SelectsTest = (commit: CandidateCommit, test: string) => boolean | null;

function norm(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Step 1: attribute each new failure to the single commit whose radius selects it. */
export function attributeByRadius(input: {
  newFailures: readonly string[];
  commits: readonly CandidateCommit[];
  selectsTest: SelectsTest;
}): FailureAttribution[] {
  const out: FailureAttribution[] = [];
  for (const raw of new Set(input.newFailures.map(norm).filter(Boolean))) {
    const selecting: string[] = [];
    let unknown = false;
    for (const c of input.commits) {
      const s = input.selectsTest(c, raw);
      if (s === null) unknown = true;
      else if (s) selecting.push(c.sha);
    }
    if (unknown) out.push({ test: raw, kind: 'unattributable', reason: 'radius-unknown', commits: selecting });
    else if (selecting.length === 0) out.push({ test: raw, kind: 'unattributable', reason: 'no-commit-selects-test', commits: [] });
    else if (selecting.length > 1) out.push({ test: raw, kind: 'unattributable', reason: 'several-commits-select-test', commits: selecting });
    else out.push({ test: raw, kind: 'attributed', commit: selecting[0] });
  }
  return out;
}

/**
 * Step 2 (D-003): confirm each attribution with the test's verdict on the candidate without the
 * attributed commit. `withoutCommit.get(commit)` is that run's per-test verdicts, or null when the
 * candidate without the commit could not be built.
 */
export function applyBlameCheck(
  attributions: readonly FailureAttribution[],
  withoutCommit: ReadonlyMap<string, ReadonlyMap<string, boolean | null> | null>,
): FailureAttribution[] {
  return attributions.map((a) => {
    if (a.kind !== 'attributed') return a;
    const run = withoutCommit.get(a.commit);
    if (run === undefined || run === null) {
      return { test: a.test, kind: 'unattributable', reason: 'candidate-without-commit-unbuildable', commits: [a.commit] };
    }
    const v = run.get(a.test);
    if (v === true) return a;
    if (v === false) return { test: a.test, kind: 'unattributable', reason: 'fails-without-commit', commits: [a.commit] };
    return { test: a.test, kind: 'unattributable', reason: 'blame-check-undetermined', commits: [a.commit] };
  });
}

export interface EjectionRoute {
  commit: string;
  /** null = the commit carries no resolvable author; reported, not dropped. */
  author: string | null;
  unattributedAuthor: boolean;
  tests: string[];
}

export type EjectionPlan =
  | { kind: 'none' }
  | {
      /** Every new failure is unattributable: freeze the candidate as before. */
      kind: 'freeze';
      unattributable: Extract<FailureAttribution, { kind: 'unattributable' }>[];
    }
  | {
      kind: 'eject';
      ejected: string[];
      routes: EjectionRoute[];
      /** Tests to re-run on the ejected candidate before it may promote. */
      retestRadius: string[];
      /** Failures still unattributable: they freeze the EJECTED candidate if they persist. */
      unattributable: Extract<FailureAttribution, { kind: 'unattributable' }>[];
    };

/** Step 3: the plan — which commits to eject, whom to route to, and what to re-test. */
export function planEjection(input: {
  confirmed: readonly FailureAttribution[];
  commits: readonly CandidateCommit[];
  /** Every test a commit's radius selects (the tests to re-test after removing it); null = unknown. */
  radiusOf: (commit: CandidateCommit) => readonly string[] | null;
}): EjectionPlan {
  if (input.confirmed.length === 0) return { kind: 'none' };
  type Unattr = Extract<FailureAttribution, { kind: 'unattributable' }>;
  const unattributable: Unattr[] = input.confirmed.filter((a): a is Unattr => a.kind === 'unattributable');
  const bySha = new Map(input.commits.map((c) => [c.sha, c] as const));
  const testsByCommit = new Map<string, string[]>();
  const radiusByCommit = new Map<string, readonly string[]>();
  for (const a of input.confirmed) {
    if (a.kind !== 'attributed') continue;
    const commit = bySha.get(a.commit);
    // A commit whose radius cannot be computed cannot be re-tested after removal, so it is
    // not ejected: its failures stay unattributable (fail closed). Other commits still eject.
    const r = commit ? (radiusByCommit.get(a.commit) ?? input.radiusOf(commit)) : null;
    if (r === null) {
      unattributable.push({ test: a.test, kind: 'unattributable', reason: 'radius-unknown', commits: [a.commit] });
      continue;
    }
    radiusByCommit.set(a.commit, r);
    testsByCommit.set(a.commit, [...(testsByCommit.get(a.commit) ?? []), a.test]);
  }
  if (testsByCommit.size === 0) return { kind: 'freeze', unattributable };
  // Keep the candidate's commit order so the ejection is reproducible.
  const ejected = input.commits.map((c) => c.sha).filter((sha) => testsByCommit.has(sha));
  // Re-test every new failure (including the unattributable ones) plus the ejected commits' radius.
  const radius = new Set<string>(input.confirmed.map((a) => a.test));
  for (const sha of ejected) for (const t of radiusByCommit.get(sha) ?? []) radius.add(norm(t));
  const routes: EjectionRoute[] = ejected.map((sha) => {
    const author = bySha.get(sha)?.author ?? null;
    return { commit: sha, author, unattributedAuthor: !author, tests: [...new Set(testsByCommit.get(sha))].sort() };
  });
  return { kind: 'eject', ejected, routes, retestRadius: [...radius].sort(), unattributable };
}

export type EjectionOutcome =
  | { kind: 'promote'; newFailures: []; reason: string }
  | { kind: 'freeze'; newFailures: string[]; unmeasured: string[]; reason: string };

/**
 * Step 4: after the re-test of the ejected candidate. Promotable only when every radius test
 * was measured and none fails that was not already failing at the previous promotion.
 * `failingAtBase` is the set of tests already red at the previous promotion (carried, not new).
 */
export function decideAfterEjection(input: {
  plan: Extract<EjectionPlan, { kind: 'eject' }>;
  retest: ReadonlyMap<string, boolean | null>;
  failingAtBase: ReadonlySet<string>;
}): EjectionOutcome {
  const newFailures: string[] = [];
  const unmeasured: string[] = [];
  for (const t of input.plan.retestRadius) {
    const v = input.retest.get(t);
    if (v === undefined || v === null) unmeasured.push(t);
    else if (v === false && !input.failingAtBase.has(t)) newFailures.push(t);
  }
  if (newFailures.length > 0) {
    return { kind: 'freeze', newFailures, unmeasured, reason: `${newFailures.length} test(s) still fail on the ejected candidate that did not fail at the previous promotion` };
  }
  if (unmeasured.length > 0) {
    return { kind: 'freeze', newFailures, unmeasured, reason: `${unmeasured.length} radius test(s) were not measured on the ejected candidate; an unmeasured re-test never promotes` };
  }
  return { kind: 'promote', newFailures: [], reason: `ejected ${input.plan.ejected.length} commit(s); the affected radius (${input.plan.retestRadius.length} test(s)) re-tested with no new failure` };
}

export interface NewRedEjectionDeps {
  /** Build (do not publish) the candidate with `commits` removed; its sha, or null when it cannot be built (a conflicting revert). */
  buildCandidateWithout(candidate: string, commits: readonly string[]): Promise<string | null>;
  /** Run `tests` in a clean tree at `sha`: per-test pass/fail, null = undetermined. */
  runTestsAt(sha: string, tests: readonly string[]): Promise<Map<string, boolean | null>>;
  /** Send the red to the commit's author; returns the routed item id when one was filed. */
  routeToAuthor(route: EjectionRoute & { candidate: string; ejectedCandidate: string }): Promise<string | null>;
  log(line: string): void;
}

export type NewRedEjectionReport =
  | { status: 'nothing-new'; candidate: string }
  | { status: 'frozen'; candidate: string; frozenSha: string; unattributable: FailureAttribution[]; newFailures: string[]; unmeasured: string[]; reason: string }
  | { status: 'promotable'; candidate: string; ejectedCandidate: string; ejected: string[]; routed: Array<{ commit: string; author: string | null; itemId: string | null }>; retested: number; reason: string };

/** Drive steps 1-5 against the deps. Never promotes the ORIGINAL candidate when it carries a new failure. */
export async function runNewRedEjection(
  deps: NewRedEjectionDeps,
  input: {
    candidate: string;
    newFailures: readonly string[];
    failingAtBase: ReadonlySet<string>;
    commits: readonly CandidateCommit[];
    selectsTest: SelectsTest;
    radiusOf: (commit: CandidateCommit) => readonly string[] | null;
  },
): Promise<NewRedEjectionReport> {
  const fresh = input.newFailures.map(norm).filter((t) => t && !input.failingAtBase.has(t));
  if (fresh.length === 0) return { status: 'nothing-new', candidate: input.candidate };
  const attributions = attributeByRadius({ newFailures: fresh, commits: input.commits, selectsTest: input.selectsTest });

  // Blame check: one build + one run per attributed commit, covering all of its tests.
  const testsByCommit = new Map<string, string[]>();
  for (const a of attributions) if (a.kind === 'attributed') testsByCommit.set(a.commit, [...(testsByCommit.get(a.commit) ?? []), a.test]);
  const withoutCommit = new Map<string, Map<string, boolean | null> | null>();
  for (const [commit, tests] of testsByCommit) {
    const sha = await deps.buildCandidateWithout(input.candidate, [commit]);
    withoutCommit.set(commit, sha ? await deps.runTestsAt(sha, tests) : null);
  }
  const confirmed = applyBlameCheck(attributions, withoutCommit);
  const plan = planEjection({ confirmed, commits: input.commits, radiusOf: input.radiusOf });
  if (plan.kind === 'none') return { status: 'nothing-new', candidate: input.candidate };
  if (plan.kind === 'freeze') {
    deps.log(`[new-red-ejection] ${plan.unattributable.length} unattributable new failure(s): candidate ${input.candidate.slice(0, 10)} freezes`);
    return { status: 'frozen', candidate: input.candidate, frozenSha: input.candidate, unattributable: plan.unattributable, newFailures: fresh, unmeasured: [], reason: 'every new failure is unattributable' };
  }
  const ejectedCandidate = await deps.buildCandidateWithout(input.candidate, plan.ejected);
  if (!ejectedCandidate) {
    return { status: 'frozen', candidate: input.candidate, frozenSha: input.candidate, unattributable: confirmed.filter((a) => a.kind === 'unattributable'), newFailures: fresh, unmeasured: [], reason: `the candidate without ${plan.ejected.length} confirmed commit(s) could not be built` };
  }
  const retest = await deps.runTestsAt(ejectedCandidate, plan.retestRadius);
  const outcome = decideAfterEjection({ plan, retest, failingAtBase: input.failingAtBase });
  // The red goes to the author whether or not the ejected candidate promotes: the commit is out.
  const routed: Array<{ commit: string; author: string | null; itemId: string | null }> = [];
  for (const route of plan.routes) {
    const itemId = await deps.routeToAuthor({ ...route, candidate: input.candidate, ejectedCandidate });
    routed.push({ commit: route.commit, author: route.author, itemId });
  }
  if (outcome.kind === 'freeze') {
    deps.log(`[new-red-ejection] ejected candidate ${ejectedCandidate.slice(0, 10)} freezes: ${outcome.reason}`);
    return { status: 'frozen', candidate: input.candidate, frozenSha: ejectedCandidate, unattributable: plan.unattributable, newFailures: outcome.newFailures, unmeasured: outcome.unmeasured, reason: outcome.reason };
  }
  return { status: 'promotable', candidate: input.candidate, ejectedCandidate, ejected: plan.ejected, routed, retested: plan.retestRadius.length, reason: outcome.reason };
}
