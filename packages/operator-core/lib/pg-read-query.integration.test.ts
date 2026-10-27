/**
 * pg-read-query.integration.test.ts — the READ-ONLY enforcement + row cap of
 * the dev:pg_query helper, against real Postgres (shared testcontainer, Docker
 * required), a fresh migrated org DB.
 *
 * The helper has THREE guards, each tested here:
 *   1. regex          — must be a single SELECT / WITH…SELECT (rejects plain writes early)
 *   2. subquery-wrap  — the LIMIT cap wraps the query in `SELECT * FROM (…)`,
 *                       which PG forbids for a data-modifying CTE (the regex bypass)
 *   3. READ ONLY txn  — PG blocks any remaining write path (e.g. a volatile
 *                       function side effect) — proven via transaction_read_only
 *
 * Run: cd packages/operator-core && \
 *   npx vitest run --config vitest.integration.config.ts lib/pg-read-query.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  boundedPgReadTxn,
  pgReadQuery,
  explainReadQuery,
  PgReadQueryError,
  PgReadQueryTimeoutError,
  describeRelation,
  listRelations,
} from './pg-read-query';
import { pgMutateQuery } from './pg-mutate-query';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('pgReadQuery (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('runs a SELECT and returns rows + field names', async () => {
    const r = await pgReadQuery("SELECT 1 AS n, 'x' AS label", { client: db.adminSql });
    expect(r.rows).toEqual([{ n: 1, label: 'x' }]);
    expect(r.fields).toEqual(['n', 'label']);
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('reads PG-canonical projection tables (harness_plans exists, returns rows array)', async () => {
    const r = await pgReadQuery(
      'SELECT plan_slug, status FROM harness_shared.harness_plans LIMIT 5',
      { client: db.adminSql },
    );
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('runs inside a READ ONLY transaction (PG-enforced, not just the regex)', async () => {
    const r = await pgReadQuery("SELECT current_setting('transaction_read_only') AS ro", {
      client: db.adminSql,
    });
    expect(r.rows[0]?.ro).toBe('on');
  });

  // papercusp-performance-audit-2026-10-12 P-003: agent-authored reads were 41% of
  // pg_stat_statements' 20,000 entries. The read must run with tracking off, and
  // the setting must stay inside its own transaction (pooled connections).
  it('runs with pg_stat_statements tracking off, scoped to its own transaction', async () => {
    const r = await pgReadQuery("SELECT current_setting('pg_stat_statements.track', true) AS track", {
      client: db.adminSql,
    });
    expect(r.rows[0]?.track).toBe('none');
    const [after] = await db.adminSql.begin((tx) =>
      tx.unsafe("SELECT current_setting('pg_stat_statements.track', true) AS track"),
    );
    expect(after?.track).not.toBe('none');
  });

  it('blocks a data-modifying CTE that sneaks past the regex (guard 2 and/or 3)', async () => {
    // Starts with WITH → passes the regex, but the write must NOT happen: the
    // subquery-wrap forbids a data-modifying CTE in a subquery, and the READ
    // ONLY txn forbids the INSERT — either way it rejects and writes nothing.
    await expect(
      pgReadQuery(
        "WITH w AS (INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, status) " +
          "VALUES ('ro-test-ws','h','ro-test-plan','draft') RETURNING 1 AS n) SELECT * FROM w",
        { client: db.adminSql },
      ),
    ).rejects.toThrow(/read-only|top level|data-modifying/i);

    // Prove nothing was written.
    const check = await pgReadQuery(
      "SELECT count(*)::int AS c FROM harness_shared.harness_plans WHERE plan_slug = 'ro-test-plan'",
      { client: db.adminSql },
    );
    expect(check.rows[0]?.c).toBe(0);
  });

  it('caps rows and flags truncation (LIMIT enforced in the DB)', async () => {
    const r = await pgReadQuery('SELECT generate_series(1, 10) AS n', {
      client: db.adminSql,
      maxRows: 3,
    });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.rows.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it('runs an absence query and its known-positive control in the same read-only transaction', async () => {
    const r = await pgReadQuery('SELECT 1 AS n WHERE false', {
      client: db.adminSql,
      positiveControlSql: 'SELECT 1 AS n',
    });
    expect(r.rowCount).toBe(0);
    expect(r.positiveControl).toEqual({
      rows: [{ n: 1 }],
      rowCount: 1,
      truncated: false,
      fields: ['n'],
    });
  });

  it('counts closed source items once when multiple bugs cite one item (EI-26805167986752964)', async () => {
    const cutoff = '2026-10-24T04:45:54.342531Z';
    const day = 86_400_000;
    const closeAt = Date.parse(cutoff) - 20 * day;
    const source = (feature_id: string, overrides: Record<string, unknown> = {}) => ({
      workspace_id: 'papercusp-workspace', harness_slug: 'papercusp', feature_id,
      item_kind: 'change', status: 'done', lane: null, title: '', summary: '',
      source_plan_slug: 'citation-fixture', created_ts: closeAt - day, closed_ts: closeAt,
      payload: { _completionEvidence: { filesChanged: ['src/example.ts'] } }, ...overrides,
    });
    const bug = (feature_id: string, cited: string, overrides: Record<string, unknown> = {}) =>
      source(feature_id, {
        item_kind: 'bug', status: 'open', title: `Follow-up to ${cited}`, summary: cited,
        created_ts: closeAt + day, closed_ts: null, ...overrides,
      });
    const fixture = [
      source('WI-100001'), source('WI-100002'),
      bug('EI-200001', 'WI-100001'), bug('EI-200002', 'WI-100001'),
      // The second source stays uncited: outside-window, cross-tenant and
      // observation records cannot turn it into a hit.
      bug('EI-200003', 'WI-100002', { created_ts: closeAt + 15 * day }),
      bug('EI-200004', 'WI-100002', { created_ts: closeAt - day }),
      bug('EI-200005', 'WI-100002', { workspace_id: 'foreign-workspace' }),
      bug('EI-200006', 'WI-100002', { harness_slug: 'foreign-harness' }),
      bug('EI-200007', 'WI-100002', { lane: 'observation' }),
      source('WI-100003', { closed_ts: Date.parse(cutoff) - 13 * day }),
      source('WI-100004', { closed_ts: Date.parse(cutoff) - 45 * day }),
      source('WI-100005', { payload: { _completionEvidence: { filesChanged: [] } } }),
      source('WI-100006', { workspace_id: 'foreign-workspace' }),
      source('WI-100007', { harness_slug: 'foreign-harness' }),
    ];
    const query = readFileSync(new URL('../../../scripts/work-item-citation-proxy.sql', import.meta.url), 'utf8');
    const records = JSON.stringify(fixture).replaceAll("'", "''");
    const fixtureQuery = query.replace('WITH inputs AS (', `WITH fixture_work_items AS (
      SELECT * FROM jsonb_to_recordset('${records}'::jsonb) AS w(
        workspace_id text, harness_slug text, feature_id text, item_kind text,
        status text, lane text, title text, summary text, source_plan_slug text,
        created_ts bigint, closed_ts bigint, payload jsonb)
    ), inputs AS (`).replaceAll('harness_shared.work_items', 'fixture_work_items');
    const result = await pgReadQuery(fixtureQuery, { client: db.adminSql });
    expect(result.rows).toMatchObject([{
      workspace_id: 'papercusp-workspace', harness_slug: 'papercusp',
      item_kind: 'change', plan_bound: true, closed_items: 2, cited_items: 1, citation_pct: 50,
    }]);
    expect(result.rows).toHaveLength(1);
    // postgres-js Date values carry milliseconds, even when SQL retains microseconds.
    expect(new Date(result.rows[0]!.cutoff as string).getTime()).toBe(Date.parse(cutoff));
    // A plausible wrong implementation produces three joined rows and 33.33%,
    // even though exactly two source items closed. Prove the regression catches it.
    const joinedDenominator = fixtureQuery.replaceAll('count(DISTINCT s.feature_id)', 'count(*)');
    const control = await pgReadQuery(joinedDenominator, { client: db.adminSql });
    expect(control.rows[0]).toMatchObject({ closed_items: 3, cited_items: 1, citation_pct: 33.33 });
  });

  it('rolls back real DML when its driver result arrives after the caller deadline', async () => {
    await db.adminSql.unsafe('CREATE TABLE harness_shared.query_deadline_rollback_fixture (id int PRIMARY KEY, value int)');
    await db.adminSql.unsafe('INSERT INTO harness_shared.query_deadline_rollback_fixture VALUES (1, 1)');
    let releaseResult!: () => void;
    const resultGate = new Promise<void>((resolve) => { releaseResult = resolve; });
    let markUpdated!: () => void;
    const updated = new Promise<void>((resolve) => { markUpdated = resolve; });
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => { markSettled = resolve; });
    const client = {
      begin: (fn: (tx: { unsafe: (query: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
        db.adminSql.begin(async (tx) => fn({
          unsafe: async (query, params) => {
            const rows = await tx.unsafe(query, params as never[]);
            if (query.startsWith('UPDATE harness_shared.query_deadline_rollback_fixture')) {
              markUpdated();
              await resultGate;
            }
            return rows;
          },
        })).finally(markSettled),
    } as never;
    const call = pgMutateQuery(
      'UPDATE harness_shared.query_deadline_rollback_fixture SET value = 2 WHERE id = 1',
      { client, timeoutMs: 1000, expectedRows: 1 },
    );
    const assertion = expect(call).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
    try {
      // The UPDATE really ran; only delivery of its result is withheld.
      await Promise.race([updated, call]);
      await assertion;
    } finally {
      releaseResult();
      await settled;
    }
    const rows = await db.adminSql.unsafe('SELECT value FROM harness_shared.query_deadline_rollback_fixture WHERE id = 1');
    expect(rows[0]?.value).toBe(1);
  }, 15_000);

  it('rejects a plain write before it reaches the DB (guard 1)', async () => {
    await expect(
      pgReadQuery('DELETE FROM harness_shared.harness_plans', { client: db.adminSql }),
    ).rejects.toThrow(PgReadQueryError);
  });

  it('rejects multiple statements (guard 1)', async () => {
    await expect(
      pgReadQuery('SELECT 1; SELECT 2', { client: db.adminSql }),
    ).rejects.toThrow(PgReadQueryError);
  });
});

/**
 * EI-22453679671058762 recurrence guard: the lossless admin pool carries
 * `harness_shared, papercusp_shared, public` at connect time, but PgBouncer
 * transaction pooling discards that startup search_path before handing a
 * transaction to PostgreSQL. This uses an intentionally unscoped client to
 * reproduce the pooler's `$user, public` session state, then forces the
 * canonical PgBouncer predicate so the test remains isolated from the host
 * pooler while still exercising the production branch.
 */
