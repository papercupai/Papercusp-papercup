/**
 * Real-Postgres coverage for plan session-transcript-exact-fuzzy-search-2026-09-14 P-002
 * (migration 1273 + the deferred build body). Covers the D-005 rule-4 matrix: migration applied
 * twice, index absent / present / invalid, vocabulary absent / mid-build / stale lease /
 * incremental — plus the SPEC-P002-MIGRATION-INDEX probe (replay the migration, inspect the
 * resulting index, EXPLAIN the intended predicate).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  SESSION_SEARCH_INDEXES,
  ISSUE_Q_SEARCH_INDEXES,
  TEST_RUNS_SEARCH_INDEXES,
  CODE_FAMILIARITY_INDEXES,
  SESSION_TURN_PARTS_TABLE,
  SESSION_TURN_TRGM_EXPR,
  SESSION_TURNS_TABLE,
  createIndexConcurrentlySql,
  readSessionSearchReadiness,
  runSessionSearchIndexBuildOnce as runSessionSearchIndexBuildOnceRaw,
  sessionSearchIndexBuildFailureDetails,
  sessionSearchTierAvailability,
  type SessionSearchIndexBuildResult,
  type SessionSearchReadiness,
} from './session-search-index-build';

/**
 * The build never throws for a per-step failure (it records the failure on the entry and carries
 * on), so every test would otherwise read a swallowed SQL error as an unrelated assertion miss.
 * Fail loudly, with the recorded message, the moment any step reports `failed`.
 */
const runSessionSearchIndexBuildOnce: typeof runSessionSearchIndexBuildOnceRaw = async (s, o) => {
  const r = await runSessionSearchIndexBuildOnceRaw(s, o);
  const failed = [...r.indexes, ...r.vocab].filter((e) => e.action === 'failed');
  expect(failed, 'no build step may report failed').toEqual([]);
  return r;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.resolve(here, '../../../libs/papercusp/libs/db/sql');
const M501 = path.join(SQL_DIR, '501-session-turns.sql');
// The migration under test. scripts/mutation-probe.sh points this at a mutated COPY (copy-out mode)
// so the falsifiability of these assertions is proven without ever mutating the tracked file.
const M1273 =
  process.env.P002_MIGRATION_SQL_UNDER_TEST ?? path.join(SQL_DIR, '1273-session-turns-trigram-exact-fuzzy-index.sql');
const M1512 = path.join(SQL_DIR, '1512-work-items-substring-trigram-indexes.sql');
const M1558 = path.join(SQL_DIR, '1558-test-runs-file-path-substring-trigram-index.sql');
const GENERATED_SCHEMA = path.resolve(here, '../../../libs/papercusp/libs/db/src/schema/generated.ts');

const TRGM = 'session_turns_text_trgm_idx';
const TS_DESC = 'session_turns_ts_desc_idx';
const TOOL_RESULT = 'session_turn_parts_owner_workspace_tool_result_idx';
const VOCAB_TRGM = 'session_turn_vocab_word_trgm_idx';
const OPTS = { minFreeDiskBytes: 0 };

let db: FreshPgDb;
let sql: postgres.Sql;

async function indexValid(name: string): Promise<boolean | null> {
  const [r] = await sql<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${name}`;
  return r ? r.valid : null;
}

async function indexValidOn(s: postgres.Sql, name: string): Promise<boolean | null> {
  const [r] = await s<Array<{ valid: boolean }>>`
    SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = ${name}`;
  return r ? r.valid : null;
}

async function dropAllIndexes(): Promise<void> {
  for (const i of SESSION_SEARCH_INDEXES) await sql.unsafe(`DROP INDEX IF EXISTS harness_shared.${i.name}`);
}

async function seed(
  ws: string,
  texts: string[],
  opts: { ingestedOffsetSec?: number } = {},
): Promise<void> {
  const base = Math.floor(Math.random() * 1e9);
  for (let i = 0; i < texts.length; i++) {
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
      VALUES (${ws}, 'claude', ${`s-${base}`}, ${i}, 'user', ${texts[i]!}, now(),
              now() + (${opts.ingestedOffsetSec ?? 0} * interval '1 second'))`;
  }
}

