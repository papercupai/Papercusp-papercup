/**
 * dev:pg_query handler wiring — the P-005 point-of-use guards ride the payload:
 * the tenant-scope ADVISORY on a successful read, and the referenced tables'
 * canonical column lists (knownColumns) on a 42703. The guard machinery itself
 * is unit-tested in pg-read-query.test.ts; this pins the handler contract —
 * where the fields land and that a guard failure never breaks the result.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { z } from 'zod';

const {
  pgReadQueryMock,
  advisoryMock,
  jsonTextSearchAdvisoryMock,
  describeColumnsMock,
  describeRelationMock,
  listRelationsMock,
} = vi.hoisted(() => ({
  pgReadQueryMock: vi.fn(),
  advisoryMock: vi.fn(),
  jsonTextSearchAdvisoryMock: vi.fn(),
  describeColumnsMock: vi.fn(),
  describeRelationMock: vi.fn(),
  listRelationsMock: vi.fn(),
}));

vi.mock('../../pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pgReadQuery: pgReadQueryMock,
  buildTenantScopeAdvisory: advisoryMock,
  buildJsonTextSearchAdvisory: jsonTextSearchAdvisoryMock,
  describeReferencedTableColumns: describeColumnsMock,
  describeRelation: describeRelationMock,
  listRelations: listRelationsMock,
}));

import pgQueryTool, { PG_QUERY_MAX_RESPONSE_BYTES, PG_QUERY_MODE } from './pg_query';
import { PG_READ_QUERY_CALL_OVERHEAD_MS, PgReadQueryTimeoutError } from '../../pg-read-query';
// EI-21596258009994255: the refusal text a caller actually reads is RENDERED by
// formatIssues, which resolves an `invalid_union` down to the closest branch's own
// sub-issues. Asserting the schema merely *carries* a message would pass while the
// caller still saw Zod's generic line, so the assertions below render it.
import { formatIssues } from '@papercusp/tooldef';

const OK_RESULT = { rowCount: 1, truncated: false, fields: ['x'], elapsedMs: 3, rows: [{ x: 1 }] };

function payloadOf(res: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

async function runUntilCallDeadline<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = work();
    await vi.advanceTimersByTimeAsync(timeoutMs + PG_READ_QUERY_CALL_OVERHEAD_MS + 1);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  pgReadQueryMock.mockReset().mockResolvedValue(OK_RESULT);
  advisoryMock.mockReset().mockResolvedValue(null);
  jsonTextSearchAdvisoryMock.mockReset().mockReturnValue(null);
  describeColumnsMock.mockReset().mockResolvedValue([]);
  describeRelationMock.mockReset().mockResolvedValue(null);
  listRelationsMock.mockReset().mockResolvedValue([]);
});

describe('dev:pg_query — P-005 guard wiring', () => {
  it('bounds default advisory prose and restores it only for an explicit full request', async () => {
    const advisory = '⚠ tenant scope: ' + '界'.repeat(4000);
    advisoryMock.mockResolvedValue(advisory);
    const args = { sql: 'SELECT 1', allowUnscoped: true } as never;
    const compact = payloadOf(await pgQueryTool.handler(args, {} as never) as never);
    expect(compact).toMatchObject(OK_RESULT);
    expect(String(compact.advisory)).toContain('TRUNCATED');
    expect(String(compact.advisory)).toContain("name:'dev:pg_query'");
    expect(String(compact.advisory)).toContain("payloadTier:'full'");
    expect(Buffer.byteLength(String(compact.advisory), 'utf8')).toBeLessThanOrEqual(4096);

    const full = payloadOf(await pgQueryTool.handler(args, { payloadTierOverride: 'full' } as never) as never);
    expect(full.advisory).toBe(advisory);
    const projected = payloadOf(await pgQueryTool.handler(args, {
      payloadTierOverride: 'full', sourceMaterialization: { promotedToFull: true },
    } as never) as never);
    expect(projected.advisory).toBe(compact.advisory);
  });

  it('bounds error advisories while retaining the database error and its recovery', async () => {
    const advisory = '⚠ scan: ' + 'x'.repeat(5000);
    jsonTextSearchAdvisoryMock.mockReturnValue(advisory);
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    const args = { sql: 'SELECT 1', allowUnboundedJsonSearch: true } as never;
    const compactResult = await pgQueryTool.handler(args, {} as never);
    expect(compactResult).toHaveProperty('isError', true);
    const compact = payloadOf(compactResult as never);
    expect(compact).toMatchObject({ error: 'syntax error', code: '42601' });
    expect(String(compact.advisory)).toContain('TRUNCATED');
    expect(String(compact.advisory).length).toBeLessThanOrEqual(1024);
    const full = payloadOf(await pgQueryTool.handler(args, { payloadTierOverride: 'full' } as never) as never);
    expect(full.advisory).toBe(advisory);
  });

  it('adds a first-response correction for an ungrouped scalar in a PostgreSQL 42803 aggregate error', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(
        new Error('column s.payload must appear in the GROUP BY clause or be used in an aggregate function'),
        { code: '42803' },
      ),
    );

    const payload = payloadOf(await pgQueryTool.handler({
      sql: 'SELECT s.payload, bool_or(s.ok) FROM probe s',
      allowUnscoped: true,
    } as never, {} as never) as never);

    expect(payload).toMatchObject({
      error: 'column s.payload must appear in the GROUP BY clause or be used in an aggregate function',
      code: '42803',
      hint: expect.stringContaining('move the aggregate into a subquery/CTE'),
    });
    expect(String(payload.hint)).toContain('GROUP BY');
    expect(String(payload.hint)).toContain('scalar payload fields outside the aggregate');
  });

  // EI-21924434989535557: an acceptance-rubric grader launches as role `judge` and
  // needs this READ-ONLY query surface (read-only txn, row cap, statement timeout —
  // no write path) to RE-MEASURE a criterion instead of quoting the implementer's
  // recorded figures. Fixed in commit a1be76b; this is the regression guard that
  // fix previously lacked — nothing here silently re-narrows the allowlist.
  it('EI-21924434989535557: grants role `judge` read access, so acceptance graders can RE-MEASURE via SQL', () => {
    expect(pgQueryTool.agentRoles).toContain('judge');
  });

  it('publishes SQL and relation description as mutually exclusive input alternatives', () => {
    expect(pgQueryTool.args.safeParse({ sql: 'SELECT 1' }).success).toBe(true);
    expect(
      pgQueryTool.args.safeParse({ sql: 'SELECT 1', positiveControlSql: 'SELECT 1 AS known' }).success,
    ).toBe(true);
    expect(pgQueryTool.args.safeParse({ describe: 'harness_shared.tool_invocations' }).success).toBe(true);
    expect(pgQueryTool.args.safeParse({ sql: 'SELECT 1', allowUnboundedJsonSearch: true }).success).toBe(true);
    expect(
      pgQueryTool.args.safeParse({ describe: 'harness_shared.tool_invocations', allowUnboundedJsonSearch: false }).success,
    ).toBe(false);
    expect(pgQueryTool.args.safeParse({ sql: 'SELECT 1', describe: 'harness_shared.tool_invocations' }).success).toBe(false);
    expect(
      pgQueryTool.args.safeParse({
        describe: 'harness_shared.tool_invocations',
        positiveControlSql: 'SELECT 1',
      }).success,
    ).toBe(false);
    expect(pgQueryTool.args.safeParse({}).success).toBe(false);

    const json = z.toJSONSchema(pgQueryTool.args as never) as {
      anyOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown; type?: unknown }>;
      }>;
      oneOf?: Array<{
        required?: string[];
        properties?: Record<string, { not?: unknown; type?: unknown }>;
      }>;
    };
    const branches = json.anyOf ?? json.oneOf ?? [];
    expect(branches).toHaveLength(2);
    const sqlBranch = branches.find((branch) => branch.required?.includes('sql'));
    const describeBranch = branches.find((branch) => branch.required?.includes('describe'));
    expect(sqlBranch?.properties?.allowUnboundedJsonSearch).toMatchObject({ type: 'boolean' });
    expect(describeBranch?.properties?.allowUnboundedJsonSearch).toMatchObject({ not: expect.anything() });
    expect(branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          required: expect.arrayContaining(['sql']),
          properties: expect.objectContaining({ describe: expect.objectContaining({ not: expect.anything() }) }),
        }),
        expect.objectContaining({
          required: expect.arrayContaining(['describe']),
          properties: expect.objectContaining({ sql: expect.objectContaining({ not: expect.anything() }) }),
        }),
      ]),
    );
  });

  it('does not retain an ambient workspace transaction while using the admin read pool', () => {
    expect((pgQueryTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('keeps ptool JSON responses parseable when a relation description exceeds the result door', () => {
    expect((pgQueryTool as unknown as { skipResultDoor?: string }).skipResultDoor).toBe('programmatic-caller');
  });

  it('documents the unwrapped root shape for code:run callers', () => {
    const returns = (pgQueryTool as unknown as { guidance?: { returns?: string } }).guidance?.returns;
    // P-011 added the `mode` discriminator to the front of this shape; the rest of
    // the documented root is unchanged, and code:run still receives it unwrapped.
    expect(returns).toContain('{ mode, rowCount, truncated, fields, elapsedMs, rows, advisory?, positiveControl?, absence? }');
    expect(returns).toContain('absence.status:"unverified"');
    expect(returns).toContain('`code:run` returns this root directly');
  });

  it('documents PostgreSQL regex repetition limits and larger-excerpt alternatives', () => {
    const description = (pgQueryTool as unknown as { description?: string }).description ?? '';
    const chaining = (pgQueryTool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(description).toContain('limited to 255');
    expect(chaining).toContain('left(text, n)');
    expect(chaining).toContain('substring(text from start for n)');
  });

  it('maps work-item response vocabulary to canonical SQL columns before raw queries', () => {
    const chaining = (pgQueryTool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain("`state` maps to table `status`");
    expect(chaining).toContain("`id` maps to `feature_id`");
    expect(chaining).toContain('`completion_ref` / `terminal_completion_ref`');
    expect(chaining).toContain('describe `harness_shared.work_items`');
  });

  it('returns a relation description as structured data for transport-safe shaping', async () => {
    const description = {
      relation: 'harness_shared.tool_invocations',
      kind: 'table',
      columns: [{ name: 'id', type: 'text', nullable: false, default: null, comment: null }],
      indexes: [{ name: 'tool_invocations_pkey', definition: 'CREATE UNIQUE INDEX …' }],
      constraints: [{ name: 'tool_invocations_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }],
    };
    describeRelationMock.mockResolvedValue(description);

    const res = await pgQueryTool.handler(
      { describe: 'harness_shared.tool_invocations' } as never,
      {} as never,
    );

    // P-011: the envelope carries its `mode` discriminator alongside the
    // description's own fields, which are passed through unchanged.
    expect(res).toEqual({ data: { mode: 'describe', ...description } });
    expect(res).not.toHaveProperty('content');
  });

  it('returns glob relation listings as structured data for transport-safe shaping', async () => {
    const relations = [{ relation: 'harness_shared.tool_invocations', kind: 'table' }];
    listRelationsMock.mockResolvedValue(relations);

    const res = await pgQueryTool.handler({ describe: 'harness_shared.tool_*' } as never, {} as never);

    expect(res).toEqual({
      // P-011: a glob LIST is its own mode — it returns names, not column metadata.
      data: { mode: 'describe-list', pattern: 'harness_shared.tool_*', relationCount: 1, relations },
    });
    expect(res).not.toHaveProperty('content');
  });

  it('redirects the removed rubric relation to the plan-backed canonical store', async () => {
    const res = await pgQueryTool.handler({ describe: 'harness_shared.rubrics' } as never, {} as never);
    const payload = payloadOf(res as never);

    expect(payload).toMatchObject({ reason: 'relation_not_found' });
    expect(String(payload.error)).toContain('harness_shared.harness_plans');
    expect(String(payload.error)).toContain("template = 'rubric'");
    expect(String(payload.error)).toContain('rubrics:list');
  });

  it('documents the plan-backed rubric relation and canonical read tools', () => {
    const description = (pgQueryTool as unknown as { description?: string }).description ?? '';
    const chaining = (pgQueryTool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(description).toContain('harness_shared.harness_plans');
    expect(description).toContain("template = 'rubric'");
    expect(chaining).toContain('rubrics:list');
    expect(chaining).toContain('harness_shared.harness_plans');
  });

  it('refuses an unscoped tenant read before executing it', async () => {
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: 'SELECT 1' } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({ reason: 'tenant_scope_required' });
    expect(String(payloadOf(res as never).error)).toContain('allowUnscoped: true');
    expect(pgReadQueryMock).not.toHaveBeenCalled();
    expect(advisoryMock).toHaveBeenCalledWith('SELECT 1', {
      workspaceId: 'ws-1',
      harnessSlug: 'h-1',
    });
  });

  it('explains the exact-file fence instead of asking for already-present tenant predicates on test_runs', async () => {
    advisoryMock.mockResolvedValue('⚠ harness_shared.test_runs: workspace_id/harness_slug are NULL-by-design for CI rows.');
    const sql =
      "SELECT id FROM harness_shared.test_runs WHERE workspace_id = 'papercusp-workspace' " +
      "AND harness_slug = 'papercusp' AND file_path LIKE '%session-identity-attribution.integration.test.ts' LIMIT 5";
    const res = await pgQueryTool.handler(
      { sql, allowUnscoped: false } as never,
      { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' } as never,
    );
    const payload = payloadOf(res as never);
    expect(payload).toMatchObject({ reason: 'tenant_scope_required' });
    expect(String(payload.error)).toContain('exact file_path = value');
    expect(String(payload.error)).toContain('open-ended file_path LIKE');
    expect(String(payload.error)).not.toContain('Add the tenant predicate(s)');
    expect(pgReadQueryMock).not.toHaveBeenCalled();
  });

  it('runs an explicitly allowed cross-tenant read and retains the advisory', async () => {
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: 'SELECT 1', allowUnscoped: true } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    expect(payloadOf(res as never)).toMatchObject({ advisory: '⚠ tenant scope: …', rowCount: 1 });
    expect(pgReadQueryMock).toHaveBeenCalledOnce();
  });

  it('refuses oversized SQL results before serializing the response', async () => {
    pgReadQueryMock.mockResolvedValueOnce({
      ...OK_RESULT,
      rows: [{ payload: 'x'.repeat(PG_QUERY_MAX_RESPONSE_BYTES) }],
    });

    const res = await pgQueryTool.handler(
      { sql: 'SELECT payload', allowUnscoped: true } as never,
      {} as never,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      reason: 'result_too_large',
      limitBytes: PG_QUERY_MAX_RESPONSE_BYTES,
      estimatedBytesAtLeast: PG_QUERY_MAX_RESPONSE_BYTES + 1,
    });
    expect(String(payloadOf(res as never).error)).toContain('aggregate large JSON values');
  });

  it('preserves normal UTF-8 SQL results below the response byte cap', async () => {
    const row = { value: 'café 😀\n"quoted"' };
    pgReadQueryMock.mockResolvedValueOnce({ ...OK_RESULT, rows: [row] });

    const res = await pgQueryTool.handler(
      { sql: 'SELECT value', allowUnscoped: true } as never,
      {} as never,
    );

    expect(payloadOf(res as never)).toMatchObject({ mode: PG_QUERY_MODE.query, rows: [row] });
    expect((res as { isError?: boolean }).isError).not.toBe(true);
  });

  // EI-20261038811991822. The builder itself is unit-tested in
  // pg-read-query.test.ts; what THIS pair proves is the wiring — that the
  // advisory actually reaches the caller's payload, which is the half a
  // builder-only test cannot show. The module mock above is PARTIAL
  // (`...importOriginal()`), so the real builder runs here.
  it('surfaces the unused-CTE advisory on a query whose CTE is never joined', async () => {
    const res = await pgQueryTool.handler(
      {
        sql:
          "WITH targets AS (SELECT unnest(ARRAY['su-a','su-b']) AS owner_id) " +
          'SELECT owner_id FROM harness_shared.coord_presence LIMIT 5',
        allowUnscoped: true,
      } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    const payload = payloadOf(res as never);
    expect(String(payload.advisory)).toContain('unused CTE');
    expect(String(payload.advisory)).toContain('`targets`');
    // It ADVISES, it does not refuse — the rows still come back.
    expect(payload).toMatchObject({ rowCount: 1 });
  });

  it('emits no unused-CTE advisory once that CTE is joined', async () => {
    const res = await pgQueryTool.handler(
      {
        sql:
          "WITH targets AS (SELECT unnest(ARRAY['su-a','su-b']) AS owner_id) " +
          'SELECT p.owner_id FROM harness_shared.coord_presence p JOIN targets t ON t.owner_id = p.owner_id',
        allowUnscoped: true,
      } as never,
      { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
    );
    expect(payloadOf(res as never).advisory).toBeUndefined();
  });

  it('refuses an unbounded JSON-text search before pgReadQuery', async () => {
    const sql =
      "SELECT id FROM harness_shared.tool_invocations WHERE args_json::text ILIKE '%EI-22033266394507364%'";
    jsonTextSearchAdvisoryMock.mockReturnValue('⚠ unbounded JSON-text search: args_json::text');

    const res = await pgQueryTool.handler({ sql } as never, {} as never);
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      reason: 'unbounded_json_search',
      advisory: '⚠ unbounded JSON-text search: args_json::text',
    });
    expect(String(payloadOf(res as never).error)).toContain('allowUnboundedJsonSearch: true');
    expect(pgReadQueryMock).not.toHaveBeenCalled();
  });

  it('allows the explicit JSON-search bypass and retains the advisory on success', async () => {
    const sql =
      "SELECT id FROM harness_shared.tool_invocations WHERE metadata_json::text ILIKE '%requestOrigin%'";
    jsonTextSearchAdvisoryMock.mockReturnValue('⚠ unbounded JSON-text search: metadata_json::text');

    const res = await pgQueryTool.handler({ sql, allowUnboundedJsonSearch: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({ rowCount: 1 });
    expect(payloadOf(res as never).advisory).toContain(
      '⚠ unbounded JSON-text search: metadata_json::text',
    );
    expect(pgReadQueryMock).toHaveBeenCalledWith(sql, expect.objectContaining({
      maxRows: undefined,
      timeoutMs: expect.any(Number),
    }));
  });

  it('publishes the JSON-search bypass only on SQL calls', () => {
    expect(
      pgQueryTool.args.safeParse({
        sql: 'SELECT 1',
        allowUnboundedJsonSearch: true,
      }).success,
    ).toBe(true);
    expect(
      pgQueryTool.args.safeParse({
        describe: 'harness_shared.tool_invocations',
        allowUnboundedJsonSearch: true,
      }).success,
    ).toBe(false);
  });

  it('runs a read-only EXPLAIN over a SELECT body and returns planner rows', async () => {
    pgReadQueryMock.mockResolvedValue({
      rowCount: 1,
      truncated: false,
      fields: ['QUERY PLAN'],
      elapsedMs: 4,
      rows: [{ 'QUERY PLAN': 'Result  (cost=0.00..0.01 rows=1 width=4)' }],
    });
    const sql = 'EXPLAIN (FORMAT TEXT) SELECT 1';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({
      rowCount: 1,
      fields: ['QUERY PLAN'],
      rows: [{ 'QUERY PLAN': expect.stringContaining('Result') }],
    });
    expect(pgReadQueryMock).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({ maxRows: undefined, timeoutMs: expect.any(Number) }),
    );
  });

  it('returns call_timeout when tenant preflight hangs before pgReadQuery starts', async () => {
    advisoryMock.mockImplementation(() => new Promise(() => {}));

    const res = await runUntilCallDeadline(
      () => pgQueryTool.handler({ sql: 'SELECT 1', timeoutMs: 100 } as never, {} as never),
      100,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({ reason: 'call_timeout' });
    expect(advisoryMock).toHaveBeenCalledOnce();
    expect(pgReadQueryMock).not.toHaveBeenCalled();
  });

  it('returns call_timeout when optional error enrichment hangs after a PG error', async () => {
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('column does not exist'), { code: '42703' }));
    describeColumnsMock.mockImplementation(() => new Promise(() => {}));

    const res = await runUntilCallDeadline(
      () => pgQueryTool.handler({ sql: 'SELECT missing FROM t', timeoutMs: 1000 } as never, {} as never),
      1000,
    );

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({ reason: 'call_timeout' });
    expect(pgReadQueryMock).toHaveBeenCalledOnce();
    expect(describeColumnsMock).toHaveBeenCalledOnce();
  });

  it('omits the advisory field when the guard finds nothing (or throws)', async () => {
    const clean = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(clean as never)).not.toHaveProperty('advisory');

    advisoryMock.mockRejectedValue(new Error('schema read down'));
    const guarded = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(guarded as never)).toMatchObject({ rowCount: 1 });
  });

  describe('positive-control evidence for empty results (WI-41165)', () => {
    it('marks a bare zero-row result unverified instead of presenting silence as evidence', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 2,
        rows: [],
      });

      const res = await pgQueryTool.handler({ sql: 'SELECT 1 WHERE false' } as never, {} as never);
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({
        status: 'unverified',
        code: 'positive-control-not-run',
      });
      expect(payload.advisory).toContain('no positiveControlSql was run');
      expect(payload).not.toHaveProperty('positiveControl');
    });

    it('marks an empty result verified when its same-transaction positive control returns a row', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 3,
        rows: [],
        positiveControl: {
          rowCount: 1,
          truncated: false,
          fields: ['id'],
          rows: [{ id: 'known-row' }],
        },
      });
      const positiveControlSql = "SELECT id FROM t WHERE id = 'known-row'";

      const res = await pgQueryTool.handler(
        { sql: 'SELECT id FROM t WHERE false', positiveControlSql } as never,
        {} as never,
      );
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({ status: 'verified', code: 'positive-control-passed' });
      expect(payload.positiveControl).toEqual({
        status: 'passed',
        rowCount: 1,
        truncated: false,
        fields: ['id'],
        rows: [{ id: 'known-row' }],
      });
      expect(String(payload.advisory ?? '')).not.toContain('absence unverified');
      expect(pgReadQueryMock).toHaveBeenCalledWith('SELECT id FROM t WHERE false', expect.objectContaining({
        maxRows: undefined,
        timeoutMs: expect.any(Number),
        positiveControlSql,
      }));
    });

    it('keeps absence unverified when the supplied positive control is also empty', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 3,
        rows: [],
        positiveControl: { rowCount: 0, truncated: false, fields: [], rows: [] },
      });

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1 WHERE false', positiveControlSql: 'SELECT 1 WHERE false' } as never,
        {} as never,
      );
      const payload = payloadOf(res as never);

      expect(payload.absence).toEqual({ status: 'unverified', code: 'positive-control-empty' });
      expect(payload.positiveControl).toMatchObject({ status: 'failed', rowCount: 0 });
      expect(payload.advisory).toContain('positiveControlSql also returned 0 rows');
    });

    it('does not treat an ungrouped COUNT(*) control returning zero as a known-positive row', async () => {
      pgReadQueryMock.mockResolvedValue({
        rowCount: 0,
        truncated: false,
        fields: [],
        elapsedMs: 3,
        rows: [],
        positiveControl: {
          rowCount: 1,
          truncated: false,
          fields: ['n_orientation_user_turns'],
          rows: [{ n_orientation_user_turns: '0' }],
        },
      });
      const positiveControlSql =
        'SELECT count(*) AS n_orientation_user_turns FROM harness_shared.session_turns WHERE false';

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1 WHERE false', positiveControlSql } as never,
        {} as never,
      );
      const payload = payloadOf(res as never);

      expect(payload.positiveControl).toMatchObject({
        status: 'failed',
        reason: 'scalar-aggregate',
        rowCount: 1,
        rows: [{ n_orientation_user_turns: '0' }],
      });
      expect(payload.absence).toEqual({
        status: 'unverified',
        code: 'positive-control-scalar-aggregate',
      });
      expect(payload.advisory).toContain('ungrouped scalar COUNT aggregate');
    });

    it('keeps row-shaped CTE and window COUNT controls usable', async () => {
      const controls = [
        {
          sql: 'WITH counts AS (SELECT count(*) AS n FROM t WHERE false) SELECT id FROM t WHERE id = 0',
          fields: ['id'],
          rows: [{ id: 0 }],
        },
        {
          sql: 'SELECT count(*) OVER () AS matches FROM t WHERE id = 0',
          fields: ['matches'],
          rows: [{ matches: '1' }],
        },
      ];

      for (const control of controls) {
        pgReadQueryMock.mockResolvedValue({
          rowCount: 0,
          truncated: false,
          fields: [],
          elapsedMs: 3,
          rows: [],
          positiveControl: {
            rowCount: 1,
            truncated: false,
            fields: control.fields,
            rows: control.rows,
          },
        });
        const res = await pgQueryTool.handler(
          { sql: 'SELECT 1 WHERE false', positiveControlSql: control.sql } as never,
          {} as never,
        );
        const payload = payloadOf(res as never);

        expect(payload.positiveControl).toMatchObject({ status: 'passed', rowCount: 1 });
        expect(payload.absence).toEqual({ status: 'verified', code: 'positive-control-passed' });
      }
    });

    it('tenant-checks positiveControlSql before executing either query', async () => {
      advisoryMock.mockImplementation(async (sql: string) =>
        sql.includes('unscoped_control') ? '⚠ tenant scope: control is unscoped' : null,
      );

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1', positiveControlSql: 'SELECT * FROM unscoped_control' } as never,
        { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
      );

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(payloadOf(res as never)).toMatchObject({ reason: 'positive_control_tenant_scope_required' });
      expect(pgReadQueryMock).not.toHaveBeenCalled();
    });

    it('gives test_runs-specific guidance when positiveControlSql hits the CI-row tenant warning', async () => {
      advisoryMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(
          '⚠ harness_shared.test_runs: workspace_id/harness_slug are NULL-by-design for CI/dogfood-reporter rows.',
        );
      const positiveControlSql =
        "SELECT id FROM harness_shared.test_runs WHERE workspace_id = 'ws-1' AND harness_slug = 'h-1'";

      const res = await pgQueryTool.handler(
        { sql: 'SELECT 1', positiveControlSql } as never,
        { workspaceId: 'ws-1', harnessSlug: 'h-1' } as never,
      );
      const payload = payloadOf(res as never);

      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(payload).toMatchObject({ reason: 'positive_control_tenant_scope_required' });
      expect(payload.error).toContain('For a local reporter positive control');
      expect(payload.error).toContain('CI/gate controls, filter by source or commit_sha');
      expect(payload.error).toContain('workspace_id/harness_slug alone are insufficient');
      expect(payload.error).not.toContain('Add tenant predicate(s) to positiveControlSql');
      expect(pgReadQueryMock).not.toHaveBeenCalled();
    });

    // EI-22633261796522656: local reporter rows can be recovered by a bounded
    // id group. The primary and positive-control reads must both pass the same
    // tenant guard so the handler can execute the evidence probe without the
    // caller resorting to allowUnscoped.
    it('executes a tenant-fenced bounded local reporter query with its positive control', async () => {
      const sql =
        "SELECT id, file_path, status FROM harness_shared.test_runs WHERE workspace_id = 'ws-1' " +
        "AND harness_slug = 'h-1' AND id BETWEEN 100 AND 104 ORDER BY id";
      const positiveControlSql =
        "SELECT id FROM harness_shared.test_runs WHERE workspace_id = 'ws-1' " +
        "AND harness_slug = 'h-1' AND id = 100";

      const res = await pgQueryTool.handler({ sql, positiveControlSql } as never, {
        workspaceId: 'ws-1',
        harnessSlug: 'h-1',
      } as never);

      expect(payloadOf(res as never)).toMatchObject({ rowCount: 1 });
      expect(pgReadQueryMock).toHaveBeenCalledWith(sql, expect.objectContaining({
        maxRows: undefined,
        timeoutMs: expect.any(Number),
        positiveControlSql,
      }));
      expect(advisoryMock).toHaveBeenNthCalledWith(1, sql, {
        workspaceId: 'ws-1',
        harnessSlug: 'h-1',
      });
      expect(advisoryMock).toHaveBeenNthCalledWith(2, positiveControlSql, {
        workspaceId: 'ws-1',
        harnessSlug: 'h-1',
      });
    });
  });

  // WI-6674. NOTE the mock factory spreads importOriginal() before overriding,
  // so buildSilentNullPathAdvisory here is the REAL implementation — these pin
  // the handler wiring end-to-end rather than a stub agreeing with itself.
  // ⚠ Repointed 2026-09-02 from the engineer_issues `_ei->>'severity'` form.
  // Migration 1096 made that path resolve on the view, so its trap was retired
  // (see SILENT_NULL_PATH_TRAPS) and this SQL would no longer raise ANY
  // advisory — the wiring assertions below would fail. `_ei->>'lane'` on the
  // work_items TABLE is still a live always-NULL trap, so it exercises the same
  // handler wiring against a claim that is currently true.
  const NULL_PATH_SQL =
    "SELECT count(*) FROM harness_shared.work_items WHERE payload->'_ei'->>'lane' <> 'observation'";

  it('attaches the always-NULL-accessor advisory to a successful result', async () => {
    const res = await pgQueryTool.handler({ sql: NULL_PATH_SQL, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('always-NULL accessor');
  });

  it('attaches the nullable-jsonb negation advisory to a successful result', async () => {
    const sql =
      "SELECT count(*) FILTER (WHERE NOT (jsonb_typeof(body->'sections') = 'array')) " +
      'FROM harness_shared.coord_event_log';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('nullable jsonb_typeof negation');
  });

  it('attaches the epoch-unit advisory to a tool_invocations recency read', async () => {
    const sql =
      'SELECT min(invoked_at) FROM harness_shared.tool_invocations ' +
      'WHERE invoked_at >= to_timestamp(1786547705.088/1000.0)';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('epoch-unit ambiguity');
  });

  it('does not warn for an epoch-milliseconds literal', async () => {
    const sql =
      'SELECT min(invoked_at) FROM harness_shared.tool_invocations ' +
      'WHERE invoked_at >= to_timestamp(1786547705088/1000.0)';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).not.toHaveProperty('advisory');
  });

  it('attaches a guarded session_turn_parts decoder advisory to a successful read', async () => {
    const sql =
      "SELECT text::jsonb FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('unsafe session_turn_parts JSON decode');
    expect(payloadOf(res as never).advisory).toContain('CASE WHEN text IS JSON THEN text::jsonb END');
  });

  it('retains the decoder advisory when the unsafe read fails before returning rows', async () => {
    const sql =
      "SELECT text::jsonb FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' }),
    );
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({
      code: '22P02',
      advisory: expect.stringContaining('unsafe session_turn_parts JSON decode'),
    });
  });

  it('attaches the population-narrowing advisory to a successful grouped read', async () => {
    const sql =
      'SELECT tool_name, count(*) FROM arbitrary_relation ' +
      'GROUP BY tool_name HAVING count(*) = 1 LIMIT 5';
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never).advisory).toContain('population-narrowing');
    expect(payloadOf(res as never).advisory).toContain('HAVING/LIMIT');
  });

  it('retains the population-narrowing advisory when the grouped read fails', async () => {
    const sql =
      'SELECT tool_name, count(*) FROM arbitrary_relation ' +
      'GROUP BY tool_name HAVING count(*) = 1 LIMIT 5';
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42601',
      advisory: expect.stringContaining('population-narrowing'),
    });
  });

  it('does not advise again after the query uses the guarded decoder', async () => {
    const sql =
      'SELECT CASE WHEN text IS JSON THEN text::jsonb END ' +
      "FROM harness_shared.session_turn_parts WHERE workspace_id = 'default'";
    const res = await pgQueryTool.handler({ sql, allowUnscoped: true } as never, {} as never);
    expect(payloadOf(res as never)).not.toHaveProperty('advisory');
  });

  it('COMPOSES both advisories — neither masks the other', async () => {
    // A query can be both wrongly-scoped AND wrongly-accessed; reporting only
    // one would send the agent back for a second round-trip on the same query.
    advisoryMock.mockResolvedValue('⚠ tenant scope: …');
    const res = await pgQueryTool.handler(
      { sql: NULL_PATH_SQL, allowUnscoped: true } as never,
      {} as never,
    );
    const advisory = String(payloadOf(res as never).advisory);
    expect(advisory).toContain('always-NULL accessor');
    expect(advisory).toContain('tenant scope');
  });

  it('omits the advisory field entirely when neither guard fires', async () => {
    const res = await pgQueryTool.handler(
      // Keep this a genuinely uncovered read: engineer_issues is covered by
      // the existing improvements:digest routing hint.
      { sql: 'SELECT 1' } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).not.toHaveProperty('advisory');
  });

  it('a 42703 error carries knownColumns for the referenced tables', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "updated_at" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.engineer_issues', columns: ['issue_id: text', 'updated_ts: bigint'] },
    ]);
    const res = await pgQueryTool.handler(
      { sql: 'SELECT updated_at FROM harness_shared.engineer_issues' } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: {
        'harness_shared.engineer_issues': ['issue_id: text', 'updated_ts: bigint'],
      },
    });
  });

  // EI-21957852799485985 / EI-21957833809596344: two hand-written
  // linked-work-item queries 20s apart from ONE session, both 42703. The
  // sql-derived advisories — the routing one above all — were computed BELOW
  // pgReadQuery, so a caller whose query threw reached none of them. The
  // errored caller is exactly the one who should be told a tool covers the
  // read: they are about to retry, and a bare column list makes retrying with
  // SQL look like the right move. `buildToolRoutingAdvisory` is the real
  // implementation here (only pgReadQuery and the describe helpers are mocked),
  // so this fails if the advisory stops reaching the error payload for any
  // reason — a regressed hoist, or the builder ceasing to fire on this shape.
  it('a failed query still carries the sql-derived routing advisory, not just the column list', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column w.id does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.work_items', columns: ['feature_id: text', 'title: text'] },
    ]);
    const res = await pgQueryTool.handler(
      { sql: "SELECT w.id, w.title FROM harness_shared.work_items w WHERE w.workspace_id = 'ws'" } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      advisory: expect.stringContaining('work_items:list'),
    });
  });

  // The placement half of the fix above, and a real failure mode rather than a
  // style point: knownColumns runs to ~79 entries (~2.4KB) for
  // harness_shared.work_items. An advisory serialised AFTER that wall is one
  // the reader reaches last, behind the most voluminous-looking part of the
  // payload — so the fix would be present and still not land.
  it('orders the advisory BEFORE the bulk knownColumns dump it would otherwise be buried under', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column w.id does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.work_items', columns: ['feature_id: text', 'title: text'] },
    ]);
    const res = await pgQueryTool.handler(
      { sql: "SELECT w.id FROM harness_shared.work_items w WHERE w.workspace_id = 'ws'" } as never,
      {} as never,
    );
    const keys = Object.keys(payloadOf(res as never));
    expect(keys).toContain('advisory');
    expect(keys).toContain('knownColumns');
    expect(keys.indexOf('advisory')).toBeLessThan(keys.indexOf('knownColumns'));
  });

  it('adds an actionable routines schema redirect alongside knownColumns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "harness_slug" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.routines', columns: ['install_slug: text', 'workspace_id: text'] },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT harness_slug FROM harness_shared.routines WHERE workspace_id = 'ws'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining('install_slug'),
    });
  });

  it('adds the work-items assignee-to-taken_by redirect alongside knownColumns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "assignee" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.work_items',
        columns: ['feature_id: text', 'taken_by: text', 'workspace_id: text', 'harness_slug: text'],
      },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT assignee FROM harness_shared.work_items WHERE workspace_id = 'ws' AND harness_slug = 'h'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: {
        'harness_shared.work_items': expect.arrayContaining(['taken_by: text']),
      },
      schemaColumn: expect.stringContaining('taken_by'),
    });
    expect(String(payloadOf(res as never).schemaColumn)).toContain('BOTH');
  });

  it('adds the feature-view assignee-to-taken_by redirect', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "assignee" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.harness_features_consolidated',
        columns: ['feature_id: text', 'taken_by: text', 'workspace_id: text', 'harness_slug: text'],
      },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT assignee FROM harness_shared.harness_features_consolidated WHERE workspace_id = 'ws' AND harness_slug = 'h'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never).schemaColumn).toEqual(expect.stringContaining('taken_by'));
  });

  it('adds the substrate_outbox table_name redirect alongside knownColumns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "table_tag" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.substrate_outbox',
        columns: ['id: bigint', 'workspace_id: text', 'harness_slug: text', 'table_name: text'],
      },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT table_tag FROM harness_shared.substrate_outbox WHERE workspace_id = 'ws'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: {
        'harness_shared.substrate_outbox': expect.arrayContaining(['table_name: text']),
      },
      schemaColumn: expect.stringContaining('table_name'),
    });
  });

  it('returns the routines pause metadata redirect for a paused_reason guess', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "paused_reason" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'harness_shared.routines', columns: ['metadata: jsonb', 'active: boolean'] },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT paused_reason FROM harness_shared.routines WHERE workspace_id = 'ws'",
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining("metadata->'pause'->>'reason'"),
    });
  });

  it('redirects the legacy result_json guess to tool_invocations output columns', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "result_json" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.tool_invocations',
        columns: ['output_ref: text', 'output_size: bigint', 'metadata_json: jsonb'],
      },
    ]);
    const res = await pgQueryTool.handler(
      { sql: 'SELECT result_json FROM harness_shared.tool_invocations LIMIT 1' } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining('output_ref'),
    });
    expect(String(payloadOf(res as never).schemaColumn)).toContain('no inline result JSON');
  });

  it('redirects the coord thread-post API created_ts alias to the physical created_at column', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "created_ts" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.coord_thread_posts',
        columns: ['created_at: timestamp with time zone', 'thread_id: text', 'body: text'],
      },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: 'SELECT created_ts FROM harness_shared.coord_thread_posts ORDER BY created_ts DESC LIMIT 1',
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      knownColumns: {
        'harness_shared.coord_thread_posts': expect.arrayContaining(['created_at: timestamp with time zone']),
      },
      schemaColumn: expect.stringContaining('created_at'),
    });
    expect(String(payloadOf(res as never).schemaColumn)).toContain('API projections');
  });

  it('redirects a generic created_at guess to tool_invocations.invoked_at', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "created_at" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      {
        table: 'harness_shared.tool_invocations',
        columns: ['invoked_at: timestamp with time zone', 'tool_name: text', 'status: text'],
      },
    ]);
    const res = await pgQueryTool.handler(
      {
        sql: 'SELECT created_at FROM harness_shared.tool_invocations ORDER BY created_at DESC LIMIT 1',
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42703',
      schemaColumn: expect.stringContaining('invoked_at'),
    });
    expect(String(payloadOf(res as never).schemaColumn)).toContain('projected-tool-deps.ts');
  });

  it('a non-42703 error gets no column lookup; a failing lookup still returns the error', async () => {
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('syntax error'), { code: '42601' }));
    const res = await pgQueryTool.handler({ sql: 'SELEC 1' } as never, {} as never);
    expect(describeColumnsMock).not.toHaveBeenCalled();
    expect(payloadOf(res as never)).toMatchObject({ code: '42601' });

    pgReadQueryMock.mockRejectedValue(Object.assign(new Error('bad column'), { code: '42703' }));
    describeColumnsMock.mockRejectedValue(new Error('schema read down'));
    const res2 = await pgQueryTool.handler({ sql: 'SELECT nope FROM t' } as never, {} as never);
    const p2 = payloadOf(res2 as never);
    expect(p2).toMatchObject({ code: '42703' });
    expect(p2).not.toHaveProperty('knownColumns');
  });

  it('adds the zero-argument signature hint for a regprocedure cast parse error', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('expected a left parenthesis'), { code: '22P02' }),
    );
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml'::regprocedure)",
      } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '22P02',
      hint: expect.stringContaining("'harness_shared.engineer_issues_view_dml()'::regprocedure"),
    });
  });

  it('adds a targeted hint for an oversized PostgreSQL regex repetition', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('invalid regular expression: invalid repetition count(s)'), { code: '2201B' }),
    );
    const res = await pgQueryTool.handler(
      {
        sql: "SELECT regexp_matches('FOCUSED TEST example text', '(?s)(FOCUSED TEST.{0,1800})')",
      } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '2201B',
      hint: expect.stringContaining('limited to 255'),
    });
    expect(String(payloadOf(res as never).hint)).toContain('left(text_expression, n)');
    expect(String(payloadOf(res as never).hint)).toContain('{0,1800}');
  });

  it('adds DBOS workflow_status epoch and column guidance to failed forensic queries', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('operator does not exist: bigint > timestamp with time zone'), {
        code: '42883',
      }),
    );
    const res = await pgQueryTool.handler(
      {
        sql: 'SELECT count(*) FROM dbos.workflow_status WHERE created_at > now()',
      } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).toMatchObject({
      code: '42883',
      hint: expect.stringContaining('(extract(epoch from now()) * 1000)::bigint'),
    });

    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('column "updated_at_epoch_ms" does not exist'), { code: '42703' }),
    );
    describeColumnsMock.mockResolvedValue([
      { table: 'dbos.workflow_status', columns: ['created_at: bigint', 'updated_at: bigint', 'name: text'] },
    ]);
    const missingColumn = await pgQueryTool.handler(
      { sql: 'SELECT updated_at_epoch_ms FROM dbos.workflow_status' } as never,
      {} as never,
    );
    expect(payloadOf(missingColumn as never)).toMatchObject({
      code: '42703',
      hint: expect.stringContaining('`updated_at_epoch_ms` and `created_at_epoch_ms` are not columns'),
      knownColumns: { 'dbos.workflow_status': expect.any(Array) },
    });
  });

  it('explains the mixed timestamp units in work_items after a 42883 division error', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('operator does not exist: timestamp with time zone / numeric'), {
        code: '42883',
        hint: 'No operator matches the given name and argument types.',
      }),
    );
    const res = await pgQueryTool.handler(
      {
        sql:
          "SELECT feature_id, to_timestamp(taken_at/1000.0) AS taken_at, " +
          "to_timestamp(updated_ts/1000.0) AS updated_ts " +
          "FROM harness_shared.work_items WHERE harness_slug = 'papercusp' LIMIT 1",
        allowUnscoped: true,
      } as never,
      {} as never,
    );
    const payload = payloadOf(res as never);

    expect(payload).toMatchObject({
      code: '42883',
      hint: expect.stringContaining('work_items.taken_at'),
    });
    expect(String(payload.hint)).toContain('already a `timestamp with time zone`');
    expect(String(payload.hint)).toContain('to_timestamp(updated_ts / 1000.0)');
    expect(String(payload.hint)).not.toContain('No operator matches');
  });

  it('does not apply the work_items timestamp correction to another relation', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('operator does not exist: timestamp with time zone / numeric'), {
        code: '42883',
        hint: 'No operator matches the given name and argument types.',
      }),
    );
    const res = await pgQueryTool.handler(
      {
        sql: 'SELECT taken_at / 1000.0 FROM harness_shared.other_table',
        allowUnscoped: true,
      } as never,
      {} as never,
    );
    expect(String(payloadOf(res as never).hint)).toBe('No operator matches the given name and argument types.');
  });

  it('returns DBOS interval-join scan guidance when a narrow-looking history join times out', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    );
    const sql = [
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
    const res = await pgQueryTool.handler({ sql } as never, {} as never);

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({ code: '57014' });
    expect(payloadOf(res as never).advisory).toContain('DBOS historical interval join');
    expect(payloadOf(res as never).advisory).toContain('join workflow_status by workflow_uuid');
  });

  it('adds a targeted hint for a UNION column-count mismatch', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('each UNION query must have the same number of columns'), {
        code: '42601',
        position: '255',
      }),
    );
    const res = await pgQueryTool.handler(
      {
        sql:
          'SELECT kind, occurred_at, phase, status, level, source, message, details ' +
          'FROM harness_shared.coord_event_log ' +
          'UNION ALL ' +
          "SELECT kind, updated_at, NULL, NULL, NULL, logical_key, state, NULL, jsonb_build_object('resource', true) " +
          'FROM harness_shared.workspace_host_resources',
      } as never,
      {} as never,
    );
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payloadOf(res as never)).toMatchObject({
      code: '42601',
      hint: expect.stringContaining('same number of columns'),
    });
    expect(String(payloadOf(res as never).hint)).toContain('NULL');
    expect(String(payloadOf(res as never).hint)).toContain('type-compatible');
  });

  // EI-22725188331129683: `harness_escalations.escalation` is TEXT in the
  // live schema. The generic PostgreSQL 42883 hint says only "explicit type
  // casts"; this regression keeps the exact failed shape actionable.
  it('adds an operand-specific JSONB cast hint when a JSON operator receives TEXT', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('operator does not exist: text ->> unknown'), {
        code: '42883',
        hint: 'No operator matches the given name and argument types. You might need to add explicit type casts.',
      }),
    );
    const sql =
      "SELECT escalation->>'kind' AS kind FROM harness_shared.harness_escalations " +
      "WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' LIMIT 1";
    const res = await pgQueryTool.handler({ sql } as never, {} as never);
    const payload = payloadOf(res as never);

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payload).toMatchObject({
      code: '42883',
      hint: expect.stringContaining("(escalation::jsonb)->>'key'"),
    });
    expect(String(payload.hint)).toContain('text');
    expect(String(payload.hint)).toContain('non-JSON');
    expect(String(payload.hint)).not.toContain('No operator matches');
  });

  it('does not attach the JSON cast correction to an unrelated 42883 operator error', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('operator does not exist: integer = text'), {
        code: '42883',
        hint: 'No operator matches the given name and argument types.',
      }),
    );
    const res = await pgQueryTool.handler(
      { sql: 'SELECT 1 FROM harness_shared.harness_escalations WHERE mtime_ms = \'one\'' } as never,
      {} as never,
    );
    expect(payloadOf(res as never).hint).toBe('No operator matches the given name and argument types.');
  });

  it('does not attach the oversized-bound hint to another repetition error shape', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('invalid regular expression: invalid repetition count(s)'), { code: '2201B' }),
    );
    const res = await pgQueryTool.handler(
      { sql: "SELECT regexp_matches('example', '(x){0,255}')" } as never,
      {} as never,
    );
    expect(payloadOf(res as never)).not.toHaveProperty('hint');
  });

  // EI-22801631303104511: the operator role cannot inspect PostgreSQL's
  // data_directory setting. Report this as a typed capability limitation so a
  // caller stops retrying the same probe and chooses a permitted diagnostic.
  it('reports the data_directory privilege boundary as capability_unavailable', async () => {
    const message =
      "Only roles with privileges of pg_read_all_settings may examine current_setting('data_directory').";
    pgReadQueryMock.mockRejectedValue(Object.assign(new Error(message), { code: '42501' }));

    const res = await pgQueryTool.handler(
      { sql: "SELECT current_setting('data_directory')" } as never,
      {} as never,
    );
    const payload = payloadOf(res as never);

    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payload).toMatchObject({
      error: message,
      reason: 'capability_unavailable',
      capability: 'pg_read_all_settings',
      setting: 'data_directory',
      code: '42501',
    });
    expect(String(payload.hint)).toContain('unavailable through `dev:pg_query`');
  });

  it('keeps unrelated 42501 errors on the normal PostgreSQL error path', async () => {
    pgReadQueryMock.mockRejectedValue(
      Object.assign(new Error('permission denied for relation harness_shared.work_items'), {
        code: '42501',
      }),
    );

    const res = await pgQueryTool.handler(
      { sql: 'SELECT feature_id FROM harness_shared.work_items' } as never,
      {} as never,
    );
    const payload = payloadOf(res as never);

    expect(payload).not.toHaveProperty('reason', 'capability_unavailable');
    expect(payload).not.toHaveProperty('capability');
    expect(payload).toMatchObject({
      error: 'permission denied for relation harness_shared.work_items',
      code: '42501',
    });
  });

  // EI-19415142351884573: a whole-call timeout is a distinct failure from a
  // real PG error ("we never found out" vs "PG said no") and must be reported
  // as such, not fall into the generic HINT/DETAIL/42703 error path below it.
  it('a PgReadQueryTimeoutError is reported as reason "call_timeout", not a generic PG error', async () => {
    pgReadQueryMock.mockRejectedValue(
      new PgReadQueryTimeoutError('Query call did not complete within 3100ms of the WHOLE call…'),
    );
    const res = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect((res as { isError?: boolean }).isError).toBe(true);
    const payload = payloadOf(res as never);
    expect(payload.reason).toBe('call_timeout');
    expect(String(payload.error)).toContain('WHOLE call');
    expect(payload).not.toHaveProperty('knownColumns');
    expect(describeColumnsMock).not.toHaveBeenCalled();
  });
});

/**
 * P-011 (fleet-friction-remediation-2026-08-21) — the OUTPUT counterpart to the
 * "mutually exclusive input alternatives" test above. The input side was already a
 * discriminated union; the RESULT side was not, and callers had to tell three
 * structurally disjoint payloads apart by probing for `rows` vs `columns` vs
 * `relations` — the schema-guessing the describe path exists to end.
 */
