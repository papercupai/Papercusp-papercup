import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdirNeedsOverride } from '@papercusp/test-config/tmpdir-guard';
import { startAdmissionTestEnvironment as startEnvironment } from './admission-private-test-pg';
const ledger = 'postgres://ledger@127.0.0.1:5432/test_runs';
const startAdmissionTestEnvironment: typeof startEnvironment = (root, options) => {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'admission-pg-scratch-'));
  roots.push(scratchRoot);
  return startEnvironment(root, { testRunsDbUrl: ledger, scratchRoot, ...options });
};

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(options: { invalidPort?: boolean; cleanupFails?: boolean; noReceipt?: boolean; pgDies?: boolean; sharedTmp?: boolean; guardTmp?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'admission-pg-lease-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@papercupai/papercusp-monorepo' }));
  writeFileSync(join(root, 'scripts/with-test-pg.mjs'), `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    ${options.guardTmp ? `const { ensurePapercuspTmpdir } = await import(${JSON.stringify(new URL('../../../../libs/test-config/src/tmpdir-guard.ts', import.meta.url).href)}); ensurePapercuspTmpdir();` : ''}
    writeFileSync('fixture-tmp', process.env.TMPDIR);
    console.log('bootstrap progress');
    const child = spawn(process.argv[3], process.argv.slice(4), { stdio: 'inherit', env: {
      ...process.env, ${options.sharedTmp ? "TMPDIR: '/tmp/pcv'," : ''} PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://private:secret@127.0.0.1:15432/postgres',
      PAPERCUSP_PG_PORT: '${options.invalidPort ? '15433' : '15432'}', PAPERCUSP_SKIP_PG_DISCOVERY: '1'
    }});
    ${options.noReceipt ? "child.kill('SIGTERM');" : ''}
    ${options.pgDies ? "setTimeout(() => console.log('postgres exited unexpectedly (code=0 signal=null cause=unknown)'), 100);" : ''}
    child.on('exit', () => { writeFileSync('stopped', 'owned fixture removed'); process.exit(${options.cleanupFails ? 1 : 0}); });
  `);
  return root;
}

describe('R6 private test PostgreSQL lifetime', () => {
  it('keeps its production scratch default accepted by the pinned launcher guard', async () => {
    const root = fixture({ guardTmp: true });
    const pg = await startEnvironment(root, { testRunsDbUrl: ledger, timeoutMs: 10_000 });
    try {
      const scratch = readFileSync(join(root, 'fixture-tmp'), 'utf8');
      expect(scratch).toContain('/papercusp-admission-test-environments/pg-');
      expect(tmpdirNeedsOverride(scratch)).toBe(false);
      pg.assertRunning();
    } finally { await pg.stop(); }
    expect(existsSync(readFileSync(join(root, 'fixture-tmp'), 'utf8'))).toBe(false);
  });

  it('refuses an incompatible explicit scratch root before bootstrapping PostgreSQL', async () => {
    const root = fixture();
    await expect(startEnvironment(root, { testRunsDbUrl: ledger, scratchRoot: root }))
      .rejects.toThrow('owned scratch would be relocated');
    expect(existsSync(join(root, 'fixture-tmp'))).toBe(false);
  });

  it('keeps control DB pins untouched, consumes the private receipt, and awaits owned cleanup', async () => {
    const root = fixture();
    const parentEnv = { ...process.env, DATABASE_URL: 'postgres://live@127.0.0.1:5432/control',
      HARNESS_ADMIN_DATABASE_URL: 'postgres://live-admin@127.0.0.1:5432/control' };
    const logs: string[] = [];
    const pg = await startAdmissionTestEnvironment(root, { env: parentEnv, log: line => logs.push(line), timeoutMs: 10_000 });
    try {
      expect(parentEnv.DATABASE_URL).toContain('/control');
      expect(parentEnv.HARNESS_ADMIN_DATABASE_URL).toContain('/control');
      expect(pg.env).toMatchObject({ DATABASE_URL: undefined, HARNESS_ADMIN_DATABASE_URL: undefined,
        PAPERCUSP_PG_PORT: '15432', PAPERCUSP_SKIP_PG_DISCOVERY: '1' });
      expect(pg.env.PAPERCUSP_TEST_PG_ADMIN_URL).toContain('127.0.0.1:15432');
      expect(pg.env.PAPERCUSP_TEST_RUNS_DB_URL).toBe(ledger);
      expect(logs.join('\n')).not.toContain('secret');
      expect(logs).toContain('bootstrap progress');
      pg.assertRunning();
      const scratch = readFileSync(join(root, 'fixture-tmp'), 'utf8');
      expect(scratch.startsWith(root + '/')).toBe(false);
      expect(existsSync(scratch)).toBe(true);
    } finally { await pg.stop(); }
    expect(existsSync(readFileSync(join(root, 'fixture-tmp'), 'utf8'))).toBe(false);
    expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('owned fixture removed');
    await pg.stop();
    expect(() => pg.assertRunning()).toThrow('exited');
  });

  it('refuses a receipt that points at a different server and still cleans up', async () => {
    const root = fixture({ invalidPort: true });
    await expect(startAdmissionTestEnvironment(root, { timeoutMs: 10_000 })).rejects.toThrow('invalid environment receipt');
    expect(readFileSync(join(root, 'stopped'), 'utf8')).toBe('owned fixture removed');
  });

  it('requires successful cleanup even after readiness', async () => {
    const root = fixture({ cleanupFails: true });
    const pg = await startAdmissionTestEnvironment(root, { timeoutMs: 10_000 });
    await expect(pg.stop()).rejects.toThrow('exited');
  });

  it('refuses a wrapper that falls back to shared scratch before admitting tests', async () => {
    const root = fixture({ sharedTmp: true });
    await expect(startAdmissionTestEnvironment(root, { timeoutMs: 10_000 })).rejects.toThrow('invalid environment receipt');
    expect(existsSync(readFileSync(join(root, 'fixture-tmp'), 'utf8'))).toBe(false);
  });

  it('refuses a wrapper that exits before producing readiness', async () => {
    await expect(startAdmissionTestEnvironment(fixture({ noReceipt: true }), { timeoutMs: 10_000 })).rejects.toThrow('exited');
  });

  it('invalidates proof immediately when its postmaster dies and cleans its owned scratch', async () => {
    const root = fixture({ pgDies: true });
    const pg = await startAdmissionTestEnvironment(root, { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(() => pg.assertRunning()).toThrow('postmaster exited'));
    await expect(pg.stop()).rejects.toThrow('postmaster exited');
    expect(existsSync(readFileSync(join(root, 'fixture-tmp'), 'utf8'))).toBe(false);
  });

  it('does not allocate Papercusp fixtures for a foreign application', async () => {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'another-application' }));
    const pg = await startAdmissionTestEnvironment(root);
    expect(pg.env).toEqual({});
    await pg.stop();
  });

  it('refuses a missing durable evidence sink before starting the supervisor', async () => {
    await expect(startEnvironment(fixture(), { env: {} })).rejects.toThrow('durable reporter-only database URL');
  });
});
