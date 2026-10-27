import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointQualificationBudgetFromEnv, CheckpointQualificationBoundaryError,
  createCheckpointQualificationExecution, createCheckpointQualificationYieldBoundary, realCheckpointDeps, runCmd } from './green-checkpoint';
import { releaseConfig } from './release-config';
import type { CheckpointExec, CheckpointExecResult } from './green-checkpoint';
import type { QualificationWorkProgressInput } from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';
import { TASK_DEADLINE_EPOCH_MS_ENV } from '@papercusp/operator-core/lib/systemd-scope';
import { GREEN_CHECKPOINT_SUITE_TIMEOUT_MS } from '@papercusp/operator-core/lib/release/green-checkpoint-schedule';
import { resolveQualificationYieldBudget } from '../../../../scripts/lib/batch-watchdog.mjs';

const confined = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/operator-core/lib/release/checkpoint-qualification-command', () => ({ runQualificationCommand: confined }));

const progress: QualificationWorkProgressInput = {
  attemptId: 'attempt', candidate: 'candidate', repairHead: null, runnerId: 'runner',
  runId: 'run', pidIdentity: 'boot:42', root: '/repo', taskKey: 'qualification',
  manifest: { schemaVersion: 1, units: [{ id: 'test:a.test.ts', kind: 'test', path: 'a.test.ts' }] },
  retryStates: [], runContext: 'green-checkpoint', runnerIdentity: 'native', updates: [],
};
const result = { code: 0, signal: null, stdout: '', stderr: '' };
const target = { workspaceId: 'w', installSlug: 'h' };
const budget = () => {
  const resolved = resolveQualificationYieldBudget({ startedAtMs: 1000, quantumMs: 500,
    orphanDeadlineEpochMs: 5000, deadlineEpochMs: 4000, cleanupReserveMs: 500, yieldReserveMs: 200 });
  if (resolved.status !== 'ready') throw new Error(resolved.reason);
  return resolved;
};
function setup(execute: CheckpointExec = vi.fn().mockResolvedValue(result)) {
  let callbacks!: Parameters<typeof createCheckpointQualificationExecution>[0] & {
    onYield: () => void; onKill: (decision: { reason: string }) => void;
  };
  const stop = vi.fn();
  const boundary = vi.fn(input => { callbacks = input; return { stop }; });
  const onStop = vi.fn();
  const execution = createCheckpointQualificationExecution({ target, progress, observer: { snapshot: vi.fn() },
    budget: budget(), baselineReceipts: [], execute, onStop }, { boundary } as never);
  return { execution, execute, onStop, stop, callbacks: () => callbacks };
}
afterEach(() => { confined.mockReset(); vi.restoreAllMocks(); });

