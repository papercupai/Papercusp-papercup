import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const {
  runWorkItemAdmissionCensus,
  parseAdmissionCensusResume,
  ADMISSION_CENSUS_RESUME_MAX_AGE_MS,
  ADMISSION_CENSUS_RESUME_SCHEMA,
  ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS,
  ADMISSION_CENSUS_EDGE_EVIDENCE_LIMIT,
  readPinnedUnadjudicatedCensus,
} = await import('./work-items-admission-census');

const WS = 'default';
const HARNESS = 'h1';
let db: FreshPgDb;

const DDL = `
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text,
    lane text,
    payload jsonb,
    item_kind text NOT NULL DEFAULT 'task',
    nature text NOT NULL DEFAULT 'work',
    origin text NOT NULL DEFAULT 'local',
    condition_key text,
    created_ts bigint,
    embedding vector(3),
    embedding_mode text,
    embedding_profile text,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  CREATE TABLE harness_shared.scout_routed_ideas (
    idea_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    routed_ref text NOT NULL,
    origin text NOT NULL,
    routed_at bigint NOT NULL
  );
  CREATE TABLE harness_shared.dedup_edges (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    cos real NOT NULL,
    trgm real,
    run_id text NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.dedup_adjudications (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    a text NOT NULL,
    b text NOT NULL,
    verdict text NOT NULL,
    canonical text,
    judged_by text NOT NULL,
    run_id text NOT NULL,
    judged_at timestamptz NOT NULL DEFAULT now(),
    evidence jsonb,
    PRIMARY KEY (workspace_id, harness_slug, a, b)
  );
  CREATE TABLE harness_shared.admission_runs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    run_kind text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    batch_size integer,
    promoted integer,
    merged integer,
    held integer,
    auto_promoted_unreviewed integer,
    census_before integer,
    census_after integer,
    model_id text,
    tokens_in bigint,
    tokens_out bigint,
    latency_ms integer,
    detail jsonb
  );
  CREATE TABLE harness_shared.dedup_shard_map (
    run_id text NOT NULL,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    shard_id integer NOT NULL,
    item_id text NOT NULL,
    role text NOT NULL,
    PRIMARY KEY (run_id, shard_id, item_id, role)
  );
  CREATE UNIQUE INDEX dedup_shard_map_one_member_uq
    ON harness_shared.dedup_shard_map (run_id, item_id) WHERE role = 'member';
`;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-admission-census');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.scout_routed_ideas,
    harness_shared.dedup_edges, harness_shared.dedup_adjudications,
    harness_shared.admission_runs, harness_shared.dedup_shard_map`;
});

it('counts pinned edges without Cartesian member probes and restores session settings', async () => {
  // Model a newly completed map absent from the planner's last statistics sample.
  await db.sql`INSERT INTO harness_shared.dedup_shard_map
    SELECT 'old', ${WS}, ${HARNESS}, 0, 'old-' || n, 'member' FROM generate_series(1, 3000) n`;
  await db.sql`ANALYZE harness_shared.dedup_shard_map`;
  await db.sql`INSERT INTO harness_shared.dedup_shard_map
    SELECT r, ${WS}, ${HARNESS}, 0, 'item-' || n, 'member'
      FROM unnest(ARRAY['before', 'after']) r CROSS JOIN generate_series(1, 64) n`;
  await db.sql`INSERT INTO harness_shared.dedup_shard_map VALUES
    ('after', ${WS}, ${HARNESS}, 0, 'inflow', 'member'),
    ('before', ${WS}, ${HARNESS}, 0, 'ghost', 'ghost'),
    ('after', ${WS}, ${HARNESS}, 0, 'ghost', 'ghost')`;
  await db.sql`INSERT INTO harness_shared.dedup_edges
    (workspace_id, harness_slug, a, b, cos, run_id) VALUES
    (${WS}, ${HARNESS}, 'item-1', 'item-2', 0.95, 'edges'),
    (${WS}, ${HARNESS}, 'item-3', 'item-4', 0.95, 'edges'),
    (${WS}, ${HARNESS}, 'item-5', 'item-6', 0.89, 'edges'),
    (${WS}, ${HARNESS}, 'inflow', 'item-1', 0.99, 'edges'),
    (${WS}, ${HARNESS}, 'ghost', 'item-1', 0.99, 'edges'),
    (${WS}, 'other-harness', 'item-1', 'item-2', 0.99, 'edges'),
    ('other-workspace', ${HARNESS}, 'item-1', 'item-2', 0.99, 'edges')`;
  await db.sql`INSERT INTO harness_shared.dedup_adjudications
    (workspace_id, harness_slug, a, b, verdict, judged_by, run_id) VALUES
    (${WS}, ${HARNESS}, 'item-3', 'item-4', 'r-related', 'judge', 'prior')`;

  type Plan = { 'Node Type': string; Plans?: Plan[] };
  const nodes = (plan: Plan): string[] => [plan['Node Type'], ...(plan.Plans ?? []).flatMap(nodes)];
  let during: { nestloop: string; timeout_ms: number } | undefined;
  let queryPlan: string[] = [];
  const observe = (sql: postgres.Sql | postgres.TransactionSql): typeof sql => new Proxy(sql, {
    apply(target, receiver, args) {
      const [strings, ...values] = args as [TemplateStringsArray, ...unknown[]];
      if (!strings.join('').includes('WITH pinned AS MATERIALIZED')) return Reflect.apply(target, receiver, args);
      return (async () => {
        [during] = await target<{ nestloop: string; timeout_ms: number }[]>`
          SELECT current_setting('enable_nestloop') AS nestloop, setting::integer AS timeout_ms
            FROM pg_settings WHERE name = 'statement_timeout' AND unit = 'ms'`;
        const text = strings.reduce((out, part, i) => out + (i ? `$${i}` : '') + part, '');
        const explained = await target.unsafe('EXPLAIN (FORMAT JSON) ' + text, values as never[]);
        queryPlan = nodes(explained[0]['QUERY PLAN'][0].Plan as Plan);
        return Reflect.apply(target, receiver, args);
      })();
    },
    get(target, key, receiver) {
      if (key === 'begin') return (body: (tx: postgres.TransactionSql) => Promise<unknown>) =>
        db.sql.begin(tx => body(observe(tx) as postgres.TransactionSql));
      return Reflect.get(target, key, receiver);
    },
  });
  const [before] = await db.sql`SELECT current_setting('enable_nestloop') AS nestloop,
    current_setting('statement_timeout') AS timeout`;
  expect(await readPinnedUnadjudicatedCensus(
    observe(db.sql) as unknown as Parameters<typeof readPinnedUnadjudicatedCensus>[0],
    { workspaceId: WS, harnessSlug: HARNESS }, { pinnedRunId: 'before', currentRunId: 'after' },
  )).toBe(1);
  expect(during).toEqual({ nestloop: 'off', timeout_ms: ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS });
  expect(queryPlan).not.toContain('Nested Loop');
  const [after] = await db.sql`SELECT current_setting('enable_nestloop') AS nestloop,
    current_setting('statement_timeout') AS timeout`;
  expect(after).toEqual(before);
});

async function seed(): Promise<void> {
  const rows = [
    {
      id: 'a',
      title: 'Alpha',
      status: 'open',
      lane: null,
      payload: { admissionIdentity: { titleKey: 'alpha' } },
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: 'watch:a',
    },
    {
      id: 'b',
      title: 'Alpha sibling',
      status: 'open',
      lane: null,
      payload: {},
      vec: '[0.999,0.04,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'c',
      title: 'Context neighbour',
      status: 'open',
      lane: null,
      payload: {},
      vec: '[0.87,0.493,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'd',
      title: 'Alpha',
      status: 'open',
      lane: null,
      payload: { admissionIdentity: { titleKey: 'alpha' } },
      vec: null,
      mode: null,
      condition: null,
    },
    {
      id: 'obs',
      title: 'Observation',
      status: 'open',
      lane: 'observation',
      payload: {},
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: null,
    },
    {
      id: 'done',
      title: 'Terminal',
      status: 'done',
      lane: null,
      payload: {},
      vec: '[1,0,0]',
      mode: 'gemma',
      condition: null,
    },
  ];
  for (const row of rows) {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         condition_key, created_ts, embedding, embedding_mode)
      VALUES (${WS}, ${HARNESS}, ${row.id}, ${row.title}, '', ${row.status}, ${row.lane},
              ${JSON.stringify(row.payload)}::text::jsonb, ${row.condition}, 1,
              ${row.vec}::vector, ${row.mode})`;
  }
  await db.sql`
    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, routed_ref, origin, routed_at)
    VALUES ('idea-c', ${WS}, ${HARNESS}, 'c', 'scout', 1)`;
}

