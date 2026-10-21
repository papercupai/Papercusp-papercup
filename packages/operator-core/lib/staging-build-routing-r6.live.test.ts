/**
 * LIVE census for staging-build-tool-routing-2026-10-21 AUTO-BAR-R-6 (P-006, evidence plane
 * `live`; acceptance rubric acceptance-staging-build-tool-routing-2026-10-21, criterion r-6):
 * "A non-implementer call with build:staging is served by the staging operator."
 * Model: a tools:invoke carrying build:'staging', sent through the :9071 proxy by a session other
 * than the implementer, lands a tool_invocations row whose serving_host is port-3170 and whose
 * serving_build_sha matches the build the staging operator was serving at that time.
 *
 * ORACLE: the committed SQL in
 * docs/evidence/sbtr-p006-r6-live-staging-routing-2026-10-21.rev3.probe-args.json, executed
 * verbatim against the live operator database. It counts a coord:whoami served on port-3170
 * after the 05:54:18Z proxy restart, by an owner other than the implementer, that is paired with
 * its tools:invoke wrapper (name coord:whoami) within 5s, from an owner whose other calls in the
 * same 10 minutes reached port-3070 (so the client is routed per call, not bound to :3170), and
 * whose serving_build_sha equals the sha another owner was served on port-3170 nearest in time.
 * It returns verdict 'pass' only when at least one such call exists.
 *
 * WHY A TEST FILE, not a stored probe (outside-lineage review, consult post 1192951): the check
 * must MEASURE the system when the grader runs it, not read a row someone recorded earlier.
 * scorecards:emit runs a tests check at grading time and records its own ledger row.
 *
 * CONTROLS run the SAME SQL text, with only its relation retargeted at a transaction-scoped temp
 * table of fixture rows. They show it rejects: a hit served by port-3070, a sha that differs from
 * the concurrent staging sha, the implementer's own call, a hit with no tools:invoke wrapper, a
 * wrapper for a different tool, a caller bound to :3170 (no port-3070 call in the window), a
 * failed call, and a call before the cutoff. A positive fixture passes, so the negatives are not
 * vacuous.
 *
 * GUARDED: this asserts over LIVE state, so it must never decide the green-checkpoint gate. The
 * live cases run only outside a gate fire (PAPERCUSP_GATE_FIRE_ID unset, cwd not a *-checkpoint
 * tree) AND when the run was dispatched by the operator test runner (PAPERCUSP_TEST_RUN_GROUP,
 * stamped by testing:run and by scorecards:emit when it executes a criterion's tests check) or
 * explicitly enabled:
 *
 *   PAPERCUSP_SBTR_R6_LIVE=1 npm run test:file -- packages/operator-core/lib/staging-build-routing-r6.live.test.ts
 *
 * A REQUESTED run never degrades to a skip: when the live census was requested but the database
 * did not answer, the always-run guard case FAILS. The :3070 build's tests check has no testName
 * pin, so a skipped live case beside a passing control would otherwise be counted as a pass.
 *
 * OBSERVABILITY: tool_invocations keeps about 12 days of rows. Once the oldest retained row is
 * newer than CUTOFF the census is UNOBSERVABLE and fails as such, never as a pass.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from './embedded-pg-discovery';
import { allowRealPgForLiveSuite } from './testing/live-suite-real-pg';

const WORKSPACE = 'papercusp-workspace';
const IMPLEMENTER = 'su-0f855fe4-d7e1-4198-be13-e8facd1ecaa2';
/** The :9071 proxy restart after which a build:'staging' call can be routed per call. */
const CUTOFF = '2026-10-21T05:54:18Z';
const CUTOFF_SQL_LITERAL = "timestamptz '2026-10-21 05:54:18+00'";
const LIVE_RELATION = 'harness_shared.tool_invocations';
const FIXTURE_RELATION = 'pg_temp.r6_fixture';
const PROBE_ARGS_URL = new URL(
  '../../../docs/evidence/sbtr-p006-r6-live-staging-routing-2026-10-21.rev3.probe-args.json',
  import.meta.url,
);

interface OracleRow {
  verdict: string;
  matching: number;
  hits: number;
}

export function loadR6Sql(): string {
  const parsed = JSON.parse(readFileSync(PROBE_ARGS_URL, 'utf8')) as { sql?: unknown };
  if (typeof parsed.sql !== 'string' || !parsed.sql.trim()) {
    throw new Error(`R-6 probe args at ${PROBE_ARGS_URL.pathname} carry no sql`);
  }
  return parsed.sql;
}

/** Point the oracle at another relation, changing nothing else in the SQL text. */
export function retargetR6Sql(sql: string, relation: string): { sql: string; replaced: number } {
  const parts = sql.split(LIVE_RELATION);
  return { sql: parts.join(relation), replaced: parts.length - 1 };
}

export function liveRequested(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): boolean {
  if (env.PAPERCUSP_GATE_FIRE_ID?.trim()) return false;
  if (/-checkpoint(?:[\\/]|$)/.test(cwd)) return false;
  return env.PAPERCUSP_SBTR_R6_LIVE === '1' || Boolean(env.PAPERCUSP_TEST_RUN_GROUP?.trim());
}

