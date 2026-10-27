// @vitest-environment node
/**
 * Real SIGKILL inside a nested tool call of an explicitly durable orchestration run
 * (blueprint-backed-work-item-execution-2026-09-23 P-019, D-019).
 *
 * Each scenario runs the REAL `durableOrchestration` DBOS workflow in a child process, kills it
 * mid-call, and relaunches DBOS on a fresh executor. The oracle is independent of the code under
 * test: it counts live dispatches in `test_durable.calls` (written by the tools themselves) and
 * reads the per-call step rows DBOS wrote to `dbos.operation_outputs`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childPath = resolve(packageRoot, 'test/_durable-orchestration-crash-child.ts');
let adminUri: string;
let databaseName: string;
let dsn: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  databaseName = 'durable_orch_crash_' + randomBytes(5).toString('hex');
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe('CREATE DATABASE "' + databaseName + '"');
    await markManagedTestDatabase(admin, databaseName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = '/' + databaseName;
  dsn = url.toString();
  sql = postgres(dsn, { max: 2, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA test_durable;
    CREATE TABLE test_durable.calls (
      seq bigserial PRIMARY KEY,
      run_key text NOT NULL,
      tool text NOT NULL,
      mode text NOT NULL,
      args text,
      idempotency_key text
    )`);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (adminUri && databaseName) {
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

interface Scenario {
  runKey: string;
  script: string;
  crashTarget: string;
  revoke?: string;
}

function runChild(mode: 'crash' | 'recover' | 'code', scenario: Scenario) {
  // Fail before process launch with a named precondition instead of an opaque child exit.
  expect(dsn, 'private DBOS database must be prepared before launching the child').toBeTruthy();
  expect(scenario.runKey, 'durable run key is required').toBeTruthy();
  expect(scenario.script, 'durable script source is required').toBeTruthy();
  return spawnSync(process.execPath, ['--import', 'tsx', childPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DURABLE_CRASH_DSN: dsn,
      DURABLE_CRASH_RUN_KEY: scenario.runKey,
      DURABLE_CRASH_MODE: mode,
      DURABLE_CRASH_SCRIPT: scenario.script,
      DURABLE_CRASH_TARGET: scenario.crashTarget,
      DURABLE_CRASH_REVOKE: mode === 'recover' ? (scenario.revoke ?? '') : '',
    },
    timeout: mode === 'code' ? 240_000 : 150_000,
    encoding: 'utf8',
  });
}

async function calls(runKey: string): Promise<Array<{ tool: string; mode: string; args: Record<string, unknown>; key: string | null }>> {
  const rows = await sql.unsafe(
    'SELECT tool, mode, args, idempotency_key FROM test_durable.calls WHERE run_key = $1 ORDER BY seq',
    [runKey],
  );
  // `args` is stored as the tool's own JSON.stringify text; parse it here so no driver-side
  // json coercion can hand back a string whose prototype methods masquerade as fields.
  return rows.map((row) => ({
    tool: row.tool,
    mode: row.mode,
    args: JSON.parse(String(row.args)) as Record<string, unknown>,
    key: row.idempotency_key,
  }));
}

async function stepNames(runKey: string): Promise<string[]> {
  const rows = await sql.unsafe(
    'SELECT function_name FROM dbos.operation_outputs WHERE workflow_uuid = $1 ORDER BY function_id',
    ['orchestrate-durable:ws-p019-crash:' + runKey],
  );
  return rows.map((row) => String(row.function_name));
}

async function crashThenRecover(scenario: Scenario) {
  const crashed = runChild('crash', scenario);
  expect(crashed.signal, 'crash child stdout: ' + crashed.stdout + '\nstderr: ' + crashed.stderr).toBe('SIGKILL');
  const afterCrash = await calls(scenario.runKey);
  const recovered = runChild('recover', scenario);
  expect(recovered.status, 'recovery stdout: ' + recovered.stdout + '\nstderr: ' + recovered.stderr).toBe(0);
  const line = recovered.stdout.split('\n').find((candidate) => candidate.startsWith('DURABLE_OUTCOME '));
  expect(line, 'recovery stdout: ' + recovered.stdout).toBeDefined();
  const parsed = JSON.parse(line!.slice('DURABLE_OUTCOME '.length)) as {
    outcome: Record<string, unknown>;
    status: { status: string; steps: Array<{ name: string }> };
  };
  return { afterCrash, ...parsed };
}

const key = (label: string) => label + '-' + randomBytes(4).toString('hex');

describe('durable tool orchestration survives real producer death (P-019)', () => {
  it('code:run returns before its two-minute script completes and recovers the original terminal result (MC-P026-SCRIPT)', async () => {
    const runKey = key('code-two-minute');
    const script = '/*' + 'large script '.repeat(2500) + `*/
      const first = await tools.call('probe:read', { phase: 'before' });
      await tools.call('runtime:sleep', { ms: 120000 });
      const last = await tools.call('probe:after', { phase: 'after' });
      return { first: first.tool, last: last.tool };`;
    const child = runChild('code', { runKey, script, crashTarget: '' });
    expect(child.status, child.stdout + '\n' + child.stderr).toBe(0);
    const line = child.stdout.split('\n').find(row => row.startsWith('DURABLE_CODE_OUTCOME '));
    expect(line, child.stdout).toBeDefined();
    const proof = JSON.parse(line!.slice('DURABLE_CODE_OUTCOME '.length));
    expect(proof.admissionElapsedMs).toBeLessThan(50_000);
    expect(proof.elapsedMs).toBeGreaterThanOrEqual(120_000);
    expect(proof.result).toMatchObject({ ok: true, durableRun: {
      workflowId: proof.workflowId, status: 'SUCCESS', outcome: { status: 'succeeded',
        summary: { first: 'probe:read', last: 'probe:after' } },
    } });
    expect((await calls(runKey)).map(row => row.tool)).toEqual(['probe:read', 'probe:after']);
    expect((await stepNames(runKey)).filter(name => name === 'tool:0:probe:read')).toHaveLength(1);
  }, 300_000);

  it('reuses recorded steps and recorded time, and resumes the pending registered-idempotent write', async () => {
    const scenario: Scenario = {
      runKey: key('resume'),
      crashTarget: 'probe:put',
      script: `const t = await tools.call('runtime:now', {});
        const a = await tools.call('probe:read', { k: 1 });
        await tools.call('runtime:sleep', { ms: 20 });
        const b = await tools.call('probe:put', { k: 1, at: t.epochMs });
        const c = await tools.call('probe:after', { k: 1 });
        return { at: t.epochMs, a: a.tool, b: b.tool, c: c.tool };`,
    };
    const { afterCrash, outcome, status } = await crashThenRecover(scenario);
    expect(afterCrash.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
    ]);

    const all = await calls(scenario.runKey);
    // The recorded read is NOT dispatched again; the pending idempotent write re-executes once;
    // the step after it runs for the first time.
    expect(all.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
      ['probe:put', 'recover'],
      ['probe:after', 'recover'],
    ]);
    // Recorded time is replayed: both attempts of the write saw the SAME runtime:now value.
    const puts = all.filter((row) => row.tool === 'probe:put');
    const firstAt = puts[0]!.args.at;
    expect(typeof firstAt).toBe('number');
    expect(puts[1]!.args.at).toBe(firstAt);
    // The nested idempotency identity is stable across recovery, so a registered-idempotent
    // write dedupes against its first attempt.
    expect(puts[0]!.key).toBeTruthy();
    expect(puts[1]!.key).toBe(puts[0]!.key);

    expect(outcome.status).toBe('succeeded');
    expect(outcome.summary).toEqual({ at: firstAt, a: 'probe:read', b: 'probe:put', c: 'probe:after' });
    expect(status.status).toBe('SUCCESS');
    // One checkpointed DBOS step per nested call — never the whole script as one step.
    const names = await stepNames(scenario.runKey);
    expect(names).toEqual(expect.arrayContaining([
      'runtime:0:runtime:now',
      'tool:1:probe:read',
      'tool:3:probe:put',
      'tool:4:probe:after',
    ]));
    expect(names.filter((name) => name === 'tool:1:probe:read')).toHaveLength(1);
  }, 400_000);

  it('stops an uncertain in-flight write for reconciliation instead of dispatching it again', async () => {
    const scenario: Scenario = {
      runKey: key('uncertain'),
      crashTarget: 'probe:send',
      script: `const a = await tools.call('probe:read', { k: 2 });
        const b = await tools.call('probe:send', { k: 2 });
        const c = await tools.call('probe:after', { k: 2 });
        return { a: a.tool, b: b.tool, c: c.tool };`,
    };
    const { afterCrash, outcome, status } = await crashThenRecover(scenario);
    expect(afterCrash.map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:send', 'crash'],
    ]);
    // Neither the uncertain write nor anything after it is dispatched on recovery.
    expect((await calls(scenario.runKey)).map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:send', 'crash'],
    ]);
    expect(outcome.status).toBe('needs-reconciliation');
    expect(outcome.reconciliation).toMatchObject({ ordinal: 1, tool: 'probe:send' });
    expect(status.status).toBe('SUCCESS');
    const names = await stepNames(scenario.runKey);
    expect(names).toEqual(expect.arrayContaining(['intent:1:probe:send', 'tool:1:probe:send']));
    expect(names).not.toContain('tool:2:probe:after');
  }, 400_000);

  it('rechecks the caller\'s current allowlist before a recovered live dispatch', async () => {
    const scenario: Scenario = {
      runKey: key('revoked'),
      crashTarget: 'probe:put',
      revoke: 'probe:put',
      script: `const a = await tools.call('probe:read', { k: 3 });
        const b = await tools.call('probe:put', { k: 3 });
        return { a: a.tool, b: b.tool };`,
    };
    const { outcome } = await crashThenRecover(scenario);
    // The revoked write is refused at recovery time: no recovered dispatch happens.
    expect((await calls(scenario.runKey)).map((row) => [row.tool, row.mode])).toEqual([
      ['probe:read', 'crash'],
      ['probe:put', 'crash'],
    ]);
    expect(outcome.status).toBe('failed');
    expect(String(outcome.error)).toMatch(/not allowed for role worker/);
  }, 400_000);
});
