import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ boundedOrgTxn: vi.fn(), appendPipelineEvent: vi.fn() }));

vi.mock('../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
vi.mock('../harness/git-sync/pipeline-events', () => ({ appendPipelineEvent: h.appendPipelineEvent }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  cancelStoredQualification,
  reserveQualificationRunner,
  reserveStoredQualificationRunner,
  recordStoredQualificationWorkProgress,
  recordStoredQualificationChildScope,
  recordQualificationChildScope,
  configureRunnerLivenessProber,
  recordStoredQualificationWorkYield,
  recordQualificationWorkProgress,
  recordStoredQualificationVerdict,
  type QualificationWorkProgressInput,
  retargetPreSuiteAttemptToOwningRepairHead,
  recoverStoredQualificationHistoricalPreSuiteError,
  settleQualificationTransaction,
  waitQualificationTransaction,
  waitStoredQualification,
  commitPreparedCheckpointSelection,
  replacePreparedSelectionAfterRepairHeadAdvance,
  supersedePreparedSelectionBeforeStart,
  preparedSelectionNamesAttemptCandidate,
  type PreparedCheckpointSelectionRecord,
} from './checkpoint-qualification-transaction';
import { GREEN_CHECKPOINT_RESULT_MARKER } from './checkpoint-log-tags';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
  parseFrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';

describe('stored qualification child scope custody', () => {
  it.each(['live', 'unknown', 'dead'] as const)('probes %s payload under the row lock and ignores caller death claims', async state => {
    const fence = { attemptId: 'attempt-1', runnerId: 'runner', runId: 'run', pidIdentity: 'boot:42' };
    const begun = beginQualificationTransaction(null, { attemptId: fence.attemptId, nowMs: 100 }).transaction;
    const runner = reserveQualificationRunner(begun, { ...fence, pid: 42, started: true,
      leaseDurationMs: 1000, nowMs: 200 }).transaction;
    const current = recordQualificationChildScope(runner, { ...fence, operation: 'enroll',
      unit: 'pc-child123.scope', nowMs: 300 }).transaction;
    const { statements } = transactionHarness({ qualificationTransaction: current });
    configureRunnerLivenessProber(candidate => {
      expect(statements[0]!.text).toContain('FOR UPDATE');
      expect(candidate).toMatchObject({ unit: 'pc-child123.scope', pid: null, pidIdentity: null });
      return state;
    });
    try {
      const result = await recordStoredQualificationChildScope(target, { ...fence, operation: 'release',
        unit: 'pc-child123.scope', scopeLiveness: 'dead' });
      expect(result.status).toBe(state === 'dead' ? 'updated' : 'conflict');
      expect(statements.some(value => value.text.includes('UPDATE harness_shared.routines'))).toBe(state === 'dead');
    } finally { configureRunnerLivenessProber(null); }
  });
});

type QueryResult = Record<string, unknown>[];

const target = { workspaceId: 'workspace-1', installSlug: 'papercusp' };

describe('stored continuation uses the existing qualification row authority', () => {
  const fixture = () => {
    const current = reserveQualificationRunner(beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction, { attemptId: 'attempt-1', candidate: 'candidate-1', runnerId: 'runner-1',
      runId: 'run-1', pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 }).transaction;
    const input: QualificationWorkProgressInput = { attemptId: 'attempt-1', candidate: 'candidate-1',
      repairHead: null, runnerId: 'runner-1', runId: 'run-1', pidIdentity: 'boot:42', root: '/repo',
      taskKey: 'qualification', manifest: { schemaVersion: 1, units: [{ id: 'a', kind: 'test', path: 'a.test.ts' }] },
      retryStates: [], runContext: 'ci', runnerIdentity: 'proof-v3 node', updates: [], nowMs: 300 };
    return { current, input };
  };
  it('locks and updates the same qualification record before acknowledging progress', async () => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: current });
    expect(await recordStoredQualificationWorkProgress(target, input)).toMatchObject({ status: 'updated' });
    expect(statements[0]!.text).toContain('FOR UPDATE');
    const update = statements.find(value => value.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.values).toContainEqual(expect.stringContaining('"continuation"'));
    expect(update.values).toContain('qualificationTransaction');
  });
  it('performs no write for an old physical fence', async () => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: current });
    expect(await recordStoredQualificationWorkProgress(target, { ...input, runnerId: 'old-runner' }))
      .toMatchObject({ status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    expect(statements.some(value => value.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it.each(['expired', 'cancelled'] as const)('refuses a %s yield after acquiring the row lock', async mode => {
    const { current, input } = fixture();
    const saved = recordQualificationWorkProgress(current, input).transaction;
    const { statements } = transactionHarness({ qualificationTransaction: saved });
    const now = Date.now(), controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    const result = await recordStoredQualificationWorkYield(target, { ...input, nowMs: now }, {
      runnerId: input.runnerId, runId: input.runId, savedAtMs: now,
      executionCutoffEpochMs: now - 1, yieldDeadlineEpochMs: mode === 'expired' ? now - 1 : now + 10000,
      cleanupDeadlineEpochMs: now + 20000, orphanDeadlineEpochMs: now + 30000,
      callerDeadlineEpochMs: now + 20000, completed: [], pendingUnitIds: ['a'],
    }, controller.signal);
    expect(result).toMatchObject({ status: 'conflict', refusalReason: 'yield-deadline-exceeded' });
    expect(statements[0]!.text).toContain('FOR UPDATE');
    expect(statements.some(value => value.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });
  it.each([{ reason: 'advanced', green: true }, { reason: 'up-to-date', green: null }])(
    'refuses $reason without composing the frozen continuation, and emits no terminal event', async verdict => {
      const { current, input } = fixture();
      const continuation = { schemaVersion: 1 as const, attemptId: input.attemptId, candidate: input.candidate,
        repairHead: null, root: input.root, taskKey: input.taskKey, manifest: input.manifest,
        retryStates: [], receipts: [], supersededReceipts: [] };
      const { statements } = transactionHarness({ qualificationTransaction: { ...current, continuation } });
      expect(await recordStoredQualificationVerdict(target, { ...verdict, attemptId: input.attemptId,
        candidate: input.candidate, runId: input.runId, nowMs: 400,
        terminalEvent: { status: 'advanced', detail: {} } }))
        .toMatchObject({ status: 'conflict', refusalReason: 'continuation-composition-required' });
      expect(statements.some(value => value.text.includes('UPDATE harness_shared.routines'))).toBe(false);
      expect(h.appendPipelineEvent).not.toHaveBeenCalled();
    },
  );
});

function terminalQualification() {
  const begun = beginQualificationTransaction(null, {
    attemptId: 'attempt-1',
    requiredAncestorSha: 'old-repair',
    declaredPaths: ['old.ts'],
    candidate: 'candidate-1',
    nowMs: 100,
  }).transaction;
  return settleQualificationTransaction(begun, {
    attemptId: 'attempt-1',
    reason: 'not-green',
    green: false,
    nowMs: 200,
  }).transaction;
}

function terminalSuccessorQualification() {
  const inherited = beginQualificationTransaction(terminalQualification(), {
    attemptId: 'attempt-2',
    requiredAncestorSha: 'repair-1',
    declaredPaths: ['fixed.ts'],
    candidate: 'candidate-1',
    nowMs: 250,
  }).transaction;
  return settleQualificationTransaction(inherited, {
    attemptId: 'attempt-2',
    reason: 'dependency-prewarm-missing',
    nowMs: 275,
  }).transaction;
}

function safeQueue() {
  return createFrozenCandidateQueue({
    candidate: 'candidate-1',
    qualificationAttemptId: 'attempt-1',
    base: null,
    nowMs: 110,
  });
}

function transactionHarness(metadata: Record<string, unknown>, options: { casMatches?: boolean } = {}) {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult> => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (text.includes('SELECT metadata')) return [{ metadata }];
    if (text.includes('UPDATE harness_shared.routines')) {
      return options.casMatches === false ? [] : [{ metadata: {} }];
    }
    throw new Error(`unexpected query: ${text}`);
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult>;
    unsafe(text: string): string;
  };
  tx.unsafe = (text: string) => text;
  h.boundedOrgTxn.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { statements };
}

const successor = {
  attemptId: 'attempt-2',
  requiredAncestorSha: 'new-repair',
  declaredPaths: ['new.ts'],
  candidate: 'candidate-2',
  nowMs: 300,
};

beforeEach(() => {
  h.boundedOrgTxn.mockReset();
  h.appendPipelineEvent.mockReset();
  h.appendPipelineEvent.mockResolvedValue(undefined);
});

describe('stored historical pre-suite recovery', () => {
  let archiveDir: string;
  beforeEach(() => { archiveDir = mkdtempSync(join(tmpdir(), 'qualification-recovery-')); });
  afterEach(() => { rmSync(archiveDir, { recursive: true, force: true }); });
  const fixture = (candidate = 'candidate-1') => {
    const current = settleQualificationTransaction(beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate, requiredAncestorSha: candidate, nowMs: 100,
    }).transaction, {
      attemptId: 'attempt-1', runId: 'run-1', candidate, reason: 'error', green: null, nowMs: 200,
    }).transaction;
    const log = [
      '[green-checkpoint] FAILED before checkpoint lock: dependency-generation.sh exited 77:',
      '[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT',
      `${GREEN_CHECKPOINT_RESULT_MARKER} ${JSON.stringify({
        candidate, runId: 'run-1', reason: 'error', green: null,
        advanced: false, crashed: true, recorded: true,
      })}`,
    ].join('\n');
    const logPath = join(archiveDir, 'run.log');
    writeFileSync(logPath, log);
    return { current, input: {
      attemptId: 'attempt-1', runId: 'run-1', candidate, logPath,
      logSha256: createHash('sha256').update(log).digest('hex'), nowMs: 300,
    } };
  };
  it('locks the exact row and archives the terminal snapshot in the same transaction', async () => {
    const { current, input } = fixture();
    const queue = safeQueue();
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
    const result = await recoverStoredQualificationHistoricalPreSuiteError(target, input);
    expect(result).toMatchObject({ status: 'updated', transaction: { previousAttemptId: current.attemptId } });
    expect(statements[0].text).toContain('FOR UPDATE');
    expect(h.appendPipelineEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'qualification-recovered-pre-suite', detail: expect.objectContaining({
        predecessor: current, logSha256: input.logSha256,
      }),
    }), expect.anything(), { required: true });
    const update = statements.find(statement => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("metadata->'repair_queue'");
    expect(update.values).toContain(JSON.stringify(queue));
  });
  it('preserves and restamps the exact untested repair queue', async () => {
    const { current, input } = fixture('repair-1');
    const red = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['x.test.ts'], nowMs: 150 });
    const queue = markFrozenRepairAdmitted(red, {
      atMs: 175, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
    const result = await recoverStoredQualificationHistoricalPreSuiteError(target, input);
    expect(result).toMatchObject({ status: 'updated', repairQueueReconciliation: { status: 'preserved' } });
    expect(statements.find(statement => statement.text.includes('UPDATE harness_shared.routines'))!.text).toContain('{repair_queue,qualificationAttemptId}');
  });
  it('refuses a changed archive or row identity without writing', async () => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: { ...current, runId: 'other-run' } });
    expect((await recoverStoredQualificationHistoricalPreSuiteError(target, input)).status).toBe('conflict');
    expect((await recoverStoredQualificationHistoricalPreSuiteError(target, { ...input, logSha256: 'a'.repeat(64) })).status).toBe('conflict');
    expect(statements.some(statement => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    expect(h.appendPipelineEvent).not.toHaveBeenCalled();
  });
  it.each([
    ['predecessor-attempt-mismatch', { attemptId: 'newer-attempt' }],
    ['predecessor-run-mismatch', { runId: 'newer-run' }],
    ['predecessor-candidate-mismatch', { candidate: 'newer-candidate' }],
  ] as const)('attributes an unrelated predecessor before its changed ancestor policy (%s)', async (refusalReason, identity) => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: {
      ...current, ...identity, requiredAncestorSha: 'newer-policy',
    } });
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input, {
      requiredAncestorSha: current.requiredAncestorSha, declaredPaths: [],
    })).toMatchObject({ status: 'conflict', refusalReason });
    expect(statements[0].text).toContain('FOR UPDATE');
    expect(statements.some(statement => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    expect(h.appendPipelineEvent).not.toHaveBeenCalled();
  });
  it.each([
    ['request-ancestor-mismatch', { requiredAncestorSha: 'other-ancestor', declaredPaths: [] }],
    ['request-paths-mismatch', { requiredAncestorSha: 'candidate-1', declaredPaths: ['extra.ts'] }],
  ] as const)('refuses a changed request policy under the row lock without archiving or writing (%s)', async (refusalReason, request) => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: current });
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input, request))
      .toMatchObject({ status: 'conflict', refusalReason });
    expect(statements[0].text).toContain('FOR UPDATE');
    expect(statements.some(statement => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    expect(h.appendPipelineEvent).not.toHaveBeenCalled();
  });
  it('fails closed on an active fixer queue or CAS miss', async () => {
    const { current, input } = fixture();
    const red = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['x.test.ts'], nowMs: 125 });
    const queue = markFrozenRepairFixerDispatched(red, { spawnId: 'live-fixer', nowMs: 150 });
    const blocked = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input))
      .toMatchObject({ status: 'conflict', refusalReason: 'repair-queue-reconciliation',
        repairQueueReconciliation: { status: 'blocked' } });
    expect(blocked.statements.some(statement => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    transactionHarness({ qualificationTransaction: current, repair_queue: safeQueue() }, { casMatches: false });
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input))
      .toMatchObject({ status: 'conflict', refusalReason: 'repair-queue-cas-miss',
        repairQueueReconciliation: { reason: 'cas-miss' } });
    expect(h.appendPipelineEvent).not.toHaveBeenCalled();
  });
  it('requires the archive event to persist before reporting success', async () => {
    const { current, input } = fixture();
    transactionHarness({ qualificationTransaction: current });
    h.appendPipelineEvent.mockRejectedValueOnce(new Error('archive event failed'));
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input)).toMatchObject({
      status: 'unreadable', error: 'archive event failed',
    });
  });
  it('attributes a changed path policy without writing or exposing the stored transaction to a new read', async () => {
    const { current, input } = fixture();
    const { statements } = transactionHarness({ qualificationTransaction: current });
    expect(await recoverStoredQualificationHistoricalPreSuiteError(target, input, {
      requiredAncestorSha: current.requiredAncestorSha, declaredPaths: ['different.ts'],
    })).toMatchObject({ status: 'conflict', refusalReason: 'request-paths-mismatch' });
    expect(statements.some(statement => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    expect(h.appendPipelineEvent).not.toHaveBeenCalled();
  });
});

