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
    CREATE TABLE harness_shared.psu_pty_host_events (
      id bigserial PRIMARY KEY, workspace_id text, owner_id text, ts timestamptz, kind text
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

async function callDigest(args: Record<string, unknown> = {}): Promise<{ count: number; total: number; digests: Digest[] }> {
  const result = await (
    digestTool as unknown as {
      handler: (
        args: unknown,
        ctx: unknown,
      ) => Promise<{ data: { count: number; total: number; digests: Digest[] } }>;
    }
  ).handler({ limit: 30, ...args }, { workspaceId: WORKSPACE, tx: sql });
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
  it('returns multiple incidents in one session once, with their own prior task and checkpoint', async () => {
    await sql`INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
      VALUES (${WORKSPACE}, 'codex', 'repeat-stop', 0, '2026-05-01T00:00Z', 'user', 'First task'),
             (${WORKSPACE}, 'codex', 'repeat-stop', 1, '2026-05-01T00:01Z', 'assistant', 'First checkpoint'),
             (${WORKSPACE}, 'codex', 'repeat-stop', 2, '2026-05-01T00:02Z', 'assistant', 'API Error: 429 Too many requests'),
             (${WORKSPACE}, 'codex', 'repeat-stop', 3, '2026-05-01T00:03Z', 'user', 'Second task'),
             (${WORKSPACE}, 'codex', 'repeat-stop', 4, '2026-05-01T00:04Z', 'assistant', 'Second checkpoint'),
             (${WORKSPACE}, 'codex', 'repeat-stop', 5, '2026-05-01T00:05Z', 'assistant', '402 Insufficient credits')`;
    try {
      const args = { session: 'repeat-stop', stopKinds: ['billing', 'rate_limit'], limit: 1 };
      const first = await callDigest(args) as any;
      expect(first.digests[0]).toMatchObject({ kickoff: 'Second task', checkpoint: 'Second checkpoint', stopKind: 'billing' });
      // A newly ingested older incident must not move the frozen page boundary.
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, ingested_at, speaker, text)
        VALUES (${WORKSPACE}, 'codex', 'repeat-stop', 6, '2026-05-01T00:04:30Z',
                ${first.coverage.snapshotAt}::timestamptz + interval '1 second', 'assistant', 'API Error: 429 Too many requests')`;
      const second = await callDigest({ ...args, cursor: first.nextCursor }) as any;
      expect(second.digests[0]).toMatchObject({ kickoff: 'First task', checkpoint: 'First checkpoint', stopKind: 'rate_limit' });
      expect(second.digests[0].stopRef).toBe('session_turn:codex:repeat-stop:2');
      expect(second.nextCursor).toBeNull();
    } finally { await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'repeat-stop'`; }
  });

  it('paginates distinct historical provider stops with the task/checkpoint before each incident', async () => {
    const failures = [
      ['quota', "You've hit your session limit"],
      ['authentication', 'API Error: 401 Authentication failed'],
      ['billing', '402 Insufficient credits'],
      ['rate_limit', 'API Error: 429 Too many requests'],
    ];
    for (const [kind, message] of failures) {
      const session = `incident-${kind}`;
      await sql`INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
        VALUES
        (${WORKSPACE}, 'codex', ${session}, 0, '2026-03-01T00:00Z', 'fixture', 'user', 'Original task'),
        (${WORKSPACE}, 'codex', ${session}, 1, '2026-03-01T00:01Z', 'fixture', 'assistant', 'Original progress'),
        (${WORKSPACE}, 'codex', ${session}, 2, '2026-03-01T00:02Z', 'fixture', 'assistant', ${message!}),
        (${WORKSPACE}, 'codex', ${session}, 3, '2026-03-01T00:03Z', 'fixture', 'user', 'Later unrelated task'),
        (${WORKSPACE}, 'codex', ${session}, 4, '2026-03-01T00:04Z', 'fixture', 'assistant', 'Later progress')`;
    }
    try {
      const kinds = failures.map(([kind]) => kind);
      const first = await callDigest({ since: '2026-03-01', until: '2026-03-02', stopKinds: kinds, limit: 2 }) as any;
      const second = await callDigest({ stopKinds: kinds, cursor: first.nextCursor, limit: 2 }) as any;
      const all = [...first.digests, ...second.digests];
      expect(all).toHaveLength(4);
      expect(new Set(all.map((d: any) => d.session_id)).size).toBe(4);
      expect(all.map((d: any) => d.stopKind).sort()).toEqual(kinds.sort());
      for (const digest of all) {
        expect(digest).toMatchObject({ kickoff: 'Original task', checkpoint: 'Original progress' });
        expect(digest.stopRef).toBe(`session_turn:codex:${digest.session_id}:2`);
        expect(digest.kickoffRef).toBe(`session_turn:codex:${digest.session_id}:0`);
        expect(digest.asOf).toContain('2026-03-01T00:02:00');
      }
      expect(second.nextCursor).toBeNull();
      const filtered = await callDigest({ since: '2026-03-01', until: '2026-03-02', stopKinds: ['billing'], limit: 1 }) as any;
      expect(filtered.nextCursor).toBeTypeOf('string');
      expect(filtered.coverage.pageScanned).toBe(1);
    } finally { await sql`DELETE FROM harness_shared.session_turns WHERE session_id LIKE 'incident-%'`; }
  });

  it('reports the census bound without generating an unusable continuation', async () => {
    await sql`INSERT INTO harness_shared.session_turns
      (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
      SELECT ${WORKSPACE}, 'codex', 'census-' || n, 0, '2026-04-01'::timestamptz, 'user', 'Task'
        FROM generate_series(1, 505) n`;
    try {
      let cursor: string | undefined;
      let last: any;
      const seen = new Set<string>();
      for (let page = 0; page < 5; page++) {
        last = await callDigest({ since: page ? undefined : '2026-04-01', until: page ? undefined : '2026-04-02', limit: 100, cursor }) as any;
        for (const d of last.digests) seen.add(d.session_id);
        cursor = last.nextCursor;
      }
      expect(seen.size).toBe(500);
      expect(last).toMatchObject({ hasMore: true, nextCursor: null, coverage: { status: 'window-limit; narrow since/until', candidateSessions: 505 } });
    } finally { await sql`DELETE FROM harness_shared.session_turns WHERE session_id LIKE 'census-%'`; }
  });

  it('freezes a paginated census and rejects changed query/authority/window cursors', async () => {
    const first = await callDigest({ limit: 1, until: '2026-01-02T00:02Z' }) as any;
    expect(first.digests.map((d: Digest) => d.session_id)).toEqual(['beta']);
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await callDigest({ limit: 1, cursor: first.nextCursor }) as any;
    expect(second.digests.map((d: Digest) => d.session_id)).toEqual(['alpha']);
    expect(second.nextCursor).toBeNull();
    expect(second.coverage.status).toBe('complete-for-indexed-transcript-window');
    expect(await callDigest({ cursor: first.nextCursor, owner: 'su-alpha' })).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(await callDigest({ cursor: first.nextCursor, until: '2026-01-04' })).toMatchObject({ ok: false, error: 'invalid_cursor' });
  });

  it('recovers the latest task/checkpoint as of the cutoff and directly links host evidence', async () => {
    await sql`INSERT INTO harness_shared.psu_pty_host_events (workspace_id, owner_id, ts, kind)
      VALUES (${WORKSPACE}, 'su-alpha', '2026-01-01T00:01Z', 'turn-deferred-quota-blocked'),
             ('foreign', 'su-alpha', '2026-01-01T00:01Z', 'quota-block-starvation')`;
    try {
      const result = await callDigest({ session: 'alpha', until: '2026-01-01T00:02:30Z', taskMode: 'as-of', includeHostEvents: true }) as any;
      expect(result.digests[0]).toMatchObject({ kickoff: 'alpha follow-up', checkpoint: 'alpha middle',
        kickoffRef: 'session_turn:codex:alpha:2', checkpointRef: 'session_turn:codex:alpha:1',
        hostCoverage: 'bounded-owner-events; native-session correlation unproven' });
      expect(result.digests[0].hostEvidence).toHaveLength(1);
      expect(result.digests[0].hostEvidence[0].ref).toMatch(/^psu_pty_host_event:/);
    } finally { await sql`TRUNCATE harness_shared.psu_pty_host_events`; }
  });
  it('finds the task after native bootstrap instructions and retains its source without claiming owner provenance', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, owner, speaker, text)
      VALUES
        (${WORKSPACE}, 'codex', 'bootstrap-task', 0, '2026-02-01T00:00Z', 'su-task', 'user', '# AGENTS.md instructions\n<INSTRUCTIONS>Workspace conventions</INSTRUCTIONS>'),
        (${WORKSPACE}, 'codex', 'bootstrap-task', 1, '2026-02-01T00:01Z', 'su-task', 'user', '<environment_context>cwd=/repo</environment_context>'),
        (${WORKSPACE}, 'codex', 'bootstrap-task', 2, '2026-02-01T00:02Z', 'su-task', 'user', 'Find agents interrupted by account limits and summarize their work'),
        (${WORKSPACE}, 'codex', 'bootstrap-task', 3, '2026-02-01T00:03Z', 'su-task', 'assistant', 'Investigating the interrupted sessions')
    `;
    try {
      const result = await callDigest({ session: 'bootstrap-task' });
      expect(result.digests).toHaveLength(1);
      expect(result.digests[0]).toMatchObject({
        kickoff: 'Find agents interrupted by account limits and summarize their work',
        kickoffRef: 'session_turn:codex:bootstrap-task:2',
        kickoffProvenance: 'transcript-candidate',
        bootstrap: '# AGENTS.md instructions <INSTRUCTIONS>Workspace conventions</INSTRUCTIONS>',
      });
    } finally {
      await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'bootstrap-task'`;
    }
  });

  it('keeps an autonomous wake goal instead of dropping the whole machine envelope', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
      VALUES (${WORKSPACE}, 'codex', 'autonomous-task', 0, '2026-02-02T00:00Z', 'user',
        'You are continuing your OWN warm session, toward: Repair account recovery. STATE: running')
    `;
    try {
      const result = await callDigest({ session: 'autonomous-task' });
      expect(result.digests[0]).toMatchObject({ kickoff: 'Repair account recovery', loopGoal: 'Repair account recovery', kickoffProvenance: 'autonomous-goal' });
    } finally {
      await sql`DELETE FROM harness_shared.session_turns WHERE session_id = 'autonomous-task'`;
    }
  });

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
