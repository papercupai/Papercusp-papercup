import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import type { BenchTask } from './types';
import { resolveCoordinationSpec } from './coordination-topology';
const io = vi.hoisted(() => ({ start: vi.fn(), load: vi.fn() }));
vi.mock('./frontier-swe-launch-adapter', () => ({ startFrontierSweLaunchAdapter: io.start }));
vi.mock('./task-sets', () => ({ loadFrontierSweTaskSet: io.load }));
import { runFrontierSweCurrentArm } from './frontier-swe-arm';

beforeEach(() => vi.clearAllMocks());
function fixture() {
  const abort = new AbortController();
  const backlog: BenchTask[] = ['t1', 't2'].map(instanceId => ({ benchmark: 'frontier-swe', instanceId,
    problemStatement: 'Solve the task', graderMeta: {} }));
  let clock = 0;
  const runAgent = vi.fn(async (_input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => ({
    submission: {}, status: 'completed' as const, modelCalls: 1, tokensIn: 10, tokensOut: 10, costUsd: 3, turns: 1,
    executionPath: 'modernization-launch-adapter' }));
  const stop = vi.fn(async () => ({ errors: [] as string[] }));
  const clone = vi.fn(async (task: BenchTask) => ({ containerId: 'task-container', image: 'fixture', instanceId: task.instanceId }));
  const grade = vi.fn(async () => ({ resolved: false, score: 0.5, graderStatus: 'failed' as const }));
  const teardown = vi.fn(async () => {});
  io.start.mockResolvedValue({ runAgent, stop, seam: { modality: 'in-container', clone, grade, teardown } });
  const deps: Parameters<typeof runFrontierSweCurrentArm>[0] = { backlog,
    spec: resolveCoordinationSpec({ id: 'papercusp', spine: {} }), budget: { maxCostUsd: 3, maxWallMs: 1000 },
    seed: 1, runId: 'runtime-arm-seed', now: () => clock++,
    rowMeta: { version: 'official-v2', modelId: 'frozen-model', harnessVersion: 'frozen-source', preregHash: 'a'.repeat(64), rolloutId: 'fixture' },
    launch: { runId: 'runtime-arm-seed', protocolRunId: 'frozen-protocol', signal: abort.signal,
      context: { workspaceId: 'benchmarks' } as PapercuspUnifiedToolContext,
      mcpOrigin: 'http://127.0.0.1:3170', hookRecordDir: '/private/hooks', startAssignment: vi.fn() } };
  return { deps, runAgent, stop, clone, grade, teardown, abort };
}

describe('current FrontierSWE per-assignment protocol execution', () => {
  it('runs the stock reference through the same task sandbox and official grading path', async () => {
    const f = fixture(); f.deps.spec.arm = 'baseline';
    f.runAgent.mockImplementation(async () => ({ submission: {}, status: 'completed', modelCalls: 1,
      tokensIn: 10, tokensOut: 10, costUsd: 3, turns: 1, executionPath: 'stock-native-reference' }));
    const result = await runFrontierSweCurrentArm(f.deps);
    expect(result.arm).toBe('baseline');
    expect(f.grade).toHaveBeenCalledTimes(2);
    expect(f.runAgent.mock.calls.map(([input]) => input.arm)).toEqual(['baseline', 'baseline']);
    expect(result.rows.every(row => row.armMeta?.executionPath === 'stock-native-reference')).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it('uses one adapter for the run and resets the frozen cap for each task', async () => {
    const f = fixture(); const result = await runFrontierSweCurrentArm(f.deps);
    expect(io.start).toHaveBeenCalledOnce(); expect(f.runAgent).toHaveBeenCalledTimes(2);
    expect(f.runAgent.mock.calls.map(([input]) => input.attemptBudget.maxCostUsd)).toEqual([3, 3]);
    expect(result.rows).toHaveLength(2); expect(result.costUsdSpent).toBe(6);
    expect(f.grade).toHaveBeenCalledTimes(2); expect(f.teardown).toHaveBeenCalledTimes(2);
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it('runs no later task after cancellation and still tears down the owned adapter', async () => {
    const f = fixture();
    f.deps.onResult = async () => { f.abort.abort(); };
    const result = await runFrontierSweCurrentArm(f.deps);
    expect(f.runAgent).toHaveBeenCalledOnce(); expect(result.skippedTaskIds).toEqual(['t2']);
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it.each(['costUsdMeasurementMissing', 'modelCallsMeasurementMissing', 'tokenUsageMeasurementMissing'])(
    'does not reset the unknown %s fence between independently capped tasks', async missing => {
      const f = fixture();
      f.runAgent.mockResolvedValueOnce({ submission: {}, status: 'completed', modelCalls: 1,
        tokensIn: 10, tokensOut: 10, costUsd: 0.1, turns: 1, armMeta: { [missing]: true } });
      const result = await runFrontierSweCurrentArm(f.deps);
      expect(f.runAgent).toHaveBeenCalledOnce();
      expect(result.accountingUnknown).toBe(true);
      expect(result.costUsdSpent).toBe(0.1);
      expect(result.attemptedTaskIds).toEqual(['t1']);
      expect(result.skippedTaskIds).toEqual(['t2']);
      expect(result.rows[0]).toMatchObject({ generationStatus: 'error', resolved: null,
        armMeta: { [missing]: true } });
      expect(f.grade).not.toHaveBeenCalled(); expect(f.teardown).toHaveBeenCalledOnce();
      expect(f.stop).toHaveBeenCalledOnce();
    });
  it('allocates no services when loading the controlled task roster fails', async () => {
    const f = fixture(); f.deps.backlog = undefined; io.load.mockImplementationOnce(() => { throw new Error('controls missing'); });
    await expect(runFrontierSweCurrentArm(f.deps)).rejects.toThrow('controls missing');
    expect(io.start).not.toHaveBeenCalled();
  });
  it('surfaces cleanup failure instead of calling an incomplete run finished', async () => {
    const f = fixture(); f.stop.mockResolvedValueOnce({ errors: ['task network remains'] });
    await expect(runFrontierSweCurrentArm(f.deps)).rejects.toThrow(/cleanup incomplete/);
  });
});
