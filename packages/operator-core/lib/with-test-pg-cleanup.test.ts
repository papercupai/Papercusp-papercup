import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { cleanupOwnedTestState, createPrivateTestPgReleaseHandler, createSingleFlightStop,
  removePrivateState, requestPrivateTestPgRelease } from '../../../scripts/lib/with-test-pg-cleanup.mjs';

describe('private PostgreSQL dependency signal ownership', () => {
  it.each([false, true])('handles actual lazy exit-hook registration (registered=%s)', registered => {
    const helper = resolve(import.meta.dirname, '../../../scripts/lib/with-test-pg-cleanup.mjs');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import exitHook from 'async-exit-hook';
      import { unhookRegisteredExitSignals } from ${JSON.stringify(helper)};
      if (${registered}) exitHook(() => {});
      const before = exitHook.hookedEvents();
      unhookRegisteredExitSignals(exitHook);
      unhookRegisteredExitSignals(exitHook);
      console.log(JSON.stringify({ before, after: exitHook.hookedEvents(),
        signals: ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)) }));
    `], { cwd: resolve(import.meta.dirname, '../../..'), encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    const observed = JSON.parse(result.stdout);
    expect(observed.before.includes('SIGINT')).toBe(registered);
    expect(observed.before.includes('SIGTERM')).toBe(registered);
    expect(observed.after).toEqual(observed.before.filter((event: string) =>
      event !== 'SIGINT' && event !== 'SIGTERM'));
    expect(observed.signals).toEqual([0, 0]);
  });
});

describe('private PostgreSQL independent cleanup', () => {
  function fixture(failedStop?: 'child' | 'profile' | 'pg') {
    const dataDir = mkdtempSync(join(tmpdir(), 'pg-cleanup-fence-'));
    const runtimeRoot = mkdtempSync(join(tmpdir(), 'runtime-cleanup-fence-'));
    writeFileSync(join(dataDir, 'evidence'), 'private pg');
    writeFileSync(join(runtimeRoot, 'evidence'), 'private runtime');
    const calls: string[] = [];
    const stages: { stage: string; [key: string]: unknown }[] = [];
    const failure = new Error('injected ' + failedStop + ' exit fence failure');
    const stop = async (name: string) => {
      calls.push(name);
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(runtimeRoot)).toBe(true);
      await Promise.resolve();
      if (name === failedStop) throw failure;
    };
    const resources = { child: { pid: 1 }, childLifetime: { terminate: () => stop('child') },
      profileProcess: { pid: 2 }, profileLifetime: { terminate: () => stop('profile') },
      pg: { stop: () => stop('pg') }, dataDir, runtimeRoot, isolatedRuntime: true,
      cleanupStage: async (stage: string, detail = {}) => { stages.push({ stage, ...detail }); },
      observePrivatePgStop: () => { calls.push('observe'); return () => { calls.push('observation-stopped'); }; } };
    return { resources, calls, stages, failure, dispose: () => {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(runtimeRoot, { recursive: true, force: true });
    } };
  }

  it.each(['child', 'profile', 'pg'] as const)(
    'attempts every owned stop and retains private state after an unverified %s exit', async failedStop => {
      const f = fixture(failedStop);
      try {
        let error: unknown;
        try { await cleanupOwnedTestState(f.resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not reject with its stop failures');
        expect(error.message).toContain('unverified resource stops');
        expect(error.errors).toHaveLength(1);
        expect(error.errors[0].cause).toBe(f.failure);
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
        expect(f.stages).toContainEqual(expect.objectContaining({ stage: 'private-state-retained',
          runtimeRemoved: false, pgDataRemoved: false }));
        expect(f.stages.some(row => row.stage === 'complete' || row.stage === 'remove-private-state')).toBe(false);
      } finally { f.dispose(); }
    });

  it('removes owned private state only after every stop succeeds', async () => {
    const f = fixture();
    try {
      await cleanupOwnedTestState(f.resources);
      expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
      expect(existsSync(f.resources.dataDir)).toBe(false);
      expect(existsSync(f.resources.runtimeRoot)).toBe(false);
      expect(f.stages.at(-1)).toEqual({ stage: 'complete', runtimeRemoved: true, pgDataRemoved: true });
    } finally { f.dispose(); }
  });

  it('stops only the owner-held PG on an authenticated child request and retains state until final cleanup', async () => {
    const f = fixture();
    const token = 'wrapper-issued-private-pg-token';
    const stop = vi.fn(() => f.resources.pg.stop());
    const stopOnce = createSingleFlightStop(stop);
    const channel = new EventEmitter() as EventEmitter & {
      pid: number; connected: boolean;
      send: (message: unknown, callback?: (error?: Error) => void) => boolean;
    };
    channel.pid = 321;
    channel.connected = true;
    const handle = createPrivateTestPgReleaseHandler({
      token,
      stop: stopOnce,
      respond: async message => { channel.emit('message', message); },
    });
    channel.send = (message, callback) => {
      void handle(message).then(() => callback?.(), error => callback?.(error));
      return true;
    };
    try {
      await expect(handle({ kind: 'papercusp-private-test-pg-release', token: 'wrong', requestId: 'wrong' }))
        .resolves.toBe(false);
      expect(stop).not.toHaveBeenCalled();
      await expect(requestPrivateTestPgRelease(token, { processRef: channel as unknown as NodeJS.Process,
        timeoutMs: 1000 })).resolves.toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(f.calls).toEqual(['pg']);
      expect(existsSync(f.resources.dataDir)).toBe(true);
      expect(existsSync(f.resources.runtimeRoot)).toBe(true);

      await cleanupOwnedTestState({ ...f.resources, pg: { ...f.resources.pg, stop: async () => { await stopOnce(); } } });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(f.calls).toEqual(['pg', 'child', 'profile', 'observe', 'observation-stopped']);
      expect(existsSync(f.resources.dataDir)).toBe(false);
      expect(existsSync(f.resources.runtimeRoot)).toBe(false);
    } finally { f.dispose(); }
  });

  it('retries a transient ENOTEMPTY while removing private runtime state', async () => {
    const f = fixture();
    try {
      const runtimePath = f.resources.runtimeRoot!;
      let attempts = 0;
      const removeWithTransientFailure = async (path: string, options: Parameters<typeof rm>[1]) => {
        if (path === runtimePath && attempts++ < 2) {
          const error = new Error('directory not empty') as NodeJS.ErrnoException;
          error.code = 'ENOTEMPTY';
          throw error;
        }
        await rm(path, options);
      };
      await removePrivateState(runtimePath, removeWithTransientFailure);
      expect(attempts).toBe(3);
      expect(existsSync(runtimePath)).toBe(false);
    } finally { f.dispose(); }
  });

  it.each([false, true])('reaps registered databases before early/final PG stop and retains cleanup failure (fails=%s)', async fails => {
    const order: string[] = [];
    let alive = true;
    const failure = new Error('owned database drop is unconfirmed');
    const prepare = vi.fn(async () => {
      expect(alive).toBe(true);
      order.push('databases');
      if (fails) throw failure;
    });
    const stop = createSingleFlightStop(async () => { order.push('pg-stop'); alive = false; }, prepare);
    if (fails) {
      await expect(stop()).rejects.toBe(failure);
      expect(alive).toBe(false);
      await expect(stop()).rejects.toBe(failure);
      expect(order).toEqual(['databases', 'pg-stop', 'pg-stop']);
    } else {
      await Promise.all([stop(), stop()]);
      await stop();
      expect(order).toEqual(['databases', 'pg-stop']);
    }
    expect(prepare).toHaveBeenCalledOnce();
  });

  it.each([false, true])('fences detached managed tasks before private PG removal (fails=%s)', async fails => {
    const f = fixture();
    try {
      const resources = { ...f.resources, stopManagedTasks: async () => {
        f.calls.push('managed-tasks');
        expect(existsSync(f.resources.dataDir)).toBe(true);
        expect(existsSync(f.resources.runtimeRoot)).toBe(true);
        if (fails) throw new Error('private task scope still populated');
      } };
      if (fails) {
        await expect(cleanupOwnedTestState(resources)).rejects.toThrow(/unverified resource stops/);
        expect(existsSync(f.resources.dataDir)).toBe(true);
        expect(existsSync(f.resources.runtimeRoot)).toBe(true);
      } else {
        await cleanupOwnedTestState(resources);
        expect(existsSync(f.resources.dataDir)).toBe(false);
      }
      expect(f.calls).toEqual(['child', 'profile', 'managed-tasks', 'observe', 'pg', 'observation-stopped']);
    } finally { f.dispose(); }
  });

  it.each(['start', 'child-group-stop', 'child-group-stopped', 'child-group-stop-error'])(
    'isolates cleanup instrumentation: a rejected %s receipt cannot skip owned stops', async failedStage => {
      const f = fixture(failedStage === 'child-group-stop-error' ? 'child' : undefined);
      const receiptFailure = new Error('injected receipt failure at ' + failedStage);
      try {
        const resources = { ...f.resources, cleanupStage: async (stage: string, detail = {}) => {
          await f.resources.cleanupStage(stage, detail);
          if (stage === failedStage) throw receiptFailure;
        } };
        let error: unknown;
        try { await cleanupOwnedTestState(resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not aggregate receipt failure');
        expect(error.errors.some(failure => failure.cause === receiptFailure)).toBe(true);
        if (failedStage === 'child-group-stop-error') {
          expect(error.errors.some(failure => failure.cause === f.failure)).toBe(true);
        }
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
      } finally { f.dispose(); }
    });

  it.each(['observe-start', 'observe-stop', 'health'])(
    'isolates cleanup instrumentation: a failed %s cannot skip private PG stop', async failedPhase => {
      const f = fixture();
      const observationFailure = new Error('injected observation failure at ' + failedPhase);
      try {
        const resources = { ...f.resources,
          pg: { ...f.resources.pg, health: () => {
            if (failedPhase === 'health') throw observationFailure;
            return null;
          } },
          observePrivatePgStop: () => {
            const stop = f.resources.observePrivatePgStop();
            if (failedPhase === 'observe-start') throw observationFailure;
            return () => { stop(); if (failedPhase === 'observe-stop') throw observationFailure; };
          } };
        let error: unknown;
        try { await cleanupOwnedTestState(resources); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) throw new Error('cleanup did not aggregate observation failure');
        expect(error.errors.some(failure => failure.cause === observationFailure)).toBe(true);
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg',
          ...(failedPhase === 'observe-start' ? [] : ['observation-stopped'])]);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
      } finally { f.dispose(); }
    });

  it('awaits cleanup instrumentation already in flight before removing private evidence', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let finishPg!: () => void;
    let finishReceipt!: () => void;
    const pgWaiting = new Promise<void>(resolve => { finishPg = resolve; });
    const receiptWaiting = new Promise<void>(resolve => { finishReceipt = resolve; });
    const receiptFailure = new Error('delayed periodic receipt rejected');
    let settled = false;
    const cleanup = cleanupOwnedTestState({ ...f.resources,
      pg: { stop: async () => { await f.resources.pg.stop(); await pgWaiting; } },
      cleanupStage: async (stage, detail) => {
        await f.resources.cleanupStage(stage, detail);
        if (stage === 'pg-stop-waiting') { await receiptWaiting; throw receiptFailure; }
      } }).finally(() => { settled = true; });
    void cleanup.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.stages.some(row => row.stage === 'pg-stop-waiting')).toBe(true);
      finishPg();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
      finishReceipt();
      await expect(cleanup).rejects.toMatchObject({ errors: [expect.objectContaining({ cause: receiptFailure })] });
      expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
      expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
    } finally {
      finishPg(); finishReceipt();
      await cleanup.catch(() => {});
      vi.useRealTimers();
      f.dispose();
    }
  });

  it.each(['stopping-throw', 'cleanup-callback', 'disconnected', 'stopping-callback', 'background-callback'] as const)(
    'launcher IPC failure %s cannot skip owned stops or certify successful cleanup', async mode => {
      const f = fixture();
      const receiptFailure = new Error('injected launcher IPC ' + mode);
      const exits: number[] = [];
      const receiptFailures: Error[] = [];
      const pendingReceipts = new Set<Promise<void>>();
      let backgroundSent!: () => void;
      let finishBackground!: () => void;
      let observationStopped!: () => void;
      const backgroundStarted = new Promise<void>(resolve => { backgroundSent = resolve; });
      const backgroundWaiting = new Promise<void>(resolve => { finishBackground = resolve; });
      const observationFinished = new Promise<void>(resolve => { observationStopped = resolve; });
      const sentStages: string[] = [];
      const source = readFileSync(resolve(import.meta.dirname, '../../../scripts/with-test-pg.mjs'), 'utf8');
      // Run the actual launcher functions, with only OS ownership and IPC
      // replaced. This catches failures outside the cleanup helper without
      // allocating another database or adding a production test-only switch.
      const stages = source.slice(source.indexOf('function cleanupStage('), source.indexOf('function observePrivatePgStop('));
      const finish = source.slice(source.indexOf('async function finishChildOwned('), source.indexOf('\nmain().catch('));
      const ownedCleanup = source.slice(source.indexOf('async function cleanupOwnedState('), source.indexOf('\nasync function stopPrivateManagedTasks('));
      expect(stages).toContain('function cleanupStage(');
      expect(finish).toContain('async function finishChildOwned(');
      expect(ownedCleanup).toContain('async function cleanupOwnedState(');
      let launcher!: { finishChildOwned(code: number, signal: null): Promise<void>;
        cleanupStage(stage: string, detail?: Record<string, unknown>): Promise<void>;
        queueCleanupStage(stage: string, detail?: Record<string, unknown>): void;
        cleanupOwnedState(): Promise<void> };
      const scope = {
        ...f.resources, cleanupOwnedTestState, managedTasks: false, managedTaskCleanupEnv: null,
        stopPrivatePg: async (): Promise<unknown> => undefined,
        isolatedRuntime: true, cleanupStartedAt: Date.now(), runtimeId: 'test-runtime-ipc',
        runtimeRoot: f.resources.runtimeRoot, dataDir: f.resources.dataDir, port: 12345,
        child: f.resources.child, cleanupReceiptFailures: receiptFailures, pendingCleanupReceipts: pendingReceipts,
        existsSync, console: { log: vi.fn() }, persistIsolatedProgress: vi.fn(),
        pg: { stop: async () => {
          await f.resources.pg.stop();
          if (mode === 'background-callback') launcher.queueCleanupStage('pg-log', { message: 'stopping' });
        } },
        observePrivatePgStop: () => {
          const stop = f.resources.observePrivatePgStop();
          return () => { stop(); observationStopped(); };
        },
        process: { pid: 123, env: { PC_ISOLATED_RUNTIME_PROOF: '1' }, connected: mode !== 'disconnected',
          send: (message: { kind: string; stage?: string }, callback?: (error?: Error) => void) => {
            if (message.stage) sentStages.push(message.stage);
            if (mode === 'stopping-throw' && message.kind === 'isolated-runtime-stopping') throw receiptFailure;
            if (mode === 'background-callback' && message.stage === 'pg-log') {
              backgroundSent();
              void backgroundWaiting.then(() => callback?.(receiptFailure));
              return;
            }
            const error = mode === 'disconnected' || mode === 'cleanup-callback' && message.stage === 'pg-stop'
              || mode === 'stopping-callback' && message.kind === 'isolated-runtime-stopping'
              ? receiptFailure : undefined;
            if (error && !callback) throw error;
            queueMicrotask(() => callback?.(error));
          },
          exit: (code: number) => { exits.push(code); },
        },
        cleanup: () => launcher.cleanupOwnedState(),
      };
      scope.stopPrivatePg = createSingleFlightStop(async () => { await scope.pg.stop(); });
      launcher = runInNewContext(stages + '\n' + ownedCleanup + '\n' + finish
        + '\n({ cleanupStage, queueCleanupStage, cleanupOwnedState, finishChildOwned })', scope);
      try {
        let failure: unknown;
        let settled = false;
        const cleanup = launcher.finishChildOwned(0, null).catch(error => { failure = error; })
          .finally(() => { settled = true; });
        if (mode === 'background-callback') {
          const prematureFinish = cleanup.then(() => {
            throw new Error('cleanup settled before its background IPC fence: ' + String(failure)
              + '; calls=' + JSON.stringify(f.calls) + '; stages=' + JSON.stringify(sentStages));
          });
          // A launcher exception before either signal is useful failure
          // evidence, rather than an unresolved promise until test timeout.
          await Promise.race([backgroundStarted, prematureFinish]);
          await Promise.race([observationFinished, prematureFinish]);
          expect(settled).toBe(false);
          expect(sentStages).not.toContain('remove-private-state');
          expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
          expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
          finishBackground();
        }
        await cleanup;
        expect(f.calls).toEqual(['child', 'profile', 'observe', 'pg', 'observation-stopped']);
        if (mode !== 'disconnected') expect(sentStages).toContain('pg-stop');
        expect(failure).toBeTruthy();
        expect(exits).toEqual([]);
        expect(existsSync(join(f.resources.dataDir, 'evidence'))).toBe(true);
        expect(existsSync(join(f.resources.runtimeRoot, 'evidence'))).toBe(true);
      } finally { finishBackground(); f.dispose(); }
    });
});