describe('stored qualification acquisition retry policy', () => {
  it('keeps safe setup retries inside one bounded 135s acquisition window', async () => {
    transactionHarness({});

    await beginStoredQualification(target, successor);

    expect(h.boundedOrgTxn).toHaveBeenCalledTimes(1);
    expect(h.boundedOrgTxn.mock.calls[0]?.[1]).toEqual({
      acquireTimeoutMs: 135_000,
      acquireRetries: 0,
      connectionSetupRetries: 15,
      connectionSetupBackoffMs: 1_000,
    });
  });
});

describe('beginStoredQualification terminal repair-queue reconciliation', () => {
  it('atomically preserves the exact predecessor queue while installing the successor', async () => {
    const current = terminalQualification();
    const queue = safeQueue();
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
      gate_health: { inconclusive: { status: 'repair-in-progress' }, keep: true },
      unrelated: { preserved: true },
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
        candidate: 'candidate-2',
      },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'exact-safe-unstarted',
        predecessorAttemptId: 'attempt-1',
        successorAttemptId: 'attempt-2',
        candidate: 'candidate-1',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).not.toContain("#- '{gate_health,inconclusive}'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain('metadata->? =');
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('leaves mismatched or started queues untouched and refuses the successor', async () => {
    const current = terminalQualification();
    const red = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    for (const [queue, reason] of [
      [{ ...safeQueue(), qualificationAttemptId: 'different-attempt' }, 'queue-origin-mismatch'],
      // STARTED: a fixer was dispatched and owns the queue — it advances it by admission.
      [markFrozenRepairFixerDispatched(red, { spawnId: 's-fixer-1', nowMs: 160 }), 'queue-not-safe-unstarted'],
    ] as const) {
      const { statements } = transactionHarness({
        qualificationTransaction: current,
        repair_queue: queue,
      });
      const result = await beginStoredQualification(target, successor, {
        reconcileTerminalRepairQueueForSuccessor: true,
      });
      expect(result).toMatchObject({ status: 'conflict', repairQueueReconciliation: { status: 'blocked', reason } });
      expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    }
  });

  // WI-10007398: an UNASSIGNED awaiting-fixer queue is not started — no fixer owns it, and only
  // the successor run's dispatch-fixer decision can launch one. Refusing it deadlocked the gate
  // (13 consecutive hourly refusals measured 2026-10-07/08). It is handed off, never retired.
  it('hands an unassigned awaiting-fixer queue to the successor in the same exact-row CAS', async () => {
    const current = terminalQualification();
    const queue = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    expect(queue.phase).toBe('awaiting-fixer');
    expect(queue.fixerSpawnId).toBeNull();
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: { attemptId: 'attempt-2', previousAttemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'preserved', reason: 'awaiting-unassigned-fixer' },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
  });

  it('preserves the unmarked unmeasured retest from a terminal inconclusive row in the successor CAS', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      requiredAncestorSha: 'candidate-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = settleQualificationTransaction(begun, {
      attemptId: 'attempt-1',
      runId: 'run-1',
      candidate: 'candidate-1',
      reason: 'error',
      green: null,
      nowMs: 200,
    }).transaction;
    expect(current.outcome.kind).toBe('code-inconclusive');

    const unmarkedRetest = {
      ...safeQueue(),
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
      repairHead: 'candidate-1',
      unmeasuredRetestHead: 'candidate-1',
      attempts: 0,
      fixerSpawnId: null,
      dispatchReservation: null,
      convergenceRounds: [],
    });
    expect(unmarkedRetest.retestRequested).toBeUndefined();

    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: unmarkedRetest,
    });
    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: { attemptId: 'attempt-2', previousAttemptId: 'attempt-1' },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'matching-untested-repair-head',
        predecessorAttemptId: 'attempt-1',
        successorAttemptId: 'attempt-2',
        candidate: 'candidate-1',
      },
    });
    expect(statements[0]!.text).toContain('FOR UPDATE');
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
  });

  // WI-6554700010030197: every queue writer CASes on repair_queue.updatedAtMs and writes its
  // whole snapshot back. A re-stamp that left the version unchanged let a writer holding a
  // pre-begin snapshot pass its CAS and restore the predecessor id (measured 2026-10-27).
  it('advances the queue CAS version when it re-stamps the origin, so a stale snapshot cannot restore it', async () => {
    const current = terminalQualification();
    const queue = {
      ...markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 }),
      updatedAtMs: 5_000,
    };
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({ status: 'updated', repairQueueReconciliation: { status: 'preserved' } });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("'{repair_queue,updatedAtMs}'");
    // Strictly past the version every pre-begin reader holds (5000), even with an earlier clock.
    expect(update.values).toContain('5001');
    expect(update.values).toContain(JSON.stringify(queue));
  });

  // WI-6554700010030197 — same-attempt stale queue origin.
  /** attempt-2 began as attempt-1's successor and is parked waiting on a repair it cannot run. */
  function waitingSuccessor() {
    const begun = beginQualificationTransaction(terminalQualification(), {
      attemptId: 'attempt-2',
      candidate: 'candidate-1',
      nowMs: 250,
    }).transaction;
    return waitQualificationTransaction(begun, {
      attemptId: 'attempt-2',
      reason: 'repair-in-progress',
      nowMs: 260,
    }).transaction;
  }
  function awaitingFixerQueue(origin: string) {
    return {
      ...markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 }),
      qualificationAttemptId: origin,
    };
  }
  const resume = { attemptId: 'attempt-2', nowMs: 300 };

  it('re-stamps a queue whose origin is still the resumed attempt\'s immediate predecessor', async () => {
    const current = waitingSuccessor();
    expect(current).toMatchObject({ phase: 'waiting', previousAttemptId: 'attempt-1' });
    const queue = awaitingFixerQueue('attempt-1');
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });

    const result = await beginStoredQualification(target, resume, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    // The resume itself is unchanged; only the queue's owner is handed to the live attempt.
    expect(result).toMatchObject({
      status: 'idempotent',
      transaction: { attemptId: 'attempt-2', phase: 'waiting' },
      repairQueueReconciliation: { status: 'preserved', reason: 'awaiting-unassigned-fixer' },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.values).toContain(JSON.stringify('attempt-2'));
    expect(update.values).toContain(JSON.stringify(queue));
  });

  it('never touches a queue owned by an unrelated attempt', async () => {
    const { statements } = transactionHarness({
      qualificationTransaction: waitingSuccessor(),
      repair_queue: awaitingFixerQueue('different-attempt'),
    });

    const result = await beginStoredQualification(target, resume, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({ status: 'idempotent', transaction: { attemptId: 'attempt-2' } });
    expect(result).not.toHaveProperty('repairQueueReconciliation');
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('leaves the resume as it was when the queue is fenced by a live dispatch reservation', async () => {
    const { statements } = transactionHarness({
      qualificationTransaction: waitingSuccessor(),
      repair_queue: {
        ...awaitingFixerQueue('attempt-1'),
        dispatchReservation: { token: 'precheck-op', claimedAtMs: 290, expiresAtMs: 10_000 },
      },
    });

    const result = await beginStoredQualification(target, resume, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    // Not a refusal: a resume that reconciled nothing before this fix must not start conflicting.
    expect(result).toMatchObject({ status: 'idempotent', transaction: { attemptId: 'attempt-2' } });
    expect(result).not.toHaveProperty('repairQueueReconciliation');
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  // WI-6554700010030504: the scheduled routine (release-actions.ts) and the manual checkpoint-run
  // both call beginStoredQualification WITHOUT nowMs. The reconciliation fails closed on a missing
  // clock, so an EXPIRED dispatch reservation used to fence every successor as dispatch-reserved
  // (6 consecutive begin-stage conflicts measured 2026-10-27 13:23-19:09Z). These cases omit nowMs
  // on purpose and drive the clock through Date.now(), exactly as production does.
  describe('dispatch-reservation expiry with no caller-supplied clock', () => {
    const productionSuccessor = {
      attemptId: successor.attemptId,
      requiredAncestorSha: successor.requiredAncestorSha,
      declaredPaths: successor.declaredPaths,
      candidate: successor.candidate,
    };
    const reservedAwaitingFixer = (expiresAtMs: number) => ({
      ...markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 }),
      dispatchReservation: { token: 'abandoned-dispatch', claimedAtMs: 4_000, expiresAtMs },
    });
    async function beginAt(systemTimeMs: number, queue: ReturnType<typeof reservedAwaitingFixer>) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(systemTimeMs);
      try {
        const harness = transactionHarness({ qualificationTransaction: terminalQualification(), repair_queue: queue });
        const result = await beginStoredQualification(target, productionSuccessor, {
          reconcileTerminalRepairQueueForSuccessor: true,
        });
        return { result, ...harness };
      } finally {
        vi.useRealTimers();
      }
    }

    it('hands an expired reservation\'s queue to the successor instead of fencing it', async () => {
      expect(productionSuccessor).not.toHaveProperty('nowMs');
      const { result, statements } = await beginAt(5_000, reservedAwaitingFixer(4_999));

      expect(result).toMatchObject({
        status: 'updated',
        transaction: { attemptId: 'attempt-2', previousAttemptId: 'attempt-1', createdAtMs: 5_000 },
        repairQueueReconciliation: { status: 'preserved', reason: 'awaiting-unassigned-fixer' },
      });
      const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
      expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    });

    it('still fences an unexpired reservation as dispatch-reserved and writes nothing', async () => {
      const { result, statements } = await beginAt(5_000, reservedAwaitingFixer(5_001));

      expect(result).toMatchObject({
        status: 'conflict',
        repairQueueReconciliation: {
          status: 'blocked',
          reason: 'queue-not-safe-unstarted',
          fence: 'dispatch-reserved',
        },
      });
      expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    });
  });

  it('installs the successor without deleting a matching untested repair head', async () => {
    const current = terminalQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-2',
        previousAttemptId: 'attempt-1',
      },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'matching-untested-repair-head',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-2'));
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('re-stamps an inherited repair head when the predecessor runner is proved dead', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const current = reserveQualificationRunner(ready, {
      attemptId: 'attempt-1', runnerId: 'dead-runner', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 200,
    }).transaction;
    const red = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'], nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(red, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    const next = {
      ...successor, candidate: 'repair-1', requiredAncestorSha: 'repair-1',
      incumbentLiveness: 'dead' as const, nowMs: 100_000,
    };
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });

    const result = await beginStoredQualification(target, next, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });
    expect(result).toMatchObject({
      status: 'updated',
      transaction: { attemptId: 'attempt-2', previousAttemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'preserved', reason: 'matching-untested-repair-head' },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-2'));
    expect(update.values).toContain(JSON.stringify(queue));

    const unknown = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
    expect((await beginStoredQualification(target, { ...next, incumbentLiveness: 'unknown' }, {
      reconcileTerminalRepairQueueForSuccessor: true,
    })).status).toBe('conflict');
    expect(unknown.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('resumes an unowned repair wait on the exact newly admitted head without waiting three hours', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      requiredAncestorSha: 'old-repair',
      declaredPaths: ['old.ts'],
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = settleQualificationTransaction(begun, {
      attemptId: 'attempt-1',
      reason: 'repair-in-progress',
      nowMs: 200,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        candidate: 'moving-tip',
      },
      { reconcileTerminalRepairQueueForSuccessor: true },
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        phase: 'ready',
        outcome: { kind: 'pending' },
        candidatePolicy: { declaredPaths: ['new.ts'] },
        eligibilitySnapshot: null,
      },
    });
    expect(result).not.toHaveProperty('repairQueueReconciliation');
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).not.toContain(JSON.stringify(queue));
  });

  it('rebinds only a dead unstarted runner to its same-row pending repair head', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const reserved = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'gate-fire-old',
      candidate: 'candidate-1',
      unit: 'papercup-checkpoint-gate-fire-old.scope',
      leaseDurationMs: 10_000,
      started: false,
      evidenceRefs: ['gate-fire:gate-fire-old'],
      nowMs: 200,
    }).transaction;
    const current = {
      ...reserved,
      pendingRepairHead: 'repair-1',
    };
    const red = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(red, {
      atMs: 250,
      actor: 'fixer',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });

    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });
    const result = await beginStoredQualification(target, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      incumbentLiveness: 'dead',
      nowMs: 100_000,
    });

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        repairHead: 'repair-1',
        pendingRepairHead: null,
        phase: 'ready',
        outcome: { kind: 'pending' },
        runId: null,
        lastProgressAtMs: 100_000,
        currentPhysicalRunner: null,
        consumedPhysicalRuns: [expect.objectContaining({
          id: 'gate-fire-old',
          candidate: 'candidate-1',
          outcome: { kind: 'pre-suite-no-verdict', reason: 'runner-vanished' },
        })],
        eligibilitySnapshot: null,
      },
    });
    if (result.status !== 'updated') throw new Error('expected repair-head rebind to update the transaction');
    const read = statements.find((statement) => statement.text.includes('SELECT metadata'))!;
    expect(read.text).toContain('FOR UPDATE');
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.values).toContain('qualificationTransaction');
    expect(update.values).toContain(JSON.stringify(result.transaction));

    for (const incumbentLiveness of ['live', 'unknown'] as const) {
      const guarded = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
      const unchanged = await beginStoredQualification(target, {
        attemptId: 'attempt-1',
        candidate: 'candidate-1',
        incumbentLiveness,
        nowMs: 100_000,
      });
      expect(unchanged).toMatchObject({
        status: 'idempotent',
        transaction: { candidate: 'candidate-1', currentPhysicalRunner: { id: 'gate-fire-old' } },
      });
      expect(guarded.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines')))
        .toBe(false);
    }

    const attached = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'gate-fire-old',
      runId: 'run-1',
      candidate: 'candidate-1',
      pid: 123,
      pidIdentity: 'boot:123',
      leaseDurationMs: 10_000,
      started: true,
      evidenceRefs: ['gate-fire:gate-fire-old', 'checkpoint-run:run-1'],
      nowMs: 250,
    }).transaction;
    const attachedCurrent = { ...attached, pendingRepairHead: 'repair-1' };
    const attachedHarness = transactionHarness({
      qualificationTransaction: attachedCurrent,
      repair_queue: queue,
    });
    const attachedResult = await beginStoredQualification(target, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      incumbentLiveness: 'dead',
      nowMs: 100_000,
    });
    expect(attachedResult).toMatchObject({
      status: 'idempotent',
      transaction: { candidate: 'candidate-1', currentPhysicalRunner: { pid: 123 } },
    });
    expect(attachedHarness.statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines')))
      .toBe(false);
  });

  it.each(['required-ancestor-missing', 'required-ancestor-unverifiable'] as const)(
    'corrects %s only to its own untested repair head without replacing the attempt', async reason => {
      const begun = beginQualificationTransaction(null, {
        attemptId: 'attempt-1', requiredAncestorSha: 'temporary-precheck',
        declaredPaths: ['fixed.ts'], candidate: 'candidate-1', nowMs: 100,
      }).transaction;
      const current = waitQualificationTransaction(begun, {
        attemptId: 'attempt-1', reason, nowMs: 200,
      }).transaction;
      const queue = markFrozenRepairAdmitted(markFrozenCandidateVerificationRed(safeQueue(), {
        failingTests: ['broken.test.ts'], nowMs: 150,
      }), {
        atMs: 175, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
        paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
      });
      const request = { ...successor, requiredAncestorSha: 'repair-1', declaredPaths: ['fixed.ts'],
        incumbentLiveness: 'live' as const };
      const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: queue });
      expect(await beginStoredQualification(target, request, { reconcileTerminalRepairQueueForSuccessor: true }))
        .toMatchObject({ status: 'updated', transaction: {
          attemptId: 'attempt-1', requiredAncestorSha: 'repair-1', candidate: 'repair-1',
          phase: 'ready', outcome: { kind: 'pending' }, currentPhysicalRunner: null,
        } });
      expect(statements.some(s => s.text.includes('UPDATE harness_shared.routines'))).toBe(true);

      for (const [saved, savedQueue, next] of [
        [current, { ...queue, qualificationAttemptId: 'other-attempt' }, request],
        [current, queue, { ...request, requiredAncestorSha: 'different-repair' }],
        [current, queue, { ...request, declaredPaths: ['other.ts'] }],
        [{ ...current, currentPhysicalRunner: reserveQualificationRunner(begun, {
          attemptId: 'attempt-1', runnerId: 'live-runner', leaseDurationMs: 10000, nowMs: 150,
        }).transaction.currentPhysicalRunner }, queue, request],
      ] as const) {
        const refused = transactionHarness({ qualificationTransaction: saved, repair_queue: savedQueue });
        expect(await beginStoredQualification(target, next, { reconcileTerminalRepairQueueForSuccessor: true }))
          .toMatchObject({ status: 'conflict', transaction: { attemptId: 'attempt-1' } });
        expect(refused.statements.some(s => s.text.includes('UPDATE harness_shared.routines'))).toBe(false);
      }
    },
  );

  it('does not resume a repair wait from a ready queue owned by another qualification', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = settleQualificationTransaction(begun, {
      attemptId: 'attempt-1',
      reason: 'repair-in-progress',
      nowMs: 200,
    }).transaction;
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = {
      ...markFrozenRepairAdmitted(redCandidate, {
        atMs: 175,
        actor: 'agent-1',
        source: { ref: 'staging', sha: 'repair-1' },
        fromRepairHead: 'candidate-1',
        toRepairHead: 'repair-1',
        paths: ['fixed.ts'],
        unchanged: [],
        blobs: { 'fixed.ts': 'blob-1' },
      }),
      qualificationAttemptId: 'different-attempt',
    };
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({ status: 'conflict', transaction: { attemptId: 'attempt-1' } });
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('preserves and re-stamps an untested queue owned by the terminal attempt immediate predecessor', async () => {
    const current = terminalSuccessorQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
    });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        attemptId: 'attempt-3',
      },
      {
        reconcileTerminalRepairQueueForSuccessor: true,
      },
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-3',
        previousAttemptId: 'attempt-2',
      },
      repairQueueReconciliation: {
        status: 'preserved',
        reason: 'matching-untested-repair-head',
        predecessorAttemptId: 'attempt-2',
        successorAttemptId: 'attempt-3',
      },
    });
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).not.toContain("- 'repair_queue'");
    expect(update.text).toContain("metadata->'repair_queue' =");
    expect(update.text).toContain("'{repair_queue,qualificationAttemptId}'");
    expect(update.values).toContain(JSON.stringify('attempt-3'));
    expect(update.values).toContain(JSON.stringify(queue));
    expect(update.values).toContain(JSON.stringify(current));
  });

  it('fails closed when the preserved queue changes before its ownership re-stamp', async () => {
    const current = terminalSuccessorQualification();
    const redCandidate = markFrozenCandidateVerificationRed(safeQueue(), {
      failingTests: ['broken.test.ts'],
      nowMs: 150,
    });
    const queue = markFrozenRepairAdmitted(redCandidate, {
      atMs: 175,
      actor: 'agent-1',
      source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1',
      toRepairHead: 'repair-1',
      paths: ['fixed.ts'],
      unchanged: [],
      blobs: { 'fixed.ts': 'blob-1' },
    });
    transactionHarness({ qualificationTransaction: current, repair_queue: queue }, { casMatches: false });

    const result = await beginStoredQualification(
      target,
      {
        ...successor,
        attemptId: 'attempt-3',
      },
      {
        reconcileTerminalRepairQueueForSuccessor: true,
      },
    );

    expect(result).toMatchObject({
      status: 'conflict',
      transaction: { attemptId: 'attempt-2' },
      repairQueueReconciliation: { status: 'blocked', reason: 'cas-miss' },
    });
  });

  it('fails closed on an exact-CAS miss without installing the successor', async () => {
    const current = terminalQualification();
    transactionHarness({ qualificationTransaction: current, repair_queue: safeQueue() }, { casMatches: false });

    const result = await beginStoredQualification(target, successor, {
      reconcileTerminalRepairQueueForSuccessor: true,
    });

    expect(result).toMatchObject({
      status: 'conflict',
      transaction: { attemptId: 'attempt-1' },
      repairQueueReconciliation: { status: 'blocked', reason: 'cas-miss' },
    });
  });

  it('CASes cancellation by attempt and unit, stops before commit, and preserves repair_queue', async () => {
    const begun = beginQualificationTransaction(null, {
      attemptId: 'attempt-1',
      candidate: 'candidate-1',
      nowMs: 100,
    }).transaction;
    const current = reserveQualificationRunner(begun, {
      attemptId: 'attempt-1',
      runnerId: 'physical-1',
      unit: 'papercup-green-checkpoint-manual-ge93sk.service',
      leaseDurationMs: 1_000,
      nowMs: 200,
    }).transaction;
    const queue = safeQueue();
    const { statements } = transactionHarness({
      qualificationTransaction: current,
      repair_queue: queue,
      unrelated: { preserved: true },
    });
    const stop = vi.fn(async () => ({ stopped: true }));

    const result = await cancelStoredQualification(
      target,
      {
        attemptId: 'attempt-1',
        unit: 'papercup-green-checkpoint-manual-ge93sk.service',
        nowMs: 300,
      },
      stop,
    );

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        phase: 'terminal',
        outcome: { kind: 'code-inconclusive', reason: 'cancelled' },
      },
    });
    expect(stop).toHaveBeenCalledTimes(1);
    const update = statements.find((statement) => statement.text.includes('UPDATE harness_shared.routines'))!;
    expect(update.text).toContain("metadata->?->>'attemptId' =");
    expect(update.text).toContain("metadata->?->'currentPhysicalRunner'->>'unit' =");
    expect(update.text).not.toContain("'repair_queue'");
    // The queue is deliberately preserved by omission: cancellation updates only the
    // qualification transaction, so it must not be passed as an UPDATE value at all.
    expect(update.values).not.toContain(JSON.stringify(queue));

    const refused = await cancelStoredQualification(
      target,
      {
        attemptId: 'attempt-1',
        unit: 'other-unit.service',
        nowMs: 301,
      },
      stop,
    );
    expect(refused).toMatchObject({ status: 'conflict' });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('reserveStoredQualificationRunner pre-suite retarget (WI-10005957)', () => {
  type Transaction = ReturnType<typeof beginQualificationTransaction>['transaction'];

  // The measured wedge: an earlier fire tore before its candidate resolved and settled the
  // attempt onto the integration tip; the next fire reserved its own placeholder on that tip.
  function wedgedAttempt(overrides: Partial<Transaction> = {}): Transaction {
    const begun = beginQualificationTransaction(null, { attemptId: 'attempt-1', nowMs: 100 }).transaction;
    return {
      ...begun,
      phase: 'running',
      candidate: 'tip-sha',
      repairHead: null,
      runId: null,
      outcome: { kind: 'pending' },
      consumedPhysicalRuns: [{
        id: 'fire-1', unit: 'fire-1.scope', phase: 'launching', pid: null, pidIdentity: null, candidate: null,
        evidenceRefs: ['gate-fire:fire-1', 'checkpoint-run:run-1'],
        reservedAtMs: 110, heartbeatAtMs: 110, leaseExpiresAtMs: 10_000,
        outcome: { kind: 'pre-suite-no-verdict', reason: 'infra-inconclusive' }, endedAtMs: 150,
      }],
      currentPhysicalRunner: {
        id: 'fire-2', unit: 'fire-2.scope', phase: 'launching', pid: null, pidIdentity: null, candidate: 'tip-sha',
        evidenceRefs: ['gate-fire:fire-2'], reservedAtMs: 200, heartbeatAtMs: 200, leaseExpiresAtMs: 100_000,
      },
      ...overrides,
    };
  }

  function owningQueue() {
    const red = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 });
    return markFrozenRepairAdmitted(red, {
      atMs: 175, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
  }

  const attach = {
    attemptId: 'attempt-1', runnerId: 'fire-2', runId: 'run-2', candidate: 'repair-1', pid: 4242,
    leaseDurationMs: 1_000, started: true, evidenceRefs: ['checkpoint-run:run-2'],
    incumbentLiveness: 'unknown' as const, nowMs: 300,
  };

  it('attaches the CLI to the owning queue\'s never-judged repair head instead of refusing conflict', async () => {
    // A completed fixer's id remains on a ready-to-verify queue as historical provenance.
    // It must not be mistaken for a still-active fixer when the joined run retargets.
    const queue = { ...owningQueue(), fixerSpawnId: 'finished-spawn-1' };
    expect(queue).toMatchObject({
      phase: 'ready-to-verify', qualificationAttemptId: 'attempt-1', repairHead: 'repair-1',
      fixerSpawnId: 'finished-spawn-1',
    });
    const { statements } = transactionHarness({ qualificationTransaction: wedgedAttempt(), repair_queue: queue });

    const result = await reserveStoredQualificationRunner(target, attach);

    expect(result).toMatchObject({
      status: 'updated',
      transaction: {
        attemptId: 'attempt-1',
        candidate: 'repair-1',
        repairHead: 'repair-1',
        runId: 'run-2',
        currentPhysicalRunner: { id: 'fire-2', candidate: 'repair-1', pid: 4242, phase: 'materializing' },
      },
    });
    const stored = (result as { transaction: Transaction }).transaction;
    expect(stored.evidenceRefs).toEqual(expect.arrayContaining(['candidate:repair-1', 'retargeted-from:tip-sha']));
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(true);
  });

  it('attributes the row-level pending-head refusal before runner retargeting without writing', async () => {
    const current = wedgedAttempt({ pendingRepairHead: 'other-repair' });
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: owningQueue() });

    expect(await reserveStoredQualificationRunner(target, attach)).toMatchObject({
      status: 'conflict', refusalReason: 'pending-head-queue-mismatch', transaction: current,
    });
    expect(statements[0].text).toContain('FOR UPDATE');
    expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
  });

  it('keeps failing closed whenever the same row does not prove the queue owns an unjudged head', async () => {
    const queue = owningQueue();
    const unadmitted = markFrozenCandidateVerificationRed(safeQueue(), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const cases: Array<{ name: string; transaction: Transaction; queue: unknown; candidate: string; guard: string }> = [
      { name: 'queue owned by another attempt', transaction: wedgedAttempt(),
        queue: { ...queue, qualificationAttemptId: 'attempt-other' }, candidate: 'repair-1', guard: 'queue-attempt-mismatch' },
      { name: 'CLI asks for a sha that is not the queue head', transaction: wedgedAttempt(), queue, candidate: 'other-sha',
        guard: 'queue-head-mismatch' },
      { name: 'queue head equals the frozen candidate (nothing to verify)', transaction: wedgedAttempt(),
        queue: { ...unadmitted, phase: 'ready-to-verify', unmeasuredRetestHead: 'candidate-1' },
        candidate: 'candidate-1', guard: 'queue-head-already-judged' },
      { name: 'queue is awaiting a fixer', transaction: wedgedAttempt(), queue: unadmitted, candidate: 'candidate-1',
        guard: 'queue-not-ready-to-verify' },
      { name: 'a fixer dispatch is reserved', transaction: wedgedAttempt(), candidate: 'repair-1',
        queue: { ...queue, dispatchReservation: { token: 'dispatch-1', claimedAtMs: 200, expiresAtMs: 500 } },
        guard: 'queue-dispatch-reserved' },
      { name: 'a suite already judged under this attempt', candidate: 'repair-1', queue, guard: 'attempt-already-judged',
        transaction: wedgedAttempt({
          consumedPhysicalRuns: [{
            ...wedgedAttempt().consumedPhysicalRuns![0]!, outcome: { kind: 'red', reason: 'not-green' },
          }],
        }) },
      { name: 'the placeholder already attached a process', candidate: 'repair-1', queue, guard: 'runner-already-attached',
        transaction: wedgedAttempt({
          currentPhysicalRunner: { ...wedgedAttempt().currentPhysicalRunner!, phase: 'materializing', pid: 99 },
        }) },
      { name: 'no queue at all', transaction: wedgedAttempt(), queue: null, candidate: 'repair-1', guard: 'queue-missing-or-unreadable' },
      { name: 'malformed queue', transaction: wedgedAttempt(), queue: { phase: 'ready-to-verify' }, candidate: 'repair-1',
        guard: 'queue-missing-or-unreadable' },
    ];
    for (const testCase of cases) {
      const { statements } = transactionHarness({ qualificationTransaction: testCase.transaction, repair_queue: testCase.queue });
      const result = await reserveStoredQualificationRunner(target, { ...attach, candidate: testCase.candidate });
      expect({ name: testCase.name, status: result.status }).toEqual({ name: testCase.name, status: 'conflict' });
      expect(result).toMatchObject({
        refusalReason: `candidate-mismatch:pre-suite-retarget-${testCase.guard}`,
        transaction: testCase.transaction,
      });
      expect(statements.some((statement) => statement.text.includes('UPDATE harness_shared.routines'))).toBe(false);
    }
  });

  it('is the identity when the stored candidate already matches or the caller is a reservation, not an attach', () => {
    const current = wedgedAttempt();
    const queue = owningQueue();
    expect(retargetPreSuiteAttemptToOwningRepairHead(current, { ...attach, started: false }, queue)).toBe(current);
    const aligned = wedgedAttempt({ candidate: 'repair-1' });
    expect(retargetPreSuiteAttemptToOwningRepairHead(aligned, attach, queue)).toBe(aligned);
  });
});