const ORACLE_SQL = loadR6Sql();

// ---------------------------------------------------------------------------
// Always-run cases.
// ---------------------------------------------------------------------------

describe('R-6 oracle text (always run)', () => {
  it('is the committed probe SQL: implementer excluded, cutoff pinned, both ports named', () => {
    expect(ORACLE_SQL).toContain(`t.coord_owner_id <> '${IMPLEMENTER}'`);
    expect(ORACLE_SQL).toContain(`t.invoked_at > ${CUTOFF_SQL_LITERAL}`);
    expect(ORACLE_SQL).toContain("t.serving_host='port-3170'");
    expect(ORACLE_SQL).toContain("m.serving_host='port-3070'");
    expect(ORACLE_SQL).toContain("p.args_json->>'name'='coord:whoami'");
    expect(ORACLE_SQL).toMatch(/THEN 'pass' ELSE 'unknown-or-failed' END AS verdict/);
  });

  it('retargets every reference to its relation and nothing else', () => {
    const { sql, replaced } = retargetR6Sql(ORACLE_SQL, FIXTURE_RELATION);
    expect(replaced).toBe(4);
    expect(sql).not.toContain(LIVE_RELATION);
    expect(sql.split(FIXTURE_RELATION).join(LIVE_RELATION)).toBe(ORACLE_SQL);
  });
});

