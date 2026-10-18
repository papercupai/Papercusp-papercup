/**
 * Determinism — plan green-main-ratchet-convergence-2026-10-17, P-008 (R-7, rule R6, scenario S4).
 *
 * A test whose verdict differs on the SAME commit is not telling the gate anything about the
 * code. Counting it makes a frozen candidate's failing count rise and fall with host weather,
 * and lets one nondeterministic file hold main. P-001 measured 31 such (commit, file) results
 * out of 210,286 (D-004): rare, but each one costs a whole repair round when it counts.
 *
 * THE RULES (pure here; `green-checkpoint` applies them):
 *  - DETECT. A flip is one test (file, or file + case) with at least one `pass` and at least one
 *    `fail` measured on one commit. Only measured verdicts count: skipped, cancelled, still
 *    running, and dirty-tree results are not observations of the commit.
 *  - QUARANTINE, OWNED. A flipping test moves to an automatic quarantine. A quarantine is a
 *    `flaky-quarantine` row in the downgrade store (harness_shared.test_downgrades, P-002), so
 *    it carries the same record as a downgrade: owner, reason, a filed work-item (the
 *    DE-QUARANTINE item, in `bug_id`), author and time. The record cannot be built without an
 *    owner and a de-quarantine work-item id: an unowned quarantine is refused, and the test
 *    keeps counting. Revoking the row de-quarantines the test.
 *  - CRITICAL AREAS. A flipping test in a critical area (P-003) is quarantined too, because a
 *    test that flips cannot tell the gate whether that area is broken. The record names the area
 *    and its risk, and the owner is notified at once (D-006's notice, applied automatically).
 *  - STOP COUNTING. An active quarantine removes the test from the gate's failure count. A
 *    file-level quarantine covers every case in the file; a case-level one covers only its case.
 *  - SAME POPULATION. Two rounds' counts are compared only over tests both rounds measured,
 *    minus every quarantined test. A test only one round measured is reported, never compared.
 */
import { classifyCriticalArea, type CriticalArea } from './critical-area-registry';
import { testDowngradeKey, type NewTestDowngrade, type TestDowngradeRecord } from './test-downgrade-store';

/** The downgrade-store kind for an automatic same-commit-flip quarantine. */
export const FLAKY_QUARANTINE_KIND = 'flaky-quarantine' as const;
/** The author stamped on every automatic quarantine. */
export const FLAKY_QUARANTINE_AUTHOR = 'system:verdict-flip-quarantine';

export type ObservedVerdict = 'pass' | 'fail';

/** One measured verdict of one test on one commit. */
export interface SameCommitObservation {
  commitSha: string;
  /** Repo-relative test file. */
  testFile: string;
  /** Full case name, or empty/absent for a file-level verdict. */
  testCase?: string | null;
  verdict: ObservedVerdict;
  /** Where the verdict came from (`suite`, `isolation`, `test_runs:<id>`), for the record. */
  source: string;
}

export interface VerdictFlip {
  commitSha: string;
  testFile: string;
  testCase: string;
  passes: number;
  fails: number;
  sources: string[];
}

const norm = (value: string | null | undefined) => String(value ?? '').trim();
const normFile = (value: string) => norm(value).replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * PURE: every test with both a pass and a fail measured on the same commit. Ordered by commit,
 * then file, then case, so the result is stable.
 */
