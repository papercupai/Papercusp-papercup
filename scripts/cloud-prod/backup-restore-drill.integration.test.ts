/** Real Postgres restore instrument. The Cloud SQL PITR drill runs separately
 * through backup-restore-drill.ts; the affected suite creates only isolated PG.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { judgeRestore } from './backup-restore-drill';

const run = promisify(execFile);
let pg: DedicatedNativePg;
let admin: Sql;
let source: Sql;
let target: Sql;
let scratchDir: string;

describe('restore instrument against real Postgres', () => {
  beforeAll(async () => {
    pg = await startDedicatedNativePg();
    admin = postgres(pg.getConnectionUri(), { onnotice: () => {} });
    await admin.unsafe('CREATE DATABASE p009_source');
    await admin.unsafe('CREATE DATABASE p009_target');
    const sourceUrl = new URL(pg.getConnectionUri()); sourceUrl.pathname = '/p009_source';
    const targetUrl = new URL(pg.getConnectionUri()); targetUrl.pathname = '/p009_target';
    source = postgres(sourceUrl.toString(), { onnotice: () => {} });
    target = postgres(targetUrl.toString(), { onnotice: () => {} });
    scratchDir = await mkdtemp(join(tmpdir(), 'p009-restore-test-'));
  }, 120_000);
  afterAll(async () => {
    await Promise.all([source?.end({ timeout: 5 }), target?.end({ timeout: 5 }), admin?.end({ timeout: 5 })]);
    await pg?.stop();
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true });
  });

  it('reads restored committed data and detects the missing-row counterexample', async () => {
    const started = Date.now();
    await source.unsafe("CREATE TABLE canary(marker text PRIMARY KEY); INSERT INTO canary VALUES ('before')");
    const dump = join(scratchDir, 'snapshot.dump');
    const sourceUrl = new URL(pg.getConnectionUri()); sourceUrl.pathname = '/p009_source';
    const targetUrl = new URL(pg.getConnectionUri()); targetUrl.pathname = '/p009_target';
    await run(join(resolveNativePgBinDir(), 'pg_dump'), ['--format=custom', '--file', dump, sourceUrl.toString()], { timeout: 60_000 });
    await source.unsafe("INSERT INTO canary VALUES ('after')");
    await run(join(resolveNativePgBinDir(), 'pg_restore'), ['--dbname', targetUrl.toString(), dump], { timeout: 60_000 });
    const observe = async () => {
      const [row] = await target.unsafe("SELECT count(*) FILTER (WHERE marker='before')::int AS before, count(*) FILTER (WHERE marker='after')::int AS after FROM canary");
      return { beforeRows: Number(row.before), afterRows: Number(row.after), rtoMs: Date.now()-started, rpoMs: 0 };
    };
    expect(judgeRestore(await observe())).toBe(true);
    await target.unsafe("DELETE FROM canary WHERE marker='before'");
    expect(judgeRestore(await observe())).toBe(false);
  }, 120_000);
});

