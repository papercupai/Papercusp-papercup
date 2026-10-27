import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { buildConnectionOptions } from '@papercusp/db-org';
import { createFreshTestDb } from '@papercusp/test-config/pg';
import { managedSpawn } from '../task-manager/managed-spawn';
import { killScopeUnit } from '../task-manager/control';
import { newTaskId, scopeUnitForTask } from '../task-manager/types';
import { userManagerBusReachable } from '../systemd-scope';
import { runQualificationCommand, type QualificationCommandOptions } from './checkpoint-qualification-command';
import type { recordStoredQualificationChildScope } from './checkpoint-qualification-transaction';

// Persistence is a fixture; worker processes, PostgreSQL lock waits, cgroups,
// command timers and death-aware scope cleanup execute their real paths.
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({ registerTask: vi.fn(async () => ({})),
  markSpawned: vi.fn(async () => ({})), closeTask: vi.fn(async () => true) }));

function running(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
  } catch { return false; }
}

describe.runIf(process.platform === 'linux' && userManagerBusReachable())('qualification independent stalled-process bounds', () => {
  it.each(['chatty', 'database-lock'] as const)('bounds %s while a healthy peer completes', async mode => {
    const database = mode === 'database-lock' ? await createFreshTestDb({ prefix: 'qualification_stall' }) : undefined;
    const sql = database ? postgres(database.url, { max: 1, onnotice: () => {} }) : undefined;
    const stalledId = newTaskId(), healthyId = newTaskId(), units = [stalledId, healthyId].map(id => scopeUnitForTask(id));
    const controller = new AbortController();
    let workerPid = 0, backendPid = 0, backendCheckInterval = '', output = '', diagnostics = '', messages = 0, spawnedAt = 0, releasedAt = 0;
    const connection = buildConnectionOptions({ searchPath: 'public', applicationName: 'qualification-stalled-worker',
      idleInTxMs: 2000, stmtTimeoutMs: 0, pooled: false, clientConnCheckMs: 100 });
    const release = vi.fn<typeof recordStoredQualificationChildScope>(async (_target, change) => {
      if (change.operation === 'release' && change.unit === units[0]) {
        expect(workerPid).toBeGreaterThan(0);
        expect(running(workerPid)).toBe(false);
        releasedAt = Date.now();
      }
      return { status: 'updated', transaction: {} } as Awaited<ReturnType<typeof recordStoredQualificationChildScope>>;
    });
    const options = (taskKey: string): QualificationCommandOptions => ({
      target: { workspaceId: 'qualification-stall-test', installSlug: 'qualification-stall-test' },
      progress: { attemptId: 'test', candidate: 'test', repairHead: null, runnerId: 'test', runId: 'test',
        pidIdentity: 'test', root: process.cwd(), taskKey, runnerIdentity: 'test', updates: [],
        manifest: { schemaVersion: 1, units: [{ id: 'test:worker', kind: 'test', path: 'worker' }] },
        retryStates: [], runContext: 'green-checkpoint' },
      // Startup-hook coverage lives in checkpoint-qualification-process.integration.test.ts.
      // These fixed 4s/6s budgets measure the driver/OS path after builtin startup.
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, signal: controller.signal,
      deadlineEpochMs: Date.now() + 15_000,
    });
    const deps = (id: string) => ({
      spawn: (cmd: string, args: readonly string[], spec: Parameters<typeof managedSpawn>[2], launch: Parameters<typeof managedSpawn>[3]) =>
        managedSpawn(cmd, args, spec, { ...launch, scopeAvailable: true }),
      record: release, kill: killScopeUnit, taskId: () => id, now: Date.now,
    });
    let stalled: Promise<unknown> | undefined;
    let cleanupCutoffEpochMs = 0;
    try {
      if (sql) await sql`SELECT pg_advisory_lock(42)`;
      const start = mode === 'database-lock' ? `
        const postgres = require('postgres');
        const client = postgres(process.env.QUALIFICATION_TEST_DB_URL, { max: 1, connection: ${JSON.stringify(connection)} });
        (async () => {
          const rows = await client.unsafe("SELECT pg_backend_pid() AS pid, current_setting('client_connection_check_interval') AS interval");
          console.log(JSON.stringify({ pid: process.pid, backendPid: rows[0].pid, backendCheckInterval: rows[0].interval }));
          setInterval(() => console.log('heartbeat without completed work'), 40);
          await client.unsafe('SELECT pg_advisory_lock(42)');
          process.exit(99);
        })().catch(error => { console.error('guarded worker failed', error.code ?? error.name); process.exit(98); });
      ` : `
        console.log(JSON.stringify({ pid: process.pid }));
        setInterval(() => console.log('heartbeat without completed work'), 40);
      `;
      // The independently fixed hang budget is 4s. Neither peer progress nor
      // chatter moves it. Optional idle expiry is tested separately: it can
      // expire during instrumentation startup before this hard-bound scenario.
      // D-008: the fixed 6s invocation cutoff includes 2s for guarded DB cleanup.
      // It never moves when output, a healthy peer or the OS release completes.
      cleanupCutoffEpochMs = Date.now() + 6000;
      stalled = runQualificationCommand(process.execPath, ['-e', start], {
        ...options('stalled'), deadlineEpochMs: cleanupCutoffEpochMs,
        env: { ...options('stalled').env, ...(database ? { QUALIFICATION_TEST_DB_URL: database.url } : {}) },
        hardTimeoutMs: 4000,
        onSpawn() { spawnedAt = Date.now(); },
        onOutput(stream, text) {
          if (stream !== 'stdout') { diagnostics += text; return; }
          output += text; messages++;
          if (!workerPid && output.includes('\n')) {
            const identity = JSON.parse(output.split('\n')[0]!);
            workerPid = identity.pid; backendPid = identity.backendPid ?? 0;
            backendCheckInterval = identity.backendCheckInterval ?? '';
          }
        },
      }, deps(stalledId));
      // Attach immediately even when an earlier readiness assertion fails.
      const outcome = stalled.then(() => null, error => error);
      await vi.waitFor(() => expect(workerPid, diagnostics).toBeGreaterThan(0), { timeout: 3000 });
      if (sql) expect(backendCheckInterval).toBe('100ms');
      if (sql) await vi.waitFor(async () => {
        const rows = await sql`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = ${backendPid}`;
        expect(rows[0]).toMatchObject({ wait_event_type: 'Lock', wait_event: 'advisory' });
      }, { timeout: 1500 });
      const healthy = await runQualificationCommand(process.execPath, ['-e', "console.log('completed healthy work')"],
        options('healthy'), deps(healthyId));
      expect(healthy).toMatchObject({ code: 0, signal: null });
      expect(healthy.stdout).toContain('completed healthy work');
      expect(running(workerPid)).toBe(true);
      expect(await outcome).toMatchObject({ message: 'qualification-worker-hard-timeout' });
      expect(messages).toBeGreaterThan(2);
      expect(releasedAt - spawnedAt).toBeGreaterThanOrEqual(3900);
      expect(releasedAt - spawnedAt).toBeLessThan(6000);
      expect(running(workerPid)).toBe(false);
      if (sql) {
        expect(Date.now()).toBeLessThan(cleanupCutoffEpochMs);
        await vi.waitFor(async () => {
          expect(await sql`SELECT pid FROM pg_stat_activity WHERE pid = ${backendPid}`).toEqual([]);
        }, { timeout: Math.max(1, cleanupCutoffEpochMs - Date.now()), interval: 25 });
        expect(Date.now()).toBeLessThanOrEqual(cleanupCutoffEpochMs);
      }
    } finally {
      controller.abort();
      await Promise.allSettled(units.map(unit => killScopeUnit(unit, { signal: 'SIGKILL' })));
      await Promise.allSettled(stalled ? [stalled] : []);
      if (sql) { await sql`SELECT pg_advisory_unlock(42)`; await sql.end({ timeout: 5 }); }
      await database?.drop();
    }
  }, 30_000);
});