describe('runWorkItemAdmissionCensus (real Postgres)', () => {
  it('excludes data records, events and documents from the work corpus and pinned shards', async () => {
    await seed();
    for (const nature of ['record', 'event', 'document']) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, nature,
           payload, created_ts, embedding, embedding_mode)
        VALUES (${WS}, ${HARNESS}, ${`data-${nature}`}, 'Alpha', '', 'open', ${nature},
                '{"admissionIdentity":{"titleKey":"alpha"}}'::jsonb, 1,
                '[1,0,0]'::vector, 'gemma')`;
    }

    const result = await runWorkItemAdmissionCensus({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'work-only-census',
      sql: db.sql,
      chunkCount: 2,
      targetTokens: 100,
    });

    expect(result.corpusSize).toBe(4);
    const members = await db.sql<Array<{ item_id: string }>>`
      SELECT item_id FROM harness_shared.dedup_shard_map
       WHERE run_id = 'work-only-census' AND role = 'member'
       ORDER BY item_id`;
    expect(members.map((row) => row.item_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(await db.sql`
      SELECT a, b FROM harness_shared.dedup_edges
       WHERE a LIKE 'data-%' OR b LIKE 'data-%'`).toHaveLength(0);
  }, 60_000);

  it('writes reproducible census runs and exact member coverage, including text-only context', async () => {
    await seed();
    let tick = 1_000;
    const common = {
      workspaceId: WS,
      harnessSlug: HARNESS,
      chunkCount: 2,
      targetTokens: 100,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => tick++,
    };
    const first = await runWorkItemAdmissionCensus({ ...common, runId: 'census-1' });
    const second = await runWorkItemAdmissionCensus({ ...common, runId: 'census-2' });

    expect(first.corpusSize).toBe(4);
    expect(first.memberRows).toBe(4);
    expect(first.embeddedItems).toBe(3);
    expect(first.missingEmbeddingItems).toBe(1);
    expect(first.hardEdges).toBeGreaterThanOrEqual(1);
    expect(first.textContextEdges).toBeGreaterThanOrEqual(1);
    expect(first.censusAfter).toBeGreaterThanOrEqual(1);
    expect(first.chunkCoverage.reduce((sum, n) => sum + n, 0)).toBe(3);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.censusBefore).toBe(first.censusAfter);

    const runs = await db.sql<Array<{ id: string; status: string; members: number; unit: string; attempted: number; successful: number }>>`
      SELECT id, detail->>'status' AS status,
             (detail #>> '{coverageAssertion,memberRows}')::int AS members,
             detail #>> '{outcome,unit}' AS unit,
             (detail #>> '{outcome,attempted}')::int AS attempted,
             (detail #>> '{outcome,successful}')::int AS successful
        FROM harness_shared.admission_runs ORDER BY id`;
    expect(runs).toEqual([
      { id: 'census-1', status: 'complete', members: 4, unit: 'snapshots', attempted: 1, successful: 1 },
      { id: 'census-2', status: 'complete', members: 4, unit: 'snapshots', attempted: 1, successful: 1 },
    ]);

    const coverage = await db.sql<Array<{ run_id: string; members: number; unique_members: number }>>`
      SELECT run_id,
             count(*) FILTER (WHERE role = 'member')::int AS members,
             count(DISTINCT item_id) FILTER (WHERE role = 'member')::int AS unique_members
        FROM harness_shared.dedup_shard_map
       GROUP BY run_id ORDER BY run_id`;
    expect(coverage).toEqual([
      { run_id: 'census-1', members: 4, unique_members: 4 },
      { run_id: 'census-2', members: 4, unique_members: 4 },
    ]);
  }, 60_000);

  it('pins corpus membership and reads canonical edges even when eligibility and edge provenance change between chunks', async () => {
    await seed();
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION mutate_admission_census_eligibility()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE harness_shared.work_items
           SET status = 'done'
         WHERE workspace_id = '${WS}'
           AND harness_slug = '${HARNESS}'
           AND feature_id = 'c'
           AND status = 'open';
        RETURN NULL;
      END;
      $$;
      CREATE OR REPLACE FUNCTION rewrite_admission_census_provenance()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.a = 'a' AND NEW.b = 'b' THEN
          NEW.run_id := 'create-prescreen';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER admission_census_eligibility_mutation
        AFTER INSERT OR UPDATE ON harness_shared.dedup_edges
        FOR EACH STATEMENT EXECUTE FUNCTION mutate_admission_census_eligibility();
      CREATE TRIGGER admission_census_provenance_mutation
        BEFORE INSERT OR UPDATE ON harness_shared.dedup_edges
        FOR EACH ROW EXECUTE FUNCTION rewrite_admission_census_provenance();
    `);

    let first: Awaited<ReturnType<typeof runWorkItemAdmissionCensus>>;
    try {
      first = await runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'mutating-corpus-1',
        chunkCount: 2,
        targetTokens: 100,
        ghostFraction: 0.5,
        sql: db.sql,
        now: () => 3_000,
      });
    } finally {
      await db.sql.unsafe(`
        DROP TRIGGER IF EXISTS admission_census_eligibility_mutation ON harness_shared.dedup_edges;
        DROP TRIGGER IF EXISTS admission_census_provenance_mutation ON harness_shared.dedup_edges;
        DROP FUNCTION IF EXISTS mutate_admission_census_eligibility();
        DROP FUNCTION IF EXISTS rewrite_admission_census_provenance();
      `);
    }

    expect(first.corpusSize).toBe(4);
    expect(first.embeddedItems).toBe(3);
    expect(first.chunkCoverage.reduce((sum, n) => sum + n, 0)).toBe(3);
    expect(first.memberRows).toBe(4);
    expect(
      await db.sql<Array<{ status: string }>>`
        SELECT status FROM harness_shared.work_items
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`,
    ).toEqual([{ status: 'done' }]);
    expect(
      await db.sql<Array<{ run_id: string }>>`
        SELECT run_id FROM harness_shared.dedup_edges
         WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND a = 'a' AND b = 'b'`,
    ).toEqual([{ run_id: 'create-prescreen' }]);

    await db.sql`
      UPDATE harness_shared.work_items SET status = 'open'
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`;
    const second = await runWorkItemAdmissionCensus({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'mutating-corpus-2',
      chunkCount: 2,
      targetTokens: 100,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => 4_000,
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.memberRows).toBe(first.memberRows);
    expect(second.hardEdges).toBe(first.hardEdges);
  }, 60_000);

  /**
   * F1 (WI-2140406 / EI-22068819110487948) — lexical hard edges.
   *
   * Measured blindness this guards against: with cosine as the only corpus-wide
   * candidate generator, an identical-title pair that is EMBEDDED but lands
   * cos < 0.85 (divergent summaries) gets no edge from ANY leg, and text-context
   * edges never enter the unadjudicated set, so the merge projection reports a
   * dup-twin corpus as empty (1,826 open twin pairs, 0 edges, 2026-09-01).
   */
  it('forms lexical hard edges for identity twins regardless of embedding state and counts them in the projection', async () => {
    const rows = [
      // (a) embedded twins, orthogonal vectors: cos = 0 — invisible to every leg today
      { id: 'e1', title: 'Dup twin', vec: '[1,0,0]', mode: 'gemma', condition: null },
      { id: 'e2', title: 'Dup twin', vec: '[0,1,0]', mode: 'gemma', condition: null },
      // (b) unembedded twins: text leg glues the plan, but the projection never sees them
      { id: 'u1', title: 'Ghost twin', vec: null, mode: null, condition: null },
      { id: 'u2', title: 'Ghost twin', vec: null, mode: null, condition: null },
      // (c) same recurring-detector condition, different titles
      { id: 'k1', title: 'Watcher red', vec: '[0,0,1]', mode: 'gemma', condition: 'watch:same' },
      { id: 'k2', title: 'Watcher blue', vec: '[-1,0,0]', mode: 'gemma', condition: 'watch:same' },
    ];
    for (const row of rows) {
      await db.sql`
        INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
           condition_key, created_ts, embedding, embedding_mode)
        VALUES (${WS}, ${HARNESS}, ${row.id}, ${row.title}, '', 'open', NULL, '{}'::jsonb,
                ${row.condition}, 1, ${row.vec}::vector, ${row.mode})`;
    }
    // An already-adjudicated lexical pair must stay out of the unadjudicated set.
    await db.sql`
      INSERT INTO harness_shared.dedup_adjudications
        (workspace_id, harness_slug, a, b, verdict, judged_by, run_id)
      VALUES (${WS}, ${HARNESS}, 'u1', 'u2', 'distinct', 'seed', 'pre-adjudicated')`;

    const result = await runWorkItemAdmissionCensus({
      workspaceId: WS,
      harnessSlug: HARNESS,
      runId: 'lexical-1',
      chunkCount: 2,
      targetTokens: 6,
      ghostFraction: 0.5,
      sql: db.sql,
      now: () => 5_000,
    });

    // All three identity twins produce a hard lexical edge; the adjudicated one
    // is excluded from the unadjudicated companion count.
    expect(result.lexicalEdges).toBe(3);
    expect(result.lexicalUnadjudicated).toBe(2);

    // Each twin pair is glued into one hard component => co-resident members.
    // targetTokens=6 forces one component per shard, so co-residency here is
    // component cohesion, not incidental packing.
    const shardOf = (id: string) =>
      result.shards.find((shard) => shard.members.includes(id))?.shardId ?? `missing:${id}`;
    expect(shardOf('e1')).toBe(shardOf('e2'));
    expect(shardOf('u1')).toBe(shardOf('u2'));
    expect(shardOf('k1')).toBe(shardOf('k2'));

    // The merge projection finally sees the lexical dup mass.
    expect(result.projection.byPairClass).toEqual({
      'agent-filed × agent-filed': 1,
      'machine-emitter × machine-emitter': 1,
    });
    expect(result.projection.outsideMachineEmitterPairs).toBe(1);
    expect(result.projection.componentCollapseUpperBound).toEqual({
      'agent-filed': 1,
      'machine-emitter': 1,
    });

    // The ledger carries the companion lexical counts.
    const detail = await db.sql<Array<{ lex: number; lexu: number }>>`
      SELECT (detail #>> '{edges,lexicalHard}')::int AS lex,
             (detail #>> '{edges,lexicalUnadjudicated}')::int AS lexu
        FROM harness_shared.admission_runs WHERE id = 'lexical-1'`;
    expect(detail).toEqual([{ lex: 3, lexu: 2 }]);
  }, 60_000);

  it('records a failed run instead of laundering an identity-unknown vector into a clean census', async () => {
    await seed();
    await db.sql`UPDATE harness_shared.work_items SET embedding_mode = 'foreign' WHERE feature_id = 'c'`;

    await expect(
      runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'mixed-mode',
        sql: db.sql,
        now: () => 2_000,
      }),
    ).rejects.toThrow(/compatible embedding_profile/);

    const rows = await db.sql<Array<{ status: string; error: string; unit: string; failure: string }>>`
      SELECT detail->>'status' AS status, detail->>'error' AS error,
             detail #>> '{outcome,unit}' AS unit,
             detail #>> '{outcome,failureReason}' AS failure
        FROM harness_shared.admission_runs WHERE id = 'mixed-mode'`;
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error).toMatch(/compatible embedding_profile/);
    expect(rows[0]?.unit).toBe('snapshots');
    expect(rows[0]?.failure).toMatch(/compatible embedding_profile/);
  }, 60_000);
  });

  it('rejects equal-mode vectors carrying two different exact accepted profiles', async () => {
    await seed();
    await db.sql`
      UPDATE harness_shared.work_items
         SET embedding_profile = CASE feature_id
           WHEN 'c' THEN 'openai-text-embedding-3-small-768@v1'
           ELSE 'gemma-embeddinggemma-300m-768@v1'
         END
       WHERE embedding IS NOT NULL AND lane IS DISTINCT FROM 'observation' AND status = 'open'`;

    await expect(
      runWorkItemAdmissionCensus({
        workspaceId: WS,
        harnessSlug: HARNESS,
        runId: 'census-mixed-exact-profiles',
        sql: db.sql,
      }),
    ).rejects.toThrow(/mixed embedding profiles/);
  });

