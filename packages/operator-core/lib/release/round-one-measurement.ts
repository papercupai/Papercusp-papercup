/**
 * P-016 (green-main-ratchet-convergence-2026-10-17#D-004): measure the full failing set at
 * round 1, and compare like with like.
 *
 * WHY (measured by P-001, report rpt_fde8130c): over 93 consecutive gate measurements, 311 of
 * the 361 failures that made a frozen failing count RISE were tests the previous measurement
 * never ran. The rise was mostly measurement growth, not breakage. Three mechanisms let one
 * round's count be read as if it covered the same tests as another round's:
 *  1. The early changed-file typecheck stops a run BEFORE the affected-test sweep. A queue can
 *     open on a round-1 count that measured no tests at all, and that count becomes the low
 *     that the bounded-life rule measures every later round against.
 *  2. A round that measured no tests carries every earlier entry forward and adds its non-test
 *     ids, and the persisted count is capped at `FROZEN_REPAIR_PERSISTED_FAILURE_CAP`. A count
 *     at the cap only says "at least the cap", so 300 → 60 reads as 50 → 50.
 *  3. A run whose failures come from the host was counted as code reds. 54150acf (2026-10-12)
 *     recorded 1,474 failures from ENOSPC on a 2-file admission. The existing disk classifier
 *     needs a low disk sample after the suite, and that space had been freed by then.
 * The bounded-life `non-improving` retirement reads the per-round count, so each mechanism can
 * retire a queue that is converging, or keep a fake low that no real round can beat.
 *
 * THE RULES (pure here; `green-checkpoint` and `frozen-repair-bounded-life` apply them):
 *  - ROUND 1 MEASURES THE SUITE. When no repair queue is open, an early typecheck failure no
 *    longer skips the affected-test sweep. The red carries both result sets, and its round is a
 *    suite measurement. Later rounds keep the early stop, because the queue already has a
 *    baseline and the round is recorded as `non-test-only`.
 *  - LIKE FOR LIKE. The convergence trajectory compares only rounds that measured the test
 *    population. The first such round is the baseline. Rounds whose count hit the persistence
 *    cap are skipped, because their real size is unknown. A skipped round can neither set a new
 *    low nor count as a round without improvement.
 *  - ENVIRONMENT-DOMINATED RUNS ARE INCONCLUSIVE. When at least
 *    `ENVIRONMENT_DOMINANCE_MIN_FILES` failing files, and at least
 *    `ENVIRONMENT_DOMINANCE_MIN_SHARE` of all failing files, show a host-resource signature
 *    (ENOSPC, EDQUOT, EMFILE/ENFILE, ENOMEM), the run renders no code verdict. No round is
 *    recorded and the next fire measures again. The file threshold keeps one test whose title
 *    mentions ENOSPC from voiding a real red.
 *
 * WHAT IT DOES NOT CHANGE. The `age` bound reads no count, so its 24h retirement is unchanged.
 * The persistence cap itself is P-017's (case-level tracking).
 */
import type { FrozenRepairConvergenceRound } from './frozen-candidate-repair-queue';

/** What a recorded round measured. Absent on a persisted round = legacy, read as `suite`. */
export type FrozenRepairRoundMeasurement = 'suite' | 'non-test-only';

/** Signature kinds that only the affected-test sweep measures. */
export const ROUND_SUITE_KINDS: readonly string[] = ['test-file', 'workspace-task', 'seed'];

/**
 * PURE: classify a round from the kinds its run measured (`RepairSignatureRedInput.measuredKinds`).
 * Absent means "every kind" (a full replacement), so it is a suite measurement. An explicit list
 * with no suite kind is a run that stopped before the sweep.
 */
export function roundMeasurementFromKinds(
  measuredKinds: readonly string[] | undefined,
): FrozenRepairRoundMeasurement {
  if (measuredKinds === undefined) return 'suite';
  return measuredKinds.some((kind) => ROUND_SUITE_KINDS.includes(kind)) ? 'suite' : 'non-test-only';
}

