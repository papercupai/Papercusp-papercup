import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointQualificationRunnerIdentity, composeCheckpointQualificationBeforePromotion, createCheckpointQualificationNativeObserver,
  createCheckpointQualificationYieldBoundary,
  createCheckpointQualificationPostSuiteExecutor, checkpointQualificationPostSuiteDefinition, runPostSuiteLegs,
  postSuiteContinuationPopulation, prepareCheckpointQualificationNativeRun, realCheckpointDeps, runCmd } from './green-checkpoint';
import type { CheckpointExec, CheckpointExecResult } from './green-checkpoint';
import type { QualificationWorkProgressInput } from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';
import { beginQualificationTransaction, reserveQualificationRunner, recordQualificationWorkProgress,
  recordQualificationWorkYield } from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';
import type { QualificationWorkContinuation, StoredQualificationMutation } from '@papercusp/operator-core/lib/release/checkpoint-qualification-transaction';
import { evaluatePartialTaskContinuation, readPartialCurrentCommandCompletion, preparePartialContinuationManifest,
  partialCurrentExecutionFingerprint, partialTaskCommandInputs, preparePartialTaskCommandDefinitions,
  readPartialTaskCommandCompletion } from '../../../../scripts/lib/partial-task-resume.mjs';
import { nativeProcessTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';
import { syncBudgetedTaskNativeExecutionReceipt, writeBudgetedTaskNativeExecutionReceipt } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';
import { releaseConfig } from './release-config';
import { resolveQualificationYieldBudget } from '../../../../scripts/lib/batch-watchdog.mjs';

const storedRead = vi.hoisted(() => vi.fn());
const storedProgress = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/operator-core/lib/release/checkpoint-qualification-transaction', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/operator-core/lib/release/checkpoint-qualification-transaction')>(),
  readStoredQualification: storedRead,
  recordStoredQualificationWorkProgress: storedProgress,
}));

const progress: QualificationWorkProgressInput = {
  attemptId: 'attempt', candidate: 'candidate', repairHead: null, runnerId: 'runner',
  runId: 'run', pidIdentity: 'boot:42', root: '/repo', taskKey: 'qualification',
  manifest: { schemaVersion: 1, units: [{ id: 'test:a.test.ts', kind: 'test', path: 'a.test.ts' }] },
  retryStates: [], runContext: 'green-checkpoint', runnerIdentity: 'native', updates: [],
};
const announcement = (task = 'ws :: test', path = '/out/a.producer.json') =>
  `QUALIFICATION_NATIVE_PRODUCER task=${JSON.stringify(task)} path=${JSON.stringify(path)}`;
const fixture = () => {
  const enroll = vi.fn().mockResolvedValue({ status: 'updated', transaction: {} });
  const recover = vi.fn().mockResolvedValue({ status: 'idempotent', transaction: { attemptId: 'attempt' } });
  const tasks = new Map([['ws :: test', { workspaceName: 'ws', selectedSpecifications: [{ testFile: 'a.test.ts' }] }]]);
  return { enroll, recover, tasks,
    observer: createCheckpointQualificationNativeObserver({ target: { workspaceId: 'w', installSlug: 'h' },
      progress, tasks }, { enroll, recover }) };
};

describe('durable native qualification yield adapter', () => {
  const setup = () => {
    const budget = resolveQualificationYieldBudget({ startedAtMs: 1000, quantumMs: 500,
      deadlineEpochMs: 2000, orphanDeadlineEpochMs: 2200, cleanupReserveMs: 200, yieldReserveMs: 100 });
    if (budget.status !== 'ready') throw new Error(budget.reason);
    const runner = reserveQualificationRunner(beginQualificationTransaction(null, {
      attemptId: progress.attemptId, candidate: progress.candidate, nowMs: 1000 }).transaction,
      { attemptId: progress.attemptId, candidate: progress.candidate, runnerId: progress.runnerId,
        runId: progress.runId, pid: 42, pidIdentity: progress.pidIdentity, started: true,
        leaseDurationMs: 1000, nowMs: 1000 }).transaction;
    let current = recordQualificationWorkProgress(runner, { ...progress, nowMs: 1300, updates: [{ receipt: {
      unitId: 'test:a.test.ts', completionId: 'new-completion', state: 'pass', observedAtMs: 1200,
    } }] }).transaction;
    const snapshot = vi.fn(async () => ({ status: 'ready' as const, transaction: current }));
    const record = vi.fn(async (_target, input, cursor, _signal) => {
      const saved = recordQualificationWorkYield(current, { ...input, nowMs: Date.now() }, cursor);
      if (saved.status === 'updated' || saved.status === 'idempotent') current = saved.transaction;
      return saved;
    });
    const onYield = vi.fn(), onKill = vi.fn();
    const boundary = createCheckpointQualificationYieldBoundary({ target: { workspaceId: 'w', installSlug: 'h' },
      progress, observer: { snapshot }, budget, baselineReceipts: [], onYield, onKill }, { record });
    return { boundary, snapshot, record, onYield, onKill, current: () => current };
  };

  it('saves the authenticated prefix and exact pending cursor before acknowledgment without releasing custody', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const f = setup();
      await vi.advanceTimersByTimeAsync(500);
      expect(f.onKill).not.toHaveBeenCalled(); expect(f.onYield).toHaveBeenCalledTimes(1);
      expect(f.current().continuation!.lastYield).toMatchObject({ savedAtMs: 1500,
        completed: [{ unitId: 'test:a.test.ts', completionId: 'new-completion' }], pendingUnitIds: [] });
      expect(f.current().currentPhysicalRunner!.id).toBe(progress.runnerId);
    } finally { vi.useRealTimers(); }
  });

  it('refuses a snapshot from another physical runner without attempting the store', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const f = setup();
      f.snapshot.mockResolvedValue({ status: 'ready', transaction: { ...f.current(), runId: 'other-run' } });
      await vi.advanceTimersByTimeAsync(500);
      expect(f.record).not.toHaveBeenCalled(); expect(f.onYield).not.toHaveBeenCalled();
      expect(f.onKill).toHaveBeenCalledWith({ reason: 'durable-progress-unmeasured' });
    } finally { vi.useRealTimers(); }
  });

  it('cancels blocked persistence at its absolute reserve and never acknowledges it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    try {
      const f = setup();
      f.record.mockImplementation(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(600);
      expect(f.boundary.signal.aborted).toBe(true);
      expect(f.onYield).not.toHaveBeenCalled();
      expect(f.onKill).toHaveBeenCalledWith({ reason: 'yield-deadline' });
    } finally { vi.useRealTimers(); }
  });
});

describe('durable native observer snapshots', () => {
  it('reads a prefix without ending observation and keeps the final read idempotent', async () => {
    const f = fixture();
    const line = announcement();
    f.observer.onOutput('stdout', line.slice(0, 20));
    expect(await f.observer.snapshot()).toMatchObject({ status: 'ready' });
    expect(f.enroll).not.toHaveBeenCalled();
    f.observer.onOutput('stdout', line.slice(20) + '\n');
    expect(await f.observer.snapshot()).toMatchObject({ status: 'ready' });
    expect(f.enroll).toHaveBeenCalledTimes(1);
    const final = f.observer.finish();
    expect(f.observer.finish()).toBe(final);
    expect(f.observer.snapshot()).toBe(final);
    expect(await final).toMatchObject({ status: 'ready' });
    expect(f.recover).toHaveBeenCalledTimes(3);
  });

  it('cannot overtake pending enrollment or another durable-prefix read', async () => {
    const f = fixture();
    let finishEnrollment!: (value: { status: string; transaction: {} }) => void;
    f.enroll.mockImplementationOnce(() => new Promise<{ status: string; transaction: {} }>(resolve => { finishEnrollment = resolve; }));
    f.observer.onOutput('stdout', announcement() + '\n');
    const first = f.observer.snapshot(), second = f.observer.snapshot();
    await Promise.resolve();
    expect(f.recover).not.toHaveBeenCalled();
    finishEnrollment({ status: 'updated', transaction: {} });
    await Promise.all([first, second]);
    expect(f.recover).toHaveBeenCalledTimes(2);
  });

  it('latches a rejected prefix so later reads cannot hide it behind banked passes', async () => {
    const f = fixture();
    f.recover.mockResolvedValueOnce({ status: 'conflict', transaction: { attemptId: 'attempt' } });
    const first = await f.observer.snapshot();
    expect(first).toEqual({ status: 'refused', reason: 'native-producer-recovery-conflict' });
    expect(await f.observer.snapshot()).toEqual(first);
    expect(await f.observer.finish()).toEqual(first);
    expect(f.recover).toHaveBeenCalledTimes(1);
  });
});

