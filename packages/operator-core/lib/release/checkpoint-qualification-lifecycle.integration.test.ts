/** Real Postgres regression for the shared qualification/repair row. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: null as Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: db.sql }),
}));
vi.mock('../pg-bounded-txn', () => ({
  boundedOrgTxn: async (run: (tx: Sql) => Promise<unknown>) => db.sql!.begin(async (tx) => run(tx as unknown as Sql)),
}));
// Queue projection is a separate filesystem optimization; keep this DB test's fixture isolated.
vi.mock('./frozen-repair-edit-marker', () => ({ projectFrozenRepairMarker: () => {} }));

import {
  beginQualificationTransaction,
  beginStoredQualification,
  checkpointPidIdentity,
  classifyScheduledQualificationJoin,
  configureRunnerLivenessProber,
  projectCheckpointQualificationState,
  probeRunnerLiveness,
  readStoredQualification,
  recordStoredQualificationRunnerProgress,
  recordStoredQualificationScheduledFire,
  recordStoredQualificationVerdict,
  reserveQualificationRunner,
  reserveStoredQualificationRunner,
  settleQualificationTransaction,
  type RunnerLiveness,
} from './checkpoint-qualification-transaction';
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  parseFrozenCandidateRepairQueue,
} from './frozen-candidate-repair-queue';
import {
  reconcileGateVerdictFreshnessWithRepairQueue,
  type FrozenRepairConvergenceReading,
} from './gate-verdict-freshness';
import { fireAwaitsForKey, registerAwait } from '../events/await/store';
import { writeFrozenCandidateRepairQueue } from '../harness/routines/release-actions';

let org: OrgTestDb;
let sql: Sql;
const target = { workspaceId: 'ws-checkpoint-lifecycle', installSlug: 'papercusp' };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
});
afterAll(async () => {
  db.sql = null;
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
});

async function seed(metadata: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata)
    VALUES ('rt-checkpoint-lifecycle', ${target.installSlug}, 'green-checkpoint', 'cron', '{}'::jsonb,
            'system:green-checkpoint', TRUE, ${target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb)
  `;
}

async function metadata(): Promise<Record<string, unknown>> {
  const rows = await sql<{ metadata: Record<string, unknown> }[]>`
    SELECT metadata FROM harness_shared.routines WHERE workspace_id = ${target.workspaceId}`;
  return rows[0]!.metadata;
}

describe('checkpoint qualification lifecycle (real row lock and JSONB)', () => {
  it.each(['skipped-locked', 'migrations-pending'])(
    'persists %s as a pre-suite no-verdict outcome',
    async (reason) => {
      await seed();
      expect((await beginStoredQualification(target, {
        attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
      })).status).toBe('updated');
      expect((await recordStoredQualificationVerdict(target, {
        attemptId: 'attempt-1', candidate: 'candidate-1',
        reason, green: null, nowMs: 200,
      })).status).toBe('updated');
      const stored = await readStoredQualification(target);
      expect(stored).toMatchObject({ status: 'present', transaction: {
        phase: 'waiting',
        outcome: { kind: 'pre-suite-no-verdict', reason },
      } });
      if (stored.status === 'present') {
        expect(projectCheckpointQualificationState(stored.transaction, 300).clocks).toMatchObject({
          lastStartedAtMs: null, lastTerminalVerdictAtMs: null,
        });
      }
    },
  );

  it('classifies a persisted converging repair as non-terminal while retaining red uncertainty', async () => {
    await seed({
      repair_queue: { phase: 'ready-to-verify' },
      gate_health: { inconclusive: { status: 'repair-in-progress' } },
    });
    const stored = await metadata();
    const queue = stored.repair_queue as FrozenRepairConvergenceReading;
    const gateHealth = stored.gate_health as { inconclusive: { status: string } };
    const freshness = { stale: true, reason: 'no new verdict', reasonCode: 'writer-starved' as const };
    const result = reconcileGateVerdictFreshnessWithRepairQueue(freshness, {
      status: gateHealth.inconclusive.status,
      phase: queue.phase,
    });
    expect(result).toMatchObject({ stale: true, reasonCode: 'repair-converging' });
    expect(result.reason).toMatch(/recorded 'repair-in-progress'/);
    expect(reconcileGateVerdictFreshnessWithRepairQueue(freshness, {
      status: null, phase: 'blocked',
    })).toEqual(freshness);
  });

  it('joins one physical runner, separates clocks, and refuses stale terminal identity', async () => {
    await seed();
    const begun = await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 1_000,
    });
    expect(begun.status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 2_000)).status).toBe('updated');
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', leaseDurationMs: 1_000_000,
      started: false, nowMs: 2_100,
    })).status).toBe('updated');
    const pidIdentity = checkpointPidIdentity(process.pid)!;
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1', candidate: 'candidate-1',
      pid: process.pid, pidIdentity, leaseDurationMs: 1_000_000, started: true, nowMs: 2_200,
    })).status).toBe('updated');
    expect((await recordStoredQualificationRunnerProgress(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pidIdentity, phase: 'suite', nowMs: 3_000,
    })).status).toBe('updated');
    expect((await recordStoredQualificationScheduledFire(target, 'attempt-1', 4_000)).status).toBe('updated');
    const running = await readStoredQualification(target);
    expect(running.status).toBe('present');
    if (running.status !== 'present') return;
    expect(running.transaction).toMatchObject({
      runId: 'run-1', lastScheduledAtMs: 4_000, lastStartedAtMs: 2_200,
      lastProgressAtMs: 3_000, currentPhysicalRunner: { phase: 'suite', pidIdentity },
    });
    expect(projectCheckpointQualificationState(running.transaction, 4_500, 'live')).toMatchObject({
      lease: { holder: 'fire-1', acquiredAtMs: 2_100, expiresAtMs: 1_002_200, expired: false },
      runnerHealth: { liveness: 'live', phase: 'suite', progressAgeMs: 1_500 },
      clocks: {
        lastScheduledAtMs: 4_000, lastStartedAtMs: 2_200,
        lastProgressAtMs: 3_000, lastTerminalVerdictAtMs: null,
      },
      agesMs: { scheduled: 500, started: 2_300, progress: 1_500, terminal: null },
    });
    expect(classifyScheduledQualificationJoin(running.transaction,
      await probeRunnerLiveness(running.transaction.currentPhysicalRunner))).toBe('join');

    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_000,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_100,
    })).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-other', candidate: 'candidate-1',
      reason: 'advanced', green: true, nowMs: 5_200,
    })).status).toBe('conflict');
    expect((await recordStoredQualificationVerdict(target, {
      attemptId: 'attempt-1', runId: 'run-1', candidate: 'candidate-1',
      reason: 'not-green', green: false, nowMs: 5_200,
    })).status).toBe('terminal');
    const terminal = await readStoredQualification(target);
    expect(terminal).toMatchObject({ status: 'present', transaction: {
      phase: 'terminal', lastScheduledAtMs: 4_000, lastProgressAtMs: 3_000,
      lastTerminalVerdictAtMs: 5_100, outcome: { kind: 'red' },
    } });
  });

  it('awaits async runner probes under the same qualification row lock', async () => {
    await seed();
    expect((await beginStoredQualification(target, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    })).status).toBe('updated');
    expect((await reserveStoredQualificationRunner(target, {
      attemptId: 'attempt-1', runnerId: 'fire-1', unit: 'probe.service',
      leaseDurationMs: 1_000_000, started: false, nowMs: 200,
    })).status).toBe('updated');

    let resolveFirst: ((value: RunnerLiveness) => void) | undefined;
    let resolveSecond: ((value: RunnerLiveness) => void) | undefined;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    let probeCount = 0;
    configureRunnerLivenessProber(() => {
      probeCount += 1;
      return new Promise<RunnerLiveness>((resolve) => {
        if (probeCount === 1) {
          resolveFirst = resolve;
          markFirstStarted();
        } else {
          resolveSecond = resolve;
          markSecondStarted();
        }
      });
    });

    let beginSettled = false;
    try {
      const begin = beginStoredQualification(target, {
        attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
      }).then((result) => { beginSettled = true; return result; });
      await firstStarted;
      const reserve = reserveStoredQualificationRunner(target, {
        attemptId: 'attempt-1', runnerId: 'fire-2',
        leaseDurationMs: 1_000_000, started: false, nowMs: 400,
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(beginSettled).toBe(false);
      expect(probeCount).toBe(1);
      resolveFirst?.('live');
      await expect(begin).resolves.toMatchObject({ status: 'conflict' });

      await secondStarted;
      expect(probeCount).toBe(2);
      resolveSecond?.('live');
      await expect(reserve).resolves.toMatchObject({ status: 'conflict' });
    } finally {
      resolveFirst?.('unknown');
      resolveSecond?.('unknown');
      configureRunnerLivenessProber(null);
    }
  });

  it('commits predecessor reconciliation and successor qualification in the same row update', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await seed({ qualificationTransaction: terminal, repair_queue: admitted });
    const next = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(next).toMatchObject({ status: 'updated', repairQueueReconciliation: { status: 'preserved' } });
    const stored = await metadata();
    expect(stored.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2', candidate: 'repair-1' });
    expect(stored.repair_queue).toMatchObject({
      candidate: 'candidate-1', repairHead: 'repair-1', qualificationAttemptId: 'attempt-2',
    });
  });

  it('hands an abandoned runner queue to its successor before gate self-heal writes', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const abandoned = reserveQualificationRunner(first, {
      attemptId: 'attempt-1', runnerId: 'dead-runner', candidate: 'candidate-1',
      leaseDurationMs: 1_000, nowMs: 200,
    }).transaction;
    const red = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    const admitted = markFrozenRepairAdmitted(red, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await seed({ qualificationTransaction: abandoned, repair_queue: admitted });

    const successor = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', requiredAncestorSha: 'repair-1',
      incumbentLiveness: 'dead', nowMs: 100_000,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(successor).toMatchObject({
      status: 'updated', repairQueueReconciliation: { status: 'preserved' },
    });
    const handedOff = await metadata();
    expect(handedOff.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2' });
    expect(handedOff.repair_queue).toMatchObject({
      repairHead: 'repair-1', qualificationAttemptId: 'attempt-2',
    });

    const queue = parseFrozenCandidateRepairQueue(handedOff.repair_queue)!;
    const healed = markFrozenRepairAdmitted(queue, {
      atMs: 100_100, actor: 'gate', source: { ref: 'writer', sha: 'repair-2' },
      fromRepairHead: 'repair-1', toRepairHead: 'repair-2',
      paths: ['artifact.json'], unchanged: [], blobs: { 'artifact.json': 'blob-2' },
    });
    await expect(writeFrozenCandidateRepairQueue(target, healed, {
      expectedUpdatedAtMs: queue.updatedAtMs,
    })).resolves.toBeUndefined();
    expect((await metadata()).repair_queue).toMatchObject({
      repairHead: 'repair-2', qualificationAttemptId: 'attempt-2',
    });
  });

  it('preserves an unknown live PID even after lease expiry, then reclaims only a proved changed identity', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    await seed({ qualificationTransaction: {
      ...ready, phase: 'running', currentPhysicalRunner: {
        id: 'old-runner', candidate: 'candidate-1', reservedAtMs: 100,
        leaseExpiresAtMs: 200, evidenceRefs: [], pid: process.pid, pidIdentity: null,
      },
    } });
    const unknown = await readStoredQualification(target);
    expect(unknown.status).toBe('present');
    if (unknown.status !== 'present') return;
    expect(projectCheckpointQualificationState(unknown.transaction, 1_000, 'unknown')).toMatchObject({
      lease: { holder: 'old-runner', expired: true },
      runnerHealth: { liveness: 'unknown' },
      safeNextAction: { code: 'inspect-runner-liveness' },
    });
    const replacement = { attemptId: 'attempt-1', runnerId: 'new-runner', leaseDurationMs: 1_000, nowMs: 1_000 };
    expect((await reserveStoredQualificationRunner(target, replacement)).status).toBe('conflict');
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{qualificationTransaction,currentPhysicalRunner,pidIdentity}',
                                  '"old-boot:1"'::jsonb, true)
       WHERE workspace_id = ${target.workspaceId}`;
    const reclaimed = await reserveStoredQualificationRunner(target, replacement);
    expect(reclaimed).toMatchObject({ status: 'updated', transaction: {
      currentPhysicalRunner: { id: 'new-runner' },
      consumedPhysicalRuns: [{ id: 'old-runner', outcome: {
        kind: 'pre-suite-no-verdict', reason: 'runner-vanished',
      } }],
    } });
  });

  it('leaves a foreign repair queue and predecessor qualification byte-identical on conflict', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const foreign = createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'foreign-attempt', base: null, nowMs: 150,
    });
    await seed({ qualificationTransaction: terminal, repair_queue: foreign });
    const before = await metadata();
    const result = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(result.status).toBe('conflict');
    expect(await metadata()).toEqual(before);
  });

  it('fires only the exact candidate await once on the durable event store', async () => {
    const key = 'green-checkpoint:red:papercusp-lifecycle-test';
    const a = await registerAwait({
      subscriberId: 'su-candidate-a', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-a' } },
    });
    const b = await registerAwait({
      subscriberId: 'su-candidate-b', eventKey: key,
      payloadFilter: { sha: { startsWith: 'candidate-b' } },
    });
    const first = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } });
    expect(first.map((row) => row.id)).toEqual([a.id]);
    expect(await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-a123', runId: 'run-a' } })).toEqual([]);
    const second = await fireAwaitsForKey({ eventKey: key, payload: { sha: 'candidate-b123', runId: 'run-b' } });
    expect(second.map((row) => row.id)).toEqual([b.id]);
  });

  it('moves an admitted repair head and its qualification handoff in one row CAS', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'attempt-1', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    await seed({ qualificationTransaction: terminal, repair_queue: redQueue });
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await writeFrozenCandidateRepairQueue(target, admitted, { expectedUpdatedAtMs: redQueue.updatedAtMs });
    const handoff = await metadata();
    expect(handoff.repair_queue).toMatchObject({ repairHead: 'repair-1', qualificationAttemptId: 'attempt-1' });
    expect(handoff.qualificationTransaction).toMatchObject({
      attemptId: 'attempt-1', outcome: { kind: 'red' }, pendingRepairHead: 'repair-1',
    });
    const successor = await beginStoredQualification(target, {
      attemptId: 'attempt-2', candidate: 'repair-1', nowMs: 300,
    }, { reconcileTerminalRepairQueueForSuccessor: true });
    expect(successor.status).toBe('updated');
    const after = await metadata();
    expect(after.qualificationTransaction).toMatchObject({ attemptId: 'attempt-2', pendingRepairHead: null });
    expect(after.repair_queue).toMatchObject({ repairHead: 'repair-1', qualificationAttemptId: 'attempt-2' });
  });

  it('rejects an admitted head whose qualification owner differs and writes neither half', async () => {
    const first = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    const terminal = settleQualificationTransaction(first, {
      attemptId: 'attempt-1', candidate: 'candidate-1', reason: 'not-green', green: false, nowMs: 200,
    }).transaction;
    const redQueue = markFrozenCandidateVerificationRed(createFrozenCandidateQueue({
      candidate: 'candidate-1', qualificationAttemptId: 'foreign-attempt', base: null, nowMs: 110,
    }), { failingTests: ['broken.test.ts'], nowMs: 150 });
    await seed({ qualificationTransaction: terminal, repair_queue: redQueue });
    const before = await metadata();
    const admitted = markFrozenRepairAdmitted(redQueue, {
      atMs: 250, actor: 'fixer', source: { ref: 'staging', sha: 'repair-1' },
      fromRepairHead: 'candidate-1', toRepairHead: 'repair-1',
      paths: ['fixed.ts'], unchanged: [], blobs: { 'fixed.ts': 'blob-1' },
    });
    await expect(writeFrozenCandidateRepairQueue(target, admitted, {
      expectedUpdatedAtMs: redQueue.updatedAtMs,
    })).rejects.toThrow();
    expect(await metadata()).toEqual(before);
  });

  it('commits one terminal pipeline result with qualification and rolls both back on event failure', async () => {
    const ready = beginQualificationTransaction(null, {
      attemptId: 'attempt-1', candidate: 'candidate-1', nowMs: 100,
    }).transaction;
    await seed({ qualificationTransaction: ready });
    const terminal = {
      attemptId: 'attempt-1', candidate: 'candidate-1', runId: 'run-1',
      reason: 'not-green', green: false, nowMs: 200,
      terminalEvent: { status: 'not-green', detail: { runId: 'run-1', candidate: 'candidate-1' } },
    };
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('updated');
    expect((await recordStoredQualificationVerdict(target, terminal)).status).toBe('terminal');
    const events = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.pipeline_events
       WHERE workspace_id = ${target.workspaceId} AND install_slug = ${target.installSlug}
         AND kind = 'green_checkpoint' AND detail->>'runId' = 'run-1'`;
    expect(events[0].n).toBe(1);
    expect((await metadata()).qualificationTransaction).toMatchObject({
      phase: 'terminal', lastTerminalVerdictAtMs: 200,
    });

    const second = beginQualificationTransaction(null, {
      attemptId: 'attempt-2', candidate: 'candidate-2', nowMs: 300,
    }).transaction;
    await sql`
      UPDATE harness_shared.routines
         SET metadata = jsonb_set(metadata, '{qualificationTransaction}', ${JSON.stringify(second)}::text::jsonb, true)
       WHERE workspace_id = ${target.workspaceId}`;
    await sql`ALTER TABLE harness_shared.pipeline_events ADD CONSTRAINT checkpoint_lifecycle_reject_test
      CHECK (status <> 'forced-fail')`;
    try {
      const failed = await recordStoredQualificationVerdict(target, {
        attemptId: 'attempt-2', candidate: 'candidate-2', runId: 'run-2',
        reason: 'not-green', green: false, nowMs: 400,
        terminalEvent: { status: 'forced-fail', detail: { runId: 'run-2' } },
      });
      expect(failed.status).toBe('unreadable');
      expect((await metadata()).qualificationTransaction).toMatchObject({
        attemptId: 'attempt-2', phase: 'ready', outcome: { kind: 'pending' },
      });
      const rolledBack = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM harness_shared.pipeline_events
         WHERE workspace_id = ${target.workspaceId} AND detail->>'runId' = 'run-2'`;
      expect(rolledBack[0].n).toBe(0);
    } finally {
      await sql`ALTER TABLE harness_shared.pipeline_events DROP CONSTRAINT checkpoint_lifecycle_reject_test`;
    }
  });
});
