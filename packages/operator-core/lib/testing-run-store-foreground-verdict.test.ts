/**
 * getForegroundRunVerdictAsync — a foreground testing:run released by a
 * host-shutdown handoff can die at its scope RuntimeMaxSec without writing a
 * ledger row. The verdict must say LOST, not leave readers on an ambiguous
 * "unknown" forever (WI-6554700010018414).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyForegroundKernelEvidence,
  getForegroundRunVerdictAsync,
  TestingRunSnapshotUnavailableError,
  type ForegroundKernelEvidence,
  type ForegroundKernelVerdict,
} from './testing-run-store';

const taskManagerMocks = vi.hoisted(() => ({
  reconcileTick: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock('./task-manager/reconcile-tick', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-manager/reconcile-tick')>()),
  reconcileTick: taskManagerMocks.reconcileTick,
}));

vi.mock('./task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./task-manager/store')>()),
  listTasks: taskManagerMocks.listTasks,
}));

type TaskRow = {
  task_id: string; workspace_id: string; state: string;
  started_at: number | null; ended_at: number | null; exit_code: number | null;
};

/** A tagged-template fake that answers the two reads the verdict makes. */
function fakeSql(opts: {
  tasks: TaskRow[] | 'throw'; ledgerRows: number | 'throw';
  kernelVerdict?: ForegroundKernelVerdict;
}) {
  const seen: string[] = [];
  const kernelReads: Array<{ taskId: string; workspaceId: string }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<unknown> => {
    const text = strings.join('?');
    seen.push(text);
    if (text.includes('harness_shared.task_ledger')) {
      expect(values).toContain('testing:run:run-1');
      return opts.tasks === 'throw' ? Promise.reject(new Error('pg down')) : Promise.resolve(opts.tasks);
    }
    if (text.includes('harness_shared.test_runs')) {
      return opts.ledgerRows === 'throw'
        ? Promise.reject(new Error('pg down'))
        : Promise.resolve([{ n: opts.ledgerRows }]);
    }
    throw new Error(`unexpected query: ${text}`);
  };
  const readKernelVerdict = async (taskId: string, workspaceId: string): Promise<ForegroundKernelVerdict> => {
    kernelReads.push({ taskId, workspaceId });
    return opts.kernelVerdict ?? { status: 'alive' };
  };
  return { sql, seen, kernelReads, readKernelVerdict };
}

const task = (state: string): TaskRow => ({
  task_id: 'task-1', workspace_id: 'workspace-1', state,
  started_at: 1000, ended_at: 2000, exit_code: null,
});

const kernelEvidence = (overrides: Partial<ForegroundKernelEvidence> = {}): ForegroundKernelEvidence => ({
  degraded: false,
  taskState: 'running',
  aliveCount: 0,
  strandedCount: 0,
  endedUnobservedCount: 0,
  unresolved: false,
  tooYoung: false,
  ...overrides,
});

type MockReconcileArgs = {
  workspaceId?: string;
  listLive?: (workspaceId?: string) => Promise<Array<{ taskId: string; state: string }>>;
};

type MockReconcileTick = {
  degraded: boolean;
  result: {
    alive: Array<{ taskId: string }>;
    stranded: Array<{ taskId: string }>;
    endedUnobserved: Array<{ taskId: string }>;
    unresolved: Array<{ taskId: string }>;
    tooYoung: string[];
  };
};

function reconcileTickResult(
  input: Partial<MockReconcileTick['result']> = {},
  degraded = false,
): MockReconcileTick {
  return {
    degraded,
    result: {
      alive: [], stranded: [], endedUnobserved: [], unresolved: [], tooYoung: [],
      ...input,
    },
  };
}

let nextReconcileTick: MockReconcileTick;

beforeEach(() => {
  nextReconcileTick = reconcileTickResult({ alive: [{ taskId: 'task-1' }] });
  taskManagerMocks.listTasks.mockReset().mockImplementation(async (filter: {
    workspaceId?: string; taskId?: string; includeEnded?: boolean; limit?: number;
  }) => filter.taskId === 'task-1' ? [{ taskId: 'task-1', state: 'running' }] : []);
  taskManagerMocks.reconcileTick.mockReset().mockImplementation(async (deps: MockReconcileArgs) => {
    await deps.listLive?.(deps.workspaceId);
    return nextReconcileTick;
  });
});

