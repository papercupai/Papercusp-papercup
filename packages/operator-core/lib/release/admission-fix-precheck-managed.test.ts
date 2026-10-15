import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { managedSpawn } from '../task-manager/managed-spawn';
import { describe, expect, it, vi } from 'vitest';
import {
  ADMISSION_PRECHECK_WORKER_MODE_ENV,
  admissionPrecheckProgressTransition,
  admissionPrecheckSettlementTransition,
  buildAdmissionPrecheckSpawnPlan,
  parseAdmissionPrecheckWorkerInput,
  runAdmissionPrecheckWorker,
  startAdmissionPrecheckWorker,
  type AdmissionPrecheckWorkerInput,
} from './admission-fix-precheck-managed';
import type { FrozenCandidateRepairQueue, FrozenRepairAdmissionPrecheck } from './frozen-candidate-repair-queue';

const operation = (overrides: Partial<FrozenRepairAdmissionPrecheck> = {}): FrozenRepairAdmissionPrecheck => ({
  schemaVersion: 1,
  operationId: 'repair-precheck-1',
  status: 'running',
  candidate: 'a'.repeat(40),
  repairHead: 'b'.repeat(40),
  builtCommit: 'c'.repeat(40),
  builtTree: 'd'.repeat(40),
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
      cmd: 'npx',
      args: ['tsx', '/repo/packages/operator-core/lib/release/admission-fix-precheck-worker-bin.ts'],
      env: { PAPERCUSP_DESKTOP_PARENT_PID: '42' },
      mode: 'dev-tsx',
    });
    const bundled = buildAdmissionPrecheckSpawnPlan({ selfPath: '/app/dist-host/hono-host.mjs', execPath: '/app/node', spawnerPid: 43 });
    expect(bundled).toMatchObject({
      cmd: '/app/node',
      args: ['/app/dist-host/hono-host.mjs'],
      env: { [ADMISSION_PRECHECK_WORKER_MODE_ENV]: '1', PAPERCUSP_DESKTOP_PARENT_PID: '43' },
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
      testRunHarness: harness,
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
        createRunner: () => async (run: { commit: string; files: readonly string[] }) => ({
          ran: true as const, commit: run.commit,
          results: run.files.map((path) => ({ path, status: path === failing ? 'fail' as const : 'pass' as const })),
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
