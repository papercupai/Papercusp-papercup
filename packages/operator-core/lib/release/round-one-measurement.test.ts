import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_DOMINANCE_MIN_FILES,
  type EarlyTypecheckMergeable,
  classifyEnvironmentDominatedRun,
  likeForLikeTrajectory,
  mergeEarlyTypecheckRedIntoSuite,
  roundMeasurementFromKinds,
  shouldRunSuiteAfterEarlyTypecheckFailure,
} from './round-one-measurement';
import { FROZEN_REPAIR_PERSISTED_FAILURE_CAP } from './frozen-candidate-repair-queue';
import { frozenRepairConvergenceTrajectory } from './frozen-repair-bounded-life';

const CAP = { saturationCap: FROZEN_REPAIR_PERSISTED_FAILURE_CAP };

type Round = { round: number; failingCount: number; measurement?: 'suite' | 'non-test-only' };
const series = (counts: readonly number[]): Round[] =>
  counts.map((failingCount, index) => ({ round: index + 1, failingCount }));

describe('P-016 round measurement', () => {
  it('reads absent kinds as a full suite measurement and a kind list without suite kinds as non-test-only', () => {
    expect(roundMeasurementFromKinds(undefined)).toBe('suite');
    expect(roundMeasurementFromKinds(['test-file', 'workspace-task', 'seed'])).toBe('suite');
    expect(roundMeasurementFromKinds(['seed'])).toBe('suite');
    expect(roundMeasurementFromKinds([])).toBe('non-test-only');
    expect(roundMeasurementFromKinds(['lint-leg', 'post-suite-leg'])).toBe('non-test-only');
  });

  it('runs the suite after an early typecheck red unless the run verifies a repair head', () => {
    // Round 1 judges the queue's immutable candidate — even when the queue row already exists.
    expect(shouldRunSuiteAfterEarlyTypecheckFailure({ verifyingRepairHead: false })).toBe(true);
    expect(shouldRunSuiteAfterEarlyTypecheckFailure({ verifyingRepairHead: true })).toBe(false);
  });
});

describe('P-016 early typecheck merge', () => {
  const early = {
    green: false as boolean | null,
    summary: 'Early changed-file typecheck failed',
    failingTests: ['lint:tsc'],
    postSuiteMeasured: true,
    postSuiteLegs: [{ id: 'lint:tsc', status: 'failed' }],
  };

  it('keeps the early red: never green, early ids first, suite ids added', () => {
    // Typed as the merge contract: a suite result that never measured post-suite legs.
    const suite: EarlyTypecheckMergeable = { green: true, summary: 'suite green', failingTests: [] };
    const { result, suiteMeasured } = mergeEarlyTypecheckRedIntoSuite(suite, early);
    expect(suiteMeasured).toBe(true);
    expect(result.green).toBe(false);
    expect(result.failingTests).toEqual(['lint:tsc']);
    expect(result.summary).toContain('Early changed-file typecheck failed');
    expect(result.summary).toContain('suite green');
    // The suite did not measure post-suite legs, so the early inventory's legs are kept.
    expect(result.postSuiteMeasured).toBe(true);
    expect(result.postSuiteLegs).toEqual(early.postSuiteLegs);
  });

  it('unions a red suite with the early ids without duplicates', () => {
    const suite = {
      green: false as boolean | null,
      summary: 'suite red',
      failingTests: ['a.test.ts', 'lint:tsc', 'b.test.ts'],
      postSuiteMeasured: true,
      postSuiteLegs: [{ id: 'lint:knip', status: 'failed' }],
    };
    const { result } = mergeEarlyTypecheckRedIntoSuite(suite, early);
    expect(result.failingTests).toEqual(['lint:tsc', 'a.test.ts', 'b.test.ts']);
    expect(result.postSuiteLegs).toEqual(suite.postSuiteLegs);
  });

  it('returns the early red unchanged when the suite was infra-inconclusive', () => {
    const suite = { green: null as boolean | null, summary: 'host fault', infraFault: { kind: 'suite-signaled' } };
    const { result, suiteMeasured } = mergeEarlyTypecheckRedIntoSuite(suite, early);
    expect(suiteMeasured).toBe(false);
    expect(result).toBe(early);
  });
});

