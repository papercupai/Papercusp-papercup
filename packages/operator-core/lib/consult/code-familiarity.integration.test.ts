/**
 * code-familiarity.integration.test.ts — R-2 of plan
 * code-intel-relevance-routing-2026-10-21: familiarity from the edit and tool
 * ledgers, all-time, editor > reader > untouched.
 *
 * WHY real Postgres: the path matching (exact or `/`-bounded suffix), the
 * all-time count and the statement-timeout degrade are properties of the SQL
 * itself; a fake `sql` would only restate what the statements were meant to do.
 * The fixture tables carry exactly the columns the measurement reads.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { codeAuthorshipScore, familiarityFilePatterns, measureCodeFamiliarity } from './code-familiarity';
import { WORKING_SET_TOOLS } from '../code-intelligence/working-set';

const WS = 'ws-fam';
const FILE = 'packages/operator-core/lib/consult/relevance-router.ts';
let fixtureDb: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'codefam' });
  sql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.edit_attribution_ledger (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text, repo text, file text NOT NULL,
      agent_id text NOT NULL, session_id text, contributor text, work_item_id text, plan_slug text, intent text,
      ts timestamptz NOT NULL DEFAULT now(), repo_root text, acquired_via text, dispatch_call_id text);
    CREATE TABLE harness_shared.tool_invocations (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, harness_slug text, tool_name text NOT NULL,
      coord_owner_id text, args_json jsonb, status text NOT NULL DEFAULT 'ok',
      invoked_at timestamptz NOT NULL DEFAULT now());
  `);
  await sql.unsafe(readFileSync(
    new URL('../../../../libs/papercusp/libs/db/sql/1606-tool-invocations-code-familiarity-index.sql', import.meta.url),
    'utf8',
  ));
  const edit = (agent: string, file: string, ts: string, ws = WS) =>
    sql`INSERT INTO harness_shared.edit_attribution_ledger (workspace_id, agent_id, file, ts) VALUES (${ws}, ${agent}, ${file}, ${ts})`;
  const read = (owner: string, tool: string, args: object, ts: string, status = 'ok') =>
    sql`INSERT INTO harness_shared.tool_invocations (workspace_id, coord_owner_id, tool_name, args_json, invoked_at, status)
        VALUES (${WS}, ${owner}, ${tool}, ${sql.json(args as never)}, ${ts}, ${status})`;
  // editor: two edits, one of them a year old.
  await edit('editor', FILE, '2025-10-01T00:00:00Z');
  await edit('editor', FILE, '2026-10-20T00:00:00Z');
  // old-editor vs new-editor: identical activity, a year apart.
  await edit('old-editor', FILE, '2025-01-01T00:00:00Z');
  await edit('new-editor', FILE, '2026-10-20T00:00:00Z');
  // reader: code reads/queries only, plus a non-code tool call naming the file.
  await read('reader', 'capability:read', { file_path: `/home/x/repo/${FILE}` }, '2026-10-19T00:00:00Z');
  await read('reader', 'lsp:query', { op: 'references', file: FILE }, '2026-10-19T00:00:00Z');
  await read('reader', 'coord:send', { body: FILE }, '2026-10-19T00:00:00Z');
  for (const status of ['error', 'timeout', 'invalid-input', 'role-not-allowed', 'quota-exceeded', 'refused', 'replayed']) {
    await read('failed-reader', 'capability:read', { file_path: FILE }, '2026-10-19T00:00:00Z', status);
    await read('failed-reader', 'lsp:query', { file: FILE }, '2026-10-19T00:00:00Z', status);
  }
  await read('file-reader', 'capability:read', { file_path: '/home/x/repo/src/widget.ts' }, '2026-10-19T00:00:00Z');
  await read('file-reader', 'capability:read', { path: 'src/widget.ts' }, '2026-10-19T00:00:00Z');
  await read('file-reader', 'lsp:query', { file: 'src/widget.ts' }, '2026-10-19T00:00:00Z');
  await read('file-reader', 'graph:query', { paths: ['src/other.ts', 'src/widget.ts'] }, '2026-10-19T00:00:00Z');
  for (const file of ['src/widget.tsx', 'src/widget.ts.backup', 'xsrc/widget.ts']) {
    await read('prefix-reader', 'capability:read', { file_path: file }, '2026-10-19T00:00:00Z');
    await read('prefix-reader', 'graph:query', { paths: [file] }, '2026-10-19T00:00:00Z');
  }
  await read('prefix-reader', 'capability:read', { file_path: 'src/other.ts', note: 'src/widget.ts' }, '2026-10-19T00:00:00Z');
  await read('prefix-reader', 'lsp:query', { file: 'src/other.ts', symbol: 'src/widget.ts' }, '2026-10-19T00:00:00Z');
  // noise: another workspace, another file, a file sharing only a name suffix.
  await edit('untouched', FILE, '2026-10-20T00:00:00Z', 'other-ws');
  await edit('untouched', 'packages/other/relevance-router.ts.bak', '2026-10-20T00:00:00Z');
  await edit('untouched', 'packages/operator-core/lib/consult/xrelevance-router.ts', '2026-10-20T00:00:00Z');
});

afterAll(async () => {
  try { await sql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

describe('measureCodeFamiliarity (R-2)', () => {
  it('scores an editor above a reader above an untouched candidate for the same file', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['editor', 'reader', 'untouched'], files: [FILE] });
    expect(m).toMatchObject({ edits: 'measured', reads: 'measured' });
    expect(m.byOwner.get('editor')).toEqual({ edits: 2, reads: 0 });
    expect(m.byOwner.get('reader')).toEqual({ edits: 0, reads: 2 });
    expect(m.byOwner.get('untouched')).toBeUndefined();
    const score = (o: string) => codeAuthorshipScore(m.byOwner.get(o));
    expect(score('editor')).toBeGreaterThan(score('reader'));
    expect(score('reader')).toBeGreaterThan(score('untouched'));
    expect(score('untouched')).toBe(0);
  });

  it('counts identical activity identically however long ago it happened', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['old-editor', 'new-editor'], files: [FILE] });
    expect(m.byOwner.get('old-editor')).toEqual(m.byOwner.get('new-editor'));
    expect(codeAuthorshipScore(m.byOwner.get('old-editor'))).toBe(codeAuthorshipScore(m.byOwner.get('new-editor')));
  });

  it('matches a partial path from the question as a directory-bounded suffix', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['editor', 'reader', 'untouched'], files: ['consult/relevance-router.ts'] });
    expect(m.byOwner.get('editor')?.edits).toBe(2);
    expect(m.byOwner.get('reader')?.reads).toBe(2);
    expect(m.byOwner.get('untouched')).toBeUndefined();
  });

  it('gives no familiarity credit to failed, refused or replayed code-tool attempts', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['reader', 'failed-reader'], files: [FILE] });
    expect(m.reads).toBe('measured');
    expect(m.byOwner.get('reader')?.reads).toBe(2);
    expect(m.byOwner.get('failed-reader')).toBeUndefined();
    expect(codeAuthorshipScore(m.byOwner.get('failed-reader'))).toBe(0);
  });

  it('matches actual file arguments without crediting filename prefixes or incidental argument text', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['file-reader', 'prefix-reader'], files: ['src/widget.ts'] });
    expect(m.reads).toBe('measured');
    expect(m.byOwner.get('file-reader')).toEqual({ edits: 0, reads: 4 });
    expect(m.byOwner.get('prefix-reader')).toBeUndefined();
  });

  it('uses the composite lookup when one candidate has substantial unrelated tool history', async () => {
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, coord_owner_id, args_json, status)
      SELECT ${WS}, 'papercusp', 'coord:send', 'reader', jsonb_build_object('body', 'unrelated'), 'ok'
        FROM generate_series(1, 20_000)
    `;
    await sql`ANALYZE harness_shared.tool_invocations`;
    const { exact, suffix } = familiarityFilePatterns([FILE]);

    const plan = await sql`
      EXPLAIN (FORMAT JSON)
      SELECT coord_owner_id
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${WS}
         AND tool_name = ANY(${[...WORKING_SET_TOOLS]}::text[])
         AND coord_owner_id = ANY(${['reader']}::text[])
         AND status = 'ok'
         AND EXISTS (
           SELECT 1 FROM (
             SELECT COALESCE(args_json->>'file_path', args_json->>'path') AS file
              WHERE tool_name IN ('capability:read', 'capability:edit', 'capability:write')
             UNION ALL
             SELECT args_json->>'file'
              WHERE tool_name IN ('lsp:query', 'graph:query')
             UNION ALL
             SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(args_json->'paths') = 'array' THEN args_json->'paths' ELSE '[]'::jsonb END)
              WHERE tool_name IN ('lsp:query', 'graph:query')
           ) AS named_files
           WHERE named_files.file = ANY(${exact}::text[]) OR named_files.file LIKE ANY(${suffix}::text[])
         )
    `;
    expect(JSON.stringify(plan[0]?.['QUERY PLAN'])).toContain('tool_invocations_code_familiarity_idx');

    const measured = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['reader'], files: [FILE] });
    expect(measured.reads).toBe('measured');
    expect(measured.byOwner.get('reader')?.reads).toBe(2);
  });

  it('reports the read leg unmeasured, and gives no read credit, when it times out', async () => {
    await sql.unsafe(`CREATE OR REPLACE FUNCTION harness_shared.slow() RETURNS boolean LANGUAGE sql AS 'SELECT pg_sleep(0.2) IS NOT NULL'`);
    await sql.unsafe(`CREATE VIEW harness_shared.tool_invocations_slow AS SELECT * FROM harness_shared.tool_invocations WHERE harness_shared.slow()`);
    await sql.unsafe(`ALTER TABLE harness_shared.tool_invocations RENAME TO tool_invocations_base`);
    await sql.unsafe(`ALTER VIEW harness_shared.tool_invocations_slow RENAME TO tool_invocations`);
    try {
      const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['editor', 'reader'], files: [FILE], readTimeoutMs: 20 });
      expect(m.reads).toBe('unmeasured');
      expect(m.edits).toBe('measured');
      expect(m.byOwner.get('reader')?.reads ?? 0).toBe(0);
      expect(m.byOwner.get('editor')?.edits).toBe(2);
    } finally {
      await sql.unsafe(`DROP VIEW harness_shared.tool_invocations`);
      await sql.unsafe(`ALTER TABLE harness_shared.tool_invocations_base RENAME TO tool_invocations`);
    }
  });

  it('counts only activity strictly before the as-of instant when one is given (offline replay)', async () => {
    const m = await measureCodeFamiliarity(sql, {
      workspaceId: WS, owners: ['editor', 'reader', 'old-editor', 'new-editor'], files: [FILE], before: '2026-10-19T12:00:00Z',
    });
    expect(m).toMatchObject({ edits: 'measured', reads: 'measured' });
    // editor's 2025 edit counts; its 2026-10-20 edit happened after the instant.
    expect(m.byOwner.get('editor')).toEqual({ edits: 1, reads: 0 });
    expect(m.byOwner.get('old-editor')).toEqual({ edits: 1, reads: 0 });
    expect(m.byOwner.get('new-editor')).toBeUndefined();
    // reader's two code reads were at 2026-10-19T00:00Z, before the instant.
    expect(m.byOwner.get('reader')).toEqual({ edits: 0, reads: 2 });
    // The read leg honours the bound too: an instant before those reads drops them.
    const earlier = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['reader'], files: [FILE], before: '2026-10-18T00:00:00Z' });
    expect(earlier.byOwner.get('reader')).toBeUndefined();
  });

  it('runs no query and returns nothing for an empty file set', async () => {
    const m = await measureCodeFamiliarity(sql, { workspaceId: WS, owners: ['editor'], files: [] });
    expect(m.byOwner.size).toBe(0);
  });
});

describe('familiarityFilePatterns', () => {
  it('escapes LIKE metacharacters and strips leading ./', () => {
    expect(familiarityFilePatterns(['./a_b%/c.ts'])).toEqual({ exact: ['a_b%/c.ts'], suffix: ['%/a\\_b\\%/c.ts'] });
  });
});