describe('original affected-task guard authentication', () => {
  it.each([[0, false, []], [0, false, ['--fixture-marker=ok']], [7, false, []], [0, true, []]] as const)(
    'authenticates the entire original npm guard, postguard exit %s, ignore-scripts %s, forwarded %j', async (postExit, ignoreScripts, forwarded) => {
    const root = mkdtempSync(join(tmpdir(), 'qualification-task-guard-source-'));
    const evidenceRoot = mkdtempSync(join(tmpdir(), 'qualification-task-guard-evidence-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      const originalCommand = 'node -e "console.log(\'GUARD_EXECUTED\')" --';
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'guard-fixture', scripts: {
        preguard: 'node -e "console.log(\'PRE_EXECUTED\')"', guard: originalCommand,
        postguard: `node -e "console.log('POST_EXECUTED');process.exit(${postExit})"`,
      } }));
      git('init', '--quiet');
      git('add', 'package.json');
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
        'commit', '--quiet', '-m', 'original guard fixture');
      const candidate = git('rev-parse', 'HEAD');
      const task = 'guard-fixture :: guard';
      const selection = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
        taskInventory: [{ id: task, dir: '.', command: originalCommand, isInvariantGuard: true }],
        tasks: [], unenumerated: [], commandObligations: [] };
      const postSuite = { schemaVersion: 1, coverage: 'complete',
        units: [{ id: 'post:build', kind: 'post-suite', path: 'package.json' }] };
      const invocations = [{ task, cwd: root, argv: ['npm', 'run', 'guard', ...(forwarded.length ? ['--', ...forwarded] : [])] }];
      const prepared = preparePartialTaskCommandDefinitions({ root, selection, postSuite, evidenceRoot, invocations });
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 'ready', operationalAcceptance: false,
        definitions: [{ task, unitIds: [`guard:${task}`] }] });
      const definition = prepared.definitions[0]!;
      const manifest = preparePartialContinuationManifest({ root, tasks: selection.taskInventory, selection, postSuite }).manifest;
      const expected = { ...progress, root, candidate, sourceCommit: candidate, manifest,
        runnerReservedAtMs: Date.now(), nowMs: 0 };
      const before = partialTaskCommandInputs(root, '.');
      const sourceBefore = { commit: candidate, clean: !git('status', '--porcelain') };
      const startedAtMs = Date.now();
      const traceOut = join(evidenceRoot, 'original-task.out');
      let childPid = 0;
      const result = await runCmd('npm', invocations[0]!.argv.slice(1), { cwd: root, timeoutMs: 10_000, allowNonZero: true,
        env: nativeProcessTraceEnv({ ...process.env, PC_EXECUTED_SOURCE_MAP_OUT: traceOut,
          npm_config_ignore_scripts: String(ignoreScripts) }),
        onSpawn: child => { childPid = child.pid; } });
      const finishedAtMs = Date.now();
      const saved = writeBudgetedTaskNativeExecutionReceipt(evidenceRoot, {
        task, attempt: expected.runId, cwd: root, command: invocations[0]!.argv,
        invocation: { command: invocations[0]!.argv, environmentSha256: 'a'.repeat(64) },
        originalCommand, before, after: partialTaskCommandInputs(root, '.'),
        currentExecution: { schemaVersion: 1, fingerprint: partialCurrentExecutionFingerprint(expected),
          childPid, childIdentity: `observed:${childPid}`, sourceBefore,
          sourceAfter: { commit: git('rev-parse', 'HEAD'), clean: !git('status', '--porcelain') } },
        processTrace: { out: traceOut, rootPid: childPid }, startedAtMs, finishedAtMs,
        exitCode: result.code, signal: result.signal ?? null, error: null, captureComplete: true,
        stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr),
      });
      syncBudgetedTaskNativeExecutionReceipt(saved);
      expect(result.stdout).toContain('GUARD_EXECUTED');
      if (ignoreScripts) {
        expect(result.stdout).not.toContain('PRE_EXECUTED');
        expect(result.stdout).not.toContain('POST_EXECUTED');
      } else {
        expect(result.stdout).toContain('PRE_EXECUTED');
        expect(result.stdout).toContain('POST_EXECUTED');
      }
      expected.nowMs = Date.now();
      const read = (identity = expected, def = definition) => readPartialTaskCommandCompletion(saved, identity, def);
      const transaction = { currentPhysicalRunner: { reservedAtMs: expected.runnerReservedAtMs },
        continuation: { receipts: [] } };
      const record = vi.fn().mockResolvedValue({ status: 'updated', transaction });
      const recover = vi.fn().mockResolvedValue({ status: 'idempotent', transaction });
      const host = () => createCheckpointQualificationNativeObserver({ target: { workspaceId: 'w', installSlug: 'h' },
        progress: expected, tasks: new Map(), commands: new Map([[task, definition]]) },
      { enroll: vi.fn(), recover, record });
      const line = `QUALIFICATION_TASK_COMPLETION=${JSON.stringify({ task, root: saved.root, receipt: saved.receipt })}`;
      const observer = host();
      observer.onOutput('stdout', line.slice(0, 31));
      observer.onOutput('stdout', line.slice(31) + '\n');
      if (postExit || ignoreScripts) {
        expect(read()).toMatchObject({ status: 'refused', receipts: [], currentEvidence: [] });
        expect(await observer.finish()).toMatchObject({ status: 'refused' });
        expect(record.mock.calls.filter(([, input]) => input.updates.length)).toHaveLength(0);
        expect(recover).not.toHaveBeenCalled();
        return;
      }
      const observed = read();
      expect(await observer.finish()).toMatchObject({ status: 'ready' });
      expect(record.mock.calls.filter(([, input]) => input.updates.length)).toHaveLength(1);
      expect(record.mock.calls.find(([, input]) => input.updates.length)![1].updates)
        .toEqual(observed.receipts.map(receipt => ({ receipt })));
      const conflict = host();
      conflict.onOutput('stdout', `${line}\n${line.replace(saved.receipt.sha256, 'f'.repeat(64))}\n`);
      expect(await conflict.finish()).toMatchObject({ status: 'refused', reason: 'task-command-announcement-conflict' });
      const stolen = host();
      record.mockResolvedValueOnce({ status: 'conflict', transaction });
      stolen.onOutput('stderr', line + '\n');
      expect(await stolen.finish()).toMatchObject({ status: 'refused', reason: 'task-command-custody-conflict' });
      expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'ready',
        receipts: [{ unitId: `guard:${task}`, state: 'pass', proof: {
          opaqueReasons: ['task-command-runtime-inputs-unmeasured'] } }], currentEvidence: [{}] });
      const checkpoint = { root, taskKey: expected.taskKey, continuation: { schemaVersion: 1, ...expected,
        receipts: observed.receipts } };
      expect(evaluatePartialTaskContinuation(checkpoint, expected, { currentEvidence: observed.currentEvidence }))
        .toMatchObject({ verdict: 'incomplete', current: [`guard:${task}`], run: ['post:build'], reused: [] });
      expect(evaluatePartialTaskContinuation(checkpoint, expected)).toMatchObject({ current: [], reused: [] });
      expect(read({ ...expected, runId: 'replacement' })).toMatchObject({ status: 'refused' });
      expect(read({ ...expected, pidIdentity: 'stale:fence' })).toMatchObject({ status: 'refused' });
      expect(read(expected, { ...definition, unitIds: [...definition.unitIds, 'guard:invented'] }))
        .toMatchObject({ status: 'refused', receipts: [], currentEvidence: [] });
      expect(preparePartialTaskCommandDefinitions({ root, selection, postSuite, evidenceRoot,
        invocations: [{ ...invocations[0], argv: ['npm', 'run', 'other'] }] })).toMatchObject({ status: 'refused' });
      writeFileSync(join(evidenceRoot, saved.receipt.ref), 'corrupt');
      expect(read()).toMatchObject({ status: 'refused', receipts: [], currentEvidence: [] });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'guard-fixture', scripts: { guard: 'node other.mjs' } }));
      expect(preparePartialTaskCommandDefinitions({ root, selection, postSuite, evidenceRoot, invocations }))
        .toMatchObject({ status: 'refused', reason: 'task-command-source-mismatch' });
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(evidenceRoot, { recursive: true, force: true }); }
  }, 30_000);
});