describe('P-016 like-for-like trajectory', () => {
  it('matches the pre-P-016 computation on legacy rounds below the cap', () => {
    expect(likeForLikeTrajectory(series([3, 5, 8, 12, 28]), CAP)).toMatchObject({
      roundsRecorded: 5,
      comparableRounds: 5,
      baselineRound: 1,
      roundsSinceLow: 4,
      lowestFailingCount: 3,
      latestFailingCount: 28,
      excludedRounds: [],
    });
    expect(likeForLikeTrajectory(series([10, 8, 9, 9, 6]), CAP).roundsSinceLow).toBe(0);
  });

  it('does not let a round-1 count that measured no tests become the low', () => {
    // Round 1 stopped at the early typecheck: its count is `lint:tsc` alone. The old
    // trajectory took 1 as the low and called every later round non-improving.
    const rounds: Round[] = [
      { round: 1, failingCount: 1, measurement: 'non-test-only' },
      { round: 2, failingCount: 46 },
      { round: 3, failingCount: 31 },
      { round: 4, failingCount: 33 },
      { round: 5, failingCount: 32 },
      { round: 6, failingCount: 34 },
    ];
    const trajectory = likeForLikeTrajectory(rounds, CAP);
    expect(trajectory.baselineRound).toBe(2);
    expect(trajectory.lowestFailingCount).toBe(31);
    expect(trajectory.roundsSinceLow).toBe(3);
    expect(trajectory.excludedRounds).toEqual([{ round: 1, reason: 'no-suite-measurement' }]);
    // The same rounds read as raw counts would already have retired the queue.
    expect(likeForLikeTrajectory(rounds.map(({ round, failingCount }) => ({ round, failingCount })), CAP).roundsSinceLow).toBe(5);
  });

  it('skips non-test-only rounds after the baseline: they are neither a low nor a stall', () => {
    const rounds: Round[] = [
      { round: 1, failingCount: 20 },
      { round: 2, failingCount: 3, measurement: 'non-test-only' },
      { round: 3, failingCount: 18 },
    ];
    expect(likeForLikeTrajectory(rounds, CAP)).toMatchObject({
      comparableRounds: 2,
      lowestFailingCount: 18,
      roundsSinceLow: 0,
      latestFailingCount: 18,
    });
  });

  it('skips counts at the persistence cap: "at least 50" cannot be compared', () => {
    const atCap = FROZEN_REPAIR_PERSISTED_FAILURE_CAP;
    // A true 300 → 60 descent persists as 50, 50, 50, 50, 50: raw, that is four rounds
    // without a new low and a non-improving retirement.
    expect(likeForLikeTrajectory(series([atCap, atCap, atCap, atCap, atCap]), CAP)).toMatchObject({
      comparableRounds: 0,
      baselineRound: null,
      roundsSinceLow: 0,
      lowestFailingCount: null,
    });
    expect(likeForLikeTrajectory(series([atCap, 40, 45, 48, 47, 49]), CAP)).toMatchObject({
      baselineRound: 2,
      roundsSinceLow: 4,
      lowestFailingCount: 40,
    });
  });

  // Fixture: the 4a0ab756 → 09b03f6f step measured by P-001 (test_runs source='ci',
  // workspace_id IS NULL). 4a0ab756 (2026-10-13 19:11Z) ran 10 test files, all passing, and
  // was red on a non-test leg. 09b03f6f (22:14Z) ran 5,577 files with 65 failing. All 10
  // shared files passed at both, so like for like the step was 0 → 0. The raw count rose
  // because the population grew, and 65 failing files persist at the 50 cap.
  it('reads the 4a0ab756 → 09b03f6f population growth as no regression', () => {
    const rounds: Round[] = [
      { round: 1, failingCount: 1, measurement: 'non-test-only' }, // 4a0ab756: the non-test red
      { round: 2, failingCount: FROZEN_REPAIR_PERSISTED_FAILURE_CAP }, // 09b03f6f: 65 files, capped
      { round: 3, failingCount: 41 },
      { round: 4, failingCount: 38 },
    ];
    const trajectory = likeForLikeTrajectory(rounds, CAP);
    expect(trajectory.excludedRounds).toEqual([
      { round: 1, reason: 'no-suite-measurement' },
      { round: 2, reason: 'saturated' },
    ]);
    expect(trajectory.baselineRound).toBe(3);
    expect(trajectory.roundsSinceLow).toBe(0);
    expect(trajectory.lowestFailingCount).toBe(38);
  });

  it('is what the bounded-life trajectory reads', () => {
    const rounds = [
      { round: 1, head: 'a', atMs: 1, failingCount: 1, measurement: 'non-test-only' as const },
      ...[46, 31, 33, 32, 34].map((failingCount, index) => ({ round: index + 2, head: 'a', atMs: 1, failingCount })),
    ];
    expect(frozenRepairConvergenceTrajectory(rounds)).toEqual({
      roundsRecorded: 6,
      comparableRounds: 5,
      roundsSinceLow: 3,
      lowestFailingCount: 31,
      latestFailingCount: 34,
    });
  });
});

