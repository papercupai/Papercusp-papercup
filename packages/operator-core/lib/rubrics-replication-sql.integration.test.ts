/**
 * rubrics-replication-sql.integration.test.ts — validateRubricReplicationSql against a
 * real migrated Postgres (Docker-gated). Pure extraction + placeholder substitution are
 * covered unit-only in rubrics-replication-sql.test.ts; this proves the EXPLAIN leg
 * actually catches the EI-10514 repro shape (a drill written against a renamed/nonexistent
 * table or column) and stays clean/non-blocking on a genuinely-runnable drill.
 *
 * EI-19988213173207009 added the bind-placeholder cases. They can ONLY be proven here: the
 * whole defect was that a parameterised drill never reached name resolution, so a unit test
 * with a stubbed EXPLAIN would assert the fix while the real SQLSTATE went unobserved.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { validateRubricReplicationSql } = await import('./rubrics-replication-sql');
const { createOrgTestDb } = await import('../test/_org-test-db');

describe('validateRubricReplicationSql (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('ok:true and no findings for criteria with clean, runnable drill SQL', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'end-to-end-flow',
        replication:
          "REPLICATION DRILL: SELECT tick_at, ideas_generated FROM harness_shared.scout_ticks " +
          "WHERE workspace_id='papercusp-workspace' ORDER BY tick_at DESC LIMIT 5; cross-check accounts:status.",
      },
      { key: 'no-sql-here', replication: 'fleet:assignments { harness } -> read summary.coverage_collisions.' },
    ]);
    expect(result).toEqual({
      checked: 1,
      findings: [],
      undeterminable: [],
      placeholderOnly: 0,
      ok: true,
      summary: '1 statement(s) checked · 0 real finding(s)',
    });
  });

  it('surfaces the EI-10514 repro: a drill referencing a renamed column, keyed by criterion', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'ideation-quality',
        // Authored from memory of the OLD schema — real column is ideas_generated/tick_at.
        replication:
          'SELECT ideas_count, created_at FROM harness_shared.scout_ticks ORDER BY created_at DESC LIMIT 5;',
      },
    ]);
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].criterionKey).toBe('ideation-quality');
    expect(result.findings[0].error.code).toBe('42703');
    // No placeholders were involved, so the one-pass path must not claim a substitution.
    expect(result.findings[0].afterPlaceholderSubstitution).toBeUndefined();
  });

  it.each(['MATERIALIZED', 'NOT MATERIALIZED'])(
    'EXPLAINs a complete AS %s interval query instead of a nested SELECT', async (modifier) => {
      const result = await validateRubricReplicationSql([{
        key: 'interval',
        replication: `WITH a AS ${modifier} (SELECT 1 AS n), ` +
          'b AS (SELECT n + 1 AS n FROM a) SELECT n FROM b;',
      }]);
      expect(result.checked).toBe(1);
      expect(result.findings).toEqual([]);
      expect(result.undeterminable).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it('still reports a genuine name-resolution failure inside a materialized CTE', async () => {
    const sql = 'WITH a AS MATERIALIZED (SELECT missing_column FROM harness_shared.scout_ticks) SELECT * FROM a';
    const result = await validateRubricReplicationSql([{ key: 'invalid-interval', replication: sql + ';' }]);
    expect(result.checked).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].sql).toBe(sql);
    expect(result.findings[0].error.code).toBe('42703');
  });

  it('surfaces a renamed-table repro (routed_ideas → harness_shared.scout_routed_ideas)', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'queen-workitem-selection', replication: 'SELECT * FROM routed_ideas LIMIT 5;' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings[0].error.code).toBe('42P01');
  });

  it('checks every criterion independently and reports each finding', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'a', replication: 'SELECT * FROM harness_shared.harness_plans LIMIT 1;' },
      { key: 'b', replication: 'SELECT * FROM harness_shared.nope_not_a_table LIMIT 1;' },
    ]);
    expect(result.checked).toBe(2);
    expect(result.findings.map((f) => f.criterionKey)).toEqual(['b']);
  });

  it('returns ok:true, checked:0 when no criteria carry any SQL', async () => {
    const result = await validateRubricReplicationSql([
      { key: 'a', replication: 'work_items:get on 3 recently-placed items; compare the brief text.' },
    ]);
    expect(result).toEqual({
      checked: 0,
      findings: [],
      undeterminable: [],
      placeholderOnly: 0,
      ok: true,
      summary: 'no embedded drill SQL to check',
    });
  });

  // ── EI-19988213173207009: bind placeholders ────────────────────────────────────────

  it('reports NO finding for a parameterised drill that is otherwise clean (the reported bug)', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'goal-spend',
        replication:
          'SELECT tick_at, ideas_generated FROM harness_shared.scout_ticks ' +
          'WHERE workspace_id = :ws AND tick_at > :run_start ORDER BY tick_at DESC LIMIT 5;',
      },
    ]);
    // Pre-fix this was `findings: [1x 42601 syntax error at or near ":"]`, i.e. pure noise.
    expect(result.findings).toEqual([]);
    expect(result.undeterminable).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(1);
    expect(result.placeholderOnly).toBe(1);
    expect(result.summary).toContain('0 real finding(s)');
    expect(result.summary).toContain('1 parameterised drill(s) clean');
  });

  it('CATCHES a real bad column inside a parameterised drill — coverage the 42601 used to mask', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'ideation-quality',
        replication: 'SELECT ideas_count FROM harness_shared.scout_ticks WHERE workspace_id = :ws;',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].error.code).toBe('42703');
    expect(result.findings[0].criterionKey).toBe('ideation-quality');
    expect(result.findings[0].afterPlaceholderSubstitution).toBe(true);
    expect(result.findings[0].placeholders).toEqual([':ws']);
    // The reported SQL stays the drill AS AUTHORED, not our rewritten probe.
    expect(result.findings[0].sql).toContain(':ws');
    expect(result.findings[0].sql).not.toContain('NULL');
  });

  it('buckets an overload failure our own dummy literal could have caused as undeterminable', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'run-window',
        // date_trunc(unknown, unknown) is ambiguous — the drill's parameter type is unknowable here.
        replication: "SELECT date_trunc('day', :run_start) FROM harness_shared.scout_ticks;",
      },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.undeterminable).toHaveLength(1);
    expect(result.undeterminable[0].error.code).toBe('42725');
    expect(result.undeterminable[0].afterPlaceholderSubstitution).toBe(true);
    expect(result.undeterminable[0].undeterminableReason).toContain('ambiguous function');
    expect(result.summary).toContain('1 undeterminable');
  });

  it('separates real defects from placeholder noise in one mixed rubric (the goal-mode-e2e shape)', async () => {
    const result = await validateRubricReplicationSql([
      {
        key: 'parameterised-1',
        replication: 'SELECT tick_at FROM harness_shared.scout_ticks WHERE workspace_id = :ws;',
      },
      {
        key: 'parameterised-2',
        replication: 'SELECT ideas_generated FROM harness_shared.scout_ticks WHERE workspace_id = :subject;',
      },
      {
        key: 'real-defect',
        replication: 'SELECT * FROM harness_shared.nope_not_a_table WHERE a = :ws;',
      },
    ]);
    expect(result.checked).toBe(3);
    expect(result.placeholderOnly).toBe(2);
    // The reviewer reads ONE real finding instead of hand-separating three.
    expect(result.findings.map((f) => f.criterionKey)).toEqual(['real-defect']);
    expect(result.findings[0].error.code).toBe('42P01');
    expect(result.ok).toBe(false);
  });
});