describe('production post-suite qualification capture', () => {
  const setup = (execute: CheckpointExec, root = progress.root, overrides: Partial<QualificationWorkProgressInput> = {}) => {
    const input = { target: { workspaceId: 'w', installSlug: 'h' }, progress: { ...progress, ...overrides, root,
      manifest: { schemaVersion: 1 as const, units: [...progress.manifest.units, ...postSuiteContinuationPopulation().units] } } };
    const started = beginQualificationTransaction(null, input.progress);
    const continuation: QualificationWorkContinuation = { schemaVersion: 1, ...input.progress, receipts: [], supersededReceipts: [] };
    const transaction = { ...started.transaction, continuation };
    const record = vi.fn(async (_target: typeof input.target, work: QualificationWorkProgressInput): Promise<StoredQualificationMutation> => {
      for (const update of work.updates) {
        const prior = transaction.continuation.receipts.findIndex(row => row.unitId === update.receipt.unitId);
        if (prior < 0) transaction.continuation.receipts.push(structuredClone(update.receipt));
        else transaction.continuation.receipts[prior] = structuredClone(update.receipt);
      }
      return { status: 'updated', transaction };
    });
    const exec = createCheckpointQualificationPostSuiteExecutor(input, execute,
      { record, now: Date.now });
    return { exec, record, transaction, input };
  };

  it('authenticates a real current command independently of reuse and refuses replacement or corrupt artifacts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-current-command-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node guard.mjs' } }));
      writeFileSync(join(root, 'guard.mjs'), 'console.log("CURRENT_COMMAND_EXECUTED");\n');
      git('init', '--quiet');
      git('add', 'package.json', 'guard.mjs');
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null',
        'commit', '--quiet', '-m', 'current command fixture');
      const candidate = git('rev-parse', 'HEAD');
      const reservedAtMs = Date.now();
      const state = setup(runCmd, root, { candidate });
      expect(await state.exec('npm', ['run', 'lint:tsc'], { cwd: root, timeoutMs: 10_000 }))
        .toMatchObject({ code: 0, stdout: expect.stringContaining('CURRENT_COMMAND_EXECUTED') });
      const saved = state.transaction.continuation.receipts[0]!;
      expect(saved.proof?.opaqueReasons).toEqual(['post-suite-runtime-inputs-unmeasured']);
      expect(saved.proof?.inputsCaptured).toBeUndefined();
      const expected = { ...state.input.progress, sourceCommit: candidate, runnerReservedAtMs: reservedAtMs, nowMs: Date.now() };
      const definition = checkpointQualificationPostSuiteDefinition(state.input.progress, saved.unitId)!;
      const read = (identity = expected) => readPartialCurrentCommandCompletion(saved, identity, definition);
      const observed = read();
      expect(observed, JSON.stringify(observed)).toMatchObject({ status: 'ready', currentEvidence: [{}] });
      expect(evaluatePartialTaskContinuation({ root, taskKey: progress.taskKey, continuation: state.transaction.continuation },
        expected, { currentEvidence: observed.currentEvidence })).toMatchObject({ verdict: 'incomplete',
        current: ['post:lint:tsc'], reused: [], counts: { passed: 1 } });
      expect(read({ ...expected, runId: 'replacement' })).toMatchObject({ status: 'refused', currentEvidence: [] });
      const outcomes = saved.proof?.commandOutcomes;
      if (!Array.isArray(outcomes)) throw new Error('missing current command artifact');
      const artifact = join(outcomes[0].root, outcomes[0].receipt.ref);
      writeFileSync(artifact, `${readFileSync(artifact, 'utf8')}corrupt`);
      expect(read()).toMatchObject({ status: 'refused', currentEvidence: [] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('banks real original npm output before a later post-suite interruption without inventing input proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-post-capture-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
        'lint:tsc': 'node -e "console.log(12345)"', 'lint:tsc:papercusp-libs': 'node -e "console.log(67890)"',
      } }));
      let state: ReturnType<typeof setup>;
      const execute: CheckpointExec = async (cmd, args, options) => {
        if (args.includes('lint:tsc:papercusp-libs')) {
          expect(state.transaction.continuation.receipts.map(row => row.unitId)).toEqual(['post:lint:tsc']);
          throw new Error('interrupted following leg');
        }
        const child = spawnSync(cmd, args, { cwd: options?.cwd, encoding: 'utf8', timeout: 10_000 });
        expect(child.error).toBeUndefined();
        return { code: child.status!, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
      };
      state = setup(execute, root);
      storedProgress.mockImplementation(state.record);
      await expect(runPostSuiteLegs(root, {}, execute, '', { qualification: state.input })).rejects.toThrow('interrupted following leg');
      const saved = state.transaction.continuation.receipts[0]!;
      expect(saved).toMatchObject({ unitId: 'post:lint:tsc', state: 'pass', observedCount: 1,
        proof: { opaqueReasons: ['post-suite-runtime-inputs-unmeasured'] } });
      expect(saved.proof?.inputsCaptured).toBeUndefined();
      const outcomes = saved.proof?.commandOutcomes;
      if (!Array.isArray(outcomes)) throw new Error('missing durable command output');
      const pin = outcomes[0];
      const bytes = readFileSync(join(pin.root, pin.receipt.ref));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.receipt.sha256);
      const native = JSON.parse(bytes.toString());
      expect(native.execution).toMatchObject({ command: ['npm', 'run', 'lint:tsc'], cwd: root, exitCode: 0 });
      expect(readFileSync(join(pin.root, native.execution.logs.stdout.ref), 'utf8')).toContain('12345');
      expect(state.transaction.continuation.receipts[1]).toMatchObject({ unitId: 'post:lint:tsc:papercusp-libs', state: 'infra' });
    } finally { storedProgress.mockReset(); rmSync(root, { recursive: true, force: true }); }
  });

  it('awaits durable acknowledgement and stops later work after a refused completion', async () => {
    const execute = vi.fn().mockResolvedValue({ code: 0, stdout: 'measured', stderr: '' });
    const state = setup(execute);
    let release!: () => void;
    state.record.mockImplementationOnce(async () => ({ status: 'updated', transaction: state.transaction }));
    state.record.mockImplementationOnce(async () => ({ status: 'updated', transaction: state.transaction }));
    state.record.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ status: 'conflict', transaction: state.transaction }); }));
    const pending = state.exec('npm', ['run', 'lint:tsc']);
    const rejected = expect(pending).rejects.toThrow('qualification-post-suite-custody-conflict');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(state.transaction.continuation.receipts).toEqual([]);
    release();
    await rejected;
    await expect(state.exec('npm', ['run', 'lint:tsc:operator'])).rejects.toThrow('qualification-post-suite-custody-conflict');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds real npm loader source and wrapper inputs to the actual spawn without granting runtime closure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-post-source-'));
    try {
      const source = 'import { readFileSync } from "node:fs"; console.log(readFileSync("input.txt", "utf8"));\n';
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node guard.mjs' } }));
      writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
      writeFileSync(join(root, 'guard.mjs'), source);
      writeFileSync(join(root, 'input.txt'), 'actual runtime input');
      const state = setup(runCmd, root);
      const observer = vi.fn(child => { child.command.splice(0, child.command.length, 'mutated'); throw new Error('observer'); });
      expect(await state.exec('npm', ['run', 'lint:tsc'], { cwd: root, timeoutMs: 10_000, onSpawn: observer }))
        .toMatchObject({ code: 0, stdout: expect.stringContaining('actual runtime input') });
      expect(observer).toHaveBeenCalledOnce();
      const saved = state.transaction.continuation.receipts[0]!;
      const [pin] = saved.proof!.commandOutcomes as Array<{ root: string; receipt: { ref: string } }>;
      const native = JSON.parse(readFileSync(join(pin!.root, pin!.receipt.ref), 'utf8'));
      expect(native).toMatchObject({ originalCommand: 'node guard.mjs', sourceInputsUnchanged: true,
        execution: { command: ['npm', 'run', 'lint:tsc'], cwd: root, exitCode: 0 },
        orderedChainQualified: false, runtimeClosure: 'unmeasured' });
      expect(native.before.inputs).toEqual(native.after.inputs);
      expect(native.before.inputs.map((input: { path: string }) => input.path)).toEqual(['package.json', 'package-lock.json']);
      expect(native.processTrace.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'node-entry', argv: expect.arrayContaining([join(root, 'guard.mjs')]) }),
        expect.objectContaining({ event: 'child-close', code: 0, signal: null }),
      ]));
      const entry = native.processTrace.loaderSources.entries.find((entry: { url: string }) => entry.url.endsWith('/guard.mjs'));
      expect(entry, 'the bytes returned by the native loader must be archived').toBeDefined();
      expect(readFileSync(join(pin!.root, entry.artifact.ref), 'utf8')).toBe(source);
      expect(saved.proof!.inputsCaptured).toBeUndefined();
      expect(saved.proof!.opaqueReasons).toEqual(['post-suite-runtime-inputs-unmeasured']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['changed', 'added', 'removed'] as const)('retains %s npm input evidence across execution', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-post-input-drift-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node original.mjs' } }));
      if (mode === 'removed') writeFileSync(join(root, '.npmrc'), 'audit=false');
      const state = setup(async () => {
        if (mode === 'changed') writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node changed.mjs' } }));
        if (mode === 'added') writeFileSync(join(root, 'package-lock.json'), '{}');
        if (mode === 'removed') unlinkSync(join(root, '.npmrc'));
        return { code: 0, stdout: '', stderr: '' };
      }, root);
      await state.exec('npm', ['run', 'lint:tsc'], { cwd: root });
      const saved = state.transaction.continuation.receipts[0]!;
      const [pin] = saved.proof!.commandOutcomes as Array<{ root: string; receipt: { ref: string } }>;
      const native = JSON.parse(readFileSync(join(pin!.root, pin!.receipt.ref), 'utf8'));
      expect(native.originalCommand).toBe('node original.mjs');
      expect(native.sourceInputsUnchanged).toBe(false);
      expect(native.before.inputs).not.toEqual(native.after.inputs);
      expect(native.processTrace.gaps).toContain('native-process-trace-unobserved');
      expect(saved.proof!.inputsCaptured).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps redirected wrapper inputs unmeasured while retaining the command outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-post-input-redirect-'));
    try {
      writeFileSync(join(root, 'actual.json'), JSON.stringify({ scripts: { 'lint:tsc': 'node guard.mjs' } }));
      symlinkSync(join(root, 'actual.json'), join(root, 'package.json'));
      const state = setup(async () => ({ code: 0, stdout: 'native output', stderr: '' }), root);
      expect(await state.exec('npm', ['run', 'lint:tsc'], { cwd: root })).toMatchObject({ code: 0 });
      const saved = state.transaction.continuation.receipts[0]!;
      const [pin] = saved.proof!.commandOutcomes as Array<{ root: string; receipt: { ref: string } }>;
      const native = JSON.parse(readFileSync(join(pin!.root, pin!.receipt.ref), 'utf8'));
      expect(native).toMatchObject({ before: { inputs: null }, after: { inputs: null }, sourceInputsUnchanged: false });
      expect(readFileSync(join(pin!.root, native.execution.logs.stdout.ref), 'utf8')).toBe('native output');
      expect(saved.proof!.inputsCaptured).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const markerArgs = ['grep', '-n', '-I', '-E', '^(<{7}|>{7}|\\|{7})([ \\t]|$)', '--', '.'];
  const bankedFixture = async (commands = ['lint:tsc'], environment?: NodeJS.ProcessEnv, workspace?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-post-replay-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        ...(workspace ? { workspaces: ['apps/*'] } : {}),
        scripts: Object.fromEntries(commands.map(command => [command, 'node guard.mjs'])),
      }));
      if (workspace) {
        mkdirSync(join(root, 'apps/spa'), { recursive: true });
        writeFileSync(join(root, 'apps/spa/package.json'), JSON.stringify({ name: workspace,
          scripts: { build: 'node ../../guard.mjs' } }));
      }
      writeFileSync(join(root, 'guard.mjs'), 'console.log(12345);\n');
      const git = (...args: string[]) => {
        const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
        expect(child.status, child.stderr).toBe(0);
        return child.stdout.trim();
      };
      git('init', '--quiet'); git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
      const state = setup(runCmd, root, { candidate: git('rev-parse', 'HEAD') });
      let original!: CheckpointExecResult;
      for (const command of commands) original = await state.exec(command === 'spa:conflict-markers' ? 'git' : 'npm',
        command === 'spa:conflict-markers' ? markerArgs : workspace && command === 'build'
          ? ['--workspace', workspace, 'run', 'build'] : ['run', command],
        { cwd: root, timeoutMs: 10_000, allowNonZero: true, ...(environment ? { env: environment } : {}) });
      const saved = state.transaction.continuation.receipts[0]!;
      // Contract fixture ONLY: production capture above intentionally does not
      // grant this proof. Test the driver given an independently eligible pass.
      Object.assign(saved, { worktreeDirty: false, proof: { ...saved.proof,
        recordedSha: state.input.progress.candidate, runContext: state.input.progress.runContext,
        runnerIdentity: state.input.progress.runnerIdentity, executedModules: ['package.json'],
        inputsCaptured: true, readPaths: [], opaqueReasons: [] } });
      const execute = vi.fn<CheckpointExec>();
      const resume = () => createCheckpointQualificationPostSuiteExecutor(state.input, execute,
        { record: state.record, now: Date.now });
      return { root, state, saved, original, execute, resume };
    } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  };

  it('replays an eligible durable post leg without a new child or receipt and keeps outstanding tests incomplete', async () => {
    const fixture = await bankedFixture();
    try {
      const completion = fixture.saved.completionId;
      const beforeWrites = fixture.state.record.mock.calls.filter(([, input]) => input.updates.length).length;
      expect(await fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root })).toMatchObject(fixture.original);
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.state.transaction.continuation.receipts[0]!.completionId).toBe(completion);
      expect(fixture.state.record.mock.calls.filter(([, input]) => input.updates.length)).toHaveLength(beforeWrites);
      expect(evaluatePartialTaskContinuation({ root: fixture.root, taskKey: fixture.state.input.progress.taskKey,
        continuation: fixture.state.transaction.continuation },
      { ...fixture.state.input.progress, sourceCommit: fixture.state.input.progress.candidate }))
        .toMatchObject({ status: 'ready', verdict: 'incomplete', reused: ['post:lint:tsc'], run: expect.arrayContaining(['test:a.test.ts']) });
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('authenticates the requested environment without retaining secret values', async () => {
    const environment = { ...process.env, P003_INPUT_SECRET: 'private-runtime-value', P003_INPUT_CONFIG: 'one' };
    const fixture = await bankedFixture(['lint:tsc'], environment);
    try {
      const [pin] = fixture.saved.proof!.commandOutcomes as Array<{ root: string; receipt: { ref: string } }>;
      const body = readFileSync(join(pin!.root, pin!.receipt.ref), 'utf8');
      const native = JSON.parse(body);
      expect(native.execution.invocation).toEqual({ command: ['npm', 'run', 'lint:tsc'],
        environmentSha256: createHash('sha256').update(JSON.stringify(Object.entries(environment)
          .filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') });
      expect(body).not.toContain('private-runtime-value');
      const reordered = Object.fromEntries(Object.entries(environment).reverse());
      expect(await fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root, env: reordered }))
        .toMatchObject(fixture.original);
      await expect(fixture.resume()('npm', ['run', 'lint:tsc'],
        { cwd: fixture.root, env: { ...environment, P003_INPUT_CONFIG: 'two' } })).rejects.toThrow('reuse-command-mismatch');
      await expect(fixture.resume()('npm', ['run', 'lint:tsc'],
        { cwd: fixture.root, env: { ...environment, P003_ADDED_INPUT: 'new' } })).rejects.toThrow('reuse-command-mismatch');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('refuses a legacy eligible receipt whose invocation environment was never measured', async () => {
    const fixture = await bankedFixture();
    try {
      const outcomes = fixture.saved.proof!.commandOutcomes as Array<{
        root: string; receipt: { ref: string; sha256: string; byteLength: number } }>;
      const pin = outcomes[0]!;
      const native = JSON.parse(readFileSync(join(pin.root, pin.receipt.ref), 'utf8'));
      delete native.execution.invocation;
      // A separately eligible fixture proof still cannot supply missing native
      // input evidence, even when the edited artifact is correctly hash-pinned.
      const bytes = Buffer.from(JSON.stringify(native));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      pin.receipt = { ref: `${sha256}.receipt.json`, sha256, byteLength: bytes.length };
      writeFileSync(join(pin.root, pin.receipt.ref), bytes);
      await expect(fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root }))
        .rejects.toThrow('reuse-command-mismatch');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('binds the original workspace build, its package inputs and clean marker exit one before replay', async () => {
    const environment = { ...process.env, PAPERCUSP_RETAIN_DIST_CHUNKS: '1' };
    const fixture = await bankedFixture(['spa:conflict-markers', 'build'], environment, '@fixture/spa');
    try {
      const pins = fixture.saved.proof!.commandOutcomes as Array<{ command: string; root: string; receipt: { ref: string } }>;
      const build = pins.find(pin => pin.command === 'build')!;
      const native = JSON.parse(readFileSync(join(build.root, build.receipt.ref), 'utf8'));
      expect(native.originalCommand).toBe('node ../../guard.mjs');
      expect(native.before.inputs.map((input: { path: string }) => input.path))
        .toEqual(['package.json', 'apps/spa/package.json']);
      expect(native.runtimeClosure).toBe('unmeasured');
      const resume = fixture.resume();
      expect(await resume('git', markerArgs, { cwd: fixture.root, env: environment })).toMatchObject({ code: 1, stdout: '' });
      expect(await resume('npm', ['--workspace', '@fixture/spa', 'run', 'build'], { cwd: fixture.root, env: environment }))
        .toMatchObject(fixture.original);
      await expect(fixture.resume()('npm', ['run', 'build'], { cwd: fixture.root, env: environment }))
        .rejects.toThrow('reuse-command-mismatch');
      await expect(fixture.resume()('npm', ['--workspace', '@another/spa', 'run', 'build'], { cwd: fixture.root, env: environment }))
        .rejects.toThrow('reuse-command-mismatch');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('rechecks workspace package inputs at the final replay fence', async () => {
    const fixture = await bankedFixture(['spa:conflict-markers', 'build'], undefined, '@fixture/spa');
    try {
      fixture.state.record.mockResolvedValueOnce({ status: 'idempotent', transaction: fixture.state.transaction })
        .mockImplementationOnce(async () => {
          writeFileSync(join(fixture.root, 'apps/spa/package.json'), JSON.stringify({ name: '@fixture/spa', scripts: { build: 'exit 0' } }));
          return { status: 'idempotent', transaction: fixture.state.transaction };
        });
      await expect(fixture.resume()('git', markerArgs, { cwd: fixture.root })).rejects.toThrow('reuse-source-drift');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(['stdout', 'loader-source', 'source-drift', 'argv-drift', 'outcomes-missing'] as const)(
    'refuses %s before replay or starting another child', async fault => {
      const fixture = await bankedFixture();
      try {
        const [pin] = fixture.saved.proof!.commandOutcomes as Array<{ root: string; receipt: { ref: string } }>;
        const native = JSON.parse(readFileSync(join(pin!.root, pin!.receipt.ref), 'utf8'));
        if (fault === 'stdout') {
          const file = join(pin!.root, native.execution.logs.stdout.ref);
          writeFileSync(file, readFileSync(file, 'utf8').replace('12345', '99999'));
        }
        if (fault === 'loader-source') {
          const loaded = native.processTrace.loaderSources.entries.find((entry: { url: string }) => entry.url.endsWith('/guard.mjs'));
          writeFileSync(join(pin!.root, loaded.artifact.ref), 'console.log(99999);\n');
        }
        if (fault === 'source-drift') writeFileSync(join(fixture.root, 'guard.mjs'), 'console.log(99999);\n');
        if (fault === 'outcomes-missing') fixture.saved.proof!.commandOutcomes = [];
        const exec = fixture.resume();
        await expect(exec('npm', ['run', 'lint:tsc', ...(fault === 'argv-drift' ? ['--', '--changed'] : [])], { cwd: fixture.root }))
          .rejects.toThrow();
        await expect(exec('npm', ['run', 'lint:tsc:operator'], { cwd: fixture.root })).rejects.toThrow();
        expect(fixture.execute).not.toHaveBeenCalled();
      } finally { rmSync(fixture.root, { recursive: true, force: true }); }
    },
  );

  it('authenticates every grouped output before replaying its first command', async () => {
    const commands = ['lint:no-owner-name-tags', 'lint:no-box-identity', 'lint:no-identity-literals'];
    const fixture = await bankedFixture(commands);
    try {
      const exec = fixture.resume();
      for (const command of commands)
        expect(await exec('npm', ['run', command], { cwd: fixture.root })).toMatchObject({ code: 0, stdout: expect.stringContaining('12345') });
      expect(fixture.execute).not.toHaveBeenCalled();
      (fixture.saved.proof!.commandOutcomes as unknown[]).pop();
      await expect(fixture.resume()('npm', ['run', commands[0]!], { cwd: fixture.root }))
        .rejects.toThrow('reuse-outcomes-unmeasured');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('rechecks custody after artifact reads before acknowledging a saved output', async () => {
    const fixture = await bankedFixture();
    try {
      fixture.state.record.mockResolvedValueOnce({ status: 'idempotent', transaction: fixture.state.transaction })
        .mockResolvedValueOnce({ status: 'conflict', transaction: fixture.state.transaction });
      await expect(fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root }))
        .rejects.toThrow('qualification-post-suite-custody-conflict');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('executes an unqualified raw outcome instead of treating its zero exit as a reuse proof', async () => {
    const fixture = await bankedFixture();
    try {
      fixture.saved.proof!.inputsCaptured = false;
      fixture.saved.proof!.opaqueReasons = ['post-suite-runtime-inputs-unmeasured'];
      const completion = fixture.saved.completionId;
      fixture.execute.mockImplementation(runCmd);
      expect(await fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root, timeoutMs: 10_000 }))
        .toMatchObject({ code: 0, stdout: expect.stringContaining('12345') });
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fixture.state.transaction.continuation.receipts[0]!.completionId).not.toBe(completion);
      expect(fixture.state.transaction.continuation.receipts[0]!.proof!.inputsCaptured).toBeUndefined();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(['receipt', 'source'] as const)('refuses %s changes during the final replay fence', async fault => {
    const fixture = await bankedFixture();
    try {
      fixture.state.record.mockResolvedValueOnce({ status: 'idempotent', transaction: fixture.state.transaction })
        .mockImplementationOnce(async () => {
          if (fault === 'receipt') fixture.saved.completionId = 'concurrently-replaced';
          else writeFileSync(join(fixture.root, 'guard.mjs'), 'console.log(99999);\n');
          return { status: 'idempotent', transaction: fixture.state.transaction };
        });
      await expect(fixture.resume()('npm', ['run', 'lint:tsc'], { cwd: fixture.root }))
        .rejects.toThrow(fault === 'receipt' ? 'reuse-receipt-changed' : 'reuse-source-drift');
      expect(fixture.execute).not.toHaveBeenCalled();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it('banks a grouped leg once after every concurrent command closes', async () => {
    let release!: (result: CheckpointExecResult) => void;
    const state = setup(async (_cmd, args) => args.includes('lint:no-owner-name-tags')
      ? new Promise(resolve => { release = resolve; }) : { code: 0, stdout: '', stderr: '' });
    const first = state.exec('npm', ['run', 'lint:no-owner-name-tags']);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await Promise.all(['lint:no-box-identity', 'lint:no-identity-literals'].map(command => state.exec('npm', ['run', command])));
    expect(state.transaction.continuation.receipts).toEqual([]);
    release({ code: 0, stdout: '', stderr: '' });
    await first;
    expect(state.transaction.continuation.receipts).toMatchObject([{ unitId: 'post:lint:identity-leak', state: 'pass', observedCount: 3 }]);
    expect(state.record.mock.calls.filter(([, input]) => input.updates.length)).toHaveLength(1);
  });

  it('stops future command starts when the store rejects without an Error value', async () => {
    const execute = vi.fn();
    const state = setup(execute);
    state.record.mockRejectedValueOnce(undefined);
    await expect(state.exec('npm', ['run', 'lint:tsc'])).rejects.toBeUndefined();
    await expect(state.exec('npm', ['run', 'lint:tsc:operator'])).rejects.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
    expect(state.record).toHaveBeenCalledTimes(1);
  });

  it('retains non-green signal evidence and rejects out-of-population or duplicate starts', async () => {
    const execute = vi.fn().mockResolvedValue({ code: 0, signal: 'SIGTERM', stdout: '', stderr: '' });
    const state = setup(execute);
    expect(await state.exec('npm', ['run', 'lint:tsc'])).toMatchObject({ code: 1, signal: 'SIGTERM' });
    expect(state.transaction.continuation.receipts[0]).toMatchObject({ state: 'infra' });
    await expect(state.exec('npm', ['run', 'lint:tsc:operator'], { cwd: '/different-root' })).rejects.toThrow('root-mismatch');
    await expect(state.exec('npm', ['run', 'unknown'])).rejects.toThrow('command-outside-manifest');
    await expect(state.exec('npm', ['run', 'lint:tsc'])).rejects.toThrow('command-duplicate');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('native qualification preparation before the production suite', () => {
  it('measures the candidate preload and each source-selected leaf, refusing unknown or mixed runtimes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-runtime-source-'));
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      writeFileSync(join(root, 'scripts/lib/vitest-startup-trace.mjs'),
        readFileSync(new URL('../../../../scripts/lib/vitest-startup-trace.mjs', import.meta.url)));
      const selection = { tasks: [{ dir: 'packages/a', runner: 'vitest', command: 'vitest run a.test.ts' },
        { dir: 'packages/b', runner: 'command-chain', command: 'npm run first && npm run second', steps: [
          { command: 'vitest run b.test.ts', discovery: [{ runner: 'vitest' }] },
          { lifecycle: true, command: 'node hook.mjs', discovery: [] },
        ] }] };
      const environment = { NODE_OPTIONS: '--max-old-space-size=2048' };
      const measure = vi.fn().mockReturnValue('measured-runtime');
      expect(await checkpointQualificationRunnerIdentity(root, selection, environment, measure)).toBe('measured-runtime');
      expect(measure.mock.calls.map(call => call[3])).toEqual([
        { workspaceRoot: join(root, 'packages/a'), scriptText: 'vitest run a.test.ts' },
        { workspaceRoot: join(root, 'packages/b'), scriptText: 'vitest run b.test.ts' },
      ]);
      expect(measure.mock.calls[0]![1].NODE_OPTIONS).toContain(root + '/scripts/lib/vitest-startup-trace.mjs');
      expect(measure.mock.calls[0]![1].NODE_OPTIONS).toContain('--max-old-space-size=2048');
      expect(environment.NODE_OPTIONS).toBe('--max-old-space-size=2048');
      measure.mockReset().mockReturnValueOnce('one-runtime').mockReturnValueOnce('another-runtime');
      expect(await checkpointQualificationRunnerIdentity(root, selection, environment, measure)).toBeNull();
      measure.mockReset().mockReturnValue(null);
      expect(await checkpointQualificationRunnerIdentity(root, selection, environment, measure)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('the actual production runGreen refuses an unreadable qualification before spawning a suite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-native-run-'));
    const saved = ['PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID', 'PAPERCUSP_GATE_VERDICT_WORKSPACE',
      'PAPERCUSP_GATE_VERDICT_HARNESS'].map(key => [key, process.env[key]] as const);
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { 'test:affected': 'node suite.mjs' } }));
      process.env.PAPERCUSP_CHECKPOINT_QUALIFICATION_ATTEMPT_ID = 'attempt';
      process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = 'w';
      process.env.PAPERCUSP_GATE_VERDICT_HARNESS = 'h';
      storedRead.mockResolvedValue({ status: 'unreadable' });
      const exec = vi.fn();
      const result = await realCheckpointDeps(releaseConfig({ checkpointRoot: root }), exec, 'run')
        .runGreen(root, 'base', { candidate: 'candidate' });
      expect(result).toMatchObject({ green: false, failingTests: ['qualification-native-preparation'] });
      expect(storedRead).toHaveBeenCalledWith({ workspaceId: 'w', installSlug: 'h' });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
      storedRead.mockReset();
    }
  });

  const setup = () => {
    const selectedSpecifications = [{ testFile: 'a.test.ts', pool: 'forks', projectName: null,
      testNamePattern: null, testIds: null, testTagsFilter: null, testLines: null }];
    const task = { id: 'ws :: test', workspace: 'ws', dir: '.', command: 'vitest run', runner: 'vitest',
      files: ['a.test.ts'], selectedSpecifications, lifecycleCommands: [], commandObligations: [] };
    const selection = { schemaVersion: 1, kind: 'full-gate', phase: 'selection-preparation', executed: false,
      tasks: [task], taskInventory: [{ id: task.id, dir: task.dir, command: task.command }],
      files: task.files, unenumerated: [], commandObligations: [], overlaps: [] };
    const prepared = preparePartialContinuationManifest({ root: progress.root, tasks: selection.taskInventory,
      selection, postSuite: postSuiteContinuationPopulation() });
    expect(prepared.status).toBe('ready');
    const transaction = { attemptId: progress.attemptId, candidate: progress.candidate,
      repairHead: progress.repairHead, runId: progress.runId,
      currentPhysicalRunner: { id: progress.runnerId, pidIdentity: progress.pidIdentity },
      continuation: { schemaVersion: 1, attemptId: progress.attemptId, candidate: progress.candidate,
        repairHead: progress.repairHead, root: progress.root, taskKey: progress.taskKey,
        manifest: prepared.manifest, retryStates: [], receipts: [], supersededReceipts: [] } };
    const read = vi.fn().mockResolvedValue({ status: 'present', transaction });
    const record = vi.fn().mockResolvedValue({ status: 'idempotent', transaction });
    const recover = vi.fn().mockResolvedValue({ status: 'idempotent', transaction });
    const observe = vi.fn().mockReturnValue(fixture().observer);
    const deps = { read, record, recover, observe, pidIdentity: () => progress.pidIdentity,
      runnerIdentity: () => progress.runnerIdentity, classify: vi.fn().mockResolvedValue(vi.fn()) };
    const select = vi.fn().mockResolvedValue(selection);
    const input = { target: { workspaceId: 'w', installSlug: 'h' }, attemptId: progress.attemptId,
      candidate: progress.candidate, runId: progress.runId, root: progress.root, select };
    return { selection, transaction, deps, input };
  };

  it('checks the independent full population and awaits current custody before observing a suite', async () => {
    const { deps, input, transaction } = setup();
    let release!: () => void;
    deps.record.mockImplementation(() => new Promise(resolve => { release = () => resolve({ status: 'idempotent',
      transaction }); }));
    const pending = prepareCheckpointQualificationNativeRun(input, deps);
    await vi.waitFor(() => expect(deps.record).toHaveBeenCalledTimes(1));
    expect(deps.observe).not.toHaveBeenCalled();
    release();
    expect(await pending).toMatchObject({ status: 'ready' });
    expect(deps.observe).toHaveBeenCalledWith(expect.objectContaining({
      tasks: new Map([['ws :: test', expect.objectContaining({ workspaceName: 'ws',
        selectedSpecifications: expect.arrayContaining([expect.objectContaining({ testFile: 'a.test.ts' })]) })]]),
    }));
  });

  it('does no selection or enrollment for an unfrozen legacy attempt', async () => {
    const { deps, input, transaction } = setup();
    deps.read.mockResolvedValue({ status: 'present', transaction: { ...transaction, continuation: undefined } });
    expect(await prepareCheckpointQualificationNativeRun(input, deps)).toEqual({ status: 'legacy' });
    expect(input.select).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'banked-file', 'banked-step', 'banked-all-files', 'invalidated-file'])(
    'independently maps each original npm step while retaining command and post obligations: %s', async scenario => {
    const { deps, input, selection, transaction } = setup();
    const root = mkdtempSync(join(tmpdir(), 'checkpoint-native-channels-'));
    try {
      const scripts = { test: 'npm run first && npm run second',
        first: `vitest run a.test.ts${scenario === 'banked-step' || scenario === 'banked-all-files' ? ' --passWithNoTests' : ''}`,
        second: `vitest run b.test.ts${scenario === 'banked-all-files' ? ' --passWithNoTests' : ''}` };
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', scripts }));
      const previous = selection.tasks[0]!;
      const steps = ['first', 'second'].map((script, index) => {
        const command = scripts[script as 'first' | 'second'], file = `${index ? 'b' : 'a'}.test.ts`;
        return { script, command, files: [file], commandObligations: [], unenumerated: [],
          discovery: [{ runner: 'vitest', command, files: [file], commandObligations: [], lifecycleCommands: [],
            selectedSpecifications: [{ ...previous.selectedSpecifications[0], testFile: file }] }] };
      });
      if (!['fresh', 'banked-step', 'banked-all-files'].includes(scenario)) {
        steps[0]!.files.push('remaining.test.ts');
        steps[0]!.discovery[0]!.files.push('remaining.test.ts');
        steps[0]!.discovery[0]!.selectedSpecifications.push({ ...previous.selectedSpecifications[0],
          testFile: 'remaining.test.ts' });
      }
      Object.assign(previous, { command: scripts.test, runner: 'command-chain', script: 'test', steps,
        files: steps.flatMap(step => step.files) });
      selection.files = previous.files;
      selection.taskInventory[0]!.command = scripts.test;
      Object.assign(selection, { invocations: [{ task: 'ws :: test', cwd: root, argv: ['npm', 'run', 'test'] }] });
      input.root = root;
      transaction.continuation.root = root;
      const prepared = preparePartialContinuationManifest({ root, selection,
        tasks: selection.taskInventory, postSuite: postSuiteContinuationPopulation() });
      expect(prepared.status, prepared.reason ?? undefined).toBe('ready');
      const manifest = prepared.manifest!;
      transaction.continuation.manifest = manifest;
      const receipts = scenario === 'fresh' ? [] : [{ unitId: 'test:a.test.ts', completionId: 'prior-pass',
        state: 'pass', observedAtMs: 1, worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass',
        proof: { recordedSha: input.candidate, executedModules: ['a.test.ts'], readPaths: [],
          inputsCaptured: true, opaqueReasons: scenario === 'invalidated-file' ? ['unmeasured-input'] : [],
          runContext: progress.runContext, runnerIdentity: progress.runnerIdentity } }];
      if (scenario === 'banked-all-files') receipts.push({ ...receipts[0]!, unitId: 'test:b.test.ts',
        completionId: 'prior-second-pass', proof: { ...receipts[0]!.proof, executedModules: ['b.test.ts'] } });
      Object.assign(transaction.continuation, { receipts });
      expect(await prepareCheckpointQualificationNativeRun(input, deps)).toMatchObject({ status: 'ready',
        checkpoint: { continuation: { manifest, receipts } } });
      const expectedTasks = new Map([
        ['ws :: test:step:0', { workspaceName: 'ws', selectedSpecifications: steps[0]!.discovery[0]!.selectedSpecifications
          .filter(spec => scenario !== 'banked-file' || spec.testFile !== 'a.test.ts'),
          supersedesCompletionIds: scenario === 'invalidated-file' ? { 'test:a.test.ts': 'prior-pass' } : {} }],
        ['ws :: test:step:1', { workspaceName: 'ws', selectedSpecifications: steps[1]!.discovery[0]!.selectedSpecifications,
          supersedesCompletionIds: {} }],
      ]);
      if (scenario === 'banked-step' || scenario === 'banked-all-files') expectedTasks.delete('ws :: test:step:0');
      if (scenario === 'banked-all-files') expectedTasks.delete('ws :: test:step:1');
      expect(deps.observe).toHaveBeenCalledWith(expect.objectContaining({ tasks: expectedTasks }));
      expect(manifest.units.some((unit: { id: string }) => unit.id === 'chain:ws :: test')).toBe(true);
      expect(manifest.units.some((unit: { kind: string }) => unit.kind === 'post-suite')).toBe(true);
      expect(steps[0]!.files).toContain('a.test.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('narrows a native producer to unfinished files while exporting the full bank for the child', async () => {
    const { deps, input, selection, transaction } = setup();
    const second = { ...selection.tasks[0]!.selectedSpecifications[0], testFile: 'b.test.ts' };
    selection.tasks[0]!.files.push('b.test.ts');
    selection.tasks[0]!.selectedSpecifications.push(second);
    const manifest = preparePartialContinuationManifest({ root: input.root, selection,
      tasks: selection.taskInventory, postSuite: postSuiteContinuationPopulation() }).manifest!;
    transaction.continuation.manifest = manifest;
    Object.assign(transaction.continuation, { receipts: [{ unitId: 'test:a.test.ts', completionId: 'prior-pass',
      state: 'pass', observedAtMs: 1, worktreeDirty: false, observedCount: 1, firstAttemptVerdict: 'pass',
      proof: { recordedSha: input.candidate, executedModules: ['a.test.ts'], readPaths: [],
        inputsCaptured: true, opaqueReasons: [], runContext: progress.runContext, runnerIdentity: progress.runnerIdentity } }] });
    const result = await prepareCheckpointQualificationNativeRun(input, deps);
    expect(result).toMatchObject({ status: 'ready', checkpoint: {
      selectedFiles: ['a.test.ts', 'b.test.ts'], continuation: { manifest,
        receipts: [expect.objectContaining({ completionId: 'prior-pass' })] } } });
    expect(deps.observe).toHaveBeenCalledWith(expect.objectContaining({ tasks: new Map([['ws :: test',
      { workspaceName: 'ws', selectedSpecifications: [second], supersedesCompletionIds: {} }]]) }));
    expect(selection.tasks[0]!.files).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it.each(['none', 'unreadable', 'stolen-custody', 'changed-population', 'custody-conflict', 'retained-failure'])(
    'refuses %s before any native suite observer can be installed', async kind => {
      const { deps, input, selection, transaction } = setup();
      if (kind === 'none' || kind === 'unreadable') deps.read.mockResolvedValue({ status: kind });
      if (kind === 'stolen-custody') deps.pidIdentity = () => 'other';
      if (kind === 'changed-population') selection.tasks[0]!.files = ['foreign.test.ts'];
      if (kind === 'custody-conflict') deps.record.mockResolvedValue({ status: 'conflict', transaction });
      if (kind === 'retained-failure') Object.assign(transaction.continuation, { receipts: [{
        unitId: 'test:a.test.ts', completionId: 'failed', state: 'fail', observedAtMs: 1,
      }] });
      expect(await prepareCheckpointQualificationNativeRun(input, deps)).toMatchObject({ status: 'refused' });
      expect(deps.observe).not.toHaveBeenCalled();
    });

  it('refuses recovery of an enrolled corrupt artifact before executing more work', async () => {
    const { deps, input, transaction } = setup();
    Object.assign(transaction.continuation, { nativeProducers: [{ path: '/out/prior' }] });
    deps.recover.mockResolvedValue({ status: 'conflict', transaction });
    expect(await prepareCheckpointQualificationNativeRun(input, deps)).toMatchObject({ status: 'refused' });
    expect(deps.recover).toHaveBeenCalledWith(input.target, expect.objectContaining({ updates: [] }),
      expect.any(Function), { recoverMissingSnapshots: true });
    expect(deps.observe).not.toHaveBeenCalled();
  });
});

describe('the production green barrier before promotion', () => {
  const setup = () => {
    const transaction = { attemptId: progress.attemptId, candidate: progress.candidate,
      repairHead: progress.repairHead, runId: progress.runId,
      currentPhysicalRunner: { id: progress.runnerId, pidIdentity: progress.pidIdentity },
      continuation: { root: progress.root, taskKey: progress.taskKey,
        manifest: progress.manifest, retryStates: progress.retryStates } };
    const read = vi.fn().mockResolvedValue({ status: 'present', transaction });
    const compose = vi.fn().mockResolvedValue({ status: 'idempotent', transaction });
    const classifier = vi.fn();
    const deps = { read, compose, pidIdentity: () => progress.pidIdentity,
      runnerIdentity: () => progress.runnerIdentity, classify: vi.fn(() => classifier) };
    const input = { target: { workspaceId: 'w', installSlug: 'h' }, attemptId: progress.attemptId,
      candidate: progress.candidate, runId: progress.runId, root: progress.root };
    return { transaction, read, compose, deps, input, classifier };
  };

  it('awaits the row composer with the current fence and maintained input classifier', async () => {
    const { deps, input, compose, classifier } = setup();
    let release!: () => void;
    compose.mockImplementation(() => new Promise(resolve => { release = () => resolve({ status: 'idempotent' }); }));
    const ready = composeCheckpointQualificationBeforePromotion(input, deps);
    await vi.waitFor(() => expect(compose).toHaveBeenCalledWith(input.target, progress, {
      classifyReadPaths: classifier, currentCommandDefinition: expect.any(Function) }));
    release();
    expect(await ready).toEqual({ status: 'ready' });
  });

  it.each(['none', 'unreadable'])('refuses an %s row instead of falling back to child exit zero', async status => {
    const { deps, input, read, compose } = setup();
    read.mockResolvedValue({ status });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toMatchObject({ status: 'refused' });
    expect(compose).not.toHaveBeenCalled();
  });

  it.each(['attemptId', 'candidate', 'runId'])('refuses a different %s', async key => {
    const { deps, input, transaction, compose } = setup();
    Object.assign(transaction, { [key]: 'other' });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toMatchObject({ status: 'refused' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('preserves a legacy attempt only when no continuation was frozen', async () => {
    const { deps, input, read, transaction, compose } = setup();
    read.mockResolvedValue({ status: 'present', transaction: { ...transaction, continuation: undefined } });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toEqual({ status: 'legacy' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('refuses stolen custody and a missing post-suite proof', async () => {
    const { deps, input, compose } = setup();
    expect(await composeCheckpointQualificationBeforePromotion(input, { ...deps, pidIdentity: () => 'other' }))
      .toMatchObject({ status: 'refused', reason: 'qualification-runner-fence-mismatch' });
    expect(compose).not.toHaveBeenCalled();
    compose.mockResolvedValue({ status: 'conflict', refusalReason: 'continuation-verdict-not-green' });
    expect(await composeCheckpointQualificationBeforePromotion(input, deps)).toEqual({ status: 'refused',
      reason: 'qualification-composition-conflict:continuation-verdict-not-green' });
  });
});

describe('native output adoption on the qualification host', () => {
  it('waits for durable enrollment before recovering native artifacts, across chunks and streams', async () => {
    const { observer, enroll, recover, tasks } = fixture();
    let release!: () => void;
    enroll.mockImplementation(() => new Promise<void>(resolve => { release = resolve; })
      .then(() => ({ status: 'updated', transaction: {} })));
    const line = announcement();
    observer.onOutput('stdout', line.slice(0, 30));
    observer.onOutput('stderr', 'diagnostic\n');
    observer.onOutput('stdout', line.slice(30) + '\n');
    // A caller mutation must not replace the independently prepared selection.
    tasks.get('ws :: test')!.selectedSpecifications[0]!.testFile = 'foreign.test.ts';
    const result = observer.finish();
    await Promise.resolve();
    expect(enroll).toHaveBeenCalledWith({ workspaceId: 'w', installSlug: 'h' }, progress, {
      taskKey: 'ws :: test', workspaceName: 'ws', selectedSpecifications: [{ testFile: 'a.test.ts' }],
      producerPath: '/out/a.producer.json', path: '/out/a',
    });
    expect(recover).not.toHaveBeenCalled();
    release();
    expect(await result).toMatchObject({ status: 'ready', transaction: { attemptId: 'attempt' } });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(observer.finish()).toBe(result);
  });

  it('coalesces repeated announcements and accepts the final unterminated line', async () => {
    const { observer, enroll } = fixture();
    observer.onOutput('stdout', announcement() + '\n' + announcement());
    expect(await observer.finish()).toMatchObject({ status: 'ready' });
    expect(enroll).toHaveBeenCalledTimes(1);
  });

  it('refuses a second producer for the same physical task instead of growing an unbounded queue', async () => {
    const { observer, recover } = fixture();
    observer.onOutput('stdout', announcement() + '\n' + announcement('ws :: test', '/out/other.producer.json') + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-announcement-conflict' });
    expect(recover).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'QUALIFICATION_NATIVE_PRODUCER task=broken path="/out/a.producer.json"'],
    ['child refusal', 'QUALIFICATION_NATIVE_PRODUCER_REFUSED task="ws :: test" reason="unknown"'],
    ['foreign task', announcement('foreign :: test')],
    ['relative artifact', announcement('ws :: test', 'relative.producer.json')],
    ['wrong artifact', announcement('ws :: test', '/out/a.json')],
  ])('refuses %s without recovering banked outcomes', async (_name, text) => {
    const { observer, enroll, recover } = fixture();
    observer.onOutput('stdout', text + '\n');
    expect(await observer.finish()).toMatchObject({ status: 'refused' });
    expect(enroll).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('never recovers or falls back to stored passes after an enrollment fence conflict', async () => {
    const { observer, enroll, recover } = fixture();
    enroll.mockResolvedValue({ status: 'conflict', refusalReason: 'runner-fence-mismatch' });
    observer.onOutput('stdout', announcement() + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-enrollment-conflict' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('rechecks earlier enrolled artifacts even when no new producer is announced', async () => {
    const { observer, recover } = fixture();
    recover.mockResolvedValue({ status: 'conflict', refusalReason: 'snapshot-integrity-mismatch' });
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-recovery-conflict' });
  });

  it('retains asynchronous storage failures as refusal rather than an unhandled observer error', async () => {
    const { observer, enroll, recover } = fixture();
    enroll.mockRejectedValue(new Error('database unavailable'));
    observer.onOutput('stdout', announcement() + '\n');
    expect(await observer.finish()).toEqual({ status: 'refused', reason: 'native-producer-enrollment-unreadable' });
    expect(recover).not.toHaveBeenCalled();
  });

  it('bounds diagnostic fragments without accepting an embedded marker as a new line', async () => {
    const { observer, enroll } = fixture();
    observer.onOutput('stdout', 'x'.repeat(20_000));
    observer.onOutput('stdout', announcement() + '\n' + announcement() + '\n');
    expect(await observer.finish()).toMatchObject({ status: 'ready' });
    expect(enroll).toHaveBeenCalledTimes(1);
  });
});