export function detectSameCommitVerdictFlips(observations: readonly SameCommitObservation[]): VerdictFlip[] {
  const groups = new Map<string, VerdictFlip>();
  for (const obs of observations) {
    const commitSha = norm(obs.commitSha);
    const testFile = normFile(obs.testFile);
    if (!commitSha || !testFile) continue;
    if (obs.verdict !== 'pass' && obs.verdict !== 'fail') continue;
    const testCase = norm(obs.testCase);
    const key = `${commitSha}\u0000${testDowngradeKey(testFile, testCase)}`;
    const group = groups.get(key) ?? { commitSha, testFile, testCase, passes: 0, fails: 0, sources: [] };
    if (obs.verdict === 'pass') group.passes += 1;
    else group.fails += 1;
    if (obs.source && !group.sources.includes(obs.source)) group.sources.push(obs.source);
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((g) => g.passes > 0 && g.fails > 0)
    .sort((a, b) =>
      a.commitSha === b.commitSha
        ? a.testFile === b.testFile
          ? a.testCase.localeCompare(b.testCase)
          : a.testFile.localeCompare(b.testFile)
        : a.commitSha.localeCompare(b.commitSha),
    );
}

/** A store row as far as quarantine and counting read it. */
export type QuarantineStoreRow = Pick<TestDowngradeRecord, 'testFile' | 'testCase' | 'revokedAt'> & {
  kind?: string | null;
};

/** PURE: does an ACTIVE row of any kind already make this test non-blocking? */
function activeRowFor(rows: readonly QuarantineStoreRow[], testFile: string, testCase: string): QuarantineStoreRow | null {
  const key = testDowngradeKey(testFile, testCase);
  const fileKey = testDowngradeKey(testFile, '');
  return (
    rows.find((row) => {
      if (row.revokedAt !== null) return false;
      const rowKey = testDowngradeKey(row.testFile, row.testCase);
      return rowKey === key || rowKey === fileKey;
    }) ?? null
  );
}

export interface QuarantineAction {
  flip: VerdictFlip;
  owner: string;
  criticalArea: CriticalArea | null;
  /** True for a critical-area test: the owner is notified at once. */
  notifyOwner: boolean;
}

export interface QuarantinePlan {
  toQuarantine: QuarantineAction[];
  /** Flips whose test an active row (quarantine or downgrade) already covers. */
  alreadyCovered: VerdictFlip[];
  /** Flips no owner could be resolved for: NOT quarantined, so they keep counting. */
  unowned: VerdictFlip[];
}

/**
 * PURE: which flips to quarantine now. One action per test (file + case), however many commits
 * it flipped on. A test already covered by an active row needs nothing new.
 */
export function planVerdictFlipQuarantine(input: {
  flips: readonly VerdictFlip[];
  active: readonly QuarantineStoreRow[];
  ownerOf: (flip: VerdictFlip) => string | null;
}): QuarantinePlan {
  const plan: QuarantinePlan = { toQuarantine: [], alreadyCovered: [], unowned: [] };
  const seen = new Set<string>();
  for (const flip of input.flips) {
    const key = testDowngradeKey(flip.testFile, flip.testCase);
    if (seen.has(key)) continue;
    seen.add(key);
    if (activeRowFor(input.active, flip.testFile, flip.testCase)) {
      plan.alreadyCovered.push(flip);
      continue;
    }
    const owner = norm(input.ownerOf(flip));
    if (!owner) {
      plan.unowned.push(flip);
      continue;
    }
    const criticalArea = classifyCriticalArea(flip.testFile);
    plan.toQuarantine.push({ flip, owner, criticalArea, notifyOwner: criticalArea !== null });
  }
  return plan;
}

function target(flip: Pick<VerdictFlip, 'testFile' | 'testCase'>): string {
  return flip.testCase ? `${flip.testFile} > ${flip.testCase}` : flip.testFile;
}

/** PURE: the de-quarantine work-item filed for one action. Its id becomes the record's `bugId`. */
export function dequarantineWorkItemDraft(action: QuarantineAction): {
  title: string;
  body: string;
  assignee: string;
  severity: 'major' | 'minor';
} {
  const { flip } = action;
  const area = action.criticalArea
    ? `\n\nCritical area: ${action.criticalArea.label}. While quarantined, main can promote with this area unchecked: ${action.criticalArea.risk}.`
    : '';
  return {
    title: `De-quarantine flaky test ${target(flip)} (verdict flipped on ${flip.commitSha.slice(0, 10)})`,
    body:
      `The green-checkpoint gate measured ${flip.passes} pass and ${flip.fails} fail for '${target(flip)}' on the same commit ` +
      `${flip.commitSha} (sources: ${flip.sources.join(', ') || 'unknown'}), so it was quarantined automatically ` +
      `(plan green-main-ratchet-convergence-2026-10-17, P-008). It no longer counts toward the gate.${area}\n\n` +
      `To finish: make the test deterministic (fix the race, timing, shared state or host dependency), confirm it passes ` +
      `repeatedly under the gate's load, then revoke the quarantine with release:test-downgrade { op: 'revoke', id } ` +
      `(op: 'list' shows the row). Revoking makes the test count again.`,
    assignee: action.owner,
    severity: action.criticalArea ? 'major' : 'minor',
  };
}

/** PURE: why a quarantine record cannot be written, or [] when it can. */
export function flakyQuarantineProblems(input: { owner?: string | null; dequarantineWorkItemId?: string | null }): string[] {
  const problems: string[] = [];
  if (!norm(input.owner)) problems.push('missing owner: an automatic quarantine must name who de-quarantines the test');
  if (!norm(input.dequarantineWorkItemId)) {
    problems.push('missing de-quarantine work-item: file it first and pass its id');
  }
  return problems;
}

export type FlakyQuarantineRecord = NewTestDowngrade & { kind: typeof FLAKY_QUARANTINE_KIND };

/**
 * PURE: the downgrade-store row for one quarantine. Refused (ok: false) without an owner or a
 * de-quarantine work-item id, so no unowned quarantine can be written.
 */
export function buildFlakyQuarantineRecord(
  action: QuarantineAction,
  dequarantineWorkItemId: string | null | undefined,
): { ok: true; record: FlakyQuarantineRecord } | { ok: false; problems: string[] } {
  const problems = flakyQuarantineProblems({ owner: action.owner, dequarantineWorkItemId });
  if (problems.length > 0) return { ok: false, problems };
  const { flip, criticalArea } = action;
  return {
    ok: true,
    record: {
      kind: FLAKY_QUARANTINE_KIND,
      testFile: flip.testFile,
      testCase: flip.testCase,
      reason:
        `same-commit verdict flip: ${flip.passes} pass / ${flip.fails} fail on ${flip.commitSha} ` +
        `(${flip.sources.join(', ') || 'unknown source'}); quarantined automatically until made deterministic`,
      owner: action.owner,
      bugId: norm(dequarantineWorkItemId),
      author: FLAKY_QUARANTINE_AUTHOR,
      criticalArea: criticalArea?.id ?? null,
      riskAcknowledgement: criticalArea
        ? `${criticalArea.id}: automatic quarantine of a test that flips on one commit, so it cannot tell whether ` +
          `${criticalArea.label} is broken; accepted risk: ${criticalArea.risk}`
        : null,
    },
  };
}

/** A failing test as the gate counts it. */
export interface CountableFailure {
  testFile: string;
  testCase?: string | null;
}

/**
 * PURE: split failures into those that count and those an ACTIVE quarantine removes. Only
 * `flaky-quarantine` rows apply here: a plain downgrade keeps its own accounting (P-004).
 * A file-level quarantine covers every case of the file; a case-level one only its case.
 */
export function partitionQuarantinedFailures<T extends CountableFailure>(
  failures: readonly T[],
  rows: readonly QuarantineStoreRow[],
): { counted: T[]; quarantined: T[] } {
  const keys = new Set(
    rows
      .filter((row) => row.revokedAt === null && row.kind === FLAKY_QUARANTINE_KIND)
      .map((row) => testDowngradeKey(row.testFile, row.testCase)),
  );
  const counted: T[] = [];
  const quarantined: T[] = [];
  for (const failure of failures) {
    const file = normFile(failure.testFile);
    const covered = keys.has(testDowngradeKey(file, '')) || keys.has(testDowngradeKey(file, failure.testCase));
    (covered ? quarantined : counted).push(failure);
  }
  return { counted, quarantined };
}

/** PURE: the test keys (file, or `file > case`) an active quarantine covers, for population maths. */
export function activeQuarantineKeys(rows: readonly QuarantineStoreRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.revokedAt === null && row.kind === FLAKY_QUARANTINE_KIND)
      .map((row) => testDowngradeKey(row.testFile, row.testCase)),
  );
}

