/**
 * P-008 (green-main-ratchet-convergence-2026-10-17, R-7): a test whose verdict differs on the
 * same commit leaves the gate's failure count through an OWNED quarantine with a de-quarantine
 * work-item, and rounds are compared only over the same measured population.
 *
 * R-7 falsifiers this file pins: (1) a flipping test still counts as a failure; (2) it is
 * quarantined without an owner or a de-quarantine work-item; (3) two rounds are compared over
 * different measured populations.
 */
import { describe, expect, it } from 'vitest';
import { criticalAreaAcknowledgementProblem, classifyCriticalArea } from './critical-area-registry';
import { memoryTestDowngradeStore, testDowngradeKey } from './test-downgrade-store';
import {
  FROZEN_REPAIR_PERSISTED_FAILURE_CAP,
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  parseFrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import { likeForLikeTrajectory } from './round-one-measurement';
import {
  FLAKY_QUARANTINE_AUTHOR,
  FLAKY_QUARANTINE_KIND,
  activeQuarantineKeys,
  buildFlakyQuarantineRecord,
  compareRoundsOverSamePopulation,
  dequarantineWorkItemDraft,
  detectSameCommitVerdictFlips,
  flakyQuarantineProblems,
  observationsFromIsolationRetries,
  observationsFromTestRuns,
  partitionQuarantinedFailures,
  planVerdictFlipQuarantine,
  type QuarantineStoreRow,
  type SameCommitObservation,
} from './verdict-flip-quarantine';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const FILE = 'packages/operator-core/lib/memory/injection.test.ts';
const obs = (over: Partial<SameCommitObservation>): SameCommitObservation => ({
  commitSha: SHA,
  testFile: FILE,
  verdict: 'fail',
  source: 'suite',
  ...over,
});

describe('detectSameCommitVerdictFlips', () => {
  it('S4: a fail and a pass of one test on the same commit is a flip', () => {
    const flips = detectSameCommitVerdictFlips([obs({}), obs({ verdict: 'pass', source: 'isolation' })]);
    expect(flips).toEqual([
      { commitSha: SHA, testFile: FILE, testCase: '', passes: 1, fails: 1, sources: ['suite', 'isolation'] },
    ]);
  });

  it('a fail on one commit and a pass on another is NOT a flip (that is a code change)', () => {
    expect(detectSameCommitVerdictFlips([obs({}), obs({ commitSha: OTHER_SHA, verdict: 'pass' })])).toEqual([]);
  });

  it('a consistently failing test is not a flip', () => {
    expect(detectSameCommitVerdictFlips([obs({}), obs({ source: 'isolation' })])).toEqual([]);
  });

  it('keys by file + case: different cases of one file never pair up', () => {
    const flips = detectSameCommitVerdictFlips([
      obs({ testCase: 'case A' }),
      obs({ testCase: 'case B', verdict: 'pass' }),
      obs({ testCase: 'case B' }),
    ]);
    expect(flips.map((f) => f.testCase)).toEqual(['case B']);
  });

  it('normalizes ./ and backslash paths so one test is one identity', () => {
    const flips = detectSameCommitVerdictFlips([obs({ testFile: `./${FILE}` }), obs({ testFile: FILE.replace(/\//g, '\\'), verdict: 'pass' })]);
    expect(flips).toHaveLength(1);
    expect(flips[0]?.testFile).toBe(FILE);
  });
});

describe('observation sources', () => {
  it('a file that failed in the suite and passed alone in isolation is a fail AND a pass', () => {
    const observations = observationsFromIsolationRetries(
      SHA,
      [
        { name: '@papercusp/operator-core::lib/memory/injection.test.ts', outcome: 'passed-on-rerun', via: 'load-flake-isolation' },
        { name: '@papercusp/operator-core::lib/other.test.ts', outcome: 'still-failing', via: 'load-flake-isolation' },
        { name: '@papercusp/web', outcome: 'passed-on-rerun', via: 'worker-crash-rerun' },
        { name: '@unknown/ws::lib/x.test.ts', outcome: 'passed-on-rerun', via: 'load-flake-isolation' },
      ],
      (ws) => (ws === '@papercusp/operator-core' ? 'packages/operator-core/' : null),
    );
    expect(observations).toEqual([
      { commitSha: SHA, testFile: FILE, verdict: 'fail', source: 'suite' },
      { commitSha: SHA, testFile: FILE, verdict: 'pass', source: 'isolation' },
      { commitSha: SHA, testFile: 'packages/operator-core/lib/other.test.ts', verdict: 'fail', source: 'suite' },
    ]);
    expect(detectSameCommitVerdictFlips(observations).map((f) => f.testFile)).toEqual([FILE]);
  });

  it('recorded runs: only clean-tree measured verdicts count', () => {
    const observations = observationsFromTestRuns([
      { id: 1, commitSha: SHA, filePath: FILE, status: 'fail', worktreeDirty: false },
      { id: 2, commitSha: SHA, filePath: FILE, status: 'pass', worktreeDirty: true },
      { id: 3, commitSha: SHA, filePath: FILE, status: 'skip', worktreeDirty: false },
      { id: 4, commitSha: SHA, filePath: FILE, status: 'error', worktreeDirty: false },
      { id: 5, commitSha: SHA, filePath: FILE, status: 'pass', worktreeDirty: null },
    ]);
    expect(observations.map((o) => `${o.verdict}:${o.source}`)).toEqual(['fail:test_runs:1', 'fail:test_runs:4']);
    expect(detectSameCommitVerdictFlips(observations)).toEqual([]);
    const clean = observationsFromTestRuns([
      { id: 6, commitSha: SHA, filePath: FILE, status: 'fail', worktreeDirty: false },
      { id: 7, commitSha: SHA, filePath: FILE, status: 'pass', worktreeDirty: false },
    ]);
    expect(detectSameCommitVerdictFlips(clean)).toHaveLength(1);
  });
});

describe('planVerdictFlipQuarantine — owned quarantine', () => {
  const [flip] = detectSameCommitVerdictFlips([obs({}), obs({ verdict: 'pass', source: 'isolation' })]);
  if (!flip) throw new Error('fixture flip missing');

  it('quarantines a flip under its resolved owner', () => {
    const plan = planVerdictFlipQuarantine({ flips: [flip], active: [], ownerOf: () => 'su-owner' });
    expect(plan.toQuarantine).toEqual([{ flip, owner: 'su-owner', criticalArea: null, notifyOwner: false }]);
    expect(plan.unowned).toEqual([]);
  });

  it('falsifier 2: no owner ⇒ NOT quarantined (it keeps counting), reported as unowned', () => {
    const plan = planVerdictFlipQuarantine({ flips: [flip], active: [], ownerOf: () => '  ' });
    expect(plan.toQuarantine).toEqual([]);
    expect(plan.unowned).toEqual([flip]);
  });

  it('a test an active row already covers needs nothing new; a revoked row covers nothing', () => {
    const active: QuarantineStoreRow[] = [{ testFile: FILE, testCase: '', revokedAt: null, kind: FLAKY_QUARANTINE_KIND }];
    expect(planVerdictFlipQuarantine({ flips: [flip], active, ownerOf: () => 'o' }).alreadyCovered).toEqual([flip]);
    const revoked: QuarantineStoreRow[] = [{ ...active[0]!, revokedAt: '2026-10-17T00:00:00.000Z' }];
    expect(planVerdictFlipQuarantine({ flips: [flip], active: revoked, ownerOf: () => 'o' }).toQuarantine).toHaveLength(1);
  });

  it('one action per test, however many commits it flipped on', () => {
    const flips = detectSameCommitVerdictFlips([
      obs({}),
      obs({ verdict: 'pass' }),
      obs({ commitSha: OTHER_SHA }),
      obs({ commitSha: OTHER_SHA, verdict: 'pass' }),
    ]);
    expect(flips).toHaveLength(2);
    expect(planVerdictFlipQuarantine({ flips, active: [], ownerOf: () => 'o' }).toQuarantine).toHaveLength(1);
  });

  it('falsifier 2: the record is refused without an owner or a de-quarantine work-item', () => {
    expect(flakyQuarantineProblems({ owner: 'o', dequarantineWorkItemId: '' })).toEqual([
      'missing de-quarantine work-item: file it first and pass its id',
    ]);
    expect(flakyQuarantineProblems({ owner: '', dequarantineWorkItemId: 'WI-1' })).toHaveLength(1);
    const action = { flip, owner: 'su-owner', criticalArea: null, notifyOwner: false };
    expect(buildFlakyQuarantineRecord(action, null)).toEqual({
      ok: false,
      problems: ['missing de-quarantine work-item: file it first and pass its id'],
    });
    expect(buildFlakyQuarantineRecord({ ...action, owner: '' }, 'WI-9').ok).toBe(false);
  });

  it('a complete record carries the owner, the de-quarantine item as bugId, and the flip evidence', () => {
    const built = buildFlakyQuarantineRecord({ flip, owner: 'su-owner', criticalArea: null, notifyOwner: false }, 'WI-42');
    if (!built.ok) throw new Error(built.problems.join('; '));
    expect(built.record).toMatchObject({
      kind: FLAKY_QUARANTINE_KIND,
      testFile: FILE,
      testCase: '',
      owner: 'su-owner',
      bugId: 'WI-42',
      author: FLAKY_QUARANTINE_AUTHOR,
      criticalArea: null,
      riskAcknowledgement: null,
    });
    expect(built.record.reason).toContain(`1 pass / 1 fail on ${SHA}`);
  });

  it('a critical-area flip is quarantined with an acknowledgement naming its area, and notifies the owner', () => {
    const gateFile = 'apps/operator/lib/release/green-checkpoint.test.ts';
    const [gateFlip] = detectSameCommitVerdictFlips([obs({ testFile: gateFile }), obs({ testFile: gateFile, verdict: 'pass' })]);
    if (!gateFlip) throw new Error('fixture flip missing');
    const plan = planVerdictFlipQuarantine({ flips: [gateFlip], active: [], ownerOf: () => 'human' });
    const action = plan.toQuarantine[0];
    expect(action?.notifyOwner).toBe(true);
    expect(action?.criticalArea?.id).toBe('gate');
    const built = buildFlakyQuarantineRecord(action!, 'WI-7');
    if (!built.ok) throw new Error(built.problems.join('; '));
    const area = classifyCriticalArea(gateFile)!;
    // The promotion ratchet re-checks this acknowledgement (P-004); it must pass.
    expect(
      criticalAreaAcknowledgementProblem(area, { area: built.record.criticalArea, risk: built.record.riskAcknowledgement }),
    ).toBeNull();
    expect(dequarantineWorkItemDraft(action!).severity).toBe('major');
  });

  it('the de-quarantine work-item is assigned to the owner and says how to finish', () => {
    const draft = dequarantineWorkItemDraft({ flip, owner: 'su-owner', criticalArea: null, notifyOwner: false });
    expect(draft.assignee).toBe('su-owner');
    expect(draft.title).toContain(FILE);
    expect(draft.body).toContain("op: 'revoke'");
    expect(draft.severity).toBe('minor');
  });
});

describe('partitionQuarantinedFailures — falsifier 1: a quarantined flipping test stops counting', () => {
  const rows: QuarantineStoreRow[] = [
    { testFile: FILE, testCase: '', revokedAt: null, kind: FLAKY_QUARANTINE_KIND },
    { testFile: 'a.test.ts', testCase: 'only this case', revokedAt: null, kind: FLAKY_QUARANTINE_KIND },
    { testFile: 'downgraded.test.ts', testCase: '', revokedAt: null, kind: 'downgrade' },
    { testFile: 'revoked.test.ts', testCase: '', revokedAt: '2026-10-17T00:00:00.000Z', kind: FLAKY_QUARANTINE_KIND },
  ];

  it('a file-level quarantine removes the file and every case in it', () => {
    const { counted, quarantined } = partitionQuarantinedFailures(
      [{ testFile: FILE }, { testFile: `./${FILE}`, testCase: 'some case' }, { testFile: 'real-break.test.ts' }],
      rows,
    );
    expect(quarantined).toHaveLength(2);
    expect(counted).toEqual([{ testFile: 'real-break.test.ts' }]);
  });

  it('a case-level quarantine covers only its case', () => {
    const { counted, quarantined } = partitionQuarantinedFailures(
      [{ testFile: 'a.test.ts', testCase: 'only this case' }, { testFile: 'a.test.ts', testCase: 'another case' }, { testFile: 'a.test.ts' }],
      rows,
    );
    expect(quarantined).toEqual([{ testFile: 'a.test.ts', testCase: 'only this case' }]);
    expect(counted).toHaveLength(2);
  });

  it('a plain downgrade keeps its own accounting, and a revoked quarantine counts again', () => {
    const { counted } = partitionQuarantinedFailures([{ testFile: 'downgraded.test.ts' }, { testFile: 'revoked.test.ts' }], rows);
    expect(counted).toHaveLength(2);
  });
});

describe('S4 end to end over the store', () => {
  it('fail-then-pass on one commit ⇒ owned quarantine row + de-quarantine item ⇒ no longer counted; revoke ⇒ counts again', async () => {
    const store = memoryTestDowngradeStore(() => new Date('2026-10-17T12:00:00.000Z'));
    const observations = observationsFromIsolationRetries(
      SHA,
      [{ name: '@papercusp/operator-core::lib/memory/injection.test.ts', outcome: 'passed-on-rerun', via: 'load-flake-isolation' }],
      () => 'packages/operator-core',
    );
    const plan = planVerdictFlipQuarantine({
      flips: detectSameCommitVerdictFlips(observations),
      active: await store.listActive(),
      ownerOf: () => 'su-owner',
    });
    expect(plan.toQuarantine).toHaveLength(1);
    const filed: { id: string; assignee: string }[] = [];
    for (const action of plan.toQuarantine) {
      const draft = dequarantineWorkItemDraft(action);
      const id = `WI-${filed.length + 100}`;
      filed.push({ id, assignee: draft.assignee });
      const built = buildFlakyQuarantineRecord(action, id);
      if (!built.ok) throw new Error(built.problems.join('; '));
      await store.insert(built.record);
    }
    expect(filed).toEqual([{ id: 'WI-100', assignee: 'su-owner' }]);
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ kind: FLAKY_QUARANTINE_KIND, owner: 'su-owner', bugId: 'WI-100' });

    const failures = [{ testFile: FILE }, { testFile: 'real-break.test.ts' }];
    expect(partitionQuarantinedFailures(failures, active).counted).toEqual([{ testFile: 'real-break.test.ts' }]);

    // A second gate run on the same commit adds nothing new: the test is already covered.
    const again = planVerdictFlipQuarantine({
      flips: detectSameCommitVerdictFlips(observations),
      active,
      ownerOf: () => 'su-owner',
    });
    expect(again.toQuarantine).toEqual([]);

    // De-quarantine = revoke: the test counts again.
    await store.revoke(active[0]!.id, 'su-owner', 'made deterministic');
    expect(partitionQuarantinedFailures(failures, await store.listActive()).counted).toHaveLength(2);
  });

  it('a plain downgrade insert keeps kind downgrade', async () => {
    const store = memoryTestDowngradeStore();
    const row = await store.insert({ testFile: 'x.test.ts', testCase: '', reason: 'r', owner: 'o', bugId: 'b', author: 'a', criticalArea: null, riskAcknowledgement: null });
    expect('conflict' in row ? null : row.kind).toBe('downgrade');
  });
});

describe('compareRoundsOverSamePopulation — falsifier 3: like for like only', () => {
  const k = (file: string, testCase = '') => testDowngradeKey(file, testCase);

  it('population growth does not read as a regression: tests only the later round measured are not compared', () => {
    const previous = { measured: [k('a'), k('b')], failing: [k('a')] };
    const next = { measured: [k('a'), k('b'), k('c'), k('d')], failing: [k('a'), k('c'), k('d')] };
    const cmp = compareRoundsOverSamePopulation(previous, next, new Set());
    expect(cmp).toMatchObject({ population: 2, previousFailing: 1, nextFailing: 1, direction: 'unchanged' });
    expect(cmp.outsidePopulation.nextOnly).toEqual([k('c'), k('d')].sort());
  });

  it('a quarantined test leaves BOTH rounds, so quarantining cannot fake an improvement', () => {
    const previous = { measured: [k('a'), k('flaky')], failing: [k('a'), k('flaky')] };
    const next = { measured: [k('a'), k('flaky')], failing: [k('a')] };
    const quarantined = activeQuarantineKeys([{ testFile: 'flaky', testCase: '', revokedAt: null, kind: FLAKY_QUARANTINE_KIND }]);
    const cmp = compareRoundsOverSamePopulation(previous, next, quarantined);
    expect(cmp).toMatchObject({ population: 1, previousFailing: 1, nextFailing: 1, direction: 'unchanged' });
    expect(cmp.outsidePopulation.quarantined).toEqual([k('flaky')]);
  });

  it('a file-level quarantine removes every case of that file from the population', () => {
    const quarantined = new Set([k('f')]);
    const cmp = compareRoundsOverSamePopulation(
      { measured: [k('f', 'c1'), k('g')], failing: [k('f', 'c1')] },
      { measured: [k('f', 'c1'), k('g')], failing: [k('g')] },
      quarantined,
    );
    expect(cmp).toMatchObject({ population: 1, previousFailing: 0, nextFailing: 1, direction: 'regressed' });
  });

  it('a real fix within the shared population reads as improved', () => {
    const cmp = compareRoundsOverSamePopulation(
      { measured: [k('a'), k('b')], failing: [k('a'), k('b')] },
      { measured: [k('a'), k('b')], failing: [k('b')] },
      new Set(),
    );
    expect(cmp.direction).toBe('improved');
  });
});

// Falsifier (3) in production: the bounded-life rule compares PERSISTED repair rounds. A test
// quarantined at round 2 left round 2's count, but round 1 still counted it; without the
// population rule round 2 reads as a new low that no repair produced (#D-015).
describe('P-008 production round comparison (persisted repair rounds)', () => {
  const cap = { saturationCap: FROZEN_REPAIR_PERSISTED_FAILURE_CAP };
  const rounds = [
    { round: 1, failingCount: 3, failingTests: ['lib/a.test.ts', 'lib/b.test.ts', 'lib/flaky.test.ts'] },
    { round: 2, failingCount: 2, failingTests: ['lib/a.test.ts', 'lib/b.test.ts'], excludedFromCount: ['lib/flaky.test.ts'] },
  ];

  it('removes every round’s exclusions from every round before comparing counts', () => {
    const t = likeForLikeTrajectory(rounds, cap);
    expect(t.comparableRounds).toBe(2);
    expect(t.lowestFailingCount).toBe(2);
    expect(t.latestFailingCount).toBe(2);
    // Round 2 is NOT a new low: the quarantine changed the population, not the failures.
    expect(t.roundsSinceLow).toBe(1);
    const naive = likeForLikeTrajectory(rounds.map(({ excludedFromCount: _x, ...r }) => r), cap);
    expect(naive.roundsSinceLow).toBe(0);
  });

  it('skips a round whose failing list is unknown once anything is excluded', () => {
    const t = likeForLikeTrajectory([{ round: 1, failingCount: 3 }, rounds[1]!], cap);
    expect(t.excludedRounds).toEqual([{ round: 1, reason: 'population-unknown' }]);
    expect(t.comparableRounds).toBe(1);
    // With nothing excluded a legacy round keeps its count (behaviour unchanged).
    expect(likeForLikeTrajectory([{ round: 1, failingCount: 3 }], cap).comparableRounds).toBe(1);
  });

  it('persists the exclusions on the round a red produces and reads them back', () => {
    const queue = createFrozenCandidateQueue({ candidate: 'c'.repeat(40), base: null, nowMs: 1_000 });
    const red = markFrozenCandidateVerificationRed(queue, {
      failingTests: ['lib/a.test.ts'],
      excludedFromCount: ['lib/flaky.test.ts', 'lib/flaky.test.ts'],
      nowMs: 2_000,
    });
    expect(red.convergenceRounds?.at(-1)?.excludedFromCount).toEqual(['lib/flaky.test.ts']);
    expect(red.convergenceRounds?.at(-1)?.failingTests).toEqual(['lib/a.test.ts']);
    const parsed = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(red)));
    expect(parsed?.convergenceRounds?.at(-1)?.excludedFromCount).toEqual(['lib/flaky.test.ts']);
    const clean = markFrozenCandidateVerificationRed(queue, { failingTests: ['lib/a.test.ts'], nowMs: 2_000 });
    expect(clean.convergenceRounds?.at(-1)).not.toHaveProperty('excludedFromCount');
  });
});