describe('dev:pg_query — result envelope is a discriminated union (P-011)', () => {
  const dataOf = (res: unknown) => (res as { data: Record<string, unknown> }).data;

  it('stamps mode:"query" on a SQL result', async () => {
    const res = await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never);
    expect(payloadOf(res as never).mode).toBe(PG_QUERY_MODE.query);
  });

  it('stamps mode:"describe" on a single-relation description, without dropping its fields', async () => {
    describeRelationMock.mockResolvedValue({
      relation: 'harness_shared.work_items',
      kind: 'table',
      columns: [{ name: 'feature_id' }],
      indexes: [],
      constraints: [],
    });
    const d = dataOf(await pgQueryTool.handler({ describe: 'harness_shared.work_items' } as never, {} as never));
    expect(d.mode).toBe(PG_QUERY_MODE.describe);
    // The discriminator is SPREAD ONTO the description, so adding it must not
    // shadow or drop what the caller actually came for.
    expect(d.relation).toBe('harness_shared.work_items');
    expect(d.columns).toEqual([{ name: 'feature_id' }]);
  });

  it('stamps mode:"describe-list" on a glob listing', async () => {
    listRelationsMock.mockResolvedValue([{ relation: 'harness_shared.work_items' }]);
    const d = dataOf(await pgQueryTool.handler({ describe: 'harness_shared.work_*' } as never, {} as never));
    expect(d.mode).toBe(PG_QUERY_MODE.describeList);
    expect(d.relationCount).toBe(1);
  });

  it('documents EVERY mode in `returns`, so the published union cannot drift from the emitted one', () => {
    const modes = Object.values(PG_QUERY_MODE);
    expect(new Set(modes).size).toBe(modes.length); // distinct, or the discriminator discriminates nothing

    // Read the contract the way the projection does — `guidance.returns`, not a
    // top-level field. Assert it RESOLVED before asserting on its content: an
    // undefined here would make every toContain below vacuous, which is how a
    // doc-pin silently stops pinning anything.
    const returns = pgQueryTool.guidance?.returns;
    expect(typeof returns).toBe('string');

    // Add a mode to PG_QUERY_MODE without documenting it and this fails. That is
    // the point: the contract is PINNED to the code rather than hand-maintained.
    for (const mode of modes) expect(returns).toContain(`"${mode}"`);
  });

  it('CONTROL: `mode` is the ONLY key all three envelopes share — which is why probing was unsound', async () => {
    describeRelationMock.mockResolvedValue({ relation: 'r', kind: 'table', columns: [], indexes: [], constraints: [] });
    listRelationsMock.mockResolvedValue([]);
    const query = payloadOf((await pgQueryTool.handler({ sql: 'SELECT 1' } as never, {} as never)) as never);
    const one = dataOf(await pgQueryTool.handler({ describe: 'r' } as never, {} as never));
    const list = dataOf(await pgQueryTool.handler({ describe: 'r*' } as never, {} as never));

    const shared = Object.keys(query).filter((k) => k in one && k in list);
    expect(shared).toEqual(['mode']);
    // Guard the premise too: if these ever genuinely converge, the union above is
    // no longer the right shape and this test should be the thing that says so.
    expect(Object.keys(one)).not.toEqual(Object.keys(list));
  });
});

