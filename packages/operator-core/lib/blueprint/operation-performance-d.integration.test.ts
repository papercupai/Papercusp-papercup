/** P-013 workload D fixture (plan D-016 (D), D-019): a 4-tool recipe — two reads, one
 * deterministic idempotent write, one declared wait — run through the public orchestrate:run
 * handler as the current foreground run (control) and as a durable DBOS run (candidate), in one
 * migrated throwaway org DB with an ISOLATED DBOS system schema and executor.
 *
 * Default (no env): a fast admission/invariant smoke, not a latency grade.
 * P013_MATRIX=1: the paired D-016 matrix (knobs as workload A/B:
 * P013_MODES P013_CONCURRENCIES P013_WARMUPS P013_WARM_SAMPLES P013_COLD_SAMPLES
 * P013_REPETITIONS P013_REPETITION_OFFSET; P013_DEDICATED_PG per D-022). Extra DBOS persistence
 * (durableSteps + DBOS system-row bytes) rides on each candidate sample (D-016). */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { startDedicatedNativePg, startDedicatedTestPg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getResourceProfile } from '../resource-profile';
import { runPairedBenchmark, type BenchmarkArm } from '../../test/_paired-operation-benchmark';
import { createTextCollector } from '../child-output';
import {
  P013D_WORKSPACE, assertWriteExactlyOnce, runP013WorkloadD, type P013DArm, type P013DSample,
} from './operation-performance-d-driver';
import { bootP013DRuntime, p013DSuppressedSchedules, type BootedP013DRuntime } from './operation-performance-d-runtime';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../workspace-registry', async () => ({
  ...(await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry')),
  activeWorkspaceId: () => P013D_WORKSPACE,
}));

let db: OrgTestDb;
let rt: BootedP013DRuntime;
let dedicatedPg: Pick<StartedPostgreSqlContainer, 'getConnectionUri' | 'stop'> | DedicatedNativePg | undefined;
const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
// P013_DEDICATED_PG=1 → a dedicated Docker container; =native → a dedicated cluster from the
// host's own PG binaries (no Docker). Both are D-022(c) run-owned clusters with server-default
// durability (D-022(b)). `native` exists because Docker container create on this host hung
// 2–30 min in overlay umount (WI-10003403), killing four consecutive repetitions in beforeAll.
const dedicatedPgMode = process.env.P013_DEDICATED_PG === 'native'
  ? 'native' : process.env.P013_DEDICATED_PG === '1' ? 'container' : null;
const dedicatedPgRequested = dedicatedPgMode !== null;
const DEDICATED_PG_SETTINGS = { max_connections: '200', dynamic_shared_memory_type: 'mmap' };
// D-024: size the getOrgPg() stand-in pool like production (resource-profile
// pgPoolMax), not the fixture default of 2; P013_ORG_POOL_MAX=<n> pins it.
const P013_ORG_POOL_MAX = (() => {
  const pinned = Number(process.env.P013_ORG_POOL_MAX);
  return Number.isInteger(pinned) && pinned > 0 ? pinned : getResourceProfile().pgPoolMax;
})();

beforeAll(async () => {
  if (dedicatedPgMode === 'native') {
    dedicatedPg = await startDedicatedNativePg({ settings: DEDICATED_PG_SETTINGS });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
  } else if (dedicatedPgMode === 'container') {
    // startDedicatedTestPg: the stock pg_isready healthcheck crash-restarts a
    // dedicated cluster mid-run under load (2026-09-27, see the helper).
    dedicatedPg = await startDedicatedTestPg({
      command: ['postgres', ...Object.entries(DEDICATED_PG_SETTINGS).flatMap(([k, v]) => ['-c', `${k}=${v}`])],
    });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
  }
  db = await createOrgTestDb({ adminPoolMax: P013_ORG_POOL_MAX });
  fixture.sql = db.adminSql;
  rt = await bootP013DRuntime({
    sql: db.adminSql, systemDsn: db.adminDsn, executorId: `p013d-parent-${process.pid}`, durable: true,
  });
}, dedicatedPgRequested ? 420_000 : 180_000);