describe('a stored settlement that moves the attempt candidate voids the old prepared selection (WI-6554700010010801)', () => {
  const selectionFor = (candidate: string): PreparedCheckpointSelectionRecord => ({
    schemaVersion: 1, attemptId: 'attempt-1', integrationRoot: '/integration', checkpointRoot: '/checkpoint',
    candidate, tip: 'tip-1', base: 'base-1', candidateSource: 'frozen-repair-queue', quietCutApplied: false,
    freezeCut: null, carry: null, queue: null,
    generation: { candidate, identity: 'generation-1', token: 'v3:token',
      inputFingerprint: '1'.repeat(64), reused: true, root: '/generations' },
  });
  // The measured papercusp state before the 23:25Z crash: a physical run committed the repair
  // head's selection, then ended pre-suite with the queue's frozen candidate as its result.
  const running = () => ({
    ...reserveQualificationRunner(beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'repair-head-1', nowMs: 100,
    }).transaction, { attemptId: 'attempt-1', candidate: 'repair-head-1', runnerId: 'runner-1',
      runId: 'run-1', pid: 42, pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 }).transaction,
    preparedSelection: selectionFor('repair-head-1'),
  });
  const writtenTransaction = (statements: Array<{ text: string; values: unknown[] }>) => {
    const update = statements.find(value => value.text.includes('UPDATE harness_shared.routines'))!;
    const json = update.values.find((value): value is string => typeof value === 'string' && value.includes('"attemptId"'))!;
    return JSON.parse(json) as Record<string, unknown> & { candidate: string; evidenceRefs: string[] };
  };

  it('drops the selection when the pre-suite result names a different candidate', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: running() });
    expect(await waitStoredQualification(target, { attemptId: 'attempt-1', reason: 'repair-in-progress',
      candidate: 'frozen-candidate-1', repairHead: 'repair-head-1', runId: 'run-1', nowMs: 300 }))
      .toMatchObject({ status: 'updated' });
    const written = writtenTransaction(statements);
    expect(written.candidate).toBe('frozen-candidate-1');
    // A later joined fire attaches on 'frozen-candidate-1'; recovering the old selection would hand
    // the writer 'repair-head-1' and the post-preflight refresh would refuse the attached runner.
    expect(written).not.toHaveProperty('preparedSelection');
    expect(written.evidenceRefs).toContain('prepared-selection-voided:repair-head-1');
  });

  it('keeps the selection when the candidate is unchanged, so a restarted writer still recovers it', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: running() });
    expect(await waitStoredQualification(target, { attemptId: 'attempt-1', reason: 'repair-in-progress',
      candidate: 'repair-head-1', repairHead: 'repair-head-1', runId: 'run-1', nowMs: 300 }))
      .toMatchObject({ status: 'updated' });
    expect(writtenTransaction(statements).preparedSelection).toEqual(selectionFor('repair-head-1'));
  });
});

