/** Real archived-schema/index controls; no corpus measurement or live DB. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';

const run = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  promisify(execFile)(command, args, options);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const helper = join(root, 'scripts/backup/search-bench/prepare-selected-corpus.py');
const functionName = 'harness_shared.active_dependency_blocker_item_ids';
const index = { tablename: 'work_items', indexname: 'work_items_active_dependency_item_ids_idx',
  indexdef: `CREATE INDEX work_items_active_dependency_item_ids_idx ON harness_shared.work_items USING gin (${functionName}(payload)) WHERE (payload ? 'externalBlockers'::text)` };
let pg: DedicatedNativePg;
let admin: Sql;
let scratch: string;
let serial = 0;

async function database() {
  const name = `selected_schema_${serial++}`;
  await admin.unsafe('CREATE DATABASE ' + name);
  const url = new URL(pg.getConnectionUri()); url.pathname = '/' + name;
  const sql = postgres(url.toString(), { onnotice: () => {} });
  return { url: url.toString(), sql };
}

async function archive(options: { functionPresent: boolean; changedTable?: boolean; selectedOnly?: boolean }) {
  const source = await database();
  try {
    await source.sql.unsafe('CREATE SCHEMA harness_shared; CREATE TABLE harness_shared.work_items (payload jsonb' +
      (options.changedTable ? ', added text' : '') + ')');
    if (options.functionPresent) {
      // Use the real function definition responsible for the retained failure.
      const migration = await readFile(join(root, 'libs/papercusp/libs/db/sql/1543-work-items-dependency-ref-ids-idx.sql'), 'utf8');
      await source.sql.unsafe(migration.slice(0, migration.indexOf('CREATE INDEX IF NOT EXISTS')));
      // A function may depend on an unselected relation's composite row type.
      // Function-only TOC selection passed simple fixtures but failed the real
      // archived corpus with a missing agent_facts relation.
      await source.sql.unsafe(`CREATE TABLE harness_shared.agent_facts (fact text);
        CREATE FUNCTION harness_shared.fact_value(row_value harness_shared.agent_facts)
        RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT row_value.fact'`);
    }
    await source.sql.unsafe(`INSERT INTO harness_shared.work_items VALUES ('{"externalBlockers":[{"status":"active","capability":"live-dependency","ref":"WI-123"}]}'${options.changedTable ? ", 'new'" : ''})`);
    const path = join(scratch, `archive-${serial}.dump`);
    await run(join(resolveNativePgBinDir(), 'pg_dump'), ['--format=custom', '--file', path,
      ...(options.selectedOnly ? ['--table=harness_shared.work_items'] : []), source.url]);
    return path;
  } finally { await source.sql.end({ timeout: 5 }); }
}

async function prepare(paths: string[], indexes = [index], restoreData = true) {
  const target = await database();
  const manifest = join(scratch, `manifest-${serial}.json`);
  const receiptPath = join(scratch, `receipt-${serial}.json`);
  await writeFile(manifest, JSON.stringify({ schema: 'harness_shared', extensions: [], indexes,
    archives: paths.map((path, i) => ({ path, tables: i === paths.length - 1 ? ['work_items'] : [] })) }));
  let exitCode = 0;
  try {
    await run('python3', [helper, '--manifest', manifest, '--receipt', receiptPath, ...(restoreData ? ['--restore-data'] : [])], {
      env: { ...process.env, PATH: resolveNativePgBinDir() + delimiter + process.env.PATH,
        PAPERCUSP_TEST_PG_ADMIN_URL: target.url }, timeout: 60_000,
    });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'number') { await target.sql.end({ timeout: 5 }); throw error; }
    exitCode = code;
  }
  try {
    return { ...target, exitCode, receipt: JSON.parse(await readFile(receiptPath, 'utf8')) };
  } catch (error) { await target.sql.end({ timeout: 5 }); throw error; }
}

describe('selected corpus native schema preparation', () => {
  beforeAll(async () => {
    pg = await startDedicatedNativePg();
    admin = postgres(pg.getConnectionUri(), { onnotice: () => {} });
    scratch = await mkdtemp(join(tmpdir(), 'selected-schema-fixture-'));
  }, 120_000);
  afterAll(async () => {
    await admin?.end({ timeout: 5 });
    await pg?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('retains the archived UDF despite table-only data ownership and gates data behind native DDL', async () => {
    const full = await archive({ functionPresent: true });
    const selected = await archive({ functionPresent: true, selectedOnly: true });
    const result = await prepare([full, selected]);
    try {
      expect(result.exitCode, JSON.stringify(result.receipt)).toBe(0);
      expect(result.receipt).toMatchObject({ preflightPassed: true, validatedIndexes: 1, dataRestored: true });
      expect(result.receipt.overlaps).toContainEqual(['TABLE', 'harness_shared', 'work_items']);
      expect(result.receipt.schemaPolicy).toBe('complete-primary-archive-pre-data');
      expect(await result.sql.unsafe("SELECT harness_shared.fact_value(ROW('kept')::harness_shared.agent_facts) AS value")).toEqual([{ value: 'kept' }]);
      expect(result.receipt.phases.indexOf('empty-schema-index-preflight-passed')).toBeLessThan(result.receipt.phases.indexOf('data-restore'));
      expect(await result.sql.unsafe(`SELECT ${functionName}(payload) AS ids FROM harness_shared.work_items`)).toEqual([{ ids: ['WI-123'] }]);
      expect(await result.sql.unsafe("SELECT indexname FROM pg_indexes WHERE schemaname='harness_shared'")).toEqual([]);
    } finally { await result.sql.end({ timeout: 5 }); }
  }, 120_000);

  it('fails for the real missing-function condition before restoring the sentinel data', async () => {
    const missing = await archive({ functionPresent: false });
    const result = await prepare([missing]);
    try {
      expect(result.exitCode).toBe(1);
      expect(result.receipt.preflightPassed).toBe(false);
      expect(result.receipt.failure.message).toContain('active_dependency_blocker_item_ids(jsonb) does not exist');
      expect(result.receipt.phases).not.toContain('data-restore');
      expect(await result.sql.unsafe('SELECT count(*)::int AS rows FROM harness_shared.work_items')).toEqual([{ rows: 0 }]);
    } finally { await result.sql.end({ timeout: 5 }); }
  }, 120_000);

  it('checks the last declared index and rolls back preceding DDL on failure', async () => {
    const full = await archive({ functionPresent: true });
    const result = await prepare([full], [
      { tablename: 'work_items', indexname: 'payload_idx', indexdef: 'CREATE INDEX payload_idx ON harness_shared.work_items USING gin (payload)' },
      { ...index, indexdef: index.indexdef.replace(functionName, 'harness_shared.missing_tail_function') },
    ]);
    try {
      expect(result.exitCode).toBe(1);
      expect(result.receipt.declaredIndexes).toBe(2);
      expect(result.receipt.failure.message).toContain('missing_tail_function');
      expect(result.receipt.phases).not.toContain('data-restore');
      expect(await result.sql.unsafe("SELECT indexname FROM pg_indexes WHERE schemaname='harness_shared'")).toEqual([]);
    } finally { await result.sql.end({ timeout: 5 }); }
  }, 120_000);

  it('rejects conflicting archive table definitions before schema restoration', async () => {
    const full = await archive({ functionPresent: true });
    const changed = await archive({ functionPresent: false, changedTable: true, selectedOnly: true });
    const result = await prepare([full, changed]);
    try {
      expect(result.exitCode).toBe(1);
      expect(result.receipt.failure.message).toContain('archive schema overlap differs');
      expect(result.receipt.phases).not.toContain('schema-restore');
      expect(await result.sql.unsafe("SELECT nspname FROM pg_namespace WHERE nspname='harness_shared'")).toEqual([]);
    } finally { await result.sql.end({ timeout: 5 }); }
  }, 120_000);
});