/**
 * WI-10004951. Reproduces the 2026-10-01 16:59Z failure: migration 1308 held ACCESS
 * EXCLUSIVE on work_items while it rewrote the table, the role's lock_timeout cancelled
 * the census read with 55P03, and that one refusal failed a scheduled bulk-dedup fire.
 * Here a reserved connection holds the same lock, and the census runs on a client whose
 * lock_timeout is short so each refusal is quick. The injected `sleep` is the only place
 * the lock can be released, so a census that completes must have retried.
 */
describe('runWorkItemAdmissionCensus lock_not_available retry (WI-10004951, real Postgres)', () => {
  let shortLockSql: postgres.Sql;

  beforeAll(() => {
    shortLockSql = postgres(db.url, {
      max: 2,
      onnotice: () => {},
      connection: { lock_timeout: 200 },
    });
  });

  afterAll(async () => {
    await shortLockSql?.end({ timeout: 5 });
  });

  async function withWorkItemsLocked<T>(body: (release: () => Promise<void>) => Promise<T>): Promise<T> {
    const holder = await db.sql.reserve();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      await holder`COMMIT`;
    };
    try {
      await holder`BEGIN`;
      await holder`LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE`;
      return await body(release);
    } finally {
      await release();
      holder.release();
    }
  }

  const base = () => ({
    workspaceId: WS,
    harnessSlug: HARNESS,
    chunkCount: 2,
    targetTokens: 100,
    ghostFraction: 0.5,
    sql: shortLockSql,
  });

  async function runStatus(runId: string): Promise<string | undefined> {
    const rows = await db.sql<Array<{ status: string }>>`
      SELECT detail->>'status' AS status FROM harness_shared.admission_runs WHERE id = ${runId}`;
    return rows[0]?.status;
  }

  it('rides out a lock refusal on work_items and completes the census', async () => {
    await seed();
    const waits: number[] = [];
    const result = await withWorkItemsLocked((release) =>
      runWorkItemAdmissionCensus({
        ...base(),
        runId: 'census-lock-retry',
        lockRetryBackoffsMs: [10, 10, 10],
        sleep: async (ms) => {
          waits.push(ms);
          await release();
        },
      }),
    );

    expect(waits).toEqual([10]);
    expect(result.corpusSize).toBe(4);
    expect(result.memberRows).toBe(4);
    expect(await runStatus('census-lock-retry')).toBe('complete');
  }, 60_000);

  it('CONTROL: with the ladder disabled ([]) the same refusal fails the census, as it did before the fix', async () => {
    await seed();
    const waits: number[] = [];
    const error = await withWorkItemsLocked(() =>
      runWorkItemAdmissionCensus({
        ...base(),
        runId: 'census-lock-control',
        lockRetryBackoffsMs: [],
        sleep: async (ms) => {
          waits.push(ms);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      ),
    );

    expect((error as { code?: string } | null)?.code).toBe('55P03');
    expect(waits).toEqual([]);
    expect(await runStatus('census-lock-control')).toBe('failed');
  }, 60_000);

  it('is bounded: a lock held past the whole ladder fails once, after every wait', async () => {
    await seed();
    const waits: number[] = [];
    const error = await withWorkItemsLocked(() =>
      runWorkItemAdmissionCensus({
        ...base(),
        runId: 'census-lock-exhausted',
        lockRetryBackoffsMs: [5, 7],
        sleep: async (ms) => {
          waits.push(ms);
        },
      }).then(
        () => null,
        (e: unknown) => e,
      ),
    );

    expect((error as { code?: string } | null)?.code).toBe('55P03');
    expect(waits).toEqual([5, 7]);
    expect(await runStatus('census-lock-exhausted')).toBe('failed');
  }, 60_000);
});

/**
 * WI-10004965 — a census interrupted part-way resumes from its finished chunks.
 *
 * Measured 2026-10-01: a production census took ~17 min and bg-host restarted every
 * ~10-13 min, so census-0 of one bulk-dedup fire restarted from chunk 0 four times
 * (17:14, 17:26, 17:37, 17:47Z) and the pass never left census.
 *
 * The interruption is simulated with a trigger that raises while chunk 1 writes
 * (seed order: a=pos1 -> chunk 0, b=pos2 -> chunk 1, c=pos3 -> chunk 0; chunk 1 is
 * the only one writing an edge with a = 'b'). A hard kill never reaches the catch
 * block, so `killed()` then resets the row to the 'running' state a dead process
 * leaves behind. Whether chunk 0 was re-scanned is read from its edges'
 * `computed_at`: every scan upserts with `clock_timestamp()`, so a re-scan moves it.
 */
describe('runWorkItemAdmissionCensus resume after interruption (WI-10004965, real Postgres)', () => {
  const base = { workspaceId: WS, harnessSlug: HARNESS, chunkCount: 2, targetTokens: 100, ghostFraction: 0.5 };

  async function armCrashOnChunk1(): Promise<void> {
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION crash_admission_census_chunk()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.a = 'b' THEN RAISE EXCEPTION 'simulated bg-host restart'; END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER admission_census_crash
        BEFORE INSERT ON harness_shared.dedup_edges
        FOR EACH ROW EXECUTE FUNCTION crash_admission_census_chunk();
    `);
  }

  async function disarmCrash(): Promise<void> {
    await db.sql.unsafe(`
      DROP TRIGGER IF EXISTS admission_census_crash ON harness_shared.dedup_edges;
      DROP FUNCTION IF EXISTS crash_admission_census_chunk();
    `);
  }

  async function interruptedAttempt(runId: string, nowMs: number): Promise<void> {
    await armCrashOnChunk1();
    try {
      await expect(
        runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId, now: () => nowMs }),
      ).rejects.toThrow(/simulated bg-host restart/);
    } finally {
      await disarmCrash();
    }
  }

  async function killed(runId: string): Promise<void> {
    await db.sql`
      UPDATE harness_shared.admission_runs
         SET finished_at = NULL,
             detail = jsonb_set(detail, '{status}', '"running"')
       WHERE id = ${runId}`;
  }

  async function edge(a: string, b: string): Promise<{ run_id: string; at: string } | undefined> {
    const rows = await db.sql<Array<{ run_id: string; at: string }>>`
      SELECT run_id, computed_at::text AS at FROM harness_shared.dedup_edges
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND a = ${a} AND b = ${b}`;
    return rows[0];
  }

  async function runRow(runId: string): Promise<{ started_at: string; detail: Record<string, unknown> }> {
    const rows = await db.sql<Array<{ started_at: Date; detail: Record<string, unknown> }>>`
      SELECT started_at, detail FROM harness_shared.admission_runs WHERE id = ${runId}`;
    return { started_at: rows[0]!.started_at.toISOString(), detail: rows[0]!.detail };
  }

  interface Witness {
    a: string; b: string;
    before: { cos: number; runId: string; computedAt: string } | null;
    after: { cos: number; runId: string; computedAt: string } | null;
    embeddingSha256: { a: string | null; b: string | null };
  }
  interface EdgeEvidence {
    scope: { workspaceId: string; harnessSlug: string; runId: string };
    coverage: string;
    missingPriorChunks: string[];
    pin: { embeddedIds: string[]; embeddings: Record<string, string>; fingerprint: string };
    writes: Record<string, { changed: number; omitted: number; samples: Witness[] }>;
  }
  const retained = async (id: string) => (await runRow(id)).detail.edgeEvidence as EdgeEvidence;

  it('retains original vector-change preimages through a committed-chunk retry, completion and later overwrite', async () => {
    await seed();
    await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'witness-baseline' });
    const baseline = await retained('witness-baseline');
    expect(baseline.pin.embeddedIds).toEqual(['a', 'b', 'c']);
    const baselineEdge = await edge('a', 'c');
    await db.sql`UPDATE harness_shared.work_items SET embedding = '[0.999,0.04,0]'::vector
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`;
    await interruptedAttempt('witness-change', Date.now());
    const first = await retained('witness-change');
    const chunkKey = Object.keys(first.writes).find(key => key.startsWith('chunk:') && key.endsWith(':0'))!;
    const witness = first.writes[chunkKey]!.samples.find(s => s.a === 'a' && s.b === 'c')!;
    expect(witness.before).toMatchObject({ runId: 'witness-baseline' });
    expect(witness.before!.cos).toBeLessThan(0.9);
    expect(new Date(witness.before!.computedAt).getTime()).toBe(new Date(baselineEdge!.at).getTime());
    expect(witness.after).toMatchObject({ runId: 'witness-change' });
    expect(witness.after!.cos).toBeGreaterThan(0.9);
    expect(witness.embeddingSha256.b).not.toBe(baseline.pin.embeddings.c);
    expect(first.pin.embeddings.c).toBe(witness.embeddingSha256.b);
    expect(Object.keys(first.writes).filter(key => key.endsWith(':1'))).toEqual([]);

    // Model a kill after atomic edge/evidence commit but before chunk checkpoint.
    // The retry sees already refreshed values and must keep the first witness.
    await killed('witness-change');
    await db.sql`UPDATE harness_shared.admission_runs
      SET detail = detail #- '{resume,chunks,0}' WHERE id = 'witness-change'`;
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, payload, created_ts, embedding, embedding_mode)
      VALUES (${WS}, ${HARNESS}, 'e', 'new member', '', 'open', '{}'::jsonb, 3, '[1,0,0]'::vector, 'gemma')`;
    await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'witness-change' });
    const completed = await retained('witness-change');
    expect(completed.pin).toEqual(first.pin);
    expect(completed.writes[chunkKey]).toEqual(first.writes[chunkKey]);
    expect(completed.writes['delta:2']!.samples.some(s => s.b === 'e' && s.after?.runId === 'witness-change')).toBe(true);
    expect(completed.scope).toEqual({ workspaceId: WS, harnessSlug: HARNESS, runId: 'witness-change' });
    expect(completed.coverage).toContain('concurrent-writers-not-covered');
    expect(completed.missingPriorChunks).toEqual([]);

    await db.sql`UPDATE harness_shared.work_items SET embedding = '[0,0,1]'::vector
      WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'c'`;
    await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'witness-later' });
    expect(await edge('a', 'c')).toBeUndefined();
    expect(await retained('witness-change')).toEqual(completed);
    expect(await retained('witness-baseline')).toEqual(baseline);
    const removed = (await retained('witness-later')).writes['stale-removal:1']!.samples;
    expect(removed).toContainEqual(expect.objectContaining({ a: 'a', b: 'c',
      before: expect.objectContaining({ runId: 'witness-change' }), after: null }));
  }, 60_000);

  it('rolls back edge writes when their evidence cannot commit, then recovers normally', async () => {
    await seed();
    await db.sql.unsafe(`CREATE FUNCTION reject_census_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.detail #> '{edgeEvidence,writes}' IS DISTINCT FROM OLD.detail #> '{edgeEvidence,writes}' THEN
          RAISE EXCEPTION 'evidence persistence refused';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER reject_census_evidence BEFORE UPDATE ON harness_shared.admission_runs
        FOR EACH ROW EXECUTE FUNCTION reject_census_evidence();`);
    try {
      await expect(runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'witness-atomic' }))
        .rejects.toThrow('evidence persistence refused');
      expect(await db.sql`SELECT a FROM harness_shared.dedup_edges`).toHaveLength(0);
      expect((await retained('witness-atomic')).writes).toEqual({});
    } finally {
      await db.sql.unsafe('DROP TRIGGER reject_census_evidence ON harness_shared.admission_runs; DROP FUNCTION reject_census_evidence();');
    }
    await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'witness-atomic' });
    expect((await runRow('witness-atomic')).detail.status).toBe('complete');
    expect(Object.values((await retained('witness-atomic')).writes).some(w => w.changed > 0)).toBe(true);
  }, 60_000);

  it('reports omitted witnesses and isolates identical endpoint IDs in other tenants', async () => {
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, payload, created_ts, embedding, embedding_mode)
      SELECT ${WS}, ${HARNESS}, 'p' || lpad(n::text, 2, '0'), 'same', '', 'open', '{}'::jsonb, n,
        '[1,0,0]'::vector, 'gemma' FROM generate_series(1,22) n`;
    await db.sql`INSERT INTO harness_shared.dedup_edges
      (workspace_id,harness_slug,a,b,cos,run_id) VALUES ('other',${HARNESS},'p01','p02',0.91,'foreign')`;
    await runWorkItemAdmissionCensus({ ...base, chunkCount: 1, sql: db.sql, runId: 'witness-bounded' });
    const saved = await retained('witness-bounded');
    const scan = Object.entries(saved.writes).find(([key]) => key.startsWith('chunk:'))![1];
    expect(scan.changed).toBe(231);
    expect(scan.samples).toHaveLength(ADMISSION_CENSUS_EDGE_EVIDENCE_LIMIT);
    expect(scan.omitted).toBe(231 - ADMISSION_CENSUS_EDGE_EVIDENCE_LIMIT);
    expect(scan.samples.find(s => s.a === 'p01' && s.b === 'p02')!.before).toBeNull();
    expect(await db.sql`SELECT run_id FROM harness_shared.dedup_edges WHERE workspace_id='other'`)
      .toEqual([{ run_id: 'foreign' }]);
  }, 60_000);

  it('skips the finished chunk, keeps the first start, and scans items filed after the pin', async () => {
    await seed();
    await interruptedAttempt('resume-1', 5_000);
    const interrupted = await runRow('resume-1');
    const pin = interrupted.detail.resume as { chunks: Record<string, unknown>; pinnedEmbeddedIds: string[]; censusBefore: number };
    expect(Object.keys(pin.chunks)).toEqual(['0']);
    expect(pin.pinnedEmbeddedIds).toEqual(['a', 'b', 'c']);
    expect(pin.censusBefore).toBe(0);
    await killed('resume-1');
    const chunk0Edges = [await edge('a', 'b'), await edge('a', 'c')];
    expect(chunk0Edges.every((e) => e?.run_id === 'resume-1')).toBe(true);

    // Filed between the attempts: sorts after every pinned id, so a live re-read
    // would have shifted nothing here, but it is not in the pin at all.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, lane, payload,
         created_ts, embedding, embedding_mode)
      VALUES (${WS}, ${HARNESS}, 'e', 'Alpha echo', '', 'open', NULL, '{}'::jsonb, 2,
              '[0.995,0.09,0]'::vector, 'gemma')`;

    const resumed = await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'resume-1', now: () => 9_000 });

    // Chunk 0 was NOT re-scanned: its edges keep the first attempt's computed_at.
    expect([await edge('a', 'b'), await edge('a', 'c')]).toEqual(chunk0Edges);
    // Chunk 1 ran on resume, and the delta scan covered the new item.
    expect((await edge('b', 'c'))?.run_id).toBe('resume-1');
    expect((await edge('a', 'e'))?.run_id).toBe('resume-1');
    expect(resumed.chunkCoverage).toEqual([2, 1]);
    expect(resumed.embeddedItems).toBe(4);
    expect(resumed.corpusSize).toBe(5);
    expect(resumed.memberRows).toBe(5);
    // censusBefore is the first attempt's reading, taken before any edge existed.
    expect(resumed.censusBefore).toBe(0);

    const done = await runRow('resume-1');
    expect(done.started_at).toBe(new Date(5_000).toISOString());
    expect(done.detail.status).toBe('complete');
    expect(done.detail.resume).toEqual({
      attempts: 2,
      resumedChunks: 1,
      pinnedEmbeddedItems: 3,
      deltaAnchors: 1,
      anchorsMissingEmbedding: 0,
      discarded: null,
    });
  }, 60_000);

  it('CONTROL: without the checkpoint the same re-run re-scans chunk 0 (computed_at moves)', async () => {
    await seed();
    await interruptedAttempt('resume-control', 5_000);
    await killed('resume-control');
    const before = await edge('a', 'b');
    await db.sql`
      UPDATE harness_shared.admission_runs SET detail = detail - 'resume' WHERE id = ${'resume-control'}`;

    const rerun = await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'resume-control', now: () => 9_000 });

    expect((await edge('a', 'b'))?.at).not.toBe(before?.at);
    expect(rerun.censusBefore).toBeGreaterThanOrEqual(1);
    expect((await runRow('resume-control')).detail.resume).toMatchObject({ attempts: 1, resumedChunks: 0 });
  }, 60_000);

  it('resumes a failed attempt in which a pinned item later lost its embedding, without a coverage error', async () => {
    await seed();
    await interruptedAttempt('resume-lost', 5_000);
    // 'b' is the only anchor of the unfinished chunk 1. Under the old live
    // row_number partition, losing it shifted 'c' into chunk 1 as well.
    await db.sql`
      UPDATE harness_shared.work_items SET embedding = NULL, embedding_mode = NULL
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND feature_id = 'b'`;

    const resumed = await runWorkItemAdmissionCensus({ ...base, sql: db.sql, runId: 'resume-lost', now: () => 9_000 });

    expect(resumed.chunkCoverage).toEqual([2, 0]);
    expect(resumed.embeddedItems).toBe(2);
    expect((await runRow('resume-lost')).detail.resume).toMatchObject({
      attempts: 2,
      resumedChunks: 1,
      anchorsMissingEmbedding: 1,
    });
  }, 60_000);

  it('restarts legacy corpus pins instead of reusing their completed chunks', async () => {
    await seed();
    await interruptedAttempt('resume-legacy-corpus', 5_000);
    await db.sql`
      UPDATE harness_shared.admission_runs
         SET detail = jsonb_set(detail, '{resume,schemaVersion}',
                                '"work-item-admission-census-resume-v1"'::jsonb)
       WHERE id = 'resume-legacy-corpus'`;

    const result = await runWorkItemAdmissionCensus({
      ...base, sql: db.sql, runId: 'resume-legacy-corpus', now: () => 9_000,
    });
    const row = await runRow('resume-legacy-corpus');
    expect(row.started_at).toBe(new Date(9_000).toISOString());
    expect(row.detail.resume).toMatchObject({ attempts: 1, resumedChunks: 0 });
    expect(result.corpusSize).toBe(4);
  }, 60_000);

  it('refuses to resume a complete run, a different chunking, or a pin past its age bound', () => {
    const pin = {
      schemaVersion: ADMISSION_CENSUS_RESUME_SCHEMA,
      chunkCount: 2,
      edgeFloor: 0.85,
      componentFloor: 0.9,
      profileId: null,
      pinnedEmbeddedIds: ['a', 'b'],
      // The module's rule: sha256 over the ids joined by U+0001.
      pinnedFingerprint: createHash('sha256').update('a\u0001b').digest('hex'),
      censusBefore: 0,
      attempts: 1,
      // '7' is out of range for chunkCount 2 and malformed; both must be dropped.
      chunks: { '0': { positions: 1, present: 1, anchors: 1, edges: 0, hard: 0 }, '7': { positions: 1 } },
    };
    const row = (status: string, startedMs = 0) => ({ started_at: new Date(startedMs), detail: { status, resume: pin } });

    const ok = parseAdmissionCensusResume(row('running'), { chunkCount: 2, nowMs: 1_000 });
    expect(ok?.pin.chunks).toEqual({ '0': { positions: 1, present: 1, anchors: 1, edges: 0, hard: 0 } });
    expect(parseAdmissionCensusResume(row('failed'), { chunkCount: 2, nowMs: 1_000 })).not.toBeNull();
    expect(parseAdmissionCensusResume(row('complete'), { chunkCount: 2, nowMs: 1_000 })).toBeNull();
    expect(parseAdmissionCensusResume(row('running'), { chunkCount: 4, nowMs: 1_000 })).toBeNull();
    expect(
      parseAdmissionCensusResume(row('running'), { chunkCount: 2, nowMs: ADMISSION_CENSUS_RESUME_MAX_AGE_MS + 1 }),
    ).toBeNull();
    expect(
      parseAdmissionCensusResume(
        { started_at: new Date(0), detail: { status: 'running', resume: { ...pin, pinnedFingerprint: 'tampered' } } },
        { chunkCount: 2, nowMs: 1_000 },
      ),
    ).toBeNull();
  });
});