describe('qualification production execution', () => {
  it.each(['yield', 'kill'] as const)('fences the losing production runGreen branch after a delayed disk sample: %s', async disposition => {
    const root = mkdtempSync(join(tmpdir(), 'qualification-late-sampler-'));
    const saved = ['PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID', 'PAPERCUSP_GATE_VERDICT_WORKSPACE',
      'PAPERCUSP_GATE_VERDICT_HARNESS', TASK_DEADLINE_EPOCH_MS_ENV].map(key => [key, process.env[key]] as const);
    let releaseSample!: (value: []) => void;
    const sample = vi.fn(() => new Promise<[]>(resolve => { releaseSample = resolve; }));
    let boundary!: Parameters<typeof createCheckpointQualificationYieldBoundary>[0];
    const observer = { snapshot: vi.fn(), finish: vi.fn(), onOutput: vi.fn() };
    const execute = vi.fn<CheckpointExec>().mockResolvedValue(result);
    const prepare = vi.fn().mockResolvedValue({ status: 'ready', observer,
      commandDefinitions: [], recheckRunnerIdentity: vi.fn(), postSuite: { target, progress: { ...progress, root } },
      checkpoint: { root, taskKey: progress.taskKey, sourceCommit: progress.candidate, sourceDigest: 'source',
        selectedFiles: ['a.test.ts'], passedFiles: [], state: 'partial',
        physicalExecution: { fingerprint: 'physical', evidenceRoot: root, tasks: [] },
        continuation: { ...progress, receipts: [] } } });
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:affected': 'node suite.mjs' } }));
      process.env.PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID = progress.attemptId;
      process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = target.workspaceId;
      process.env.PAPERCUSP_GATE_VERDICT_HARNESS = target.installSlug;
      process.env[TASK_DEADLINE_EPOCH_MS_ENV] = String(Date.now() + 600_000);
      const deps = realCheckpointDeps(releaseConfig({ checkpointRoot: root, integrationRoot: root,
        checkpointLogDir: join(root, 'logs') }), execute, 'run', undefined, undefined, sample,
        undefined, undefined, undefined, undefined, undefined, {
          prepare,
          execution: input => createCheckpointQualificationExecution(input, {
            boundary: (input: Parameters<typeof createCheckpointQualificationYieldBoundary>[0]) => {
              boundary = input; return { stop: vi.fn() };
            },
          } as never),
        });
      const pending = deps.runGreen(root, null, { candidate: progress.candidate });
      const rejected = expect(pending).rejects.toMatchObject({ disposition: disposition === 'yield' ? 'yielded' : 'killed' });
      await vi.waitFor(() => expect(sample).toHaveBeenCalledTimes(1));
      expect(boundary).toBeDefined();
      if (disposition === 'yield') boundary.onYield!({ identity: 'fixture', completedUnitIds: [],
        pendingUnitIds: [], newCompletionIds: [], budget: budget() });
      else boundary.onKill!({ reason: 'durable-progress-stalled' });
      await rejected;
      const filesAtReturn = readdirSync(root, { recursive: true });
      // The caller has already returned. Resume the abandoned operation at the
      // exact pre-suite await that previously fell back to the raw executor.
      releaseSample([]);
      await new Promise(resolve => setImmediate(resolve));
      expect(execute).not.toHaveBeenCalled();
      expect(observer.finish).not.toHaveBeenCalled();
      expect(readdirSync(root, { recursive: true })).toEqual(filesAtReturn);
    } finally {
      for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('charges preparation to the original caller clock and preserves an earlier deadline', () => {
    const started = 1_000_000;
    const inherited = started + 400_000;
    const resolved = checkpointQualificationBudgetFromEnv(started + 50_000,
      { [TASK_DEADLINE_EPOCH_MS_ENV]: String(inherited) }, started);
    expect(resolved).toMatchObject({ status: 'ready', callerDeadlineEpochMs: inherited,
      cleanupDeadlineEpochMs: inherited, executionCutoffEpochMs: inherited - 135_000,
      yieldDeadlineEpochMs: inherited - 120_000 });
    const fallback = checkpointQualificationBudgetFromEnv(started + 50_000, {}, started);
    expect(fallback).toMatchObject({ status: 'ready', cleanupDeadlineEpochMs: started + GREEN_CHECKPOINT_SUITE_TIMEOUT_MS });
    expect(checkpointQualificationBudgetFromEnv(inherited - 10_000,
      { [TASK_DEADLINE_EPOCH_MS_ENV]: String(inherited) }, started)).toMatchObject({ status: 'refused' });
  });

  it('confines candidate workers, including nested workspace commands, under the same cleanup deadline', async () => {
    const { execution, execute } = setup();
    await execution.execute('npm', ['test'], { cwd: '/repo/packages/a', env: {} });
    expect(execute).toHaveBeenCalledWith('npm', ['test'], expect.objectContaining({
      qualification: { target, progress, deadlineEpochMs: 4000 }, signal: expect.any(AbortSignal),
    }));
    await execution.stop();
  });

  it('aborts on durable yield and waits for scope cleanup before returning custody', async () => {
    let finish!: (value: CheckpointExecResult) => void;
    const raw = vi.fn<CheckpointExec>(() => new Promise<CheckpointExecResult>(resolve => { finish = resolve; }));
    const { execution, callbacks, onStop } = setup(raw);
    const pending = execution.execute('npm', ['test'], { cwd: '/repo' });
    const rejected = expect(pending).rejects.toBeInstanceOf(CheckpointQualificationBoundaryError);
    callbacks().onYield();
    expect(onStop.mock.calls[0]?.[0]).toMatchObject({ disposition: 'yielded' });
    expect(raw.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    let cleaned = false;
    const cleanup = execution.stop().then(() => { cleaned = true; });
    await Promise.resolve(); expect(cleaned).toBe(false);
    finish(result); await rejected; await cleanup;
    expect(cleaned).toBe(true);
    await expect(execution.execute('npm', ['test'], { cwd: '/repo' })).rejects.toBeInstanceOf(CheckpointQualificationBoundaryError);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('a failed durable boundary prevents a later zero exit from becoming a verdict', async () => {
    const { execution, callbacks, onStop } = setup();
    callbacks().onKill({ reason: 'durable-progress-stalled' });
    expect(onStop.mock.calls[0]?.[0]).toMatchObject({ disposition: 'killed', detail: 'durable-progress-stalled' });
    expect(() => execution.assertRunning()).toThrow('durable-progress-stalled');
    await execution.stop();
  });

  it('runCmd keeps the original npm argv inside pc-heavy and uses the confined executor even with a worker timeout', async () => {
    confined.mockResolvedValue(result);
    await expect(runCmd('npm', ['run', 'test:affected'], { cwd: '/repo', env: {}, heavy: true,
      timeoutMs: 100, qualification: { target, progress, deadlineEpochMs: 4000 } })).resolves.toEqual(result);
    expect(confined).toHaveBeenCalledWith(expect.stringContaining('/scripts/pc-heavy.sh'),
      ['npm', 'run', 'test:affected'], expect.objectContaining({ cwd: '/repo', timeoutMs: 100,
        env: expect.objectContaining({ PC_HEAVY_COALESCE: '0' }), deadlineEpochMs: 4000 }));
  });

  it('runCmd preserves a measured signal and refuses a false zero-exit success', async () => {
    confined.mockResolvedValue({ ...result, code: null, signal: 'SIGKILL' });
    await expect(runCmd('npm', ['test'], { cwd: '/repo', env: {}, allowNonZero: true,
      qualification: { target, progress, deadlineEpochMs: 4000 } })).resolves.toMatchObject({ code: 1, signal: 'SIGKILL' });
    await expect(runCmd('npm', ['test'], { cwd: '/repo', env: {},
      qualification: { target, progress, deadlineEpochMs: 4000 } })).rejects.toThrow('SIGKILL');
  });
});
