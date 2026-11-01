import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  assessTerminalRepairQueueReconciliation,
  beginQualificationTransaction,
  type PreparedCheckpointSelectionRecord,
  checkpointSelectionQueueAuthorityMatches,
  preparedCheckpointQueueMatches,
  classifyScheduledQualificationJoin,
  cancelQualificationTransaction,
  classifyQualificationVerdict,
  describeQualificationSettleConflict,
  parseCheckpointQualificationTransaction,
  projectCheckpointQualificationState,
  QUALIFICATION_PROGRESS_STALE_MS,
  recordQualificationRunnerProgress,
  recordQualificationChildScope,
  recordQualificationWorkProgress,
  recordQualificationWorkYield,
  type QualificationWorkProgressInput,
  isPostVerdictHang,
  QUALIFICATION_POST_VERDICT_HANG_MS,
  recordQualificationScheduledFire,
  qualificationIntentMatches,
  reserveQualificationRunner,
  recoverQualificationScheduledTerminal,
  recoverQualificationHistoricalPreSuiteError,
  settleQualificationTransaction,
  waitQualificationTransaction,
  voidPreparedSelectionForMovedCandidate,
  type HistoricalPreSuiteRecoveryInput,
} from './checkpoint-qualification-transaction';
import { GREEN_CHECKPOINT_RESULT_MARKER } from './checkpoint-log-tags';
import {
  createFrozenCandidateQueue,
  parseFrozenCandidateRepairQueue,
  decideFrozenCandidateRepairQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  markFrozenRepairExhausted,
  markFrozenRepairFixerDead,
  markFrozenRepairFixerDispatched,
  markFrozenRepairUnmeasuredRetest,
  markFrozenRepairVerificationGreen,
  frozenRepairHeadOwesVerification,
  frozenRepairHeadAwaitsVerification,
  settleFrozenRepairRetestRequest,
  type FrozenCandidateRepairPhase,
  type FrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  CHECKPOINT_ELIGIBILITY_PREDICATES,
  buildCheckpointEligibilitySnapshot,
} from './checkpoint-eligibility-snapshot';

const begin = () =>
  beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    requiredAncestorSha: 'abc123',
    declaredPaths: ['b.ts', 'a.ts', 'a.ts'],
    candidate: 'candidate-1',
    evidenceRefs: ['tool:release:checkpoint-run'],
    nowMs: 100,
  }).transaction;

describe('qualification child scope custody', () => {
  const fence = { attemptId: 'attempt-1', runnerId: 'runner', runId: 'run', pidIdentity: 'boot:42' };
  const fixture = () => reserveQualificationRunner(begin(), { ...fence, pid: 42,
    unit: 'parent.scope', started: true, leaseDurationMs: 1000, nowMs: 200 }).transaction;
  const enroll = (unit = 'pc-child123.scope') => recordQualificationChildScope(fixture(), {
    ...fence, unit, operation: 'enroll', nowMs: 300 }).transaction;

  it('durably recovers enrolled payloads and refuses settlement or cancellation before death', () => {
    const current = parseCheckpointQualificationTransaction(enroll())!;
    expect(current.currentPhysicalRunner!.childScopeUnits).toEqual(['pc-child123.scope']);
    expect(waitQualificationTransaction(current, { attemptId: fence.attemptId, reason: 'infra-inconclusive' }))
      .toMatchObject({ status: 'conflict', refusalReason: 'child-scope-custody-held' });
    expect(settleQualificationTransaction(current, { ...fence, reason: 'not-green', green: false }))
      .toMatchObject({ status: 'conflict', refusalReason: 'child-scope-custody-held' });
    expect(cancelQualificationTransaction(current, { attemptId: fence.attemptId, unit: 'parent.scope' }))
      .toMatchObject({ status: 'conflict', refusalReason: 'child-scope-custody-held' });
  });

  it.each(['live', 'unknown', undefined] as const)('retains payload custody for %s liveness', scopeLiveness => {
    const current = enroll();
    expect(recordQualificationChildScope(current, { ...fence, unit: 'pc-child123.scope',
      operation: 'release', scopeLiveness, nowMs: 400 }))
      .toMatchObject({ status: 'conflict', transaction: current, refusalReason: 'child-scope-death-unmeasured' });
  });

  it('releases only the dead payload and permits a successor after the last payload is gone', () => {
    const first = enroll();
    const second = recordQualificationChildScope(first, { ...fence, unit: 'pc-child456.scope',
      operation: 'enroll', nowMs: 400 }).transaction;
    const release = (current: Parameters<typeof recordQualificationChildScope>[0], unit: string) => recordQualificationChildScope(current, { ...fence, unit,
      operation: 'release', scopeLiveness: 'dead', nowMs: 500 });
    const partial = release(second, 'pc-child123.scope').transaction;
    expect(partial.currentPhysicalRunner!.childScopeUnits).toEqual(['pc-child456.scope']);
    const freed = release(partial, 'pc-child456.scope').transaction;
    expect(waitQualificationTransaction(freed, { attemptId: fence.attemptId, reason: 'infra-inconclusive',
      runId: fence.runId, nowMs: 600 }).status).toBe('updated');
  });

  it('refuses stale runners, malformed units, duplicate recovery data and backwards clocks', () => {
    const current = enroll();
    for (const wrong of [{ runnerId: 'old' }, { runId: 'old' }, { pidIdentity: 'old' },
      { attemptId: 'old' }, { unit: 'unowned.service' }, { nowMs: 299 }]) {
      expect(recordQualificationChildScope(current, { ...fence, unit: 'pc-other123.scope',
        operation: 'enroll', nowMs: 400, ...wrong }).status).toBe('conflict');
    }
    const duplicate = structuredClone(current);
    duplicate.currentPhysicalRunner!.childScopeUnits!.push('pc-child123.scope');
    expect(parseCheckpointQualificationTransaction(duplicate)).toBeNull();
  });
});

describe('prepared selection authority shape', () => {
  const prepared = (): PreparedCheckpointSelectionRecord => ({
    schemaVersion: 1, attemptId: 'attempt-1', integrationRoot: '/integration', checkpointRoot: '/checkpoint',
    candidate: 'candidate-1', tip: 'tip-1', base: null, candidateSource: 'tip', quietCutApplied: false,
    freezeCut: null, carry: null, queue: null,
    generation: { candidate: 'candidate-1', identity: 'generation-1', token: 'v3:token',
      inputFingerprint: '1'.repeat(64), reused: true, root: '/generations' },
  });

  it('recovers the complete committed selection through the stored transaction parser', () => {
    const transaction = { ...begin(), preparedSelection: prepared() };
    expect(parseCheckpointQualificationTransaction(JSON.parse(JSON.stringify(transaction))))
      .toEqual(transaction);
  });

  it('voids a selection made for a candidate the attempt no longer names (WI-6554700010010801)', () => {
    const moved = { ...begin(), candidate: 'frozen-candidate', preparedSelection: prepared() };
    const voided = voidPreparedSelectionForMovedCandidate(moved);
    expect(voided).not.toHaveProperty('preparedSelection');
    expect(voided.candidate).toBe('frozen-candidate');
    expect(voided.evidenceRefs).toContain('prepared-selection-voided:candidate-1');
    // The voided record round-trips: the next physical run reads "no selection" and plans afresh.
    expect(parseCheckpointQualificationTransaction(JSON.parse(JSON.stringify(voided)))).toEqual(voided);
  });

  it('leaves a matching selection, an unset candidate, or no selection untouched', () => {
    const matching = { ...begin(), preparedSelection: prepared() };
    expect(voidPreparedSelectionForMovedCandidate(matching)).toBe(matching);
    const unset = { ...begin(), candidate: null, preparedSelection: prepared() };
    expect(voidPreparedSelectionForMovedCandidate(unset)).toBe(unset);
    const none = begin();
    expect(voidPreparedSelectionForMovedCandidate(none)).toBe(none);
  });

  it.each([
    ['missing freeze cut', { freezeCut: undefined }],
    ['partial freeze cut', { freezeCut: { candidate: 'candidate-1' } }],
    ['mismatched freeze cut', { freezeCut: { candidate: 'other', tip: 'tip-1', knownGood: null,
      source: 'staging-tip', reason: 'no-known-good' } }],
    ['unknown freeze reason', { freezeCut: { candidate: 'candidate-1', tip: 'tip-1', knownGood: null,
      source: 'staging-tip', reason: 'invented' } }],
    ['partial carry', { carry: { judgedCandidate: 'candidate-1' } }],
    ['malformed queue', { queue: { repairHead: 'candidate-1' } }],
  ])('refuses %s instead of recovering partial authority', (_name, corruption) => {
    const stored = JSON.parse(JSON.stringify({ ...begin(), preparedSelection: { ...prepared(), ...corruption } }));
    expect(parseCheckpointQualificationTransaction(stored)).toBeNull();
  });

  it('recovers after its own initial queue write, preserving strict refusal after authority changes', () => {
    const record = prepared();
    const initial = createFrozenCandidateQueue({ candidate: record.candidate,
      qualificationAttemptId: record.attemptId, base: record.base, nowMs: 200,
      affectedTestProofGroup: 'original-run' });
    const roundTrip = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(initial)))!;
    expect(preparedCheckpointQueueMatches(record, null)).toBe(true);
    expect(preparedCheckpointQueueMatches(record, roundTrip)).toBe(true);
    for (const changed of [
      { ...roundTrip, qualificationAttemptId: 'other-attempt' },
      { ...roundTrip, repairHead: 'admitted-head' },
      { ...roundTrip, base: 'other-base' },
      { ...roundTrip, updatedAtMs: 201 },
      { ...roundTrip, attempts: 1 },
      { ...roundTrip, phase: 'blocked' as const },
    ]) expect(preparedCheckpointQueueMatches(record, changed)).toBe(false);
    // A captured queue never takes the fresh-cut exception, even at the same SHA.
    expect(preparedCheckpointQueueMatches({ ...record, queue: roundTrip }, null)).toBe(false);
  });

  // WI-6554700010029580: a later physical run of the SAME attempt recovers the committed selection after
  // the fixer state machine and the attempt's own verdict recording touched the queue row.
  it('recovers a captured queue across bookkeeping drift but refuses any change to the selected candidate', () => {
    const roundTrip = (q: unknown) => parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))!;
    const opened = createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'earlier-attempt',
      base: 'base-1', nowMs: 200, affectedTestProofGroup: 'original-run' });
    // Physical run 1 judged the candidate red; that is the queue the attempt's preparation captured.
    const red = roundTrip(markFrozenCandidateVerificationRed(opened, { failingTests: ['lib/a.test.ts'], nowMs: 300 }));
    expect(red.phase).toBe('awaiting-fixer');
    // The stored record is the JSON round-trip the transaction parser returns, not the in-memory object.
    const record = JSON.parse(JSON.stringify({ ...prepared(), candidate: red.repairHead, queue: red }));
    // Between physical runs the fixer state machine and the gate touch only bookkeeping.
    const dispatched = markFrozenRepairFixerDispatched(red, { spawnId: 'durable-spawn:fixer-1', nowMs: 400 });
    expect(dispatched.attempts).toBe(1);
    for (const live of [
      dispatched,
      { ...red, updatedAtMs: 900, fixerStateChangedAtMs: 900 },
      { ...red, freeRetries: 1, lastVerdictAtMs: 800, fixerSpawnId: null },
      { ...red, phase: 'blocked' as const, blockedReason: 'attempts-exhausted' as const },
    ]) expect(preparedCheckpointQueueMatches(record, live)).toBe(true);
    // An admission moves the head the preflight would prepare; lineage changes are a different queue.
    const admitted = markFrozenRepairAdmitted(dispatched, { atMs: 500, actor: 'su-test',
      source: { ref: 'head-2', sha: 'head-2' }, fromRepairHead: red.repairHead, toRepairHead: 'head-2',
      paths: ['lib/a.test.ts'], unchanged: [], blobs: { 'lib/a.test.ts': 'blob-2' } });
    expect(admitted.repairHead).toBe('head-2');
    for (const live of [
      admitted,
      { ...red, phase: 'ready-to-test' as const },
      { ...red, base: 'other-base' },
      { ...red, qualificationAttemptId: 'other-attempt' },
      { ...red, openedAtMs: 250 },
      { ...red, candidate: 'candidate-2' },
    ]) expect(preparedCheckpointQueueMatches(record, live)).toBe(false);
    expect(preparedCheckpointQueueMatches(record, null)).toBe(false);
    expect(preparedCheckpointQueueMatches({ ...record, queue: { repairHead: red.repairHead } }, red)).toBe(false);
  });

  // WI-6554700010030147: the fresh preparation's pre-commit re-read uses the same authority.
  it('judges a live queue by its selection authority, and a queue appearing or vanishing as a change', () => {
    const roundTrip = (q: unknown) => parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))!;
    const red = roundTrip(markFrozenCandidateVerificationRed(createFrozenCandidateQueue({ candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1', base: 'base-1', nowMs: 200, affectedTestProofGroup: 'g' }),
      { failingTests: ['lib/a.test.ts'], nowMs: 300 }));
    expect(checkpointSelectionQueueAuthorityMatches(null, null)).toBe(true);
    expect(checkpointSelectionQueueAuthorityMatches(red, null)).toBe(false);
    expect(checkpointSelectionQueueAuthorityMatches(null, red)).toBe(false);
    expect(checkpointSelectionQueueAuthorityMatches(red, { ...red, updatedAtMs: 901, attempts: 3 })).toBe(true);
    expect(checkpointSelectionQueueAuthorityMatches(red, { ...red, repairHead: 'head-2' })).toBe(false);
    expect(checkpointSelectionQueueAuthorityMatches(red, { ...red, phase: 'ready-to-test' as const })).toBe(false);
  });
});

