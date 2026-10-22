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
  retargetPreSuiteAttemptToOwningRepairHead,
  recoverStoredQualificationHistoricalPreSuiteError,
  settleQualificationTransaction,
  waitQualificationTransaction,
} from './checkpoint-qualification-transaction';
import { GREEN_CHECKPOINT_RESULT_MARKER } from './checkpoint-log-tags';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  markFrozenRepairFixerDispatched,
} from './frozen-candidate-repair-queue';

type QueryResult = Record<string, unknown>[];

const target = { workspaceId: 'workspace-1', installSlug: 'papercusp' };

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
    const queue = owningQueue();
    expect(queue).toMatchObject({ phase: 'ready-to-verify', qualificationAttemptId: 'attempt-1', repairHead: 'repair-1' });
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
      { name: 'a fixer is dispatched', transaction: wedgedAttempt(), queue: { ...queue, fixerSpawnId: 'spawn-1' }, candidate: 'repair-1',
        guard: 'queue-fixer-active' },
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