/**
 * PURE: should a run whose early changed-file typecheck failed still run the affected-test
 * sweep? Yes exactly when the run is NOT verifying a repair head. Every other run judges a
 * queue's immutable candidate (round 1), and its count is the baseline every later round is
 * compared with.
 *
 * The input is "verifying a repair head", NOT "a repair queue is open": production persists
 * the queue BEFORE the early typecheck on a candidate's very first run ("stable-candidate queue
 * persisted … before its first suite"), so an open queue does not mean a later round. Keying
 * on the open queue made this rule unreachable in production.
 */
export function shouldRunSuiteAfterEarlyTypecheckFailure(input: {
  verifyingRepairHead: boolean;
}): boolean {
  return !input.verifyingRepairHead;
}

/** The fields of a gate result that the early-typecheck merge reads and writes. */
export interface EarlyTypecheckMergeable {
  green: boolean | null;
  summary: string;
  failingTests?: string[];
  postSuiteMeasured?: boolean;
  postSuiteLegs?: readonly unknown[];
  infraFault?: unknown;
}

/**
 * PURE: combine round 1's early typecheck red with the suite that ran after it. The early red
 * stays a red: the result is never green, and its failing ids are listed before the suite's.
 * If the suite itself was inconclusive (an infra fault), it measured nothing reliable, so the
 * early red is returned unchanged and the round stays `non-test-only`.
 */
export function mergeEarlyTypecheckRedIntoSuite<
  Suite extends EarlyTypecheckMergeable,
  Early extends EarlyTypecheckMergeable,
>(suite: Suite, early: Early): { result: Suite | Early; suiteMeasured: boolean } {
  if (suite.infraFault) return { result: early, suiteMeasured: false };
  const failingTests = [...new Set([...(early.failingTests ?? []), ...(suite.failingTests ?? [])])];
  const suiteLegsMeasured = suite.postSuiteMeasured === true;
  const merged: Suite = {
    ...suite,
    green: false,
    summary: `${early.summary}\n\nAffected-test sweep (P-016: round 1 measures the suite even after an early typecheck red):\n${suite.summary}`,
    failingTests,
    postSuiteMeasured: suiteLegsMeasured || early.postSuiteMeasured === true,
    ...(suiteLegsMeasured
      ? {}
      : early.postSuiteLegs
        ? { postSuiteLegs: early.postSuiteLegs }
        : {}),
  };
  return { result: merged, suiteMeasured: true };
}

export type LikeForLikeExclusionReason = 'no-suite-measurement' | 'saturated';

export interface LikeForLikeTrajectory {
  /** Every recorded round, comparable or not. */
  roundsRecorded: number;
  /** Rounds that measured the test population and whose count is below the cap. */
  comparableRounds: number;
  /** The first comparable round, or null when there is none yet. */
  baselineRound: number | null;
  /** Comparable rounds after the last one that set a new strict low. */
  roundsSinceLow: number;
  lowestFailingCount: number | null;
  /** The latest COMPARABLE round's count (not the latest recorded round's). */
  latestFailingCount: number | null;
  excludedRounds: { round: number; reason: LikeForLikeExclusionReason }[];
}

/**
 * PURE: the convergence shape over comparable rounds only. Rounds are ordered by their stable
 * `round` number. A round that measured no tests is skipped, and so is a round whose count
 * reached `saturationCap`. Legacy rounds without a `measurement` field are read as suite rounds,
 * which keeps the previous behaviour for queues written before P-016.
 */
