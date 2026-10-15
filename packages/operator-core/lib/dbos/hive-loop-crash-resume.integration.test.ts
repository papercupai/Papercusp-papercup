/**
 * hive-loop-crash-resume.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-002: crash-resume durability of the feature pipeline, proven with a REAL
 * process death (SIGKILL mid-step), not a simulated abort.
 *
 * Child process #1 boots a real DBOS against a shared throwaway system DB,
 * starts the F-CRASH pipeline, and SIGKILLs itself MID-WORKER-STEP (after the
 * runner recorded the invocation + spawn). Child process #2 boots DBOS against
 * the same system DB + application version; DBOS recovery resumes the PENDING
 * workflow and runs it to DONE. (Driver: test/_hive-crash-child.ts.)
 *
 * The safety oracle (plan §Oracles): crash-resume re-runs the interrupted STEP
 * but never re-spawns an already-invoked agent —
 *   - decide-t0 completed BEFORE the crash → checkpointed → exactly 1 invocation
 *     across both processes (replay reuses the recorded output);
 *   - the worker step was interrupted → re-runs → 2 invocations total, with the
 *     SAME idempotency key both times;
 *   - the spawn-dedup contract keyed on that idempotency key yields ONE spawn —
 *     "one spawn, not two";
 *   - the finalizer (checkpointed step) fires exactly once, outcome done;
 *   - the workflow ends SUCCESS with exactly one pipeline lifetime in
 *     dbos.workflow_status.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '../..');
const CHILD = resolve(PKG_ROOT, 'test/_hive-crash-child.ts');

let adminUri: string;
let dbName: string;
let dsn: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `crash_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  dsn = u.toString();

  sql = postgres(dsn, { max: 2, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA test_crash;
    CREATE TABLE test_crash.invocations (seq bigserial PRIMARY KEY, key text NOT NULL, role text NOT NULL, pid int NOT NULL, mode text NOT NULL);
    CREATE TABLE test_crash.spawns (key text PRIMARY KEY, role text NOT NULL);
    CREATE TABLE test_crash.finalizes (seq bigserial PRIMARY KEY, outcome text NOT NULL);
    CREATE TABLE test_crash.markers (seq bigserial PRIMARY KEY, k text NOT NULL);
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

function runChild(mode: 'crash' | 'recover') {
  return spawnSync(process.execPath, ['--import', 'tsx', CHILD], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      CRASH_DB_DSN: dsn,
      CRASH_MODE: mode,
      PAPERCUSP_SKIP_PG_DISCOVERY: '1',
      PAPERCUSP_WORKSPACE_ID: 'ws-crash',
    },
    timeout: 150_000,
    encoding: 'utf8' as const,
  });
}

describe('hive loop crash-resume durability (P-002)', () => {
  it('SIGKILL mid-worker-step → DBOS recovery re-runs the step but reuses the agent invocation (one spawn, not two)', async () => {
    // ── Phase 1: run to the worker step and die there (a real crash).
    const c1 = runChild('crash');
    // The child SIGKILLs itself from inside the worker step; any clean exit
    // means the crash point was never reached.
    expect(c1.signal, `child1 stderr:\n${c1.stderr}`).toBe('SIGKILL');

    const preInvocations = await sql`SELECT key, role, mode FROM test_crash.invocations ORDER BY seq`;
    expect(preInvocations.map((r) => [r.role, r.key, r.mode])).toEqual([
      ['director', 'crash:F-CRASH:director:t0', 'crash'],
      ['worker', 'crash:F-CRASH:worker:t0', 'crash'],
    ]);
    // The pipeline is mid-flight: no finalize, workflow not SUCCESS.
    expect((await sql`SELECT count(*)::int AS n FROM test_crash.finalizes`)[0].n).toBe(0);

    // ── Phase 2: a fresh process boots DBOS; recovery resumes the workflow.
    const c2 = runChild('recover');
    expect(c2.status, `child2 stdout:\n${c2.stdout}\nstderr:\n${c2.stderr}`).toBe(0);

    // The recovered workflow completed.
    const markers = await sql`SELECT k FROM test_crash.markers`;
    expect(markers.map((r) => r.k)).toContain('result:pipeline-complete (last=DONE)');
    const [wfRow] = await sql`
      SELECT status FROM dbos.workflow_status WHERE workflow_uuid = 'pipeline:crash:F-CRASH:e0'`;
    expect(wfRow.status).toBe('SUCCESS');

    // ── The decisive safety assertions.
    const counts = await sql`
      SELECT key, role, count(*)::int AS n FROM test_crash.invocations GROUP BY key, role`;
    const byKey = new Map(counts.map((r) => [r.key as string, r.n as number]));
    // decide-t0 completed before the crash → checkpoint replayed, NOT re-invoked.
    expect(byKey.get('crash:F-CRASH:director:t0')).toBe(1);
    // The interrupted worker STEP re-ran (once pre-crash, once post-recovery)…
    expect(byKey.get('crash:F-CRASH:worker:t0')).toBe(2);
    // …with the SAME idempotency key, so the spawn was reused: one spawn, not two.
    const spawnRows = await sql`SELECT key FROM test_crash.spawns WHERE role = 'worker'`;
    expect(spawnRows.map((r) => r.key)).toEqual(['crash:F-CRASH:worker:t0']);
    // The post-crash decide (t1) ran once, in the recovery process only.
    expect(byKey.get('crash:F-CRASH:director:t1')).toBe(1);
    const t1Mode = await sql`
      SELECT mode FROM test_crash.invocations WHERE key = 'crash:F-CRASH:director:t1'`;
    expect(t1Mode.map((r) => r.mode)).toEqual(['recover']);

    // Finalizer: a checkpointed step — exactly once, outcome done.
    const fins = await sql`SELECT outcome FROM test_crash.finalizes`;
    expect(fins.map((r) => r.outcome)).toEqual(['done']);

    // Exactly ONE pipeline lifetime exists (no phantom second workflow).
    const lifetimes = await sql`
      SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid LIKE 'pipeline:crash:%'`;
    expect(lifetimes.length).toBe(1);
  }, 300_000);
});
