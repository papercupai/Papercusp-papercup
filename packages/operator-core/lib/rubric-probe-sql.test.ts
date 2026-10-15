/**
 * R-4 (test-rubric-unification-2026-10-12#P-004): a rubric probe check can
 * measure with read-only SQL, and a probe that attempts to write is refused
 * without changing any row.
 *
 * The chain under test is the production one, end to end:
 *   evaluateCriterionProbeChecks → runContinuityProbeBatch → a kind:'sql' probe
 *   → dispatched to dev:pg_query (the REAL handler) → the REAL pgReadQuery guard
 *   (assertSingleReadStatement, SET TRANSACTION READ ONLY, SET LOCAL
 *   statement_timeout, LIMIT maxRows+1).
 * There is no second allowlist: the SQL probe has no execution path of its own.
 *
 * Only the Postgres client at the very bottom is a fixture. It holds one
 * sentinel row and enforces a READ ONLY transaction the way Postgres does
 * (SQLSTATE 25006). The fixture is falsifiable — the control case shows the
 * same write DOES change the sentinel outside a READ ONLY transaction — so
 * "unchanged" below is the guard's doing, not the fixture's. Real-Postgres
 * enforcement of the READ ONLY transaction is pinned separately by
 * pg-read-query.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeTxnLog {
  statements: string[];
}

const fakeDb = vi.hoisted(() => {
  const state = { sentinel: { id: 1, v: 'original' }, txns: [] as FakeTxnLog[] };
  const WRITE_VERB = /\b(insert|update|delete|create|drop|alter|truncate)\b/i;

  function rowsFor(text: string): Record<string, unknown>[] {
    if (/generate_series/i.test(text)) return Array.from({ length: 10 }, (_, i) => ({ i: i + 1 }));
    if (/probe_sentinel/i.test(text)) return [{ id: state.sentinel.id, v: state.sentinel.v }];
    return [{ n: 1 }];
  }

  /** A transaction handle that executes like Postgres for the statements this suite issues. */
  function transaction(log: FakeTxnLog) {
    let readOnly = false;
    const unsafe = async (text: string) => {
      log.statements.push(text);
      if (/^SET TRANSACTION READ ONLY$/i.test(text.trim())) {
        readOnly = true;
        return [];
      }
      if (/^\s*(SET\b|SELECT set_config)/i.test(text)) return [];
      const write = WRITE_VERB.exec(text);
      if (write) {
        if (readOnly) {
          throw Object.assign(new Error(`cannot execute ${write[1]!.toUpperCase()} in a read-only transaction`), {
            code: '25006',
          });
        }
        state.sentinel.v = 'written';
        return [];
      }
      const limit = /LIMIT (\d+)\s*$/i.exec(text);
      const rows = rowsFor(text);
      return limit ? rows.slice(0, Number(limit[1])) : rows;
    };
    // Tagged-template calls (helper reads) are recorded and answer no rows.
    return Object.assign(
      async (...parts: unknown[]) => {
        log.statements.push(`<tagged>${String(parts[0])}`);
        return [];
      },
      { unsafe },
    );
  }

  const client = Object.assign(async () => [], {
    unsafe: async () => [],
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      const log: FakeTxnLog = { statements: [] };
      state.txns.push(log);
      return fn(transaction(log));
    },
  });

  return {
    state,
    client,
    transaction,
    reset() {
      state.sentinel = { id: 1, v: 'original' };
      state.txns.length = 0;
    },
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPgLosslessBigint: () => ({ sql: fakeDb.client }),
  pgbouncerEnabled: () => false,
}));

// The DB-backed advisories around the read are not under test here (their own
// suites pin them); the read itself — pgReadQuery — stays REAL.
vi.mock('./pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildTenantScopeAdvisory: async () => null,
  buildJsonTextSearchAdvisory: () => null,
  describeReferencedTableColumns: async () => [],
  describeRelation: async () => null,
  listRelations: async () => [],
}));

import pgQueryTool from './agent-tools/dev/pg_query';
import {
  SQL_PROBE_DEFAULT_MAX_ROWS,
  SQL_PROBE_TOOL,
  continuityProbeRevision,
  continuityProbeSchema,
} from './continuity-probes';
import { evaluateCriterionProbeChecks, validateCriterionCheckPaths } from './rubrics-criterion-checks';