async function vocabOf(ws: string): Promise<Map<string, number>> {
  const rows = await sql<Array<{ word: string; ndoc: number }>>`
    SELECT word, ndoc FROM harness_shared.session_turn_vocab WHERE workspace_id = ${ws}`;
  return new Map(rows.map((r) => [r.word, r.ndoc]));
}

async function explain(query: string): Promise<string> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.unsafe(`EXPLAIN ${query}`);
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('sess-search');
  sql = db.sql;
  // 501 indexes harness_shared.coord_event_log (an unrelated coord leg); stub ONLY that table so
  // the real session_turns DDL replays unmodified.
  await sql.unsafe(
    `CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`,
  );
  await applyMigrationForTest(sql, M501);
  await applyMigrationForTest(sql, M1273);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await sql.unsafe(
    `TRUNCATE harness_shared.session_turns, harness_shared.session_turn_vocab, harness_shared.session_turn_vocab_state`,
  );
  await dropAllIndexes();
});

describe('migration 1273 — replay safety + the index/EXPLAIN probe (SPEC-P002-MIGRATION-INDEX)', () => {
  it('is idempotent: applying it repeatedly on a small table leaves one valid copy of each index', async () => {
    await applyMigrationForTest(sql, M1273);
    await applyMigrationForTest(sql, M1273);
    await applyMigrationForTest(sql, M1273);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBe(true);
    const [{ n }] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'harness_shared'
         AND indexname IN (${TRGM}, ${TS_DESC}, ${VOCAB_TRGM})`;
    expect(n).toBe(3);
  });

  it('a replayed database serves the exact-tier predicate, the newest-first walk and the vocabulary lookup from the indexes', async () => {
    await applyMigrationForTest(sql, M1273);
    await seed('w1', Array.from({ length: 40 }, (_, i) => `turn ${i} about furnishedfinder and papercusp`));
    // The planner needs a vocabulary big enough that the trigram GIN beats the (workspace_id, word)
    // primary key: on a two-row table it correctly prefers the pkey bitmap scan.
    await sql`INSERT INTO harness_shared.session_turn_vocab (workspace_id, word, ndoc)
              SELECT 'w1', 'w' || md5(g::text), 1 FROM generate_series(1, 20000) g`;
    await sql`INSERT INTO harness_shared.session_turn_vocab (workspace_id, word, ndoc)
              VALUES ('w1', 'furnishedfinder', 40), ('w1', 'papercusp', 40)`;
    await sql.unsafe('ANALYZE harness_shared.session_turn_vocab');
    await sql.unsafe('ANALYZE harness_shared.session_turns');

    const exactPlan = await explain(
      `SELECT session_id FROM harness_shared.session_turns
        WHERE ${SESSION_TURN_TRGM_EXPR} LIKE '%furnishedfinder%'`,
    );
    expect(exactPlan).toContain(TRGM);

    const walkPlan = await explain(
      `SELECT session_id FROM harness_shared.session_turns ORDER BY ts DESC NULLS LAST LIMIT 10`,
    );
    expect(walkPlan).toContain(TS_DESC);

    const vocabPlan = await explain(
      `SELECT word FROM harness_shared.session_turn_vocab WHERE workspace_id = 'w1' AND word % 'furnisedfinder'`,
    );
    expect(vocabPlan).toContain(VOCAB_TRGM);
  });

  it('on a table past the size guard creates the tables but NO index (they are left to the deferred job)', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text)
      SELECT 'big', 'claude', 's-big', g, 'user', 'row ' || g FROM generate_series(1, 10001) g`;
    await applyMigrationForTest(sql, M1273);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBeNull();
    const [{ t }] = await sql<Array<{ t: string | null }>>`
      SELECT to_regclass('harness_shared.session_turn_vocab_state')::text AS t`;
    expect(t).toBe('harness_shared.session_turn_vocab_state');
  });

  it('schema drift: the Drizzle projection (generated.ts) declares exactly the columns, nullability and constraints the replayed tables have', async () => {
    const generated = readFileSync(GENERATED_SCHEMA, 'utf8');
    for (const table of ['session_turn_vocab', 'session_turn_vocab_state']) {
      const start = generated.indexOf(`harnessShared.table("${table}", {`);
      expect(start, `${table} must be declared in generated.ts`).toBeGreaterThanOrEqual(0);
      const end = generated.indexOf('\n]);', start);
      const block = generated.slice(start, end);
      // `key: type("col_name")` or, when the column name needs no casing, `col: type()`.
      const declared = new Map<string, boolean>(); // column → declared NOT NULL / primary key
      for (const m of block.matchAll(/^\t(\w+): \w+\((?:"([^"]+)")?[^\n]*$/gm)) {
        const line = m[0];
        declared.set(m[2] ?? m[1]!, /\.notNull\(\)|\.primaryKey\(\)/.test(line));
      }
      const live = await sql<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = ${table}`;
      expect([...declared.keys()].sort(), `${table}: generated.ts columns`).toEqual(
        live.map((c) => c.column_name).sort(),
      );
      for (const c of live) {
        expect(declared.get(c.column_name), `${table}.${c.column_name} NOT NULL agrees`).toBe(
          c.is_nullable === 'NO',
        );
      }
    }
    // The status CHECK is part of the contract the build module and the read path rely on.
    expect(generated).toContain('session_turn_vocab_state_status_check');
    const checks = await sql<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
       WHERE conrelid = 'harness_shared.session_turn_vocab_state'::regclass AND contype = 'c'`;
    expect(checks.map((c) => c.conname)).toContain('session_turn_vocab_state_status_check');
  });

  it('session_turns specs mirror migration 1273 and tool_result index stays online-built', () => {
    const migration = readFileSync(M1273, 'utf8').replace(/\s+/g, ' ');
    // Stage 'windows' indexes live in migration 1334 (pinned in session-turn-windows.integration.test.ts).
    for (const spec of SESSION_SEARCH_INDEXES.filter((s) => s.table === SESSION_TURNS_TABLE)) {
      expect(migration).toContain(spec.name);
      // The migration splits the DDL over string literals; compare the definition body.
      expect(migration.replace(/' \|\| '/g, '')).toContain(spec.definition);
    }
    expect(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0])).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turns_text_trgm_idx ON harness_shared.session_turns USING gin (lower(text) gin_trgm_ops)',
    );
    const toolResultIndex = SESSION_SEARCH_INDEXES.find(
      (spec) => spec.name === 'session_turn_parts_owner_workspace_tool_result_idx',
    )!;
    expect(toolResultIndex.table).toBe(SESSION_TURN_PARTS_TABLE);
    expect(toolResultIndex.definition).toBe("(owner, workspace_id) WHERE part_kind = 'tool_result'");
    expect(createIndexConcurrentlySql(toolResultIndex)).toBe(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turn_parts_owner_workspace_tool_result_idx " +
      "ON harness_shared.session_turn_parts (owner, workspace_id) WHERE part_kind = 'tool_result'",
    );
  });
});