/**
 * EI-21596258009994255 — `describe` with the WRONG VALUE.
 *
 * `describe` is DECLARED, so none of the `argRedirects` machinery fires:
 * `invalidInputCorrections` returns early unless a key was UNRECOGNIZED. The measured
 * refusal was the bare Zod line "describe: Invalid input: expected string, received
 * object" — it names the type and never the string to send, and the reporting caller
 * had passed `{ schema, table }`, which is the natural shape when a relation is thought
 * of as two parts.
 */
describe('dev:pg_query `describe` value shape (EI-21596258009994255)', () => {
  /** What a caller actually reads back for these args. */
  const refusalFor = (input: unknown): string => {
    const parsed = pgQueryTool.args.safeParse(input);
    if (parsed.success) throw new Error(`expected a refusal, got acceptance: ${JSON.stringify(parsed.data)}`);
    return formatIssues(parsed.error.issues as never, input);
  };

  it('CONTROL: the correct dotted string is accepted — the constraint is real, not merely re-worded', () => {
    const parsed = pgQueryTool.args.safeParse({ describe: 'harness_shared.work_items' });
    expect(parsed.success).toBe(true);
  });

  it('names the dotted STRING to send when the caller passes { schema, table }', () => {
    const rendered = refusalFor({ describe: { schema: 'harness_shared', table: 'work_items' } });
    // The correction has to carry a copyable value, not just a type name.
    expect(rendered).toContain('"harness_shared.work_items"');
    expect(rendered).toMatch(/not an object/i);
    // The glob form is the reason this is NOT widened to accept the object: an object
    // cannot express it. If that stops being true the widening argument changes, so the
    // reasoning is pinned here rather than left in a comment.
    expect(rendered).toContain('"harness_shared.*"');
  });

  it('POSITIVE CONTROL: the generic Zod line is no longer what the caller sees', () => {
    // Without the substitution this is EXACTLY the text that was measured in the field.
    // If the custom error is dropped or stops reaching formatIssues' union-leaf
    // resolution, this assertion is the one that fails.
    const rendered = refusalFor({ describe: { schema: 'harness_shared', table: 'work_items' } });
    expect(rendered).not.toMatch(/expected string, received object/);
  });

  it('covers the other non-string shapes a caller reaches for', () => {
    for (const value of [['harness_shared.work_items'], 42, { relation: 'work_items' }]) {
      expect(refusalFor({ describe: value })).toContain('"harness_shared.work_items"');
    }
  });

  it('the published arg description states the same shape, so the fix is not refusal-only', () => {
    // A caller who reads the schema before calling must not have to trigger the refusal
    // to learn the form; these two texts drifting apart is the failure this pins.
    const schema = z.toJSONSchema(pgQueryTool.args as never, { io: 'input' }) as { anyOf?: Array<{ properties?: Record<string, { description?: string }> }> };
    const described = (schema.anyOf ?? [])
      .map((branch) => branch.properties?.describe?.description)
      .filter((d): d is string => typeof d === 'string' && d.length > 0);
    expect(described.length).toBeGreaterThan(0);
    expect(described.some((d) => d.includes('"harness_shared.work_items"'))).toBe(true);
  });
});