const PROBE_BUDGET_MS = 4_000;
const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];

/** The grading-time dispatcher: by name, into the real projected tool handler. */
async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  dispatched.push({ name, args });
  if (name !== pgQueryTool.name) throw new Error(`sql probe dispatched to an unexpected tool: ${name}`);
  return pgQueryTool.handler(args as never, {} as never);
}

function sqlProbe(sql: string, expectation: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    kind: 'sql',
    sql,
    ...extra,
    schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL)!,
    expect: expectation,
  };
}

function grade(probe: Record<string, unknown>, rating: string) {
  return evaluateCriterionProbeChecks({
    criteria: [{ key: 'r-4', check: { kind: 'probe', probe } }],
    ratings: { 'r-4': { rating } },
    dispatchTool,
    probeTimeoutMs: PROBE_BUDGET_MS,
  });
}

/** The data statement of a pgReadQuery transaction (everything after its SET prologue). */
function dataStatements(log: FakeTxnLog): string[] {
  return log.statements.filter((s) => !/^\s*(SET\b|SELECT set_config|DO \$untracked\$|<tagged>)/i.test(s));
}

beforeEach(() => {
  fakeDb.reset();
  dispatched.length = 0;
});

describe('R-4 — rubric probe checks run read-only SQL through the dev:pg_query guard', () => {
  it('dispatches every SQL probe to dev:pg_query itself (no parallel execution path)', () => {
    expect(SQL_PROBE_TOOL).toBe('dev:pg_query');
    expect(pgQueryTool.name).toBe(SQL_PROBE_TOOL);
    expect(continuityProbeRevision(SQL_PROBE_TOOL)).toBeTruthy();
    // The generic tool-probe door stays closed to dev:pg_query and names the sanctioned route.
    const asToolProbe = continuityProbeSchema.safeParse({
      kind: 'tool',
      tool: SQL_PROBE_TOOL,
      args: { sql: 'SELECT 1' },
      schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL)!,
      expect: { path: '$.rowCount', op: 'eq', value: 1 },
    });
    expect(asToolProbe.success).toBe(false);
    expect(JSON.stringify(asToolProbe.error?.issues)).toContain("kind:'sql'");
  });

  it('a read-only SELECT whose typed expectation holds rates pass, inside READ ONLY with a row cap and statement timeout', async () => {
    const result = await grade(
      sqlProbe('SELECT v FROM probe_sentinel WHERE id = 1', { path: '$.rows[0].v', op: 'eq', value: 'original' }),
      'healthy',
    );
    expect(result).toMatchObject({ ok: true, checkRuns: { 'r-4': { kind: 'probe', verdict: 'pass', status: 'fresh' } } });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      name: 'dev:pg_query',
      args: { sql: 'SELECT v FROM probe_sentinel WHERE id = 1', maxRows: SQL_PROBE_DEFAULT_MAX_ROWS, timeoutMs: PROBE_BUDGET_MS },
    });

    expect(fakeDb.state.txns).toHaveLength(1);
    const log = fakeDb.state.txns[0]!;
    expect(log.statements[0]).toBe('SET TRANSACTION READ ONLY');
    const timeout = log.statements.map((s) => /^SET LOCAL statement_timeout = (\d+)$/.exec(s)).find(Boolean);
    expect(timeout, 'statement_timeout must be set inside the probe transaction').toBeTruthy();
    expect(Number(timeout![1])).toBeGreaterThan(0);
    expect(Number(timeout![1])).toBeLessThanOrEqual(PROBE_BUDGET_MS);
    expect(dataStatements(log)).toEqual([
      `SELECT * FROM (SELECT v FROM probe_sentinel WHERE id = 1) AS _pgq LIMIT ${SQL_PROBE_DEFAULT_MAX_ROWS + 1}`,
    ]);
  });

  it('a SELECT whose result fails its typed expectation never rates pass', async () => {
    const failing = sqlProbe('SELECT v FROM probe_sentinel WHERE id = 1', { path: '$.rows[0].v', op: 'eq', value: 'something-else' });

    const claimedPass = await grade(failing, 'healthy');
    expect(claimedPass).toMatchObject({ ok: false, error: 'probe_contradicted', criterionKey: 'r-4' });

    const honest = await grade(failing, 'unhealthy');
    expect(honest).toMatchObject({ ok: true, checkRuns: { 'r-4': { verdict: 'fail', status: 'stale', observed: 'original' } } });
  });

  it('a write statement is refused at authoring and at grading, and never reaches Postgres', async () => {
    const write = sqlProbe("UPDATE probe_sentinel SET v = 'written' WHERE id = 1", { path: '$.rowCount', op: 'gte', value: 0 });

    const parsed = continuityProbeSchema.safeParse(write);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('not_read_only');

    const authored = validateCriterionCheckPaths([{ key: 'r-4', check: { kind: 'probe', probe: write } }] as never);
    expect(authored.ok).toBe(false);

    const graded = await grade(write, 'healthy');
    expect(graded).toMatchObject({ ok: false, error: 'probe_invalid', criterionKey: 'r-4' });

    expect(dispatched).toHaveLength(0);
    expect(fakeDb.state.txns).toHaveLength(0);
    expect(fakeDb.state.sentinel.v).toBe('original');
  });

  it('a write hidden in a WITH clause is refused by the READ ONLY transaction and the sentinel row stays unchanged', async () => {
    const hidden = sqlProbe(
      "WITH w AS (UPDATE probe_sentinel SET v = 'written' WHERE id = 1 RETURNING v) SELECT v FROM w",
      { path: '$.rows[0].v', op: 'eq', value: 'written' },
    );
    // It passes the statement-shape check (it starts with WITH), so only the transaction can stop it.
    expect(continuityProbeSchema.safeParse(hidden).success).toBe(true);

    const graded = await grade(hidden, 'healthy');
    expect(graded).toMatchObject({ ok: false, error: 'probe_run_failed', criterionKey: 'r-4' });

    expect(dispatched).toHaveLength(1);
    expect(fakeDb.state.txns).toHaveLength(1);
    const log = fakeDb.state.txns[0]!;
    const readOnlyAt = log.statements.indexOf('SET TRANSACTION READ ONLY');
    const writeAt = log.statements.findIndex((s) => /UPDATE probe_sentinel/.test(s));
    expect(readOnlyAt).toBe(0);
    expect(writeAt).toBeGreaterThan(readOnlyAt);
    expect(fakeDb.state.sentinel.v).toBe('original');
  });

  it('fixture control: outside a READ ONLY transaction the same write DOES change the sentinel', async () => {
    const tx = fakeDb.transaction({ statements: [] });
    await tx.unsafe("UPDATE probe_sentinel SET v = 'written' WHERE id = 1");
    expect(fakeDb.state.sentinel.v).toBe('written');
  });

  it('applies the declared row cap and reports truncation in the typed result', async () => {
    const capped = sqlProbe('SELECT i FROM generate_series(1, 10) AS i', { path: '$.truncated', op: 'eq', value: true }, { maxRows: 3 });
    const result = await grade(capped, 'healthy');
    expect(result).toMatchObject({ ok: true, checkRuns: { 'r-4': { verdict: 'pass' } } });
    expect(dispatched[0]?.args).toMatchObject({ maxRows: 3 });
    expect(dataStatements(fakeDb.state.txns[0]!)).toEqual(['SELECT * FROM (SELECT i FROM generate_series(1, 10) AS i) AS _pgq LIMIT 4']);

    fakeDb.reset();
    const rowCount = await grade(
      sqlProbe('SELECT i FROM generate_series(1, 10) AS i', { path: '$.rowCount', op: 'eq', value: 3 }, { maxRows: 3 }),
      'healthy',
    );
    expect(rowCount).toMatchObject({ ok: true, checkRuns: { 'r-4': { verdict: 'pass', observed: 3 } } });
  });

  it('pins an explicit row cap into every persisted SQL probe, even when the author omits one', () => {
    const parsed = continuityProbeSchema.parse(sqlProbe('SELECT 1 AS n', { path: '$.rows[0].n', op: 'eq', value: 1 }));
    expect(parsed).toMatchObject({ kind: 'sql', maxRows: SQL_PROBE_DEFAULT_MAX_ROWS });
    expect(continuityProbeSchema.safeParse(sqlProbe('SELECT 1 AS n', { path: '$.rowCount', op: 'eq', value: 1 }, { maxRows: 0 })).success).toBe(false);
  });
});