describe('committing a prepared selection honours the attempt candidate (WI-6554700010029754)', () => {
  const selectionFor = (candidate: string): PreparedCheckpointSelectionRecord => ({
    schemaVersion: 1, attemptId: 'attempt-1', integrationRoot: '/integration', checkpointRoot: '/checkpoint',
    candidate, tip: 'tip-1', base: 'base-1', candidateSource: 'frozen-repair-queue', quietCutApplied: false,
    freezeCut: null, carry: null, queue: null,
    generation: { candidate, identity: 'generation-1', token: 'v3:token',
      inputFingerprint: '1'.repeat(64), reused: true, root: '/generations' },
  });
  // The CLI attaches its runner on the attempt's candidate before the preflight selects.
  const attachedOn = (candidate: string) => reserveQualificationRunner(beginQualificationTransaction(null, {
    attemptId: 'attempt-1', candidate, nowMs: 100,
  }).transaction, { attemptId: 'attempt-1', candidate, runnerId: 'runner-1', runId: 'run-1', pid: 42,
    pidIdentity: 'boot:42', leaseDurationMs: 1000, started: true, nowMs: 200 }).transaction;
  const expected = { queue: null, pendingCarry: null };
  const updates = <T extends { text: string }>(statements: T[]) =>
    statements.filter(value => value.text.includes('UPDATE harness_shared.routines'));
  const written = (statements: Array<{ text: string; values: unknown[] }>) => {
    const json = updates(statements)[0]!.values
      .find((value): value is string => typeof value === 'string' && value.includes('"attemptId"'))!;
    return (JSON.parse(json) as { qualificationTransaction: Record<string, unknown> & { evidenceRefs: string[] } })
      .qualificationTransaction;
  };

  it('refuses, without publishing, a selection the attached runner would refuse at its refresh', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: attachedOn('frozen-candidate-1') });
    await expect(commitPreparedCheckpointSelection(target, selectionFor('repair-head-1'), expected))
      .rejects.toThrow(/candidate-mismatch: selected repair-head-1 but attempt attempt-1 is pinned to frozen-candidate-1/);
    expect(updates(statements)).toHaveLength(0);
  });

  it('publishes a selection that names the attempt candidate', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: attachedOn('frozen-candidate-1') });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('frozen-candidate-1'), expected)).toBe(true);
    expect(written(statements).preparedSelection).toEqual(selectionFor('frozen-candidate-1'));
  });

  it('replaces a stored selection for another candidate instead of refusing every later commit', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: {
      ...attachedOn('frozen-candidate-1'), preparedSelection: selectionFor('repair-head-1'),
    } });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('frozen-candidate-1'), expected)).toBe(true);
    const transaction = written(statements);
    expect(transaction.preparedSelection).toEqual(selectionFor('frozen-candidate-1'));
    expect(transaction.evidenceRefs).toContain('prepared-selection-voided:repair-head-1');
  });

  it('still compares a stored selection that names the attempt candidate (write-once)', async () => {
    const stored = { ...selectionFor('frozen-candidate-1'), tip: 'tip-0' };
    const { statements } = transactionHarness({ qualificationTransaction: {
      ...attachedOn('frozen-candidate-1'), preparedSelection: stored,
    } });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('frozen-candidate-1'), expected)).toBe(false);
    expect(updates(statements)).toHaveLength(0);
  });

  it('lets an attempt with no attached runner commit, because the refresh re-pins it', async () => {
    const { statements } = transactionHarness({ qualificationTransaction: beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'frozen-candidate-1', nowMs: 100,
    }).transaction });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('repair-head-1'), expected)).toBe(true);
    expect(written(statements).preparedSelection).toEqual(selectionFor('repair-head-1'));
  });

  it('atomically replans a committed selection when only the ready repairHead advanced before the suite', async () => {
    const initial = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'frozen-candidate-1', qualificationAttemptId: 'attempt-1', base: 'base-1', nowMs: 50,
      affectedTestProofGroup: 'group-1' }), { failingTests: ['lib/a.test.ts'], nowMs: 60 });
    const dispatched = markFrozenRepairFixerDispatched(initial, { spawnId: 'fixer-1', nowMs: 70 });
    const oldQueue = markFrozenRepairFixerFinished(dispatched, {
      spawnId: 'fixer-1', repairHead: 'repair-head-1', nowMs: 80,
    });
    const newQueue = markFrozenRepairAdmitted(oldQueue, { atMs: 90, actor: 'su-test',
      source: { ref: 'head-2', sha: 'repair-head-2' }, fromRepairHead: oldQueue.repairHead,
      toRepairHead: 'repair-head-2', paths: ['lib/a.test.ts'], unchanged: [], blobs: { 'lib/a.test.ts': 'blob-2' } });
    const previous = { ...selectionFor('repair-head-1'), queue: oldQueue };
    const replacement = { ...selectionFor('repair-head-2'), queue: newQueue };
    const base = attachedOn('repair-head-1');
    const runner = { ...base.currentPhysicalRunner!, phase: 'materializing' as const,
      evidenceRefs: [...base.currentPhysicalRunner!.evidenceRefs, 'checkpoint-run:run-1'] };
    const current = { ...base, runId: 'run-1', currentPhysicalRunner: runner, preparedSelection: previous };
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: newQueue });

    expect(await replacePreparedSelectionAfterRepairHeadAdvance(
      target, previous, replacement, newQueue, 'run-1',
    )).toBe(true);
    const writtenTransaction = written(statements);
    expect(writtenTransaction).toMatchObject({ candidate: 'repair-head-2', repairHead: 'repair-head-2',
      preparedSelection: replacement,
      currentPhysicalRunner: { candidate: 'repair-head-2', phase: 'materializing' } });
    expect(writtenTransaction.evidenceRefs).toContain('prepared-selection-replanned:repair-head-1:repair-head-2');
  });

  it('retires a stale prepared selection as repair-in-progress when queue phase changed', async () => {
    const initial = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'frozen-candidate-1', qualificationAttemptId: 'attempt-1', base: 'base-1', nowMs: 50,
      affectedTestProofGroup: 'group-1' }), { failingTests: ['lib/a.test.ts'], nowMs: 60 });
    const dispatched = markFrozenRepairFixerDispatched(initial, { spawnId: 'fixer-1', nowMs: 70 });
    const oldQueue = markFrozenRepairFixerFinished(dispatched, {
      spawnId: 'fixer-1', repairHead: 'repair-head-1', nowMs: 80,
    });
    const nextQueue = markFrozenRepairAdmitted(oldQueue, { atMs: 90, actor: 'su-test',
      source: { ref: 'head-2', sha: 'repair-head-2' }, fromRepairHead: oldQueue.repairHead,
      toRepairHead: 'repair-head-2', paths: ['lib/a.test.ts'], unchanged: [], blobs: { 'lib/a.test.ts': 'blob-2' } });
    const waitingQueue = { ...nextQueue, phase: 'awaiting-fixer' as const };
    const previous = { ...selectionFor('repair-head-1'), queue: oldQueue };
    const base = attachedOn('repair-head-1');
    const runner = { ...base.currentPhysicalRunner!, phase: 'materializing' as const,
      evidenceRefs: [...base.currentPhysicalRunner!.evidenceRefs, 'checkpoint-run:run-1'] };
    const current = { ...base, runId: 'run-1', currentPhysicalRunner: runner, preparedSelection: previous };
    const { statements } = transactionHarness({ qualificationTransaction: current, repair_queue: waitingQueue });

    const result = await supersedePreparedSelectionBeforeStart(target, {
      previous, expectedQueue: waitingQueue, runId: 'run-1', nowMs: 100,
    });
    expect(result.status).toBe('updated');
    const serialized = updates(statements)[0]!.values
      .find((value): value is string => typeof value === 'string' && value.includes('"attemptId"'))!;
    const updated = JSON.parse(serialized) as Record<string, unknown>;
    expect(updated.phase).toBe('waiting');
    expect(updated.outcome).toEqual({ kind: 'pre-suite-no-verdict', reason: 'repair-in-progress' });
    expect(updated.currentPhysicalRunner).toBeNull();
    expect(updated.preparedSelection).toBeUndefined();
    expect(updated.evidenceRefs).toContain('prepared-selection-superseded-before-start:repair-head-1');
  });

  // WI-6554700010030147: a running admission pre-check rewrites the queue row every few seconds.
  // The commit CAS must judge the selection authority, or every preparation replans to exhaustion.
  it('commits across queue bookkeeping drift but refuses a queue that would select another candidate', async () => {
    const roundTrip = (q: unknown) => parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(q)))!;
    const red = roundTrip(markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'frozen-candidate-1', qualificationAttemptId: 'attempt-1', base: 'base-1', nowMs: 50,
      affectedTestProofGroup: 'group-1' }), { failingTests: ['lib/a.test.ts'], nowMs: 60 }));
    const captured = { queue: red, pendingCarry: null };
    const drifted = roundTrip({ ...markFrozenRepairFixerDispatched(red, { spawnId: 'durable-spawn:fixer-1', nowMs: 70 }),
      updatedAtMs: 999 });
    expect(drifted).not.toEqual(red);
    const live = transactionHarness({ qualificationTransaction: attachedOn('frozen-candidate-1'), repair_queue: drifted });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('frozen-candidate-1'), captured)).toBe(true);
    expect(updates(live.statements)).toHaveLength(1);

    const admitted = roundTrip(markFrozenRepairAdmitted(red, { atMs: 80, actor: 'su-test',
      source: { ref: 'head-2', sha: 'head-2' }, fromRepairHead: red.repairHead, toRepairHead: 'head-2',
      paths: ['lib/a.test.ts'], unchanged: [], blobs: { 'lib/a.test.ts': 'blob-2' } }));
    const moved = transactionHarness({ qualificationTransaction: attachedOn('frozen-candidate-1'), repair_queue: admitted });
    expect(await commitPreparedCheckpointSelection(target, selectionFor('frozen-candidate-1'), captured)).toBe(false);
    expect(updates(moved.statements)).toHaveLength(0);
  });

  it('treats an unpinned attempt as accepting any selection', () => {
    expect(preparedSelectionNamesAttemptCandidate({ candidate: null }, { candidate: 'x' })).toBe(true);
    expect(preparedSelectionNamesAttemptCandidate({ candidate: ' x ' }, { candidate: 'x' })).toBe(true);
    expect(preparedSelectionNamesAttemptCandidate({ candidate: 'y' }, { candidate: 'x' })).toBe(false);
  });
});