describe('P-016 environment-dominated runs', () => {
  const block = (file: string, message: string) => [
    ` FAIL  ${file} > suite > case`,
    `Error: ${message}`,
    '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  ];
  const enospc = "ENOSPC: no space left on device, write '/tmp/vitest-x'";

  it('classifies a red whose failing files mostly carry ENOSPC as environment-dominated', () => {
    const output = [
      'RUN v4',
      ...Array.from({ length: 6 }, (_, index) => block(`pkg/lib/f${index}.test.ts`, enospc)).flat(),
      ...block('pkg/lib/real.test.ts', 'expected 1 to be 2'),
      ...block('pkg/lib/fd.test.ts', 'EMFILE: too many open files'),
    ].join('\n');
    const result = classifyEnvironmentDominatedRun(output);
    expect(result).toMatchObject({ failingFiles: 8, taintedFiles: 7, signatures: { ENOSPC: 6, EMFILE: 1 } });
    expect(result?.share).toBeCloseTo(7 / 8);
  });

  it('parses ANSI-coloured FAIL headers', () => {
    const output = Array.from({ length: ENVIRONMENT_DOMINANCE_MIN_FILES }, (_, index) => [
      `\u001b[31m FAIL \u001b[39m pkg/a${index}.test.ts > x`,
      'Error: ENOMEM: Cannot allocate memory',
    ]).flat().join('\n');
    expect(classifyEnvironmentDominatedRun(output)?.taintedFiles).toBe(ENVIRONMENT_DOMINANCE_MIN_FILES);
  });

  it('keeps a real red: one test whose title mentions ENOSPC is below the file floor', () => {
    const output = [...block('pkg/disk-alarm.test.ts', 'ENOSPC expected to page'), ...block('pkg/b.test.ts', 'boom')].join('\n');
    expect(classifyEnvironmentDominatedRun(output)).toBeNull();
  });

  it('keeps a red where host signatures are a minority of failing files', () => {
    const output = [
      ...Array.from({ length: 5 }, (_, index) => block(`pkg/env${index}.test.ts`, enospc)).flat(),
      ...Array.from({ length: 6 }, (_, index) => block(`pkg/code${index}.test.ts`, 'assertion failed')).flat(),
    ].join('\n');
    expect(classifyEnvironmentDominatedRun(output)).toBeNull();
  });

  it('ignores signatures outside any failure block and output with no failing files', () => {
    expect(classifyEnvironmentDominatedRun(`${enospc}\n${enospc}`)).toBeNull();
    expect(classifyEnvironmentDominatedRun('')).toBeNull();
  });
});