afterAll(async () => {
  await rt?.shutdown().catch(() => {});
  await db?.cleanup();
  await dedicatedPg?.stop({ timeout: 10_000 });
  if (dedicatedPg) {
    if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
    else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
  }
}, dedicatedPgRequested ? 180_000 : 60_000);

/** The id nested tools see as ctx.runId: the durable workflow id, else the caller's run id. */
const writeRunId = (sample: P013DSample) => sample.workflowId ?? sample.runId;

describe('P-013 workload D fixture', () => {
  it('runs the same 4-tool recipe through foreground and durable orchestrate:run with one write per run', async () => {
    // Hygiene positive control: production scheduled workflows (routinesTick …) were kept out of
    // this executor, so none fires inside a timed window.
    expect(p013DSuppressedSchedules()).toContain('routinesTick');
    let sequence = 0;
    const samples: Array<P013DSample & { arm: P013DArm }> = [];
    const runArm = async (arm: P013DArm) => {
      const sample = { ...(await runP013WorkloadD(rt, arm, `p013d-${arm}-${process.pid}-${sequence++}`)), arm };
      samples.push(sample);
      return sample;
    };
    if (process.env.P013_MATRIX === '1') {
      const matrix = matrixShape();
      let coldStarts = 0;
      const benchmarkArm = (arm: P013DArm): BenchmarkArm => ({
        warmup: async () => { await runArm(arm); },
        run: async () => runArm(arm),
        coldStart: async () => {
          const childSequence = sequence++;
          coldStarts++;
          const child = spawn(process.execPath, [
            '--import', 'tsx', fileURLToPath(new URL('./operation-performance-d-child.ts', import.meta.url)),
          ], {
            cwd: process.cwd(),
            env: { ...process.env, P013_COLD_DSN: db.adminDsn, P013_COLD_ARM: arm,
              P013_COLD_RUN_ID: `p013d-cold-${arm}-${process.pid}-${childSequence}`,
              PAPERCUSP_WORKSPACE_ID: P013D_WORKSPACE,
              HARNESS_ADMIN_DATABASE_URL: db.adminDsn, HARNESS_DATABASE_URL: db.appDsn },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            signal: AbortSignal.timeout(120_000),
          });
          const stderr = createTextCollector(child.stderr, { maxChars: 4_000 });
          let stage = 'spawned';
          let sample: P013DSample | undefined;
          const exit = new Promise<void>((resolve, reject) => {
            child.once('error', (error) => reject(new Error(`P-013 D cold child ${stage}: ${error.message}; ${stderr.peek()}`)));
            // 'close', not 'exit': under load 'exit' can fire before the already-sent p013-sample
            // IPC message is dispatched (the child self-SIGKILLs right after send's callback), so
            // a successful sample read as a failed child. 'close' waits for the IPC channel to drain.
            child.once('close', (code, signal) => code === 0 || (signal === 'SIGKILL' && sample)
              ? resolve()
              : reject(new Error(`P-013 D cold child ${stage} exited ${code}/${signal}: ${stderr.peek()}`)));
          });
          child.on('message', (message: { kind?: string; stage?: string; sample?: P013DSample }) => {
            if (message?.kind === 'p013-stage') stage = message.stage ?? stage;
            if (message?.kind === 'p013-sample') sample = message.sample;
          });
          return {
            run: async () => {
              await exit;
              expect(sample).toBeDefined();
              samples.push({ ...sample!, arm });
              return sample!;
            },
            close: async () => { if (!child.killed && child.exitCode === null) child.kill(); await exit.catch(() => {}); },
          };
        },
      });
      const trials = await runPairedBenchmark({ control: benchmarkArm('control'), candidate: benchmarkArm('candidate') }, matrix);
      expect(coldStarts).toBe(matrix.modes.includes('cold')
        ? 2 * matrix.repetitions * matrix.coldSamples * matrix.concurrencies.length : 0);
      expect(trials).toHaveLength(2 * matrix.repetitions * matrix.modes.length * matrix.concurrencies.length);
      const candidates = samples.filter((sample) => sample.arm === 'candidate');
      console.info(`P-013 workload D ${matrix.modes.join('+')} trials`, JSON.stringify({
        ...matrix, cluster: dedicatedPg ? 'dedicated' : 'shared', clusterSubstrate: dedicatedPgMode ?? 'shared-container', orgPoolMax: P013_ORG_POOL_MAX,
        dispatchBeforeReceipt: candidates.filter((sample) => sample.dispatchBeforeReceipt).length,
        candidateSamples: candidates.length, trials }));
    } else {
      for (const arm of ['control', 'candidate'] as const) await runArm(arm);
      console.info('P-013 workload D admission/invariant smoke; no grade', JSON.stringify(samples.map((sample) => ({
        arm: sample.arm, runId: sample.runId, workflowId: sample.workflowId,
        durableSteps: sample.durableSteps ?? null, dbBytes: sample.dbBytes ?? null,
        ms: [sample.accepted - sample.ingress, sample.dispatched - sample.accepted, sample.terminal - sample.dispatched,
          sample.businessEvent - sample.terminal, sample.businessEvent - sample.ingress].map((ms) => +ms.toFixed(2)),
      }))));
    }
    // Behavioral invariants (both arms): exactly one write and one live write attempt per run,
    // including across the durable step boundary; every candidate persisted one DBOS step per
    // nested call (3 tool calls + the durable timer).
    const invariant = await assertWriteExactlyOnce(db.adminSql, samples.map(writeRunId));
    expect(invariant).toEqual({ runs: samples.length, writes: samples.length, attempts: samples.length });
    expect(new Set(samples.map(writeRunId)).size).toBe(samples.length);
    for (const sample of samples.filter((entry) => entry.arm === 'candidate')) {
      expect(sample.durableSteps).toBeGreaterThanOrEqual(4);
      expect(sample.dbBytes).toBeGreaterThan(0);
    }
    for (const sample of samples.filter((entry) => entry.arm === 'control')) {
      expect(sample.durableSteps).toBeUndefined();
    }
  }, budgetMs());
});

