import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import type { managedSpawn } from '../task-manager/managed-spawn';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_PRECHECK_WORKER_MODE_ENV,
  ADMISSION_TEST_ENVIRONMENT,
  admissionPrecheckProgressTransition,
  admissionPrecheckSettlementTransition,
  admissionPrecheckMeasurementIdentity,
  buildAdmissionPrecheckSpawnPlan,
  parseAdmissionPrecheckWorkerInput,
  runAdmissionPrecheckWorker,
  startAdmissionPrecheckWorker,
  type AdmissionPrecheckWorkerInput,
} from './admission-fix-precheck-managed';
import { ADMISSION_PRECHECK_MAX_FILES, admissionPrecheckFileConcurrency, type FixPrecheckRunner } from './admission-fix-precheck';
import type { FrozenCandidateRepairQueue, FrozenRepairAdmissionPrecheck } from './frozen-candidate-repair-queue';

const operation = (overrides: Partial<FrozenRepairAdmissionPrecheck> = {}): FrozenRepairAdmissionPrecheck => ({
  schemaVersion: 1,
  operationId: 'repair-precheck-1',
  status: 'running',
  candidate: 'a'.repeat(40),
  repairHead: 'b'.repeat(40),
  builtCommit: 'c'.repeat(40),
  builtTree: 'd'.repeat(40),
  testEnvironment: ADMISSION_TEST_ENVIRONMENT,
  files: ['lib/red.test.ts'],
  actor: 'su-test',
  runnerPid: 100,
  runnerPidIdentity: 'boot:100',
  runnerTaskId: 'task123456',
  startedAtMs: 10,
  updatedAtMs: 10,
  expiresAtMs: 60_000,
  currentFile: 'lib/red.test.ts',
  completedCount: 0,
  totalCount: 1,
  heartbeatAtMs: 10,
  ...overrides,
});

const queue = (precheck = operation()): FrozenCandidateRepairQueue => ({
  schemaVersion: 4,
  phase: 'awaiting-fixer',
  candidate: 'a'.repeat(40),
  base: 'e'.repeat(40),
  repairHead: 'b'.repeat(40),
  worktreePath: '/tmp/repair',
  attempts: 0,
  openedAtMs: 1,
  updatedAtMs: 10,
  fixerSpawnId: null,
  failingTests: ['lib/red.test.ts'],
  signature: [{ kind: 'test-file', id: 'lib/red.test.ts', recipe: 'test:file', admittedRound: 1, measuredHead: 'b'.repeat(40) }],
  admissions: [],
  admissionPrecheck: precheck,
} as unknown as FrozenCandidateRepairQueue);

const input: AdmissionPrecheckWorkerInput = {
  operationId: 'repair-precheck-1',
  taskId: 'task123456',
  queueTarget: { workspaceId: 'workspace-1', installSlug: 'papercusp' },
  integrationRoot: '/repo',
  checkpointRoot: '/repo-checkpoint',
  expiresAtMs: 60_000,
};