/** One round's measurement: the tests it measured, and those that failed (both as test keys). */
export interface MeasuredRound {
  measured: readonly string[];
  failing: readonly string[];
}

export interface SamePopulationComparison {
  /** Tests both rounds measured, minus quarantined ones. */
  population: number;
  previousFailing: number;
  nextFailing: number;
  direction: 'improved' | 'regressed' | 'unchanged';
  /** Failures outside the shared population: reported, never compared. */
  outsidePopulation: { previousOnly: string[]; nextOnly: string[]; quarantined: string[] };
}

/**
 * PURE: compare two rounds over the SAME measured population. A key matches a quarantine when it
 * equals a quarantined key or its file part is quarantined at file level (`file\0`). Keys are
 * built with `testDowngradeKey`.
 */
export function compareRoundsOverSamePopulation(
  previous: MeasuredRound,
  next: MeasuredRound,
  quarantinedKeys: ReadonlySet<string>,
): SamePopulationComparison {
  const isQuarantined = (key: string) => {
    if (quarantinedKeys.has(key)) return true;
    const file = key.split('\u0000')[0] ?? '';
    return quarantinedKeys.has(`${file}\u0000`);
  };
  const prevMeasured = new Set(previous.measured);
  const nextMeasured = new Set(next.measured);
  const population = new Set([...prevMeasured].filter((key) => nextMeasured.has(key) && !isQuarantined(key)));
  const prevFailing = [...new Set(previous.failing)];
  const nextFailing = [...new Set(next.failing)];
  const previousFailing = prevFailing.filter((key) => population.has(key)).length;
  const nextFailingCount = nextFailing.filter((key) => population.has(key)).length;
  const quarantined = [...new Set([...prevFailing, ...nextFailing].filter(isQuarantined))].sort();
  return {
    population: population.size,
    previousFailing,
    nextFailing: nextFailingCount,
    direction:
      nextFailingCount < previousFailing ? 'improved' : nextFailingCount > previousFailing ? 'regressed' : 'unchanged',
    outsidePopulation: {
      previousOnly: prevFailing.filter((key) => !population.has(key) && !isQuarantined(key)).sort(),
      nextOnly: nextFailing.filter((key) => !population.has(key) && !isQuarantined(key)).sort(),
      quarantined,
    },
  };
}