function matrixShape() {
  const count = (name: string, fallback: number, min: number) => {
    const value = Number(process.env[name] ?? String(fallback));
    if (!Number.isInteger(value) || value < min) throw new Error(`P-013 ${name} must be an integer >= ${min}`);
    return value;
  };
  const list = <T extends string>(name: string, fallback: string, allowed: readonly T[]): T[] => {
    const values = (process.env[name] ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
    if (values.length === 0 || values.some((value) => !allowed.includes(value as T))) {
      throw new Error(`P-013 ${name} must be a comma list of ${allowed.join('|')}`);
    }
    return values as T[];
  };
  return {
    repetitions: count('P013_REPETITIONS', 1, 1),
    repetitionOffset: count('P013_REPETITION_OFFSET', 0, 0),
    coldSamples: count('P013_COLD_SAMPLES', 1, 1),
    warmSamples: count('P013_WARM_SAMPLES', 1, 1),
    warmups: count('P013_WARMUPS', 0, 0),
    modes: list('P013_MODES', 'warm', ['warm', 'cold'] as const),
    concurrencies: list('P013_CONCURRENCIES', '1', ['1', '8'] as const).map(Number) as Array<1 | 8>,
  };
}

function budgetMs(): number {
  if (process.env.P013_MATRIX !== '1') return 180_000;
  const m = matrixShape();
  const perConcurrency = (m.modes.includes('cold') ? m.repetitions * m.coldSamples * 60_000 : 0) +
    (m.modes.includes('warm') ? m.repetitions * m.warmSamples * 5_000 : 0) + m.warmups * 5_000;
  return Math.min(115 * 60_000, Math.max(180_000, 2 * m.concurrencies.length * perConcurrency + 120_000));
}
