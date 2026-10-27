/**
 * pg-read-query.test.ts — unit coverage for the single-read-statement guard
 * (the defense-in-depth check; the READ ONLY transaction is the real
 * enforcement, covered in pg-read-query.integration.test.ts) and the P-005
 * point-of-use guards (table extraction, 42703 column hint, tenant-scope
 * advisory) through an injected client stub.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
// Enrolled in tsconfig.declarations.json — typed, so no @ts-expect-error directive
// (one here would be TS2578 "unused"). Used by the AUTO-BAR-R-001-P-002 guard below
// so its tree scan cannot match detection tokens that live inside string literals.
import { stripCommentsAndStrings } from '../../../scripts/lib/strip-comments-and-strings.mjs';
// The write half of the shared Personal Vault fence — imported here so the two
// doors are pinned by ONE test block and cannot drift into one being fenced.
import { assertSingleWriteStatement } from './pg-mutate-query';
import {
  assertSingleReadStatement,
  assertReadOnlyExplainStatement,
  SET_LOCAL_UNTRACKED_STATEMENTS,
  extractPgErrorInfo,
  extractReferencedTables,
  personalVaultRefusal,
  describeReferencedTableColumns,
  buildTenantScopeAdvisory,
  buildSilentNullPathAdvisory,
  buildJsonbTypeofNegationAdvisory,
  buildJsonNullArrowAdvisory,
  buildUnusedCteAdvisory,
  buildPopulationNarrowingAdvisory,
  buildNonSummingPartitionAdvisory,
  buildExecutedPartitionAdvisory,
  executePredicatePartition,
  predicatePartitionSampleSql,
  predicatePartitionSql,
  predicatePartitionTotalSql,
  planPredicatePartition,
  PREDICATE_PARTITION_CELL_LIMIT,
  buildClaimabilityAdvisory,
  buildBacklogFlowAdvisory,
  buildCorpusNamespaceAdvisory,
  buildSessionTurnPartsJsonAdvisory,
  buildNativeToolAttributionAdvisory,
  buildAgentActivityLedgerAdvisory,
  buildAdvSessionsLivenessAdvisory,
  buildAgentFactsSupersessionAdvisory,
  buildEventFireWindowAdvisory,
  buildEpochUnitAdvisory,
  buildDbosWorkflowStatusSchemaHint,
  buildDbosHistoricalIntervalJoinAdvisory,
  buildSplitCompletionEvidenceAdvisory,
  buildDerivedColumnRedirect,
  buildToolRoutingAdvisory,
  buildJsonTextSearchAdvisory,
  TOOL_ROUTING_BY_TABLE,
  buildJsonbPathRedirect,
  buildSchemaColumnRedirect,
  parseMissingColumnName,
  clearTenantScopeSchemaCache,
  classifyTenantPrescription,
  refutedTenantAdvisory,
  pgReadQuery,
  boundedPgReadTxn,
  type PgReadTxnTimeoutContext,
  PgReadQueryError,
  PgReadQueryTimeoutError,
  PG_READ_QUERY_CALL_OVERHEAD_MS,
} from './pg-read-query';

describe('assertSingleReadStatement', () => {
  it('accepts a plain SELECT and strips a single trailing semicolon', () => {
    expect(assertSingleReadStatement('SELECT 1')).toBe('SELECT 1');
    expect(assertSingleReadStatement('  SELECT 1 ;  ')).toBe('SELECT 1');
  });

  it('accepts a WITH…SELECT (CTE)', () => {
    const q = 'WITH t AS (SELECT 1 AS n) SELECT * FROM t';
    expect(assertSingleReadStatement(q)).toBe(q);
  });

  it('accepts parenthesized SELECT operands in a UNION query expression', () => {
    const q =
      '(SELECT owner_id, occurred_at FROM harness_shared.coord_event_log WHERE owner_id = \'su-a\') ' +
      'UNION ALL ' +
      '(SELECT owner_id, updated_at FROM harness_shared.workspace_host_resources WHERE owner_id = \'su-b\')';
    expect(assertSingleReadStatement(q)).toBe(q);
  });

  it('accepts nested parentheses around a read query expression', () => {
    const q = '((SELECT 1 AS n) UNION ALL (SELECT 2 AS n))';
    expect(assertSingleReadStatement(q)).toBe(q);
  });

  it('continues to reject parenthesized non-read statements', () => {
    for (const q of ['(DELETE FROM foo)', '((UPDATE foo SET x = 1))', '(DROP TABLE foo)']) {
      expect(() => assertSingleReadStatement(q), q).toThrow(/read-only/i);
    }
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(assertSingleReadStatement('select 1')).toBe('select 1');
    expect(assertSingleReadStatement('  WiTh t as (select 1) select * from t')).toMatch(/^WiTh/);
  });

  it('rejects an empty query', () => {
    expect(() => assertSingleReadStatement('   ')).toThrow(PgReadQueryError);
  });

  it('rejects multiple statements (no `;`-separated injection)', () => {
    expect(() => assertSingleReadStatement('SELECT 1; DROP TABLE foo')).toThrow(/single statement/i);
    expect(() => assertSingleReadStatement('SELECT 1; SELECT 2')).toThrow(PgReadQueryError);
  });

  it('rejects a non-read leading statement (INSERT/UPDATE/DELETE/DDL)', () => {
    for (const q of [
      'INSERT INTO foo VALUES (1)',
      'UPDATE foo SET x = 1',
      'DELETE FROM foo',
      'DROP TABLE foo',
      'CREATE TABLE foo (id int)',
      'TRUNCATE foo',
      'ALTER TABLE foo ADD COLUMN x int',
    ]) {
      expect(() => assertSingleReadStatement(q), q).toThrow(/read-only/i);
    }
  });

  // EI-7584: the splitter must not count a `;` INSIDE a string literal (or a
  // quoted identifier, or a comment) as a statement separator.
  describe('quote/comment-aware `;` scan (EI-7584)', () => {
    it('accepts a `;` inside a single-quoted string literal', () => {
      const q = `SELECT * FROM foo WHERE reason = 'text; more text'`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a jsonb_set string argument (the reported repro shape)', () => {
      const q = `SELECT jsonb_set('{}', '{reason}', '"text; more text"')`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts an escaped quote (\'\') followed by a `;` still inside the literal', () => {
      const q = `SELECT 'it''s fine; really' AS x`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a double-quoted identifier', () => {
      const q = `SELECT "weird;column" FROM foo`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a dollar-quoted string', () => {
      const q = `SELECT $$a; b$$`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a tagged dollar-quoted string', () => {
      const q = `SELECT $tag$a; b$tag$`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a `--` line comment', () => {
      const q = `SELECT 1 -- trailing; comment`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('accepts a `;` inside a block comment', () => {
      const q = `SELECT /* a; b */ 1`;
      expect(assertSingleReadStatement(q)).toBe(q);
    });

    it('still rejects a REAL multi-statement query with a literal in the mix', () => {
      expect(() =>
        assertSingleReadStatement(`SELECT 'a; b'; DROP TABLE foo`),
      ).toThrow(/single statement/i);
    });

    it('still rejects two real SELECTs even with a literal before the separator', () => {
      expect(() => assertSingleReadStatement(`SELECT 'x'; SELECT 1`)).toThrow(PgReadQueryError);
    });
  });
});

describe('assertReadOnlyExplainStatement', () => {
  it('accepts EXPLAIN with parenthesized options and a SELECT body', () => {
    expect(assertReadOnlyExplainStatement('EXPLAIN (FORMAT TEXT) SELECT 1')).toBe(
      'EXPLAIN (FORMAT TEXT) SELECT 1',
    );
    expect(assertReadOnlyExplainStatement('EXPLAIN ANALYZE SELECT 1')).toBe('EXPLAIN ANALYZE SELECT 1');
  });

  it('preserves SELECT/WITH-only validation for the explained statement', () => {
    for (const sql of ['EXPLAIN (FORMAT TEXT) UPDATE t SET x = 1', 'EXPLAIN ANALYZE DELETE FROM t']) {
      expect(() => assertReadOnlyExplainStatement(sql)).toThrow(/read-only/i);
    }
  });

  it('rejects malformed or missing EXPLAIN bodies', () => {
    expect(() => assertReadOnlyExplainStatement('EXPLAIN (FORMAT TEXT)')).toThrow(/must include/i);
    expect(() => assertReadOnlyExplainStatement('EXPLAIN (FORMAT TEXT SELECT 1')).toThrow(/not closed/i);
  });
});

// EI-8301: dev:pg_query dropped Postgres' HINT/DETAIL on a failed query, so a
// "column does not exist" error only showed the bare message — agents then
// guessed non-obvious column names repeatedly. extractPgErrorInfo pulls the
// diagnostic fields the postgres-js driver attaches through to the payload.
describe('extractPgErrorInfo (EI-8301 — surface PG HINT/DETAIL/code/position)', () => {
  it('extracts hint/detail/code/position from a postgres-js "undefined column" error', () => {
    // Shape postgres-js throws for `SELECT updated_at FROM harness_shared.work_items`
    const pgErr = Object.assign(new Error('column "updated_at" does not exist'), {
      code: '42703',
      hint: 'Perhaps you meant to reference the column "work_items.updated_ts".',
      position: '8',
      severity: 'ERROR',
    });
    expect(extractPgErrorInfo(pgErr)).toEqual({
      message: 'column "updated_at" does not exist',
      hint: 'Perhaps you meant to reference the column "work_items.updated_ts".',
      code: '42703',
      position: '8',
    });
  });

  it('carries DETAIL through when present', () => {
    const pgErr = Object.assign(new Error('some constraint error'), {
      code: '23505',
      detail: 'Key (id)=(1) already exists.',
    });
    const info = extractPgErrorInfo(pgErr);
    expect(info.detail).toBe('Key (id)=(1) already exists.');
    expect(info.code).toBe('23505');
    expect(info.hint).toBeUndefined();
  });

  it('coerces a numeric position to a string', () => {
    const pgErr = Object.assign(new Error('boom'), { position: 42 });
    expect(extractPgErrorInfo(pgErr).position).toBe('42');
  });

  it('returns only message for a PgReadQueryError (validation error — no PG fields)', () => {
    expect(extractPgErrorInfo(new PgReadQueryError('empty query'))).toEqual({
      message: 'empty query',
    });
  });

  it('returns only message for a plain Error with no PG fields', () => {
    expect(extractPgErrorInfo(new Error('generic failure'))).toEqual({
      message: 'generic failure',
    });
  });

  it('handles a non-Error thrown value', () => {
    expect(extractPgErrorInfo('string blew up')).toEqual({ message: 'string blew up' });
  });

  it('omits empty-string PG fields rather than surfacing blanks', () => {
    const pgErr = Object.assign(new Error('x'), { hint: '', detail: '', code: '' });
    expect(extractPgErrorInfo(pgErr)).toEqual({ message: 'x' });
  });
});

describe('pgReadQuery — whole-call deadline (EI-19415142351884573)', () => {
  it('rejects with PgReadQueryTimeoutError instead of hanging when connect/acquire never settles', async () => {
    vi.useFakeTimers();
    try {
      // Simulates a hung `sql.begin()` — the exact shape of the reported bug:
      // the operator restarting mid-call, so acquiring a connection never
      // returns and Postgres itself never even sees the query.
      const hangingClient = { begin: () => new Promise(() => {}) } as never;

      const timeoutMs = 100;
      const promise = pgReadQuery('SELECT 1', { client: hangingClient, timeoutMs });
      const assertion = expect(promise).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
      // Advance past timeoutMs + the call-deadline overhead — statement_timeout
      // alone (the pre-fix behavior) would never have rejected this at all.
      await vi.advanceTimersByTimeAsync(timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resolves normally well within the deadline (the fix does not slow the happy path)', async () => {
    const rows = [{ n: 1 }];
    const fastClient = {
      begin: async (fn: (tx: { unsafe: (sql: string) => Promise<unknown> }) => Promise<void>) => {
        const tx = { unsafe: async (sql: string) => (sql.includes('SELECT * FROM') ? rows : []) };
        await fn(tx);
      },
    } as never;

    const result = await pgReadQuery('SELECT 1 AS n', { client: fastClient, timeoutMs: 5000 });
    expect(result.rows).toEqual(rows);
    expect(result.rowCount).toBe(1);
  });

  it('propagates a real connection error immediately, without waiting for the deadline', async () => {
    const failingClient = {
      begin: async () => {
        throw new Error('connection refused');
      },
    } as never;

    await expect(
      pgReadQuery('SELECT 1', { client: failingClient, timeoutMs: 5000 }),
    ).rejects.toThrow('connection refused');
  });
});

describe('boundedPgReadTxn — bounded internal loop reads', () => {
  it('sets READ ONLY, statement_timeout, and UTC before invoking the callback', async () => {
    const unsafeCalls: string[] = [];
    let taggedCalls = 0;
    const tx = Object.assign(
      async (..._args: unknown[]) => {
        taggedCalls += 1;
        return [];
      },
      {
        unsafe: async (query: string) => {
          unsafeCalls.push(query);
          return [];
        },
      },
    );
    const client = {
      begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };

    const result = await boundedPgReadTxn(
      async (transaction) => {
        await transaction`SELECT 1`;
        return 'ok';
      },
      { client: client as never, timeoutMs: 1234 },
    );

    expect(result).toBe('ok');
    expect(unsafeCalls).toEqual(['SET TRANSACTION READ ONLY', "SET LOCAL TIME ZONE 'UTC'"]);
    // One tagged query installs statement_timeout; the second is the callback's query.
    expect(taggedCalls).toBe(2);
  });

  // WI-6554700010018139: an opt-in lock_timeout lets a caller tell a lock wait (55P03)
  // from a slow statement (57014). It must stay below statement_timeout to do that.
  it('installs an opt-in transaction-local lock_timeout, clamped below statement_timeout', async () => {
    const settings = async (opts: { timeoutMs: number; lockTimeoutMs?: number }): Promise<string[]> => {
      const seen: string[] = [];
      const tx = Object.assign(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('?');
          if (text.includes('set_config(')) seen.push(`${text.match(/set_config\('(\w+)'/)?.[1]}=${String(values[0])}`);
          return [];
        },
        { unsafe: async () => [] },
      );
      await boundedPgReadTxn(async () => 'ok', {
        client: { begin: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never,
        ...opts,
      });
      return seen;
    };

    expect(await settings({ timeoutMs: 5000, lockTimeoutMs: 2000 })).toEqual([
      'statement_timeout=5000ms',
      'lock_timeout=2000ms',
    ]);
    expect(await settings({ timeoutMs: 1000, lockTimeoutMs: 9000 })).toEqual([
      'statement_timeout=1000ms',
      'lock_timeout=999ms',
    ]);
    expect(await settings({ timeoutMs: 5000 })).toEqual(['statement_timeout=5000ms']);
  });

  it('fails a hung connection acquisition before invoking the callback', async () => {
    vi.useFakeTimers();
    try {
      let callbackCalled = false;
      const promise = boundedPgReadTxn(
        async () => {
          callbackCalled = true;
          return 'late';
        },
        {
          client: { begin: () => new Promise(() => {}) } as never,
          timeoutMs: 100,
          acquireTimeoutMs: 100,
        },
      );
      const assertion = expect(promise).rejects.toThrow(/db-call-deadline/i);
      await vi.advanceTimersByTimeAsync(101);
      await assertion;
      expect(callbackCalled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries measured acquire-queue pressure without invoking the read callback twice', async () => {
    vi.useFakeTimers();
    const { beginAcquire, resetAcquireRegistryForTest } = await import('@papercusp/db-org');
    resetAcquireRegistryForTest();
    try {
      // A recent successful acquire makes the first deadline decisively QUEUED,
      // rather than the ambiguous dead-endpoint shape that must not be retried.
      const seed = beginAcquire('org-admin');
      seed.acquired();
      seed.release();

      let beginCalls = 0;
      let callbackCalls = 0;
      const tx = Object.assign(async () => [], { unsafe: async () => [] });
      const client = {
        begin: async (fn: (transaction: unknown) => Promise<unknown>) => {
          beginCalls += 1;
          if (beginCalls === 1) return new Promise(() => {});
          return fn(tx);
        },
      };

      const promise = boundedPgReadTxn(
        async () => {
          callbackCalls += 1;
          return 'verified';
        },
        {
          client: client as never,
          acquirePool: 'org-admin',
          timeoutMs: 100,
          acquireTimeoutMs: 100,
        },
      );

      // First acquire deadline (100ms) + the retry helper's first backoff (150ms).
      await vi.advanceTimersByTimeAsync(251);
      await expect(promise).resolves.toBe('verified');
      expect(beginCalls).toBe(2);
      expect(callbackCalls).toBe(1);
    } finally {
      resetAcquireRegistryForTest();
      vi.useRealTimers();
    }
  });

  it('keeps injected-client acquisition deadlines unmeasured by default', async () => {
    vi.useFakeTimers();
    try {
      const promise = boundedPgReadTxn(
        async () => 'never',
        {
          client: { begin: () => new Promise(() => {}) } as never,
          timeoutMs: 100,
          acquireTimeoutMs: 100,
        },
      );
      const caught = promise.then(
        () => {
          throw new Error('expected a deadline rejection');
        },
        (error: unknown) => error as { pool: string | null; measured: string | null },
      );
      await vi.advanceTimersByTimeAsync(101);
      const error = await caught;
      expect(error.pool).toBeNull();
      expect(error.measured).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('attributes an injected-client acquisition deadline when acquirePool is explicit', async () => {
    vi.useFakeTimers();
    try {
      const promise = boundedPgReadTxn(
        async () => 'never',
        {
          client: { begin: () => new Promise(() => {}) } as never,
          acquirePool: 'org-admin',
          timeoutMs: 100,
          acquireTimeoutMs: 100,
        },
      );
      const caught = promise.then(
        () => {
          throw new Error('expected a deadline rejection');
        },
        (error: unknown) => error as { pool: string | null; measured: string | null },
      );
      await vi.advanceTimersByTimeAsync(101);
      const error = await caught;
      expect(error.pool).toBe('org-admin');
      expect(error.measured).toMatch(/1 acquisition\(s\) WAITING/);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['acquire', 'setup', 'callback', 'commit'] as const)(
    'attaches bounded phase and safe acquire snapshots when %s times out',
    async (phase) => {
      vi.useFakeTimers();
      const { resetAcquireRegistryForTest } = await import('@papercusp/db-org');
      resetAcquireRegistryForTest();
      try {
        const never = () => new Promise<never>(() => {});
        const tx = Object.assign(async () => [], {
          unsafe: async (query: string) =>
            phase === 'setup' && query === 'SET TRANSACTION READ ONLY' ? never() : [],
        });
        const client = phase === 'acquire'
          ? { begin: never }
          : phase === 'commit'
            ? { begin: async (fn: (transaction: unknown) => Promise<unknown>) => { await fn(tx); return never(); } }
            : { begin: async (fn: (transaction: unknown) => Promise<unknown>) => fn(tx) };
        let callbackCalled = false;
        const pending = boundedPgReadTxn(
          async () => {
            callbackCalled = true;
            return phase === 'callback' ? never() : 'ok';
          },
          {
            client: client as never,
            acquirePool: 'org-admin',
            timeoutMs: 100,
            acquireTimeoutMs: 100,
          },
        );
        const settled = pending.then(
          () => { throw new Error('expected a bounded transaction deadline'); },
          (error: Error & { boundedPgReadTxn?: PgReadTxnTimeoutContext }) => error,
        );

        const deadlineMs = phase === 'acquire' || phase === 'setup'
          ? 101
          : 100 + 100 + PG_READ_QUERY_CALL_OVERHEAD_MS + 1;
        await vi.advanceTimersByTimeAsync(deadlineMs);
        const error = await settled;
        const context = (error as Error & { boundedPgReadTxn?: PgReadTxnTimeoutContext }).boundedPgReadTxn;

        expect(context).toMatchObject({
          phase,
          acquirePool: 'org-admin',
          acquireSnapshot: { pool: 'org-admin' },
          acquireTicketSnapshot: { pool: 'org-admin', active: 1 },
        });
        expect(error.message).toContain(`phase=${phase}`);
        expect(JSON.stringify(context?.acquireTicketSnapshot)).not.toMatch(/ownerId|sessionId|sql|connectionString/i);
        expect(callbackCalled).toBe(phase === 'callback' || phase === 'commit');
        if (phase === 'callback' || phase === 'commit') {
          expect(context?.acquireTicketSnapshot?.tickets[0]?.state).toBe('held');
        } else {
          expect(context?.acquireTicketSnapshot?.tickets[0]?.state).toBe('waiting');
        }
      } finally {
        resetAcquireRegistryForTest();
        vi.useRealTimers();
      }
    },
  );
});

describe('pgReadQuery — same-transaction positive control (WI-41165)', () => {
  it('runs the known-positive probe before the target on one read-only transaction and caps its evidence', async () => {
    const calls: string[] = [];
    const controlRows = [{ id: 'known-1' }, { id: 'known-2' }];
    const client = {
      begin: async (fn: (tx: { unsafe: (sql: string) => Promise<unknown> }) => Promise<void>) => {
        await fn({
          unsafe: async (sql: string) => {
            calls.push(sql);
            if (sql.includes('_pgq_positive_control')) return controlRows;
            if (sql.includes('AS _pgq LIMIT')) return [];
            return [];
          },
        });
      },
    } as never;

    const result = await pgReadQuery('SELECT id FROM t WHERE false', {
      client,
      positiveControlSql: "SELECT id FROM t WHERE id = 'known-1'",
    });

    expect(calls).toEqual([
      'SET TRANSACTION READ ONLY',
      SET_LOCAL_UNTRACKED_STATEMENTS,
      'SET LOCAL statement_timeout = 5000',
      "SET LOCAL TIME ZONE 'UTC'",
      "SELECT * FROM (SELECT id FROM t WHERE id = 'known-1') AS _pgq_positive_control LIMIT 2",
      'SELECT * FROM (SELECT id FROM t WHERE false) AS _pgq LIMIT 201',
    ]);
    expect(result.rows).toEqual([]);
    expect(result.positiveControl).toEqual({
      rows: [{ id: 'known-1' }],
      rowCount: 1,
      truncated: true,
      fields: ['id'],
    });
  });

  it('rejects a write-shaped positive control before acquiring a connection', async () => {
    const begin = vi.fn();
    await expect(
      pgReadQuery('SELECT 1', {
        client: { begin } as never,
        positiveControlSql: 'DELETE FROM t',
      }),
    ).rejects.toThrow(/read-only/i);
    expect(begin).not.toHaveBeenCalled();
  });
});

describe('pgReadQuery — read-only EXPLAIN', () => {
  it('executes EXPLAIN directly inside READ ONLY and caps plan rows', async () => {
    const calls: string[] = [];
    const explainRows = [
      { 'QUERY PLAN': 'Limit  (cost=0.00..1.00 rows=1 width=4)' },
      { 'QUERY PLAN': '  ->  Result  (cost=0.00..0.01 rows=1 width=4)' },
      { 'QUERY PLAN': '        Output: 1' },
    ];
    const client = {
      begin: async (fn: (tx: { unsafe: (sql: string) => Promise<unknown> }) => Promise<void>) => {
        await fn({
          unsafe: async (sql: string) => {
            calls.push(sql);
            return sql.startsWith('EXPLAIN') ? explainRows : [];
          },
        });
      },
    } as never;

    const result = await pgReadQuery('EXPLAIN (FORMAT TEXT) SELECT 1', { client, maxRows: 2 });

    expect(calls).toEqual([
      'SET TRANSACTION READ ONLY',
      SET_LOCAL_UNTRACKED_STATEMENTS,
      'SET LOCAL statement_timeout = 5000',
      "SET LOCAL TIME ZONE 'UTC'",
      'EXPLAIN (FORMAT TEXT) SELECT 1',
    ]);
    expect(result.rows).toEqual(explainRows.slice(0, 2));
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.fields).toEqual(['QUERY PLAN']);
  });

  it('rejects EXPLAIN of a write before executing it', async () => {
    const begin = vi.fn();
    const client = { begin } as never;
    await expect(pgReadQuery('EXPLAIN (FORMAT TEXT) UPDATE t SET x = 1', { client })).rejects.toThrow(
      /read-only/i,
    );
    expect(begin).not.toHaveBeenCalled();
  });
});

// ── P-005 point-of-use guards ────────────────────────────────────────────────

describe('extractReferencedTables (P-005)', () => {
  it('extracts FROM + JOIN names, schema-qualified or bare, lowercased + deduped', () => {
    expect(
      extractReferencedTables(
        'SELECT * FROM harness_shared.Engineer_Issues e JOIN work_items w ON w.id = e.id ' +
          'LEFT JOIN harness_shared.engineer_issues e2 ON e2.id = w.id',
      ),
    ).toEqual(['harness_shared.engineer_issues', 'work_items']);
  });

  it('does not extract a table name from inside a string literal', () => {
    expect(
      extractReferencedTables("SELECT * FROM t1 WHERE note = 'copied from harness_plans join x'"),
    ).toEqual(['t1']);
  });

  it('skips a subquery FROM ( and caps the list', () => {
    const sql =
      'SELECT * FROM (SELECT 1) sub JOIN a ON 1=1 JOIN b ON 1=1 JOIN c ON 1=1 JOIN d ON 1=1 JOIN e ON 1=1';
    expect(extractReferencedTables(sql)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not treat a table-valued function in a scalar subquery as a physical relation', () => {
    const sql =
      'SELECT tr.id, (SELECT array_agg(k) FROM jsonb_object_keys(tr.execution_details) k) AS keys ' +
      'FROM harness_shared.test_runs tr WHERE tr.id = 20852828';
    expect(extractReferencedTables(sql)).toEqual(['harness_shared.test_runs']);
  });

  it('does not treat a LATERAL table-valued function as a physical relation', () => {
    const sql =
      'SELECT tr.id FROM harness_shared.test_runs tr ' +
      'JOIN LATERAL jsonb_object_keys(tr.execution_details) k ON true WHERE tr.id = 20852828';
    expect(extractReferencedTables(sql)).toEqual(['harness_shared.test_runs']);
  });

  it('returns [] when nothing matches', () => {
    expect(extractReferencedTables('SELECT 1')).toEqual([]);
  });

  it('extracts UPDATE / INSERT INTO write targets (pg-mutate tenant gate, EI-20478724424443538)', () => {
    expect(
      extractReferencedTables("UPDATE harness_shared.Work_Items SET state = 'done' WHERE id = 'x'"),
    ).toEqual(['harness_shared.work_items']);
    expect(extractReferencedTables('INSERT INTO plans (id) VALUES (1)')).toEqual(['plans']);
    expect(extractReferencedTables('UPDATE only t SET a = 1 WHERE true')).toEqual(['t']);
  });

  it('does not mis-read FOR UPDATE OF / SKIP LOCKED keywords as tables', () => {
    expect(extractReferencedTables('SELECT * FROM t FOR UPDATE OF t SKIP LOCKED')).toEqual(['t']);
    expect(extractReferencedTables('SELECT * FROM t FOR UPDATE SKIP LOCKED')).toEqual(['t']);
    expect(extractReferencedTables('SELECT * FROM t FOR UPDATE')).toEqual(['t']);
  });
});

/** A tagged-template postgres client stub returning canned information_schema rows. */
function stubClient(rows: Array<{ table_schema: string; table_name: string; column_name: string; data_type?: string }>) {
  const calls: unknown[][] = [];
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // boundedPgReadTxn tags set_config once during setup; keep `calls` focused
    // on the schema lookup the fixture is meant to observe.
    if (!strings.join('').includes("set_config('statement_timeout'")) calls.push(values);
    return rows;
  };
  const tx = Object.assign(query, {
    unsafe: async (_text: string) => [] as typeof rows,
  });
  const sql = Object.assign(query, {
    begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
  });
  return { sql: sql as never, calls };
}

describe('describeReferencedTableColumns (P-005a — the 42703 column hint)', () => {
  it('returns each referenced table with its columns in ordinal order', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'issue_id', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'title', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'engineer_issues', column_name: 'state', data_type: 'character varying' },
    ]);
    const out = await describeReferencedTableColumns(
      'SELECT wrong_col FROM harness_shared.engineer_issues',
      { client: sql },
    );
    expect(out).toEqual([
      {
        table: 'harness_shared.engineer_issues',
        columns: ['issue_id: text', 'title: text', 'state: character varying'],
      },
    ]);
  });

  it('bounds a hung schema lookup used to enrich a 42703 error', async () => {
    vi.useFakeTimers();
    try {
      let schemaLookupStarted = false;
      const never = new Promise<unknown[]>(() => {});
      const query = async (strings: TemplateStringsArray) => {
        const text = strings.join('');
        if (text.includes("set_config('statement_timeout'")) return [];
        if (text.includes('information_schema.columns')) {
          schemaLookupStarted = true;
          return never;
        }
        return [];
      };
      const tx = Object.assign(query, { unsafe: async () => [] });
      // Keep the client callable too: without boundedAdvisoryRead, the old code
      // issued this tagged query directly and stayed pending forever.
      const client = Object.assign(query, {
        begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
        unsafe: async () => [],
      });

      const pending = describeReferencedTableColumns(
        'SELECT missing_column FROM harness_shared.work_items',
        { client: client as never },
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(PgReadQueryTimeoutError);
      await vi.advanceTimersByTimeAsync(5_001);
      await assertion;
      expect(schemaLookupStarted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a bare name matched in many schemas to the preferred one (harness_shared first)', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_zzz_clone', table_name: 'messages', column_name: 'clone_col', data_type: 'text' },
      { table_schema: 'harness_shared', table_name: 'messages', column_name: 'id', data_type: 'bigint' },
      { table_schema: 'harness_shared', table_name: 'messages', column_name: 'body', data_type: 'text' },
    ]);
    const out = await describeReferencedTableColumns('SELECT nope FROM messages', { client: sql });
    expect(out).toEqual([{ table: 'harness_shared.messages', columns: ['id: bigint', 'body: text'] }]);
  });

  it('returns [] without querying when the SQL references no tables', async () => {
    const { sql, calls } = stubClient([]);
    expect(await describeReferencedTableColumns('SELECT 1', { client: sql })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('buildTenantScopeAdvisory (P-005b — the wrong-tenant footgun)', () => {
  const TENANT_ROWS = [
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'plan_slug' },
  ];

  beforeEach(() => clearTenantScopeSchemaCache());

  it('fires for a filtered query on a tenant table with no scope predicate', async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'my-plan'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_shared.harness_plans');
    expect(advisory).toContain('workspace_id + harness_slug');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace'");
    expect(advisory).toContain("harness_slug = 'papercusp'");
    expect(advisory).toContain('raw-sql-plan-slug-needs-workspace-harness-scope');
  });

  it('is silent when the query already carries a scope column', async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'p' AND workspace_id = 'ws'",
        { client: sql },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0); // short-circuits before the schema read
  });

  it('does not treat scope columns selected for output as a tenant predicate', async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT workspace_id, harness_slug, plan_slug FROM harness_shared.harness_plans WHERE plan_slug = 'p'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_shared.harness_plans');
    expect(advisory).toContain('workspace_id + harness_slug');
  });

  it("is silent for an unfiltered aggregate (no WHERE — usually a deliberate cross-tenant count)", async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    expect(
      await buildTenantScopeAdvisory('SELECT count(*) FROM harness_shared.harness_plans', {
        client: sql,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('is silent when the referenced table has no tenant columns', async () => {
    const { sql } = stubClient([
      { table_schema: 'public', table_name: 'plain_table', column_name: 'id' },
    ]);
    expect(
      await buildTenantScopeAdvisory('SELECT * FROM plain_table WHERE id = 1', { client: sql }),
    ).toBeNull();
  });

  it("a scope column mentioned only inside a string literal does NOT count as a predicate", async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'workspace_id-lookalike'",
      { client: sql },
    );
    expect(advisory).not.toBeNull();
  });

  it('caches the schema read (second call for the same table skips the query)', async () => {
    const { sql, calls } = stubClient(TENANT_ROWS);
    await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'a'",
      { client: sql },
    );
    await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'b'",
      { client: sql },
    );
    expect(calls).toHaveLength(1);
  });

  it('propagates nothing on a schema-read failure (caller catches — advisory just absent)', async () => {
    const query = async (strings: TemplateStringsArray) => {
      if (strings.join('').includes("set_config('statement_timeout'")) return [];
      throw new Error('pg down');
    };
    const tx = Object.assign(query, {
      unsafe: async (_text: string) => [],
    });
    const throwing = Object.assign(query, {
      begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    }) as never;
    await expect(
      buildTenantScopeAdvisory("SELECT * FROM harness_shared.harness_plans WHERE x = 1", {
        client: throwing,
      }),
    ).rejects.toThrow('pg down');
  });
});

// EI-18669912007336072: the generic workspace_id/harness_slug heuristic named
// the WRONG columns for harness_shared.agent_facts (tenanted by scope +
// scope_ref; harness_slug is NULL for ~99.6% of rows) — following its own
// suggested predicate returned a clean-looking, confidence-inspiring empty
// result instead of an error. A per-table override replaces the check (and
// the suggested predicate) for known exceptions like this one.
describe('buildTenantScopeAdvisory — per-table overrides (EI-18669912007336072)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('advises the real scope+scope_ref predicate for agent_facts instead of workspace_id/harness_slug — no schema read needed', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.agent_facts WHERE expires_at < now()',
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('agent_facts');
    expect(advisory).toContain('scope + scope_ref');
    expect(advisory).toContain("scope = 'harness'");
    expect(advisory).toContain("scope_ref = 'papercusp'");
    expect(advisory).toContain('facts:list');
    expect(advisory).not.toContain('harness_slug =');
    expect(calls).toHaveLength(0); // the override is hardcoded — no information_schema read
  });

  it('falls back to a placeholder predicate when harnessSlug is unresolved', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM agent_facts WHERE expires_at < now()',
      { client: sql },
    );
    expect(advisory).toContain('scope_ref');
    expect(advisory).not.toContain('scope_ref = \'\'');
  });

  it('is silent for agent_facts when the query already filters by scope + scope_ref', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.agent_facts WHERE scope = 'harness' AND scope_ref = 'papercusp'",
        { client: sql },
      ),
    ).toBeNull();
  });

  it('is silent for agent_facts when scoped by scope_ref alone (either override column suffices)', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory("SELECT * FROM agent_facts WHERE scope_ref = 'papercusp'", {
        client: sql,
      }),
    ).toBeNull();
  });

  it('still fires for agent_facts when filtered by harness_slug alone — the exact wrong-predicate footgun', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.agent_facts WHERE harness_slug = 'papercusp'",
      { client: sql, harnessSlug: 'papercusp' },
    );
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('agent_facts');
  });

  it('still fires generically for a different table joined alongside agent_facts, while agent_facts itself is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.agent_facts f JOIN harness_shared.harness_plans p " +
        "ON p.plan_slug = f.scope_ref WHERE f.scope_ref = 'x'",
      { client: sql },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('agent_facts');
  });

  it('suggests workspace-only scope for operator-local coord_thread_posts', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, thread_id, body FROM harness_shared.coord_thread_posts WHERE thread_id = 'issue-thread-WI-6270'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('coord_thread_posts');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace'");
    expect(advisory).not.toContain('harness_slug =');
    expect(advisory).toContain('work_items:get');
    expect(calls).toHaveLength(0); // the override captures the nullable federation column
  });

  it('requires only workspace scope for task_ledger because harness_slug is nullable provenance', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT task_id, workspace_id, harness_slug, state FROM harness_shared.task_ledger WHERE task_id = 'task-1'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('task_ledger');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace'");
    expect(advisory).not.toContain("harness_slug = 'papercusp'");
    expect(advisory).toContain('processes:list');
    expect(calls).toHaveLength(0); // semantic override, no schema read
  });

  it('accepts a workspace-scoped task_ledger lookup', async () => {
    const { sql, calls } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.task_ledger WHERE task_id = 'task-1' AND workspace_id = 'papercusp-workspace'",
        { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  // EI-21601240974104741: predicate_watches is workspace-tenanted, while
  // harness_slug is nullable optional scope. Requiring both keys drops the
  // valid NULL-harness rows from workspace-level watch queries.
  it('suggests workspace-only scope for predicate_watches', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.predicate_watches WHERE predicate = 'work-item:done'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('predicate_watches');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace'");
    expect(advisory).not.toContain("harness_slug = 'papercusp'");
    expect(calls).toHaveLength(0); // semantic override; no information_schema read
  });

  it('accepts a predicate_watches workspace predicate without requiring harness_slug', async () => {
    const { sql, calls } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM predicate_watches WHERE predicate = 'work-item:done' AND workspace_id = 'papercusp-workspace'",
        { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('still warns when predicate_watches has only a harness_slug predicate', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.predicate_watches WHERE harness_slug = 'papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('predicate_watches');
    expect(advisory).toContain('workspace_id');
    expect(calls).toHaveLength(0);
  });
});

// EI-18749676091756794: the generic heuristic prescribed a WRONG query for
// harness_shared.tool_usage_rollup — it named a `harness_slug` column the
// table does not have at all, and even after dropping that, the real tenant
// workspace id matches ZERO rows because the table is keyed by a CORPUS
// NAMESPACE ('default'), not a tenant. An unscoped read is the correct one
// for these tables, so the advisory must stay silent for them.
describe('buildTenantScopeAdvisory — corpus-namespaced tables (EI-18749676091756794)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('is silent for tool_usage_rollup even though it has a workspace_id column and no scope predicate', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'tool_name' },
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'calls' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT count(*) FROM harness_shared.tool_usage_rollup WHERE tool_name = 'coord:orient'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('is silent for session_turns the same way', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'session_turns', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'session_turns', column_name: 'session_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.session_turns WHERE session_id = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('never names a column absent from the offending table — a workspace_id-only table gets no harness_slug suggestion', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'workspace_only_table', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'workspace_only_table', column_name: 'id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.workspace_only_table WHERE id = 1",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('workspace_id');
    expect(advisory).not.toContain('harness_slug');
  });

  it('still fires generically for a real tenant table joined alongside a corpus-namespaced one, while the corpus table is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'tool_usage_rollup', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.tool_usage_rollup u JOIN harness_shared.harness_plans p ' +
        "ON true WHERE u.tool_name = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('tool_usage_rollup');
  });
});

// WI-6847: event_awaits/event_wake_deliveries have a workspace_id column
// (DEFAULT 'default') that is measurably 'default' for 100% of rows — the
// generic advisory recommended a predicate that silently empties the result
// (0 of 32,152 rows on event_awaits, 0 of 37,756 on event_wake_deliveries).
// Same class as EI-18749676091756794 above; folded into the same registry.
describe('buildTenantScopeAdvisory — corpus-namespaced tables (WI-6847)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('is silent for event_awaits even though it has a workspace_id column and no scope predicate', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'event_awaits', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'event_awaits', column_name: 'event_key' },
      { table_schema: 'harness_shared', table_name: 'event_awaits', column_name: 'subscriber_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.event_awaits WHERE event_key = 'x' AND created_at > now() - interval '7 days'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('is silent for event_wake_deliveries the same way', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'event_wake_deliveries', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'event_wake_deliveries', column_name: 'subscriber_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.event_wake_deliveries WHERE subscriber_id = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('still fires generically for a real tenant table joined alongside event_awaits, while event_awaits is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'event_awaits', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.event_awaits e JOIN harness_shared.harness_plans p ' +
        "ON true WHERE e.event_key = 'x'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('event_awaits');
  });

  // EI-19324633485547042's second confirmed instance (su-1a0a0a1a, 2026-08-02): the advisory
  // suggested workspace_id = 'papercusp-workspace' for event_key_fires and returned 0 rows
  // against a real, existing fire — every row is written under the DDL default 'default'
  // (measured: 16,935 of 16,935 rows, and the table has no harness_slug column at all).
  it('is silent for event_key_fires the same way', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'event_key_fires', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'event_key_fires', column_name: 'event_key' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.event_key_fires WHERE event_key = 'green-checkpoint:red:papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });
});

// EI-20105490569127338: two more corpus-family tables, each admitted on its WRITER rather than
// on its row counts — the distinction the filing split out precisely so a registry whose value
// is trustworthiness does not accumulate entries justified by "looks corpus-shaped".
//
// session_turn_chunks: turn-chunk-sync.ts copies `st.workspace_id` straight from session_turns,
// so it is a derived projection that cannot hold a value its parent does not (1,071,004
// 'default' vs 6, mirroring the parent's own 1,181,873 vs 214).
// event_await_nodes: compose-store.ts's only two inserts both write DEFAULT_COORD_WORKSPACE,
// the literal 'default' — so all-331-rows-'default' is by construction, not a young table.
//
// The third case is the load-bearing one: it pins that the set still DISCRIMINATES. Sweeping in
// every session_*/event_* table by name would silence correct advisories and train callers to
// ignore the warning, which is the failure in the opposite direction from a missing entry.
describe('buildTenantScopeAdvisory — corpus-namespaced tables (EI-20105490569127338)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('is silent for session_turn_chunks, which inherits its workspace_id from session_turns', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'session_turn_chunks', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'session_turn_chunks', column_name: 'session_id' },
      { table_schema: 'harness_shared', table_name: 'session_turn_chunks', column_name: 'content' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT content FROM harness_shared.session_turn_chunks WHERE session_id = 'abc'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  it('is silent for event_await_nodes the same way its three event_* siblings already are', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'event_await_nodes', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'event_await_nodes', column_name: 'root_id' },
      { table_schema: 'harness_shared', table_name: 'event_await_nodes', column_name: 'subscriber_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.event_await_nodes WHERE parent_id IS NULL',
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
  });

  // The counter-example, deliberately NOT added to the set. Re-measured 2026-09-05 it has
  // INVERTED since it was first cited: 20,739 'papercusp-workspace' vs 2,721 'default' (88%
  // tenant, up from 31%), so a tenant predicate there is more legitimate now than when the
  // filing named it. This asserts the neighbouring entries did not sweep it in by name.
  it('STILL fires for session_turn_journal — genuinely tenant-mixed, so the advisory is right about it', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'session_turn_journal', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'session_turn_journal', column_name: 'session_id' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.session_turn_journal WHERE session_id = 'abc'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('session_turn_journal');
  });

  it('still fires for a real tenant table joined alongside session_turn_chunks, while the chunk table is silenced', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'session_turn_chunks', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.session_turn_chunks c JOIN harness_shared.harness_plans p ' +
        "ON true WHERE c.session_id = 'abc'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('harness_plans');
    expect(advisory).not.toContain('session_turn_chunks');
  });
});

// EI-19324633485547042: the ORIGINAL instance this item reports. harness_shared.test_runs is
// unlike the corpus-namespaced tables above — its workspace_id/harness_slug columns genuinely
// hold real values for SOME rows (the per-hive Tests-tab ingestion path) — but every CI/gate row
// (the population that matters for red-gate triage) has both NULL by construction, so the
// generic heuristic's own "already scoped" signal is BACKWARDS here: a workspace_id/harness_slug
// predicate silently EXCLUDES every CI/gate row and reads as a clean, confidence-inspiring empty
// "no failures" result. These guard the recurrence this bug report exists to prevent — without
// them, buildTestRunsAdvisory had zero test coverage despite being the fix for the reported bug.
describe('buildTenantScopeAdvisory — test_runs gate-triage trap (EI-19324633485547042)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('fires for a filtered test_runs query with no source/commit_sha predicate', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE status = 'fail'",
      { client: sql },
    );
    expect(advisory).toContain('harness_shared.test_runs');
    expect(advisory).toContain('source/commit_sha');
    expect(advisory).toContain("'pass'/'fail'/'skip'");
    expect(calls).toHaveLength(0); // purely textual — never reads the schema cache
  });

  it('still fires even when workspace_id/harness_slug ARE present — their presence is the trap, not the fix', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).not.toBeNull();
    expect(advisory).toContain('silently EXCLUDES every CI/gate row');
  });

  it('does not treat source or commit_sha selected for output as identity predicates', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status, source, commit_sha FROM harness_shared.test_runs " +
        "WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('silently EXCLUDES every CI/gate row');
    expect(advisory).toContain('source/commit_sha');
  });

  it('is silent once `source` is mentioned', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.test_runs WHERE source = 'ci' AND status = 'fail'",
        { client: sql },
      ),
    ).toBeNull();
  });

  it('is silent once `commit_sha` is mentioned', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.test_runs WHERE commit_sha = 'abc123'",
        { client: sql },
      ),
    ).toBeNull();
  });

  it('is silent for an unfiltered query (no WHERE at all)', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory('SELECT count(*) FROM harness_shared.test_runs', { client: sql }),
    ).toBeNull();
  });
});

// EI-19324633485547042: harness_shared.test_runs does NOT fit the generic "mentions
// workspace_id/harness_slug ⇒ correctly scoped" heuristic — those columns are NULL-by-design for
// every CI/dogfood-reporter row (env-derived, stamped only by the per-hive ingestion route,
// migration 413), so following the generic advisory's own suggested predicate silently excludes
// every gate row and reads as a clean "no failures". Local/admin-ui rows may now carry explicit
// tenant fields, so test_runs gets its own advisory instead: it fires for broad/partial reads and
// clears on source/commit_sha or an exact run-group fence carrying both tenant predicates.
describe('buildTenantScopeAdvisory — test_runs CI-row null trap (EI-19324633485547042)', () => {
  beforeEach(() => clearTenantScopeSchemaCache());

  it('fires for an unscoped test_runs query, warning about the CI-row null trap (not the generic predicate)', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE status <> 'passed'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('test_runs');
    expect(advisory).toContain('NULL-by-design');
    expect(advisory).toContain('source/commit_sha');
    // never the generic (wrong-for-this-table) predicate suggestion:
    expect(advisory).not.toContain("workspace_id = 'papercusp-workspace'");
    expect(calls).toHaveLength(0); // no schema read needed — test_runs never enters the generic path
  });

  it('STILL fires when the query already filters by workspace_id/harness_slug — that predicate is the trap, not the fix', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'",
      { client: sql },
    );
    expect(advisory).toContain('test_runs');
    expect(advisory).toContain('NULL-by-design');
  });

  it('allows an exact run-group read fenced by both explicit tenant predicates', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status FROM harness_shared.test_runs " +
        "WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' " +
        "AND run_group_id = 'dream-p005-authorization-20260907' LIMIT 10",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('allows explicit test_runs tenant and identity predicates inside LEFT JOIN ON', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'WITH target AS (SELECT feature_id, test_file, evidence_run_group FROM harness_shared.work_items) ' +
        'SELECT t.feature_id, tr.status FROM target t ' +
        'LEFT JOIN harness_shared.test_runs tr ' +
        "ON tr.workspace_id = 'papercusp-workspace' AND tr.harness_slug = 'papercusp' " +
        'AND tr.run_group_id = t.evidence_run_group AND tr.file_path = t.test_file ' +
        "WHERE t.feature_id = 'EI-22666749939664001' LIMIT 20",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  // EI-22633261796522656: local reporter rows are sometimes recovered by their
  // contiguous database ids rather than run_group_id. Both the primary query and
  // its positive control carry the tenant fence, so the CI-null warning must not
  // turn this known local group into a false refusal.
  it('allows a bounded local reporter id group fenced by both explicit tenant predicates', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status FROM harness_shared.test_runs " +
        "WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' " +
        'AND id BETWEEN 17630475 AND 17630479 ORDER BY id',
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('allows an exact primary-key equality without tenant predicates, including NULL-tenant rows', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT id, file_path, status FROM harness_shared.test_runs WHERE id = 20852828',
      { client: sql },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('allows a finite literal primary-key IN-list without tenant predicates', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT id, file_path, status FROM harness_shared.test_runs ' + 'WHERE id IN (20852828, 20852471)',
      { client: sql },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('allows an exact primary-key read with a set-returning function subquery in the projection', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT id, (SELECT array_agg(k) FROM jsonb_object_keys(execution_details) k) AS keys ' +
        'FROM harness_shared.test_runs WHERE id = 20852828',
      { client: sql },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps the CI-null warning when an exact id read also references another physical relation', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT tr.id, (SELECT max(w.id) FROM harness_shared.work_items w) AS item_id ' +
        'FROM harness_shared.test_runs tr WHERE tr.id = 20852828',
      { client: sql },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('keeps the CI-null warning when an exact id is only one branch of a broader OR', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE id IN (20852828, 20852471) OR status = 'fail'",
      { client: sql },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('does not borrow an id predicate from a nested query block', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'WITH ids AS (SELECT 20852828 AS id) ' +
        'SELECT * FROM harness_shared.test_runs WHERE EXISTS (SELECT 1 FROM ids WHERE id = 20852828)',
      { client: sql },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  // EI-22773920937987602: local acceptance evidence is also recovered by an
  // exact file path, newest-first, with a one-row result cap. The explicit
  // tenant fence identifies the local reporter population; the cap keeps this
  // exception from turning into a historical file-path scan.
  it('allows a bounded exact file-path read fenced by both explicit tenant predicates', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status FROM harness_shared.test_runs " +
        "WHERE file_path = 'packages/operator-core/lib/plan-audits.test.ts' " +
        "AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' " +
        'ORDER BY started_at DESC LIMIT 1',
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  // EI-22641981769449390: local dev:pg_query evidence can have a harness fence
  // but no workspace_id. Requiring the exact run group AND exact file path keeps
  // this exception limited to one local reporter identity instead of permitting
  // a broad harness-scoped historical read.
  it('allows an exact harness-scoped local run/file read without workspace_id', async () => {
    const { sql, calls } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status FROM harness_shared.test_runs " +
        "WHERE harness_slug = 'papercusp' " +
        "AND run_group_id = 'e31d1e34-7c58-4d8f-9a7b-1c2f4b6d8e90' " +
        "AND file_path = 'packages/operator-core/lib/pg-read-query.test.ts'",
      { client: sql, harnessSlug: 'papercusp' },
    );
    expect(advisory).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps the CI-null warning when the harness-scoped local file identity is open-ended', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT id, file_path, status FROM harness_shared.test_runs " +
        "WHERE harness_slug = 'papercusp' " +
        "AND run_group_id = 'e31d1e34-7c58-4d8f-9a7b-1c2f4b6d8e90' " +
        "AND file_path LIKE 'packages/operator-core/lib/%' LIMIT 1",
      { client: sql, harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('keeps the CI-null warning for an exact file path without a result cap', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE file_path = 'packages/operator-core/lib/plan-audits.test.ts' " +
        "AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('keeps the CI-null warning for an open-ended file-path pattern even with LIMIT', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE file_path LIKE 'packages/operator-core/%' " +
        "AND workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' LIMIT 1",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('keeps the CI-null warning for an open-ended id predicate despite the tenant fence', async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.test_runs WHERE workspace_id = 'papercusp-workspace' " +
        "AND harness_slug = 'papercusp' AND id > 17630475",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('keeps the CI-null warning when another joined table supplies the bounded id predicate', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.test_runs t JOIN harness_shared.harness_plans p ON p.id = 1 ' +
        "WHERE t.workspace_id = 'papercusp-workspace' AND t.harness_slug = 'papercusp'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('NULL-by-design');
  });

  it('is silent once the query scopes by source', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory(
        "SELECT * FROM harness_shared.test_runs WHERE source = 'ci' AND status = 'fail'",
        { client: sql },
      ),
    ).toBeNull();
  });

  it('is silent once the query scopes by commit_sha', async () => {
    const { sql } = stubClient([]);
    expect(
      await buildTenantScopeAdvisory("SELECT * FROM harness_shared.test_runs WHERE commit_sha = 'abc123'", {
        client: sql,
      }),
    ).toBeNull();
  });

  it('still fires generically for a real tenant table joined alongside test_runs, while test_runs gets its own caveat', async () => {
    const { sql } = stubClient([
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
      { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    ]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.test_runs t JOIN harness_shared.harness_plans p ' +
        "ON true WHERE t.status = 'fail'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
    );
    expect(advisory).toContain('test_runs');
    expect(advisory).toContain('harness_plans');
  });
});

// EI-19324633485547042 point 3: ctx.harnessSlug/workspaceId can be the '*' wildcard sentinel
// (every su/operator-scope call sets it — agent-tools/_harness-scope.ts) which is NOT a valid SQL
// wildcard for `=`. The advisory must never suggest a literal `= '*'` predicate — that "fix" matches
// nothing and reads as a clean, confidence-inspiring empty result.
describe("buildTenantScopeAdvisory — the '*' wildcard sentinel must never be suggested as a literal (EI-19324633485547042 pt.3)", () => {
  const TENANT_ROWS = [
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'harness_slug' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'plan_slug' },
  ];

  beforeEach(() => clearTenantScopeSchemaCache());

  it("never suggests harness_slug = '*' when ctx.harnessSlug is the wildcard sentinel", async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'my-plan'",
      { client: sql, workspaceId: 'papercusp-workspace', harnessSlug: '*' },
    );
    expect(advisory).not.toContain("= '*'");
    // workspaceId is real, so it's still suggested; harnessSlug is the unresolved '*' sentinel, so
    // it's silently DROPPED from the suggestion clause (never rendered as a bogus literal).
    expect(advisory).toContain("Add: workspace_id = 'papercusp-workspace'.");
    expect(advisory).not.toContain('harness_slug = ');
  });

  it("never suggests workspace_id = '*' when ctx.workspaceId is the wildcard sentinel", async () => {
    const { sql } = stubClient(TENANT_ROWS);
    const advisory = await buildTenantScopeAdvisory(
      "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'my-plan'",
      { client: sql, workspaceId: '*', harnessSlug: 'papercusp' },
    );
    expect(advisory).not.toContain("= '*'");
    expect(advisory).toContain("harness_slug = 'papercusp'");
  });

  it("the agent_facts override also never suggests a '*' harness_slug literal", async () => {
    const { sql } = stubClient([]);
    const advisory = await buildTenantScopeAdvisory(
      'SELECT * FROM harness_shared.agent_facts WHERE expires_at < now()',
      { client: sql, harnessSlug: '*' },
    );
    expect(advisory).not.toContain("= '*'");
  });
});

describe('buildDerivedColumnRedirect (EI-18801042715296007 — the derived-verdict dead end)', () => {
  const NOT_EXIST = (col: string): string => `column "${col}" does not exist`;
  const PRESENCE_SQL = 'SELECT session_state FROM harness_shared.coord_presence';

  it('redirects the exact query from the filing', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT owner_id, last_active_at, intent, session_state FROM harness_shared.coord_presence',
      NOT_EXIST('session_state'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('DERIVED, not stored');
  });

  it('names the surfaces that DO return the verdict', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('coord:presence');
    expect(out).toContain('fleet:assignments');
  });

  // THE POINT OF THE WHOLE FIX: `knownColumns` steers the retry onto
  // heartbeat_at / last_active_at, which the platform documents as NOT the
  // liveness verdict. The redirect must name that fallback to rule it OUT.
  it('explicitly rules out the raw-keepalive fallback the 42703 hint steers to', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('heartbeat_at');
    expect(out).toContain('last_active_at');
    expect(out).toMatch(/do NOT fall back/i);
  });

  // Without this, the next reader proposes the coord_presence_live VIEW that
  // would fork the single oracle — the redirect carries its own rationale.
  it('explains why no view can add the column (the two non-SQL legs)', () => {
    const out = buildDerivedColumnRedirect(PRESENCE_SQL, NOT_EXIST('session_state'));
    expect(out).toContain('no view can add it');
    expect(out).toMatch(/kill\(pid, ?0\)/);
    expect(out).toContain('psu-pty host registry');
  });

  it('handles the ALIAS-QUALIFIED spelling PG uses', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT p.session_state FROM harness_shared.coord_presence p',
      'column p.session_state does not exist',
    );
    expect(out).toBeTruthy();
    expect(out).toContain('DERIVED, not stored');
  });

  it('covers the rest of the oracle-derived family', () => {
    for (const col of ['wakeable', 'live_turn', 'confirm_liveness']) {
      const out = buildDerivedColumnRedirect(
        `SELECT ${col} FROM harness_shared.coord_presence`,
        NOT_EXIST(col),
      );
      expect(out, col).toBeTruthy();
      expect(out, col).toContain('DERIVED, not stored');
    }
  });

  // intent_stale is the sharpest one: the row DOES carry `intent` and
  // `last_active_at`, so a hand-rolled threshold LOOKS like it works while
  // silently disagreeing with INTENT_STALE_SEC.
  it('warns intent_stale against a hand-rolled last_active_at threshold', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT owner_id, intent_stale FROM harness_shared.coord_presence',
      NOT_EXIST('intent_stale'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('INTENT_STALE_SEC');
    expect(out).toMatch(/do NOT fall back/i);
  });

  // heartbeat_fresh IS computable in SQL — the redirect exists to stop it being
  // READ as liveness, so it must not claim a view is impossible for it.
  it('treats heartbeat_fresh as computable-but-not-the-verdict', () => {
    const out = buildDerivedColumnRedirect(
      'SELECT heartbeat_fresh FROM harness_shared.coord_presence',
      NOT_EXIST('heartbeat_fresh'),
    );
    expect(out).toBeTruthy();
    expect(out).toContain('NOT the liveness verdict');
    expect(out).not.toContain('no view can add it');
  });

  it('stays silent for an ordinary typo on the same table', () => {
    expect(
      buildDerivedColumnRedirect(
        'SELECT owner_idd FROM harness_shared.coord_presence',
        NOT_EXIST('owner_idd'),
      ),
    ).toBeNull();
  });

  // The registry is keyed on (table, column), not column alone — the same word
  // against an unrelated table must not trigger the liveness lecture.
  it('stays silent when the column matches but the table does not', () => {
    expect(
      buildDerivedColumnRedirect(
        'SELECT session_state FROM harness_shared.tool_invocations',
        NOT_EXIST('session_state'),
      ),
    ).toBeNull();
  });

  it('stays silent on a non-undefined-column message', () => {
    expect(
      buildDerivedColumnRedirect(
        PRESENCE_SQL,
        'relation "harness_shared.coord_presence" does not exist',
      ),
    ).toBeNull();
  });
});

describe('buildUnusedCteAdvisory (EI-20261038811991822 — the CTE that is defined but never joined)', () => {
  // The measured case: a fleet-scheduler payload audit defined a 29-member
  // `targets` CTE and then forgot to join it. PostgreSQL returned valid,
  // well-formed rows from the FULL relation — no error, no empty result — and
  // the scope loss was only caught because someone checked the owner ids by
  // hand. These two queries differ by one clause, which is the whole point:
  // the FIRES/SILENT pair is what shows the detector discriminates rather than
  // just always answering one way.
  const UNJOINED =
    "WITH targets AS (SELECT unnest(ARRAY['su-a','su-b']) AS owner_id) " +
    'SELECT owner_id, payload FROM harness_shared.coord_presence ORDER BY updated_at DESC LIMIT 5';
  const JOINED =
    "WITH targets AS (SELECT unnest(ARRAY['su-a','su-b']) AS owner_id) " +
    'SELECT p.owner_id, p.payload FROM harness_shared.coord_presence p ' +
    'JOIN targets t ON t.owner_id = p.owner_id ORDER BY p.updated_at DESC LIMIT 5';

  it('FIRES on the reported shape — CTE defined, main query never references it', () => {
    const advisory = buildUnusedCteAdvisory(UNJOINED);
    expect(advisory).toContain('unused CTE');
    expect(advisory).toContain('`targets`');
  });

  it('stays SILENT once that same CTE is joined', () => {
    expect(buildUnusedCteAdvisory(JOINED)).toBeNull();
  });

  it('stays SILENT when the CTE is consumed by a LATER CTE rather than the main query', () => {
    expect(
      buildUnusedCteAdvisory(
        'WITH targets AS (SELECT 1 AS owner_id), latest AS (SELECT owner_id FROM targets) ' +
          'SELECT count(*) FROM latest',
      ),
    ).toBeNull();
  });

  it('names EVERY unused CTE, not just the first', () => {
    const advisory = buildUnusedCteAdvisory(
      'WITH targets AS (SELECT 1 AS owner_id), windows AS (SELECT 2 AS n) ' +
        'SELECT count(*) FROM harness_shared.work_items',
    );
    expect(advisory).toContain('`targets`');
    expect(advisory).toContain('`windows`');
  });

  it('parses a column alias list and [NOT] MATERIALIZED', () => {
    expect(
      buildUnusedCteAdvisory(
        'WITH targets(owner_id) AS MATERIALIZED (SELECT 1) SELECT count(*) FROM harness_shared.work_items',
      ),
    ).toContain('`targets`');
    expect(
      buildUnusedCteAdvisory(
        'WITH targets(owner_id) AS NOT MATERIALIZED (SELECT 1) SELECT owner_id FROM targets',
      ),
    ).toBeNull();
    // `AS(` with no space is legal and must still parse.
    expect(
      buildUnusedCteAdvisory('WITH targets AS(SELECT 1) SELECT count(*) FROM harness_shared.work_items'),
    ).toContain('`targets`');
  });

  it('does not count a RECURSIVE self-reference as a use — the result still does not depend on it', () => {
    expect(
      buildUnusedCteAdvisory(
        'WITH RECURSIVE walk AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM walk WHERE n < 5) ' +
          'SELECT count(*) FROM harness_shared.work_items',
      ),
    ).toContain('`walk`');
    // …but the ordinary recursive query, whose final SELECT does read it, is silent.
    expect(
      buildUnusedCteAdvisory(
        'WITH RECURSIVE walk AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM walk WHERE n < 5) ' +
          'SELECT count(*) FROM walk',
      ),
    ).toBeNull();
  });

  it('does not accept a SCHEMA-QUALIFIED name as a reference to the CTE', () => {
    // `public.targets` resolves to a real TABLE, never to the CTE — so this
    // query is genuinely unscoped despite the name appearing twice.
    expect(
      buildUnusedCteAdvisory('WITH targets AS (SELECT 1 AS owner_id) SELECT count(*) FROM public.targets'),
    ).toContain('`targets`');
  });

  it('stays SILENT on a query with no CTE at all', () => {
    expect(
      buildUnusedCteAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE harness_slug = 'papercusp'",
      ),
    ).toBeNull();
  });

  it('is not started by a `WITH` inside a comment or a string literal', () => {
    expect(
      buildUnusedCteAdvisory(
        '-- WITH targets AS (SELECT 1)\nSELECT count(*) FROM harness_shared.work_items',
      ),
    ).toBeNull();
    expect(
      buildUnusedCteAdvisory(
        "SELECT 'WITH targets AS (SELECT 1)' AS note FROM harness_shared.work_items",
      ),
    ).toBeNull();
  });

  it('BAILS conservatively rather than guessing on a shape it cannot parse', () => {
    // A quoted CTE name: the stripper erases quoted-identifier CONTENT, so the
    // name is unrecoverable here. Staying silent is the documented limit —
    // guessing would be the confidently-wrong answer this file exists to avoid.
    expect(
      buildUnusedCteAdvisory(
        'WITH "Targets" AS (SELECT 1 AS owner_id) SELECT count(*) FROM harness_shared.work_items',
      ),
    ).toBeNull();
    // An unbalanced body cannot be delimited; same rule.
    expect(buildUnusedCteAdvisory('WITH targets AS (SELECT 1 SELECT 2')).toBeNull();
  });
});

describe('buildPopulationNarrowingAdvisory (EI-22433765987075358)', () => {
  it('warns when HAVING narrows grouped output', () => {
    const advisory = buildPopulationNarrowingAdvisory(
      'SELECT tool_name, count(*) FROM work_items GROUP BY tool_name HAVING count(*) = 1',
    );
    expect(advisory).toContain('population-narrowing');
    expect(advisory).toContain('HAVING');
    expect(advisory).toContain('no group matched the HAVING predicate');
    expect(advisory).toContain('underlying population is empty');
  });

  it('warns when a numeric LIMIT is below the configured maxRows', () => {
    const advisory = buildPopulationNarrowingAdvisory(
      'SELECT id FROM work_items ORDER BY id LIMIT 5',
      20,
    );
    expect(advisory).toContain('LIMIT');
    expect(advisory).toContain('bounded query');
  });

  it('composes HAVING and LIMIT warnings instead of reporting only the first', () => {
    const advisory = buildPopulationNarrowingAdvisory(
      'SELECT tool_name, count(*) FROM work_items GROUP BY tool_name HAVING count(*) = 1 LIMIT 5',
      20,
    );
    expect(advisory).toContain('HAVING/LIMIT');
  });

  it('stays silent when LIMIT reaches the configured maxRows or is unbounded', () => {
    expect(buildPopulationNarrowingAdvisory('SELECT id FROM work_items LIMIT 20', 20)).toBeNull();
    expect(buildPopulationNarrowingAdvisory('SELECT id FROM work_items LIMIT 21', 20)).toBeNull();
    expect(buildPopulationNarrowingAdvisory('SELECT id FROM work_items LIMIT ALL', 20)).toBeNull();
    expect(buildPopulationNarrowingAdvisory('SELECT id FROM work_items', 20)).toBeNull();
  });

  it('does not match HAVING or LIMIT text inside literals or comments', () => {
    expect(
      buildPopulationNarrowingAdvisory(
        "SELECT 'HAVING count(*) = 1 LIMIT 1' AS note FROM work_items -- LIMIT 1",
        20,
      ),
    ).toBeNull();
  });
});

describe('buildSilentNullPathAdvisory (WI-6674 — the always-NULL accessor)', () => {
  // ── engineer_issues `payload->'_ei'` — RETIRED 2026-09-02 by migration 1096.
  //
  // This registry used to flag the nested path on the engineer_issues VIEW,
  // which exploded `_ei` into real columns and then subtracted the blob
  // (`payload - '_ei'`), making the path NULL for every row. P-003 of plan
  // silent-wrong-answers-2026-08-01 removed the subtraction, so the path now
  // resolves: measured on the live view, the two accessors agree on 166,795 of
  // 166,802 rows, and the 7 exceptions carry a NULL payload entirely (the
  // `severity` COLUMN reports its COALESCE default of 'minor'; the nested path
  // honestly reports NULL). Keeping the advisory would assert "NULL for EVERY
  // row" against a view where the path resolves — the confidently-wrong answer
  // this registry exists to prevent.
  //
  // ⚠ These tests assert the SILENCE. They CANNOT assert that the silence is
  // correct: this suite never touches Postgres, so it has no way to know what
  // the live view projects. That half is pinned against pg_get_viewdef in
  // pg-read-query-engineer-issues-ei-pin.integration.test.ts. Asserting silence
  // here and calling it verified would repeat the exact mistake being fixed —
  // a guard pinned to the claim rather than to the world.
  const CRITICAL_AUDIT =
    "SELECT count(*) FROM harness_shared.engineer_issues WHERE payload->'_ei'->>'severity' = 'critical'";

  it('no longer flags the engineer_issues nested path — migration 1096 made it resolve', () => {
    expect(buildSilentNullPathAdvisory(CRITICAL_AUDIT)).toBeNull();
  });

  it('stays SILENT on a bare projection and inside an aggregate FILTER', () => {
    expect(
      buildSilentNullPathAdvisory(
        "SELECT payload->'_ei'->>'severity' FROM harness_shared.engineer_issues",
      ),
    ).toBeNull();
    expect(
      buildSilentNullPathAdvisory(
        "SELECT count(*) FILTER (WHERE payload->'_ei'->>'severity' IS NOT NULL) FROM harness_shared.engineer_issues",
      ),
    ).toBeNull();
  });

  it('stays SILENT on the work_items TABLE — there the same path was always CORRECT', () => {
    expect(
      buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'severity' = 'critical'",
      ),
    ).toBeNull();
  });

  it('stays SILENT when engineer_issues is read via its real columns', () => {
    expect(
      buildSilentNullPathAdvisory(
        "SELECT severity FROM harness_shared.engineer_issues WHERE state = 'open'",
      ),
    ).toBeNull();
  });

  it('CALIBRATION: still flags a different relation trap, so the silence above is not just a broken scan', () => {
    // Without this control every toBeNull() above would also pass if removing
    // the engineer_issues entry had broken buildSilentNullPathAdvisory itself —
    // four green assertions for entirely the wrong reason. `_ei->>'lane'` on the
    // work_items TABLE is a live trap and must still fire.
    expect(
      buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'lane' <> 'observation'",
      ),
    ).toContain('always-NULL accessor');
  });

  // ── work_items.kind — effectively dead (3 of 28,255 rows non-null, measured
  // 2026-08-02) while item_kind is populated on every row. `WHERE kind='bug'`
  // therefore returns ~nothing and reads exactly like "there are no bugs".
  describe('work_items.kind vs item_kind', () => {
    it('flags a kind PREDICATE — the shape that silently returns zero rows', () => {
      const advisory = buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE kind = 'bug'",
      );
      expect(advisory).toContain('always-NULL accessor');
      expect(advisory).toContain('item_kind');
    });

    it('flags kind IN (...) and kind IS NULL too', () => {
      expect(
        buildSilentNullPathAdvisory(
          "SELECT * FROM harness_shared.work_items WHERE kind IN ('bug','change')",
        ),
      ).toContain('always-NULL accessor');
      expect(
        buildSilentNullPathAdvisory(
          'SELECT * FROM harness_shared.work_items WHERE kind IS NULL',
        ),
      ).toContain('always-NULL accessor');
    });

    it('points at the observation lane too — item_kind alone is not the real-work filter', () => {
      // The count that bit was not just kind-vs-item_kind: ~84% of open rows are
      // lane='observation' and never enter the queue, so a backlog number needs
      // BOTH discriminators. An advisory that fixed only half would still hand
      // back a confidently wrong backlog.
      const advisory =
        buildSilentNullPathAdvisory(
          "SELECT count(*) FROM harness_shared.work_items WHERE kind = 'bug'",
        ) ?? '';
      expect(advisory).toContain('observation');
    });

    it('stays SILENT on item_kind — the CORRECT column must never be flagged', () => {
      expect(
        buildSilentNullPathAdvisory(
          "SELECT count(*) FROM harness_shared.work_items WHERE item_kind = 'bug'",
        ),
      ).toBeNull();
    });

    it('stays SILENT on an `AS kind` alias or GROUP BY — a false advisory is worse than none', () => {
      // Both are legitimate, common shapes. This file's own tenant-scope note is
      // explicit that a wrong advisory trains readers to ignore advisories, so
      // the trap is scoped to predicate position rather than any mention.
      expect(
        buildSilentNullPathAdvisory(
          "SELECT coalesce(item_kind,'?') AS kind, count(*) FROM harness_shared.work_items GROUP BY kind",
        ),
      ).toBeNull();
    });
  });

  // ── work_items.attempts — nullable on the compatibility view. Issue-family
  // rows project NULL, so ordinary comparisons silently discard the dominant
  // never-attempted population (`attempts = 0` is not true for NULL).
  describe('work_items.attempts nullable predicates', () => {
    it('flags ordinary comparisons that silently discard NULL attempts', () => {
      for (const predicate of ['attempts = 0', 'attempts > 0', "attempts IN (0, 1)", 'attempts BETWEEN 0 AND 1']) {
        const advisory = buildSilentNullPathAdvisory(
          `SELECT count(*) FROM harness_shared.work_items WHERE ${predicate}`,
        );
        expect(advisory, predicate).toContain('nullable predicate');
        expect(advisory, predicate).toContain('COALESCE(attempts, 0)');
      }
    });

    it('stays silent when the caller handles NULL explicitly', () => {
      for (const predicate of ['attempts IS NULL', 'attempts IS NOT NULL', 'COALESCE(attempts, 0) = 0']) {
        expect(
          buildSilentNullPathAdvisory(
            `SELECT count(*) FROM harness_shared.work_items WHERE ${predicate}`,
          ),
          predicate,
        ).toBeNull();
      }
    });

    it('does not treat attempts on another relation as the work_items trap', () => {
      expect(
        buildSilentNullPathAdvisory(
          'SELECT count(*) FROM harness_shared.harness_features_consolidated WHERE attempts = 0',
        ),
      ).toBeNull();
    });
  });

  // ── lane lives at the TOP level of payload, never under _ei. Measured
  // 2026-08-02: payload ? 'lane' true for 12,694 rows, payload->'_ei' ? 'lane'
  // for ZERO — so the _ei form silently counts every observation as real work.
  describe("work_items payload->'_ei'->>'lane'", () => {
    it('flags the _ei lane accessor on work_items', () => {
      const advisory = buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'lane' <> 'observation'",
      );
      expect(advisory).toContain('always-NULL accessor');
      expect(advisory).toContain("payload->>'lane'");
    });

    it('stays SILENT on the correct top-level lane accessor', () => {
      expect(
        buildSilentNullPathAdvisory(
          "SELECT count(*) FROM harness_shared.work_items WHERE coalesce(payload->>'lane','') <> 'observation'",
        ),
      ).toBeNull();
    });

    it("does not disturb the existing _ei->>'severity' allowance on work_items", () => {
      // Regression guard: the severity path IS correct on this TABLE, and adding
      // a lane trap to the same relation must not start flagging it.
      expect(
        buildSilentNullPathAdvisory(
          "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'severity' = 'critical'",
        ),
      ).toBeNull();
    });
  });

  it('stays SILENT on an unrelated payload path on a trapped relation', () => {
    // Deliberately on work_items, which STILL carries a live `_ei->>'lane'`
    // trap. Asserting this against engineer_issues would pass trivially now
    // that its entry is retired — a test that cannot fail proves nothing.
    expect(
      buildSilentNullPathAdvisory(
        "SELECT payload->'paths' FROM harness_shared.work_items WHERE status = 'open'",
      ),
    ).toBeNull();
  });

  it('does not match the path inside a string literal', () => {
    // Also repointed to the live work_items lane trap. The engineer_issues form
    // this used to assert would now return null because the trap is gone rather
    // than because literal-masking works, silently retiring the real coverage.
    expect(
      buildSilentNullPathAdvisory(
        "SELECT title FROM harness_shared.work_items WHERE title = 'payload->''_ei''->>lane'",
      ),
    ).toBeNull();

    // Control: the same path OUTSIDE a literal must still fire, or the
    // assertion above would pass even if masking swallowed everything.
    expect(
      buildSilentNullPathAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'lane' = 'observation'",
      ),
    ).toContain('always-NULL accessor');
  });
});

describe('buildJsonNullArrowAdvisory (json null is not SQL NULL — WI-10005716)', () => {
  it('fires on a single-arrow accessor compared with IS NULL', () => {
    expect(
      buildJsonNullArrowAdvisory(
        "SELECT 1 FROM harness_shared.work_items WHERE payload->'goalId' IS NULL",
      ),
    ).toContain('json null is not SQL NULL');
  });

  it('fires on IS NOT NULL — the populated-field reading that actually bit', () => {
    const advisory =
      buildJsonNullArrowAdvisory(
        "SELECT count(*) FROM harness_shared.session_briefs WHERE control_state->'activation' IS NOT NULL",
      ) ?? '';
    expect(advisory).toContain('counts them as populated');
    expect(advisory).toContain('EI-23761509275982493');
  });

  it('fires through a parenthesised operand, a chained path and the #> form', () => {
    expect(
      buildJsonNullArrowAdvisory("SELECT (payload->'_ei'->'severity') IS NULL FROM t"),
    ).toContain('json null is not SQL NULL');
    expect(buildJsonNullArrowAdvisory("SELECT payload #> '{a,b}' IS NULL FROM t")).toContain(
      'json null is not SQL NULL',
    );
  });

  // The remedy forms must stay SILENT. An advisory that fires on the very shape
  // it recommends gets discounted as noise, which retires it faster than being
  // wrong does — so these are the load-bearing cases, not the firing ones.
  it('stays silent on the text-returning forms it recommends', () => {
    expect(
      buildJsonNullArrowAdvisory("SELECT 1 FROM t WHERE payload->>'goalId' IS NULL"),
    ).toBeNull();
    expect(
      buildJsonNullArrowAdvisory("SELECT 1 FROM t WHERE payload->'_ei'->>'severity' IS NULL"),
    ).toBeNull();
    expect(
      buildJsonNullArrowAdvisory("SELECT 1 FROM t WHERE payload #>> '{a,b}' IS NULL"),
    ).toBeNull();
    expect(
      buildJsonNullArrowAdvisory("SELECT 1 FROM t WHERE jsonb_typeof(payload->'k') = 'null'"),
    ).toBeNull();
    expect(
      buildJsonNullArrowAdvisory("SELECT 1 FROM t WHERE payload->'k' = 'null'::jsonb"),
    ).toBeNull();
  });

  it('stays silent when the arrow is not the operand of the IS NULL test', () => {
    expect(
      buildJsonNullArrowAdvisory("SELECT payload->'k' AS k FROM t WHERE id IS NULL"),
    ).toBeNull();
  });

  it('ignores the pattern inside literals and comments', () => {
    expect(
      buildJsonNullArrowAdvisory("SELECT 'payload->''k'' IS NULL' AS prose FROM t"),
    ).toBeNull();
    expect(buildJsonNullArrowAdvisory("SELECT 1 -- payload->'k' IS NULL")).toBeNull();
  });
});

describe('buildJsonbTypeofNegationAdvisory (nullable JSONB predicates)', () => {
  const TRAP =
    "SELECT count(*) FILTER (WHERE NOT (jsonb_typeof(e.body->'sections') = 'array')) " +
    'FROM harness_shared.coord_event_log e';

  it('flags the negated comparison that drops absent-key rows', () => {
    const advisory = buildJsonbTypeofNegationAdvisory(TRAP) ?? '';
    expect(advisory).toContain('nullable jsonb_typeof negation');
    expect(advisory).toContain('absent-key rows');
    expect(advisory).toContain('coalesce');
  });

  it('handles direct NOT, nested function arguments, and inequality operators', () => {
    const sql =
      "SELECT * FROM t WHERE NOT ((jsonb_typeof(coalesce(payload->'sections', '{}'::jsonb)) <> 'object'))";
    expect(buildJsonbTypeofNegationAdvisory(sql)).toContain('nullable jsonb_typeof negation');
  });

  it('stays silent for the positive comparison and for IS NULL checks', () => {
    expect(
      buildJsonbTypeofNegationAdvisory(
        "SELECT * FROM t WHERE jsonb_typeof(payload->'sections') = 'array'",
      ),
    ).toBeNull();
    expect(
      buildJsonbTypeofNegationAdvisory(
        "SELECT * FROM t WHERE NOT (jsonb_typeof(payload->'sections') IS NULL)",
      ),
    ).toBeNull();
  });

  it('does not match the shape when it appears only in a string or comment', () => {
    expect(
      buildJsonbTypeofNegationAdvisory(
        "SELECT 'NOT (jsonb_typeof(payload->''sections'') = ''array'')' AS note",
      ),
    ).toBeNull();
    expect(
      buildJsonbTypeofNegationAdvisory('SELECT 1 -- NOT (jsonb_typeof(payload) = \'array\')'),
    ).toBeNull();
  });
});

describe('buildClaimabilityAdvisory (status=open is the lifecycle axis, not claimability)', () => {
  // The shape that actually bit, 2026-08-01: an agent counted open issue-family
  // rows, called the result "the claimable backlog", and was wrong by more than
  // an order of magnitude. Unlike the two advisories above, the query is not
  // malformed — it correctly answers a DIFFERENT question, which is why nothing
  // about the result looks suspicious.
  const OPEN_COUNT =
    "SELECT count(*) FROM harness_shared.work_items WHERE item_kind IN ('bug','change','task') AND status = 'open'";

  it('flags the count-open-rows shape', () => {
    const advisory = buildClaimabilityAdvisory(OPEN_COUNT);
    expect(advisory).toContain('LIFECYCLE, not claimability');
    expect(advisory).toContain('work_items');
  });

  it('is actionable — names the tool that computes the real answer', () => {
    expect(buildClaimabilityAdvisory(OPEN_COUNT) ?? '').toContain('work_items:claimable');
  });

  it('explains WHY no column can settle it (caller- and moment-relative floors)', () => {
    const advisory = buildClaimabilityAdvisory(OPEN_COUNT) ?? '';
    expect(advisory).toContain('CALLER');
    expect(advisory).toContain('MOMENT');
  });

  it('quotes no fixed multiplier — a hardcoded ratio would itself go stale', () => {
    const advisory = buildClaimabilityAdvisory(OPEN_COUNT) ?? '';
    expect(advisory).not.toMatch(/\d+\s*x\b/i);
  });

  it("stays quiet when the query goes through the real floor function — that caller knows the difference", () => {
    expect(
      buildClaimabilityAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE status = 'open' AND " +
          'cardinality(harness_shared.work_item_claim_floors(status, taken_by, origin, title, ' +
          'terminal_owner, terminal_completion_ref, payload, feature_id)) = 0',
      ),
    ).toBeNull();
  });

  it('points a raw-SQL reader at the queryable SSOT view, not only at the tool', () => {
    // Migration 654 exists precisely so a raw dev:pg_query read can AGREE with the
    // scheduler. An advisory that named only the tool would send raw SQL nowhere.
    expect(buildClaimabilityAdvisory(OPEN_COUNT) ?? '').toContain('work_items_claimable');
  });

  it('treats the SSOT view as CORRECT-but-scoped, not as a mistake', () => {
    const advisory =
      buildClaimabilityAdvisory('SELECT count(*) FROM harness_shared.work_items_claimable') ?? '';
    expect(advisory).toContain('caller-independent scope');
    expect(advisory).toContain('claimable by someone');
    // Migration 654 omits the per-claim floors DELIBERATELY; the view also
    // under-admits on the federated-origin leg. Claiming a clean direction
    // would be exactly the confidently-wrong artifact this advisory prevents.
    expect(advisory).toContain('neither a clean upper nor lower bound');
  });

  it("matches status = ANY(ARRAY['open', …]) too, not just the = form", () => {
    expect(
      buildClaimabilityAdvisory(
        "SELECT feature_id FROM harness_shared.work_items WHERE status = ANY(ARRAY['open','wip'])",
      ),
    ).toContain('LIFECYCLE, not claimability');
  });

  it('stays quiet on a work_items read that makes no claimability claim', () => {
    expect(
      buildClaimabilityAdvisory(
        "SELECT title FROM harness_shared.work_items WHERE feature_id = 'EI-123'",
      ),
    ).toBeNull();
  });

  it('stays quiet on an unrelated table', () => {
    expect(
      buildClaimabilityAdvisory("SELECT count(*) FROM harness_shared.harness_plans WHERE status = 'open'"),
    ).toBeNull();
  });

  it('ignores a status=open written only in a comment', () => {
    expect(
      buildClaimabilityAdvisory(
        "SELECT title FROM harness_shared.work_items -- WHERE status = 'open'\n WHERE feature_id = 'EI-1'",
      ),
    ).toBeNull();
  });
});

/**
 * VERIFY-BEFORE-PRESCRIBE (plan false-premise-in-prescriptive-artifacts-2026-08-02
 * P-003; canonical instance EI-19324633485547042).
 *
 * The advisory used to infer a predicate from a column's EXISTENCE and recommend it
 * unchecked. That premise was measured false on at least three unrelated tables, each
 * handled by appending to a hardcoded list. These pin the general rule instead: a
 * prescription refuted by the table's own rows must be REPLACED, never merely
 * annotated — and every uncertain case must fail OPEN, so the guard can never become
 * the reason a genuine tenant warning stops firing.
 */
describe('classifyTenantPrescription (verify-before-prescribe)', () => {
  const pop = (over: Record<string, unknown> = {}) => ({
    hasRows: true,
    workspaceIdHit: true as boolean | null,
    harnessSlugHit: null as boolean | null,
    actualWorkspaceIds: [] as string[],
    actualHarnessSlugs: [] as string[],
    at: Date.now(),
    ...over,
  });
  const bothChecked = { checkedWorkspaceId: true, checkedHarnessSlug: true };

  it('prescribes when the predicate actually matches rows', () => {
    expect(classifyTenantPrescription(pop(), bothChecked).kind).toBe('prescribe');
  });

  it('REFUTES when the table has rows but the prescribed workspace_id matches none', () => {
    // The event_key_fires / event_awaits shape: every row is the literal 'default'.
    const v = classifyTenantPrescription(
      pop({ workspaceIdHit: false, actualWorkspaceIds: ['default'] }),
      bothChecked,
    );
    expect(v.kind).toBe('refute');
    expect(v).toMatchObject({ column: 'workspace_id', actual: ['default'] });
  });

  it('REFUTES on harness_slug independently of workspace_id', () => {
    const v = classifyTenantPrescription(
      pop({ workspaceIdHit: true, harnessSlugHit: false, actualHarnessSlugs: [] }),
      bothChecked,
    );
    expect(v).toMatchObject({ kind: 'refute', column: 'harness_slug' });
  });

  it('fails OPEN when the probe returned nothing — an unprobed table keeps the old advisory', () => {
    expect(classifyTenantPrescription(null, bothChecked).kind).toBe('prescribe');
  });

  it('fails OPEN on an EMPTY table — zero rows makes the hit-test meaningless', () => {
    // Not evidence the predicate is wrong: there is simply nothing to match yet.
    expect(
      classifyTenantPrescription(pop({ hasRows: false, workspaceIdHit: false }), bothChecked).kind,
    ).toBe('prescribe');
  });

  it('ignores a column it was not asked to check', () => {
    expect(
      classifyTenantPrescription(pop({ harnessSlugHit: false }), {
        checkedWorkspaceId: true,
        checkedHarnessSlug: false,
      }).kind,
    ).toBe('prescribe');
  });
});

describe('refutedTenantAdvisory', () => {
  it('names the REAL key so the agent gets a usable predicate, not just a refusal', () => {
    const msg = refutedTenantAdvisory(
      'harness_shared.event_key_fires',
      'workspace_id',
      'papercusp-workspace',
      ['default'],
    );
    expect(msg).toContain("NONE match workspace_id = 'papercusp-workspace'");
    expect(msg).toContain("keyed 'default'");
    expect(msg).toContain('Do NOT add that predicate');
  });

  it('states the NULL case explicitly rather than showing an empty list', () => {
    // The test_runs shape: CI rows are env-stamped, so both keys are NULL.
    const msg = refutedTenantAdvisory('harness_shared.test_runs', 'harness_slug', 'papercusp', []);
    expect(msg).toContain('every row has harness_slug NULL');
  });

  it('explains WHY the empty result is dangerous — a zero is never re-checked', () => {
    const msg = refutedTenantAdvisory('t', 'workspace_id', 'w', ['default']);
    expect(msg).toContain('no rows exist');
  });
});

describe('parseMissingColumnName (the ONE 42703 name parser)', () => {
  it('reads the bare form', () => {
    expect(parseMissingColumnName('column "severity" does not exist')).toBe('severity');
  });

  it('reads the alias-qualified form, returning the COLUMN not the alias', () => {
    expect(parseMissingColumnName('column w.severity does not exist')).toBe('severity');
  });

  it('CONTROL: an unrelated error yields null rather than a plausible-looking guess', () => {
    expect(parseMissingColumnName('relation "nope" does not exist')).toBeNull();
    expect(parseMissingColumnName('syntax error at or near "FROM"')).toBeNull();
  });
});

describe('buildSchemaColumnRedirect (known physical-column vocabulary)', () => {
  it('redirects the public work-item id to the canonical feature_id column', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT id FROM harness_shared.work_items WHERE workspace_id = 'ws'",
      'column "id" does not exist',
    );
    expect(out).toContain('public work-item id');
    expect(out).toContain('feature_id');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_shared.work_items');
  });

  it('redirects the compatibility state name to the canonical work-item status column', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT state FROM harness_shared.work_items WHERE workspace_id = 'ws'",
      'column "state" does not exist',
    );
    expect(out).toContain('canonical work-item lifecycle column');
    expect(out).toContain('status');
    expect(out).toContain('engineer_issues');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_shared.work_items');
  });

  it('redirects work-item assignee to taken_by and preserves both tenant predicates', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT assignee FROM harness_shared.work_items WHERE workspace_id = 'ws' AND harness_slug = 'h'",
      'column "assignee" does not exist',
    );
    expect(out).toContain('taken_by');
    expect(out).toContain('BOTH');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_slug');
    expect(out).toContain('harness_shared.work_items');
  });

  it('redirects the feature-compatible view assignee to taken_by', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT assignee FROM harness_shared.harness_features_consolidated WHERE workspace_id = 'ws' AND harness_slug = 'h'",
      'column "assignee" does not exist',
    );
    expect(out).toContain('taken_by');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_slug');
    expect(out).toContain('harness_shared.harness_features_consolidated');
  });

  it('does not redirect the issue-view assignee alias', () => {
    expect(
      buildSchemaColumnRedirect(
        "SELECT assignee FROM harness_shared.engineer_issues WHERE workspace_id = 'ws'",
        'column "assignee" does not exist',
      ),
    ).toBeNull();
  });

  it('redirects substrate_outbox table_tag to the physical table_name column', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT table_tag FROM harness_shared.substrate_outbox WHERE workspace_id = 'ws'",
      'column "table_tag" does not exist',
    );
    expect(out).toContain('table_name');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_shared.substrate_outbox');
  });

  it('redirects the derived checkpoint field to the canonical carry-note reader', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT checkpoint FROM harness_shared.work_items WHERE workspace_id = 'ws' AND feature_id = 'WI-1'",
      'column "checkpoint" does not exist',
    );
    expect(out).toContain('harness_shared.carry_notes.note');
    expect(out).toContain('workitem:<harness>:<work-item-id>');
    expect(out).toContain('work_items:get');
    expect(out).toContain('checkpoint');
  });

  it.each(['blocked_kind', 'blocked_ref', 'blocker_kind', 'blocker_ref'])(
    'redirects the work-item dependency column %s to the canonical edge relation',
    (missing) => {
      const out = buildSchemaColumnRedirect(
        `SELECT ${missing} FROM harness_shared.work_items WHERE workspace_id = 'ws'`,
        `column "${missing}" does not exist`,
      );
      expect(out).toContain('harness_shared.work_item_deps');
      expect(out).toContain(missing);
      expect(out).toContain('workspace_id');
      expect(out).toContain('work_items:get');
    },
  );

  it('does not redirect a dependency-column miss when the canonical edge relation is already queried', () => {
    expect(
      buildSchemaColumnRedirect(
        "SELECT blocked_kind FROM harness_shared.work_item_deps WHERE workspace_id = 'ws'",
        'column "blocked_kind" does not exist',
      ),
    ).toBeNull();
  });

  it('redirects the plan-item claim agent_id guess to the canonical owner column', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT agent_id FROM harness_shared.plan_item_claims WHERE workspace_id = 'ws' AND harness_slug = 'h'",
      'column "agent_id" does not exist',
    );
    expect(out).toContain('plan-item claim ownership');
    expect(out).toContain('owner');
    expect(out).toContain('owner_name');
    expect(out).toContain('owner_label');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_slug');
    expect(out).toContain('harness_shared.plan_item_claims');
  });

  it('names install_slug for the routines table when harness_slug is guessed', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT harness_slug FROM harness_shared.routines WHERE workspace_id = 'ws'",
      'column "harness_slug" does not exist',
    );
    expect(out).toContain('install_slug');
    expect(out).toContain('workspace_id');
    expect(out).toContain('harness_shared.routines');
  });

  it('redirects the legacy paused_reason guess to routines metadata.pause', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT paused_reason FROM harness_shared.routines WHERE workspace_id = 'ws'",
      'column "paused_reason" does not exist',
    );
    expect(out).toContain('metadata');
    expect(out).toContain("metadata->'pause'->>'reason'");
    expect(out).toContain('routines:list');
    expect(out).toContain('harness_shared.routines');
  });

  it('stays silent for joined relations where the missing name may belong elsewhere', () => {
    expect(
      buildSchemaColumnRedirect(
        'SELECT harness_slug FROM harness_shared.routines r JOIN harness_shared.harness_plans p ON true',
        'column "harness_slug" does not exist',
      ),
    ).toBeNull();
  });

  it('stays silent for unrelated relations', () => {
    expect(
      buildSchemaColumnRedirect(
        'SELECT harness_slug FROM harness_shared.harness_plans',
        'column "harness_slug" does not exist',
      ),
    ).toBeNull();
  });

  it('explains that tool_invocations stores output references and metadata, not result_json', () => {
    const out = buildSchemaColumnRedirect(
      'SELECT result_json FROM harness_shared.tool_invocations LIMIT 1',
      'column "result_json" does not exist',
    );
    expect(out).toContain('output_ref');
    expect(out).toContain('output_size');
    expect(out).toContain('metadata_json');
    expect(out).toContain('no inline result JSON');
    expect(out).toContain('harness_shared.tool_invocations');
  });

  it('redirects the generic created_at guess to the invocation ledger timestamp', () => {
    const out = buildSchemaColumnRedirect(
      'SELECT created_at FROM harness_shared.tool_invocations ORDER BY created_at DESC LIMIT 1',
      'column "created_at" does not exist',
    );
    expect(out).toContain('invoked_at');
    expect(out).toContain('not generic `created_at`');
    expect(out).toContain('projected-tool-deps.ts');
    expect(out).toContain('harness_shared.tool_invocations');
  });

  it('redirects the removed request_origin guess to the live call-origin columns', () => {
    const out = buildSchemaColumnRedirect(
      'SELECT request_origin FROM harness_shared.tool_invocations LIMIT 1',
      'column "request_origin" does not exist',
    );
    expect(out).toContain('call_origin');
    expect(out).toContain('call_origin_source');
    expect(out).toContain('metadata_json');
    expect(out).toContain('requestOrigin');
    expect(out).toContain('harness_shared.tool_invocations');
  });

  it('redirects the API created_ts alias to coord_thread_posts.created_at', () => {
    const out = buildSchemaColumnRedirect(
      'SELECT created_ts FROM harness_shared.coord_thread_posts ORDER BY created_ts DESC LIMIT 1',
      'column "created_ts" does not exist',
    );
    expect(out).toContain('API projections');
    expect(out).toContain('created_at');
    expect(out).toContain('timestamptz');
    expect(out).toContain('recency filters and ordering');
    expect(out).toContain('harness_shared.coord_thread_posts');
  });

  it('redirects migration_number probes to the reservation ledger num column', () => {
    const out = buildSchemaColumnRedirect(
      "SELECT migration_number, reserved_by, reserved_at FROM harness_shared.migration_reservations WHERE migration_number >= 905 ORDER BY migration_number",
      'column "migration_number" does not exist',
    );
    expect(out).toContain('`num`');
    expect(out).toContain('`filename`');
    expect(out).toContain('db:next-migration');
    expect(out).toContain('harness_shared.migration_reservations');
  });

  it('redirects the reservation ledger name guess to filename', () => {
    const out = buildSchemaColumnRedirect(
      'SELECT name FROM harness_shared.migration_reservations LIMIT 1',
      'column "name" does not exist',
    );
    expect(out).toContain('`filename`');
    expect(out).toContain('`num`');
    expect(out).toContain('db:next-migration');
  });

  it('does not redirect result_json for an unrelated relation', () => {
    expect(
      buildSchemaColumnRedirect(
        'SELECT result_json FROM harness_shared.action_executions',
        'column "result_json" does not exist',
      ),
    ).toBeNull();
  });
});

/**
 * P-015 — a 42703 whose name lives INSIDE a jsonb column.
 *
 * `knownColumns` answers "what columns exist", which is the wrong answer to a
 * nesting mistake and is how `work_items.severity` (really
 * `payload->'_ei'->>'severity'`) reads as "no such field". The probe answers the
 * question that was actually asked.
 *
 * The CONTROLs matter more than the hits: this advisory must stay SILENT when it
 * has nothing to say, or it becomes noise on every ordinary typo — and it must
 * never run a probe it does not need.
 */
describe('buildJsonbPathRedirect (P-015)', () => {
  type SchemaRow = { table_schema: string; table_name: string; column_name: string; data_type?: string };
  type ProbeRow = { depth: number; parent: string | null };

  /** A client that answers information_schema by tagged template AND the probe by `.unsafe`. */
  function stubJsonbClient(schemaRows: SchemaRow[], probeRows: ProbeRow[] | (() => never)) {
    const probes: Array<{ query: string; params: unknown[] }> = [];
    const query = async (_s: TemplateStringsArray, ..._v: unknown[]) => schemaRows;
    const unsafe = async (query: string, params: unknown[] = []) => {
      if (/^\s*SET\b/i.test(query) || /\bset_config\s*\(/i.test(query)) return [];
      probes.push({ query, params });
      if (typeof probeRows === 'function') return probeRows();
      return probeRows;
    };
    const tx = Object.assign(query, { unsafe });
    const sql = Object.assign(query, {
      begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    });
    return { sql: sql as never, probes };
  }

  const WORK_ITEMS: SchemaRow[] = [
    { table_schema: 'harness_shared', table_name: 'work_items', column_name: 'id', data_type: 'text' },
    { table_schema: 'harness_shared', table_name: 'work_items', column_name: 'status', data_type: 'text' },
    { table_schema: 'harness_shared', table_name: 'work_items', column_name: 'payload', data_type: 'jsonb' },
  ];

  it('a DEPTH-1 key returns the ->> accessor', async () => {
    const { sql } = stubJsonbClient(WORK_ITEMS, [{ depth: 1, parent: null }]);
    const out = await buildJsonbPathRedirect(
      "SELECT _completionevidence FROM harness_shared.work_items",
      'column "_completionevidence" does not exist',
      { client: sql },
    );
    expect(out).toContain("payload->>'_completionevidence'");
    expect(out).toContain('is NOT a column on harness_shared.work_items');
  });

  it('a DEPTH-2 key returns the path THROUGH the intermediate key (the severity shape)', async () => {
    const { sql } = stubJsonbClient(WORK_ITEMS, [{ depth: 2, parent: '_ei' }]);
    const out = await buildJsonbPathRedirect(
      'SELECT severity FROM harness_shared.work_items',
      'column "severity" does not exist',
      { client: sql },
    );
    expect(out).toContain("payload->'_ei'->>'severity'");
    // The relation-binding caveat is the whole reason this is not just a path.
    expect(out).toContain('bound to THIS');
    expect(out).toContain('NULL for EVERY row without erroring');
  });

  it('names the presence test too — `?` on the right level, not IS NOT NULL', async () => {
    const { sql } = stubJsonbClient(WORK_ITEMS, [{ depth: 2, parent: '_ei' }]);
    const out = await buildJsonbPathRedirect(
      'SELECT severity FROM harness_shared.work_items',
      'column "severity" does not exist',
      { client: sql },
    );
    expect(out).toContain("payload->'_ei' ? 'severity'");
  });

  it('passes the key as a BOUND PARAMETER and bounds the sample — never interpolated', async () => {
    const { sql, probes } = stubJsonbClient(WORK_ITEMS, [{ depth: 1, parent: null }]);
    await buildJsonbPathRedirect(
      'SELECT severity FROM harness_shared.work_items',
      'column "severity" does not exist',
      { client: sql },
    );
    expect(probes).toHaveLength(1);
    expect(probes[0]?.params).toEqual(['severity']);
    // The name reaches PG as $1, not spliced into the statement text.
    expect(probes[0]?.query).not.toContain('severity');
    expect(probes[0]?.query).toContain('LIMIT 200');
    // Identifiers from information_schema are quoted.
    expect(probes[0]?.query).toContain('"harness_shared"."work_items"');
    expect(probes[0]?.query).toContain('"payload"');
    // `jsonb_exists(...)`, never the `?` operator, which collides with placeholders.
    expect(probes[0]?.query).toContain('jsonb_exists');
    expect(probes[0]?.query).not.toContain(' ? ');
  });

  it('CONTROL: the name IS a real column — stays silent AND never probes', async () => {
    const { sql, probes } = stubJsonbClient(WORK_ITEMS, [{ depth: 1, parent: null }]);
    const out = await buildJsonbPathRedirect(
      'SELECT w.status FROM harness_shared.work_items w JOIN x ON true',
      'column w.status does not exist',
      { client: sql },
    );
    expect(out).toBeNull();
    expect(probes).toHaveLength(0);
  });

  it('CONTROL: no jsonb column on the table — stays silent AND never probes', async () => {
    const { sql, probes } = stubJsonbClient(
      [
        { table_schema: 'harness_shared', table_name: 'messages', column_name: 'id', data_type: 'bigint' },
        { table_schema: 'harness_shared', table_name: 'messages', column_name: 'body', data_type: 'text' },
      ],
      [{ depth: 1, parent: null }],
    );
    const out = await buildJsonbPathRedirect(
      'SELECT nope FROM harness_shared.messages',
      'column "nope" does not exist',
      { client: sql },
    );
    expect(out).toBeNull();
    expect(probes).toHaveLength(0);
  });

  it('CONTROL: the key is genuinely absent from the payload — no invented path', async () => {
    const { sql, probes } = stubJsonbClient(WORK_ITEMS, []);
    const out = await buildJsonbPathRedirect(
      'SELECT definitely_not_a_key FROM harness_shared.work_items',
      'column "definitely_not_a_key" does not exist',
      { client: sql },
    );
    expect(out).toBeNull();
    expect(probes).toHaveLength(1); // it looked, and honestly found nothing
  });

  it('CONTROL: a probe that THROWS degrades to null — an advisory never breaks the error path', async () => {
    const { sql } = stubJsonbClient(WORK_ITEMS, () => {
      throw new Error('permission denied');
    });
    await expect(
      buildJsonbPathRedirect(
        'SELECT severity FROM harness_shared.work_items',
        'column "severity" does not exist',
        { client: sql },
      ),
    ).resolves.toBeNull();
  });

  it('CONTROL: an error that is not a 42703 column miss yields null without querying', async () => {
    const { sql, probes } = stubJsonbClient(WORK_ITEMS, [{ depth: 1, parent: null }]);
    expect(
      await buildJsonbPathRedirect(
        'SELECT * FROM harness_shared.work_items',
        'relation "work_itemz" does not exist',
        { client: sql },
      ),
    ).toBeNull();
    expect(probes).toHaveLength(0);
  });
});

/**
 * EI-20103748074297088 — the two false zeros that both read as "the agent edited nothing".
 *
 * Distinct from every advisory above, and the distinction is the reason these are separate
 * builders: the tenant advisory warns the rows you got may be from the WRONG TENANT. These warn
 * there will be NO ROWS AT ALL, from a query that looks perfectly scoped — the failure mode that
 * cannot be spotted by inspecting the result, because a well-formed zero is exactly what a real
 * "nothing happened" looks like.
 *
 * Both are pure string builders (no client), so they need no stub.
 */
describe('buildCorpusNamespaceAdvisory — a tenant predicate on a corpus table (EI-20103748074297088)', () => {
  const PARTS = 'harness_shared.session_turn_parts';
  const TURNS = 'harness_shared.session_turns';

  it('fires when a corpus table is filtered by a real tenant id', () => {
    const advisory = buildCorpusNamespaceAdvisory(
      `SELECT owner, count(*) FROM ${PARTS} WHERE workspace_id = 'papercusp-workspace' GROUP BY 1`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('session_turn_parts');
    expect(advisory).toContain("'papercusp-workspace'");
    // It must hand over the fix, not just the diagnosis.
    expect(advisory).toContain("workspace_id = 'default'");
    expect(advisory).toContain('owner');
  });

  it('EI-21477025296868436: names session_turns as mixed scope and rejects the plausible partial tenant slice', () => {
    const advisory = buildCorpusNamespaceAdvisory(
      `SELECT source_kind, count(*) FROM ${TURNS} WHERE workspace_id = 'papercusp-workspace' GROUP BY 1`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('NOT a corpus constant');
    expect(advisory).toContain('agent_chat');
    expect(advisory).toContain("workspace_id = 'papercusp-workspace' OR workspace_id = 'default'");
    expect(advisory).toContain('plausible non-empty result');
    expect(advisory).not.toContain('matches ZERO rows');
  });

  it('EI-21477025296868436: is silent for session_turns when the caller uses the production dual-scope predicate', () => {
    expect(
      buildCorpusNamespaceAdvisory(
        `SELECT * FROM ${TURNS} WHERE workspace_id = 'papercusp-workspace' OR workspace_id = 'default'`,
      ),
    ).toBeNull();
  });

  /**
   * The inversion this shares with buildTestRunsAdvisory: it fires BECAUSE the column is
   * present. An advisory that cleared on "workspace_id is mentioned" would go silent at exactly
   * the moment the caller has written the wrong thing — which is the whole failure.
   */
  it('is NOT satisfied merely by workspace_id being mentioned', () => {
    expect(
      buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} WHERE workspace_id = 'papercusp-workspace'`),
    ).toBeTruthy();
  });

  it('is silent when the caller already knows the namespace', () => {
    expect(
      buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} WHERE workspace_id = 'default'`),
    ).toBeNull();
  });

  it.each([
    ['IN list', `p.workspace_id IN ('papercusp-workspace', 'default')`],
    ['OR equalities', `p.workspace_id = 'papercusp-workspace' OR p.workspace_id = 'default'`],
    ['ANY array', `p.workspace_id = ANY(ARRAY['papercusp-workspace', 'default'])`],
  ])('is silent for a full-corpus literal predicate (%s)', (_shape, predicate) => {
    expect(buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} p WHERE ${predicate}`)).toBeNull();
  });

  it('still warns when a corpus IN list contains only tenant ids', () => {
    const advisory = buildCorpusNamespaceAdvisory(
      `SELECT * FROM ${PARTS} p WHERE p.workspace_id IN ('papercusp-workspace', 'another-workspace')`,
    );
    expect(advisory).toContain('matches ZERO rows');
    expect(advisory).toContain("'another-workspace'");
  });

  /** An UNSCOPED read is the correct one for these tables — never warn about a right answer. */
  it('is silent for an unscoped read', () => {
    expect(buildCorpusNamespaceAdvisory(`SELECT count(*) FROM ${PARTS}`)).toBeNull();
    expect(
      buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} WHERE ts > now() - interval '1 hour'`),
    ).toBeNull();
  });

  it('is silent for a genuinely multi-tenant table, where the predicate is correct', () => {
    expect(
      buildCorpusNamespaceAdvisory(
        "SELECT * FROM harness_shared.work_items WHERE workspace_id = 'papercusp-workspace'",
      ),
    ).toBeNull();
  });

  /**
   * session_turn_journal is 10,453 'default' vs 4,706 'papercusp-workspace' (measured
   * 2026-08-10) — genuinely mixed, so a tenant predicate there is legitimate. Pinned because the
   * tempting over-fix is to sweep in every session_* table by name, which would start warning
   * about correct queries and train callers to ignore the advisory.
   */
  it('is silent for a session_* table that is genuinely mixed rather than corpus-namespaced', () => {
    expect(
      buildCorpusNamespaceAdvisory(
        "SELECT * FROM harness_shared.session_turn_journal WHERE workspace_id = 'papercusp-workspace'",
      ),
    ).toBeNull();
  });

  it('ignores a predicate that only appears inside a comment', () => {
    expect(
      buildCorpusNamespaceAdvisory(
        `SELECT count(*) FROM ${PARTS} -- workspace_id = 'papercusp-workspace'\n`,
      ),
    ).toBeNull();
  });

  it('does not fire on an exclusion predicate', () => {
    expect(
      buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} WHERE workspace_id <> 'papercusp-workspace'`),
    ).toBeNull();
  });

  it('EI-25306698395799848: does not attribute a routine workspace filter to joined wake deliveries', () => {
    const query = `SELECT r.id, w.id AS delivery_id
      FROM harness_shared.routines AS r
      LEFT JOIN harness_shared.event_wake_deliveries AS w
        ON w.subscriber_id = r.action_config->>'ownerId'
        AND w.source = 'routine'
        AND w.created_at >= r.created_at
      WHERE r.workspace_id = 'papercusp-workspace' AND r.name LIKE 'loop:%'`;
    expect(buildCorpusNamespaceAdvisory(query)).toBeNull();
    expect(buildCorpusNamespaceAdvisory(query + " AND w.workspace_id = 'papercusp-workspace'"))
      .toContain('event_wake_deliveries');
  });

  it.each([
    "SELECT * FROM harness_shared.routines r JOIN harness_shared.event_wake_deliveries w ON true WHERE r.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.event_wake_deliveries w JOIN harness_shared.routines r ON true WHERE r.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.routines JOIN harness_shared.event_wake_deliveries ON true WHERE routines.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.routines JOIN harness_shared.event_wake_deliveries ON true WHERE harness_shared.routines.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.routines r JOIN harness_shared.event_wake_deliveries w ON true WHERE workspace_id = 'papercusp-workspace'",
  ])('does not invent corpus ownership for an unrelated or ambiguous joined predicate: %s', (query) => {
    expect(buildCorpusNamespaceAdvisory(query)).toBeNull();
  });

  it('keeps corpus predicates independent across joined tables', () => {
    const query = `SELECT * FROM ${PARTS} p JOIN harness_shared.event_wake_deliveries w ON true
      WHERE p.workspace_id = 'default' AND w.workspace_id = 'papercusp-workspace'`;
    expect(buildCorpusNamespaceAdvisory(query)).toContain('event_wake_deliveries');
    expect(buildCorpusNamespaceAdvisory(query)).not.toContain('harness_shared.session_turn_parts');
  });

  it.each([
    `SELECT * FROM ${PARTS} WHERE owner = 'workspace_id = ''papercusp-workspace'''`,
    `SELECT * FROM ${PARTS} /* workspace_id = 'papercusp-workspace' */ WHERE owner = 'agent'`,
    `SELECT * FROM ${PARTS} WHERE owner = $$workspace_id = 'papercusp-workspace'$$`,
    `SELECT * FROM ${PARTS} WHERE owner = $example$workspace_id = 'papercusp-workspace'$example$`,
    `SELECT workspace_id = 'papercusp-workspace' AS belongs_to_workspace FROM ${PARTS}`,
  ])('ignores predicate-shaped text in literals and block comments: %s', (query) => {
    expect(buildCorpusNamespaceAdvisory(query)).toBeNull();
  });

  it.each([
    "SELECT * FROM harness_shared.routines JOIN harness_shared.event_wake_deliveries ON true WHERE event_wake_deliveries.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.routines JOIN harness_shared.event_wake_deliveries ON true WHERE harness_shared.event_wake_deliveries.workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.routines r LEFT JOIN harness_shared.event_wake_deliveries w ON w.workspace_id = 'papercusp-workspace' WHERE r.name = 'loop'",
  ])('warns about the corpus relation with its own explicit predicate: %s', (query) => {
    expect(buildCorpusNamespaceAdvisory(query)).toContain('event_wake_deliveries');
  });

  it.each([
    "SELECT * FROM harness_shared.event_wake_deliveries JOIN harness_shared.routines ON true WHERE workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.event_wake_deliveries, harness_shared.routines WHERE workspace_id = 'papercusp-workspace'",
    "SELECT * FROM harness_shared.event_wake_deliveries w WHERE EXISTS (SELECT 1 FROM harness_shared.routines w WHERE w.workspace_id = 'papercusp-workspace')",
  ])('stays silent when relation ownership is ambiguous: %s', (query) => {
    expect(buildCorpusNamespaceAdvisory(query)).toBeNull();
  });

  it('does not use a self-joined alias default predicate to silence another alias warning', () => {
    expect(buildCorpusNamespaceAdvisory(`SELECT * FROM ${PARTS} p JOIN ${PARTS} q ON true
      WHERE p.workspace_id = 'default' AND q.workspace_id = 'papercusp-workspace'`))
      .toContain('matches ZERO rows');
  });

  it('preserves the mixed session_turns warning independently of joined corpus defaults', () => {
    const advisory = buildCorpusNamespaceAdvisory(`SELECT * FROM ${TURNS} t JOIN ${PARTS} p ON true
      WHERE t.workspace_id = 'papercusp-workspace' AND p.workspace_id = 'default'`);
    expect(advisory).toContain('NOT a corpus constant');
    expect(advisory).not.toContain('matches ZERO rows');
  });
});