describe('managed R6 admission pre-check runner (WI-10006003)', () => {
  it('does not identify old shared-PG evidence as the private fixture measurement', () => {
    const current = operation();
    const legacy = { ...current, testEnvironment: undefined };
    expect(admissionPrecheckMeasurementIdentity(current, [])).not.toBe(admissionPrecheckMeasurementIdentity(legacy, []));
  });

  it('keeps the identity across a Postgres jsonb key-order round trip (EI-27114233692780034)', () => {
    const radius = { status: 'measured', reason: 'ok', guarded: ['lib/guard-0.test.ts'], reportOnly: [],
      legs: { 'lib/red.test.ts': '@t/core', 'lib/guard-0.test.ts': '@t/core' } };
    const current = operation({ files: ['lib/red.test.ts', 'lib/guard-0.test.ts'],
      sourceCommit: 'e'.repeat(40), radius } as Partial<FrozenRepairAdmissionPrecheck>);
    // jsonb stores object keys ordered by length, then bytes.
    const jsonbKeyOrder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(jsonbKeyOrder);
      if (value === null || typeof value !== 'object') return value;
      const keys = Object.keys(value).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(keys.map(key => [key, jsonbKeyOrder((value as Record<string, unknown>)[key])]));
    };
    const readBack = jsonbKeyOrder(JSON.parse(JSON.stringify(current))) as FrozenRepairAdmissionPrecheck;
    expect(JSON.stringify(readBack)).not.toBe(JSON.stringify(current));
    expect(admissionPrecheckMeasurementIdentity(readBack, [])).toBe(admissionPrecheckMeasurementIdentity(current, []));
    // A real radius change still changes the identity.
    const widened = { ...current, radius: { ...radius, guarded: [...radius.guarded, 'lib/guard-1.test.ts'] } } as FrozenRepairAdmissionPrecheck;
    expect(admissionPrecheckMeasurementIdentity(widened, [])).not.toBe(admissionPrecheckMeasurementIdentity(current, []));
  });

  describe('EI-27092183951452642: identity follows the judged classification, not verdict detail', () => {
    type Signature = FrozenCandidateRepairQueue['signature'];
    const entry = (fields: Record<string, unknown>) =>
      ({ recipe: 'test:file', admittedRound: 1, measuredHead: 'b'.repeat(40), ...fields });
    const base = [
      entry({ kind: 'test-file', id: 'lib/red.test.ts' }),
      entry({ kind: 'test-file', id: 'lib/other-red.test.ts' }),
      entry({ kind: 'workspace-task', id: '@t/core :: test' }),
    ] as unknown as Signature;

    it('keeps the identity when a verdict re-stamps, reorders and adds an id of a present non-test kind', () => {
      const restamped = [
        { ...base[2], measuredHead: 'f'.repeat(40), errors: ['exit 1'] },
        { ...base[1], measuredHead: 'f'.repeat(40), cases: ['re-measured case'] },
        { ...base[0], measuredHead: 'f'.repeat(40), admittedRound: 3 },
        entry({ kind: 'workspace-task', id: '@t/desktop :: test', admittedRound: 3, measuredHead: 'f'.repeat(40) }),
      ] as unknown as Signature;
      expect(admissionPrecheckMeasurementIdentity(operation(), restamped))
        .toBe(admissionPrecheckMeasurementIdentity(operation(), base));
    });

    it.each([
      ['a signature test file is dropped', (s: Signature) => s.filter(e => e.id !== 'lib/other-red.test.ts')],
      ['a signature test file is added', (s: Signature) => [...s, entry({ kind: 'test-file', id: 'lib/new-red.test.ts' })]],
      ['a new non-test kind appears', (s: Signature) => [...s, entry({ kind: 'lint-leg', id: 'lint:tsc' })]],
    ])('changes the identity when %s', (_label, mutate) => {
      expect(admissionPrecheckMeasurementIdentity(operation(), mutate(base) as Signature))
        .not.toBe(admissionPrecheckMeasurementIdentity(operation(), base));
    });

    it.each([
      ['re-stamps the same population: the pre-check completes', false],
      ['promotes a radius file into the signature: the pre-check stops', true],
    ])('a gate verdict written mid-run that %s', async (_label, reclassifies) => {
      let persisted = wide(41);
      let verdictWritten = false;
      const outcome = await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        now: () => 30,
        createRunner: () => async run => {
          const results = run.files.map(path => ({ path, status: 'pass' as const }));
          for (const result of results) {
            await run.onFileResult?.(result);
            if (verdictWritten) continue;
            verdictWritten = true;
            // The gate records its verdict: every entry re-stamped at the head it measured.
            persisted = { ...persisted, lastVerdictAtMs: 25, signature: [
              ...persisted.signature.map(e => ({ ...e, measuredHead: 'f'.repeat(40), cases: ['re-measured case'] })),
              ...(reclassifies ? [entry({ kind: 'test-file', id: 'lib/file-0.test.ts', admittedRound: 2 })] : []),
            ] } as unknown as FrozenCandidateRepairQueue;
          }
          return { ran: true, commit: run.commit, results };
        },
      });
      expect(verdictWritten).toBe(true);
      if (reclassifies) {
        expect(outcome).toMatchObject({ status: 'interrupted', reason: expect.stringContaining('identity changed') });
      } else {
        expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: true, ran: true } });
        expect(persisted.admissionPrecheck?.status).toBe('passed');
        expect(persisted.admissionPrecheck?.completedCount).toBe(41);
      }
    });
  });

  const wide = (size = 81) => {
    const files = ['lib/red.test.ts', ...Array.from({ length: size - 1 }, (_, i) => `lib/file-${i}.test.ts`)];
    return queue(operation({ files, totalCount: files.length, radius: { status: 'measured', reason: 'ok',
      guarded: files.slice(1), reportOnly: [], legs: Object.fromEntries(files.map(file => [file, '@t/core'])) } }));
  };

  const jsonbRoundTrip = (value: FrozenCandidateRepairQueue): FrozenCandidateRepairQueue =>
    JSON.parse(JSON.stringify(value, (_key, nested) =>
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)))
        : nested));

  it.each([false, true])('owns one fixture across groups and gates pass on cleanup (cleanup fails=%s)', async cleanupFails => {
    let persisted = wide();
    const output = vi.fn();
    let fixtureOutput: (() => void) | undefined;
    const stop = vi.fn(async () => { fixtureOutput?.(); if (cleanupFails) throw new Error('owned PG cleanup failed'); });
    const startTestEnvironment = vi.fn(async (_root: string, options: { onOutput?: () => void } = {}) => {
      fixtureOutput = options.onOutput;
      fixtureOutput?.();
      return { env: { PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private' }, assertRunning: vi.fn(), stop };
    });
    const work = runAdmissionPrecheckWorker(input, {
      startTestEnvironment,
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }), now: () => 30,
      transition: async (_target, update) => {
        const next = update(persisted);
        if (next.admissionPrecheck?.status === 'passed') expect(stop).toHaveBeenCalledTimes(1);
        persisted = next;
      },
      createRunner: options => async run => {
        expect(await options.prepareTestEnvironment?.('/pinned', output)).toEqual({ PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private' });
        return { ran: true, commit: run.commit, results: run.files.map(path => ({ path, status: 'pass' as const })) };
      },
    });
    if (cleanupFails) {
      await expect(work).resolves.toMatchObject({ status: 'settled', verdict: {
        ok: false, code: 'admission-precheck-unavailable', detail: expect.stringContaining('owned PG cleanup failed'),
      } });
      expect(persisted.admissionPrecheck?.status).toBe('failed');
    } else await expect(work).resolves.toMatchObject({ status: 'settled', verdict: { ok: true } });
    expect(startTestEnvironment).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledTimes(1);
  });

  it('aggregates JSONB-reordered native results across execution groups', async () => {
    let persisted = jsonbRoundTrip(wide(41));
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = jsonbRoundTrip(update(persisted)); },
      now: () => 30,
      createRunner: () => async run => {
        const results = run.files.map(path => ({ path, status: 'pass' as const, exitCode: 0, durationMs: 1, detail: 'native receipt' }));
        for (const result of results) await run.onFileResult?.(result);
        return { ran: true, commit: run.commit, results: results.map(result => ({
          detail: result.detail, durationMs: result.durationMs, exitCode: result.exitCode,
          status: result.status, path: result.path,
        })) };
      },
    });
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: true, ran: true } });
    expect(persisted.admissionPrecheck?.measurement?.results.map(result => result.path)).toEqual(persisted.admissionPrecheck?.files);
    expect(persisted.admissionPrecheck?.completedCount).toBe(41);
  });

  it('retains removed-test proof in the durable measurement identity and runs no deleted path', async () => {
    let persisted = queue(operation({
      files: ['lib/still-red.test.ts'],
      removedTestFiles: ['apps/operator/lib/deleted.test.ts', 'lib/deleted.test.ts'],
      totalCount: 1,
    }));
    persisted.signature = [{
      kind: 'test-file',
      id: 'lib/deleted.test.ts',
      recipe: 'test:file',
      admittedRound: 1,
      measuredHead: 'b'.repeat(40),
    }];
    const seen: string[][] = [];
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = jsonbRoundTrip(update(persisted)); },
      now: () => 30,
      createRunner: () => async run => {
        seen.push([...run.files]);
        const results = run.files.map(path => ({ path, status: 'pass' as const }));
        for (const result of results) await run.onFileResult?.(result);
        return { ran: true, commit: run.commit, results };
      },
    });
    expect(seen).toEqual([['lib/still-red.test.ts']]);
    expect(outcome).toMatchObject({
      status: 'settled',
      verdict: { ok: true, fixes: ['lib/deleted.test.ts'] },
    });
    expect(persisted.admissionPrecheck?.removedTestFiles).toEqual([
      'apps/operator/lib/deleted.test.ts',
      'lib/deleted.test.ts',
    ]);
  });

  it('refuses changed native results after a JSONB round trip', async () => {
    let persisted = jsonbRoundTrip(wide(41));
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = jsonbRoundTrip(update(persisted)); },
      now: () => 30,
      createRunner: () => async run => {
        const results = run.files.map(path => ({ path, status: 'pass' as const, exitCode: 0 }));
        for (const result of results) await run.onFileResult?.(result);
        return { ran: true, commit: run.commit, results: results.map((result, index) =>
          index === 0 ? { ...result, status: 'fail' as const, exitCode: 1 } : result) };
      },
    });
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: 'admission-precheck-unavailable' } });
    expect(persisted.admissionPrecheck?.status).toBe('failed');
  });

  it('refuses a final aggregate that contradicts a per-file callback in the same run', async () => {
    let persisted = wide(41);
    const unavailable = persisted.admissionPrecheck!.files[0]!;
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); },
      createRunner: () => async run => {
        const results = run.files.map(path => ({ path, status: 'pass' as const }));
        await run.onFileResult?.({ path: unavailable, status: 'unmeasured' });
        for (const result of results.filter(result => result.path !== unavailable))
          await run.onFileResult?.(result);
        return { ran: true, commit: run.commit, results };
      },
      now: () => 30,
    });
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: 'admission-precheck-unavailable' } });
    expect(persisted.admissionPrecheck!.measurement!.results.find(result => result.path === unavailable)?.status)
      .toBe('unmeasured');
  });

  it('bounds two-plus native groups without raising the existing cap and never passes a partial aggregate', async () => {
    let persisted = wide();
    const sizes: number[] = [];
    const runner: FixPrecheckRunner = async run => {
      expect(persisted.admissionPrecheck?.status).toBe('running');
      expect(run.expectedTree).toBe('d'.repeat(40));
      sizes.push(run.files.length);
      const results = run.files.map(path => ({ path, status: 'pass' as const }));
      for (const result of results) await run.onFileResult?.(result);
      expect(persisted.admissionPrecheck?.status).toBe('running');
      return { ran: true, commit: run.commit, results };
    };
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }), readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); }, createRunner: () => runner, now: () => 30,
    });
    expect(ADMISSION_PRECHECK_MAX_FILES).toBe(200);
    expect(sizes).toEqual([40, 40, 1]);
    expect(sizes.every(size => size <= ADMISSION_PRECHECK_MAX_FILES)).toBe(true);
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: true, ran: true } });
    expect(persisted.admissionPrecheck?.measurement?.results.map(result => result.path)).toEqual(persisted.admissionPrecheck?.files);
    expect(persisted.admissionPrecheck?.completedCount).toBe(81);
  });

  it('settles a gate run taking the checkpoint tree between groups as a DEFERRAL, keeping completed rows (WI-6554700010030460)', async () => {
    let persisted = wide();
    persisted = { ...persisted, dispatchReservation: { token: input.operationId, claimedAtMs: 1, expiresAtMs: 10_000_000 } } as unknown as FrozenCandidateRepairQueue;
    let calls = 0;
    const busyOnSecondGroup: FixPrecheckRunner = async run => {
      if (++calls === 2) return { ran: false, reason: 'checkpoint-tree-busy',
        detail: 'a green-checkpoint run holds the checkpoint tree (pid 7, 30s in)', holder: { pid: 7, elapsedSec: 30 } };
      const results = run.files.map(path => ({ path, status: 'pass' as const }));
      for (const result of results) await run.onFileResult?.(result);
      return { ran: true, commit: run.commit, results };
    };
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running' as const, confined: true }),
      readQueue: async () => ({ status: 'value' as const, queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); },
      createRunner: () => busyOnSecondGroup, now: () => 30,
    });
    // Nothing ran in the busy group, so this is a deferral with the runner's own reason, never the
    // runner-failed label that sent callers into retryPrecheck loops while the suite held the tree.
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: true, ran: false, reason: 'checkpoint-tree-busy' } });
    expect(persisted.admissionPrecheck).toMatchObject({ status: 'deferred', completedCount: 40,
      verdict: { reason: 'checkpoint-tree-busy', holder: { pid: 7, elapsedSec: 30 } } });
    expect(persisted.admissionPrecheck!.measurement!.results).toHaveLength(40);
    expect(persisted.dispatchReservation).toBeUndefined();
  });

  it.each(['fail', 'unmeasured'] as const)('retains measured fail and retries unmeasured rows across replacement (%s)', async status => {
    let persisted = wide();
    // WI-6554700010030199: the interrupted worker must release the gate's dispatch reservation itself.
    persisted = { ...persisted, dispatchReservation: { token: input.operationId, claimedAtMs: 1, expiresAtMs: 10_000_000 } } as unknown as FrozenCandidateRepairQueue;
    const originalFiles = [...persisted.admissionPrecheck!.files];
    let calls = 0;
    const interrupted: FixPrecheckRunner = async run => {
      if (++calls === 2) throw new Error('simulated worker death');
      const results = run.files.map((path, i) => ({ path, status: i === 1 ? status : 'pass' as const }));
      for (const result of results) await run.onFileResult?.(result);
      return { ran: true, commit: run.commit, results };
    };
    const deps = { getTask: async () => ({ state: 'running' as const, confined: true }),
      readQueue: async () => ({ status: 'value' as const, queue: persisted }),
      transition: async (_target: unknown, update: (q: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue) => { persisted = update(persisted); }, now: () => 30 };
    // The interruption settles at once (runner-failed, fail-closed) instead of leaving a 'running'
    // operation whose reservation fences the gate until an unrelated status read notices it.
    expect(await runAdmissionPrecheckWorker(input, { ...deps, createRunner: () => interrupted })).toMatchObject({
      status: 'settled', verdict: { ok: false, ran: false, reason: 'runner-failed', detail: expect.stringContaining('simulated worker death') } });
    expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', completedCount: status === 'unmeasured' ? 39 : 40 });
    expect(persisted.admissionPrecheck!.measurement!.results).toHaveLength(40);
    expect(persisted.dispatchReservation).toBeUndefined();
    // retryPrecheck:true resumes the SAME operation: running again, verdict cleared, new task id
    // (the shape repair-queue.ts builds from a runner-failed precheck).
    const saved = JSON.parse(JSON.stringify(persisted));
    persisted = saved;
    persisted.admissionPrecheck = { ...persisted.admissionPrecheck!, status: 'running', verdict: undefined, runnerTaskId: 'replacement-task' };
    const resumed: string[] = [];
    const baseline: string[] = [];
    const outcome = await runAdmissionPrecheckWorker({ ...input, taskId: 'replacement-task' }, { ...deps, createRunner: options => async run => {
      (options.precheckRootSuffix ? baseline : resumed).push(...run.files);
      // The resume never re-measures the retained file; only the labelled EI-27083585698781986
      // confirmation re-run reaches it, and there it reproduces — a real red, still attributed.
      return { ran: true, commit: run.commit, results: run.files.map(path =>
        ({ path, status: !options.precheckRootSuffix && path === originalFiles[1] ? status : 'pass' as const })) };
    } });
    expect(resumed).toEqual(status === 'fail'
      ? [...originalFiles.slice(40), originalFiles[1]]
      : [originalFiles[1], ...originalFiles.slice(40)]);
    // D-004: only a retained FAIL is paired with a previous-head measurement; it passed there.
    expect(baseline).toEqual(status === 'fail' ? [originalFiles[1]] : []);
    expect(persisted.admissionPrecheck!.files).toEqual(originalFiles);
    expect(persisted.admissionPrecheck!.measurement!.results[1]!.status).toBe(status);
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: status === 'fail' ? 'admission-imports-red' : 'admission-precheck-unavailable' } });
  });

  it('retries only unavailable rows while preserving paired evidence for measured reds', async () => {
    let persisted = wide(41);
    const operation = persisted.admissionPrecheck!;
    const redFile = operation.files[1]!;
    const unavailableFile = operation.files.at(-1)!;
    const results = operation.files.map(path => ({
      path,
      status: path === redFile ? 'fail' as const : path === unavailableFile ? 'unmeasured' as const : 'pass' as const,
    }));
    const previousHead = { commit: operation.repairHead, results: [{ path: redFile, status: 'pass' as const }] };
    const confirmation = { commit: operation.builtCommit, results: [{ path: redFile, status: 'unmeasured' as const }] };
    const identity = admissionPrecheckMeasurementIdentity(operation, persisted.signature);
    persisted = { ...persisted, admissionPrecheck: { ...operation, status: 'running',
      measurement: { schemaVersion: 1, identity, results, previousHead, confirmation } } };
    const calls: Array<{ commit: string; files: string[]; baseline: boolean }> = [];
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); },
      createRunner: options => async run => {
        calls.push({ commit: run.commit, files: [...run.files], baseline: Boolean(options.precheckRootSuffix) });
        const next = run.files.map(path => ({ path, status: path === redFile ? 'fail' as const : 'pass' as const }));
        for (const result of next) await run.onFileResult?.(result);
        return { ran: true, commit: run.commit, results: next };
      },
      now: () => 30,
    });
    expect(calls).toEqual([
      { commit: operation.builtCommit, files: [unavailableFile], baseline: false },
      { commit: operation.builtCommit, files: [redFile], baseline: false },
    ]);
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: 'admission-imports-red' } });
    expect(persisted.admissionPrecheck!.measurement!.results.find(result => result.path === redFile)).toEqual({
      path: redFile, status: 'fail',
    });
    expect(persisted.admissionPrecheck!.measurement!.previousHead).toEqual(previousHead);
    expect(persisted.admissionPrecheck!.measurement!.confirmation).toEqual({
      commit: operation.builtCommit, results: [{ path: redFile, status: 'fail' }],
    });
  });

  it.each(['commit', 'tree', 'population', 'partition'] as const)('refuses saved evidence under changed %s identity', async change => {
    let persisted = wide();
    const op = persisted.admissionPrecheck!;
    op.measurement = { schemaVersion: 1, identity: admissionPrecheckMeasurementIdentity(op, persisted.signature), results: [{ path: op.files[0]!, status: 'pass' }] };
    if (change === 'commit') op.builtCommit = 'f'.repeat(40);
    if (change === 'tree') op.builtTree = 'f'.repeat(40);
    if (change === 'population') op.files = [...op.files].reverse();
    if (change === 'partition') op.radius!.reportOnly = [...op.radius!.guarded.splice(0, 1)];
    const runner = vi.fn();
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }), readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); }, createRunner: () => runner, now: () => 30,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: 'admission-precheck-unavailable' } });
  });

  it.each(['missing', 'duplicate', 'foreign', 'skipped', 'stale'] as const)('refuses %s group evidence before terminal pass', async fault => {
    let persisted = wide(41);
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }), readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); }, now: () => 30,
      createRunner: () => async run => {
        const results = run.files.map(path => ({ path, status: 'pass' as const }));
        if (fault === 'missing') results.pop();
        if (fault === 'duplicate') results[1] = results[0]!;
        if (fault === 'foreign') results[0] = { path: 'foreign.test.ts', status: 'pass' };
        if (fault === 'skipped') (results[0] as { status: string }).status = 'skip';
        return { ran: true, commit: fault === 'stale' ? '0'.repeat(40) : run.commit, results };
      },
    });
    expect(outcome).toMatchObject({ status: 'settled', verdict: { ok: false, code: 'admission-precheck-unavailable' } });
    expect(persisted.admissionPrecheck?.status).toBe('failed');
  });

  it('a concurrent immutable identity change cannot be overwritten by a stale worker', async () => {
    let persisted = wide(41);
    const outcome = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }), readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); }, now: () => 30,
      createRunner: () => async run => {
        persisted = { ...persisted, admissionPrecheck: { ...persisted.admissionPrecheck!, builtTree: 'e'.repeat(40) } };
        await run.onFileResult?.({ path: run.files[0]!, status: 'pass' });
        throw new Error('must not reach publication');
      },
    });
    expect(outcome.status).toBe('interrupted');
    expect(persisted.admissionPrecheck).toMatchObject({ status: 'running', builtTree: 'e'.repeat(40), measurement: { results: [] } });
  });

  it('hands a proposal to the confined worker without reading or mutating admission state', async () => {
    const proposalInput = { ...input, proposal: { candidate: 'a'.repeat(40), repairHead: 'b'.repeat(40) } };
    const runProposal = vi.fn(async () => undefined);
    const readQueue = vi.fn();
    const transition = vi.fn();
    const createRunner = vi.fn();
    expect(await runAdmissionPrecheckWorker(proposalInput, {
      getTask: async () => ({ state: 'running', confined: true }), runProposal,
      readQueue, transition, createRunner,
    })).toEqual({ status: 'proposed' });
    expect(runProposal).toHaveBeenCalledWith(proposalInput);
    expect(readQueue).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(createRunner).not.toHaveBeenCalled();
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify(proposalInput))).toEqual(proposalInput);
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify({ ...proposalInput, proposal: { candidate: 'invalid', repairHead: 'b'.repeat(40) } }))).toBeNull();
  });

  it('retains actual worker stdout and startup stderr after the launching descriptor closes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-worker-log-'));
    let fd = -1;
    const launch = vi.fn(async (...args: Parameters<typeof managedSpawn>) => {
      const [, , spec, options] = args;
      fd = (options?.spawnOptions?.stdio as ['ignore', number, number])[1];
      expect(spec.logPath).toBe(join(root, `admission-precheck-worker-${input.taskId}.log`));
      const child = spawn(process.execPath, ['-e', 'console.log("worker stdout"); console.error("startup failure marker"); process.exitCode = 1'], {
        stdio: options?.spawnOptions?.stdio,
      });
      return { child } as Awaited<ReturnType<typeof managedSpawn>>;
    });
    try {
      const result = await startAdmissionPrecheckWorker(input, {
        spawn: launch, logDir: root, spawnPlan: { cmd: '/node', args: ['/worker'], env: {}, mode: 'bundled-reexec' },
      });
      expect(() => writeSync(fd, 'leaked descriptor')).toThrow();
      const [code] = await once(result.child, 'close');
      expect(code).toBe(1);
      const output = readFileSync(join(root, `admission-precheck-worker-${input.taskId}.log`), 'utf8');
      expect(output).toContain('worker stdout');
      expect(output).toContain('startup failure marker');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['dev-tsx', 'bundled-reexec'] as const)('starts an independent %s worker without a desktop parent lifetime', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-worker-parent-'));
    const previousParent = process.env.PAPERCUSP_DESKTOP_PARENT_PID;
    process.env.PAPERCUSP_DESKTOP_PARENT_PID = '101';
    const launch = vi.fn(async (...args: Parameters<typeof managedSpawn>) => {
      const [, , spec, options] = args;
      expect(spec.class).toBe('test-run');
      const child = spawn(process.execPath, ['-e', `console.log(JSON.stringify({
        parent: process.env.PAPERCUSP_DESKTOP_PARENT_PID ?? null,
        taskId: JSON.parse(process.env.PAPERCUSP_REPAIR_PRECHECK_WORKER_INPUT).taskId,
      }))`], { env: options?.spawnOptions?.env, stdio: options?.spawnOptions?.stdio });
      return { child } as Awaited<ReturnType<typeof managedSpawn>>;
    });
    try {
      const result = await startAdmissionPrecheckWorker(input, {
        spawn: launch, logDir: root,
        spawnPlan: { cmd: '/node', args: ['/worker'], env: { PAPERCUSP_DESKTOP_PARENT_PID: '202' }, mode },
      });
      const [code] = await once(result.child, 'close');
      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(join(root, `admission-precheck-worker-${input.taskId}.log`), 'utf8')))
        .toEqual({ parent: null, taskId: input.taskId });
    } finally {
      if (previousParent === undefined) delete process.env.PAPERCUSP_DESKTOP_PARENT_PID;
      else process.env.PAPERCUSP_DESKTOP_PARENT_PID = previousParent;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('logs a scope launch rejection and closes the descriptor before rethrowing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'precheck-scope-log-'));
    let fd = -1;
    const launch = vi.fn(async (...args: Parameters<typeof managedSpawn>): Promise<Awaited<ReturnType<typeof managedSpawn>>> => {
      fd = (args[3]?.spawnOptions?.stdio as ['ignore', number, number])[2];
      throw new Error('scope launch rejected');
    });
    try {
      await expect(startAdmissionPrecheckWorker(input, {
        spawn: launch, logDir: root, spawnPlan: { cmd: '/node', args: ['/worker'], env: {}, mode: 'bundled-reexec' },
      })).rejects.toThrow('scope launch rejected');
      expect(readFileSync(join(root, `admission-precheck-worker-${input.taskId}.log`), 'utf8')).toContain('scope launch rejected');
      expect(() => writeSync(fd, 'leaked descriptor')).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('re-execs as a host-independent task in source and bundled deployments', () => {
    expect(buildAdmissionPrecheckSpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/release/admission-fix-precheck-managed.ts',
      moduleDirOverride: '/repo/packages/operator-core/lib/release',
      execPath: '/node',
      spawnerPid: 42,
    })).toEqual({
      cmd: '/node',
      args: ['--import', createRequire(import.meta.url).resolve('tsx'), '/repo/packages/operator-core/lib/release/admission-fix-precheck-worker-bin.ts'],
      env: {},
      mode: 'dev-tsx',
    });
    const bundled = buildAdmissionPrecheckSpawnPlan({ selfPath: '/app/dist-host/hono-host.mjs', execPath: '/app/node', spawnerPid: 43 });
    expect(bundled).toMatchObject({
      cmd: '/app/node',
      args: ['/app/dist-host/hono-host.mjs'],
      env: { [ADMISSION_PRECHECK_WORKER_MODE_ENV]: '1' },
      mode: 'bundled-reexec',
    });
  });

  it.each(['papercusp', 'oddsmith'])('a successor preserves %s harness scope, progress and verdict', async (harness) => {
    let persisted = queue();
    const progress = { currentFile: 'lib/red.test.ts', completedCount: 0, totalCount: 1, heartbeatAtMs: 20 };
    const runner = vi.fn(async (run: {
      commit: string;
      files: readonly string[];
      onProgress?: (snapshot: typeof progress) => Promise<void> | void;
    }) => {
      await run.onProgress?.(progress);
      return { ran: true as const, commit: run.commit, results: run.files.map((path) => ({ path, status: 'pass' as const })) };
    });
    const createRunner = vi.fn(() => runner);
    const outcome = await runAdmissionPrecheckWorker({ ...input, toolingRoot: '/operator', testCommand: ['npm', 'test'], clearEnv: ['DATABASE_URL'],
      queueTarget: { ...input.queueTarget, installSlug: harness } }, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); },
      createRunner,
      now: () => 30,
    });

    expect(outcome.status).toBe('settled');
    expect(createRunner).toHaveBeenCalledWith({
      integrationRoot: input.integrationRoot,
      checkpointRoot: input.checkpointRoot,
      prepareTestEnvironment: expect.any(Function),
      assertTestEnvironment: expect.any(Function),
      testRunHarness: harness,
      fileConcurrency: admissionPrecheckFileConcurrency(),
      toolingRoot: '/operator',
      testCommand: ['npm', 'test'],
      clearEnv: ['DATABASE_URL'],
    });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      commit: 'c'.repeat(40),
      files: ['lib/red.test.ts'],
      onProgress: expect.any(Function),
    }));
    expect(persisted.admissionPrecheck).toMatchObject({
      operationId: input.operationId,
      runnerTaskId: input.taskId,
      status: 'passed',
      currentFile: 'lib/red.test.ts',
      completedCount: 0,
      totalCount: 1,
      heartbeatAtMs: 20,
      verdict: { ok: true, ran: true, fixes: ['lib/red.test.ts'] },
    });
    expect(persisted.dispatchReservation).toBeUndefined();
  });

  it('P-007 (#D-037): rebuilds the population with the persisted radius partition, so a report-only red cannot refuse', async () => {
    const files = ['lib/red.test.ts', 'ws-a/near.test.ts', 'ws-b/red-leg.test.ts'];
    const radius = {
      status: 'measured' as const, reason: 'ok', guarded: ['ws-a/near.test.ts'], reportOnly: ['ws-b/red-leg.test.ts'],
      legs: { 'ws-a/near.test.ts': '@t/a', 'ws-b/red-leg.test.ts': '@t/b' },
    };
    const settle = async (precheck: FrozenRepairAdmissionPrecheck, failing: string) => {
      let persisted = queue(precheck);
      await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        // Red only at the BUILT commit: the paired baseline at repairHead measures green (D-004).
        createRunner: () => async (run: { commit: string; files: readonly string[] }) => ({
          ran: true as const, commit: run.commit,
          results: run.files.map((path) => ({ path, status: path === failing && run.commit === 'c'.repeat(40) ? 'fail' as const : 'pass' as const })),
        }),
        now: () => 30,
      });
      return persisted.admissionPrecheck;
    };
    const withRadius = operation({ files, totalCount: files.length, radius });
    expect(await settle(withRadius, 'ws-b/red-leg.test.ts')).toMatchObject({
      status: 'passed', verdict: { ok: true, reportOnlyRed: ['ws-b/red-leg.test.ts'] },
    });
    expect(await settle(withRadius, 'ws-a/near.test.ts')).toMatchObject({
      status: 'failed', verdict: { ok: false, code: 'admission-imports-red', newlyRedLegs: ['@t/a'] },
    });
    // CONTROL: the same files without the partition read the report-only file as admitted.
    expect(await settle(operation({ files, totalCount: files.length }), 'ws-b/red-leg.test.ts')).toMatchObject({
      status: 'failed', verdict: { ok: false, code: 'admission-imports-red', importedRed: ['ws-b/red-leg.test.ts'] },
    });
  });

  describe('measured-wide-repair-admission-2026-10-24#D-004 ruling 1: the paired previous-head baseline', () => {
    const files = ['lib/red.test.ts', 'ws-a/near.test.ts', 'ws-a/other.test.ts'];
    const radius = { status: 'measured' as const, reason: 'ok', guarded: ['ws-a/near.test.ts', 'ws-a/other.test.ts'],
      reportOnly: [], legs: { 'ws-a/near.test.ts': '@t/a', 'ws-a/other.test.ts': '@t/a' } };
    type Status = 'pass' | 'fail' | 'unmeasured';
    /** `atBuilt`/`atPrevious` answer per file at the built commit 'c…' and the repair head 'b…'. */
    const settle = async (precheck: FrozenRepairAdmissionPrecheck, atBuilt: Record<string, Status>, atPrevious: Record<string, Status>) => {
      let persisted = queue(precheck);
      const calls: Array<{ suffix: string | undefined; commit: string; files: string[] }> = [];
      const outcome = await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        createRunner: options => async run => {
          calls.push({ suffix: options.precheckRootSuffix, commit: run.commit, files: [...run.files] });
          const table = run.commit === 'c'.repeat(40) ? atBuilt : atPrevious;
          const results = run.files.map(path => ({ path, status: table[path] ?? 'pass' as Status }));
          for (const result of results) await run.onFileResult?.(result);
          return { ran: true, commit: run.commit, results };
        },
        now: () => 30,
      });
      return { outcome, persisted, calls };
    };

    it('measures ONLY the guarded reds, at repairHead, in the second tree — and a red at both heads is carried', async () => {
      const { persisted, calls } = await settle(operation({ files, totalCount: files.length, radius }),
        { 'ws-a/near.test.ts': 'fail' }, { 'ws-a/near.test.ts': 'fail' });
      expect(calls).toEqual([
        { suffix: undefined, commit: 'c'.repeat(40), files },
        { suffix: '-previous-head', commit: 'b'.repeat(40), files: ['ws-a/near.test.ts'] },
      ]);
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'passed', verdict: { ok: true, fixes: ['lib/red.test.ts'],
        carriedRed: ['ws-a/near.test.ts'], previousHead: { commit: 'b'.repeat(40), results: [{ path: 'ws-a/near.test.ts', status: 'fail' }] } } });
    });

    it('WI-6554700010030140: the admission runner AND its paired baseline both measure files concurrently', async () => {
      let persisted = queue(operation({ files, totalCount: files.length, radius }));
      const seen: Array<{ suffix: string | undefined; fileConcurrency: number | undefined }> = [];
      await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        createRunner: options => async run => {
          seen.push({ suffix: options.precheckRootSuffix, fileConcurrency: options.fileConcurrency });
          const results = run.files.map(path => ({ path, status: path === 'ws-a/near.test.ts' ? 'fail' as const : 'pass' as const }));
          for (const result of results) await run.onFileResult?.(result);
          return { ran: true, commit: run.commit, results };
        },
        now: () => 30,
      });
      expect(admissionPrecheckFileConcurrency()).toBeGreaterThan(1);
      expect(seen).toEqual([
        { suffix: undefined, fileConcurrency: admissionPrecheckFileConcurrency() },
        { suffix: '-previous-head', fileConcurrency: admissionPrecheckFileConcurrency() },
      ]);
    });

    it('a guarded red that PASSED at the measured previous head still refuses admission-imports-red', async () => {
      const { persisted } = await settle(operation({ files, totalCount: files.length, radius }), { 'ws-a/near.test.ts': 'fail' }, {});
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', verdict: { ok: false, code: 'admission-imports-red',
        importedRed: ['ws-a/near.test.ts'], ratchet: { newFailures: [{ test: 'ws-a/near.test.ts', before: 'pass' }] } } });
    });

    it('a baseline collection failure is UNMEASURED: never blamed, never published', async () => {
      const { persisted } = await settle(operation({ files, totalCount: files.length, radius }),
        { 'ws-a/near.test.ts': 'fail' }, { 'ws-a/near.test.ts': 'unmeasured' });
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', verdict: { ok: false, code: 'admission-precheck-unavailable',
        importedRed: [], baselineMissing: ['ws-a/near.test.ts'] } });
    });

    it('a baseline that cannot run leaves the red unpaired and records why', async () => {
      let persisted = queue(operation({ files, totalCount: files.length, radius }));
      await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        createRunner: options => async run => options.precheckRootSuffix
          ? { ran: false, reason: 'runner-failed', detail: 'setup-release-checkout exited 1' }
          : { ran: true, commit: run.commit, results: run.files.map(path => ({ path, status: path === 'ws-a/near.test.ts' ? 'fail' as const : 'pass' as const })) },
        now: () => 30,
      });
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', verdict: { ok: false, code: 'admission-precheck-unavailable',
        baselineMissing: ['ws-a/near.test.ts'], detail: expect.stringContaining('setup-release-checkout exited 1') } });
    });

    it('no guarded red ⇒ no baseline run at all', async () => {
      const { calls, persisted } = await settle(operation({ files, totalCount: files.length, radius }), {}, {});
      expect(calls.map(call => call.suffix)).toEqual([undefined]);
      expect(persisted.admissionPrecheck?.verdict).not.toHaveProperty('previousHead');
    });

    it('bounded mode persists the baseline beside the aggregate, so the door can re-judge it', async () => {
      const wideFiles = ['lib/red.test.ts', ...Array.from({ length: 44 }, (_, i) => `ws-a/file-${i}.test.ts`)];
      const wideRadius = { status: 'measured' as const, reason: 'ok', guarded: wideFiles.slice(1), reportOnly: [], legs: {} };
      const { persisted, calls } = await settle(operation({ files: wideFiles, totalCount: wideFiles.length, radius: wideRadius }),
        { 'ws-a/file-3.test.ts': 'fail', 'ws-a/file-41.test.ts': 'fail' }, { 'ws-a/file-3.test.ts': 'fail', 'ws-a/file-41.test.ts': 'fail' });
      expect(calls.filter(call => call.suffix).map(call => call.files)).toEqual([['ws-a/file-3.test.ts', 'ws-a/file-41.test.ts']]);
      expect(persisted.admissionPrecheck?.measurement?.previousHead).toEqual({ commit: 'b'.repeat(40),
        results: [{ path: 'ws-a/file-3.test.ts', status: 'fail' }, { path: 'ws-a/file-41.test.ts', status: 'fail' }] });
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'passed',
        verdict: { ok: true, carriedRed: ['ws-a/file-3.test.ts', 'ws-a/file-41.test.ts'] } });
    });
  });

  describe('EI-27083585698781986: one isolated confirmation re-run before a guarded red is attributed', () => {
    const files = ['lib/red.test.ts', 'ws-a/near.test.ts', 'ws-a/other.test.ts'];
    const radius = { status: 'measured' as const, reason: 'ok', guarded: ['ws-a/near.test.ts', 'ws-a/other.test.ts'],
      reportOnly: [], legs: { 'ws-a/near.test.ts': '@t/a', 'ws-a/other.test.ts': '@t/a' } };
    type Status = 'pass' | 'fail' | 'unmeasured';
    /**
     * An exec stub: `flaky` files FAIL their first N readings at the built commit 'c…' and pass after;
     * `red` files always fail there. The repair head 'b…' is green throughout.
     */
    const settle = async (precheck: FrozenRepairAdmissionPrecheck, opts: { flaky?: Record<string, number>; red?: string[] }) => {
      let persisted = queue(precheck);
      const calls: Array<{ suffix: string | undefined; commit: string; files: string[]; expectedTree?: string }> = [];
      const readings = new Map<string, number>();
      await runAdmissionPrecheckWorker(input, {
        getTask: async () => ({ state: 'running', confined: true }),
        readQueue: async () => ({ status: 'value', queue: persisted }),
        transition: async (_target, update) => { persisted = update(persisted); },
        createRunner: options => async run => {
          calls.push({ suffix: options.precheckRootSuffix, commit: run.commit, files: [...run.files],
            ...(run.expectedTree ? { expectedTree: run.expectedTree } : {}) });
          const results = run.files.map(path => {
            if (run.commit !== 'c'.repeat(40)) return { path, status: 'pass' as Status };
            const seen = readings.get(path) ?? 0;
            readings.set(path, seen + 1);
            const failing = opts.red?.includes(path) || seen < (opts.flaky?.[path] ?? 0);
            return { path, status: (failing ? 'fail' : 'pass') as Status };
          });
          for (const result of results) await run.onFileResult?.(result);
          return { ran: true, commit: run.commit, results };
        },
        now: () => 30,
      });
      return { persisted, calls };
    };

    it('a red that fails ONCE then passes its re-run at the SAME built commit is an advisory flake, and the admission publishes', async () => {
      const { persisted, calls } = await settle(operation({ files, totalCount: files.length, radius }), { flaky: { 'ws-a/near.test.ts': 1 } });
      expect(calls).toEqual([
        { suffix: undefined, commit: 'c'.repeat(40), files },
        { suffix: '-previous-head', commit: 'b'.repeat(40), files: ['ws-a/near.test.ts'] },
        // The confirmation re-run: the main tree, the built commit, only the would-be-attributed file.
        { suffix: undefined, commit: 'c'.repeat(40), files: ['ws-a/near.test.ts'] },
      ]);
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'passed', verdict: { ok: true, fixes: ['lib/red.test.ts'],
        flakyAtBuiltCommit: ['ws-a/near.test.ts'],
        confirmation: { commit: 'c'.repeat(40), results: [{ path: 'ws-a/near.test.ts', status: 'pass' }] } } });
    });

    it('a red that fails its re-run too is attributed: admission-imports-red', async () => {
      const { persisted, calls } = await settle(operation({ files, totalCount: files.length, radius }), { red: ['ws-a/near.test.ts'] });
      expect(calls.at(-1)).toEqual({ suffix: undefined, commit: 'c'.repeat(40), files: ['ws-a/near.test.ts'] });
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', verdict: { ok: false, code: 'admission-imports-red',
        importedRed: ['ws-a/near.test.ts'], confirmation: { results: [{ path: 'ws-a/near.test.ts', status: 'fail' }] } } });
      expect(persisted.admissionPrecheck?.verdict).not.toHaveProperty('flakyAtBuiltCommit');
    });

    it('no attributable red ⇒ no confirmation re-run', async () => {
      const { calls, persisted } = await settle(operation({ files, totalCount: files.length, radius }), {});
      expect(calls.map(call => call.suffix)).toEqual([undefined]);
      expect(persisted.admissionPrecheck?.verdict).not.toHaveProperty('confirmation');
    });

    it('bounded mode re-runs at the expected built tree and persists the confirmation beside the aggregate', async () => {
      const wideFiles = ['lib/red.test.ts', ...Array.from({ length: 44 }, (_, i) => `ws-a/file-${i}.test.ts`)];
      const wideRadius = { status: 'measured' as const, reason: 'ok', guarded: wideFiles.slice(1), reportOnly: [], legs: {} };
      const { persisted, calls } = await settle(operation({ files: wideFiles, totalCount: wideFiles.length, radius: wideRadius }),
        { flaky: { 'ws-a/file-3.test.ts': 1 }, red: ['ws-a/file-41.test.ts'] });
      const confirmationCall = calls.at(-1)!;
      expect(confirmationCall).toMatchObject({ suffix: undefined, commit: 'c'.repeat(40), files: ['ws-a/file-3.test.ts', 'ws-a/file-41.test.ts'] });
      expect(confirmationCall.expectedTree).toBe(persisted.admissionPrecheck?.builtTree);
      expect(persisted.admissionPrecheck?.measurement?.confirmation).toEqual({ commit: 'c'.repeat(40),
        results: [{ path: 'ws-a/file-3.test.ts', status: 'pass' }, { path: 'ws-a/file-41.test.ts', status: 'fail' }] });
      expect(persisted.admissionPrecheck).toMatchObject({ status: 'failed', verdict: { ok: false, code: 'admission-imports-red',
        importedRed: ['ws-a/file-41.test.ts'], flakyAtBuiltCommit: ['ws-a/file-3.test.ts'] } });
    });
  });

  it('does not run outside a confined task or overwrite a successor operation', async () => {
    const unconfinedRunner = vi.fn();
    const unconfined = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: false }),
      readQueue: async () => ({ status: 'value', queue: queue() }),
      transition: async () => undefined,
      createRunner: () => unconfinedRunner as never,
    });
    expect(unconfined.status).toBe('ignored');
    expect(unconfinedRunner).not.toHaveBeenCalled();

    let persisted = queue();
    const newer = operation({ operationId: 'repair-precheck-newer', runnerTaskId: 'task-newer' });
    const stale = await runAdmissionPrecheckWorker(input, {
      getTask: async () => ({ state: 'running', confined: true }),
      readQueue: async () => ({ status: 'value', queue: persisted }),
      transition: async (_target, update) => { persisted = update(persisted); },
      createRunner: () => async () => {
        persisted = queue(newer);
        return { ran: true, commit: 'c'.repeat(40), results: [{ path: 'lib/red.test.ts', status: 'pass' }] };
      },
      now: () => 30,
    });
    expect(stale.status).toBe('settled');
    expect(persisted.admissionPrecheck).toMatchObject({ operationId: 'repair-precheck-newer', status: 'running' });
  });

  it('rejects malformed worker context before it can read or write a queue', () => {
    expect(parseAdmissionPrecheckWorkerInput(undefined)).toBeNull();
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify({ ...input, taskId: '' }))).toBeNull();
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify(input))).toEqual(input);
    const foreign = { ...input, toolingRoot: '/operator', testCommand: ['npm', 'test'], clearEnv: ['DATABASE_URL'] };
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify(foreign))).toEqual(foreign);
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify({ ...foreign, testCommand: [] }))).toBeNull();
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify({ ...foreign, testCommand: [5] }))).toBeNull();
    expect(parseAdmissionPrecheckWorkerInput(JSON.stringify({ ...foreign, clearEnv: ['invalid key'] }))).toBeNull();
  });

  it('pins both host entrypoints to divert before normal host boot and parent-death handling', () => {
    const root = join(import.meta.dirname, '../../../../');
    const serve = readFileSync(join(root, 'apps/operator/bin/serve.ts'), 'utf8');
    const hono = readFileSync(join(root, 'apps/operator/bin/hono-host.ts'), 'utf8');
    expect(serve.indexOf('PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE')).toBeLessThan(serve.indexOf('startSidecarParentDeathWatch();'));
    expect(serve.includes('runAdmissionPrecheckWorkerMain')).toBe(true);
    expect(hono).toContain("'repair-precheck'");
    expect(hono.includes('runAdmissionPrecheckWorkerMain')).toBe(true);
  });

  it('uses CAS transforms that ignore progress and settlements from a replaced operationId', () => {
    const active = queue();
    const replaced = queue(operation({ operationId: 'newer' }));
    expect(admissionPrecheckProgressTransition(replaced, input.operationId, {
      currentFile: 'lib/red.test.ts', completedCount: 1, totalCount: 1, heartbeatAtMs: 20,
    })).toBe(replaced);
    const verdict = { ok: true as const, ran: false as const, reason: 'nothing-to-run' as const, population: {
      signatureTestFiles: [], admittedTestFiles: [], nonTestKinds: [], canProveDoesNotFix: false, files: [],
    } };
    expect(admissionPrecheckSettlementTransition(replaced, input.operationId, verdict, 30)).toBe(replaced);
    expect(admissionPrecheckSettlementTransition(active, input.operationId, verdict, 30).admissionPrecheck)
      .toMatchObject({ status: 'deferred', operationId: input.operationId });
  });
});