describe('fenced durable remaining-work continuation', () => {
  const running = () => reserveQualificationRunner(begin(), { attemptId: 'attempt-1', runnerId: 'runner-1',
    candidate: 'candidate-1', runId: 'run-1', pid: 42, pidIdentity: 'boot:42', started: true,
    leaseDurationMs: 1_000, nowMs: 200 }).transaction;
  const input = (): QualificationWorkProgressInput => ({ attemptId: 'attempt-1', candidate: 'candidate-1',
    repairHead: null, runnerId: 'runner-1', runId: 'run-1', pidIdentity: 'boot:42', root: '/repo',
    taskKey: 'qualification', runContext: 'ci', runnerIdentity: 'proof-v3 node', retryStates: [],
    manifest: { schemaVersion: 1, units: [
      { id: 'a', kind: 'test', path: 'a.test.ts' }, { id: 'post', kind: 'post-suite', path: 'post.mjs' } ] },
    updates: [{ receipt: { unitId: 'a', completionId: 'completion-a', observedAtMs: 250, state: 'pass',
      worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass', proof: {
        recordedSha: 'candidate-1', executedModules: ['a.test.ts'], readPaths: [], inputsCaptured: true,
        opaqueReasons: [], runContext: 'ci', runnerIdentity: 'proof-v3 node' } } }], nowMs: 300 });

  it('persists the entire frozen population and survives the production parse/recovery path', () => {
    const saved = recordQualificationWorkProgress(running(), input());
    expect(saved.status).toBe('updated');
    const recovered = parseCheckpointQualificationTransaction(JSON.parse(JSON.stringify(saved.transaction)))!;
    expect(recovered.continuation).toMatchObject({ manifest: input().manifest,
      receipts: [{ unitId: 'a', state: 'pass' }] });
    expect(recordQualificationWorkProgress(recovered, input())).toMatchObject({ status: 'idempotent' });
    expect(parseCheckpointQualificationTransaction({ ...recovered, continuation: { ...recovered.continuation,
      receipts: null } })).toBeNull();
    expect(parseCheckpointQualificationTransaction({ ...recovered, continuation: { ...recovered.continuation,
      manifest: { schemaVersion: 1, units: [] } } })).toBeNull();
    expect(parseCheckpointQualificationTransaction({ ...recovered, continuation: { ...recovered.continuation,
      supersededReceipts: recovered.continuation!.receipts } })).toBeNull();
  });

  it('saves the exact yield cursor while retaining single-flight custody through cleanup', () => {
    const saved = recordQualificationWorkProgress(running(), input()).transaction;
    const checkpoint = { runnerId: 'runner-1', runId: 'run-1', savedAtMs: 350,
      executionCutoffEpochMs: 340, yieldDeadlineEpochMs: 400, cleanupDeadlineEpochMs: 600,
      orphanDeadlineEpochMs: 700, callerDeadlineEpochMs: 650,
      completed: [{ unitId: 'a', completionId: 'completion-a' }], pendingUnitIds: ['post'] };
    const result = recordQualificationWorkYield(saved, { ...input(), updates: [], nowMs: 350 }, checkpoint);
    expect(result.status).toBe('updated');
    expect(result.transaction.currentPhysicalRunner).toEqual(saved.currentPhysicalRunner);
    expect(result.transaction.continuation!.lastYield).toEqual(checkpoint);
    expect(parseCheckpointQualificationTransaction(JSON.parse(JSON.stringify(result.transaction))))
      .toEqual(result.transaction);
    expect(reserveQualificationRunner(result.transaction, { attemptId: 'attempt-1', runnerId: 'rival',
      candidate: 'candidate-1', incumbentLiveness: 'live', leaseDurationMs: 1000, nowMs: 360 }).status).toBe('conflict');
    const waiting = settleQualificationTransaction(result.transaction, { attemptId: 'attempt-1',
      runId: 'run-1', candidate: 'candidate-1', reason: 'infra-inconclusive', green: null, nowMs: 380 }).transaction;
    expect(waiting.phase).toBe('waiting');
    expect(waiting.continuation).toEqual(result.transaction.continuation);
    for (const override of [{ pendingUnitIds: [] }, { completed: [] },
      { completed: [{ unitId: 'a', completionId: 'forged' }] }, { savedAtMs: 400 },
      { callerDeadlineEpochMs: 550 }]) {
      expect(recordQualificationWorkYield(saved, { ...input(), updates: [], nowMs: 350 },
        { ...checkpoint, ...override }).status).toBe('conflict');
    }
  });

  it.each(['live', 'unknown'] as const)('refuses a second runner even with an expired lease and %s liveness', liveness => {
    const saved = recordQualificationWorkProgress(running(), input()).transaction;
    const rival = reserveQualificationRunner(saved, { attemptId: 'attempt-1', runnerId: 'runner-2',
      candidate: 'candidate-1', leaseDurationMs: 1_000, incumbentLiveness: liveness, nowMs: 50_000 });
    expect(rival).toMatchObject({ status: 'conflict', refusalReason: 'runner-held' });
    expect(recordQualificationWorkProgress(saved, { ...input(), runnerId: 'runner-2' })).toMatchObject({
      status: 'conflict', refusalReason: 'runner-fence-mismatch' });
  });

  it('rejects an old fence after a proved-dead handoff without altering replacement receipts', () => {
    const saved = recordQualificationWorkProgress(running(), input()).transaction;
    const replacement = reserveQualificationRunner(saved, { attemptId: 'attempt-1', runnerId: 'runner-2',
      runId: 'run-2', candidate: 'candidate-1', pid: 43, pidIdentity: 'boot:43', started: true,
      leaseDurationMs: 1_000, incumbentLiveness: 'dead', nowMs: 50_000 }).transaction;
    const late = recordQualificationWorkProgress(replacement, { ...input(), nowMs: 50_100 });
    expect(late).toEqual({ status: 'conflict', refusalReason: 'runner-fence-mismatch', transaction: replacement });
    expect(replacement.continuation).toEqual(saved.continuation);
  });

  it('refuses selection, retry-policy, candidate, repair-head, and duplicate-completion changes', () => {
    const saved = recordQualificationWorkProgress(running(), input()).transaction;
    for (const override of [
      { manifest: { schemaVersion: 1 as const, units: input().manifest.units.slice(1) } },
      { candidate: 'other' }, { repairHead: 'other' }, { retryStates: ['fail' as const] },
      { updates: [{ receipt: { ...input().updates[0]!.receipt, unitId: 'post' } }] },
    ]) expect(recordQualificationWorkProgress(saved, { ...input(), ...override }).status).toBe('conflict');
    expect(reserveQualificationRunner(saved, { attemptId: 'attempt-1', runnerId: 'new-runner',
      candidate: 'recut-candidate', incumbentLiveness: 'dead', leaseDurationMs: 1000, nowMs: 50_000 }))
      .toMatchObject({ status: 'conflict', refusalReason: 'continuation-lineage-mismatch' });
    expect(beginQualificationTransaction(saved, { attemptId: 'attempt-1', candidate: 'recut-candidate', nowMs: 50_000 }))
      .toMatchObject({ status: 'conflict', refusalReason: 'continuation-lineage-mismatch' });
    expect(waitQualificationTransaction(saved, { attemptId: 'attempt-1', candidate: 'recut-candidate',
      reason: 'infra-inconclusive', nowMs: 50_000 }))
      .toMatchObject({ status: 'conflict', refusalReason: 'continuation-lineage-mismatch' });
    expect(settleQualificationTransaction(saved, { attemptId: 'attempt-1', repairHead: 'recut-repair',
      reason: 'advanced', green: true, nowMs: 50_000 }))
      .toMatchObject({ status: 'conflict', refusalReason: 'continuation-lineage-mismatch' });
    expect(parseCheckpointQualificationTransaction({ ...saved, candidate: 'recut-candidate' })).toBeNull();
  });

  it('retains failure history and requires the frozen retry policy plus an exact predecessor to replace it', () => {
    const first = input(); first.retryStates = ['fail']; first.updates[0]!.receipt.state = 'fail';
    const saved = recordQualificationWorkProgress(running(), first).transaction;
    const retry = input(); retry.retryStates = ['fail']; retry.nowMs = 400;
    retry.updates[0]!.receipt.completionId = 'completion-retry';
    expect(recordQualificationWorkProgress(saved, retry).status).toBe('conflict');
    retry.updates[0]!.supersedesCompletionId = 'completion-a';
    expect(recordQualificationWorkProgress(saved, retry)).toMatchObject({ status: 'updated', transaction: {
      continuation: { receipts: [{ state: 'pass', completionId: 'completion-retry' }],
        supersededReceipts: [{ state: 'fail', completionId: 'completion-a' }] } } });
    const validPass = recordQualificationWorkProgress(running(), input()).transaction;
    expect(recordQualificationWorkProgress(validPass, { ...retry, retryStates: [] })).toMatchObject({
      status: 'conflict', refusalReason: 'continuation-replacement-not-admitted' });
  });
});

describe('physical reservation refusal evidence (P-033)', () => {
  const running = () => reserveQualificationRunner(begin(), {
    attemptId: 'attempt-1', runnerId: 'fire-1', candidate: 'candidate-1',
    runId: 'run-1', pid: 42, pidIdentity: 'boot:42', started: true,
    leaseDurationMs: 1_000, nowMs: 200,
  }).transaction;

  it.each([
    [{ attemptId: 'other-attempt' }, 'attempt-id-mismatch'],
    [{ candidate: 'other-candidate' }, 'candidate-mismatch'],
    [{ runId: 'other-run' }, 'run-id-mismatch'],
    [{ pidIdentity: 'other-boot:42' }, 'pid-identity-mismatch'],
    [{ runnerId: 'other-fire' }, 'runner-held'],
  ] as const)('names the failed invariant while preserving the reservation: %s', (override, reason) => {
    const current = running();
    const result = reserveQualificationRunner(current, {
      attemptId: 'attempt-1', runnerId: 'fire-1', candidate: 'candidate-1',
      runId: 'run-1', pid: 42, pidIdentity: 'boot:42', started: true,
      leaseDurationMs: 1_000, nowMs: 300, ...override,
    });
    expect(result).toEqual({ status: 'conflict', transaction: current, refusalReason: reason });
    expect(result.transaction).toBe(current);
  });

  it('still attaches the matching process instead of treating equal ids as a refusal', () => {
    expect(reserveQualificationRunner(running(), {
      attemptId: 'attempt-1', runnerId: 'fire-1', candidate: 'candidate-1',
      runId: 'run-1', pid: 42, pidIdentity: 'boot:42', started: true,
      leaseDurationMs: 1_000, nowMs: 300,
    }).status).toBe('updated');
  });
});

describe('historical dependency pre-suite recovery', () => {
  const terminal = () => settleQualificationTransaction(begin(), {
    attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
    reason: 'error', green: null, evidenceRefs: ['original-terminal-event'], nowMs: 200,
  }).transaction;
  const log = () => [
    '[green-checkpoint] FAILED before checkpoint lock: dependency-generation.sh --ensure-ref candidate-1 exited 77:',
    '[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=100 avail=0',
    `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
      candidate: 'candidate-1', runId: 'run-1', reason: 'error', green: null,
      advanced: false, crashed: true, recorded: true,
    })}`,
  ].join('\n');
  const proof = (text = log()): HistoricalPreSuiteRecoveryInput => ({
    attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
    logPath: '/archive/exact-run.log', log: text,
    logSha256: createHash('sha256').update(text).digest('hex'), nowMs: 300,
  });

  it('creates an idempotent distinct successor without rewriting the historical terminal', () => {
    const current = terminal();
    const snapshot = structuredClone(current);
    const recovered = recoverQualificationHistoricalPreSuiteError(current, proof());
    expect(recovered.status).toBe('updated');
    expect(recovered.transaction.attemptId).not.toBe(current.attemptId);
    expect(recovered.transaction).toMatchObject({
      previousAttemptId: current.attemptId, phase: 'ready', outcome: { kind: 'pending' },
      runId: null, requiredAncestorSha: current.requiredAncestorSha,
      candidatePolicy: current.candidatePolicy, candidate: current.candidate,
    });
    expect(recovered.transaction.evidenceRefs).toContain('original-terminal-event');
    expect(recoverQualificationHistoricalPreSuiteError(recovered.transaction, proof())).toEqual({
      status: 'idempotent', transaction: recovered.transaction,
    });
    expect(current).toEqual(snapshot);
    expect(settleQualificationTransaction(current, {
      attemptId: current.attemptId, reason: 'green', green: true, runId: 'run-1',
    }).status).toBe('conflict');
  });

  it.each(['attemptId', 'candidate', 'runId', 'logSha256'] as const)('rejects a mismatched %s', field => {
    expect(recoverQualificationHistoricalPreSuiteError(terminal(), { ...proof(), [field]: 'other' }).status).toBe('conflict');
  });
  it.each([
    ['red', { kind: 'red', reason: 'not-green' }],
    ['green', { kind: 'green', reason: 'green' }],
    ['another inconclusive verdict', { kind: 'code-inconclusive', reason: 'gate-tooling-crash' }],
  ] as const)('preserves a real %s terminal', (_, outcome) => {
    const current = { ...terminal(), outcome };
    expect(recoverQualificationHistoricalPreSuiteError(current, proof())).toEqual({
      status: 'conflict', transaction: current, refusalReason: 'predecessor-not-recoverable',
    });
  });
  it.each([
    ['no positive prelock evidence', (text: string) => text.replace('FAILED before checkpoint lock:', 'dependency setup failed:')],
    ['no typed dependency evidence', (text: string) => text.replace('DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT', 'untyped error')],
    ['duplicate results', (text: string) => `${text}\n${text.split('\n').at(-1)}`],
    ['malformed result', (text: string) => text.replace('"advanced":false', '"advanced":')],
    ['wrong producer identity', (text: string) => text.replace('"runId":"run-1"', '"runId":"run-other"')],
    ['a produced code verdict', (text: string) => text.replace('"green":null', '"green":false')],
    ['an unrecorded result', (text: string) => text.replace('"recorded":true', '"recorded":false')],
    ['suite start', (text: string) => `[green-checkpoint] checkpointing candidate candidate-1\n${text}`],
    ['suite output', (text: string) => `[green-checkpoint] full suite output → /suite.log\n${text}`],
    ['fixture-only preflight', (text: string) => text.replace('[green-checkpoint]', '[green-checkpoint:TEST-FIXTURE]')],
  ])('rejects %s even with a correct archive hash', (_, change) => {
    expect(recoverQualificationHistoricalPreSuiteError(terminal(), proof(change(log()))).status).toBe('conflict');
  });
  it('refuses active runners and previous measured suite history', () => {
    const runner = { id: 'run-1', candidate: 'candidate-1', reservedAtMs: 100, evidenceRefs: [], phase: 'suite' as const };
    const current = terminal();
    expect(recoverQualificationHistoricalPreSuiteError({ ...current, currentPhysicalRunner: runner }, proof()).status).toBe('conflict');
    expect(recoverQualificationHistoricalPreSuiteError({ ...current, consumedPhysicalRuns: [{
      ...runner, endedAtMs: 200, outcome: current.outcome,
    }] }, proof()).status).toBe('conflict');
  });
  it.each([
    ['attemptId', 'predecessor-attempt-mismatch'],
    ['runId', 'predecessor-run-mismatch'],
    ['candidate', 'predecessor-candidate-mismatch'],
  ] as const)('identifies the exact predecessor %s guard without changing the terminal', (field, refusalReason) => {
    const current = { ...terminal(), [field]: 'different' };
    const snapshot = structuredClone(current);
    expect(recoverQualificationHistoricalPreSuiteError(current, proof())).toEqual({
      status: 'conflict', transaction: current, refusalReason,
    });
    expect(current).toEqual(snapshot);
  });
  it('distinguishes an archive hash mismatch from measured suite evidence', () => {
    expect(recoverQualificationHistoricalPreSuiteError(terminal(), { ...proof(), logSha256: 'a'.repeat(64) }))
      .toMatchObject({ status: 'conflict', refusalReason: 'archive-hash-mismatch' });
    expect(recoverQualificationHistoricalPreSuiteError(terminal(), proof(`phase=suite\n${log()}`)))
      .toMatchObject({ status: 'conflict', refusalReason: 'archive-suite-evidence' });
  });
});