describe('buildSessionTurnPartsJsonAdvisory — mixed transcript text needs a guarded decode', () => {
  const PARTS = 'harness_shared.session_turn_parts';

  it('fires for a direct text::jsonb cast and gives the safe decoder', () => {
    const advisory = buildSessionTurnPartsJsonAdvisory(
      `SELECT p.text::jsonb FROM ${PARTS} AS p WHERE p.workspace_id = 'default'`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('22P02');
    expect(advisory).toContain('faithful-render');
    expect(advisory).toContain('CASE WHEN text IS JSON THEN text::jsonb END');
  });

  it('also catches CAST(text AS json/jsonb)', () => {
    expect(
      buildSessionTurnPartsJsonAdvisory(`SELECT CAST(text AS json) FROM ${PARTS}`),
    ).toContain('unsafe session_turn_parts JSON decode');
  });

  it('is silent for the guarded CASE form it recommends', () => {
    expect(
      buildSessionTurnPartsJsonAdvisory(
        `SELECT CASE WHEN p.text IS JSON THEN p.text::jsonb END FROM ${PARTS} AS p`,
      ),
    ).toBeNull();
    expect(
      buildSessionTurnPartsJsonAdvisory(
        `SELECT CASE WHEN text IS JSON THEN CAST(text AS jsonb) END FROM ${PARTS}`,
      ),
    ).toBeNull();
  });

  it('ignores comments, literals, other tables, and non-text JSON casts', () => {
    expect(
      buildSessionTurnPartsJsonAdvisory(
        `SELECT * FROM ${PARTS} -- text::jsonb is only an example\nWHERE owner = 'text::jsonb'`,
      ),
    ).toBeNull();
    expect(buildSessionTurnPartsJsonAdvisory('SELECT text::jsonb FROM harness_shared.work_items')).toBeNull();
    expect(buildSessionTurnPartsJsonAdvisory(`SELECT payload::jsonb FROM ${PARTS}`)).toBeNull();
  });
});

describe('buildNativeToolAttributionAdvisory — native tools are absent from tool_invocations', () => {
  const TI = 'harness_shared.tool_invocations';

  it('fires when tool_invocations is asked about a native client tool', () => {
    const advisory = buildNativeToolAttributionAdvisory(
      `SELECT count(*) FROM ${TI} WHERE tool_name IN ('Edit','Write','MultiEdit')`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('MCP tools ONLY');
    // Routes to the working query INCLUDING the corpus predicate, so following this advice
    // cannot land the caller in the second trap.
    expect(advisory).toContain('session_turn_parts');
    expect(advisory).toContain("workspace_id = 'default'");
    expect(advisory).toContain('SELECT owner, ts, tool_name, text');
    expect(advisory).toContain('faithful-render payload');
    expect(advisory).toContain('no `input`, `content`, or JSON payload columns');
    expect(advisory).toContain('ORDER BY ts DESC LIMIT 50');
  });

  it('is silent for an MCP tool name, which really is recorded there', () => {
    expect(
      buildNativeToolAttributionAdvisory(`SELECT * FROM ${TI} WHERE tool_name = 'capability:edit'`),
    ).toBeNull();
  });

  it('is silent when a native name appears against a different table', () => {
    expect(
      buildNativeToolAttributionAdvisory(
        "SELECT * FROM harness_shared.session_turn_parts WHERE tool_name = 'Edit'",
      ),
    ).toBeNull();
  });

  it('is silent for a tool_invocations query that is not about tool names at all', () => {
    expect(
      buildNativeToolAttributionAdvisory(`SELECT count(*) FROM ${TI} WHERE status = 'error'`),
    ).toBeNull();
  });

  /**
   * The REGRESSION case, verbatim in shape from the report: the two traps compose, and the
   * second zero reads as corroboration of the first. Both advisories must speak for the pair of
   * queries that produced them.
   */
  it('REGRESSION: the composed pair each get their own warning', () => {
    const trap1 = `SELECT count(*) FROM ${TI} WHERE tool_name IN ('Edit','Write') AND workspace_id = 'papercusp-workspace'`;
    const trap2 =
      "SELECT owner, count(*) FROM harness_shared.session_turn_parts WHERE workspace_id = 'papercusp-workspace' AND tool_name = 'Edit' GROUP BY 1";

    expect(buildNativeToolAttributionAdvisory(trap1)).toBeTruthy();
    // trap1's workspace_id predicate is CORRECT — tool_invocations really is multi-tenant.
    expect(buildCorpusNamespaceAdvisory(trap1)).toBeNull();

    expect(buildCorpusNamespaceAdvisory(trap2)).toBeTruthy();
    expect(buildNativeToolAttributionAdvisory(trap2)).toBeNull();
  });
});

/**
 * EI-21847759967934033. The query in the first case is VERBATIM in shape the one that was actually
 * run against a working peer: its truthful MCP-only answer was read as the agent's whole activity,
 * and the agent was told to stop spinning and warned its work might be reassigned. The transcript
 * store for that same owner carries 17 `Bash` calls over the same window.
 */
describe('buildAgentActivityLedgerAdvisory — a single-agent ledger window is not that agent`s activity', () => {
  const TI = 'harness_shared.tool_invocations';
  const PEER = 'su-2a1ddad8-3a5a-48cd-97fc-5314d9767ed0';

  it('fires on the "is this peer working?" read that caused the incident', () => {
    const advisory = buildAgentActivityLedgerAdvisory(
      `SELECT tool_name, count(*) AS calls, max(invoked_at) AS last_at\n` +
        `FROM ${TI}\n` +
        `WHERE coord_owner_id = '${PEER}'\n` +
        `  AND workspace_id = 'papercusp-workspace'\n` +
        `  AND invoked_at > now() - interval '60 minutes'\n` +
        `GROUP BY tool_name ORDER BY 2 DESC`,
    );
    expect(advisory).toBeTruthy();
    // States the coverage gap and names the direction of the error.
    expect(advisory).toContain('MCP calls ONLY');
    expect(advisory).toContain('DIRECTIONAL');
    // Hands over the store that DOES see native calls, and the raw corroborating query with its
    // corpus predicate already correct, so acting on the advice cannot land in the second trap.
    expect(advisory).toContain('activity:tool-log');
    expect(advisory).toContain('session_turn_parts');
    expect(advisory).toContain("workspace_id = 'default'");
  });

  /**
   * The caveat is load-bearing, not decoration. `agent_activity` is empty for ~45% of agents
   * (24h: 182 of 333 tool_invocations owners had rows), so an advisory that named
   * `activity:tool-log` as THE fix would relocate the identical directional error onto a second
   * instrument — and lend it this advisory's authority. If a later edit trims the caveat to
   * shorten the message, this fails.
   */
  it('does not invert the error onto the store it recommends', () => {
    const advisory = buildAgentActivityLedgerAdvisory(
      `SELECT count(*) FROM ${TI} WHERE coord_owner_id = '${PEER}'`,
    );
    expect(advisory).toBeTruthy();
    // The instrument-independent rule, stated outright.
    expect(advisory).toContain('positive rows prove activity; absence here proves nothing');
    // And the specific warning that the recommended store is itself incomplete.
    expect(advisory).toMatch(/empty for ~45% of agents/);
    expect(advisory).toMatch(/empty tool-log is equally not evidence/);
    expect(advisory).toContain('SELECT ts, tool_name, text');
    expect(advisory).toContain("owner = '<the coord ownerId>'");
    expect(advisory).toContain('faithful-render payload column');
    expect(advisory).toContain('ORDER BY ts DESC LIMIT 50');
  });

  it('fires on a prefix-matched owner scope and on a spawn_id scope', () => {
    expect(
      buildAgentActivityLedgerAdvisory(
        `SELECT date_trunc('minute', invoked_at), count(*) FROM ${TI} ` +
          `WHERE coord_owner_id LIKE 'su-61b2b4e5%' AND invoked_at > now() - interval '30 minutes' GROUP BY 1`,
      ),
    ).toBeTruthy();
    expect(
      buildAgentActivityLedgerAdvisory(`SELECT * FROM ${TI} WHERE spawn_id = 'spawn-abc' ORDER BY invoked_at`),
    ).toBeTruthy();
  });

  /**
   * THE REASON THIS BUILDER EXISTS, pinned. The sibling advisory is silent on the harmful query
   * because it never names a native tool — that silence is the whole gap. If someone later widens
   * the sibling to cover this shape, this expectation fails and the right repair is to DELETE one
   * of them, not to keep both firing.
   */
  it('REGRESSION: covers exactly the query the native-tool advisory is silent on', () => {
    const harmful = `SELECT tool_name, count(*) FROM ${TI} WHERE coord_owner_id = '${PEER}' GROUP BY 1`;
    expect(buildNativeToolAttributionAdvisory(harmful)).toBeNull();
    expect(buildAgentActivityLedgerAdvisory(harmful)).toBeTruthy();

    // And the converse: an unscoped read that ASKS FOR a native tool is the sibling's case only.
    const askedByName = `SELECT count(*) FROM ${TI} WHERE tool_name IN ('Edit','Write')`;
    expect(buildNativeToolAttributionAdvisory(askedByName)).toBeTruthy();
    expect(buildAgentActivityLedgerAdvisory(askedByName)).toBeNull();
  });

  it('is silent for a fleet-wide rollup that only projects or groups by the owner', () => {
    expect(
      buildAgentActivityLedgerAdvisory(
        `SELECT coord_owner_id, count(*) FROM ${TI} WHERE invoked_at > now() - interval '24 hours' GROUP BY coord_owner_id`,
      ),
    ).toBeNull();
  });

  it('is silent for an IS NOT NULL population filter, which scopes to no one agent', () => {
    expect(
      buildAgentActivityLedgerAdvisory(
        `SELECT count(*) FROM ${TI} WHERE coord_owner_id IS NOT NULL AND status = 'error'`,
      ),
    ).toBeNull();
  });

  it('is silent when the owner scope is against a different table', () => {
    expect(
      buildAgentActivityLedgerAdvisory(
        `SELECT tool_name, count(*) FROM harness_shared.session_turn_parts WHERE owner = '${PEER}' GROUP BY 1`,
      ),
    ).toBeNull();
  });

  it('is silent when the scope appears only in a comment', () => {
    expect(
      buildAgentActivityLedgerAdvisory(
        `SELECT count(*) FROM ${TI}\n-- was: WHERE coord_owner_id = '${PEER}'\nWHERE status = 'error'`,
      ),
    ).toBeNull();
  });
});

/**
 * WI-1447231 / scheduling-and-liveness-source-of-truth-2026-08-31 P-001. The query in the first
 * case is verbatim in shape the one that caused the incident: a session an operator SIGKILL cut
 * off mid-turn never wrote `ended_at`, so the raw predicate over-reported running agents 44 vs the
 * true ~12 by sessionState (only 3 live).
 */
describe('buildAdvSessionsLivenessAdvisory — adv_sessions.ended_at is not the liveness oracle', () => {
  const ADV = 'harness_shared.adv_sessions';

  it('fires on the "IS NULL ⇒ running" read that caused the incident', () => {
    const advisory = buildAdvSessionsLivenessAdvisory(
      `SELECT count(*) FROM ${ADV} WHERE ended_at IS NULL`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('NOT the liveness oracle');
    expect(advisory).toContain('SIGKILL');
    expect(advisory).toContain('coord:presence');
    expect(advisory).toContain('sessionState');
    expect(advisory).toContain('presence-wakeability.ts');
    // The measured incident numbers, pinned so a later edit can't quietly drop them.
    expect(advisory).toMatch(/44 running agents/);
    expect(advisory).toMatch(/~12 by sessionState/);
  });

  it('fires on the opposite direction too — IS NOT NULL is the same trap read backwards', () => {
    expect(
      buildAdvSessionsLivenessAdvisory(`SELECT * FROM ${ADV} WHERE ended_at IS NOT NULL`),
    ).toBeTruthy();
  });

  it('fires regardless of case/whitespace in the predicate', () => {
    expect(
      buildAdvSessionsLivenessAdvisory(`select * from ${ADV} where ended_at  is  null`),
    ).toBeTruthy();
  });

  it('is silent when the table is not adv_sessions', () => {
    expect(
      buildAdvSessionsLivenessAdvisory(
        `SELECT count(*) FROM harness_shared.session_turns WHERE ended_at IS NULL`,
      ),
    ).toBeNull();
  });

  it('is silent on adv_sessions when the query never touches ended_at', () => {
    expect(
      buildAdvSessionsLivenessAdvisory(
        `SELECT session_id, owner FROM ${ADV} WHERE owner = 'su-abc' ORDER BY started_at DESC`,
      ),
    ).toBeNull();
  });

  it('is silent when ended_at appears only in a comment, not a predicate', () => {
    expect(
      buildAdvSessionsLivenessAdvisory(
        `SELECT count(*) FROM ${ADV}\n-- was: WHERE ended_at IS NULL\nWHERE owner = 'su-abc'`,
      ),
    ).toBeNull();
  });
});

/**
 * WI-38056 / EI-20203674337042683. The regression this locks down is not
 * hypothetical: the query in the first case is the one the WI-38045 fleet audit
 * actually ran, and its confident empty produced a published finding that did not
 * exist plus a downgraded grade for an agent whose work was fine.
 */
describe('buildSplitCompletionEvidenceAdvisory — one evidence surface read as "no evidence"', () => {
  const EI = 'harness_shared.engineer_issues';

  it('fires on the audit query that read ONLY payload evidence', () => {
    const advisory = buildSplitCompletionEvidenceAdvisory(
      `SELECT issue_id, payload->'_completionEvidence' AS ev FROM ${EI} WHERE state = 'dropped'`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('terminal_completion_ref');
  });

  it('fires the other way too — only terminal_completion_ref', () => {
    const advisory = buildSplitCompletionEvidenceAdvisory(
      `SELECT issue_id, terminal_completion_ref FROM ${EI} WHERE state = 'done'`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('_completionEvidence');
  });

  it('stays SILENT when both surfaces are read — the query cannot under-report', () => {
    expect(
      buildSplitCompletionEvidenceAdvisory(
        `SELECT payload->'_completionEvidence' AS ev, terminal_completion_ref FROM ${EI}`,
      ),
    ).toBeNull();
  });

  it('warns that terminal_reason is a vocabulary token, not a reason', () => {
    const advisory = buildSplitCompletionEvidenceAdvisory(
      `SELECT issue_id, terminal_reason FROM ${EI} WHERE state = 'dropped'`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('vocabulary token');
  });

  it('does not fire on a query that reads neither surface, or on another table', () => {
    expect(buildSplitCompletionEvidenceAdvisory(`SELECT issue_id, title FROM ${EI}`)).toBeNull();
    expect(
      buildSplitCompletionEvidenceAdvisory('SELECT terminal_completion_ref FROM harness_shared.harness_plans'),
    ).toBeNull();
  });
});

describe('buildEpochUnitAdvisory (EI-20261119579595975 — seconds divided as milliseconds)', () => {
  const TOOL_INVOCATIONS = 'harness_shared.tool_invocations';

  it('warns on an epoch-seconds literal divided by 1000 in an invoked_at read', () => {
    const advisory = buildEpochUnitAdvisory(
      `SELECT min(invoked_at) FROM ${TOOL_INVOCATIONS} ` +
        'WHERE invoked_at >= to_timestamp(1786547705.088/1000.0)',
    );
    expect(advisory).toContain('epoch-unit ambiguity');
    expect(advisory).toContain('ISO timestamptz literal');
    expect(advisory).toContain('min(invoked_at)');
  });

  it('stays silent when the literal is genuinely epoch milliseconds', () => {
    expect(
      buildEpochUnitAdvisory(
        `SELECT min(invoked_at) FROM ${TOOL_INVOCATIONS} ` +
          'WHERE invoked_at >= to_timestamp(1786547705088/1000.0)',
      ),
    ).toBeNull();
  });

  it.each([
    ['a different relation', 'harness_shared.work_items'],
    ['a parameterized value', 'harness_shared.tool_invocations'],
  ])('stays silent for %s', (_label, relation) => {
    const sql =
      relation === TOOL_INVOCATIONS
        ? `SELECT invoked_at FROM ${relation} WHERE invoked_at >= to_timestamp(epoch_ms/1000)`
        : `SELECT invoked_at FROM ${relation} WHERE invoked_at >= to_timestamp(1786547705.088/1000.0)`;
    expect(buildEpochUnitAdvisory(sql)).toBeNull();
  });

  it('ignores the trap text when it appears inside a string or comment', () => {
    const sql =
      `SELECT invoked_at FROM ${TOOL_INVOCATIONS} ` +
      "WHERE note = 'to_timestamp(1786547705.088/1000.0)' -- to_timestamp(1786547705.088/1000.0)";
    expect(buildEpochUnitAdvisory(sql)).toBeNull();
  });
});

describe('buildDbosWorkflowStatusSchemaHint (EI-23095186684817118)', () => {
  const WORKFLOW_STATUS = 'dbos.workflow_status';

  it('explains the epoch-ms comparison after a bigint/timestamptz operator error', () => {
    const hint = buildDbosWorkflowStatusSchemaHint(
      `SELECT count(*) FROM ${WORKFLOW_STATUS} WHERE created_at > now()`,
      {
        code: '42883',
        message: 'operator does not exist: bigint > timestamp with time zone',
      },
    );

    expect(hint).toContain('BIGINT epoch milliseconds');
    expect(hint).toContain('(extract(epoch from now()) * 1000)::bigint');
    expect(hint).toContain('updated_at_epoch_ms');
  });

  it('corrects guessed DBOS timestamp and workflow-name columns', () => {
    const timestampHint = buildDbosWorkflowStatusSchemaHint(
      `SELECT updated_at_epoch_ms FROM ${WORKFLOW_STATUS}`,
      { code: '42703', message: 'column "updated_at_epoch_ms" does not exist' },
    );
    const nameHint = buildDbosWorkflowStatusSchemaHint(
      `SELECT workflow_name FROM ${WORKFLOW_STATUS}`,
      { code: '42703', message: 'column "workflow_name" does not exist' },
    );

    expect(timestampHint).toContain('updated_at`');
    expect(nameHint).toContain('`name`, not `workflow_name`');
  });

  it('stays silent for unrelated relations and errors', () => {
    expect(
      buildDbosWorkflowStatusSchemaHint(
        'SELECT updated_at_epoch_ms FROM harness_shared.work_items',
        { code: '42703', message: 'column "updated_at_epoch_ms" does not exist' },
      ),
    ).toBeNull();
    expect(
      buildDbosWorkflowStatusSchemaHint(
        `SELECT priority FROM ${WORKFLOW_STATUS}`,
        { code: '42703', message: 'column "priority" does not exist' },
      ),
    ).toBeNull();
  });
});

describe('buildDbosHistoricalIntervalJoinAdvisory (EI-25237971414928998)', () => {
  const historyWideJoin = [
    'WITH target(window_label, lo_ms, hi_ms) AS (',
    "  VALUES ('09:45-09:46Z', 1000, 2000)",
    ')',
    'SELECT w.workflow_uuid, o.function_name',
    'FROM target t',
    'JOIN dbos.workflow_status w',
    "  ON w.name IN ('routinesTick', 'routineFire')",
    ' AND w.started_at_epoch_ms < t.hi_ms',
    'JOIN dbos.operation_outputs o',
    '  ON o.workflow_uuid = w.workflow_uuid',
    ' AND o.started_at_epoch_ms < t.hi_ms',
    ' AND (o.completed_at_epoch_ms IS NULL OR o.completed_at_epoch_ms >= t.lo_ms)',
  ].join('\n');

  it('warns when a narrow operation window is joined after an upper-only workflow history scan', () => {
    const advisory = buildDbosHistoricalIntervalJoinAdvisory(historyWideJoin);
    expect(advisory).toContain('DBOS historical interval join');
    expect(advisory).toContain('every earlier workflow remains a candidate');
    expect(advisory).toContain('join workflow_status by workflow_uuid');
    expect(advisory).toContain('maxRows limits returned rows, not scan work');
  });

  it('stays silent when workflow start time is bounded on both sides or has no upper-only predicate', () => {
    expect(
      buildDbosHistoricalIntervalJoinAdvisory(
        historyWideJoin.replace('w.started_at_epoch_ms < t.hi_ms', 'w.workflow_uuid = t.workflow_uuid'),
      ),
    ).toBeNull();
    expect(
      buildDbosHistoricalIntervalJoinAdvisory(
        historyWideJoin.replace(
          'w.started_at_epoch_ms < t.hi_ms',
          'w.started_at_epoch_ms >= t.lo_ms AND w.started_at_epoch_ms < t.hi_ms',
        ),
      ),
    ).toBeNull();
  });

  it('ignores unrelated and comment/literal-only DBOS mentions', () => {
    expect(buildDbosHistoricalIntervalJoinAdvisory('SELECT 1')).toBeNull();
    expect(
      buildDbosHistoricalIntervalJoinAdvisory(
        "SELECT 'dbos.workflow_status w JOIN dbos.operation_outputs o' AS note -- w.started_at_epoch_ms < 1",
      ),
    ).toBeNull();
  });
});

describe('buildJsonTextSearchAdvisory (EI-21663090256112441 — unbounded JSONB text search)', () => {
  const TOOL_INVOCATIONS = 'harness_shared.tool_invocations';

  it('warns when args_json is cast to text for an unbounded ILIKE predicate', () => {
    const advisory = buildJsonTextSearchAdvisory(
      `SELECT id, tool_name FROM ${TOOL_INVOCATIONS} ` +
        "WHERE workspace_id = 'papercusp-workspace' AND args_json::text ILIKE '%EI-22033266394507364%'",
    );
    expect(advisory).toContain('unbounded JSON-text search');
    expect(advisory).toContain('args_json::text');
    expect(advisory).toContain('maxRows');
    expect(advisory).toContain('allowUnboundedJsonSearch: true');
  });

  it('also catches metadata_json CAST(text) and PostgreSQL LIKE operator spellings', () => {
    expect(
      buildJsonTextSearchAdvisory(
        `SELECT id FROM ${TOOL_INVOCATIONS} WHERE CAST(metadata_json AS text) ~~* '%requestOrigin%'`,
      ),
    ).toContain('metadata_json::text');
  });

  it('still warns when SQL supplies a LIMIT/FETCH row cap because the WHERE scan remains unbounded', () => {
    expect(
      buildJsonTextSearchAdvisory(
        `SELECT id FROM ${TOOL_INVOCATIONS} WHERE args_json::text ILIKE '%needle%' LIMIT 5`,
      ),
    ).toContain('unbounded JSON-text search');
    expect(
      buildJsonTextSearchAdvisory(
        `SELECT id FROM ${TOOL_INVOCATIONS} WHERE metadata_json::text LIKE '%needle%' FETCH FIRST 5 ROWS ONLY`,
      ),
    ).toContain('unbounded JSON-text search');
  });

  it('stays silent for projections, other relations, and quoted examples', () => {
    expect(
      buildJsonTextSearchAdvisory(`SELECT args_json::text FROM ${TOOL_INVOCATIONS}`),
    ).toBeNull();
    expect(
      buildJsonTextSearchAdvisory("SELECT args_json::text FROM other_table WHERE args_json::text ILIKE '%x%'"),
    ).toBeNull();
    expect(
      buildJsonTextSearchAdvisory(
        `SELECT id FROM ${TOOL_INVOCATIONS} ` +
          "WHERE note = 'args_json::text ILIKE ''%quoted%''' -- args_json::text ILIKE '%comment%'",
      ),
    ).toBeNull();
  });
});

/**
 * P-001 (sql-escape-tool-routing-2026-08-12) — "a tool already answers this read".
 *
 * The behaviour under test is a BALANCE, so both halves are asserted with equal
 * weight: an advisory that never fires teaches nothing, and one that fires on
 * the analytic reads `dev:pg_query` exists to serve is noise on a path that
 * carried ~15.9k calls in 14 days. The silence cases below are therefore the
 * real specification, not padding.
 */
describe('buildToolRoutingAdvisory', () => {
  it('fires on a plain single-table read of a covered relation', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT name, active, last_fired_at FROM harness_shared.routines WHERE install_slug = 'papercusp'",
    );
    expect(advisory).toContain('routines:list');
    // It must say what the tool ADDS, not merely that one exists.
    expect(advisory).toContain('pause');
  });

  // The three relations P-009 tranche 2 shipped audited pairs for. Each had a
  // CLAUDE.md row and a frozen-fixture equivalence verdict while the LIVE nudge
  // — the one the agent meets mid-query, which is the only one they are reading
  // at the moment it matters — was silent or pointed elsewhere.
  it('fires for a schema_migrations lookup and says what the verdict adds', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT filename, applied_at FROM harness_shared.schema_migrations WHERE filename LIKE '795%'",
    );
    expect(advisory).toContain('db:migrations');
    // The whole reason to switch: an empty SQL result cannot distinguish these.
    expect(advisory).toContain('draft-not-armed');
  });

  it('fires for a test_runs read and warns that the guessed status literal cannot match', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT file_path, status FROM harness_shared.test_runs WHERE status = 'failed' ORDER BY started_at DESC LIMIT 20",
    );
    expect(advisory).toContain('testing:runs');
    expect(advisory).toContain("status='failed'");
  });

  it('names the id-capable verb for engineer_issues, since issues:list has no id filter', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT issue_id, state, title FROM harness_shared.engineer_issues WHERE state = 'open'",
    );
    expect(advisory).toContain('issues:list');
    expect(advisory).toContain('work_items:get');
  });

  it('names the derived-liveness surface for a raw coord_presence read', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT owner_id, heartbeat_at FROM harness_shared.coord_presence WHERE workspace_id = 'papercusp-workspace'",
    );
    expect(advisory).toContain('coord:presence');
    expect(advisory).toContain('sessionState');
  });

  it('stays silent on an uncovered relation', () => {
    expect(
      buildToolRoutingAdvisory("SELECT * FROM harness_shared.some_unrouted_table WHERE id = '1'"),
    ).toBeNull();
  });

  it.each([
    ['a group-by', 'SELECT status, count(*) FROM harness_shared.work_items GROUP BY status'],
    ['an aggregate', 'SELECT count(*) FROM harness_shared.routines'],
    ['a window function', 'SELECT name, row_number() OVER (ORDER BY last_fired_at) FROM harness_shared.routines'],
    [
      'a join',
      'SELECT r.name FROM harness_shared.routines r JOIN harness_shared.harness_plans p ON p.slug = r.name',
    ],
    ['a union', 'SELECT name FROM harness_shared.routines UNION SELECT slug FROM harness_shared.harness_plans'],
  ])('stays silent on %s — that is what this tool is FOR', (_label, sql) => {
    expect(buildToolRoutingAdvisory(sql)).toBeNull();
  });

  it('defers to the claimability advisory rather than crowding it', () => {
    const sql = "SELECT feature_id FROM harness_shared.work_items WHERE status = 'open'";
    // The specific correctness warning still fires...
    expect(buildClaimabilityAdvisory(sql)).not.toBeNull();
    // ...and the generic routing hint stands down so it is not buried.
    expect(buildToolRoutingAdvisory(sql)).toBeNull();
  });

  it('still routes a work_items read that is NOT the claimability shape', () => {
    const advisory = buildToolRoutingAdvisory(
      "SELECT title FROM harness_shared.work_items WHERE feature_id = 'WI-1'",
    );
    expect(advisory).toContain('work_items:list');
  });

  it('stays silent for arbitrary coord_thread_posts and post-id scans', () => {
    expect(
      buildToolRoutingAdvisory(
        'SELECT id, author_id, body FROM harness_shared.coord_thread_posts WHERE id = 53559',
      ),
    ).toBeNull();
    expect(
      buildToolRoutingAdvisory(
        "SELECT id, thread_id, body FROM harness_shared.coord_thread_posts WHERE post_msg_id = 'post-1'",
      ),
    ).toBeNull();
    expect(
      buildToolRoutingAdvisory(
        "SELECT id, thread_id, body FROM harness_shared.coord_thread_posts WHERE thread_id = 'thr-conversation-1'",
      ),
    ).toBeNull();
  });

  it.each(['issue-thread-WI-6270', 'work-item-thread-WI-5137'])(
    'routes the recognizable %s shape to work_items:get',
    (threadId) => {
      const advisory = buildToolRoutingAdvisory(
        `SELECT id, thread_id, body FROM harness_shared.coord_thread_posts WHERE thread_id = '${threadId}'`,
      );
      expect(advisory).toContain('work_items:get');
      expect(advisory).not.toContain('coord:catch-up');
    },
  );

  it('does not route a commented or string-contained example as a thread predicate', () => {
    expect(
      buildToolRoutingAdvisory(
        "SELECT body FROM harness_shared.coord_thread_posts WHERE id = 53559 -- thread_id = 'issue-thread-WI-1'",
      ),
    ).toBeNull();
    expect(
      buildToolRoutingAdvisory(
        "SELECT 'thread_id = \'issue-thread-WI-1\'' AS example FROM harness_shared.coord_thread_posts",
      ),
    ).toBeNull();
  });

  /**
   * THE RECURRENCE GUARD. Routing an agent to a verb that does not exist is
   * strictly worse than the raw SQL it replaces — the SQL works, and the
   * phantom costs a round trip and teaches a name that resolves to nothing.
   *
   * ⚠ This guard exists because the obvious way to check a verb's existence is
   * WRONG here: a `grep "name: '<verb>'"` under-reports, since several real
   * tools declare their name with DOUBLE quotes (work_items:list, plans:items).
   * A single-quote grep reports them absent, which reads exactly like proof of
   * absence. Assert against the loaded registry instead of any text search.
   */
  it('every routed verb resolves in the real tool registry', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    // BOTH tool roots. The write-side group lives under operator-core, the
    // read-side group under agent-mcp — and scanning only the first is a
    // mistake this guard has already caught once (it reported goals:list,
    // goals:get and harness:status as phantom when all three are real).
    const toolRoots = [
      join(here, 'agent-tools'),
      join(here, '..', '..', 'agent-mcp', 'src', 'tools'),
    ];
    const known = new Set<string>();
    for (const root of toolRoots) {
      for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
        if (!entry.endsWith('.ts') || entry.includes('.test.')) continue;
        const src = readFileSync(join(root, entry), 'utf8');
        // Quote-agnostic ON PURPOSE — see this block's doc comment.
        for (const m of src.matchAll(/\bname:\s*['"]([a-z_]+:[a-z_-]+)['"]/g)) known.add(m[1]);
      }
    }

    // CALIBRATION: without this, a scan that silently found nothing would make
    // `phantom` empty for the wrong reason and the guard would pass while
    // verifying nothing. It has already earned its place once — the first
    // version of this test loaded the registry the wrong way and this line is
    // what said so, instead of a confusing wall of "verb does not exist".
    expect(known.size).toBeGreaterThan(100);

    const routed = Object.values(TOOL_ROUTING_BY_TABLE)
      .flatMap((r) => r.tool.split('/'))
      .map((v) => v.trim())
      .filter((v) => /^[a-z_]+:[a-z_-]+$/.test(v));
    expect(routed.length).toBeGreaterThan(10);

    const phantom = routed.filter((v) => !known.has(v));
    expect(phantom, `routed to verbs that do not exist: ${phantom.join(', ')}`).toEqual([]);
  });
});
describe('buildBacklogFlowAdvisory — lane-predicate detection (EI-21412161573952069)', () => {
  it('does NOT fire for a payload-lane filter whose key only survives in string literals', () => {
    // The exact reporter shape: the lane key lives inside a JSON literal, which
    // stripSqlLiteralsAndComments erases — the old stripped-only probe read this
    // correctly-filtered aggregate as "no lane predicate".
    const sql = [
      'SELECT workspace_id, harness_slug, count(*) AS n',
      'FROM harness_shared.work_items',
      "WHERE COALESCE(payload->>'lane','') <> 'observation'",
      'GROUP BY workspace_id, harness_slug',
    ].join(' ');
    expect(buildBacklogFlowAdvisory(sql)).toBeNull();
  });

  it('still fires for an aggregate with no lane mention anywhere', () => {
    const sql = 'SELECT count(*) FROM harness_shared.work_items';
    expect(buildBacklogFlowAdvisory(sql)).toMatch(/no `lane` predicate/);
  });

  it('stays silent when a real lane column reference survives stripping', () => {
    const sql = "SELECT count(*) FROM harness_shared.work_items WHERE payload->>'lane' = 'bug'";
    expect(buildBacklogFlowAdvisory(sql)).toBeNull();
  });
});

