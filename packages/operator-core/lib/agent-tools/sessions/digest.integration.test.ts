/**
 * WI-6843 — sessions:digest must not materialize session_turns.text in its
 * multi-use `scoped` CTE. This real-Postgres fixture compares the optimized
 * handler with the legacy query's output, and includes a same-key row in an
 * excluded workspace so omitting workspace_id from the text join is observable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { applyDisclosureLedgerForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

vi.mock('./_shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionSearchEnabled: vi.fn(async () => true),
}));

const digestTool = (await import('./digest')).default;

interface LegacyRow {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  tool_call_count: number | null;
  kickoff_text: string | null;
  closing_text: string | null;
  total_matching: number;
}

interface Digest {
  source_kind: string;
  session_id: string;
  turns: number;
  prompt_count: number;
  owner: string | null;
  harness_slug: string | null;
  cwd: string | null;
  first_ts: string | null;
  last_ts: string | null;
  tool_call_count: number | null;
  kickoff: string | null;
  closing: string | null;
}

const WORKSPACE = 'ws-fixture';
let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('sessions-digest');
  sql = db.sql;
  await sql.unsafe(`
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL DEFAULT 'default',
      source_kind text NOT NULL,
      session_id text NOT NULL,
      turn_idx integer NOT NULL,
      ts timestamptz,
      owner text,
      harness_slug text,
      cwd text,
      speaker text NOT NULL,
      text text NOT NULL,
      ingested_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
    );
    CREATE TABLE harness_shared.session_ingest_state (
      source_kind text NOT NULL,
      file_path text NOT NULL,
      session_id text,
      tool_call_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (source_kind, file_path)
    );
  `);
  await applyDisclosureLedgerForTest(sql); // D-006 reader rule (WI-10005570)
  await sql`
    INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, owner, harness_slug, cwd, speaker, text)
    VALUES
      (${WORKSPACE}, 'codex', 'alpha', 0, '2026-01-01T00:00:00Z', 'su-alpha', 'papercusp', '/repo/a', 'user', 'alpha kickoff'),
      (${WORKSPACE}, 'codex', 'alpha', 1, '2026-01-01T00:01:00Z', 'su-alpha', 'papercusp', '/repo/a', 'assistant', 'alpha middle'),
      (${WORKSPACE}, 'codex', 'alpha', 2, '2026-01-01T00:02:00Z', 'su-alpha', 'papercusp', '/repo/a', 'user', 'alpha follow-up'),
      (${WORKSPACE}, 'codex', 'alpha', 3, '2026-01-01T00:03:00Z', 'su-alpha', 'papercusp', '/repo/a', 'assistant', 'alpha closing'),
      ('default', 'claude', 'beta', 0, '2026-01-02T00:00:00Z', 'su-beta', 'papercusp', '/repo/b', 'user', 'beta kickoff'),
      ('default', 'claude', 'beta', 1, '2026-01-02T00:01:00Z', 'su-beta', 'papercusp', '/repo/b', 'assistant', 'beta closing'),
      ('ws-excluded', 'codex', 'alpha', 0, '2026-01-03T00:00:00Z', 'su-decoy', 'other', '/repo/decoy', 'user', 'WRONG decoy kickoff'),
      ('ws-excluded', 'codex', 'alpha', 3, '2026-01-03T00:03:00Z', 'su-decoy', 'other', '/repo/decoy', 'assistant', 'WRONG decoy closing')
  `;
  await sql`
    INSERT INTO harness_shared.session_ingest_state
      (source_kind, file_path, session_id, tool_call_count)
    VALUES
      ('codex', '/alpha-1.jsonl', 'alpha', 3),
      ('codex', '/alpha-2.jsonl', 'alpha', 4),
      ('claude', '/beta.jsonl', 'beta', 2)
  `;
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

async function callDigest(): Promise<{ count: number; total: number; digests: Digest[] }> {
  const result = await (
    digestTool as unknown as {
      handler: (
        args: unknown,
        ctx: unknown,
      ) => Promise<{ data: { count: number; total: number; digests: Digest[] } }>;
    }
  ).handler({ limit: 30 }, { workspaceId: WORKSPACE, tx: sql });
  return result.data;
}

async function legacyRows(): Promise<LegacyRow[]> {
  return sql<LegacyRow[]>`
    WITH scoped AS (
      SELECT *
        FROM harness_shared.session_turns
       WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
    ),
    agg AS (
      SELECT source_kind, session_id, count(*)::int AS turns,
             count(*) FILTER (WHERE speaker = 'user')::int AS prompt_count,
             max(owner) AS owner, max(harness_slug) AS harness_slug, max(cwd) AS cwd,
             min(ts) AS first_ts_raw, max(ts) AS last_ts_raw
        FROM scoped
       GROUP BY source_kind, session_id
    ),
    kickoff AS (
      SELECT DISTINCT ON (source_kind, session_id) source_kind, session_id, text
        FROM scoped WHERE speaker = 'user'
       ORDER BY source_kind, session_id, turn_idx ASC
    ),
    closing AS (
      SELECT DISTINCT ON (source_kind, session_id) source_kind, session_id, text
        FROM scoped WHERE speaker = 'assistant'
       ORDER BY source_kind, session_id, turn_idx DESC
    ),
    state_agg AS (
      SELECT source_kind, session_id, sum(tool_call_count)::int AS tool_call_count
        FROM harness_shared.session_ingest_state
       WHERE session_id IS NOT NULL
       GROUP BY source_kind, session_id
    )
    SELECT a.source_kind, a.session_id, a.turns, a.prompt_count,
           a.owner, a.harness_slug, a.cwd,
           to_json(a.first_ts_raw) #>> '{}' AS first_ts,
           to_json(a.last_ts_raw) #>> '{}' AS last_ts,
           s.tool_call_count,
           k.text AS kickoff_text,
           c.text AS closing_text,
           count(*) OVER ()::int AS total_matching
      FROM agg a
      LEFT JOIN kickoff k USING (source_kind, session_id)
      LEFT JOIN closing c USING (source_kind, session_id)
      LEFT JOIN state_agg s USING (source_kind, session_id)
     ORDER BY a.last_ts_raw DESC NULLS LAST
     LIMIT 30
  `;
}

describe('sessions:digest narrow CTE + primary-key text join (WI-6843)', () => {
  it('preserves the legacy digest output while excluding same-key text from another workspace', async () => {
    const [actual, legacy] = await Promise.all([callDigest(), legacyRows()]);
    const expected = legacy.map((row) => ({
      source_kind: row.source_kind,
      session_id: row.session_id,
      turns: row.turns,
      prompt_count: row.prompt_count,
      owner: row.owner,
      harness_slug: row.harness_slug,
      cwd: row.cwd,
      first_ts: row.first_ts,
      last_ts: row.last_ts,
      tool_call_count: row.tool_call_count,
      kickoff: row.kickoff_text,
      closing: row.closing_text,
    }));

    expect(actual.total).toBe(legacy[0]!.total_matching);
    expect(actual.count).toBe(legacy.length);
    expect(actual.digests).toMatchObject(expected);
    expect(actual.digests.find((row) => row.session_id === 'alpha')).toMatchObject({
      kickoff: 'alpha kickoff',
      closing: 'alpha closing',
      tool_call_count: 7,
    });
    expect(JSON.stringify(actual.digests)).not.toContain('WRONG decoy');
  });
});
