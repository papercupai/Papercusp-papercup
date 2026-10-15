import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTestPg } from '@papercusp/test-config/pg';

const root = resolve(__dirname, '../../..');
const probePath = resolve(root, 'docs/evidence/goal-brief-r10-goal-feedback-live-probe-2026-09-29.mts');
const bwrapWorks = spawnSync('bwrap', ['--dev-bind', '/', '/', '--die-with-parent', '--', 'true'], {
  encoding: 'utf8', timeout: 10_000,
}).status === 0;

describe('R-10 live probe database access', () => {
  it('uses the shared script Postgres resolver without privilege elevation', () => {
    const source = readFileSync(probePath, 'utf8');
    expect(source).toContain('connectScriptPg');
    expect(source).toContain('BEGIN READ ONLY');
    expect(source).not.toMatch(/(?:execFileSync|spawnSync)\(['"]sudo['"]/);
  });

  it.skipIf(!bwrapWorks)('can read Postgres in the mutation-probe overlay namespace', async () => {
    const databaseUrl = await getTestPg();
    const pgUrlModule = pathToFileURL(resolve(root, 'scripts/lib/pg-url.mjs')).href;
    const script = `
      const { connectScriptPg } = await import(${JSON.stringify(pgUrlModule)});
      const client = await connectScriptPg();
      try {
        await client.query('BEGIN READ ONLY');
        const result = await client.query("SELECT current_setting('transaction_read_only') AS read_only");
        console.log(JSON.stringify({ readOnly: result.rows[0]?.read_only === 'on' }));
        await client.query('ROLLBACK');
      } finally {
        await client.end();
      }
    `;
    const result = spawnSync('bwrap', [
      '--dev-bind', '/', '/', '--die-with-parent', '--chdir', root, '--',
      process.execPath, '--input-type=module', '-e', script,
    ], {
      cwd: root,
      env: { ...process.env, HARNESS_ADMIN_DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ readOnly: true });
  });
});