describe('buildBacklogFlowAdvisory — exact resource-governor population detection (EI-22041497849729519)', () => {
  it('stays silent for an aggregate restricted to resource-governor receipts', () => {
    const sql = [
      'SELECT count(*) FROM harness_shared.work_items',
      "WHERE jsonb_exists(payload, 'resource_governor')",
    ].join(' ');
    expect(buildBacklogFlowAdvisory(sql)).toBeNull();
  });

  it('recognizes the equivalent JSON existence operator', () => {
    const sql = "SELECT count(*) FROM harness_shared.work_items WHERE payload ? 'resource_governor'";
    expect(buildBacklogFlowAdvisory(sql)).toBeNull();
  });

  it('still warns when resource-governor receipts are excluded from a general aggregate', () => {
    const sql = "SELECT count(*) FROM harness_shared.work_items WHERE NOT jsonb_exists(payload, 'resource_governor')";
    expect(buildBacklogFlowAdvisory(sql)).toMatch(/no `lane` predicate/);
  });

  it('does not treat a marker mentioned only in the projection as a population predicate', () => {
    const sql = [
      'SELECT count(*), jsonb_exists(payload,',
      "'resource_governor') AS has_receipt",
      'FROM harness_shared.work_items',
    ].join(' ');
    expect(buildBacklogFlowAdvisory(sql)).toMatch(/no `lane` predicate/);
  });
});