describe('readSessionSearchReadiness / sessionSearchTierAvailability (the read path degrade contract)', () => {
  it('reports absent → invalid → ready from catalog truth, and vocab status from the state row', async () => {
    // w1 HAS transcript rows the build owes a vocabulary for, so no state row reads `absent`
    // (an `empty` verdict is reserved for a workspace with no rows at all — see the next test).
    await seed('w1', ['plan the furnished finder listing']);
    let r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('absent');
    expect(r.vocab.w1).toBe('absent');

    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('ready');

    await sql.unsafe(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${TRGM}'::regclass`,
    );
    r = await readSessionSearchReadiness(sql, ['w1']);
    expect(r.indexes[TRGM]).toBe('invalid');

    await sql`INSERT INTO harness_shared.session_turn_vocab_state (workspace_id, status) VALUES ('w1', 'building')`;
    expect((await readSessionSearchReadiness(sql, ['w1'])).vocab.w1).toBe('building');
  });

  it('skips a tier with a named reason instead of allowing a scan', () => {
    const ready = (over: Partial<SessionSearchReadiness['indexes']>, vocab: SessionSearchReadiness['vocab']) =>
      sessionSearchTierAvailability(
        {
          indexes: { [TRGM]: 'ready', [TS_DESC]: 'ready', [VOCAB_TRGM]: 'ready', ...over },
          vocab,
        } as SessionSearchReadiness,
        ['w1', 'default'],
      );
    // No windows readiness (migration 1334 not applied / backfill incomplete) => the legacy whole-turn route.
    expect(ready({}, { w1: 'ready', default: 'ready' })).toEqual({
      exact: { available: true, route: 'legacy' },
      fuzzy: { available: true },
    });
    expect(ready({ [TRGM]: 'absent' }, { w1: 'ready', default: 'ready' })).toEqual({
      exact: { available: false, skipReason: 'exact-index-absent' },
      fuzzy: { available: false, skipReason: 'exact-index-absent' },
    });
    expect(ready({ [TRGM]: 'invalid' }, {}).exact.skipReason).toBe('exact-index-invalid');
    expect(ready({ [VOCAB_TRGM]: 'absent' }, { w1: 'ready', default: 'ready' }).fuzzy.skipReason).toBe(
      'vocab-index-absent',
    );
    const mid = ready({}, { w1: 'ready', default: 'building' });
    expect(mid.exact.available).toBe(true);
    expect(mid.fuzzy).toEqual({ available: false, skipReason: 'vocab-default:building' });
    expect(ready({}, { w1: 'ready' }).fuzzy.skipReason).toBe('vocab-default:absent');
    // `empty` (no rows, so nothing to build) satisfies the tier exactly like `ready`; `absent` and `failed` do not.
    expect(ready({}, { w1: 'ready', default: 'empty' }).fuzzy).toEqual({ available: true });
    expect(ready({}, { w1: 'empty', default: 'empty' }).fuzzy).toEqual({ available: true });
    expect(ready({}, { w1: 'ready', default: 'failed' }).fuzzy.skipReason).toBe('vocab-default:failed');
  });

  it('a workspace with NO transcript rows reads `empty`, never `absent`: the host-global `default` workspace must not wedge the fuzzy tier forever', async () => {
    // Regression: the fuzzy tier always asks for [workspace, 'default']. The build only creates a vocab
    // state row for a workspace that has rows, so on an install whose 'default' workspace holds no
    // transcripts the state row never appears and `absent` skipped the tier permanently.
    await seed('w1', ['plan the furnished finder listing']);
    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    await runSessionSearchIndexBuildOnce(sql, OPTS);

    const r = await readSessionSearchReadiness(sql, ['w1', 'default']);
    expect(r.vocab.w1).toBe('ready');
    expect(r.vocab.default).toBe('empty');
    expect(sessionSearchTierAvailability(r, ['w1', 'default']).fuzzy).toEqual({ available: true });

    // Control: the same workspace the moment it gains a row (before the build catches up) is `absent`
    // again, so a real vocabulary gap still skips the tier instead of being read as "nothing to build".
    await seed('default', ['a turn the vocabulary has not seen yet']);
    const afterRow = await readSessionSearchReadiness(sql, ['w1', 'default']);
    expect(afterRow.vocab.default).toBe('absent');
    expect(sessionSearchTierAvailability(afterRow, ['w1', 'default']).fuzzy).toEqual({
      available: false,
      skipReason: 'vocab-default:absent',
    });
  });
});