describe('R-6 live guard (always run)', () => {
  it('never runs inside a gate fire or a checkpoint tree', () => {
    expect(liveRequested({ PAPERCUSP_GATE_FIRE_ID: 'f1', PAPERCUSP_SBTR_R6_LIVE: '1' }, '/x/papercusp')).toBe(false);
    expect(liveRequested({ PAPERCUSP_TEST_RUN_GROUP: 'g' }, '/x/papercusp-checkpoint/packages')).toBe(false);
  });

  it('runs when dispatched by the operator runner or explicitly enabled', () => {
    expect(liveRequested({ PAPERCUSP_TEST_RUN_GROUP: 'g' }, '/x/papercusp')).toBe(true);
    expect(liveRequested({ PAPERCUSP_SBTR_R6_LIVE: '1' }, '/x/papercusp')).toBe(true);
    expect(liveRequested({}, '/x/papercusp')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LIVE.
// ---------------------------------------------------------------------------

const LIVE_REQUESTED = liveRequested();

async function openLive(): Promise<{ client: Client | null; error: string | null }> {
  if (!LIVE_REQUESTED) return { client: null, error: 'not requested' };
  const client = new Client({ connectionString: getHarnessAdminUrl(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { client, error: null };
  } catch (error) {
    await client.end().catch(() => undefined);
    return { client: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const OPENED = await openLive();
const LIVE = OPENED.client;
allowRealPgForLiveSuite(Boolean(LIVE));

describe('R-6 requested census is never a skip (always run)', () => {
  it('fails when the live census was requested but the operator database did not answer', () => {
    if (!LIVE_REQUESTED) return;
    expect(
      LIVE,
      `live census requested (operator runner or PAPERCUSP_SBTR_R6_LIVE=1) but the operator database ` +
        `did not answer (${OPENED.error}). The bar is unjudged, not passed.`,
    ).not.toBeNull();
  });
});

afterAll(async () => {
  await LIVE?.end();
});

interface FixtureRow {
  id: number;
  owner: string | null;
  tool: string;
  host: string;
  at: string;
  sha?: string | null;
  args?: Record<string, unknown> | null;
  status?: string;
}

const GRADER = 'su-fixture-grader';
const OTHER = 'su-fixture-other';

/** One call the oracle must accept: hit + wrapper + a :3070 call in the window + a concurrent staging peer. */
function passingFixture(t0: number = Date.parse('2026-10-21T08:00:00Z')): FixtureRow[] {
  const at = (deltaMs: number) => new Date(t0 + deltaMs).toISOString();
  return [
    { id: 1, owner: GRADER, tool: 'coord:whoami', host: 'port-3170', at: at(0), sha: 'sha-staging' },
    {
      id: 2,
      owner: GRADER,
      tool: 'tools:invoke',
      host: 'port-3170',
      at: at(-1_000),
      sha: 'sha-staging',
      args: { name: 'coord:whoami', args: {}, build: 'staging' },
    },
    { id: 3, owner: GRADER, tool: 'coord:orient', host: 'port-3070', at: at(-120_000), sha: 'sha-release' },
    { id: 4, owner: OTHER, tool: 'coord:inbox', host: 'port-3170', at: at(30_000), sha: 'sha-staging' },
  ];
}

function edit(rows: FixtureRow[], id: number, patch: Partial<FixtureRow>): FixtureRow[] {
  return rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

async function runOnFixture(db: Client, rows: FixtureRow[]): Promise<OracleRow> {
  await db.query('BEGIN');
  try {
    await db.query(`CREATE TEMP TABLE r6_fixture (LIKE ${LIVE_RELATION}) ON COMMIT DROP`);
    for (const r of rows) {
      await db.query(
        `INSERT INTO ${FIXTURE_RELATION}
           (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id, window_key, status,
            coord_owner_id, serving_host, serving_build_sha, args_json, invoked_at)
         VALUES ($1, $2, 'papercusp', 'fixture', $3, 'su', 'fixture', 'fixture', $4, $5, $6, $7, $8, $9)`,
        [r.id, WORKSPACE, r.tool, r.status ?? 'ok', r.owner, r.host, r.sha ?? null, r.args ? JSON.stringify(r.args) : null, r.at],
      );
    }
    const { sql, replaced } = retargetR6Sql(ORACLE_SQL, FIXTURE_RELATION);
    expect(replaced).toBe(4);
    const res = await db.query<OracleRow>(sql);
    expect(res.rows).toHaveLength(1);
    return res.rows[0]!;
  } finally {
    await db.query('ROLLBACK');
  }
}

describe.skipIf(!LIVE)('LIVE: R-6 oracle controls on fixture rows (same SQL text)', () => {
  it('accepts one routed non-implementer staging call (positive control)', async () => {
    expect(await runOnFixture(LIVE!, passingFixture())).toEqual({ verdict: 'pass', matching: 1, hits: 1 });
  });

  it('rejects a hit served by port-3070', async () => {
    const out = await runOnFixture(LIVE!, edit(passingFixture(), 1, { host: 'port-3070' }));
    expect(out.verdict).toBe('unknown-or-failed');
  });

  it('rejects a sha that differs from the concurrent staging sha', async () => {
    const out = await runOnFixture(LIVE!, edit(passingFixture(), 4, { sha: 'sha-other-build' }));
    expect(out).toEqual({ verdict: 'unknown-or-failed', matching: 0, hits: 1 });
  });

  it("rejects the implementer's own call", async () => {
    const rows = passingFixture().map((r) => (r.owner === GRADER ? { ...r, owner: IMPLEMENTER } : r));
    const out = await runOnFixture(LIVE!, rows);
    expect(out).toEqual({ verdict: 'unknown-or-failed', matching: 0, hits: 0 });
  });

  it('rejects a hit with no tools:invoke wrapper', async () => {
    const out = await runOnFixture(LIVE!, passingFixture().filter((r) => r.id !== 2));
    expect(out.verdict).toBe('unknown-or-failed');
  });

  it('rejects a wrapper that invoked a different tool', async () => {
    const out = await runOnFixture(LIVE!, edit(passingFixture(), 2, { args: { name: 'coord:orient', build: 'staging' } }));
    expect(out.verdict).toBe('unknown-or-failed');
  });

  it('rejects a caller bound to :3170 (no port-3070 call in the window)', async () => {
    const out = await runOnFixture(LIVE!, passingFixture().filter((r) => r.id !== 3));
    expect(out.verdict).toBe('unknown-or-failed');
  });

  it('rejects a failed call', async () => {
    const out = await runOnFixture(LIVE!, edit(passingFixture(), 1, { status: 'error' }));
    expect(out.verdict).toBe('unknown-or-failed');
  });

  it('rejects a call before the cutoff', async () => {
    const out = await runOnFixture(LIVE!, passingFixture(Date.parse(CUTOFF) - 3_600_000));
    expect(out.verdict).toBe('unknown-or-failed');
  });
});

describe.skipIf(!LIVE)('LIVE: R-6 non-implementer build:staging call served by the staging operator (AUTO-BAR-R-6)', () => {
  it('the committed oracle returns pass over the live tool_invocations ledger', async () => {
    const db = LIVE!;
    await db.query('BEGIN READ ONLY');
    try {
      await db.query("SET LOCAL statement_timeout = '30s'");
      const retained = await db.query<{ oldest: Date | null }>(
        `SELECT min(invoked_at) AS oldest FROM ${LIVE_RELATION}
          WHERE workspace_id = $1 AND invoked_at > now() - interval '60 days'`,
        [WORKSPACE],
      );
      const oldest = retained.rows[0]?.oldest ? new Date(retained.rows[0].oldest).toISOString() : null;
      expect(
        oldest !== null && Date.parse(oldest) <= Date.parse(CUTOFF),
        `UNOBSERVABLE: the oldest retained tool_invocations row (${oldest}) is newer than the cutoff ${CUTOFF}`,
      ).toBe(true);

      const res = await db.query<OracleRow>(ORACLE_SQL);
      const row = res.rows[0];
      console.log(`R-6 census verdict=${row?.verdict} matching=${row?.matching} hits=${row?.hits} oldestRetained=${oldest}`);
      expect(res.rows).toHaveLength(1);
      expect(row!.verdict, `R-6 oracle found ${row!.hits} candidate call(s), ${row!.matching} with a matching staging sha`).toBe('pass');
      expect(row!.matching).toBeGreaterThan(0);
    } finally {
      await db.query('ROLLBACK');
    }
  });
});