describe('getForegroundRunVerdictAsync', () => {
  it('classifies a single live kernel match as alive', () => {
    expect(classifyForegroundKernelEvidence(kernelEvidence({ aliveCount: 1 }))).toEqual({ status: 'alive' });
  });

  it.each([
    ['ended_unobserved', { endedUnobservedCount: 1 }],
  ] as const)('classifies a fresh %s kernel verdict as terminal', (_name, evidence) => {
    expect(classifyForegroundKernelEvidence(kernelEvidence(evidence)))
      .toEqual({ status: 'terminal', taskState: _name });
  });

  it.each([
    ['degraded scan', { degraded: true, aliveCount: 1 }],
    ['unresolved task', { unresolved: true }],
    ['young task', { tooYoung: true }],
    ['stranded task with unconfirmed scope release', { strandedCount: 1 }],
    ['ambiguous matches', { aliveCount: 1, strandedCount: 1 }],
    ['missing classification', {}],
  ] as const)('preserves unknown for %s evidence', (_name, evidence) => {
    expect(classifyForegroundKernelEvidence(kernelEvidence(evidence))).toEqual({ status: 'unknown' });
  });

  it('reports LOST when the foreground task ended without any ledger row', async () => {
    const fake = fakeSql({ tasks: [task('ended_unobserved')], ledgerRows: 0 });
    const out = await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict);
    expect(out).toMatchObject({ runId: 'run-1', taskId: 'task-1', taskState: 'ended_unobserved', ledgerRows: 0, verdict: 'lost' });
    expect(fake.kernelReads).toEqual([]);
  });

  it.each(['killed', 'timed_out', 'exited'])('reports LOST for terminal state %s with zero rows', async (state) => {
    const fake = fakeSql({ tasks: [task(state)], ledgerRows: 0 });
    expect((await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict))?.verdict).toBe('lost');
    expect(fake.kernelReads).toEqual([]);
  });

  it('reports RUNNING while the task is live and no row exists yet', async () => {
    const fake = fakeSql({ tasks: [task('running')], ledgerRows: 0 });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict))
      .toMatchObject({ taskState: 'running', verdict: 'running' });
    expect(fake.kernelReads).toEqual([{ taskId: 'task-1', workspaceId: 'workspace-1' }]);
  });

  it('overlays a fresh terminal kernel verdict on a stale running ledger row', async () => {
    const fake = fakeSql({ tasks: [task('running')], ledgerRows: 0, kernelVerdict: { status: 'terminal', taskState: 'ended_unobserved' } });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict))
      .toMatchObject({ taskState: 'ended_unobserved', verdict: 'lost' });
  });

  it('runs the shared dry-run reconciler against only the exact foreground task', async () => {
    nextReconcileTick = reconcileTickResult({ endedUnobserved: [{ taskId: 'task-1' }] });
    const fake = fakeSql({ tasks: [task('running')], ledgerRows: 0 });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql))
      .toMatchObject({ taskState: 'ended_unobserved', verdict: 'lost' });
    expect(taskManagerMocks.reconcileTick).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      workspaceId: 'workspace-1',
    }));
    expect(taskManagerMocks.listTasks).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', taskId: 'task-1', includeEnded: true, limit: 2,
    });
  });

  it('preserves unknown when the fresh kernel read is degraded or ambiguous', async () => {
    const fake = fakeSql({ tasks: [task('running')], ledgerRows: 0, kernelVerdict: { status: 'unknown' } });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict)).toBeNull();
  });

  it('reports RECORDED whenever ledger rows exist, whatever the task state', async () => {
    const fake = fakeSql({ tasks: [task('running')], ledgerRows: 3, kernelVerdict: { status: 'unknown' } });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict))
      .toMatchObject({ verdict: 'recorded', ledgerRows: 3 });
    expect(fake.kernelReads).toEqual([]);
  });

  it('returns null when no foreground task exists for the run id', async () => {
    const fake = fakeSql({ tasks: [], ledgerRows: 0 });
    expect(await getForegroundRunVerdictAsync('run-1', fake.sql, fake.readKernelVerdict)).toBeNull();
    expect(fake.seen.some((q) => q.includes('test_runs'))).toBe(false);
    expect(fake.kernelReads).toEqual([]);
  });

  it('refuses to call an ambiguous or unreadable lookup lost', async () => {
    const ambiguous = fakeSql({ tasks: [task('exited'), task('exited')], ledgerRows: 0 });
    const unreadableTasks = fakeSql({ tasks: 'throw', ledgerRows: 0 });
    const unreadableLedger = fakeSql({ tasks: [task('exited')], ledgerRows: 'throw' });
    await expect(getForegroundRunVerdictAsync('run-1', ambiguous.sql, ambiguous.readKernelVerdict))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
    await expect(getForegroundRunVerdictAsync('run-1', unreadableTasks.sql, unreadableTasks.readKernelVerdict))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
    await expect(getForegroundRunVerdictAsync('run-1', unreadableLedger.sql, unreadableLedger.readKernelVerdict))
      .rejects.toBeInstanceOf(TestingRunSnapshotUnavailableError);
  });
});