/**
 * EI-19450552881841590 — `superseded_at` misread in both directions.
 *
 * The filing measured the omission direction on 2026-08-03 (naive 139 vs a real
 * cap population of 50). Re-measured 2026-09-01 the trap is live and larger —
 * naive 471 vs 200 — but its COMPOSITION moved: supersession is now only 131 of
 * the 271-row gap, with conventions 81 and exempt wall:/dead-end:/guard-rail:
 * slots 59. That is why the remedy names all five clauses; an advisory that
 * fixed only the clause the filing named would return a predicate still wrong by
 * ~140 rows while carrying this tool's authority.
 */
describe('buildAgentFactsSupersessionAdvisory — superseded_at means neither "live" nor "evicted"', () => {
  const AF = 'harness_shared.agent_facts';

  it('fires on the naive liveness predicate every audit of this table reaches for', () => {
    const advisory = buildAgentFactsSupersessionAdvisory(
      `SELECT count(*) FROM ${AF}\n` +
        ` WHERE workspace_id = 'papercusp-workspace' AND scope = 'harness'\n` +
        `   AND scope_ref = 'papercusp'\n` +
        `   AND retracted_at IS NULL AND expires_at > now()`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('superseded_at IS NULL');
    // Names the direction of the error, which is what stops the false headline.
    expect(advisory).toContain('cap has stopped enforcing');
  });

  /**
   * Load-bearing, not decoration. Adding `superseded_at IS NULL` alone closes 131
   * of 271 rows; a reader who stopped there would believe a still-wrong number.
   * If a later edit trims the remedy to just the named clause, this fails.
   */
  it('hands back all five clauses, not just the one the filing named', () => {
    const advisory = buildAgentFactsSupersessionAdvisory(
      `SELECT * FROM ${AF} WHERE retracted_at IS NULL`,
    )!;
    expect(advisory).toContain('is NOT enough');
    expect(advisory).toContain('source_hive IS NULL');
    expect(advisory).toContain("key NOT LIKE 'guard-rail:%'");
    expect(advisory).toContain("COALESCE(kind,'') <> 'convention'");
    // And routes to the surfaces that already scope correctly.
    expect(advisory).toContain('facts:list');
    expect(advisory).toContain('dryRun');
  });

  it('fires the OPPOSITE direction: superseded rows read as evictions', () => {
    const advisory = buildAgentFactsSupersessionAdvisory(
      `SELECT count(*) FROM ${AF} WHERE superseded_at IS NOT NULL AND superseded_at > now() - interval '6 hours'`,
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('NOT an eviction marker');
    // Hands over the column that actually marks destruction, plus the live-successor
    // test that separates a correction from a real loss.
    expect(advisory).toContain('evicted_at IS NOT NULL');
    expect(advisory).toContain('live successor');
  });

  it('stays silent for a reader already distinguishing supersession from eviction', () => {
    expect(
      buildAgentFactsSupersessionAdvisory(
        `SELECT count(*) FILTER (WHERE evicted_at IS NOT NULL) FROM ${AF} WHERE superseded_at IS NOT NULL`,
      ),
    ).toBeNull();
  });

  it('stays silent once the omitted clause is present', () => {
    expect(
      buildAgentFactsSupersessionAdvisory(
        `SELECT * FROM ${AF} WHERE superseded_at IS NULL AND retracted_at IS NULL AND expires_at > now()`,
      ),
    ).toBeNull();
  });

  it('does not fire on a read that makes no liveness claim, or on another table', () => {
    // No liveness marker at all — counting every version is a legitimate question.
    expect(buildAgentFactsSupersessionAdvisory(`SELECT key, count(*) FROM ${AF} GROUP BY 1`)).toBeNull();
    expect(
      buildAgentFactsSupersessionAdvisory(
        'SELECT * FROM harness_shared.work_items WHERE retracted_at IS NULL AND expires_at > now()',
      ),
    ).toBeNull();
  });

  /**
   * The builder matches the literal-and-comment-stripped body, so a column named
   * inside a quoted string or a `--` comment is not treated as a predicate. Without
   * this, quoting the correct predicate in a comment would silence the advisory.
   */
  it('does not count `superseded_at` mentioned only in a comment or string literal', () => {
    const advisory = buildAgentFactsSupersessionAdvisory(
      `SELECT count(*) FROM ${AF}\n` +
        ` -- remember to add superseded_at IS NULL here\n` +
        ` WHERE retracted_at IS NULL AND body <> 'superseded_at'`,
    );
    expect(advisory).toBeTruthy();
  });

  /**
   * DRIFT PIN. The advisory prints what it calls "the full predicate, mirroring
   * capPopulationPredicate" — a hand-maintained second copy of a predicate the
   * store owns. Its only previous guard was a comment asking the next editor to
   * remember, and that failed: the partition clause added by
   * EI-20365165629381535 never reached the advisory, so the advertised "full
   * predicate" merged the ordinary and volatile populations and compared the
   * total against one of two different caps.
   *
   * Rather than assert a hand-listed clause set (which would be a THIRD copy
   * with the same defect), derive the required tokens from store.ts at test
   * time: every column/marker the canonical predicate constrains must be named
   * in the advisory. A new clause in capPopulationPredicate fails this until the
   * advisory names it too.
   */
  it('mirrors every column the canonical capPopulationPredicate constrains', async () => {
    const { readFileSync } = await import('node:fs');
    const storeSrc = readFileSync(new URL('./agent-facts/store.ts', import.meta.url), 'utf8');

    const fnStart = storeSrc.indexOf('function capPopulationPredicate(');
    expect(fnStart, 'capPopulationPredicate not found — this pin is measuring nothing').toBeGreaterThan(-1);
    // Slice to the next top-level `function ` so the body is bounded even as it grows.
    const after = storeSrc.slice(fnStart + 1);
    const fnEnd = after.indexOf('\nfunction ');
    const body = fnEnd === -1 ? after : after.slice(0, fnEnd);

    // Only the SQL the function actually emits: its sql`...` template literals,
    // minus `--` comments and ${...} interpolations, so TypeScript identifiers
    // and explanatory prose cannot inflate the required set.
    const sqlChunks = [...body.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]);
    expect(sqlChunks.length, 'no sql`` templates found in capPopulationPredicate').toBeGreaterThan(0);
    const emittedSql = sqlChunks
      .join('\n')
      .replace(/\$\{[^}]*\}/g, ' ')
      .replace(/--[^\n]*/g, ' ');

    // SQL keywords/functions and bare literals are not columns.
    const NOISE = new Set([
      'and',
      'or',
      'not',
      'null',
      'like',
      'from',
      'distinct',
      'true',
      'false',
      'coalesce',
      'now',
      'jsonb',
      'is',
    ]);
    const required = [...new Set([...emittedSql.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map((m) => m[0]))].filter(
      (t) => !NOISE.has(t.toLowerCase()),
    );
    // Guard the guard: if extraction silently returned nothing, the assertions
    // below would all pass vacuously.
    expect(required, 'derived token set is empty — extraction broke, not a clean pass').not.toHaveLength(0);
    expect(required).toContain('subjectVolatile');

    const advisory = buildAgentFactsSupersessionAdvisory(
      `SELECT count(*) FROM ${AF} WHERE retracted_at IS NULL AND expires_at > now()`,
    );
    expect(advisory).toBeTruthy();
    const missing = required.filter((token) => !advisory!.includes(token));
    expect(
      missing,
      `the advisory's printed predicate omits ${missing.join(', ')} — it is a hand-maintained ` +
        'mirror of capPopulationPredicate and has drifted; add the clause to the advisory text',
    ).toEqual([]);
  });
});

/**
 * EI-19464809374955438 — the sibling of the block above, and the reason it is a
 * SEPARATE advisory: that one warns a predicate is wrong and names the clause
 * that repairs it, while this one warns the question cannot be answered from the
 * data at all.
 *
 * `event_key_fires` holds ONE row per key, so a windowed predicate on its
 * timestamps drops every fire but the last and returns 0 — a value shaped
 * exactly like "no harm occurred". These tests pin the two properties that make
 * the advisory worth its noise: it fires on the windowed shape a wake-loss
 * investigation actually reaches for, and it stays silent on the ordinary latch
 * reads that are a correct use of the table.
 *
 * The ABSENCE of a clearing predicate is deliberate and is asserted below. If a
 * later edit "helpfully" adds one, that edit is claiming a right answer is
 * reachable by rewriting the SQL — which is false, and this fails.
 */
describe('buildEventFireWindowAdvisory — an aggregate latch cannot answer a windowed question', () => {
  const EKF = 'harness_shared.event_key_fires';

  it('fires on the exact join the filing used to conclude "0 stranded"', () => {
    const advisory = buildEventFireWindowAdvisory(
      `SELECT count(*) FROM harness_shared.event_awaits cx\n` +
        ` JOIN ${EKF} f ON f.event_key = cx.event_key\n` +
        ` WHERE f.last_fired_at > cx.cancelled_at AND f.last_fired_at < cx.expires_ts`,
    );
    expect(advisory).toBeTruthy();
    // The operative correction: the number is not a count, it is an unknown.
    expect(advisory).toContain('UNKNOWN, never NONE');
    expect(advisory).toContain('AGGREGATE LATCH');
  });

  /**
   * Load-bearing. `event_wake_attempts` is the obvious next reach for a reader who
   * has just been told the latch cannot answer, and it is the same trap one level
   * quieter: 3.4% of fires observable, 98.5% of keys with no row at all. An
   * advisory that omitted this would move the reader from a loud false negative to
   * a silent one.
   */
  it('pre-empts the wake-attempts "fix", which is the same trap quieter', () => {
    const advisory = buildEventFireWindowAdvisory(
      `SELECT * FROM ${EKF} WHERE last_fired_at >= now() - interval '1 day'`,
    )!;
    expect(advisory).toContain('event_wake_attempts');
    expect(advisory).toContain('ARMED');
    expect(advisory).toContain('3.4%');
  });

  it('names the one narrowing that IS exact, rather than only refusing', () => {
    const advisory = buildEventFireWindowAdvisory(
      `SELECT * FROM ${EKF} WHERE last_fired_at BETWEEN $1 AND $2`,
    )!;
    expect(advisory).toContain('fire_count = 1');
  });

  it('offers NO clearing predicate — the data does not exist, so better SQL is not the fix', () => {
    // Every plausible "corrected" form still fires. This is the property that
    // separates this advisory from every other builder in the file.
    for (const sql of [
      `SELECT * FROM ${EKF} WHERE workspace_id = 'papercusp-workspace' AND last_fired_at > now() - interval '7 days'`,
      `SELECT * FROM ${EKF} f JOIN harness_shared.event_wake_attempts a USING (event_key) WHERE f.last_fired_at > a.attempted_at`,
      `SELECT * FROM ${EKF} WHERE first_fired_at >= $1 AND last_fired_at <= $2`,
    ]) {
      expect(buildEventFireWindowAdvisory(sql)).toBeTruthy();
    }
  });

  it('matches a comparison on EITHER side of the operator', () => {
    expect(buildEventFireWindowAdvisory(`SELECT * FROM ${EKF} WHERE $1 < f.last_fired_at`)).toBeTruthy();
  });

  /**
   * The noise boundary. Reading the latch AS a latch is the common, correct use of
   * this table; firing there would train readers to skim advisories, which is the
   * cost that makes a good advisory bad.
   */
  it('stays silent on latch reads that make no window claim', () => {
    expect(buildEventFireWindowAdvisory(`SELECT event_key, fire_count FROM ${EKF}`)).toBeNull();
    expect(
      buildEventFireWindowAdvisory(
        `SELECT event_key, last_fired_at FROM ${EKF} ORDER BY last_fired_at DESC LIMIT 5`,
      ),
    ).toBeNull();
    expect(buildEventFireWindowAdvisory(`SELECT max(last_fired_at) FROM ${EKF}`)).toBeNull();
    // A comparison on a NON-timestamp column is not a window question.
    expect(buildEventFireWindowAdvisory(`SELECT * FROM ${EKF} WHERE fire_count > 100`)).toBeNull();
  });

  it('does not fire on another table that happens to have a windowed timestamp', () => {
    expect(
      buildEventFireWindowAdvisory(
        `SELECT * FROM harness_shared.event_wake_attempts WHERE attempted_at > now() - interval '1 day'`,
      ),
    ).toBeNull();
  });

  /**
   * Same literal/comment discipline as the sibling: quoting the column inside a
   * comment must not manufacture a window question out of a plain latch read.
   */
  it('does not treat a timestamp comparison inside a comment as a predicate', () => {
    expect(
      buildEventFireWindowAdvisory(
        `SELECT event_key, fire_count FROM ${EKF}\n -- was: WHERE last_fired_at > now()\n`,
      ),
    ).toBeNull();
  });
});

/**
 * EI-21338326327553651 — the tenant-population cache must be keyed by the SCOPE the
 * verdict was computed for, not by the table alone.
 *
 * `probeTenantPopulation` answers a scope-relative question ("does THIS caller's
 * resolved workspace match at least one row"), but cached it under `table`. So for the
 * 60s TTL, the FIRST caller's verdict was replayed to every other scope. The reported
 * symptom is the dangerous direction: rows legitimately pinned to another workspace
 * (loop carry notes pin to DEFAULT_COORD_WORKSPACE) were advertised as matching the
 * ACTIVE workspace, so the advisory prescribed a predicate that matches nothing —
 * verify-before-prescribe silently degraded back into prescribe-without-verifying, which
 * is precisely what that machinery exists to prevent.
 *
 * The two calls below deliberately do NOT clear the cache between them: the second call
 * being served the first's verdict IS the bug. Keyed by table alone, call 2 inherits call
 * 1's `ws_hit: true` and prescribes; keyed by scope, it probes again and refutes.
 */
describe('EI-21338326327553651 — tenant population cache is scope-keyed, not table-keyed', () => {
  const ROWS = [
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'workspace_id' },
    { table_schema: 'harness_shared', table_name: 'harness_plans', column_name: 'plan_slug' },
  ];
  const QUERY = "SELECT * FROM harness_shared.harness_plans WHERE plan_slug = 'my-plan'";

  /** A client whose POPULATION probe answers differently per resolved workspace. */
  function popStub(hitFor: string) {
    const probedWorkspaces: string[] = [];
    const query = async (_strings: TemplateStringsArray, ..._values: unknown[]) => ROWS;
    const unsafe = async (text: string, params: string[] = []) => {
      if (/^\s*SET\b/i.test(text) || /\bset_config\s*\(/i.test(text)) return [];
      probedWorkspaces.push(params[0]!);
      return [{ has_rows: true, ws_hit: params[0] === hitFor, ws_vals: [hitFor] }];
    };
    const tx = Object.assign(query, { unsafe });
    const sql = Object.assign(query, {
      begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
    });
    return { sql: sql as never, probedWorkspaces };
  }

  beforeEach(() => clearTenantScopeSchemaCache());

  it('does not replay one workspace’s population verdict to a different workspace', async () => {
    // Call 1 — the scope that DOES match rows. Warms the cache with ws_hit:true.
    const a = popStub('default');
    const first = await buildTenantScopeAdvisory(QUERY, {
      client: a.sql,
      workspaceId: 'default',
    });
    expect(first, 'sanity: the matching scope should get a normal advisory').toBeTruthy();

    // Call 2 — SAME table, DIFFERENT resolved workspace, cache deliberately NOT cleared.
    // Its rows are all 'default', so prescribing 'papercusp-workspace' matches nothing
    // and the advisory must REFUTE, naming the value the rows actually carry.
    const b = popStub('default');
    const second = await buildTenantScopeAdvisory(QUERY, {
      client: b.sql,
      workspaceId: 'papercusp-workspace',
    });

    expect(
      b.probedWorkspaces,
      'the second scope must be PROBED, not served the first scope’s cached verdict',
    ).toContain('papercusp-workspace');
    expect(
      second,
      'the advisory must refute the prescription by naming the workspace the rows actually carry',
    ).toContain('default');
  });

  it('still caches WITHIN one scope — the fix must not turn the cache off', async () => {
    const c = popStub('default');
    await buildTenantScopeAdvisory(QUERY, { client: c.sql, workspaceId: 'default' });
    const afterFirst = c.probedWorkspaces.length;
    await buildTenantScopeAdvisory(QUERY, { client: c.sql, workspaceId: 'default' });
    expect(
      c.probedWorkspaces.length,
      'a repeat call in the SAME scope must be served from cache, not re-probed',
    ).toBe(afterFirst);
  });
});

describe('personalVaultRefusal — the Personal Vault fence (WI-10001796)', () => {
  it.each([
    ['message bodies', "SELECT subject, body_text FROM harness_shared.documents WHERE source='gmail'"],
    ['an aggregate count', 'SELECT count(*) FROM harness_shared.documents'],
    ['the bare, unqualified name', 'SELECT * FROM documents'],
    // Migration 1327 (WI-10005071) leaves a compat VIEW under the old name that
    // reads the same rows. Until the contract migration drops it, it is a second
    // way into the mailbox and must stay fenced.
    ['the compat view under the old name', "SELECT subject FROM harness_shared.personal_documents WHERE source='gmail'"],
    ['the old name, unqualified', 'SELECT * FROM personal_documents'],
    ['consent rows', 'SELECT * FROM harness_shared.personal_grants'],
    ['identities', 'SELECT * FROM harness_shared.personal_identities'],
    ['identity aliases', 'SELECT * FROM harness_shared.personal_identity_aliases'],
    ['sync state', 'SELECT * FROM harness_shared.personal_sync_state'],
    ['vault settings', 'SELECT * FROM harness_shared.personal_vault_settings'],
  ])('refuses a vault read: %s', (_label, sql) => {
    expect(personalVaultRefusal(sql)).toMatch(/Personal Vault/);
    expect(() => assertSingleReadStatement(sql)).toThrow(/Personal Vault/);
  });

  it('refuses a vault table sitting PAST the bounded extractor s join budget', () => {
    // This is why the fence does not reuse extractReferencedTables: that helper
    // stops at GUARD_MAX_TABLES references, so a vault table in the fifth join
    // position is invisible to it. The precondition below asserts the bypass
    // against the REAL extractor — if the extractor is ever made unbounded this
    // test fails loudly rather than silently ceasing to prove anything.
    const sql = `
      SELECT d.subject
        FROM harness_shared.work_items a
        JOIN harness_shared.harness_plans b ON true
        JOIN harness_shared.test_runs c ON true
        JOIN harness_shared.tool_invocations e ON true
        JOIN harness_shared.documents d ON true`;
    expect(
      extractReferencedTables(sql),
      'precondition: the bounded extractor must NOT see the vault table here',
    ).not.toContain('harness_shared.documents');
    expect(() => assertSingleReadStatement(sql)).toThrow(/Personal Vault/);
  });

  it('refuses a vault table in a set-operation arm and in a scalar subquery', () => {
    expect(() =>
      assertSingleReadStatement(
        'SELECT id FROM harness_shared.work_items UNION ALL SELECT id FROM harness_shared.documents',
      ),
    ).toThrow(/Personal Vault/);
    expect(() =>
      assertSingleReadStatement('SELECT (SELECT count(*) FROM harness_shared.personal_documents) AS n'),
    ).toThrow(/Personal Vault/);
  });

  it('names the relation it actually matched in the refusal, so the quoting hint is usable', () => {
    expect(personalVaultRefusal('SELECT count(*) FROM harness_shared.documents')).toContain(
      "harness_shared.documents holds Personal Vault data",
    );
    expect(personalVaultRefusal('SELECT count(*) FROM harness_shared.documents')).toContain("('documents')");
    expect(personalVaultRefusal('SELECT * FROM personal_grants')).toContain("('personal_grants')");
  });

  it('refuses a vault WRITE — forging a consent row is worse than reading one', () => {
    expect(() =>
      assertSingleWriteStatement(
        "INSERT INTO harness_shared.personal_grants (principal_id, scopes) VALUES ('operator', '{personal:mail}')",
      ),
    ).toThrow(/Personal Vault/);
  });

  // CALIBRATION. A fence that refused everything would pass every case above
  // while making the database unusable, so these cases are what make the ones
  // above mean something. Each must stay ALLOWED.
  it('allows schema/audit reads, where the vault name is a literal not a table', () => {
    expect(
      personalVaultRefusal(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'documents'",
      ),
      'auditing whether vault RLS actually bites is how this bug was found — fencing that would be self-defeating',
    ).toBeNull();
    expect(
      personalVaultRefusal("SELECT * FROM information_schema.columns WHERE table_name = 'personal_grants'"),
    ).toBeNull();
  });

  it('allows ordinary reads, and an identifier that merely starts with a vault name', () => {
    expect(personalVaultRefusal('SELECT * FROM harness_shared.work_items')).toBeNull();
    expect(
      personalVaultRefusal('SELECT personal_documents_id FROM harness_shared.some_table'),
      'the trailing word boundary must not fire on personal_documents_id',
    ).toBeNull();
    expect(
      personalVaultRefusal('SELECT documents_id FROM harness_shared.some_table'),
      'the trailing word boundary must not fire on documents_id',
    ).toBeNull();
    expect(
      personalVaultRefusal('SELECT * FROM harness_shared.plan_documents'),
      'the leading word boundary must not fire on a table that merely ends in documents',
    ).toBeNull();
  });
});

describe('personalVaultRefusal — organization-corpus access-control tables (P-014)', () => {
  it.each([
    ['permission lists', 'SELECT * FROM harness_shared.document_permission_lists'],
    ['permission members', 'SELECT provider_user_id FROM harness_shared.document_permission_members'],
    ['provider identity mappings', 'SELECT user_id FROM provider_identity_mappings'],
  ])('refuses a read of %s and names the authorized path', (_label, sql) => {
    expect(personalVaultRefusal(sql)).toMatch(/organization documents corpus/);
    expect(() => assertSingleReadStatement(sql)).toThrow(/searchOrganizationDocuments/);
  });

  it('refuses a WRITE that would forge access — mapping a provider identity to yourself', () => {
    expect(() =>
      assertSingleWriteStatement(
        "INSERT INTO harness_shared.provider_identity_mappings (workspace_id, provider, provider_user_id, user_id, mapped_by) VALUES ('w', 'slack', 'U1', gen_random_uuid(), 'me')",
      ),
    ).toThrow(/organization documents corpus/);
  });

  it('keeps the vault message when a statement touches both a vault and an org relation', () => {
    expect(
      personalVaultRefusal(
        'SELECT d.id FROM harness_shared.personal_documents d JOIN harness_shared.document_permission_members m ON m.list_id = d.permission_list_id',
      ),
    ).toMatch(/Personal Vault/);
  });

  // CALIBRATION — schema audits and look-alike identifiers stay allowed.
  it('allows schema reads that quote the name, and identifiers that only share a prefix', () => {
    expect(
      personalVaultRefusal("SELECT * FROM information_schema.columns WHERE table_name = 'provider_identity_mappings'"),
    ).toBeNull();
    expect(personalVaultRefusal('SELECT document_permission_lists_count FROM harness_shared.some_table')).toBeNull();
  });
});

describe('buildNonSummingPartitionAdvisory (WI-10002034 — the scalar whose buckets do not sum)', () => {
  // The measured case. This exact shape returned total 96 / bricked 0 / healthy 2,
  // which DOES NOT SUM: 94 rows fell through every FILTER, because an ABSENT jsonb
  // path is NULL and NULL fails every comparison, `<>` included.
  const MEASURED = [
    'SELECT count(*) AS total,',
    "       count(*) FILTER (WHERE control_state->'activation'->>'status' <> 'applied') AS bricked,",
    "       count(*) FILTER (WHERE control_state->'activation'->'applied'->>'specificationRevision'",
    "                            = control_state->'activation'->'desired'->>'specificationRevision') AS healthy",
    '  FROM harness_shared.session_briefs',
    " WHERE workspace_id = 'papercusp-workspace'",
  ].join('\n');

  it('fires on the measured non-summing census', () => {
    const advisory = buildNonSummingPartitionAdvisory(MEASURED);
    expect(advisory).toBeTruthy();
    expect(advisory).toContain('buckets may not sum');
    expect(advisory).toContain('harness_shared.session_briefs');
  });

  it("partitions by the caller's OWN bucket expressions, jsonb key preserved verbatim", () => {
    const advisory = buildNonSummingPartitionAdvisory(MEASURED)!;
    // A stripped copy of the SQL would have ERASED the jsonb key, because the key
    // IS a string literal. That is the whole reason the parse runs on an
    // index-preserving mask while the emitted text is sliced from the raw SQL.
    expect(advisory).toContain("(control_state->'activation'->>'status' <> 'applied') AS d1");
    expect(advisory).toContain('count(*) AS row_count');
    expect(advisory).toContain('GROUP BY 1, 2');
  });

  it("carries the query's tenant scope into the partition instead of making it a dimension", () => {
    const advisory = buildNonSummingPartitionAdvisory(MEASURED)!;
    // Partitioning BY the tenant would change the question AND leave the suggested
    // query unscoped, which dev:pg_query itself refuses with tenant_scope_required.
    // The shared scope sits at depth 0 and LATER than the FILTER buckets' own
    // `WHERE`s, so this also pins the shallowest-WHERE selection rule.
    expect(advisory).toContain("WHERE workspace_id = 'papercusp-workspace'");
    expect(advisory).not.toContain("(workspace_id = 'papercusp-workspace') AS d");
  });

  it('fires on an EXISTS whose predicate sits one paren deep, without a stray paren', () => {
    const advisory = buildNonSummingPartitionAdvisory(
      "SELECT EXISTS (SELECT 1 FROM harness_shared.work_items WHERE payload->>'lane' <> 'observation')",
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain("(payload->>'lane' <> 'observation') AS d1");
    expect(advisory, 'the subquery close paren must not ride along into the dimension').not.toContain(
      "'observation')) AS d1",
    );
  });

  it('stays silent on a row-returning query with a correlated EXISTS projection', () => {
    const existsProjection = [
      'EXISTS (',
      '  SELECT 1 FROM harness_shared.documents d',
      '   WHERE d.workspace_id = s.workspace_id',
      "     AND d.source_kind <> 'calendar'",
      "     AND d.storage_state <> 'missing'",
      ') AS has_local_documents',
    ].join('\n       ');
    const sql = [
      'SELECT s.kind, s.provider,',
      `       ${existsProjection}`,
      '  FROM harness_shared.data_sources s',
    ].join('\n');
    const singleColumnRowRead = [
      'SELECT',
      `       ${existsProjection}`,
      '  FROM harness_shared.data_sources s',
    ].join('\n');

    // EXISTS in a projection does not make the outer query scalar. The old
    // query-wide token check treated the correlated subquery's WHERE as the
    // population and generated partition SQL over documents with an unbound s.
    for (const rowRead of [sql, singleColumnRowRead]) {
      expect(planPredicatePartition(rowRead)).toBeNull();
      expect(buildNonSummingPartitionAdvisory(rowRead)).toBeNull();
    }
  });

  it('fires on two independent non-jsonb dimensions', () => {
    expect(
      buildNonSummingPartitionAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE status <> 'done' AND assignee <> 'me'",
      ),
    ).toBeTruthy();
  });

  it('is not steered by an AND or a paren inside a string literal', () => {
    const advisory = buildNonSummingPartitionAdvisory(
      "SELECT count(*) FROM harness_shared.work_items WHERE title <> 'a and b (c)' AND status <> 'done'",
    );
    expect(advisory).toBeTruthy();
    expect(advisory).toContain("(title <> 'a and b (c)') AS d1");
    expect(advisory).toContain("(status <> 'done') AS d2");
  });

  it('caps the emitted partition at three dimensions so the advisory stays readable', () => {
    const advisory = buildNonSummingPartitionAdvisory(
      'SELECT count(*) FROM harness_shared.work_items ' +
        "WHERE a <> '1' AND b <> '2' AND c <> '3' AND d <> '4'",
    )!;
    expect(advisory).toContain('AS d3');
    expect(advisory).not.toContain('AS d4');
  });

  it('stays silent on a row-returning window COUNT over a LATERAL table function', () => {
    const rowReturning = [
      'SELECT t AS title, count(*) OVER () AS n_titles',
      "  FROM harness_shared.test_runs r, jsonb_array_elements_text(r.execution_details->'passedCaseTitles') t",
      " WHERE r.id = 20924107 AND r.workspace_id = 'papercusp-workspace' AND (t ILIKE '%stable source key%' OR t ILIKE '%does not file when the author published%')",
    ].join('\n');

    expect(planPredicatePartition(rowReturning)).toBeNull();
    expect(buildNonSummingPartitionAdvisory(rowReturning)).toBeNull();
  });

  it('preserves source aliases and LATERAL rows in every generated partition query', () => {
    const sql = [
      "SELECT count(*) FILTER (WHERE t ILIKE '%stable source key%') AS matching,",
      '       count(*) FILTER (WHERE t IS NULL) AS missing',
      '  FROM harness_shared.test_runs r,',
      "       LATERAL jsonb_array_elements_text(r.execution_details->'passedCaseTitles') t",
      " WHERE r.workspace_id = 'papercusp-workspace'",
    ].join('\n');
    const plan = planPredicatePartition(sql)!;
    const source =
      "FROM harness_shared.test_runs r,\n       LATERAL jsonb_array_elements_text(r.execution_details->'passedCaseTitles') t";
    const generated = [
      predicatePartitionSql(plan),
      predicatePartitionTotalSql(plan),
      predicatePartitionSampleSql(plan),
      buildNonSummingPartitionAdvisory(sql)!,
    ];

    expect(plan.relation).toBe('harness_shared.test_runs');
    for (const statement of generated) {
      expect(statement).toContain(source);
      expect(statement).toContain('r.execution_details->');
    }
  });

  // ---- controls: the shapes that MUST stay silent. A detector that fires on a
  // correct census is what trains callers to skim past the whole advisory seam.

  it('stays silent when the caller already partitioned', () => {
    expect(
      buildNonSummingPartitionAdvisory(
        "SELECT status, count(*) FROM harness_shared.work_items WHERE payload->>'lane' <> 'x' GROUP BY 1",
      ),
      'a GROUP BY already puts every cell on screen, so nothing is hidden',
    ).toBeNull();
  });

  it('stays silent on a single non-jsonb dimension', () => {
    expect(
      buildNonSummingPartitionAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE status = 'open'",
      ),
      'one plain column cannot hide a fall-through worth a full partition',
    ).toBeNull();
  });

  it('keeps shape checks linear for large dollar-quoted projections', () => {
    // The partition detector masks string bodies with spaces before checking
    // whether a projection is a scalar EXISTS. An end-anchored alias regex
    // used to backtrack across those spaces quadratically, so this otherwise
    // ordinary 32 KB read spent seconds in preflight and hit dev:pg_query's
    // default whole-call deadline.
    const literal = 'x'.repeat(31_799);
    const sql =
      `SELECT encode(sha256(convert_to($qx7zk$${literal}$qx7zk$,'UTF8')),'hex') AS h, ` +
      `octet_length($qx7zk$${literal}$qx7zk$) AS n`;
    const started = performance.now();
    expect(buildNonSummingPartitionAdvisory(sql)).toBeNull();
    const PARTITION_SHAPE_BUDGET_MS = 500;
    expect(performance.now() - started).toBeLessThan(PARTITION_SHAPE_BUDGET_MS);
  });

  it('stays silent when the query scopes but never discriminates', () => {
    expect(
      buildNonSummingPartitionAdvisory(
        "SELECT count(*) FROM harness_shared.work_items WHERE workspace_id = 'papercusp-workspace'",
      ),
    ).toBeNull();
  });

  it('stays silent on a non-aggregate row read', () => {
    expect(
      buildNonSummingPartitionAdvisory(
        "SELECT id FROM harness_shared.work_items WHERE payload->>'lane' <> 'x' AND status = 'open'",
      ),
      'a row read shows its own rows; only a SCALAR can hide the fall-through',
    ).toBeNull();
  });
});

