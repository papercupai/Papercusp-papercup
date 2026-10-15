import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

describe('ordinary PostgreSQL endpoint isolation', () => {
  it('removes inherited live product pins and the real resolver queries only the owned server', async () => {
    const pins = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'];
    const child = `
      (async () => {
        const assert = require('node:assert/strict');
        const pins = ${JSON.stringify(pins)};
        // Refuse before importing or connecting if an ambient product endpoint survived.
        // Ordinary mode must also leave env-resolution tests free to set their own pins.
        for (const key of pins) assert.equal(process.env[key], undefined, key + ' must be removed');
        const port = Number(process.env.PAPERCUSP_PG_PORT);
        assert.ok(port > 0 && port !== 5432);
        assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
        const db = await import('./libs/papercusp/libs/db/src/connection.ts');
        const { getOrgPg, _resolveUrlsForTests } = { ...db.default, ...db };
        const urls = _resolveUrlsForTests();
        assert.equal(new URL(urls.admin).port, String(port));
        assert.equal(new URL(urls.app).port, String(port));
        const { sql } = getOrgPg();
        try {
          const [row] = await sql.unsafe("SELECT inet_server_port() AS port, current_database() AS database, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('full_page_writes') AS full_page_writes");
          assert.equal(row.port, port);
          assert.equal(row.database, 'papercusp');
          // A disposable cluster must not inherit production crash-durability:
          // its final checkpoint otherwise flushes thousands of discarded files.
          for (const key of ['fsync', 'synchronous_commit', 'full_page_writes']) {
            assert.equal(row[key], 'off', key + ' must use the maintained disposable-PG policy');
          }
          console.log('ORDINARY_PRIVATE_PG_RESULT=' + JSON.stringify(row));
        } finally { await sql.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--', process.execPath, '--import', 'tsx', '-e', child], {
      cwd: root,
      env: { ...process.env, ...Object.fromEntries(pins.map(key => [key, 'postgresql://unused@localhost:5432/ambient'])) },
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find(line => line.startsWith('ORDINARY_PRIVATE_PG_RESULT='));
    expect(line).toBeDefined();
    const result = JSON.parse(line!.slice('ORDINARY_PRIVATE_PG_RESULT='.length));
    expect(result.database).toBe('papercusp');
    expect(result).toMatchObject({ fsync: 'off', synchronous_commit: 'off', full_page_writes: 'off' });
    expect(result.port).toBeGreaterThan(0);
    expect(result.port).not.toBe(5432);
    const dataDir = stdout.match(/booting throwaway PG[^\n]*\(datadir ([^\)]+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
  }, 200_000);
});

describe('private PostgreSQL pool admission', () => {
  it('bounds non-Vitest org pools to the owned server and serves a concurrent request burst without admission refusals', async () => {
    const child = `
      (async () => {
        const assert = require('node:assert/strict');
        assert.equal(process.env.VITEST, undefined);
        const db = await import('./libs/papercusp/libs/db/src/connection.ts');
        const { getOrgPg, processConnectionCeiling } = { ...db.default, ...db };
        const { sql } = getOrgPg();
        try {
          const [settings] = await sql.unsafe("SELECT current_setting('max_connections')::int AS capacity, current_setting('superuser_reserved_connections')::int AS reserved");
          const ceiling = processConnectionCeiling();
          assert.ok(ceiling.poolMax >= 2, 'nested requests need more than one slot');
          assert.ok(ceiling.poolMax * 2 * 3 + 13 * 3 + 32 + settings.reserved <= settings.capacity,
            JSON.stringify({ settings, ceiling }));
          await Promise.all(Array.from({ length: 12 }, () => sql.unsafe('SELECT pg_sleep(0.02)')));
          console.log('PRIVATE_POOL_ADMISSION_CONTROL=' + JSON.stringify({ settings, ceiling, completed: 12 }));
        } finally { await sql.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const { stdout, stderr } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '-e', child], {
      cwd: root, env: { ...process.env, PAPERCUSP_DB_POOL_MAX: '1000' },
      timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find(line => line.startsWith('PRIVATE_POOL_ADMISSION_CONTROL='));
    expect(line, stderr.slice(-1000)).toBeDefined();
    const result = JSON.parse(line!.slice('PRIVATE_POOL_ADMISSION_CONTROL='.length));
    expect(result.completed).toBe(12);
    expect(result.settings.capacity).toBe(100);
    expect(result.ceiling.poolMax).toBeLessThanOrEqual(4);
    expect(stdout + stderr).not.toContain('remaining connection slots');
    expect(stdout).toContain('"runtimeRemoved":true,"pgDataRemoved":true');
  }, 200_000);
});

describe('isolated PostgreSQL mutation evidence', () => {
  it.each([true, false])('keeps committed-source receipts optional across the private runtime (configured=%s)', async configured => {
    const directory = mkdtempSync(join(tmpdir(), 'private-pg-source-audit-'));
    const auditPath = join(directory, 'load-receipts.jsonl');
    const env = { ...process.env };
    if (configured) env.PAPERCUSP_COMMITTED_SOURCE_AUDIT = auditPath;
    else delete env.PAPERCUSP_COMMITTED_SOURCE_AUDIT;
    env.PAPERCUSP_SUBSTRATE_IPC_SOCKET = '/ambient/operator.sock';
    const child = `
      import assert from 'node:assert/strict';
      assert.equal(process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET, undefined);
      assert.equal(process.env.PAPERCUSP_COMMITTED_SOURCE_AUDIT, ${JSON.stringify(configured ? auditPath : undefined)});
      await import('./scripts/lib/pg-url.mjs');
      console.log('PRIVATE_SOURCE_AUDIT_RESULT=' + JSON.stringify({ pid: process.pid }));
    `;
    try {
      const { stdout } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
        '--isolated-runtime', '--', process.execPath,
        '--import', join(root, 'scripts/lib/committed-source-loader.mjs'),
        '--input-type=module', '-e', child], {
        cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      });
      const line = stdout.split('\n').find(line => line.startsWith('PRIVATE_SOURCE_AUDIT_RESULT='));
      expect(line).toBeDefined();
      const { pid } = JSON.parse(line!.slice('PRIVATE_SOURCE_AUDIT_RESULT='.length));
      if (configured) {
        const records = readFileSync(auditPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(records.find(record => record.pid === pid && record.file === join(root, 'scripts/lib/pg-url.mjs'))).toMatchObject({
          schemaVersion: 'committed-source-load-receipt-v1', boundary: 'node-esm-load-return',
          returnedSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else {
        expect(existsSync(auditPath)).toBe(false);
      }
      expect(stdout).toContain('"runtimeRemoved":true,"pgDataRemoved":true');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 200_000);

  it('preserves reporter provenance while replacing ambient product endpoints and identity', async () => {
    const reporterScope = {
      PAPERCUSP_TEST_RUN_HARNESS: 'reporter-harness',
      PAPERCUSP_TEST_RUN_WORKSPACE: 'reporter-workspace',
    };
    const probe = {
      PAPERCUSP_MUTATION_PROBE: '1',
      PAPERCUSP_MUTATION_PHASE: 'mutant',
      PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT: root,
      PAPERCUSP_MUTATION_PROBE_SUBJECT: join(root, 'scripts/with-test-pg.mjs'),
    };
    const child = `
      const keys = ${JSON.stringify(Object.keys(probe))};
      const provenance = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const reporterKeys = ${JSON.stringify(['PAPERCUSP_TEST_RUN_HARNESS', 'PAPERCUSP_TEST_RUN_WORKSPACE'])};
      const reporterScope = Object.fromEntries(reporterKeys.map(key => [key, process.env[key]]));
      const privateDatabase = new URL(process.env.HARNESS_ADMIN_DATABASE_URL).port !== '5432';
      console.log('TEST_PROVENANCE_ENV_RESULT=' + JSON.stringify({
        provenance, reporterScope, privateDatabase,
        isolatedWorkspace: process.env.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'),
        reporterWorkspaceDiffersFromProduct: process.env.PAPERCUSP_TEST_RUN_WORKSPACE !== process.env.PAPERCUSP_WORKSPACE_ID,
        ambientSocketRemoved: process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET === undefined,
        ambientEndpointReplaced: process.env.PAPERCUSP_OPERATOR_URL !== 'http://ambient.invalid:3070',
      }));
    `;
    const { stdout } = await run(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e', child], {
      cwd: root,
      env: { ...process.env, ...probe, ...reporterScope,
        PAPERCUSP_WORKSPACE_ID: 'ambient-workspace',
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/ambient/operator.sock',
        PAPERCUSP_OPERATOR_URL: 'http://ambient.invalid:3070',
        HARNESS_ADMIN_DATABASE_URL: 'postgresql://unused@localhost:5432/ambient',
      },
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const line = stdout.split('\n').find(line => line.startsWith('TEST_PROVENANCE_ENV_RESULT='));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice('TEST_PROVENANCE_ENV_RESULT='.length))).toEqual({
      provenance: probe, reporterScope, privateDatabase: true, isolatedWorkspace: true,
      reporterWorkspaceDiffersFromProduct: true,
      ambientSocketRemoved: true, ambientEndpointReplaced: true,
    });
    const dataDir = stdout.match(/booting throwaway PG[^\n]*\(datadir ([^\)]+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
  }, 200_000);
});

describe('isolated PostgreSQL signal cleanup', () => {
  it.each(['supervisor', 'process-group'] as const)('finishes owned cleanup after SIGINT to %s', async target => {
    const child = spawn(process.execPath, [join(root, 'scripts/with-test-pg.mjs'),
      '--isolated-runtime', '--', process.execPath, '-e',
      "console.log('SIGNAL_CLEANUP_WORKER_READY');setInterval(() => {}, 1000)"], {
      // Keep owned PG process/I/O observations in assertion failures; elapsed
      // stage receipts alone cannot distinguish a checkpoint from a deadlock.
      cwd: root, env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1' },
      detached: target === 'process-group', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', fail);
      child.once('close', (code, signal) => done({ code, signal }));
    });
    let finished = false;
    try {
      const deadline = Date.now() + 180_000;
      while (!output.includes('SIGNAL_CLEANUP_WORKER_READY') && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await new Promise(done => setTimeout(done, 100));
      }
      expect(output, errors.slice(-1500)).toContain('SIGNAL_CLEANUP_WORKER_READY');
      if (target === 'process-group') process.kill(-child.pid!, 'SIGINT');
      else child.kill('SIGINT');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([closed, new Promise<never>((_, fail) => {
        timer = setTimeout(() => fail(new Error('Private signal cleanup did not close: ' + output.slice(-2000) + errors.slice(-500))), 30_000);
      })]).finally(() => clearTimeout(timer));
      finished = true;
      expect(result.code === 130 || result.signal === 'SIGINT').toBe(true);
      const receipt = output.split('\n').filter(line => line.startsWith('[with-test-pg] cleanup '))
        .map(line => JSON.parse(line.slice('[with-test-pg] cleanup '.length)))
        .find(row => row.stage === 'complete');
      expect(receipt, output.slice(-2000) + errors.slice(-500)).toMatchObject({ runtimeRemoved: true, pgDataRemoved: true });
      expect(existsSync(receipt.dataDir)).toBe(false);
      expect(existsSync(receipt.runtimeRoot)).toBe(false);
    } finally {
      if (!finished && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => {
          try { target === 'process-group' ? process.kill(-child.pid!, 'SIGKILL') : child.kill('SIGKILL'); } catch { /* already closed */ }
        }, 5000);
        await closed.finally(() => clearTimeout(timer));
      }
    }
  }, 220_000);
});
