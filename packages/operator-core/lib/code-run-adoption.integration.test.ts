/** Real PostgreSQL semantics and plan guard for EI-25299577060523251. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  CODE_RUN_ADOPTION_SQL,
  readRecipeOutcomeReport,
  spawnRowsFromCalls,
  type CallRow,
  type SpawnAdoptionRow,
} from './code-run-adoption';
import { TURN_GAP_MS } from './code-run-batch-nudge';

describe('adoption SQL: one turn stream without materialized call reuse', () => {
  let db: MigratedTestDb;
  let sql: Sql;
  let expected: SpawnAdoptionRow[];

  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'adoption-plan' });
    sql = postgres(db.url, { max: 1, onnotice: () => {} });
    // Only this query's input contract; no production database or corpus is used.
    await sql`CREATE SCHEMA harness_shared`;
    await sql`CREATE TABLE harness_shared.tool_invocations (
      spawn_id text, role text, invoked_at timestamptz, tool_name text,
      status text, transport text
    )`;
    const [{ at }] = await sql<{ at: Date }[]>`SELECT date_trunc('day', now()) AS at`;
    const base = at!.getTime();
    const calls: CallRow[] = [];
    const add = (spawnId: string, toolName: string, offset: number) => {
      calls.push({ spawnId, role: spawnId, day: at!.toISOString().slice(0, 10), toolName, invokedAt: base + offset });
    };
    // Tied timestamps, the exact gap boundary, repeated tools across turns, and
    // excluded calls between work calls all exercise the window/reduction seam.
    add('mixed', 'work_items:get', 0);
    add('mixed', 'facts:list', 0);
    add('mixed', 'work_items:get', TURN_GAP_MS);
    add('mixed', 'code:run', TURN_GAP_MS + 1);
    add('mixed', 'work_items:get', 2 * TURN_GAP_MS + 1);
    add('mixed', 'docs:search', 3 * TURN_GAP_MS + 2);
    add('mixed', 'work_items:get', 4 * TURN_GAP_MS + 3);
    add('door-only', 'recipes:run', 0);
    add('poller-only', 'activity:recent', 0);
    add('excluded-only', 'code:tools', 0);
    add('single-turn', 'facts:list', 0);
    add('single-turn', 'facts:list', 0);
    add('single-turn', 'docs:search', 1);
    expected = spawnRowsFromCalls(calls).sort((a, b) => a.role.localeCompare(b.role));
    await sql`INSERT INTO harness_shared.tool_invocations ${sql(calls.map((c) => ({
      spawn_id: c.spawnId, role: c.role, invoked_at: new Date(c.invokedAt),
      tool_name: c.toolName, status: 'ok', transport: 'mcp',
    })))}`;
    // These must not enter either the spawn denominator or the work window.
    await sql`INSERT INTO harness_shared.tool_invocations VALUES
      ('failed', 'failed', now(), 'facts:list', 'error', 'mcp'),
      ('ui', 'ui', now(), 'facts:list', 'ok', 'http'),
      (NULL, 'anonymous', now(), 'facts:list', 'ok', 'mcp'),
      ('old', 'old', now() - interval '8 days', 'facts:list', 'ok', 'mcp')`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.drop();
  });

  it('matches the independent pure turn classifier, including zero-work spawns', async () => {
    const rows = await sql.unsafe(CODE_RUN_ADOPTION_SQL, [7]);
    const actual: SpawnAdoptionRow[] = rows.map((r) => ({
      role: r.role, day: r.day, workCalls: Number(r.work_calls),
      distinctTools: Number(r.distinct_tools), maxSameTool: Number(r.max_same_tool),
      maxSameToolTurns: Number(r.max_same_tool_turns), distinctTurns: Number(r.distinct_turns),
      usedCodeRun: r.used_code_run,
    }));
    expect(actual.sort((a, b) => a.role.localeCompare(b.role))).toEqual(expected);
    expect(actual.find((r) => r.role === 'mixed')).toMatchObject({ distinctTurns: 4, maxSameToolTurns: 3 });
  });

  it('does not materialize the reused call or turn streams in the PostgreSQL plan', async () => {
    const rows = await sql.unsafe(`EXPLAIN (FORMAT JSON) ${CODE_RUN_ADOPTION_SQL}`, [7]);
    const plan = JSON.stringify(rows[0]!['QUERY PLAN']);
    // This was the observed disk allocator: calls/turned had multiple CTE Scan
    // consumers. A live planner guard catches a return to that shape.
    expect(plan).not.toContain('"CTE Name":"calls"');
    expect(plan).not.toContain('"CTE Name":"turned"');
  });
});

describe('R13 exact-window recipe outcome report (real PG)', () => {
  let db: MigratedTestDb;
  let sql: Sql;
  const scope = { workspaceId: 'report-ws', harnessSlug: 'app', windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z' };
  beforeAll(async () => {
    db = await createFreshTestDb({ prefix: 'recipe-report' });
    sql = postgres(db.url, { max: 1, onnotice: () => {} });
    await sql`CREATE SCHEMA harness_shared`;
    await sql`CREATE TABLE harness_shared.code_recipe_runs (
      id serial, recipe_id text, workspace_id text, agent_owner text, agent_role text,
      success boolean, reused boolean, execution_trace jsonb, ts timestamptz)`;
    await sql`CREATE TABLE harness_shared.tool_invocations (
      id serial, workspace_id text, harness_slug text, tool_name text, invoked_at timestamptz, metadata_json jsonb)`;
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); await db?.drop(); });
  const read = () => readRecipeOutcomeReport(async <T>(query: string, params: unknown[]) =>
    await sql.unsafe(query, params as never) as unknown as T[], scope);
  const run = async (call: string | null, attempt: number, selection = 'saved-replay', outcome = 'success', mode = 'commit') => {
    const trace = call ? { usage: { version: 1, choice: 'agent', selection, outcome, mode, settled: true },
      runEvidence: { version: 1, invocationId: call, attempt, executed: outcome !== 'refused',
        sourceBytes: 10, intermediateBytes: 5, elapsedBeforeRecordMs: 1 } } : {};
    await sql`INSERT INTO harness_shared.code_recipe_runs
      (recipe_id,workspace_id,agent_owner,agent_role,success,reused,execution_trace,ts)
      VALUES ('recipe','report-ws','agent-one','operator',${outcome === 'success'},true,
        ${sql.json(trace)},'2026-10-01T12:00:00Z')`;
  };
  const host = async (call: string, bytes: number | null, harness = 'app', final = true) => sql`
    INSERT INTO harness_shared.tool_invocations (workspace_id,harness_slug,tool_name,invoked_at,metadata_json)
    VALUES ('report-ws',${harness},'recipes:run','2026-10-01T12:00:01Z',
      ${sql.json({ otel: { callId: call }, returnedContextBytes: bytes,
        ...(final ? { spillPending: false, resultDoorReason: 'per-result-budget-exceeded' } : {}) })})`;

  it('R13 counts failures and copies honestly while charging bulk returned context once', async () => {
    await host('bulk', 100); await host('refused', null);
    for (const call of ['authored', 'automatic', 'preview']) await host(call, 20, 'app', call !== 'authored');
    await run('bulk', 0); await run('bulk', 0); await run('bulk', 1, 'saved-replay', 'error');
    await run('refused', 0, 'saved-replay', 'refused');
    await run('authored', 0, 'authored'); await run('automatic', 0, 'automatic-match');
    await run('preview', 0, 'saved-replay', 'success', 'preview'); await run(null, 0);
    await host('foreign', 999, 'other-harness'); await run('foreign', 0);
    const report = await read();
    expect(report.measurement).toMatchObject({ sourceRows: 8, attempts: 7, verifiedCopiesExcluded: 1,
      conflictingReceipts: 0, authored: 1, automaticMatches: 1, deliberateSelections: 4,
      previews: 1, unknown: 1, replaySuccesses: 1, replayErrors: 1, replayRefusals: 1,
      replayDenominator: 3, distinctAgents: 1, unscopedWorkspaceReceipts: 1,
      sourceBytes: 60, intermediateBytes: 30, elapsedBeforeRecordMs: 6,
      dispatches: 5, contextMeasuredDispatches: 3, returnedContextBytes: 140, recordedContextBytes: 160 });
    expect(report.coverage).toMatchObject({ state: 'unknown', complete: false });
    expect(report.benefit.measuredSavings).toBeNull();
    await run('bulk', 0, 'saved-replay', 'error');
    expect((await read()).measurement).toMatchObject({ conflictingReceipts: 1, unknown: 2,
      replaySuccesses: 0, replayErrors: 1, replayRefusals: 1, replayDenominator: 2 });
    // Two plausible host rows do not authorize choosing the convenient one.
    await host('authored', 20);
    expect((await read()).measurement).toMatchObject({ authored: 0, unknown: 3, unscopedWorkspaceReceipts: 2 });
  });
});