/** One per-file re-run of the gate's isolation absorber (green-checkpoint `RetriedTest`). */
export interface IsolationRetry {
  /** `workspace::file` for the isolation path; a bare workspace for a worker-crash re-run. */
  name: string;
  outcome: 'passed-on-rerun' | 'still-failing';
  via: 'load-flake-isolation' | 'worker-crash-rerun';
}

/**
 * PURE: same-commit observations from the gate's own isolation re-runs. A file that failed in
 * the suite and passed when re-run alone on the same tree is a fail AND a pass on that commit.
 * A still-failing file contributes only its fail. Worker-crash re-runs name a workspace, not a
 * test, so they yield nothing (there is no test identity to quarantine). Files whose workspace
 * directory cannot be resolved are skipped (fail-closed: they keep counting).
 */
export function observationsFromIsolationRetries(
  commitSha: string,
  retries: readonly IsolationRetry[],
  workspaceDirOf: (workspace: string) => string | null,
): SameCommitObservation[] {
  const out: SameCommitObservation[] = [];
  for (const retry of retries) {
    if (retry.via !== 'load-flake-isolation') continue;
    const sep = retry.name.indexOf('::');
    if (sep <= 0) continue;
    const dir = workspaceDirOf(retry.name.slice(0, sep));
    const file = retry.name.slice(sep + 2).trim();
    if (!dir || !file) continue;
    const testFile = normFile(`${dir.replace(/\/+$/, '')}/${file}`);
    out.push({ commitSha, testFile, verdict: 'fail', source: 'suite' });
    if (retry.outcome === 'passed-on-rerun') out.push({ commitSha, testFile, verdict: 'pass', source: 'isolation' });
  }
  return out;
}

/** A `harness_shared.test_runs` row as the cross-run reader returns it. */
export interface TestRunVerdictRow {
  id: number | string;
  commitSha: string;
  filePath: string;
  status: string;
  worktreeDirty: boolean | null;
}

/**
 * PURE: same-commit observations from recorded test runs. Only clean-tree rows with a measured
 * status count: `pass` → pass; `fail` and `error` → fail. A dirty-tree row did not run the
 * commit, and skip / cancelled / running measured nothing.
 */
export function observationsFromTestRuns(rows: readonly TestRunVerdictRow[]): SameCommitObservation[] {
  const out: SameCommitObservation[] = [];
  for (const row of rows) {
    if (row.worktreeDirty !== false) continue;
    const verdict: ObservedVerdict | null =
      row.status === 'pass' ? 'pass' : row.status === 'fail' || row.status === 'error' ? 'fail' : null;
    if (!verdict) continue;
    out.push({ commitSha: row.commitSha, testFile: row.filePath, verdict, source: `test_runs:${row.id}` });
  }
  return out;
}
