import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TASK_DEADLINE_EPOCH_MS_ENV as PRODUCER_ENV, taskDeadlineEnv } from '../systemd-scope';
import {
  isTaskDeadlineRefusal,
  readTaskDeadlineEpochMs,
  runBudgetedTaskShards,
  SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS,
  TASK_DEADLINE_EPOCH_MS_ENV as CONSUMER_ENV,
} from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

/**
 * WI-1639265 — `test:affected` admission and the caller's wall clock.
 *
 * Two independent internal budgets used to run side by side with nothing between them:
 * the scheduler's 45-minute shared-admission QUEUE budget (a fixed constant) and the
 * launcher's `RuntimeMaxSec` (a systemd property the payload never sees). A run could
 * therefore be admitted with no time left to execute and be SIGKILLed part-way through
 * with no `AFFECTED_TESTS_RESULT` line — a LOST RUN to the gate, a hang to a triager.
 */

// `runBudgetedTasks` takes the REAL shared test-process admission mutex, and this file is
// itself run BY `test:affected` — which is holding that very mutex for the whole invocation.
// Without this redirect every case here would queue behind its own parent until the 4h
// acquisition timeout (EI-21882326796062266). Redirect the lock ROOT rather than disabling
// the mutex, so the serialization being tested still genuinely happens, just in private.
let mutexLockRoot: string;
let previousMutexLockRoot: string | undefined;
beforeAll(() => {
  previousMutexLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  mutexLockRoot = mkdtempSync(join(tmpdir(), 'pc-deadline-admission-locks-'));
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = mutexLockRoot;
});
afterAll(() => {
  if (previousMutexLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = previousMutexLockRoot;
  rmSync(mutexLockRoot, { recursive: true, force: true });
});

type Task = { id: string; estimateMs: number | null };

const CONFIG = {
  workerBudget: 4,
  memoryBudgetMb: 4096,
  workerMemoryMb: 1024,
  maxConcurrentTasks: 2,
  reserveWorkers: 1,
};

const shardsOf = (...groups: Task[][]) => ({
  blastRadius: { kind: 'scoped', reason: 'path-closure', triggerPaths: [] as string[] } as const,
  maxTasksPerShard: Math.max(1, ...groups.map((tasks) => tasks.length)),
  taskCount: groups.reduce((total, tasks) => total + tasks.length, 0),
  shards: groups.map((tasks, index) => ({ index, tasks, taskKeys: tasks.map((t) => t.id) })),
});

function harness(overrides: Record<string, unknown> = {}) {
  const ran: string[] = [];
  const notices: string[] = [];
  const options = {
    ...CONFIG,
    estimateMs: (task: Task) => task.estimateMs,
    runTask: async (task: Task) => {
      ran.push(task.id);
      return task.id;
    },
    onAdmissionNotice: (line: string) => notices.push(line),
    ...overrides,
  };
  return { ran, notices, options };
}

describe('deadline-aware admission (WI-1639265)', () => {
  it('pins the producer and consumer to ONE variable name', () => {
    // The producer stamps it on the unit; the consumer reads it out of its own env. They
    // are in different languages, in different trees, and never import each other — so a
    // rename on either side would silently restore the pre-fix behaviour, since an ABSENT
    // variable legitimately means "no deadline was set". This equality is the only thing
    // that makes that impossible.
    expect(CONSUMER_ENV).toBe(PRODUCER_ENV);
    expect(CONSUMER_ENV).toBe('PAPERCUSP_TASK_DEADLINE_EPOCH_MS');
    expect(readTaskDeadlineEpochMs(taskDeadlineEnv(30, 1_000_000))).toBe(1_030_000);
  });

  it('reads a deadline only from a well-formed value; everything else is UNKNOWN', () => {
    expect(readTaskDeadlineEpochMs({})).toBeNull();
    expect(readTaskDeadlineEpochMs({ [CONSUMER_ENV]: '' })).toBeNull();
    expect(readTaskDeadlineEpochMs({ [CONSUMER_ENV]: 'soon' })).toBeNull();
    expect(readTaskDeadlineEpochMs({ [CONSUMER_ENV]: '-1' })).toBeNull();
    expect(readTaskDeadlineEpochMs({ [CONSUMER_ENV]: '1.5' })).toBeNull();
    expect(readTaskDeadlineEpochMs({ [CONSUMER_ENV]: '1788169003197' })).toBe(1788169003197);
  });

  it('refuses BEFORE running anything when the known work already exceeds the wall clock', async () => {
    const { ran, options } = harness();
    const error = await runBudgetedTaskShards(
      shardsOf([
        { id: 'a', estimateMs: 60_000 },
        { id: 'b', estimateMs: 60_000 },
      ]),
      { ...options, deadlineEpochMs: Date.now() + 5_000 },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isTaskDeadlineRefusal(error)).toBe(true);
    expect(error!.message).toContain('TASK_DEADLINE_REFUSAL');
    expect(error!.message).toContain('knownEstimateMs=60000');
    expect(error!.message).toContain('knownTasks=2');
    expect(error!.message).toContain('unknownTasks=0');
    // The whole point: nothing ran, so nothing was measured and nothing was thrown away.
    expect(ran).toEqual([]);
  });

  it('admits concurrent tasks whose wall projection fits even when their summed work does not', async () => {
    const { ran, notices, options } = harness();
    const pool = await runBudgetedTaskShards(
      shardsOf([
        { id: 'a', estimateMs: 60_000 },
        { id: 'b', estimateMs: 60_000 },
      ]),
      { ...options, deadlineEpochMs: Date.now() + 90_000 },
    );

    expect(ran.sort()).toEqual(['a', 'b']);
    expect(pool.results).toHaveLength(2);
    expect(notices.some((line) => line.startsWith('AFFECTED_TESTS_DEADLINE_SHORTFALL'))).toBe(false);
  });

  it('still refuses sequential shards whose combined wall projection exceeds the deadline', async () => {
    const { ran, options } = harness();
    const error = await runBudgetedTaskShards(
      shardsOf([{ id: 'a', estimateMs: 60_000 }], [{ id: 'b', estimateMs: 60_000 }]),
      { ...options, deadlineEpochMs: Date.now() + 90_000 },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(isTaskDeadlineRefusal(error)).toBe(true);
    expect(error!.message).toContain('knownEstimateMs=120000');
    expect(ran).toEqual([]);
  });

  it('still refuses summed work when the configured lane policy is serial', async () => {
    const { ran, options } = harness({ maxConcurrentTasks: 1 });
    const error = await runBudgetedTaskShards(
      shardsOf([
        { id: 'a', estimateMs: 60_000 },
        { id: 'b', estimateMs: 60_000 },
      ]),
      { ...options, deadlineEpochMs: Date.now() + 90_000 },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(isTaskDeadlineRefusal(error)).toBe(true);
    expect(error!.message).toContain('knownEstimateMs=120000');
    expect(ran).toEqual([]);
  });

  it('counts an unknown estimate as ZERO rather than guessing a duration', async () => {
    const { ran, options } = harness();
    // Same tiny clock, but no duration history for either task. A refusal here would be a
    // prediction, not a measurement — so the run proceeds and only the shortfall is voiced.
    const pool = await runBudgetedTaskShards(
      shardsOf([
        { id: 'a', estimateMs: null },
        { id: 'b', estimateMs: null },
      ]),
      { ...options, deadlineEpochMs: Date.now() + 5_000 },
    );
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(pool.results).toHaveLength(2);
  });

  it('refuses once the clock is already spent, whatever the estimates say', async () => {
    const { ran, options } = harness();
    const error = await runBudgetedTaskShards(shardsOf([{ id: 'a', estimateMs: null }]), {
      ...options,
      deadlineEpochMs: Date.now() - 1,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(isTaskDeadlineRefusal(error)).toBe(true);
    expect(ran).toEqual([]);
  });

  it('runs normally when the known work fits, and says nothing', async () => {
    const { ran, notices, options } = harness();
    const pool = await runBudgetedTaskShards(
      shardsOf([{ id: 'a', estimateMs: 10 }], [{ id: 'b', estimateMs: 10 }]),
      { ...options, deadlineEpochMs: Date.now() + 6 * 60 * 60 * 1_000 },
    );
    expect(ran).toEqual(['a', 'b']);
    expect(pool.results.map((entry: { task: Task }) => entry.task.id)).toEqual(['a', 'b']);
    expect(notices).toEqual([]);
  });

  it('warns when the QUEUE budget alone could eat the whole wall clock', async () => {
    const { notices, options } = harness();
    // The inversion this exists to name: the dangerous caller is the CONSERVATIVE-looking
    // one. A generous timeout sits well above the queue budget and is never squeezed.
    await runBudgetedTaskShards(shardsOf([{ id: 'a', estimateMs: 10 }]), {
      ...options,
      deadlineEpochMs: Date.now() + SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS - 60_000,
    });
    const tight = notices.filter((line) => line.startsWith('AFFECTED_TESTS_DEADLINE_TIGHT'));
    expect(tight).toHaveLength(1);
    expect(tight[0]).toContain(`queueBudgetMs=${SHARED_TEST_PROCESS_ADMISSION_RUN_BUDGET_MS}`);
  });

  it('voices a per-shard shortfall WITHOUT discarding shards that already settled', async () => {
    // Pre-flight passes (10ms + 1,200ms of known work against a 2,000ms clock), then shard 0
    // spends 1,200ms of it. By the time shard 1 is considered, its own estimate no longer
    // fits. That case must NOT throw: shard 0 holds real settled results, and trading a
    // measured verdict for a predicted one is a worse outcome than the kill it anticipates.
    const { ran, notices, options } = harness({
      runTask: async (task: Task) => {
        ran.push(task.id);
        if (task.id === 'a') await new Promise<void>((done) => setTimeout(done, 1_200));
        return task.id;
      },
    });
    const pool = await runBudgetedTaskShards(
      shardsOf([{ id: 'a', estimateMs: 10 }], [{ id: 'b', estimateMs: 1_200 }]),
      { ...options, deadlineEpochMs: Date.now() + 2_000 },
    );

    expect(ran).toEqual(['a', 'b']);
    expect(pool.results.map((entry: { task: Task }) => entry.task.id)).toEqual(['a', 'b']);
    const shortfall = notices.filter((l) => l.startsWith('AFFECTED_TESTS_DEADLINE_SHORTFALL'));
    expect(shortfall).toHaveLength(1);
    expect(shortfall[0]).toContain('shard=1');
    expect(shortfall[0]).toContain('knownEstimateMs=1200');
  }, 15_000);

  it('is byte-identical to the pre-fix scheduler when no deadline was published', async () => {
    const { ran, notices, options } = harness();
    // `null` is the explicit "this caller has no deadline" answer, and is also what an
    // unconfined/unlaunched run resolves to. Every check above must be skipped.
    const pool = await runBudgetedTaskShards(
      shardsOf([
        { id: 'a', estimateMs: 10 * 60 * 60 * 1_000 },
        { id: 'b', estimateMs: 10 * 60 * 60 * 1_000 },
      ]),
      { ...options, deadlineEpochMs: null },
    );
    expect(ran.sort()).toEqual(['a', 'b']);
    expect(pool.results).toHaveLength(2);
    expect(notices).toEqual([]);
  });
});
