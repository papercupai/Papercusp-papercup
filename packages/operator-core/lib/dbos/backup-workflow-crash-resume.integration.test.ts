// @vitest-environment node
/** Real SIGKILL between checkpointed safety snapshot and restore apply. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { getTestPg, teardownTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const childPath = resolve(packageRoot, 'test/_backup-crash-child.ts');
const operationId = 'restore-' + randomBytes(6).toString('hex');
let adminUri: string;
let databaseName: string;
let dsn: string;
let root: string;
let homeDir: string;
let sql: postgres.Sql;

beforeAll(async () => {
  adminUri = await getTestPg();
  databaseName = 'backup_crash_' + randomBytes(5).toString('hex');
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
  await sql.unsafe('CREATE SCHEMA test_backup; CREATE TABLE test_backup.calls (phase text NOT NULL, mode text NOT NULL)');
  root = await mkdtemp(join(tmpdir(), 'backup-crash-p023-'));
  homeDir = join(root, 'home');
  await mkdir(join(homeDir, '.papercusp'), { recursive: true });
  await writeFile(join(homeDir, '.papercusp', 'db-encryption-key'), randomBytes(32).toString('hex'));
  await mkdir(join(root, 'live'), { recursive: true });
  await writeFile(join(root, 'live', 'marker.txt'), 'ORIGINAL');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true });
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

function runChild(mode: 'crash' | 'recover') {
  return spawnSync(process.execPath, ['--import', 'tsx', childPath], {
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: homeDir,
      BACKUP_CRASH_DB_DSN: dsn,
      BACKUP_CRASH_ROOT: root,
      BACKUP_CRASH_OP_ID: operationId,
      BACKUP_CRASH_MODE: mode,
    },
    timeout: 120_000,
    encoding: 'utf8',
  });
}

describe('DBOS backup restore survives real producer death (P-023)', () => {
  it('SIGKILL after safety snapshot reuses its step and original workflow ID on a fresh executor', async () => {
    const crashed = runChild('crash');
    expect(crashed.signal, 'crash child stderr: ' + crashed.stderr).toBe('SIGKILL');
    expect(await readFile(join(root, 'live', 'marker.txt'), 'utf8')).toBe('ORIGINAL');
    const before = await sql.unsafe('SELECT phase, mode FROM test_backup.calls ORDER BY phase, mode');
    expect(before.map((row) => [row.phase, row.mode])).toEqual([
      ['restore-apply', 'crash'],
      ['safety-snapshot', 'crash'],
    ]);

    const recovered = runChild('recover');
    expect(recovered.status, 'recovery stdout: ' + recovered.stdout + '\nstderr: ' + recovered.stderr).toBe(0);
    expect(recovered.stdout).toContain('BACKUP_RECOVERED');
    expect(await readFile(join(root, 'live', 'marker.txt'), 'utf8')).toBe('RESTORED');
    const calls = await sql.unsafe('SELECT phase, mode FROM test_backup.calls ORDER BY phase, mode');
    expect(calls.map((row) => [row.phase, row.mode])).toEqual([
      ['restore-apply', 'crash'],
      ['restore-apply', 'recover'],
      ['safety-snapshot', 'crash'],
    ]);
    const workflowId = 'backup-restore-in-place:ws-p023-crash:' + operationId;
    const workflows = await sql.unsafe(
      'SELECT workflow_uuid, status FROM dbos.workflow_status WHERE workflow_uuid = $1',
      [workflowId],
    );
    expect(workflows).toEqual([{ workflow_uuid: workflowId, status: 'SUCCESS' }]);
  }, 300_000);
});