describe('logical checkpoint qualification transaction', () => {
  it('keeps scheduler fires separate from suite progress and a terminal verdict', () => {
    const ready = begin();
    const scheduled = recordQualificationScheduledFire(ready, 200);
    expect(scheduled).toMatchObject({ status: 'updated', transaction: { lastScheduledAtMs: 200, updatedAtMs: 100 } });
    const joined = recordQualificationScheduledFire(scheduled.transaction, 300);
    expect(joined).toMatchObject({ status: 'updated', transaction: { lastScheduledAtMs: 300, updatedAtMs: 100 } });
    expect(projectCheckpointQualificationState(joined.transaction, 400).agesMs).toEqual({
      attempt: 300,
      scheduled: 100,
      started: null,
      progress: null,
      terminal: null,
    });

    const running = reserveQualificationRunner(joined.transaction, {
      attemptId: 'attempt-1', runnerId: 'runner-1', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 500,
    }).transaction;
    const fireDuringRun = recordQualificationScheduledFire(running, 600).transaction;
    expect(projectCheckpointQualificationState(fireDuringRun, 700).agesMs).toMatchObject({
      scheduled: 100, started: 200, progress: 200, terminal: null,
    });
    const terminal = settleQualificationTransaction(fireDuringRun, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 800,
    }).transaction;
    expect(projectCheckpointQualificationState(terminal, 900).agesMs).toMatchObject({
      scheduled: 300, started: 400, progress: 400, terminal: 100,
    });
    expect(recordQualificationScheduledFire(terminal, 1_000).status).toBe('terminal');
  });
  it('joins a live physical runner even past its lease and fails closed on unknown liveness', () => {
    const ready = begin();
    expect(classifyScheduledQualificationJoin(ready, 'unknown')).toBe('launch');
    const running = reserveQualificationRunner(ready, {
      attemptId: 'attempt-1', runnerId: 'runner-1', candidate: 'candidate-1',
      leaseDurationMs: 1, nowMs: 200,
    }).transaction;
    expect(classifyScheduledQualificationJoin(running, 'live')).toBe('join');
    expect(classifyScheduledQualificationJoin(running, 'unknown')).toBe('unknown-liveness');
    expect(classifyScheduledQualificationJoin(running, 'dead')).toBe('launch');
  });
  it('only accepts progress from the exact activated runner and keeps scheduler time independent', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'fire-1', leaseDurationMs: 1_000_000,
      started: false, nowMs: 200,
    }).transaction;
    const running = reserveQualificationRunner(reserved, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pid: 123, pidIdentity: 'boot:1', leaseDurationMs: 1_000_000,
      started: true, nowMs: 300,
    }).transaction;
    const scheduled = recordQualificationScheduledFire(running, 400).transaction;
    expect(scheduled.lastProgressAtMs).toBe(300);
    const input = { attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1', pidIdentity: 'boot:1', phase: 'suite' as const, nowMs: 500 };
    expect(recordQualificationRunnerProgress(scheduled, { ...input, runnerId: 'fire-2' }).status).toBe('conflict');
    expect(recordQualificationRunnerProgress(scheduled, { ...input, pidIdentity: 'boot:2' }).status).toBe('conflict');
    const progress = recordQualificationRunnerProgress(scheduled, input);
    expect(progress).toMatchObject({ status: 'updated', transaction: {
      lastScheduledAtMs: 400, lastProgressAtMs: 500,
      currentPhysicalRunner: { heartbeatAtMs: 500, phase: 'suite', leaseExpiresAtMs: 1_000_300 },
    } });
    expect(projectCheckpointQualificationState(progress.transaction, 550, 'live')).toMatchObject({
      lease: { holder: 'fire-1', acquiredAtMs: 200, expiresAtMs: 1_000_300, expired: false },
      runnerHealth: { state: 'progressing', liveness: 'live', phase: 'suite', progressAgeMs: 50 },
      clocks: { lastScheduledAtMs: 400, lastStartedAtMs: 300, lastProgressAtMs: 500, lastTerminalVerdictAtMs: null },
      agesMs: { scheduled: 150, started: 250, progress: 50, terminal: null },
    });
    const staleAt = 500 + QUALIFICATION_PROGRESS_STALE_MS + 1;
    const anotherFire = recordQualificationScheduledFire(progress.transaction, staleAt).transaction;
    expect(projectCheckpointQualificationState(anotherFire, staleAt, 'live')).toMatchObject({
      runnerHealth: { state: 'stalled', liveness: 'live', phase: 'suite' },
      agesMs: { scheduled: 0, progress: QUALIFICATION_PROGRESS_STALE_MS + 1 },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    expect(recordQualificationRunnerProgress(progress.transaction, { ...input, nowMs: 450 }).status).toBe('idempotent');
    // WI-6554700010009616: the phase clock starts on a phase change and holds across same-phase
    // beats, because the heartbeat itself keeps advancing through an awaited hang.
    expect(progress.transaction.currentPhysicalRunner).toMatchObject({ phase: 'suite', phaseEnteredAtMs: 500 });
    const beat = recordQualificationRunnerProgress(progress.transaction, { ...input, nowMs: 600 }).transaction;
    expect(beat.currentPhysicalRunner).toMatchObject({ heartbeatAtMs: 600, phaseEnteredAtMs: 500 });
    const finalizing = recordQualificationRunnerProgress(beat, { ...input, phase: 'finalizing', nowMs: 700 }).transaction;
    expect(finalizing.currentPhysicalRunner).toMatchObject({ phase: 'finalizing', phaseEnteredAtMs: 700 });
    const pastBound = 701 + QUALIFICATION_POST_VERDICT_HANG_MS;
    expect(isPostVerdictHang(finalizing.currentPhysicalRunner, 'live', pastBound - 1)).toBe(false);
    expect(isPostVerdictHang(finalizing.currentPhysicalRunner, 'live', pastBound)).toBe(true);
    expect(isPostVerdictHang(finalizing.currentPhysicalRunner, 'unknown', pastBound)).toBe(false);
    expect(isPostVerdictHang(finalizing.currentPhysicalRunner, 'dead', pastBound)).toBe(false);
    expect(isPostVerdictHang(beat.currentPhysicalRunner, 'live', pastBound)).toBe(false);
    const terminal = settleQualificationTransaction(progress.transaction, {
      attemptId: 'attempt-1', runId: 'run-1', reason: 'not-green', green: false, nowMs: 600,
    }).transaction;
    expect(recordQualificationRunnerProgress(terminal, { ...input, nowMs: 700 }).status).toBe('terminal');
    expect(settleQualificationTransaction(terminal, {
      attemptId: 'attempt-1', runId: 'run-other', reason: 'advanced', green: true, nowMs: 700,
    }).status).toBe('conflict');
    expect(settleQualificationTransaction(terminal, {
      attemptId: 'attempt-1', runId: 'run-1', reason: 'not-green', green: false, nowMs: 700,
    }).status).toBe('terminal');
  });
  it('projects owner, phase, heartbeat, and deadline from the persisted runner fields', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'runner-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 123, pidIdentity: 'boot:1', leaseDurationMs: 1_000, started: true, nowMs: 200,
    }).transaction;
    const runner = running.currentPhysicalRunner!;
    const project = (changes: Partial<typeof runner>) =>
      projectCheckpointQualificationState({ ...running, currentPhysicalRunner: { ...runner, ...changes } }, 300, 'live');

    expect(project({})).toMatchObject({
      lease: { holder: 'runner-1', expiresAtMs: 1_200, expired: false },
      runnerHealth: { phase: 'materializing', progressAgeMs: 100 },
    });
    expect(project({ id: 'runner-2' }).lease?.holder).toBe('runner-2');
    expect(project({ phase: 'suite' }).runnerHealth.phase).toBe('suite');
    expect(project({ heartbeatAtMs: 250 }).runnerHealth.progressAgeMs).toBe(50);
    expect(project({ leaseExpiresAtMs: 250 })).toMatchObject({
      lease: { expired: true }, safeNextAction: { code: 'inspect-runner-liveness' },
    });
  });
  it('creates one normalized durable identity and reuses the same attempt idempotently', () => {
    const current = begin();
    expect(current).toMatchObject({
      attemptId: 'attempt-1',
      phase: 'ready',
      outcome: { kind: 'pending' },
      candidatePolicy: { kind: 'quiet-cut', declaredPaths: ['b.ts', 'a.ts'] },
      waitGeneration: 0,
    });
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-1', nowMs: 200 }).status).toBe('idempotent');
    expect(beginQualificationTransaction(current, { attemptId: 'attempt-2', nowMs: 200 }).status).toBe('conflict');
    expect(
      qualificationIntentMatches(current, {
        requiredAncestorSha: 'abc123',
        declaredPaths: ['a.ts', 'b.ts'],
      }),
    ).toBe(true);
    expect(
      qualificationIntentMatches(current, {
        requiredAncestorSha: 'different',
        declaredPaths: ['a.ts', 'b.ts'],
      }),
    ).toBe(false);
  });

  it('settles a repair-head verification whose verdict names the frozen candidate plus the verified head (WI-10002602)', () => {
    // The attempt is reserved against the repair head it verifies ('repair-head-1'), but the
    // green-checkpoint verdict names the FROZEN candidate as `candidate` and the verified head
    // as `repairHead`. Before the fix this returned conflict: the verdict was discarded and the
    // attempt stayed non-terminal, wedging every later scheduled fire.
    const reserved = reserveQualificationRunner(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-rh',
        requiredAncestorSha: 'repair-head-1',
        candidate: 'repair-head-1',
        nowMs: 100,
      }).transaction,
      { attemptId: 'attempt-rh', runnerId: 'physical-rh', candidate: 'repair-head-1', leaseDurationMs: 1_000, nowMs: 150 },
    ).transaction;

    const settled = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      reason: 'repair-in-progress',
      green: null,
      nowMs: 200,
    });
    // repair-in-progress is a no-verdict: the attempt returns to waiting with its runner
    // released, instead of staying 'running' under a runner that will never settle it.
    expect(settled.status).toBe('updated');
    expect(settled.transaction).toMatchObject({
      phase: 'waiting',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      currentPhysicalRunner: null,
    });

    // A real verdict on the same repair head settles terminally.
    const red = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(red.status).toBe('updated');
    expect(red.transaction).toMatchObject({ phase: 'terminal', repairHead: 'repair-head-1' });

    // A verdict for a DIFFERENT repair head is still a stale producer and must not settle.
    const otherHead = settleQualificationTransaction(reserved, {
      attemptId: 'attempt-rh',
      candidate: 'frozen-candidate-1',
      repairHead: 'repair-head-2',
      reason: 'repair-in-progress',
      green: null,
      nowMs: 200,
    });
    expect(otherHead).toMatchObject({ status: 'conflict', transaction: reserved });
  });

  it('settles the incumbent run verdict for the sha it actually judged after re-resolving its target (WI-10003215)', () => {
    // Incident shape (attempt 1cf6ef83, run e787243b): the scheduled reservation stored the quiet-cut
    // tip, the run resumed the frozen lineage, its own lockfile convergence advanced repairHead
    // (persisting pendingRepairHead), and the green verdict named the converged head with no repair
    // head because promotion retired the queue. Before the fix this returned conflict: the green was
    // DISCARDED, release:green wakes were withheld, and the attempt stayed running under a dead runner.
    const placeholder = reserveQualificationRunner(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-conv', requiredAncestorSha: 'tip-cut', candidate: 'tip-cut', nowMs: 100,
      }).transaction,
      { attemptId: 'attempt-conv', runnerId: 'gate-fire-conv', leaseDurationMs: 1_000, started: false, nowMs: 150 },
    ).transaction;
    const running = reserveQualificationRunner(placeholder, {
      attemptId: 'attempt-conv', runnerId: 'gate-fire-conv', runId: 'run-conv', candidate: 'tip-cut',
      pid: 42, pidIdentity: 'boot-a:42', leaseDurationMs: 2_000, started: true, nowMs: 200,
      evidenceRefs: ['checkpoint-run:run-conv'],
    }).transaction;
    const converged = { ...running, pendingRepairHead: 'converged-head' };
    expect(converged.currentPhysicalRunner?.evidenceRefs).toContain('checkpoint-run:run-conv');

    const green = { attemptId: 'attempt-conv', candidate: 'converged-head', reason: 'advanced', green: true, nowMs: 300 };
    const settled = settleQualificationTransaction(converged, { ...green, runId: 'run-conv' });
    expect(settled.status).toBe('updated');
    expect(settled.transaction).toMatchObject({
      phase: 'terminal',
      outcome: { kind: 'green' },
      candidate: 'converged-head',
      repairHead: 'converged-head',
      pendingRepairHead: null,
      currentPhysicalRunner: null,
    });
    expect(describeQualificationSettleConflict(converged, { ...green, runId: 'run-conv' })).toEqual([]);
    // An exact replay of the same verdict is idempotent, not a second terminal event.
    expect(settleQualificationTransaction(settled.transaction, { ...green, runId: 'run-conv' }).status).toBe('terminal');

    // A red from the same run on a still-frozen queue names the frozen candidate plus the converged
    // head; it settles too and consumes the handoff.
    const red = settleQualificationTransaction(converged, {
      attemptId: 'attempt-conv', candidate: 'frozen-candidate', repairHead: 'converged-head',
      runId: 'run-conv', reason: 'not-green', green: false, nowMs: 300,
    });
    expect(red.transaction).toMatchObject({
      phase: 'terminal', candidate: 'frozen-candidate', repairHead: 'converged-head', pendingRepairHead: null,
    });

    // A handoff the run did NOT judge (a later admission) survives for the successor attempt.
    const laterAdmission = settleQualificationTransaction(
      { ...running, pendingRepairHead: 'later-admission' },
      { ...green, runId: 'run-conv' },
    );
    expect(laterAdmission.transaction).toMatchObject({ phase: 'terminal', pendingRepairHead: 'later-admission' });

    // Identity is still enforced: a candidate mismatch settles ONLY for the incumbent's bound run.
    for (const stale of [
      { runId: 'run-other' },
      { runId: null },
    ]) {
      expect(settleQualificationTransaction(converged, { ...green, ...stale })).toMatchObject({
        status: 'conflict', transaction: converged,
      });
    }
    // A stored run id the live runner never bound (inherited history) is not proof of the same run.
    const unbound = {
      ...converged,
      currentPhysicalRunner: { ...converged.currentPhysicalRunner!, evidenceRefs: [] as string[] },
    };
    expect(settleQualificationTransaction(unbound, { ...green, runId: 'run-conv' }).status).toBe('conflict');
    expect(describeQualificationSettleConflict(unbound, { ...green, runId: 'run-conv' })).toEqual([
      'candidate stored=tip-cut produced=converged-head',
    ]);
  });

  it('pins the first terminal result to the exact candidate and run identity', () => {
    const current = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 150,
    }).transaction;

    const staleCandidate = settleQualificationTransaction(current, {
      attemptId: 'attempt-1',
      candidate: 'candidate-2',
      runId: 'run-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(staleCandidate).toMatchObject({ status: 'conflict', transaction: current });

    const first = settleQualificationTransaction(current, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      runId: 'run-1',
      reason: 'not-green',
      green: false,
      nowMs: 200,
    });
    expect(first).toMatchObject({
      status: 'updated',
      transaction: { candidate: 'candidate-1', runId: 'run-1', phase: 'terminal' },
    });

    const duplicateFromOtherRun = settleQualificationTransaction(first.transaction, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      runId: 'run-2',
      reason: 'advanced',
      green: true,
      nowMs: 300,
    });
    expect(duplicateFromOtherRun).toMatchObject({ status: 'conflict', transaction: first.transaction });
    expect(settleQualificationTransaction(first.transaction, {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
      reason: 'advanced', green: true, nowMs: 300,
    }).status).toBe('conflict');
  });

  it('recovers a mismatched pre-suite terminal only for its exact unitless scheduled runner, including replay', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'fire-1', candidate: 'candidate-1',
      evidenceRefs: ['gate-fire:fire-1'], leaseDurationMs: 1_000, started: false, nowMs: 150,
    }).transaction;
    const proof = {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'wrapper-1',
      reason: 'skipped-locked', finishedAtMs: 200,
      evidenceRefs: ['checkpoint-terminal:wrapper-1', 'gate-fire:fire-1'], nowMs: 210,
    };
    expect(settleQualificationTransaction(reserved, {
      attemptId: 'attempt-1', reason: 'skipped-locked', candidate: 'candidate-2', nowMs: 200,
    }).status).toBe('conflict');
    for (const changed of [
      { runnerId: 'fire-other' }, { attemptId: 'attempt-other' }, { reason: 'not-green' },
      { finishedAtMs: 149 }, { evidenceRefs: ['gate-fire:fire-1'] },
    ]) {
      expect(recoverQualificationScheduledTerminal(reserved, { ...proof, ...changed }).status).toBe('conflict');
    }
    expect(recoverQualificationScheduledTerminal({
      ...reserved, currentPhysicalRunner: { ...reserved.currentPhysicalRunner!, pid: 123 },
    }, proof).status).toBe('conflict');
    const recovered = recoverQualificationScheduledTerminal(reserved, proof);
    expect(recovered).toMatchObject({
      status: 'updated', transaction: {
        phase: 'terminal', candidate: 'candidate-1', currentPhysicalRunner: null,
        outcome: { kind: 'code-inconclusive', reason: 'orphaned-reservation-after-skipped-locked' },
      },
    });
    expect(recovered.transaction.consumedPhysicalRuns).toHaveLength(1);
    expect(recoverQualificationScheduledTerminal(recovered.transaction, proof).status).toBe('terminal');
    expect(recoverQualificationScheduledTerminal(recovered.transaction, { ...proof, runId: 'other' }).status).toBe('conflict');
  });

  it('WI-10002454: names every identity behind a settle conflict, and nothing when identities agree', () => {
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 150,
    }).transaction;
    const stored = { ...reserved, runId: 'run-1' };
    const verdict = { reason: 'not-green', green: false, nowMs: 200 };
    const cases = [
      { produced: { attemptId: 'attempt-2', candidate: 'candidate-1', runId: 'run-1' }, expected: ['attempt stored=attempt-1 produced=attempt-2'] },
      { produced: { attemptId: 'attempt-1', candidate: 'candidate-2', runId: 'run-1' }, expected: ['candidate stored=candidate-1 produced=candidate-2'] },
      { produced: { attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-2' }, expected: ['run stored=run-1 produced=run-2'] },
    ];
    for (const { produced, expected } of cases) {
      // Calibration: the REAL settle must call each of these a conflict, or the helper would be
      // describing a disagreement the state machine does not have.
      expect(settleQualificationTransaction(stored, { ...produced, ...verdict }).status).toBe('conflict');
      expect(describeQualificationSettleConflict(stored, produced)).toEqual(expected);
    }
    // Every mismatch is named, not only the first one the settle short-circuits on.
    expect(
      describeQualificationSettleConflict(stored, { attemptId: 'attempt-2', candidate: 'candidate-2', runId: 'run-2' }),
    ).toHaveLength(3);
    // Agreeing (trimmed) or absent produced identities yield [] — the CAS-race signal, never a
    // fabricated mismatch.
    const agreeing = { attemptId: 'attempt-1', candidate: ' candidate-1 ', runId: null };
    expect(settleQualificationTransaction(stored, { ...agreeing, ...verdict }).status).not.toBe('conflict');
    expect(describeQualificationSettleConflict(stored, agreeing)).toEqual([]);
  });

  it('releases the singleton when an eligibility waiter never started, while preserving real waits', () => {
    const unavailable = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'wait-for-eligibility-unavailable',
      blockers: [
        {
          code: 'dbos-eligibility-waiter',
          detail: 'DBOS is not installed',
          clearEvents: [],
        },
      ],
      nowMs: 200,
    }).transaction;

    const sameAttempt = beginQualificationTransaction(unavailable, {
      attemptId: 'attempt-1',
      requiredAncestorSha: 'abc123',
      declaredPaths: ['a.ts', 'b.ts'],
      candidate: 'candidate-1',
      evidenceRefs: ['tool:release:checkpoint-run'],
      nowMs: 300,
    });
    expect(sameAttempt).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
        blockers: [],
        phaseDurationsMs: { ready: 100, waiting: 100 },
      },
    });

    const successor = beginQualificationTransaction(unavailable, {
      attemptId: 'attempt-2',
      candidate: 'candidate-2',
      nowMs: 300,
    });
    expect(successor).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
      },
    });

    const ownedWait = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      nowMs: 200,
    }).transaction;
    expect(
      beginQualificationTransaction(ownedWait, {
        attemptId: 'attempt-2',
        nowMs: 300,
      }).status,
    ).toBe('conflict');
  });

  it('persists retryable no-verdict waits and allows at most one physical runner', () => {
    const waiting = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 200,
    }).transaction;
    expect(waiting).toMatchObject({ phase: 'waiting', waitGeneration: 1, currentPhysicalRunner: null });
    expect(
      waitQualificationTransaction(waiting, {
        attemptId: 'attempt-1',
        reason: 'eligibility-wait',
        blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
        nowMs: 250,
      }).status,
    ).toBe('idempotent');

    const running = reserveQualificationRunner(waiting, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 1_000,
      nowMs: 300,
    }).transaction;
    expect(running).toMatchObject({ phase: 'running', currentPhysicalRunner: { id: 'physical-1' } });
    expect(
      reserveQualificationRunner(running, {
        attemptId: 'attempt-1',
        runnerId: 'physical-1',
        leaseDurationMs: 1_000,
        nowMs: 350,
      }).status,
    ).toBe('idempotent');
    expect(
      reserveQualificationRunner(running, {
        attemptId: 'attempt-1',
        runnerId: 'physical-2',
        leaseDurationMs: 1_000,
        nowMs: 350,
      }).status,
    ).toBe('conflict');
  });

  it('resumes a same-head repair attempt after an already-running collision releases its runner', () => {
    const waiting = waitQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'already-running',
      candidate: 'repair-1',
      nowMs: 200,
    }).transaction;
    expect(waiting).toMatchObject({
      phase: 'waiting',
      outcome: { kind: 'pre-suite-no-verdict', reason: 'already-running' },
      currentPhysicalRunner: null,
    });

    expect(beginQualificationTransaction(waiting, {
      attemptId: 'attempt-1',
      candidate: 'repair-1',
      nowMs: 300,
    }).status).toBe('idempotent');
    expect(beginQualificationTransaction(waiting, {
      attemptId: 'attempt-1',
      candidate: 'repair-1',
      resumeUnownedRepairVerification: true,
      nowMs: 300,
    })).toMatchObject({
      status: 'updated',
      transaction: {
        phase: 'ready',
        outcome: { kind: 'pending' },
        currentPhysicalRunner: null,
      },
    });
  });

  it('requires proven death before reclaiming even an expired physical runner', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 100,
      nowMs: 200,
    }).transaction;
    expect(projectCheckpointQualificationState(running, 250)).toMatchObject({
      owner: { kind: 'routine', id: 'system:green-checkpoint' },
      lease: { holder: 'physical-1', expired: false },
      safeNextAction: { code: 'await-current-run' },
    });
    expect(projectCheckpointQualificationState(running, 301)).toMatchObject({
      lease: { holder: 'physical-1', expired: true },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    expect(projectCheckpointQualificationState(running, 301, 'dead')).toMatchObject({
      runnerHealth: { state: 'dead', liveness: 'dead' },
      safeNextAction: { code: 'recover-expired-runner' },
    });

    const unproven = reserveQualificationRunner(running, {
      attemptId: 'attempt-1', runnerId: 'physical-2', leaseDurationMs: 200, nowMs: 301,
    });
    expect(unproven.status).toBe('conflict');
    const replacement = reserveQualificationRunner(running, {
      attemptId: 'attempt-1',
      runnerId: 'physical-2',
      leaseDurationMs: 200,
      incumbentLiveness: 'dead',
      nowMs: 301,
    });
    expect(replacement).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        currentPhysicalRunner: { id: 'physical-2', leaseExpiresAtMs: 501 },
        consumedPhysicalRuns: [
          { id: 'physical-1', outcome: { kind: 'pre-suite-no-verdict', reason: 'runner-vanished' } },
        ],
      },
    });
  });

  it('attaches the scheduled CLI process to its pre-spawn reservation without a second runner', () => {
    const placeholder = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000,
      started: false, nowMs: 200,
    }).transaction;
    expect(placeholder).toMatchObject({
      currentPhysicalRunner: { id: 'gate-fire-1', phase: 'launching' },
    });
    expect(placeholder.lastStartedAtMs).toBeUndefined();
    const attached = reserveQualificationRunner(placeholder, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'cli-run-1',
      candidate: 'candidate-1', pid: 123, pidIdentity: 'boot-a:100',
      leaseDurationMs: 2_000, started: true, nowMs: 300,
    });
    expect(attached).toMatchObject({
      status: 'updated', transaction: {
        runId: 'cli-run-1', lastStartedAtMs: 300,
        currentPhysicalRunner: { id: 'gate-fire-1', pid: 123, pidIdentity: 'boot-a:100', phase: 'materializing' },
        consumedPhysicalRuns: [],
      },
    });
    expect(reserveQualificationRunner(attached.transaction, {
      attemptId: 'attempt-1', runnerId: 'other-fire', leaseDurationMs: 1_000,
      incumbentLiveness: 'live', nowMs: 2_301,
    }).status).toBe('conflict');
    expect(reserveQualificationRunner(attached.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'another-cli-run',
      leaseDurationMs: 1_000, started: true, nowMs: 400,
    }).status).toBe('conflict');
  });

  it('never lets a fresh runner inherit the run id bound to an ended runner (WI-10002602 re-wedge)', () => {
    // First scheduled runner binds run-1, then settles pre-suite (waiting, runner released).
    const reserved1 = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const started1 = reserveQualificationRunner(reserved1, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 11, pidIdentity: 'boot-a:11', leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: ['checkpoint-run:run-1'],
    }).transaction;
    const waiting = settleQualificationTransaction(started1, {
      attemptId: 'attempt-1', reason: 'repair-in-progress', candidate: 'candidate-1', runId: 'run-1', nowMs: 400,
    });
    expect(waiting).toMatchObject({ status: 'updated', transaction: { phase: 'waiting', runId: 'run-1', currentPhysicalRunner: null } });

    // A later fire reserves a NEW runner: run-1 belongs to the consumed runner, so it is not inherited.
    const reserved2 = reserveQualificationRunner(waiting.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', leaseDurationMs: 1_000, started: false, nowMs: 500,
    });
    expect(reserved2).toMatchObject({ status: 'updated', transaction: { runId: null, phase: 'running' } });
    const attach = (from: typeof waiting.transaction) => reserveQualificationRunner(from, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-2', candidate: 'candidate-1',
      pid: 22, pidIdentity: 'boot-a:22', leaseDurationMs: 2_000, started: true, nowMs: 600,
      evidenceRefs: ['checkpoint-run:run-2'],
    });
    expect(attach(reserved2.transaction)).toMatchObject({ status: 'updated', transaction: { runId: 'run-2' } });

    // A row ALREADY wedged by the old code (the new runner inherited run-1) still activates.
    const wedged = { ...reserved2.transaction, runId: 'run-1' };
    const unwedged = attach(wedged);
    expect(unwedged).toMatchObject({
      status: 'updated',
      transaction: { runId: 'run-2', currentPhysicalRunner: { id: 'gate-fire-2', phase: 'materializing' } },
    });
    // ... and a verdict from the new run settles against it instead of being discarded.
    expect(settleQualificationTransaction(wedged, {
      attemptId: 'attempt-1', reason: 'not-green', green: false, candidate: 'candidate-1', runId: 'run-2', nowMs: 650,
    }).status).toBe('updated');

    // Single flight is intact: once run-2 is bound to the live runner, a different run id conflicts
    // on activation, and a zombie verdict from ended run-1 cannot settle the attempt.
    expect(reserveQualificationRunner(unwedged.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-3', leaseDurationMs: 1_000,
      started: true, nowMs: 700, evidenceRefs: ['checkpoint-run:run-3'],
    }).status).toBe('conflict');
    expect(settleQualificationTransaction(unwedged.transaction, {
      attemptId: 'attempt-1', reason: 'not-green', green: false, candidate: 'candidate-1', runId: 'run-1', nowMs: 800,
    }).status).toBe('conflict');
  });

  it('binds a run that settles BEFORE activating to its released runner, so no fresh runner inherits it (WI-10003212)', () => {
    // A scheduled reservation whose CLI lock-skips: it settles `skipped-locked` without ever
    // attaching, so the runner never recorded `checkpoint-run:skipped-run`.
    const reserved1 = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const skipped = settleQualificationTransaction(reserved1, {
      attemptId: 'attempt-1', reason: 'skipped-locked', candidate: 'candidate-1', runId: 'skipped-run', nowMs: 300,
    });
    expect(skipped).toMatchObject({ status: 'updated', transaction: { phase: 'waiting', runId: 'skipped-run' } });
    expect(skipped.transaction.consumedPhysicalRuns?.at(-1)).toMatchObject({
      id: 'gate-fire-1', evidenceRefs: expect.arrayContaining(['checkpoint-run:skipped-run']),
    });

    // The next fire's fresh reservation does not inherit the skipped run's id ...
    const reserved2 = reserveQualificationRunner(skipped.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', leaseDurationMs: 1_000, started: false, nowMs: 400,
    });
    expect(reserved2).toMatchObject({ status: 'updated', transaction: { runId: null } });
    // ... so its own CLI activates instead of being refused `run stored=skipped-run produced=run-2`.
    expect(reserveQualificationRunner(reserved2.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-2', runId: 'run-2', candidate: 'candidate-1',
      pid: 22, pidIdentity: 'boot-a:22', leaseDurationMs: 2_000, started: true, nowMs: 500,
      evidenceRefs: ['checkpoint-run:run-2'],
    })).toMatchObject({ status: 'updated', transaction: { runId: 'run-2' } });
  });

  it('recovers a row already wedged on an orphaned run id that aged out of history (WI-10003212)', () => {
    // Pre-fix shape: the attempt holds `orphan-run`, bound to no runner (the lock-skipped runner
    // aged out of the 32-run window), and a fresh scheduled placeholder inherited it.
    const placeholder = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-9', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const wedged = { ...placeholder, runId: 'orphan-run' };
    const attach = (from: Parameters<typeof reserveQualificationRunner>[0], runId: string, pid: number) => reserveQualificationRunner(from, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-9', runId, candidate: 'candidate-1',
      pid, pidIdentity: `boot-a:${pid}`, leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: [`checkpoint-run:${runId}`],
    });
    const recovered = attach(wedged, 'run-9', 99);
    expect(recovered).toMatchObject({
      status: 'updated',
      transaction: { runId: 'run-9', currentPhysicalRunner: { id: 'gate-fire-9', phase: 'materializing', pid: 99 } },
    });
    // Once a CLI has attached, single flight holds: a different run id against it conflicts.
    expect(attach(recovered.transaction, 'run-10', 100).status).toBe('conflict');
  });

  it('pins a terminal verdict to its own run id even when no runner was ever reserved', () => {
    // WI-10003212 made WAITS refuse to store an unbound run id (a fresh runner inherited it). A
    // terminal attempt refuses every later reservation, so its pin cannot be inherited — and
    // without it a DIFFERENT run's replay reads as an idempotent `terminal` instead of a conflict.
    const settled = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-terminal',
      reason: 'not-green', green: false, nowMs: 200,
    });
    expect(settled).toMatchObject({ status: 'updated', transaction: { phase: 'terminal', runId: 'run-terminal' } });
    const replay = { attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 300 };
    expect(settleQualificationTransaction(settled.transaction, { ...replay, runId: 'run-terminal' }).status).toBe('terminal');
    expect(settleQualificationTransaction(settled.transaction, { ...replay, runId: 'run-other' }).status).toBe('conflict');
    expect(reserveQualificationRunner(settled.transaction, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-late', leaseDurationMs: 1_000, started: false, nowMs: 400,
    }).status).toBe('terminal');
  });

  it('never stores a released run id that no runner can carry (WI-10003212)', () => {
    // run-1 activated and is bound to gate-fire-1; a late wait from an unrelated run must not
    // overwrite the attempt's run id with an unattributable one, nor re-bind gate-fire-1.
    const reserved = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', leaseDurationMs: 1_000, started: false, nowMs: 200,
    }).transaction;
    const started = reserveQualificationRunner(reserved, {
      attemptId: 'attempt-1', runnerId: 'gate-fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: 11, pidIdentity: 'boot-a:11', leaseDurationMs: 2_000, started: true, nowMs: 300,
      evidenceRefs: ['checkpoint-run:run-1'],
    }).transaction;
    const waited = waitQualificationTransaction(started, {
      attemptId: 'attempt-1', reason: 'repair-in-progress', runId: 'stray-run', nowMs: 400,
    });
    expect(waited).toMatchObject({ status: 'updated', transaction: { runId: 'run-1' } });
    const released = waited.transaction.consumedPhysicalRuns?.at(-1);
    expect(released?.evidenceRefs).toContain('checkpoint-run:run-1');
    expect(released?.evidenceRefs).not.toContain('checkpoint-run:stray-run');
    // With no runner at all, an unbound id is likewise not stored.
    const again = waitQualificationTransaction(waited.transaction, {
      attemptId: 'attempt-1', reason: 'wait-for-eligibility-unavailable', runId: 'stray-run', nowMs: 500,
    });
    expect(again.transaction.runId).toBe('run-1');
  });

  it('lets a live physical-run lease outrank a stale eligibility action', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      candidate: 'candidate-1',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const staleEligibility = buildCheckpointEligibilitySnapshot({
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      observedAtMs: 150,
      predicates: CHECKPOINT_ELIGIBILITY_PREDICATES.map((code) => ({
        code,
        status: ['candidate-migrations', 'dependency-generation', 'target-relation-reservation'].includes(code)
          ? ('deferred' as const)
          : ('clear' as const),
        detail: `${code} observed at request time`,
        clearEvents: [],
        evidenceRefs: [`test:${code}`],
      })),
    });
    const withStaleEligibility = {
      ...running,
      eligibilitySnapshot: staleEligibility,
    };

    expect(projectCheckpointQualificationState(withStaleEligibility, 250)).toMatchObject({
      phase: 'running',
      lease: { holder: 'physical-1', expired: false },
      eligibilitySnapshot: { safeNextAction: { code: 'launch-preflight-runner' } },
      safeNextAction: { code: 'await-current-run' },
    });
  });

  it('cancels only the exact attempt/unit and settles a terminal code-inconclusive outcome', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;

    const cancelled = cancelQualificationTransaction(running, {
      attemptId: 'attempt-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      nowMs: 300,
    });
    expect(cancelled).toMatchObject({
      status: 'updated',
      transaction: {
        phase: 'terminal',
        outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
        currentPhysicalRunner: null,
        consumedPhysicalRuns: [
          {
            id: 'physical-1',
            endedAtMs: 300,
            outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
          },
        ],
      },
    });

    expect(
      cancelQualificationTransaction(running, {
        attemptId: 'attempt-1',
        unit: 'another-checkpoint.service',
        nowMs: 300,
      }),
    ).toMatchObject({ status: 'conflict', transaction: running });
    expect(
      cancelQualificationTransaction(running, {
        attemptId: 'attempt-2',
        unit: 'papercup-green-checkpoint-manual-ge93sk.service',
        nowMs: 300,
      }),
    ).toMatchObject({ status: 'conflict', transaction: running });
  });

  it('projects blocker events, elapsed phase durations, terminal action, and consumed runs', () => {
    const running = reserveQualificationRunner(begin(), {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const waiting = waitQualificationTransaction(running, {
      attemptId: 'attempt-1',
      reason: 'eligibility-wait',
      blockers: [{ code: 'quiet-cut', clearEvents: ['checkpoint:eligible:attempt-1'] }],
      nowMs: 350,
    }).transaction;
    expect(projectCheckpointQualificationState(waiting, 500)).toMatchObject({
      phase: 'waiting',
      phaseDurationsMs: { ready: 100, running: 150, waiting: 150 },
      consumedPhysicalRuns: [{ id: 'physical-1', endedAtMs: 350 }],
      safeNextAction: {
        code: 'await-blocker-events',
        waitEvents: ['checkpoint:eligible:attempt-1'],
      },
    });

    const red = settleQualificationTransaction(waiting, {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 600,
    }).transaction;
    expect(projectCheckpointQualificationState(red, 700)).toMatchObject({
      phase: 'terminal',
      phaseDurationsMs: { ready: 100, running: 150, waiting: 250, terminal: 100 },
      safeNextAction: { code: 'repair-code' },
    });
  });

  it('retries only the explicit pre-suite no-verdict allowlist and makes red/code outcomes terminal', () => {
    expect(classifyQualificationVerdict({ reason: 'skipped-locked', green: null })).toEqual({
      kind: 'pre-suite-no-verdict',
      reason: 'skipped-locked',
    });
    expect(classifyQualificationVerdict({ reason: 'migrations-pending', green: null })).toEqual({
      kind: 'pre-suite-no-verdict',
      reason: 'migrations-pending',
    });
    expect(classifyQualificationVerdict({ reason: 'not-green', green: false })).toEqual({
      kind: 'red',
      reason: 'not-green',
    });
    expect(classifyQualificationVerdict({ reason: 'not-fast-forward', green: null })).toEqual({
      kind: 'code-inconclusive',
      reason: 'not-fast-forward',
    });

    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    expect(red).toMatchObject({ phase: 'terminal', outcome: { kind: 'red' }, currentPhysicalRunner: null });
    expect(
      waitQualificationTransaction(red, {
        attemptId: 'attempt-1',
        reason: 'eligibility-wait',
        nowMs: 500,
      }).status,
    ).toBe('terminal');
  });

  it('fails closed on malformed nested metadata instead of trusting a shallow record cast', () => {
    const current = begin();
    expect(parseCheckpointQualificationTransaction(current)).toEqual(current);
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        currentPhysicalRunner: {
          id: 'physical-1',
          candidate: null,
          reservedAtMs: 'not-a-number',
          evidenceRefs: [],
        },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        outcome: { kind: 'pre-suite-no-verdict', reason: 'invented-retry' },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        phaseDurationsMs: { running: -1 },
      }),
    ).toBeNull();
    expect(
      parseCheckpointQualificationTransaction({
        ...current,
        consumedPhysicalRuns: [{ id: 'run-1', outcome: { kind: 'invented' } }],
      }),
    ).toBeNull();
  });

  it('preserves the predecessor-linked unstarted candidate for a distinct successor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const safeQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'successor-repair',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    expect(assessTerminalRepairQueueReconciliation(terminal, successor, safeQueue)).toMatchObject({
      status: 'preserved',
      reason: 'exact-safe-unstarted',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: 'another-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    // A measured red is never RETIRED. Since WI-10007398 the unassigned awaiting-fixer queue it
    // leaves is handed to the successor (preserved) rather than blocking it; see the dedicated
    // test below for why a block here deadlocked the gate.
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        successor,
        markFrozenCandidateVerificationRed(safeQueue, {
          failingTests: ['broken.test.ts'],
          nowMs: 300,
        }),
      ),
    ).toMatchObject({ status: 'preserved', reason: 'awaiting-unassigned-fixer' });
  });

  describe('unstarted candidate with an admitted repair', () => {
    const terminal = () => settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1', reason: 'error', green: null, nowMs: 400,
    }).transaction;
    const successor = { attemptId: 'attempt-2', requiredAncestorSha: 'repair-1',
      declaredPaths: ['fixed.ts'], candidate: 'candidate-2', nowMs: 500 };
    const admitted = () => markFrozenRepairAdmitted(
      createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'attempt-1',
        base: null, nowMs: 200 }),
      { atMs: 350, actor: 'agent-1', source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1', toRepairHead: 'repair-1', paths: ['fixed.ts'],
        unchanged: [], blobs: { 'fixed.ts': 'blob-1' } },
    );

    it('preserves the admitted head across terminal handoff and judges the original candidate first', () => {
      const queue = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(admitted())))!;
      const before = structuredClone(queue);
      expect(queue).toMatchObject({ phase: 'ready-to-test', candidate: 'candidate-1', repairHead: 'repair-1' });
      expect(assessTerminalRepairQueueReconciliation(terminal(), successor, queue)).toMatchObject({
        status: 'preserved', reason: 'exact-safe-unstarted', candidate: 'candidate-1',
        predecessorAttemptId: 'attempt-1', successorAttemptId: 'attempt-2',
      });
      expect(queue).toEqual(before);
      expect(decideFrozenCandidateRepairQueue(queue, { nowMs: 600 })).toMatchObject({
        kind: 'test-candidate', candidate: 'candidate-1', runSuite: true, recordVerdict: true,
      });
      const measured = markFrozenCandidateVerificationRed(queue, {
        failingTests: ['broken.test.ts'], nowMs: 700,
      });
      expect(measured).toMatchObject({ phase: 'ready-to-verify', candidate: 'candidate-1',
        repairHead: 'repair-1', retestRequested: queue.retestRequested,
        convergenceRounds: [{ head: 'candidate-1' }] });
      expect(decideFrozenCandidateRepairQueue(measured, { nowMs: 800 })).toMatchObject({
        kind: 'verify-repair', candidate: 'repair-1', originalCandidate: 'candidate-1',
        runSuite: true, recordVerdict: true,
      });
    });

    it('refuses competing ownership and advanced heads without exact admission and pending proof', () => {
      const queue = admitted();
      const entry = queue.admissions![0]!;
      for (const changed of [
        { ...queue, attempts: 1 },
        { ...queue, fixerSpawnId: 'live-fixer' },
        { ...queue, dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 1000 } },
        { ...queue, qualificationAttemptId: 'other-attempt' },
        { ...queue, qualificationAttemptId: null },
        { ...queue, admissions: [] },
        { ...queue, admissions: [{ ...entry, toRepairHead: 'other-head' }] },
        { ...queue, admissions: [entry, { ...entry, atMs: 360, toRepairHead: 'other-head' }], updatedAtMs: 360 },
        { ...queue, retestRequested: undefined },
        { ...queue, retestRequested: { ...queue.retestRequested!, candidate: 'other-candidate' } },
        { ...queue, retestRequested: { ...queue.retestRequested!, repairHead: 'other-head' } },
        { ...queue, retestRequested: { ...queue.retestRequested!, requestedAtMs: 300 } },
      ]) {
        expect(parseFrozenCandidateRepairQueue(changed)).not.toBeNull();
        expect(assessTerminalRepairQueueReconciliation(terminal(), successor, changed).status).toBe('blocked');
      }
      // WI-6554700010015312: the immediate-predecessor link is the same single lineage one hop
      // back, so it carries provenance in every phase, including this admitted ready-to-test.
      // The admission proof is still required: drop it and the fence names what is missing.
      expect(assessTerminalRepairQueueReconciliation({ ...terminal(), previousAttemptId: 'older-attempt' },
        successor, { ...queue, qualificationAttemptId: 'older-attempt' }))
        .toMatchObject({ status: 'preserved', reason: 'exact-safe-unstarted' });
      expect(assessTerminalRepairQueueReconciliation({ ...terminal(), previousAttemptId: 'older-attempt' },
        successor, { ...queue, qualificationAttemptId: 'older-attempt', retestRequested: undefined }))
        .toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted', fence: 'admission-unproven' });
      // A two-hop-old origin is not the lineage.
      expect(assessTerminalRepairQueueReconciliation({ ...terminal(), previousAttemptId: 'older-attempt' },
        successor, { ...queue, qualificationAttemptId: 'oldest-attempt' }))
        .toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    });
  });

  // WI-10007398: the run that measures a red moves the queue to awaiting-fixer and exits; the
  // fixer is dispatched by the NEXT run's `dispatch-fixer` decision. Refusing that successor at
  // begin (queue-not-safe-unstarted) closed the only automatic path — measured 2026-10-07/08:
  // 13 consecutive hourly ticks refused with attempts=0, fixerSpawnId=null, nobody dispatched.
  it('hands an unassigned awaiting-fixer queue to the successor so its run can dispatch the fixer', () => {
    const awaitingFixer = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
      { failingTests: ['broken.test.ts'], nowMs: 300 },
    );
    expect(awaitingFixer.phase).toBe('awaiting-fixer');
    expect(awaitingFixer.fixerSpawnId).toBeNull();
    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };
    // The live shape: a terminal code-inconclusive attempt owns the queue.
    const inconclusive = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'error',
      green: null,
      nowMs: 400,
    }).transaction;
    expect(inconclusive.outcome.kind).toBe('code-inconclusive');
    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;

    for (const terminal of [inconclusive, red]) {
      expect(assessTerminalRepairQueueReconciliation(terminal, successor, awaitingFixer)).toMatchObject({
        status: 'preserved',
        reason: 'awaiting-unassigned-fixer',
        predecessorAttemptId: 'attempt-1',
        successorAttemptId: 'attempt-2',
        candidate: 'candidate-1',
      });
    }
    // An EXPIRED reservation is abandoned — the queue policy dispatches past it, so must begin.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        dispatchReservation: { token: 'stale', claimedAtMs: 100, expiresAtMs: 499 },
      }),
    ).toMatchObject({ status: 'preserved', reason: 'awaiting-unassigned-fixer' });

    // Negative controls — each keeps the fail-closed verdict.
    // A fixer is assigned: it advances the queue itself by admission.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, { ...awaitingFixer, fixerSpawnId: 's-live' }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    // A launch is in flight under an unexpired reservation.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    // Someone else's queue.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, {
        ...awaitingFixer,
        qualificationAttemptId: 'someone-else',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    // Unknown origin needs the exact repairHead pin, then remains safe to hand off only while
    // the fixer is unassigned and no dispatch reservation is live.
    const unknownOriginQueue = { ...awaitingFixer, qualificationAttemptId: null };
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successor, unknownOriginQueue),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
    const pinnedSuccessor = { ...successor, requiredAncestorSha: unknownOriginQueue.repairHead };
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, pinnedSuccessor, unknownOriginQueue),
    ).toMatchObject({ status: 'preserved', reason: 'awaiting-unassigned-fixer' });
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, {
        ...successor,
        requiredAncestorSha: 'different-repair-head',
      }, unknownOriginQueue),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
    // Once the pin supplies provenance, the refusal names the live competing owner rather than
    // the (already-resolved) unknown origin — naming the pin as the remedy would mislead.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, pinnedSuccessor, {
        ...unknownOriginQueue,
        fixerSpawnId: 's-live',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted', fence: 'fixer-not-proven-dead' });
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, pinnedSuccessor, {
        ...unknownOriginQueue,
        dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted', fence: 'dispatch-reserved' });
  });

  // WI-10007408: the same deadlock with a fixer ASSIGNED but dead. Observed 2026-10-08: the
  // papercusp fixer reached spawned_agents 'done' at 10:43Z with no admission and the queue
  // stayed awaiting-fixer naming it. Only the run's `recover-dead-fixer` branch clears that row,
  // and the run cannot start while begin refuses its successor.
  it('hands an awaiting-fixer queue whose assigned fixer is PROVABLY dead to the successor', () => {
    const awaitingDeadFixer = {
      ...markFrozenCandidateVerificationRed(
        createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
        { failingTests: ['broken.test.ts'], nowMs: 300 },
      ),
      fixerSpawnId: 's-dead',
      attempts: 1,
    };
    const inconclusive = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'error',
      green: null,
      nowMs: 400,
    }).transaction;
    const successorWith = (assignedFixerLiveness: { spawnId: string; liveness: 'live' | 'dead' | 'unknown' } | null) => ({
      attemptId: 'attempt-2',
      declaredPaths: [],
      candidate: 'candidate-2',
      nowMs: 500,
      assignedFixerLiveness,
    });

    const preserved = assessTerminalRepairQueueReconciliation(
      inconclusive,
      successorWith({ spawnId: 's-dead', liveness: 'dead' }),
      awaitingDeadFixer,
    );
    expect(preserved).toMatchObject({
      status: 'preserved',
      reason: 'awaiting-dead-fixer',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });
    // The handoff only helps if the successor's run can ACT on it: the run's own policy, fed
    // the same verdict (dead = fixerAlive false), must take the recovery exit. A preserve
    // with no matching exit would just move the deadlock one stage later.
    expect(decideFrozenCandidateRepairQueue(awaitingDeadFixer, { nowMs: 600, fixerAlive: false }).kind).toBe(
      'recover-dead-fixer',
    );

    // Negative controls — each keeps the old fail-closed verdict.
    const blocked = { status: 'blocked', reason: 'queue-not-safe-unstarted' };
    // A live fixer advances the queue itself by admission.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successorWith({ spawnId: 's-dead', liveness: 'live' }), awaitingDeadFixer),
    ).toMatchObject(blocked);
    // An unmeasurable fixer must not be raced.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successorWith({ spawnId: 's-dead', liveness: 'unknown' }), awaitingDeadFixer),
    ).toMatchObject(blocked);
    // No probe at all (every pre-WI-10007408 caller).
    expect(assessTerminalRepairQueueReconciliation(inconclusive, successorWith(null), awaitingDeadFixer)).toMatchObject(blocked);
    // A probe of a DIFFERENT (superseded) spawn cannot vouch for the fixer the row names now.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successorWith({ spawnId: 's-older', liveness: 'dead' }), awaitingDeadFixer),
    ).toMatchObject(blocked);
    // A launch is in flight under an unexpired reservation.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successorWith({ spawnId: 's-dead', liveness: 'dead' }), {
        ...awaitingDeadFixer,
        dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject(blocked);
    // Someone else's queue stays theirs even with a dead fixer.
    expect(
      assessTerminalRepairQueueReconciliation(inconclusive, successorWith({ spawnId: 's-dead', liveness: 'dead' }), {
        ...awaitingDeadFixer,
        qualificationAttemptId: 'someone-else',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
  });

  // green-main-cycle-time-2026-10-08 P-001 / WI-10007578. The two tests above prove each begin
  // arm in isolation. This one pins the END-TO-END property the gate actually needs: an
  // awaiting-fixer queue left behind by a terminal predecessor gets a fixer DISPATCHED within the
  // successor's one tick. Measured 2026-09-22 -> 2026-10-08: dispatchReleaseFixer was not
  // reached for hours at a time because begin refused the successor (queue-not-safe-unstarted),
  // and each fix (WI-10007398 unassigned, WI-10007408 dead) closed one arm while every other
  // narrowing kept failing closed. A future edit that preserves at begin but has no matching
  // dispatch exit, or that dispatches but refuses at begin, fails here instead of freezing main.
  it('dispatches a fixer within one tick for every awaiting-fixer queue a terminal predecessor leaves behind', () => {
    const maxAttempts = 3; // DEFAULT_FROZEN_REPAIR_QUEUE_LIMITS.maxAttempts
    const terminalFor = (attemptId: string, kind: 'red' | 'code-inconclusive') => {
      const begun = beginQualificationTransaction(null, {
        attemptId,
        requiredAncestorSha: 'abc123',
        declaredPaths: [],
        candidate: 'candidate-1',
        nowMs: 100,
      }).transaction;
      const settled = settleQualificationTransaction(begun, {
        attemptId,
        ...(kind === 'red' ? ({ reason: 'not-green', green: false } as const) : ({ reason: 'error', green: null } as const)),
        nowMs: 400,
      }).transaction;
      expect(settled.outcome.kind).toBe(kind);
      return settled;
    };
    const redQueue = (qualificationAttemptId: string) =>
      markFrozenCandidateVerificationRed(
        createFrozenCandidateQueue({ candidate: 'candidate-1', qualificationAttemptId, base: null, nowMs: 200 }),
        { failingTests: ['broken.test.ts'], nowMs: 300 },
      );

    // One scheduled tick, composed exactly as the gate composes it: begin reconciliation with the
    // caller's liveness probe, then the run's queue policy, then (on a dead fixer) the persisted
    // recovery and a re-decide, then the dispatch transition.
    const tick = (
      terminal: ReturnType<typeof terminalFor>,
      queue: ReturnType<typeof redQueue>,
      nowMs: number,
      assess: typeof assessTerminalRepairQueueReconciliation = assessTerminalRepairQueueReconciliation,
    ) => {
      const fixerAlive = queue.fixerSpawnId ? false : undefined;
      const reconciliation = assess(
        terminal,
        {
          attemptId: `successor-of-${terminal.attemptId}`,
          declaredPaths: [],
          candidate: 'candidate-2',
          nowMs,
          assignedFixerLiveness: queue.fixerSpawnId ? { spawnId: queue.fixerSpawnId, liveness: 'dead' } : null,
        },
        queue,
      );
      if (reconciliation.status !== 'preserved') return { begin: reconciliation, decisions: [] as string[], dispatched: null };
      const decisions: string[] = [];
      let current = queue;
      let decision = decideFrozenCandidateRepairQueue(current, { nowMs, fixerAlive });
      decisions.push(decision.kind);
      if (decision.kind === 'recover-dead-fixer') {
        current = markFrozenRepairFixerDead(current, { spawnId: decision.fixerSpawnId, nowMs });
        decision = decideFrozenCandidateRepairQueue(current, { nowMs });
        decisions.push(decision.kind);
      }
      const dispatched =
        decision.kind === 'dispatch-fixer'
          ? markFrozenRepairFixerDispatched(current, { spawnId: `fixer-${decision.nextAttempt}`, nowMs })
          : null;
      return { begin: reconciliation, decisions, dispatched };
    };

    const cases: Array<{ name: string; queue: ReturnType<typeof redQueue>; expectDecisions: string[] }> = [];
    for (const kind of ['red', 'code-inconclusive'] as const) {
      const base = redQueue('attempt-1');
      cases.push({ name: `${kind} / unassigned`, queue: base, expectDecisions: ['dispatch-fixer'] });
      cases.push({
        name: `${kind} / unassigned behind an expired reservation`,
        queue: { ...base, dispatchReservation: { token: 'stale', claimedAtMs: 100, expiresAtMs: 499 } },
        expectDecisions: ['dispatch-fixer'],
      });
      for (let attempts = 1; attempts < maxAttempts; attempts++) {
        cases.push({
          name: `${kind} / dead fixer after ${attempts} attempt(s)`,
          queue: { ...base, fixerSpawnId: `fixer-${attempts}`, attempts },
          expectDecisions: ['recover-dead-fixer', 'dispatch-fixer'],
        });
      }
      for (const c of cases.filter((entry) => entry.name.startsWith(kind))) {
        const result = tick(terminalFor('attempt-1', kind), c.queue, 500);
        expect(result.begin, c.name).toMatchObject({ status: 'preserved' });
        expect(result.decisions, c.name).toEqual(c.expectDecisions);
        expect(result.dispatched, c.name).not.toBeNull();
        expect(result.dispatched!.fixerSpawnId, c.name).toMatch(/^fixer-\d+$/);
        expect(result.dispatched!.attempts, c.name).toBe(c.queue.attempts + 1);
      }
    }

    // The live 2026-10-08 sequence: the successor that inherited the queue at begin was re-stamped
    // as its owner, then crashed pre-verdict (ENOSPC in npm-install-safe at 17:28Z), so the queue
    // now names THAT attempt while still awaiting a dead fixer. The next successor must dispatch.
    const inherited = { ...redQueue('attempt-2'), fixerSpawnId: 'fixer-1', attempts: 1 };
    const crashedHeir = tick(terminalFor('attempt-2', 'code-inconclusive'), inherited, 700);
    expect(crashedHeir.begin).toMatchObject({ status: 'preserved', reason: 'awaiting-dead-fixer' });
    expect(crashedHeir.decisions).toEqual(['recover-dead-fixer', 'dispatch-fixer']);
    expect(crashedHeir.dispatched?.attempts).toBe(2);

    // Boundary control: at the attempt budget the queue HOLDS (D-005 exhaustion escalates, never
    // re-cuts), but it still holds through the run's decision, not through a refusal at begin.
    const exhausted = tick(terminalFor('attempt-1', 'red'), { ...redQueue('attempt-1'), fixerSpawnId: 'fixer-3', attempts: maxAttempts }, 500);
    expect(exhausted.begin).toMatchObject({ status: 'preserved', reason: 'awaiting-dead-fixer' });
    expect(exhausted.decisions).toEqual(['recover-dead-fixer', 'hold-exhausted']);
    expect(exhausted.dispatched).toBeNull();

    // Falsifiability control (kept permanently, per the testing doctrine for imported modules):
    // the pre-WI-10007408 begin, which refused an assigned-but-dead fixer, must make this
    // composed tick report NO dispatch. If it did not, the assertions above could pass vacuously.
    const preWi10007408: typeof assessTerminalRepairQueueReconciliation = (current, successor, raw) => {
      const verdict = assessTerminalRepairQueueReconciliation(current, successor, raw);
      return verdict.reason === 'awaiting-dead-fixer'
        ? { ...verdict, status: 'blocked', reason: 'queue-not-safe-unstarted' }
        : verdict;
    };
    const regressed = tick(terminalFor('attempt-2', 'code-inconclusive'), inherited, 700, preWi10007408);
    expect(regressed.begin).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    expect(regressed.dispatched).toBeNull();
  });

  // EI-24610407938327281: a green advance whose P-008 staging bridge lost the git-sync lock
  // leaves `ready-to-promote` as the retry marker. Blocking the successor qualification
  // made that retry unreachable and deadlocked the gate for hours.
  it('preserves a promoted ready-to-promote queue so the next run can retry the staging bridge', () => {
    const provenGreen = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'advanced',
      green: true,
      nowMs: 400,
    }).transaction;
    // Built through the real transitions (red → admit → verification green) so the
    // parser accepts it exactly as it accepts the live row.
    const promoted = markFrozenRepairVerificationGreen(
      markFrozenRepairAdmitted(
        markFrozenCandidateVerificationRed(
          createFrozenCandidateQueue({ candidate: 'frozen-0', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
          { failingTests: ['broken.test.ts'], nowMs: 250 },
        ),
        {
          atMs: 300,
          actor: 'agent-1',
          source: { ref: 'staging', sha: 'candidate-1' },
          fromRepairHead: 'frozen-0',
          toRepairHead: 'candidate-1',
          paths: ['fixed.ts'],
          unchanged: [],
          blobs: { 'fixed.ts': 'blob-1' },
        },
      ),
      { repairHead: 'candidate-1', nowMs: 350 },
    );
    expect(promoted.phase).toBe('ready-to-promote');
    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };

    expect(assessTerminalRepairQueueReconciliation(provenGreen, successor, promoted)).toMatchObject({
      status: 'preserved',
      reason: 'promoted-awaiting-staging-bridge',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
    });
    // Negative controls — each keeps the old fail-closed verdict.
    const red = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    expect(assessTerminalRepairQueueReconciliation(red, successor, promoted)).toMatchObject({
      status: 'blocked',
      reason: 'queue-not-safe-unstarted',
    });
    expect(
      assessTerminalRepairQueueReconciliation(provenGreen, successor, { ...promoted, repairHead: 'other-head' }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
    expect(
      assessTerminalRepairQueueReconciliation(provenGreen, successor, {
        ...promoted,
        qualificationAttemptId: 'someone-else',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });

    // Measured 2026-09-30 (queue 9a4319b70a): the preserved retry itself lost the git-sync lock
    // and settled code-inconclusive on a TIP candidate while re-stamping the queue as its own.
    // That no-verdict attempt must hand the retry marker forward, or the deadlock recurs one
    // retry later. A red retry still fails closed (asserted above for the same queue shape).
    const retryInconclusive = settleQualificationTransaction(
      beginQualificationTransaction(null, {
        attemptId: 'attempt-2',
        declaredPaths: [],
        candidate: 'tip-2',
        evidenceRefs: ['gate-fire:attempt-2'],
        nowMs: 500,
      }).transaction,
      { attemptId: 'attempt-2', reason: 'error', green: null, nowMs: 600 },
    ).transaction;
    expect(retryInconclusive.outcome.kind).toBe('code-inconclusive');
    const restamped = { ...promoted, qualificationAttemptId: 'attempt-2' };
    const nextSuccessor = { attemptId: 'attempt-3', declaredPaths: [], candidate: 'tip-3', nowMs: 700 };
    expect(assessTerminalRepairQueueReconciliation(retryInconclusive, nextSuccessor, restamped)).toMatchObject({
      status: 'preserved',
      reason: 'promoted-awaiting-staging-bridge',
      predecessorAttemptId: 'attempt-2',
      successorAttemptId: 'attempt-3',
    });
    expect(
      assessTerminalRepairQueueReconciliation(retryInconclusive, nextSuccessor, {
        ...restamped,
        dispatchReservation: { token: 'fixer-1', claimedAtMs: 650, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked' });
  });

  it('preserves a predecessor-linked repair head that is ready for its first verification', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      {
        failingTests: ['broken.test.ts'],
        nowMs: 300,
      },
    );
    const readyToVerify = markFrozenRepairAdmitted(redCandidate, {
      atMs: 350,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'repair-1',
      declaredPaths: [],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    expect(assessTerminalRepairQueueReconciliation(terminal, successor, readyToVerify)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...readyToVerify,
        qualificationAttemptId: null,
      }),
    ).toMatchObject({ status: 'preserved', reason: 'matching-untested-repair-head' });
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        { ...successor, requiredAncestorSha: 'different-repair' },
        { ...readyToVerify, qualificationAttemptId: null },
      ),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...readyToVerify,
        convergenceRounds: [
          ...(readyToVerify.convergenceRounds ?? []),
          { round: 2, head: 'repair-1', failingCount: 1, atMs: 360 },
        ],
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted' });
  });

  // WI-6554700010029878: a terminal no-verdict predecessor must preserve an unmeasured head even
  // when the pending-request marker is missing and no convergence round records a verdict.
  it('preserves an unmarked unmeasured retest after an inconclusive no-verdict predecessor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'unchanged-since-verdict',
      green: null,
      nowMs: 400,
    }).transaction;
    expect(terminal.outcome.kind).toBe('code-inconclusive');

    const baseQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    });
    const unmarkedRetest = {
      ...baseQueue,
      phase: 'ready-to-verify' as const,
      unmeasuredRetestHead: 'candidate-1',
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: null,
      convergenceRounds: [],
      retestRequested: undefined,
    };
    expect(unmarkedRetest).toMatchObject({
      phase: 'ready-to-verify',
      candidate: 'candidate-1',
      repairHead: 'candidate-1',
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: null,
      convergenceRounds: [],
      unmeasuredRetestHead: 'candidate-1',
    });
    expect(unmarkedRetest.retestRequested).toBeUndefined();

    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };
    expect(assessTerminalRepairQueueReconciliation(terminal, successor, unmarkedRetest)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });

    const redTerminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    expect(assessTerminalRepairQueueReconciliation(redTerminal, successor, unmarkedRetest)).toMatchObject({
      status: 'blocked',
      reason: 'queue-not-safe-unstarted',
      fence: 'head-already-judged',
    });

    const judgedRetest = {
      ...markFrozenRepairUnmeasuredRetest(
        markFrozenCandidateVerificationRed(
          createFrozenCandidateQueue({
            candidate: 'candidate-1',
            qualificationAttemptId: 'attempt-1',
            base: null,
            nowMs: 200,
          }),
          { failingTests: [], nowMs: 300 },
        ),
        { nowMs: 350 },
      ),
      retestRequested: undefined,
    };
    expect(assessTerminalRepairQueueReconciliation(terminal, successor, judgedRetest)).toMatchObject({
      status: 'blocked',
      reason: 'queue-not-safe-unstarted',
      fence: 'head-already-judged',
    });
  });

  // WI-6554700010018169 — measured on slack-asana-bug-drill 2026-10-15 → 2026-10-20: the
  // once-per-head retest marker normally preserves a same-head verification after an inconclusive
  // predecessor, including when that head already has a convergence round.
  it('preserves a same-head unmeasured retest left pending by an inconclusive predecessor', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'unchanged-since-verdict',
      green: null,
      nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      { failingTests: [], nowMs: 300 },
    );
    const retest = markFrozenRepairUnmeasuredRetest(redCandidate, { nowMs: 350 });
    // The exact wedged shape: verification owed at a head the suite already judged.
    expect(retest).toMatchObject({
      phase: 'ready-to-verify',
      repairHead: 'candidate-1',
      candidate: 'candidate-1',
      unmeasuredRetestHead: 'candidate-1',
      retestRequested: { repairHead: 'candidate-1' },
    });
    expect(frozenRepairHeadAwaitsVerification(retest)).toBe(false);
    expect(frozenRepairHeadOwesVerification(retest)).toBe(true);

    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-2', nowMs: 500 };
    expect(assessTerminalRepairQueueReconciliation(terminal, successor, retest)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });

    // Narrow on purpose: once a pass at that head settles the marker, the same row is an
    // already-judged head again and stays blocked; a live dispatch lease still fences it.
    const settled = settleFrozenRepairRetestRequest(retest, 'candidate-1');
    expect(settled.kind).toBe('settled');
    expect(frozenRepairHeadOwesVerification(settled.queue)).toBe(false);
    expect(assessTerminalRepairQueueReconciliation(terminal, successor, settled.queue)).toMatchObject({
      status: 'blocked',
      reason: 'queue-not-safe-unstarted',
    });
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...retest,
        dispatchReservation: { token: 'fixer-1', claimedAtMs: 450, expiresAtMs: 9_999_999 },
      }),
    ).toMatchObject({ status: 'blocked' });
    // A marker naming an OLDER head does not vouch for the current one.
    expect(frozenRepairHeadOwesVerification({ ...retest, unmeasuredRetestHead: 'older-head' })).toBe(false);
  });

  it('preserves a completed-fixer repair head whose spawn id is retained as provenance', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      { failingTests: ['broken.test.ts'], nowMs: 300 },
    );
    // A completed fixer is represented by ready-to-verify plus its historical spawn id;
    // the id is deliberately retained for lineage diagnostics and is not a live lease.
    const completedFixerQueue = {
      ...markFrozenRepairAdmitted(redCandidate, {
        atMs: 350,
        actor: 'agent-1',
        source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1',
        toRepairHead: 'repair-1',
        paths: ['fixed.ts'],
        unchanged: [],
        blobs: { 'fixed.ts': 'blob-1' },
      }),
      fixerSpawnId: 'completed-fixer-1',
    };
    expect(completedFixerQueue.phase).toBe('ready-to-verify');

    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        {
          attemptId: 'attempt-2',
          requiredAncestorSha: 'repair-1',
          declaredPaths: [],
          candidate: 'candidate-2',
          nowMs: 500,
        },
        completedFixerQueue,
      ),
    ).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      candidate: 'candidate-1',
    });
  });

  it('preserves an untested repair head linked through the terminal attempt immediate predecessor', () => {
    const firstTerminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const inherited = beginQualificationTransaction(firstTerminal, {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'candidate-1',
      candidate: 'candidate-1',
      nowMs: 450,
    }).transaction;
    const current = settleQualificationTransaction(inherited, {
      attemptId: 'attempt-2',
      reason: 'dependency-prewarm-missing',
      nowMs: 500,
    }).transaction;
    expect(current).toMatchObject({
      attemptId: 'attempt-2',
      previousAttemptId: 'attempt-1',
      phase: 'terminal',
      outcome: { kind: 'code-inconclusive' },
    });

    const redCandidate = markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({
        candidate: 'candidate-1',
        qualificationAttemptId: 'attempt-1',
        base: null,
        nowMs: 200,
      }),
      {
        failingTests: ['broken.test.ts'],
        nowMs: 300,
      },
    );
    const readyToVerify = markFrozenRepairAdmitted(redCandidate, {
      atMs: 350,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const successor = {
      attemptId: 'attempt-3',
      requiredAncestorSha: 'repair-1',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 600,
    };

    expect(assessTerminalRepairQueueReconciliation(current, successor, readyToVerify)).toMatchObject({
      status: 'preserved',
      reason: 'matching-untested-repair-head',
      predecessorAttemptId: 'attempt-2',
      successorAttemptId: 'attempt-3',
      candidate: 'candidate-1',
    });
    expect(
      assessTerminalRepairQueueReconciliation(current, successor, {
        ...readyToVerify,
        qualificationAttemptId: 'unrelated-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
    expect(
      assessTerminalRepairQueueReconciliation(current, successor, {
        ...readyToVerify,
        convergenceRounds: [
          ...(readyToVerify.convergenceRounds ?? []),
          { round: 2, head: 'repair-1', failingCount: 1, atMs: 550 },
        ],
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted', fence: 'head-already-judged' });
  });

  // WI-6554700010015312: the reconciliation is a GENERAL handoff, not a shape allowlist. Each
  // past deadlock (EI-24610407938327281, WI-10000288, WI-10007398, WI-10007408,
  // WI-6554700010018169) was one more legitimate queue shape missing from the old list, and the
  // refused successor was the only run that could act on it. A lineage-linked queue in ANY phase
  // is now handed forward unless a NAMED fence holds.
  describe('general handoff across every queue phase (WI-6554700010015312)', () => {
    const settled = (green: boolean | null, reason: string) =>
      settleQualificationTransaction(begin(), { attemptId: 'attempt-1', reason, green, nowMs: 400 }).transaction;
    const inconclusive = () => settled(null, 'error');
    const red = () => settled(false, 'not-green');
    const provenGreen = () => settled(true, 'advanced');
    const successor = { attemptId: 'attempt-2', declaredPaths: [], candidate: 'candidate-9', nowMs: 500 };
    // begin() judges 'candidate-1', so the promoted fixture's repairHead is 'candidate-1'.
    const awaitingFixer = () => markFrozenCandidateVerificationRed(
      createFrozenCandidateQueue({ candidate: 'frozen-0', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
      { failingTests: ['broken.test.ts'], nowMs: 250 },
    );
    const readyToVerify = () => markFrozenRepairAdmitted(awaitingFixer(), {
      atMs: 300, actor: 'agent-1', source: { ref: 'staging', sha: 'candidate-1' }, fromRepairHead: 'frozen-0',
      toRepairHead: 'candidate-1', paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    const fixtures: Record<FrozenCandidateRepairPhase, () => FrozenCandidateRepairQueue> = {
      'ready-to-test': () =>
        createFrozenCandidateQueue({ candidate: 'frozen-0', qualificationAttemptId: 'attempt-1', base: null, nowMs: 200 }),
      'awaiting-fixer': awaitingFixer,
      'ready-to-verify': readyToVerify,
      'ready-to-promote': () => markFrozenRepairVerificationGreen(readyToVerify(), { repairHead: 'candidate-1', nowMs: 350 }),
      blocked: () => markFrozenRepairExhausted(awaitingFixer(), { reason: 'attempts-exhausted', nowMs: 350 }),
    };
    // Record<FrozenCandidateRepairPhase, …> makes a new phase a compile error HERE as well as in
    // the switch, so the handoff decision for it cannot be skipped.
    const preservedReason: Record<FrozenCandidateRepairPhase, string> = {
      'ready-to-test': 'exact-safe-unstarted',
      'awaiting-fixer': 'awaiting-unassigned-fixer',
      'ready-to-verify': 'matching-untested-repair-head',
      'ready-to-promote': 'promoted-awaiting-staging-bridge',
      blocked: 'blocked-hold-handoff',
    };
    const roundTrip = (q: FrozenCandidateRepairQueue) => parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))!;

    for (const phase of Object.keys(fixtures) as FrozenCandidateRepairPhase[]) {
      it(`hands a lineage-linked ${phase} queue to the successor, and the run then acts on it`, () => {
        const queue = roundTrip(fixtures[phase]());
        expect(queue.phase).toBe(phase);
        // ready-to-promote carries green proof, so its owner is the green attempt; every other
        // phase is handed forward by the inconclusive attempt that most often owns it live.
        const terminal = phase === 'ready-to-promote' ? provenGreen() : inconclusive();
        expect(assessTerminalRepairQueueReconciliation(terminal, successor, queue)).toMatchObject({
          status: 'preserved', reason: preservedReason[phase], candidate: 'frozen-0',
          predecessorAttemptId: 'attempt-1', successorAttemptId: 'attempt-2',
        });
        // Same lineage one hop back carries the same provenance.
        expect(assessTerminalRepairQueueReconciliation(
          { ...terminal, attemptId: 'attempt-1b', previousAttemptId: 'attempt-1' }, successor, queue,
        )).toMatchObject({ status: 'preserved', reason: preservedReason[phase] });
        // The handed-forward queue yields a real decision, never an unhandled shape.
        expect(decideFrozenCandidateRepairQueue(queue, { nowMs: 600, fixerAlive: null })).toHaveProperty('kind');
        // A live dispatch reservation fences every phase.
        expect(assessTerminalRepairQueueReconciliation(terminal, successor, {
          ...queue, dispatchReservation: { token: 'live', claimedAtMs: 450, expiresAtMs: 9_999_999 },
        })).toMatchObject({ status: 'blocked', reason: 'queue-not-safe-unstarted', fence: 'dispatch-reserved' });
        // Someone else's queue stays fail-closed in every phase.
        expect(assessTerminalRepairQueueReconciliation(terminal, successor, {
          ...queue, qualificationAttemptId: 'someone-else',
        })).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
      });
    }

    it('keeps each named fence fail-closed', () => {
      const fenceOf = (terminal: ReturnType<typeof settled>, queue: FrozenCandidateRepairQueue,
        next: typeof successor & { assignedFixerLiveness?: { spawnId: string; liveness: 'live' | 'dead' | 'unknown' } } = successor) =>
        assessTerminalRepairQueueReconciliation(terminal, next, queue);
      const assigned = markFrozenRepairFixerDispatched(awaitingFixer(), { spawnId: 's-fixer', nowMs: 320 });
      for (const liveness of [undefined, 'live', 'unknown'] as const) {
        expect(fenceOf(inconclusive(), assigned,
          liveness ? { ...successor, assignedFixerLiveness: { spawnId: 's-fixer', liveness } } : successor))
          .toMatchObject({ status: 'blocked', fence: 'fixer-not-proven-dead' });
      }
      expect(fenceOf(inconclusive(), assigned,
        { ...successor, assignedFixerLiveness: { spawnId: 's-fixer', liveness: 'dead' } }))
        .toMatchObject({ status: 'preserved', reason: 'awaiting-dead-fixer' });
      // Liveness for a DIFFERENT spawn proves nothing about this row's fixer.
      expect(fenceOf(inconclusive(), assigned,
        { ...successor, assignedFixerLiveness: { spawnId: 's-other', liveness: 'dead' } }))
        .toMatchObject({ status: 'blocked', fence: 'fixer-not-proven-dead' });
      // A red terminal cannot carry ready-to-promote's green proof forward.
      expect(fenceOf(red(), fixtures['ready-to-promote']()))
        .toMatchObject({ status: 'blocked', fence: 'promotion-unproven' });
      // Green proof at a DIFFERENT head is not proof for this head.
      expect(fenceOf(provenGreen(), { ...fixtures['ready-to-promote'](), repairHead: 'other-head' }))
        .toMatchObject({ status: 'blocked', fence: 'promotion-unproven' });
      // A ready-to-verify head the suite already judged would be declined by the run itself.
      const judged = fixtures['ready-to-verify']();
      expect(fenceOf(inconclusive(), {
        ...judged,
        convergenceRounds: [...(judged.convergenceRounds ?? []), { round: 2, head: judged.repairHead, failingCount: 1, atMs: 360 }],
      })).toMatchObject({ status: 'blocked', fence: 'head-already-judged' });
      // No transition counts an attempt before the candidate is judged.
      expect(fenceOf(inconclusive(), { ...fixtures['ready-to-test'](), attempts: 1 }))
        .toMatchObject({ status: 'blocked', fence: 'queue-integrity' });
      // An EXPIRED reservation is abandoned in every phase, not a fence.
      expect(fenceOf(inconclusive(), {
        ...fixtures.blocked(), dispatchReservation: { token: 'stale', claimedAtMs: 100, expiresAtMs: 499 },
      })).toMatchObject({ status: 'preserved', reason: 'blocked-hold-handoff' });
    });

    it('keeps an unpinned null-origin queue fail-closed outside the idle unstarted candidate', () => {
      for (const phase of Object.keys(fixtures) as FrozenCandidateRepairPhase[]) {
        const queue = { ...roundTrip(fixtures[phase]()), qualificationAttemptId: null };
        const verdict = assessTerminalRepairQueueReconciliation(inconclusive(), successor, queue);
        if (phase === 'ready-to-test') {
          expect(verdict).toMatchObject({ status: 'preserved', reason: 'exact-safe-unstarted' });
        } else {
          expect(verdict).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
        }
      }
      // A pin on the exact repairHead supplies the link — except for ready-to-promote, whose
      // green proof needs a KNOWN lineage, not just a head match.
      const promote = { ...fixtures['ready-to-promote'](), qualificationAttemptId: null };
      expect(assessTerminalRepairQueueReconciliation(provenGreen(),
        { ...successor, requiredAncestorSha: promote.repairHead }, promote))
        .toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });
      const held = { ...fixtures.blocked(), qualificationAttemptId: null };
      expect(assessTerminalRepairQueueReconciliation(inconclusive(),
        { ...successor, requiredAncestorSha: held.repairHead }, held))
        .toMatchObject({ status: 'preserved', reason: 'blocked-hold-handoff' });
    });
  });

  // WI-2142947: a NULL qualificationAttemptId (schema v3 permits this, WI-41667) is an
  // ABSENCE of provenance, not evidence of a competing owner. It must not be treated as a
  // permanent 'queue-origin-mismatch' fail-close; it falls through to the same
  // phase/attempts/fixer safety checks as a known-matching origin.
  it('judges a null-origin queue (unknown provenance) on its actual state instead of permanently fail-closing it', () => {
    const terminal = settleQualificationTransaction(begin(), {
      attemptId: 'attempt-1',
      reason: 'not-green',
      green: false,
      nowMs: 400,
    }).transaction;
    const safeQueue = createFrozenCandidateQueue({
      candidate: 'candidate-1',
      qualificationAttemptId: 'attempt-1',
      base: null,
      nowMs: 200,
    });
    const successor = {
      attemptId: 'attempt-2',
      requiredAncestorSha: 'successor-repair',
      declaredPaths: ['fixed.ts'],
      candidate: 'candidate-2',
      nowMs: 500,
    };

    // Null-origin AND exact/safe/unstarted -> preserved, same as a known-matching origin. This
    // is the concrete case that used to permanently fail-close manual release:checkpoint-run.
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: undefined,
      }),
    ).toMatchObject({
      status: 'preserved',
      reason: 'exact-safe-unstarted',
      predecessorAttemptId: 'attempt-1',
      successorAttemptId: 'attempt-2',
      candidate: 'candidate-1',
    });

    // Null-origin but genuinely NOT idle (mid-repair) -> still blocked, but diagnosable as
    // origin-unknown rather than reading like a takeover race against a known owner.
    expect(
      assessTerminalRepairQueueReconciliation(
        terminal,
        successor,
        markFrozenCandidateVerificationRed(
          { ...safeQueue, qualificationAttemptId: undefined },
          { failingTests: ['broken.test.ts'], nowMs: 300 },
        ),
      ),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-unknown' });

    // A KNOWN, DIFFERENT origin is still a genuine mismatch and stays fail-closed forever.
    expect(
      assessTerminalRepairQueueReconciliation(terminal, successor, {
        ...safeQueue,
        qualificationAttemptId: 'another-attempt',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'queue-origin-mismatch' });
  });
});

// WI-6554700010042670: the measured wedge. A scheduled runner judging candidate 7147ef76 was
// cancelled after admissions had moved the queue to 5dfdd8f0; its attempt settled as a runner-less
// `cancelled` wait carrying pendingRepairHead 5dfdd8f0, and every successor begin conflicted for 3h.
describe('superseded cancelled wait', () => {
  const cancelledWait = (overrides: Partial<ReturnType<typeof begin>> = {}) => ({
    ...begin(),
    phase: 'waiting' as const,
    outcome: { kind: 'pre-suite-no-verdict' as const, reason: 'cancelled' as const },
    currentPhysicalRunner: null,
    repairHead: null,
    pendingRepairHead: 'admitted-head',
    updatedAtMs: 1_000,
    ...overrides,
  });
  // Well inside QUALIFICATION_OWNER_ABANDONED_MS of updatedAtMs: only the new rule can release it.
  const successor = { attemptId: 'attempt-2', candidate: 'admitted-head', nowMs: 2_000 };

  it('lets a successor attempt replace a cancelled wait whose judged head an admission superseded', () => {
    const result = beginQualificationTransaction(cancelledWait(), successor);
    expect(result.status).toBe('updated');
    expect(result.transaction).toMatchObject({
      attemptId: 'attempt-2',
      previousAttemptId: 'attempt-1',
      phase: 'ready',
      outcome: { kind: 'pending' },
    });
  });

  it('judges supersession against repairHead when the attempt judged one', () => {
    expect(beginQualificationTransaction(cancelledWait({ repairHead: 'old-head' }), successor).status).toBe('updated');
    // The pending head IS the judged repair head: nothing superseded it, so the attempt stays owned.
    expect(
      beginQualificationTransaction(
        cancelledWait({ repairHead: 'admitted-head', pendingRepairHead: 'admitted-head' }),
        successor,
      ).status,
    ).toBe('conflict');
  });

  it('keeps a non-superseded cancelled wait owned so its own attempt can resume it', () => {
    const current = cancelledWait({ pendingRepairHead: null });
    expect(beginQualificationTransaction(current, successor).status).toBe('conflict');
    expect(
      beginQualificationTransaction(current, { attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 2_000 }).status,
    ).toBe('idempotent');
  });

  it('does not release a superseded wait for any reason other than a runner-recorded cancellation', () => {
    for (const reason of ['repair-in-progress', 'eligibility-wait', 'deadline-exceeded'] as const) {
      const current = cancelledWait({ outcome: { kind: 'pre-suite-no-verdict', reason } });
      expect(beginQualificationTransaction(current, successor).status).toBe('conflict');
    }
  });
});
