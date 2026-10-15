import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');

describe('actual isolated supervisor migration custody', () => {
  it('seeds real PostgreSQL and restarts on the same snapshot despite a late unreserved migration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'private-migration-wiring-'));
    const source = join(directory, 'candidate-sql');
    const audit = join(directory, 'source-loads.jsonl');
    cpSync(join(root, 'libs/papercusp/libs/db/sql'), source, { recursive: true });
    const entry = join(root, 'scripts/with-test-pg.mjs');
    // Execute the product's resolver and migration runner in separate boot
    // processes, against the actual DB seeded by the maintained supervisor.
    const boot = `
      import assert from 'node:assert/strict';
      import postgres from 'postgres';
      import { resolveSqlDir } from './packages/operator-core/lib/migration-drift.ts';
      import { applyPendingMigrations } from '@papercusp/embedded-postgres-server/src/migration-runner.js';
      const sqlDir = resolveSqlDir();
      assert.equal(sqlDir, process.env.PAPERCUSP_PG_SQL_DIR);
      const sql = postgres(process.env.HARNESS_ADMIN_DATABASE_URL, { max: 1 });
      try {
        const result = await applyPendingMigrations({ client: sql, sqlDir, continueOnError: true,
          beforeApply: file => { throw new Error('Unexpected pending migration: ' + file); } });
        assert.deepEqual(result.failed, []);
        assert.equal(result.appliedCount, 0);
        console.log('MIGRATION_BOOT=' + JSON.stringify({ sqlDir, appliedCount: result.appliedCount }));
      } finally { await sql.end(); }
    `;
    const child = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const { execFileSync } = require('node:child_process');
      const sqlDir = process.env.PAPERCUSP_PG_SQL_DIR;
      assert.ok(sqlDir && sqlDir !== ${JSON.stringify(source)});
      assert.equal(sqlDir, path.join(path.dirname(process.env.HOME), 'db-sql'));
      const files = fs.readdirSync(sqlDir).sort();
      const boot = () => execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        ${JSON.stringify(boot)}], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60000 });
      process.stdout.write(boot());
      fs.writeFileSync(path.join(${JSON.stringify(source)}, '999999-late-unreserved.sql'),
        'SELECT definitely_missing_function_for_late_migration();');
      assert.ok(fs.existsSync(path.join(${JSON.stringify(source)}, '999999-late-unreserved.sql')));
      assert.deepEqual(fs.readdirSync(sqlDir).sort(), files);
      process.stdout.write(boot());
      console.log('MIGRATION_SNAPSHOT_WIRING=' + JSON.stringify({ sqlDir, files: files.length,
        lateSourcePresent: true, lateSnapshotAbsent: !fs.existsSync(path.join(sqlDir, '999999-late-unreserved.sql')) }));
    `;
    try {
      const { stdout, stderr } = await run(process.execPath, [entry, '--isolated-runtime', '--',
        process.execPath, '-e', child], {
        cwd: root, env: { ...process.env, PAPERCUSP_PG_SQL_DIR: source, PAPERCUSP_COMMITTED_SOURCE_AUDIT: audit },
        timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      });
      const records = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const supervisor = records.find(row => row.file === entry && row.boundary === 'node-esm-load-return');
      expect(supervisor, stderr.slice(-2000)).toBeDefined();
      expect(supervisor.returnedSha256).toBe(createHash('sha256').update(readFileSync(entry)).digest('hex'));
      const receipt = JSON.parse(stdout.split('\n').find(line => line.startsWith('MIGRATION_SNAPSHOT_WIRING='))!
        .slice('MIGRATION_SNAPSHOT_WIRING='.length));
      expect(stdout).toContain('[with-test-pg] migrations: ' + receipt.sqlDir);
      expect(stdout.split('\n').filter(line => line.startsWith('MIGRATION_BOOT=')).map(line => JSON.parse(line.slice(15))))
        .toEqual([{ sqlDir: receipt.sqlDir, appliedCount: 0 }, { sqlDir: receipt.sqlDir, appliedCount: 0 }]);
      expect(receipt).toMatchObject({ lateSourcePresent: true, lateSnapshotAbsent: true });
      expect(receipt.files).toBeGreaterThan(0);
      expect(stdout).toContain('"runtimeRemoved":true,"pgDataRemoved":true');
      expect(existsSync(receipt.sqlDir)).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 200_000);
});