describe('pgReadQuery — per-transaction org search_path (EI-22453679671058762)', () => {
  let db: OrgTestDb;
  let unscopedSql: postgres.Sql;

  beforeAll(async () => {
    db = await createOrgTestDb();
    unscopedSql = postgres(db.adminDsn, {
      max: 1,
      onnotice: () => {},
      prepare: false,
      connection: { search_path: '$user, public' },
    });
  }, 120_000);

  afterAll(async () => {
    await unscopedSql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('restores the canonical org path inside the transaction without leaking it', async () => {
    const [canonical] = (await unscopedSql.unsafe(
      "SELECT to_regclass('harness_shared.tool_invocations')::text AS relation",
    )) as unknown as Array<{ relation: string | null }>;
    expect(canonical?.relation).toBe('harness_shared.tool_invocations');

    const [before] = (await unscopedSql.unsafe(
      "SELECT current_setting('search_path') AS path",
    )) as unknown as Array<{ path: string }>;
    expect(before?.path).not.toContain('harness_shared');

    // CONTROL: the deliberately unscoped client cannot resolve the relation
    // outside pgReadQuery, so a green result below proves the transaction-local
    // repair rather than an accidental startup/default path.
    await expect(unscopedSql.unsafe('SELECT count(*)::int AS c FROM tool_invocations')).rejects.toMatchObject({
      code: '42P01',
    });

    const previousPgbouncer = process.env.PAPERCUSP_PGBOUNCER;
    process.env.PAPERCUSP_PGBOUNCER = '1';
    try {
      const r = await pgReadQuery('SELECT count(*)::int AS c FROM tool_invocations', {
        client: unscopedSql,
      });
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.c).toBeGreaterThanOrEqual(0);
    } finally {
      if (previousPgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
      else process.env.PAPERCUSP_PGBOUNCER = previousPgbouncer;
    }

    const [after] = (await unscopedSql.unsafe(
      "SELECT current_setting('search_path') AS path",
    )) as unknown as Array<{ path: string }>;
    expect(after?.path).toBe(before?.path);
  });
});

describe('boundedPgReadTxn (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('uses a READ ONLY transaction and lets PostgreSQL cancel a slow statement', async () => {
    const readOnly = await boundedPgReadTxn(
      async (tx) => tx`SELECT current_setting('transaction_read_only') AS read_only`,
      { client: db.adminSql, timeoutMs: 1000 },
    );
    expect(readOnly[0]?.read_only).toBe('on');

    const startedAt = Date.now();
    await expect(
      boundedPgReadTxn(
        async (tx) => tx`SELECT pg_sleep(1)`,
        { client: db.adminSql, timeoutMs: 150, acquireTimeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  // WI-6554700010018139: the operator role's lock_timeout (15s, measured 2026-10-20)
  // sits ABOVE this seam's statement_timeout, so without lockTimeoutMs a read blocked
  // behind a lock burns the whole budget and reports 57014, exactly like a slow plan.
  // With it, the same wait fails fast as 55P03, which callers may retry.
  it('surfaces a lock wait as 55P03 under lockTimeoutMs, and as 57014 without it', async () => {
    await db.adminSql`CREATE TABLE IF NOT EXISTS public.lock_timeout_probe (id int)`;
    const read = (lockTimeoutMs?: number) =>
      boundedPgReadTxn(async (tx) => tx`SELECT count(*) AS n FROM public.lock_timeout_probe`, {
        client: db.adminSql,
        timeoutMs: 1500,
        acquireTimeoutMs: 2000,
        ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
      });
    // The holder occupies one adminSql connection; the reads use the other (max: 2).
    await db.adminSql.begin(async (holder) => {
      await holder`LOCK TABLE public.lock_timeout_probe IN ACCESS EXCLUSIVE MODE`;
      const startedAt = Date.now();
      await expect(read(200)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - startedAt).toBeLessThan(1500);
      await expect(read()).rejects.toMatchObject({ code: '57014' });
    });
    await expect(read(200)).resolves.toEqual([expect.objectContaining({ n: expect.anything() })]);
  });
});

/**
 * EI-18789855771421275 recurrence guard: a bigint (int8) value beyond
 * `Number.MAX_SAFE_INTEGER` must survive `pgReadQuery` at EXACT precision, not
 * get silently rounded to the nearest representable double. `db.adminSql`
 * (used everywhere above) mirrors the canonical `getOrgPg()` client shape —
 * `types: PG_BIGINT_AS_NUMBER_TYPES` (EI-9265) — which is why the first test
 * below documents the LOSSY behavior still correctly applies there (that
 * override is intentional and stays for ordinary app code, per WI-3880). A
 * client built with NO type override (postgres-js's own default for oid 20,
 * mirroring what `getOrgPgLosslessBigint()` builds via `buildClient`'s
 * `typesOverride: {}` param) must instead come back as an exact string.
 */
describe('pgReadQuery — bigint precision (EI-18789855771421275)', () => {
  let db: OrgTestDb;
  let losslessSql: postgres.Sql;
  // 19-digit value from the reported incident — well past 2^53 (9007199254740991)
  // in both directions, so it exercises the exact rounding this bug reported.
  const BIG_NEGATIVE = '-259627072863669756';

  beforeAll(async () => {
    db = await createOrgTestDb();
    losslessSql = postgres(db.adminDsn, { max: 1, onnotice: () => {}, prepare: false, types: {} });
  }, 120_000);

  afterAll(async () => {
    await losslessSql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('documents the bug: the bigint-as-number client (db.adminSql, same shape as getOrgPg()) rounds a >2^53 bigint', async () => {
    const r = await pgReadQuery(`SELECT ${BIG_NEGATIVE}::bigint AS big_id`, { client: db.adminSql });
    expect(typeof r.rows[0]?.big_id).toBe('number');
    // The rounded value is NOT the original — proving precision was actually lost,
    // not just represented differently.
    expect(String(r.rows[0]?.big_id)).not.toBe(BIG_NEGATIVE);
  });

  it('the fix: a lossless-bigint client (what getOrgPgLosslessBigint() builds) returns the EXACT value as a string', async () => {
    const r = await pgReadQuery(`SELECT ${BIG_NEGATIVE}::bigint AS big_id`, { client: losslessSql });
    expect(r.rows[0]?.big_id).toBe(BIG_NEGATIVE);
  });

  it('a safe-range bigint is unaffected (still an exact string, just one that happens to be small)', async () => {
    const r = await pgReadQuery('SELECT 42::bigint AS big_id', { client: losslessSql });
    expect(r.rows[0]?.big_id).toBe('42');
  });
});

/**
 * EI-19331550321709126 recurrence guard: `... AT TIME ZONE 'UTC'` (a
 * timestamptz -> bare `timestamp` cast, oid 1114) is the idiom agents reach
 * for specifically to "get UTC" out of a timestamptz column. Before the fix,
 * postgres-js's default oid-1114 parser interpreted the bare string as
 * SERVER-LOCAL, so on a non-UTC server the value came back silently shifted
 * by the server's UTC offset — while still LOOKING like a correct UTC value
 * (trailing "Z"). This reproduces the exact repro shape end-to-end against a
 * real PG server whose session TZ is forced to a non-UTC zone, through
 * `pgReadQuery` (the real dev:pg_query code path).
 */
describe('pgReadQuery — timestamp-without-tz UTC parsing (EI-19331550321709126)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Force a non-UTC session TZ so a server already running UTC (as most CI/dev
    // boxes do) still exercises the bug this test guards against.
    await db.adminSql.unsafe("SET TIME ZONE 'America/New_York'");
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('AT TIME ZONE \'UTC\' round-trips to the SAME instant, not shifted by the session offset', async () => {
    const r = await pgReadQuery(
      "SELECT to_timestamp(1785654929.372) AT TIME ZONE 'UTC' AS t",
      { client: db.adminSql },
    );
    const t = r.rows[0]?.t;
    expect(t).toBeInstanceOf(Date);
    // 1785654929.372 epoch seconds == this exact UTC instant. Before the fix this
    // rendered ~4h in the future (the America/New_York offset applied on top of an
    // already-UTC value) — see the EI repro for the live-incident numbers.
    expect((t as Date).toISOString()).toBe('2026-08-02T07:15:29.372Z');
  });

  it('a genuine timestamptz column (no cast) is unaffected by the session TZ', async () => {
    const r = await pgReadQuery(
      "SELECT '2026-08-02T07:15:29.372Z'::timestamptz AS t",
      { client: db.adminSql },
    );
    expect((r.rows[0]?.t as Date).toISOString()).toBe('2026-08-02T07:15:29.372Z');
  });
});

/**
 * EI-19397658288924647 recurrence guard: `date_trunc` buckets on the SESSION
 * timezone. On this box that is America/New_York, so the obvious daily rollup
 * bucketed in EDT while the result was still serialised with a literal `Z` —
 * a label affirmatively WRONG about its own timezone, shifting every
 * agent-built daily series by 4h with nothing in the row to notice it by.
 * `pgReadQuery` now pins its transaction to UTC.
 *
 * The CONTROL test below is load-bearing: most CI/dev servers already run UTC,
 * where every assertion here passes whether or not the fix exists. It proves
 * the client really is non-UTC, so the assertions above it are not vacuous.
 */
describe('pgReadQuery — UTC bucketing (EI-19397658288924647)', () => {
  let db: OrgTestDb;
  let edtSql: postgres.Sql;
  // 01:34Z on 08-03 is 21:34 EDT on 08-02 — the two zones disagree about which
  // DAY this instant belongs to, which is the entire bug.
  const CROSSES_MIDNIGHT_IN_EDT = "timestamptz '2026-08-03 01:34:00Z'";
  const BUCKET = `date_trunc('day', ${CROSSES_MIDNIGHT_IN_EDT})::date`;

  beforeAll(async () => {
    db = await createOrgTestDb();
    // max:1 so the SET is guaranteed to land on the same connection pgReadQuery
    // then borrows — with a larger pool it could apply to a different one.
    edtSql = postgres(db.adminDsn, { max: 1, onnotice: () => {} });
    await edtSql.unsafe("SET TIME ZONE 'America/New_York'");
  }, 120_000);

  afterAll(async () => {
    await edtSql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('runs with TimeZone=UTC even when the surrounding session is not', async () => {
    const r = await pgReadQuery("SELECT current_setting('TimeZone') AS tz", { client: edtSql });
    expect(r.rows[0]?.tz).toBe('UTC');
  });

  it('buckets on the UTC day (text form — no client date-parser involved)', async () => {
    const r = await pgReadQuery(`SELECT ${BUCKET}::text AS d`, { client: edtSql });
    // Pre-fix this was '2026-08-02' — the EDT day.
    expect(r.rows[0]?.d).toBe('2026-08-03');
  });

  it("renders a `...T00:00:00.000Z` label that is TRUE, not 4h off", async () => {
    const r = await pgReadQuery(`SELECT ${BUCKET} AS d`, { client: edtSql });
    expect((r.rows[0]?.d as Date).toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });

  it('CONTROL: the SAME client outside pgReadQuery still buckets in EDT — so the above is not vacuous', async () => {
    const rows = (await edtSql.unsafe(`SELECT ${BUCKET}::text AS d`)) as unknown as Array<{ d: string }>;
    expect(rows[0]?.d).toBe('2026-08-02');
  });

  it('the pin is transaction-scoped — it must not leak onto the pooled connection', async () => {
    await pgReadQuery('SELECT 1 AS n', { client: edtSql });
    const rows = (await edtSql.unsafe(
      "SELECT current_setting('TimeZone') AS tz",
    )) as unknown as Array<{ tz: string }>;
    expect(rows[0]?.tz).toBe('America/New_York');
  });
});

// EI-10514: EXPLAIN-only schema validation (parses/plans, never executes or writes) —
// built for validateRubricReplicationSql to schema-check embedded rubric drill SQL.
describe('explainReadQuery (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('ok:true for a query against a real table/columns', async () => {
    const r = await explainReadQuery('SELECT plan_slug, status FROM harness_shared.harness_plans LIMIT 5', {
      client: db.adminSql,
    });
    expect(r).toEqual({ ok: true });
  });

  it('ok:false with the PG error info for an undefined table (42P01)', async () => {
    const r = await explainReadQuery('SELECT * FROM harness_shared.this_table_does_not_exist', {
      client: db.adminSql,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('42P01');
      expect(r.error.message).toMatch(/does not exist/i);
    }
  });

  it('ok:false with the PG error info for an undefined column (42703) — the renamed-column repro shape', async () => {
    // The literal EI-10514 repro: a drill authored from memory of the old column name.
    const r = await explainReadQuery(
      'SELECT ideas_count, created_at FROM harness_shared.scout_ticks LIMIT 1',
      { client: db.adminSql },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('42703');
    }
  });

  it('never executes/materializes the query — an aggregate over a huge generate_series is instant', async () => {
    const started = Date.now();
    const r = await explainReadQuery('SELECT count(*) FROM generate_series(1, 100000000) AS n', {
      client: db.adminSql,
    });
    expect(r).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects a write statement (guard 1, same as pgReadQuery)', async () => {
    const r = await explainReadQuery('DELETE FROM harness_shared.harness_plans', { client: db.adminSql });
    expect(r.ok).toBe(false);
  });
});

/**
 * describeRelation / listRelations — the `\d` equivalent (plan
 * bash-to-tool-substitution-2026-07-26, P-011).
 *
 * `\d` is a psql CLIENT meta-command with no SQL form, so before this it could
 * not be expressed through dev:pg_query at all. The bash audit measured 88 such
 * atoms — the single largest psql residue — which is why this is a tool gap and
 * not a routing problem.
 */
describe('describeRelation / listRelations (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('describes a schema-qualified table: columns, indexes, constraints', async () => {
    const d = await describeRelation('harness_shared.harness_plans', { client: db.adminSql });
    expect(d).not.toBeNull();
    expect(d!.relation).toBe('harness_shared.harness_plans');
    expect(d!.kind).toBe('table');
    expect(d!.columns.length).toBeGreaterThan(0);
    // Every column carries a resolved type + nullability, like `\d` — asserted
    // structurally rather than against specific column names, so the test does
    // not break every time the table gains or renames a column.
    expect(d!.columns.map((c) => c.name)).toContain('workspace_id');
    for (const col of d!.columns) {
      expect(col.name).toBeTruthy();
      expect(col.type).not.toBe('');
      expect(col.type).not.toBe('unknown');
      expect(typeof col.nullable).toBe('boolean');
    }
    // A table with a primary key must report it as a constraint.
    expect(d!.constraints.some((c) => c.type === 'PRIMARY KEY')).toBe(true);
    expect(d!.indexes.length).toBeGreaterThan(0);
  });

  it('uses two catalog round-trips per describe to keep concurrent calls within their deadline (EI-25597414544524089)', async () => {
    let queryCount = 0;
    const countingClient = new Proxy(db.adminSql, {
      apply(target, thisArg, args) {
        queryCount += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });

    const d = await describeRelation('harness_shared.harness_plans', { client: countingClient });

    expect(d?.relation).toBe('harness_shared.harness_plans');
    expect(queryCount).toBe(2);
  });

  it('resolves a BARE table name to the same relation a query would use', async () => {
    const bare = await describeRelation('harness_plans', { client: db.adminSql });
    expect(bare?.relation).toBe('harness_shared.harness_plans');
  });

  it('returns null for a missing relation rather than an empty description', async () => {
    // An empty description would read as "this table has no columns", which is
    // a far more confusing answer than "no such relation".
    expect(await describeRelation('no_such_table_xyz', { client: db.adminSql })).toBeNull();
  });

  it('renders NOT NULL constraints by name, not as a bare catalog code', async () => {
    // PG 17+ materialises NOT NULL as a pg_constraint row with contype 'n';
    // without the mapping over half a table's constraints render as "n".
    const d = await describeRelation('harness_shared.harness_plans', { client: db.adminSql });
    for (const c of d!.constraints) {
      expect(c.type).not.toMatch(/^[a-z]$/);
    }
  });

  it('lists relations matching a glob (the \\dt equivalent)', async () => {
    const rows = await listRelations('harness_shared.*plan*', { client: db.adminSql });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.relation.includes('plan'))).toBe(true);
    expect(rows.map((r) => r.relation)).toContain('harness_shared.harness_plans');
  });

  it('excludes system schemas from a wildcard listing', async () => {
    const rows = await listRelations('*', { client: db.adminSql, limit: 2000 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.relation.startsWith('pg_catalog.'))).toBe(false);
    expect(rows.some((r) => r.relation.startsWith('information_schema.'))).toBe(false);
  });

  /**
   * WI-37360: a column's own COMMENT is where a "this field is dead, read THAT one
   * instead" pointer belongs — it lands directly on the schema an agent inspects via
   * `describe`, unlike a doc comment in a file nobody greps when orienting to a table.
   * Before this, describeRelation dropped comments entirely, so a migration adding one
   * (as WI-37360's own fix does, for harness_shared.work_items.completion_ref /
   * terminal_completion_ref) would never actually reach an agent calling `describe`.
   */
  it('surfaces a COMMENT ON COLUMN, and reports null for a column nobody commented', async () => {
    await db.adminSql`CREATE TABLE IF NOT EXISTS harness_shared._describe_comment_probe (
      commented_col text,
      plain_col text
    )`;
    await db.adminSql`COMMENT ON COLUMN harness_shared._describe_comment_probe.commented_col IS
      'DEAD — read plain_col instead.'`;
    try {
      const d = await describeRelation('harness_shared._describe_comment_probe', { client: db.adminSql });
      const commented = d!.columns.find((c) => c.name === 'commented_col');
      const plain = d!.columns.find((c) => c.name === 'plain_col');
      expect(commented?.comment).toBe('DEAD — read plain_col instead.');
      expect(plain?.comment).toBeNull();
    } finally {
      await db.adminSql`DROP TABLE IF EXISTS harness_shared._describe_comment_probe`;
    }
  });
});