describe('the EXECUTED partition probe (WI-10002034 — AUTO-BAR-R-002-P-002)', () => {
  // The ratified acceptance bar names the falsifier directly: "A qualifying count
  // returns the scalar alone, with no partition, no NULL counts and no sample
  // rows." Emitting the partition SQL as TEXT does not satisfy it — these cases
  // pin the half that actually RUNS those statements and returns their results.
  const MEASURED = [
    'SELECT count(*) AS total,',
    "       count(*) FILTER (WHERE control_state->'activation'->>'status' <> 'applied') AS bricked",
    '  FROM harness_shared.session_briefs',
    " WHERE workspace_id = 'papercusp-workspace'",
  ].join('\n');

  type ProbeClient = NonNullable<Parameters<typeof executePredicatePartition>[1]>['client'];
  type FakeRow = Record<string, unknown>;

  /**
   * boundedPgReadTxn calls `sql.begin(cb)`, and INSIDE the transaction issues
   * `tx.unsafe('SET TRANSACTION READ ONLY')`, a tagged-template `set_config`,
   * and `tx.unsafe(SET_LOCAL_UTC)` before the callback ever runs.
   * EI-21372563569490957: doubles that model only a tag function fail with
   * `sql.begin is not a function`, so this one models begin, the tag AND unsafe.
   * The SET preamble is swallowed rather than routed so `ran` holds exactly the
   * probe's own statements — which is what makes the no-probe case below
   * assertable instead of merely plausible.
   */
  function fakeClient(route: (sql: string) => FakeRow[]): { client: ProbeClient; ran: string[] } {
    const ran: string[] = [];
    const tx = Object.assign((..._args: unknown[]) => Promise.resolve([] as FakeRow[]), {
      unsafe: (text: string) => {
        if (/^\s*SET\b/i.test(text)) return Promise.resolve([] as FakeRow[]);
        ran.push(text);
        return Promise.resolve(route(text));
      },
    });
    const sql = Object.assign((..._args: unknown[]) => Promise.resolve([] as FakeRow[]), {
      begin: (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    });
    return { client: sql as unknown as ProbeClient, ran };
  }

  /** Dispatch on each statement's OWN alias, so a mis-routed probe is visible. */
  const route =
    (parts: { cells?: FakeRow[]; total?: FakeRow[]; samples?: FakeRow[] }) =>
    (text: string): FakeRow[] => {
      if (/AS row_count/i.test(text)) return parts.cells ?? [];
      if (/AS total/i.test(text)) return parts.total ?? [];
      return parts.samples ?? [];
    };

  it('asks for the UNFILTERED total under the same scope — never the caller’s FILTERs', () => {
    const plan = planPredicatePartition(MEASURED)!;
    const sql = predicatePartitionTotalSql(plan);
    expect(sql).toContain('count(*) AS total');
    expect(sql).toContain('FROM harness_shared.session_briefs');
    expect(sql).toContain("WHERE workspace_id = 'papercusp-workspace'");
    // A total that inherited a bucket FILTER cannot be the denominator the cells
    // must sum to — and that arithmetic is the entire point of the advisory.
    expect(sql, 'the denominator must not inherit a bucket predicate').not.toContain('FILTER');
  });

  it('returns cells, per-dimension NULL rows and sample rows ALONGSIDE the scalar', async () => {
    const { client } = fakeClient(
      route({
        // The measured shape: 2 healthy, 94 fell through every FILTER because an
        // absent jsonb path is NULL and NULL fails every comparison.
        cells: [
          { d1: true, row_count: 2 },
          { d1: null, row_count: 94 },
        ],
        total: [{ total: 96 }],
        samples: [{ sample: 'brief-a' }, { sample: 'brief-b' }],
      }),
    );
    const advisory = (await buildExecutedPartitionAdvisory(MEASURED, { client }))!;
    expect(advisory).toContain('PARTITION (d1 → rows)');
    expect(advisory).toContain('NULL → 94');
    expect(advisory).toContain('PER-DIMENSION NULL ROWS: d1=94');
    expect(advisory).toContain('PARTITION TOTAL: 96 of 96');
    expect(advisory).toContain('FALL-THROUGH SAMPLE (2 row(s))');
    expect(advisory).toContain('brief-a');
  });

  it('FAILS OPEN to the statements when the probe cannot run — never to an empty partition', async () => {
    const { client } = fakeClient(() => {
      throw new Error('relation "harness_shared.session_briefs" does not exist');
    });
    const advisory = (await buildExecutedPartitionAdvisory(MEASURED, { client }))!;
    // Byte-identical to the statements-only rendering: a probe that could not run
    // must degrade to homework, NOT to a rendering that reports no fall-through.
    expect(advisory).toBe(buildNonSummingPartitionAdvisory(MEASURED));
    expect(advisory).toContain('buckets may not sum');
    expect(advisory).not.toContain('PARTITION (d1');
  });

  it('an empty partition reads as UNMEASURED — textually distinct from a failed probe', async () => {
    const { client } = fakeClient(route({ cells: [], total: [{ total: 0 }], samples: [] }));
    const advisory = (await buildExecutedPartitionAdvisory(MEASURED, { client }))!;
    // "no cells" and "the probe never ran" mean opposite things. Collapsing them
    // reintroduces, through this fix, the exact false negative it exists to stop.
    expect(advisory).toContain('UNMEASURED');
    expect(advisory).not.toBe(buildNonSummingPartitionAdvisory(MEASURED));
  });

  it('reports TRUNCATED past the cap and renders no more than the cap', async () => {
    const overCap = Array.from({ length: PREDICATE_PARTITION_CELL_LIMIT + 1 }, (_, i) => ({
      d1: `v${i}`,
      row_count: 1,
    }));
    const { client } = fakeClient(route({ cells: overCap, total: [{ total: 999 }], samples: [] }));
    const data = (await executePredicatePartition(planPredicatePartition(MEASURED)!, { client }))!;
    expect(data.truncated).toBe(true);
    expect(data.cells).toHaveLength(PREDICATE_PARTITION_CELL_LIMIT);
  });

  it('a partition sitting exactly ON the cap is exhaustive, not truncated', async () => {
    // The cellLimit + 1 fetch exists for this boundary: reporting an exhaustive
    // partition as truncated makes the sum check unsatisfiable, and reporting a
    // truncated one as exhaustive makes it silently wrong.
    const { client } = fakeClient(
      route({
        cells: [
          { d1: 'a', row_count: 1 },
          { d1: 'b', row_count: 2 },
        ],
        total: [{ total: 3 }],
        samples: [],
      }),
    );
    const data = (await executePredicatePartition(planPredicatePartition(MEASURED)!, {
      client,
      cellLimit: 2,
    }))!;
    expect(data.truncated).toBeUndefined();
    expect(data.cells).toHaveLength(2);
  });

  it('leaves a non-qualifying read alone — no advisory, and no probe paid for', async () => {
    const { client, ran } = fakeClient(route({}));
    const advisory = await buildExecutedPartitionAdvisory(
      "SELECT id, title FROM harness_shared.work_items WHERE workspace_id = 'papercusp-workspace' LIMIT 5",
      { client },
    );
    expect(advisory).toBeNull();
    expect(ran, 'the narrow-reads-unchanged boundary must cost a narrow read nothing').toHaveLength(
      0,
    );
  });

  /**
   * FALSIFIABILITY (R-002). Every assertion above watches a CORRECT
   * implementation render the preview, which cannot show the suite would go RED
   * against a wrong one — a guard that has never failed is a guard nobody has
   * tested. R-002's falsifier names the wrong behaviour exactly: "a qualifying
   * count returns the scalar alone, with no partition, no NULL counts and no
   * sample rows". So the check is factored into a PURE detector and pointed at a
   * deliberately-wrong, permanently-resident scalar-only control. The control is
   * ordinary data, so nothing is ever written to the shared tree (no temp file,
   * no sweep race).
   */
  const REQUIRED_PREVIEW_PARTS = [
    { id: 'partition', probe: /PARTITION \(/ },
    { id: 'null-counts', probe: /PER-DIMENSION NULL ROWS:/ },
    { id: 'samples', probe: /FALL-THROUGH SAMPLE \(/ },
  ] as const;

  function missingPreviewParts(advisory: string | null | undefined): string[] {
    const text = advisory ?? '';
    return REQUIRED_PREVIEW_PARTS.filter((part) => !part.probe.test(text)).map((part) => part.id);
  }

  it('calibration — the REAL advisory for a qualifying read is missing NO preview part', async () => {
    const { client } = fakeClient(
      route({
        cells: [
          { d1: true, row_count: 2 },
          { d1: null, row_count: 94 },
        ],
        total: [{ total: 96 }],
        samples: [{ sample: 'brief-a' }],
      }),
    );
    const advisory = await buildExecutedPartitionAdvisory(MEASURED, { client });
    // Calibration guard: an empty rendering would make BOTH this case and the
    // CONTROL below pass for the wrong reason — the detector would be reporting
    // on nothing at all.
    expect(advisory, 'calibration needs a real rendering, not an empty advisory').toBeTruthy();
    expect(missingPreviewParts(advisory)).toEqual([]);
  });

  it('CONTROL — a scalar-only rendering is CAUGHT (this is what makes R-002 falsifiable)', () => {
    // Verbatim the falsifier's wrong behaviour: the scalar, and nothing beside it.
    const scalarOnly = 'count: 96';
    // Guard the guard: if this fixture ever stopped looking like a real scalar
    // rendering, the control would pass VACUOUSLY — a green that proves nothing,
    // which is the exact failure a control exists to rule out.
    expect(scalarOnly, 'the control must carry the scalar it is accused of returning alone').toMatch(
      /\d/,
    );
    expect(
      missingPreviewParts(scalarOnly),
      'the detector must FLAG every absent preview part, not tolerate a bare scalar',
    ).toEqual(['partition', 'null-counts', 'samples']);
  });
});

describe('AUTO-BAR-R-003-P-002 — the preview rides the EXISTING advisory channel', () => {
  /**
   * R-003's falsifier: "a new tool, verb, table or configuration key must be
   * added or configured before the preview appears." The clause is satisfied
   * today because the partition preview is bound to a LOCAL and merged into the
   * same `advisory` payload that already carries the tenant-scope warning — it
   * never becomes a result key of its own. A fork that attached it to a new
   * top-level key is precisely the falsifier, so that is the control.
   *
   * The detector takes the source as DATA rather than scanning the tree, so the
   * fixture cannot SELF-MATCH the way a tree-scanning guard does (the trap the
   * R-001 control below documents, and the same family as `pgrep -f` matching
   * its own argv).
   */
  const DECLARED_RESULT_KEYS = [
    'mode',
    'rowCount',
    'truncated',
    'fields',
    'elapsedMs',
    'rows',
    'advisory',
    'positiveControl',
    'absence',
  ];
  const PREVIEW_VALUE = /(?:build)?[eE]xecutedPartitionAdvisory/;

  /** Object-literal keys whose value is the partition preview. */
  function previewResultKeys(source: string): string[] {
    const keyed = /(\w+)\s*:\s*[^,\n}]*(?:build)?[eE]xecutedPartitionAdvisory/g;
    const found = new Set<string>();
    for (const match of source.matchAll(keyed)) found.add(match[1]);
    return [...found].sort();
  }

  function undeclaredPreviewKeys(source: string): string[] {
    return previewResultKeys(source).filter((key) => !DECLARED_RESULT_KEYS.includes(key));
  }

  const callerSource = (): string =>
    readFileSync(
      join(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
        'packages/operator-core/lib/agent-tools/dev/pg_query.ts',
      ),
      'utf8',
    );

  it('calibration — the real caller introduces NO new result key for the preview', () => {
    const source = callerSource();
    // Positive control: an absence claim is only meaningful if the detector was
    // actually pointed at the partition code. A source that never mentions the
    // builder would yield [] for the wrong reason.
    expect(
      PREVIEW_VALUE.test(source),
      'the caller must actually reach the partition advisory for this to measure anything',
    ).toBe(true);
    expect(undeclaredPreviewKeys(source)).toEqual([]);
  });

  it('CONTROL — a new top-level result key is CAUGHT (this is what makes R-003 falsifiable)', () => {
    const forked = [
      'return {',
      '  mode,',
      '  rows,',
      '  advisory: tenantScopeAdvisory,',
      '  // Deliberately wrong: a NEW result key, so the preview only reaches the',
      '  // agent once the caller adds a surface that did not exist before.',
      '  partitionPreview: executedPartitionAdvisory,',
      '};',
    ].join('\n');
    // Guard the guard: the fixture must genuinely be key-shaped, or the control
    // would feed the detector something it cannot match and pass VACUOUSLY.
    expect(
      previewResultKeys(forked),
      'the forked fixture must genuinely attach the preview to a result key',
    ).toContain('partitionPreview');
    expect(
      undeclaredPreviewKeys(forked),
      'the detector must FLAG a brand-new delivery key, not tolerate it',
    ).toEqual(['partitionPreview']);
  });
});

describe('AUTO-BAR-R-001-P-002 — ONE partition primitive, never two implementations (D-001)', () => {
  /**
   * D-001 ratifies ONE predicate-preview primitive with two callers, and calls a
   * second implementation "a defect against this plan, not a convenience".
   * R-001's falsifier has two disjuncts: (a) two call sites produce different
   * partitions for the same predicate, or (b) the partition computation appears
   * in more than one module.
   *
   * (b) is the disjunct that rots silently. The second caller (claim-spec
   * authoring) does not exist yet, and when it arrives, forking the computation
   * will be markedly easier than importing it — so it gets a mechanical guard
   * now, while there is still exactly one implementation to pin.
   *
   * FALSIFIABILITY — this is what the CONTROL case is for. A detector that never
   * fires is indistinguishable from a tree that genuinely has no fork, so a
   * passing calibration proves nothing on its own. A deliberately FORKED module
   * is therefore kept PERMANENTLY below and fed to the SAME detector, which must
   * catch it. The real tree is never mutated to prove this: per CLAUDE.md
   * "Proving a guard is falsifiable", git-sync sweeps the whole tree on a timer
   * and can commit a mutant left behind by a probe that dies mid-run.
   */
  const PARTITION_DEFINITION =
    /export\s+(?:async\s+)?function\s+(?:plan|execute|render)PredicatePartition\b/;

  /**
   * Pure + injectable, so the forked control is ordinary data and never a temp file.
   *
   * SELF-MATCH DEFENCE (EI-23769743489199449). The SUBJECT of this scan is the source
   * tree, and this test file is IN that tree — so any fixture, error message or comment
   * here that spells the detection token becomes a phantom second implementation, and the
   * guard goes red forever on a fork that does not exist. That is the PHANTOM-OFFENDER
   * class `guard-string-literal-blindness.test.ts` exists to prevent, and the shared
   * stripper is its prescribed cure: blank comments and string literals before matching,
   * so only REAL top-level code can satisfy the detector. Reused rather than re-solved —
   * the earlier hand-rolled fix here split the keyword (`'export ' + 'function '`) to keep
   * the source unmatchable, which worked but silently obliged every future author to
   * remember the trick.
   *
   * Safe for THIS detector specifically: a genuine `export function planPredicatePartition`
   * never appears inside a string literal, so stripping cannot turn a true positive into a
   * silent false negative. That is the caveat the shared stripper's own docs raise — it is
   * why a `DROP DATABASE` detector must NOT strip strings, since in TS source those words
   * occur only inside a SQL template literal. The split is per call site, not per guard.
   */
  function modulesDefiningPartition(
    files: ReadonlyArray<{ path: string; source: string }>,
  ): string[] {
    return files
      .filter((file) =>
        PARTITION_DEFINITION.test(stripCommentsAndStrings(file.source, file.path)),
      )
      .map((file) => file.path)
      .sort();
  }

  function repoRoot(): string {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  }

  /**
   * Candidate prefilter. Reading all ~12.7k operator-core TS files would make this
   * a slow test for no gain: any module DEFINING one of these functions must also
   * contain the literal `PredicatePartition`, so grepping that string cannot miss
   * a fork — it only shrinks the set actually parsed. Scope is the superproject
   * (submodules are not searched); operator-core lives here, so that is the right
   * radius for this claim.
   */
  function candidateFiles(): Array<{ path: string; source: string }> {
    const root = repoRoot();
    const listed = execFileSync(
      'git',
      ['grep', '-l', '--untracked', 'PredicatePartition', '--', '*.ts'],
      { encoding: 'utf8', cwd: root },
    )
      .split('\n')
      .filter(Boolean);
    // Positive control on the INSTRUMENT: if git grep silently searched the wrong
    // tree or returned nothing, every assertion below would pass vacuously — which
    // reads exactly like "no fork exists". Fail loudly instead.
    expect(
      listed,
      'instrument check: git grep must at least find the primitive it is auditing',
    ).toContain('packages/operator-core/lib/pg-read-query.ts');
    return listed.map((path) => ({ path, source: readFileSync(join(root, path), 'utf8') }));
  }

  it('calibration — the real tree defines the partition computation in exactly ONE module', () => {
    expect(modulesDefiningPartition(candidateFiles())).toEqual([
      'packages/operator-core/lib/pg-read-query.ts',
    ]);
  });

  it('CONTROL — a forked second implementation is CAUGHT (this is what makes the guard falsifiable)', () => {
    // This fixture's own source lives INSIDE the tree the detector scans. It is spelled
    // plainly on purpose: `modulesDefiningPartition` blanks string literals before
    // matching, so a fixture can now look EXACTLY like the fork it stands in for without
    // minting a phantom offender. (The self-match defence itself is proven load-bearing by
    // the dedicated test below, not merely assumed here.)
    const forked = {
      path: 'packages/operator-core/lib/claim-spec/partition-preview.ts',
      source: [
        '// Deliberately wrong, and deliberately permanent: a second caller that',
        '// re-derives the partition instead of importing the shared primitive.',
        'export function planPredicatePartition(rawSql: string) {',
        '  return rawSql.includes("WHERE") ? { dimensions: [] } : null;',
        '}',
      ].join('\n'),
    };
    // Guard the guard: if the fixture ever stops being fork-shaped, this control would
    // feed the detector something it cannot match and pass VACUOUSLY — a green that proves
    // nothing, which is the exact failure the control exists to rule out. Asserted through
    // the SAME lens the detector uses (stripped), or this check could disagree with it.
    expect(
      PARTITION_DEFINITION.test(stripCommentsAndStrings(forked.source, forked.path)),
      'the forked fixture must genuinely look like a second implementation',
    ).toBe(true);
    const defining = modulesDefiningPartition([...candidateFiles(), forked]);
    expect(
      defining,
      'the detector must FLAG a second implementation, not tolerate it',
    ).toContain(forked.path);
    expect(defining).toHaveLength(2);
  });

  /**
   * The recurrence guard for EI-23769743489199449 itself. The calibration above would also
   * catch a regression here, but only as a confusing "2 defining modules" failure naming
   * this very file — the symptom that already cost one debugging cycle. This names the
   * cause directly.
   */
  it('SELF-MATCH DEFENCE — this test file is scanned but never reported as a fork', () => {
    const selfPath = 'packages/operator-core/lib/pg-read-query.test.ts';
    const self = {
      path: selfPath,
      source: readFileSync(join(repoRoot(), selfPath), 'utf8'),
    };

    // This file IS in the scanned population (candidateFiles greps the whole tree for
    // `PredicatePartition`, which this file is full of), so the detector must look at it
    // and still decline to call it an implementation.
    expect(
      modulesDefiningPartition([self]),
      'the guard must not report its own fixtures as a second implementation',
    ).toEqual([]);

    // FALSIFIABILITY of the defence — kept permanently, because the assertion above passes
    // for TWO very different reasons: the stripping works, or this file no longer contains
    // the token at all. Only the first is the property we mean. So the PRE-FIX detector
    // (match the RAW source, no stripping) is preserved inline and asserted to reach the
    // WRONG verdict on the same input, which is what proves the defence is doing real work
    // rather than guarding a case that no longer exists.
    const legacyModulesDefiningPartition = (
      files: ReadonlyArray<{ path: string; source: string }>,
    ): string[] => files.filter((f) => PARTITION_DEFINITION.test(f.source)).map((f) => f.path);

    expect(
      legacyModulesDefiningPartition([self]),
      'the pre-fix detector must still self-match this file — otherwise the defence above ' +
        'is guarding an empty case and this control has stopped discriminating',
    ).toEqual([selfPath]);
  });

  it('the dev:pg_query caller reaches the partition ONLY through the shared primitive', () => {
    const caller = readFileSync(
      join(repoRoot(), 'packages/operator-core/lib/agent-tools/dev/pg_query.ts'),
      'utf8',
    );
    expect(
      PARTITION_DEFINITION.test(caller),
      'the caller must import the primitive, never re-derive it',
    ).toBe(false);
    expect(caller).toMatch(/buildExecutedPartitionAdvisory/);
  });
});

describe('extractReferencedTables — `FROM` that is not a clause (WI-10002041)', () => {
  // Reported by a peer against the partition advisory: the FROM inside
  // `IS DISTINCT FROM <col>` was read as a FROM clause, so tables[0] became a
  // COLUMN and planPredicatePartition rendered `FROM <column-name>` — SQL that
  // cannot run. The defect is in the SHARED extractor, not the partition code,
  // so it is fixed there (every consumer benefits) and asserted here as a CLASS
  // rather than only the one reported spelling.
  const REAL = 'harness_shared.work_items';

  it.each([
    ['IS DISTINCT FROM', `SELECT count(*) FROM ${REAL} WHERE a IS DISTINCT FROM b`],
    ['IS NOT DISTINCT FROM', `SELECT count(*) FROM ${REAL} WHERE a IS NOT DISTINCT FROM b`],
    ['EXTRACT', `SELECT EXTRACT(epoch FROM created_ts) FROM ${REAL}`],
    ['SUBSTRING', `SELECT SUBSTRING(title FROM 1 FOR 4) FROM ${REAL}`],
    ['TRIM', `SELECT TRIM(BOTH 'x' FROM title) FROM ${REAL}`],
    ['OVERLAY', `SELECT OVERLAY(title PLACING 'z' FROM 2) FROM ${REAL}`],
  ])('%s contributes no phantom relation', (_label, sql) => {
    expect(extractReferencedTables(sql)).toEqual([REAL]);
  });

  // Over-correction guard: `DISTINCT` also appears in perfectly ordinary
  // positions, and a fix that suppressed those would silently blind every
  // tenant/scope advisory that depends on this extractor.
  it('does NOT over-correct — ordinary DISTINCT still yields the real relation', () => {
    expect(extractReferencedTables(`SELECT DISTINCT title FROM ${REAL}`)).toEqual([REAL]);
    expect(extractReferencedTables(`SELECT count(DISTINCT title) FROM ${REAL}`)).toEqual([REAL]);
    expect(extractReferencedTables(`SELECT DISTINCT ON (kind) kind FROM ${REAL}`)).toEqual([REAL]);
  });

  it('the partition advisory names the RELATION, never a column (the reported symptom)', () => {
    const plan = planPredicatePartition(
      `SELECT count(*) FROM ${REAL} WHERE status IS DISTINCT FROM 'open' AND item_kind = 'bug'`,
    );
    expect(plan, 'this read qualifies for a partition, so a null plan means the test is vacuous')
      .not.toBeNull();
    expect(plan!.relation).toBe(REAL);
  });
});