async function prepareWorkItemsQDb(fresh: FreshPgDb): Promise<void> {
  await fresh.sql.unsafe('CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)');
  await applyMigrationForTest(fresh.sql, M501);
  await applyMigrationForTest(fresh.sql, M1273);
  await fresh.sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      item_kind text NOT NULL,
      title text,
      summary text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE harness_shared.work_item_occurrences (
      workspace_id text NOT NULL,
      canonical_harness_slug text NOT NULL,
      canonical_work_item_id text NOT NULL,
      reported_title text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    );
  `).simple();
}

async function explainWithIndexes(s: postgres.Sql, query: string): Promise<string> {
  return s.begin(async (tx) => {
    await tx.unsafe('SET LOCAL enable_seqscan = off');
    const rows = await tx.unsafe(`EXPLAIN ${query}`);
    return rows.map((row) => String(row['QUERY PLAN'])).join('\\\\n');
  });
}

describe('runSessionSearchIndexBuildOnce', () => {
  it('preserves per-index, vocabulary, and invalid-drop errors for the scheduled log', () => {
    const result: SessionSearchIndexBuildResult = {
      invalidDropped: [],
      invalidDropFailures: [{ name: 'stale_idx', error: 'lock not available' }],
      indexes: [{ name: 'title_idx', action: 'failed', elapsedMs: 12, error: 'operator does not exist' }],
      vocab: [{ workspaceId: 'ws-1', action: 'failed', elapsedMs: 7, error: 'lease update failed' }],
      truncated: false,
    };
    expect(sessionSearchIndexBuildFailureDetails(result)).toEqual([
      'drop invalid stale_idx: lock not available',
      'index title_idx: operator does not exist',
      'vocabulary ws-1: lease update failed',
    ]);
  });

  it('skips with tables-missing on a database the migration has not reached', async () => {
    const bare = await createFreshPgDb('sess-search-bare');
    try {
      expect((await runSessionSearchIndexBuildOnce(bare.sql, OPTS)).skipped).toBe('tables-missing');
    } finally {
      await bare.cleanup();
    }
  }, 60_000);

  it('builds absent indexes concurrently, then is a no-op once everything is current', async () => {
    await seed('w1', ['alpha furnishedfinder text', 'beta papercusp session']);
    const first = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(first.skipped).toBeUndefined();
    expect(first.indexes.map((i) => [i.name, i.action])).toEqual([
      [TRGM, 'built'],
      [TS_DESC, 'built'],
      [TOOL_RESULT, 'deferred-table-missing'],
      ...ISSUE_Q_SEARCH_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      ...TEST_RUNS_SEARCH_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      ...CODE_FAMILIARITY_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      [VOCAB_TRGM, 'built'],
    ]);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBe(true);
    expect(await indexValid(TOOL_RESULT)).toBeNull();

    const second = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(second.indexes.map((i) => [i.name, i.action])).toEqual([
      [TRGM, 'present'],
      [TS_DESC, 'present'],
      [TOOL_RESULT, 'deferred-table-missing'],
      ...ISSUE_Q_SEARCH_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      ...TEST_RUNS_SEARCH_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      ...CODE_FAMILIARITY_INDEXES.map((i) => [i.name, 'deferred-table-missing']),
      [VOCAB_TRGM, 'present'],
    ]);
    expect(second.vocab.every((v) => v.action === 'current')).toBe(true);
  }, 60_000);

  it('builds the tool_result owner index when session_turn_parts is present', async () => {
    await sql.unsafe(`CREATE TABLE harness_shared.session_turn_parts (
      owner text NOT NULL,
      workspace_id text NOT NULL,
      part_kind text NOT NULL
    )`);
    try {
      const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
      expect(r.indexes.find((i) => i.name === TOOL_RESULT)?.action).toBe('built');
      expect(await indexValid(TOOL_RESULT)).toBe(true);
    } finally {
      await sql.unsafe('DROP TABLE harness_shared.session_turn_parts CASCADE');
    }
  }, 60_000);

  it('builds the invocation familiarity index online and recovers an interrupted build', async () => {
    await sql.unsafe(`CREATE TABLE harness_shared.tool_invocations (
      workspace_id text NOT NULL,
      tool_name text NOT NULL,
      coord_owner_id text,
      status text NOT NULL
    )`);
    const { name } = CODE_FAMILIARITY_INDEXES[0];
    try {
      const first = await runSessionSearchIndexBuildOnce(sql, OPTS);
      expect(first.indexes.find((i) => i.name === name)?.action).toBe('built');
      expect(await indexValid(name)).toBe(true);

      const second = await runSessionSearchIndexBuildOnce(sql, OPTS);
      expect(second.indexes.find((i) => i.name === name)?.action).toBe('present');

      await sql.unsafe(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${name}'::regclass`,
      );
      const recovered = await runSessionSearchIndexBuildOnce(sql, OPTS);
      expect(recovered.invalidDropped).toContain(name);
      expect(recovered.indexes.find((i) => i.name === name)?.action).toBe('built');
      expect(await indexValid(name)).toBe(true);
    } finally {
      await sql.unsafe('DROP TABLE harness_shared.tool_invocations CASCADE');
    }
  }, 60_000);

  it('drops an invalid leftover (interrupted CONCURRENTLY build) and rebuilds it valid', async () => {
    await seed('w1', ['alpha furnishedfinder text']);
    await sql.unsafe(createIndexConcurrentlySql(SESSION_SEARCH_INDEXES[0]));
    await sql.unsafe(
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'harness_shared.${TRGM}'::regclass`,
    );
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.invalidDropped).toContain(TRGM);
    expect(r.indexes.find((i) => i.name === TRGM)?.action).toBe('built');
    expect(await indexValid(TRGM)).toBe(true);
  }, 60_000);

  it('builds a per-workspace vocabulary: 4-40 char tokens only, exact doc counts, no cross-workspace words', async () => {
    await seed('w1', ['furnishedfinder session', 'furnishedfinder the and abc', 'session x']);
    await seed('other', ['secretword zzzzzzzz']);
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.filter((v) => v.action === 'full').map((v) => v.workspaceId).sort()).toEqual(['other', 'w1']);

    const w1 = await vocabOf('w1');
    expect(w1.get('furnishedfinder')).toBe(2);
    expect(w1.get('session')).toBe(2);
    for (const short of ['the', 'and', 'abc']) expect(w1.has(short)).toBe(false);
    expect(w1.has('secretword')).toBe(false);
    expect((await vocabOf('other')).get('secretword')).toBe(1);

    const [st] = await sql<Array<{ status: string; word_count: number; watermark_ingested_at: Date | null }>>`
      SELECT status, word_count, watermark_ingested_at FROM harness_shared.session_turn_vocab_state
       WHERE workspace_id = 'w1'`;
    expect(st!.status).toBe('ready');
    expect(Number(st!.word_count)).toBe(w1.size);
    expect(st!.watermark_ingested_at).not.toBeNull();
  }, 60_000);

  it('covers rows whose ingested_at has sub-millisecond precision (the watermark must not round-trip through a JS Date)', async () => {
    // A Date truncates .123999 to .123, which would exclude this row from the full build's
    // `ingested_at <= watermark` bound and re-count it on the next incremental.
    await sql`
      INSERT INTO harness_shared.session_turns
        (workspace_id, source_kind, session_id, turn_idx, speaker, text, ts, ingested_at)
      VALUES ('w1', 'claude', 's-micro', 0, 'user', 'microsecondword here', now(),
              timestamptz '2026-01-01 00:00:00.123999+00')`;
    const first = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(first.vocab.find((v) => v.workspaceId === 'w1')).toMatchObject({ action: 'full' });
    expect((await vocabOf('w1')).get('microsecondword')).toBe(1);
    const quiet = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(quiet.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('current');
    expect((await vocabOf('w1')).get('microsecondword')).toBe(1);
  }, 60_000);

  it('refreshes incrementally: only rows newer than the watermark are added, and a quiet pass is current', async () => {
    await seed('w1', ['furnishedfinder session']);
    await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect((await vocabOf('w1')).get('furnishedfinder')).toBe(1);

    await seed('w1', ['furnishedfinder brandnewword'], { ingestedOffsetSec: 5 });
    const r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('incremental');
    const after = await vocabOf('w1');
    expect(after.get('brandnewword')).toBe(1);
    expect(after.get('furnishedfinder')).toBe(2);
    expect(after.get('session')).toBe(1);

    const quiet = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(quiet.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('current');
    expect((await vocabOf('w1')).get('furnishedfinder')).toBe(2);
  }, 60_000);

  it('a full rebuild removes words whose last turn was deleted by retention', async () => {
    await seed('w1', ['gonewords keepwords']);
    await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect((await vocabOf('w1')).has('gonewords')).toBe(true);
    await sql`TRUNCATE harness_shared.session_turns`;
    await seed('w1', ['keepwords only']);
    await runSessionSearchIndexBuildOnce(sql, {
      ...OPTS,
      vocabFullRebuildAfterMs: -1, // force the periodic full rebuild
    });
    const v = await vocabOf('w1');
    expect(v.has('gonewords')).toBe(false);
    expect(v.get('keepwords')).toBe(1);
  }, 60_000);

  it('does not build a workspace whose lease is live (another pass is mid-build) and reclaims a stale lease', async () => {
    await seed('w1', ['leasedword one']);
    await sql`INSERT INTO harness_shared.session_turn_vocab_state (workspace_id, status, build_started_at)
              VALUES ('w1', 'building', now())`;
    let r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('in-flight');
    expect((await vocabOf('w1')).size).toBe(0);

    await sql`UPDATE harness_shared.session_turn_vocab_state
                 SET build_started_at = now() - interval '3 hours' WHERE workspace_id = 'w1'`;
    r = await runSessionSearchIndexBuildOnce(sql, OPTS);
    expect(r.vocab.find((v) => v.workspaceId === 'w1')?.action).toBe('full');
    expect((await vocabOf('w1')).get('leasedword')).toBe(1);
  }, 60_000);

  it('dryRun reports what it would build and changes nothing', async () => {
    await seed('w1', ['dryrunword here']);
    const r = await runSessionSearchIndexBuildOnce(sql, { ...OPTS, dryRun: true });
    expect(
      r.indexes
        .filter((i) => i.name !== TOOL_RESULT && i.action !== 'deferred-table-missing')
        .every((i) => i.action === 'would-build'),
    ).toBe(true);
    expect(r.indexes.find((i) => i.name === TOOL_RESULT)?.action).toBe('deferred-table-missing');
    for (const i of ISSUE_Q_SEARCH_INDEXES) {
      expect(r.indexes.find((entry) => entry.name === i.name)?.action).toBe('deferred-table-missing');
    }
    for (const i of TEST_RUNS_SEARCH_INDEXES) {
      expect(r.indexes.find((entry) => entry.name === i.name)?.action).toBe('deferred-table-missing');
    }
    expect(r.vocab.every((v) => v.action === 'would-build')).toBe(true);
    for (const n of [TRGM, TS_DESC, VOCAB_TRGM]) expect(await indexValid(n)).toBeNull();
    expect(await indexValid(TOOL_RESULT)).toBeNull();
    expect((await vocabOf('w1')).size).toBe(0);
  }, 60_000);
});

describe('work_items:list literal q trigram indexes (EI-25883110093789830)', () => {
  it('creates indexes inline for small tables and each predicate can use its matching index', async () => {
    const fresh = await createFreshPgDb('work-items-q-small');
    try {
      await prepareWorkItemsQDb(fresh);
      await applyMigrationForTest(fresh.sql, M1512);
      await fresh.sql.unsafe(`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, summary)
        SELECT 'default', 'h1', 'EI-' || n::text, 'bug',
               CASE WHEN n = 1 THEN 'needle in title' ELSE 'ordinary title ' || n::text END,
               CASE WHEN n = 1 THEN 'needle in summary' ELSE 'ordinary summary ' || n::text END
          FROM generate_series(1, 1000) AS n;
        INSERT INTO harness_shared.work_item_occurrences
          (workspace_id, canonical_harness_slug, canonical_work_item_id, reported_title, evidence)
        SELECT 'default', 'h1', 'EI-' || n::text,
               CASE WHEN n = 1 THEN 'needle in report title' ELSE 'ordinary report ' || n::text END,
               jsonb_build_object('body', CASE WHEN n = 1 THEN 'needle in evidence body' ELSE 'ordinary evidence ' || n::text END)
          FROM generate_series(1, 1000) AS n;
        ANALYZE harness_shared.work_items;
        ANALYZE harness_shared.work_item_occurrences;
      `).simple();

      for (const spec of ISSUE_Q_SEARCH_INDEXES) {
        expect(await indexValidOn(fresh.sql, spec.name)).toBe(true);
      }
      const queries = [
        [ISSUE_Q_SEARCH_INDEXES[0]!.name, "SELECT feature_id FROM harness_shared.work_items WHERE COALESCE(title, '') ILIKE '%needle%' ESCAPE '\\'"],
        [ISSUE_Q_SEARCH_INDEXES[1]!.name, "SELECT feature_id FROM harness_shared.work_items WHERE COALESCE(summary, '') ILIKE '%needle%' ESCAPE '\\'"],
        [ISSUE_Q_SEARCH_INDEXES[2]!.name, "SELECT canonical_work_item_id FROM harness_shared.work_item_occurrences WHERE reported_title ILIKE '%needle%' ESCAPE '\\'"],
        [ISSUE_Q_SEARCH_INDEXES[3]!.name, "SELECT canonical_work_item_id FROM harness_shared.work_item_occurrences WHERE COALESCE(evidence ->> 'body', '') ILIKE '%needle%' ESCAPE '\\'"],
      ] as const;
      for (const [name, query] of queries) {
        expect(await explainWithIndexes(fresh.sql, query)).toContain(name);
      }
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);

  it('defers populated-table indexes to the guarded concurrent builder', async () => {
    const fresh = await createFreshPgDb('work-items-q-large');
    try {
      await prepareWorkItemsQDb(fresh);
      await fresh.sql.unsafe(`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, summary)
        SELECT 'default', 'h1', 'EI-' || n::text, 'bug', 'ordinary title ' || n::text, 'ordinary summary ' || n::text
          FROM generate_series(1, 10001) AS n;
        INSERT INTO harness_shared.work_item_occurrences
          (workspace_id, canonical_harness_slug, canonical_work_item_id, reported_title, evidence)
        SELECT 'default', 'h1', 'EI-' || n::text, 'ordinary report ' || n::text,
               jsonb_build_object('body', 'ordinary evidence ' || n::text)
          FROM generate_series(1, 10001) AS n;
      `).simple();
      await applyMigrationForTest(fresh.sql, M1512);
      for (const spec of ISSUE_Q_SEARCH_INDEXES) {
        expect(await indexValidOn(fresh.sql, spec.name)).toBeNull();
      }

      const built = await runSessionSearchIndexBuildOnce(fresh.sql, OPTS);
      for (const spec of ISSUE_Q_SEARCH_INDEXES) {
        expect(built.indexes.find((entry) => entry.name === spec.name)?.action).toBe('built');
        expect(await indexValidOn(fresh.sql, spec.name)).toBe(true);
      }
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);
});

describe('testing:runs filePath substring trigram index', () => {
  const indexName = TEST_RUNS_SEARCH_INDEXES[0]!.name;

  async function prepareTestRunsDb(fresh: FreshPgDb): Promise<void> {
    // runSessionSearchIndexBuildOnce has a Guard 0 preflight for the session-turn,
    // vocabulary, and vocabulary-state tables. The populated-ledger case must reach
    // the per-index builder instead of returning early with `tables-missing`.
    await fresh.sql.unsafe(
      `CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (surface text, body jsonb)`,
    );
    await applyMigrationForTest(fresh.sql, M501);
    await applyMigrationForTest(fresh.sql, M1273);
    await fresh.sql.unsafe(`
      CREATE TABLE harness_shared.test_runs (
        id bigserial PRIMARY KEY,
        file_path text NOT NULL
      )
    `).simple();
  }

  it('creates the matching index inline for a small or fresh ledger', async () => {
    const fresh = await createFreshPgDb('test-runs-path-trgm-small');
    try {
      await prepareTestRunsDb(fresh);
      await applyMigrationForTest(fresh.sql, M1558);
      expect(await indexValidOn(fresh.sql, indexName)).toBe(true);
      expect(
        await explainWithIndexes(
          fresh.sql,
          "SELECT id FROM harness_shared.test_runs WHERE file_path ILIKE '%needle%'",
        ),
      ).toContain(indexName);
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);

  it('defers a populated ledger to the guarded concurrent builder', async () => {
    const fresh = await createFreshPgDb('test-runs-path-trgm-large');
    try {
      await prepareTestRunsDb(fresh);
      await fresh.sql.unsafe(`
        INSERT INTO harness_shared.test_runs (file_path)
        SELECT CASE WHEN n = 1 THEN 'apps/operator/needle.test.ts' ELSE 'ordinary/test-' || n::text END
          FROM generate_series(1, 10001) AS n
      `).simple();
      await applyMigrationForTest(fresh.sql, M1558);
      expect(await indexValidOn(fresh.sql, indexName)).toBeNull();

      const built = await runSessionSearchIndexBuildOnce(fresh.sql, OPTS);
      expect(built.indexes.find((entry) => entry.name === indexName)?.action).toBe('built');
      expect(await indexValidOn(fresh.sql, indexName)).toBe(true);
      expect(
        await explainWithIndexes(
          fresh.sql,
          "SELECT id FROM harness_shared.test_runs WHERE file_path ILIKE '%needle%'",
        ),
      ).toContain(indexName);
    } finally {
      await fresh.cleanup();
    }
  }, 120_000);
});