export function likeForLikeTrajectory(
  rounds: readonly Pick<FrozenRepairConvergenceRound, 'round' | 'failingCount' | 'measurement'>[] | undefined,
  options: { saturationCap: number },
): LikeForLikeTrajectory {
  const ordered = [...(rounds ?? [])].sort((a, b) => a.round - b.round);
  const excludedRounds: LikeForLikeTrajectory['excludedRounds'] = [];
  const comparable: { round: number; failingCount: number }[] = [];
  for (const entry of ordered) {
    if (entry.measurement === 'non-test-only') {
      excludedRounds.push({ round: entry.round, reason: 'no-suite-measurement' });
    } else if (entry.failingCount >= options.saturationCap) {
      excludedRounds.push({ round: entry.round, reason: 'saturated' });
    } else {
      comparable.push({ round: entry.round, failingCount: entry.failingCount });
    }
  }
  let lowest: number | null = null;
  let lowIndex = -1;
  comparable.forEach((entry, index) => {
    if (lowest === null || entry.failingCount < lowest) {
      lowest = entry.failingCount;
      lowIndex = index;
    }
  });
  const latest = comparable[comparable.length - 1];
  return {
    roundsRecorded: ordered.length,
    comparableRounds: comparable.length,
    baselineRound: comparable[0]?.round ?? null,
    roundsSinceLow: lowIndex < 0 ? 0 : comparable.length - 1 - lowIndex,
    lowestFailingCount: lowest,
    latestFailingCount: latest ? latest.failingCount : null,
    excludedRounds,
  };
}

/** Host-resource signatures. Each names a resource the host ran out of, never code behaviour. */
export const ENVIRONMENT_FAILURE_SIGNATURES: readonly { id: string; pattern: RegExp }[] = [
  { id: 'ENOSPC', pattern: /\bENOSPC\b|no space left on device/i },
  { id: 'EDQUOT', pattern: /\bEDQUOT\b|disk quota exceeded/i },
  { id: 'EMFILE', pattern: /\bE[MN]FILE\b|too many open files/i },
  { id: 'ENOMEM', pattern: /\bENOMEM\b|cannot allocate memory/i },
];
export const ENVIRONMENT_DOMINANCE_MIN_FILES = 5;
export const ENVIRONMENT_DOMINANCE_MIN_SHARE = 0.5;

export interface EnvironmentDominance {
  failingFiles: number;
  taintedFiles: number;
  share: number;
  /** Signature id → failing files whose failure output carried it. */
  signatures: Record<string, number>;
  /** Up to 10 tainted files, for the log. */
  sampleFiles: string[];
}

// Strip ANSI colour codes; vitest colours its FAIL headers.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const FAIL_HEADER = /\bFAIL\s+(?:\[[^\]]*\]\s+)?(\S+?\.(?:test|spec)\.[cm]?[jt]sx?)\b/;

/**
 * PURE: is this red dominated by host-resource failures? Each failure block runs from a vitest
 * `FAIL <file>` header to the next header. A file is tainted when any of its blocks carries a
 * signature. Returns null unless both dominance thresholds hold.
 */
export function classifyEnvironmentDominatedRun(output: string): EnvironmentDominance | null {
  const failing = new Set<string>();
  const tainted = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '');
    const header = FAIL_HEADER.exec(line);
    if (header) {
      current = header[1] as string;
      failing.add(current);
    }
    if (current === null) continue;
    for (const signature of ENVIRONMENT_FAILURE_SIGNATURES) {
      if (!signature.pattern.test(line)) continue;
      const ids = tainted.get(current) ?? new Set<string>();
      ids.add(signature.id);
      tainted.set(current, ids);
    }
  }
  if (failing.size === 0) return null;
  const share = tainted.size / failing.size;
  if (tainted.size < ENVIRONMENT_DOMINANCE_MIN_FILES || share < ENVIRONMENT_DOMINANCE_MIN_SHARE) return null;
  const signatures: Record<string, number> = {};
  for (const ids of tainted.values()) {
    for (const id of ids) signatures[id] = (signatures[id] ?? 0) + 1;
  }
  return {
    failingFiles: failing.size,
    taintedFiles: tainted.size,
    share,
    signatures,
    sampleFiles: [...tainted.keys()].slice(0, 10),
  };
}
