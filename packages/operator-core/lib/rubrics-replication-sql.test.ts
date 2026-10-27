/**
 * rubrics-replication-sql.test.ts — pure unit coverage for the EI-10514 SQL-drill
 * extractor (extractReplicationSqlStatements). No DB: the async EXPLAIN validation
 * (validateRubricReplicationSql / explainReadQuery) is covered against real Postgres in
 * pg-read-query.integration.test.ts + rubrics-replication-sql.integration.test.ts.
 *
 * Fixtures below are drawn verbatim from LIVE stored rubric `replication` fields
 * (mug-pot-coordination-health, autoloop-release-readiness, ei10443-repro-drill,
 * su-agent-behavior) so the extractor is pinned against real authored drill prose, not
 * synthetic strings that happen to be easy.
 */
import { describe, it, expect } from 'vitest';
import {
  extractReplicationSqlStatements,
  substituteBindPlaceholders,
  summarizeReplicationSqlCheck,
  lintSqlCohortMethod,
  validateRubricReplicationSql,
} from './rubrics-replication-sql';

describe('SQL cohort method consistency', () => {
  const singleSql = "SELECT count(*) n FROM harness_shared.tool_invocations WHERE workspace_id='ws' AND tool_name='coord:orient' AND duration_ms>=0";
  const criterion = (sql = singleSql, method = 'Both named cohorts must have at least20 calls.') => ({
    key: 'wake-orient-latency', method, check: { kind: 'probe' as const, probe: { kind: 'sql' as const, sql } },
  });

  it('surfaces the live single-tool/two-cohort defect through the existing write validator', async () => {
    const result = await validateRubricReplicationSql([criterion()]);
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.findings).toMatchObject([{ criterionKey: 'wake-orient-latency', error: { code: 'METHOD_COHORT_MISMATCH' } }]);
    expect(result.summary).toContain('1 real finding');
  });

  it('accepts corrected single-cohort wording and genuine paired-cohort procedures', () => {
    expect(lintSqlCohortMethod(criterion(singleSql, 'Require at least20 calls in the single coord:orient cohort.'))).toEqual([]);
    expect(lintSqlCohortMethod(criterion("SELECT tool_name,count(*) FROM calls WHERE tool_name IN ('coord:presence','coord:inbox') GROUP BY tool_name"))).toEqual([]);
  });

  it('ignores SQL noise and does not guess dynamic or compound populations', () => {
    expect(lintSqlCohortMethod(criterion(singleSql + " /* tool_name IN ('other') */"))).toHaveLength(1);
    expect(lintSqlCohortMethod(criterion("SELECT 'tool_name=''coord:orient''' FROM calls"))).toEqual([]);
    expect(lintSqlCohortMethod(criterion('SELECT count(*) FROM calls WHERE tool_name=$1'))).toEqual([]);
    expect(lintSqlCohortMethod(criterion(singleSql + " OR tool_name='coord:inbox'"))).toEqual([]);
    expect(lintSqlCohortMethod({ ...criterion(), check: { kind: 'instrument', instrumentKey: 'none' } })).toEqual([]);
    expect(lintSqlCohortMethod({ ...criterion(), check: { kind: 'probe', probe: 'not a descriptor' } })).toEqual([]);
  });
});

describe('extractReplicationSqlStatements', () => {
  it('returns [] for undefined/null/empty text', () => {
    expect(extractReplicationSqlStatements(undefined)).toEqual([]);
    expect(extractReplicationSqlStatements(null)).toEqual([]);
    expect(extractReplicationSqlStatements('')).toEqual([]);
  });

  it('returns [] for prose with no embedded SQL', () => {
    expect(extractReplicationSqlStatements('fleet:assignments { harness } -> read summary.coverage')).toEqual([]);
  });

  it('extracts a semicolon-terminated statement, dropping trailing prose', () => {
    const text =
      "SELECT tick_at, frontier_depth, placements, cups_busy, cups_cap FROM harness_shared.pot_throughput_ticks " +
      "WHERE workspace_id='papercusp-workspace' AND tick_at > now()-interval '24 hours' ORDER BY tick_at; " +
      "apply the stuck-run rule above; cross-check accounts:status before rating fail.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT tick_at, frontier_depth, placements, cups_busy, cups_cap FROM harness_shared.pot_throughput_ticks " +
        "WHERE workspace_id='papercusp-workspace' AND tick_at > now()-interval '24 hours' ORDER BY tick_at",
    ]);
  });

  it('finds the SELECT after a leading tool-call prefix ("accounts:status + SELECT …")', () => {
    const text =
      "accounts:status + SELECT status, gate, count(*) FROM harness_shared.scout_ticks " +
      "WHERE tick_at > now()-interval '48 hours' GROUP BY 1,2;";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT status, gate, count(*) FROM harness_shared.scout_ticks WHERE tick_at > now()-interval '48 hours' GROUP BY 1,2",
    ]);
  });

  it('extracts a statement that runs to end-of-field, stripping one trailing sentence period', () => {
    const text =
      "REPLICATION DRILL: sentinel-ei10443-payload — this exact string must survive rubrics:ratify. Verify: " +
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans " +
      "WHERE plan_slug='ei10443-repro-drill')) c WHERE c->>'replication' LIKE '%sentinel-ei10443-payload%'.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans " +
        "WHERE plan_slug='ei10443-repro-drill')) c WHERE c->>'replication' LIKE '%sentinel-ei10443-payload%'",
    ]);
  });

  it('does not re-extract a nested/subquery SELECT as its own statement', () => {
    const text =
      "SELECT count(*) FROM jsonb_array_elements((SELECT template_data->'criteria' FROM harness_shared.harness_plans)) c;";
    expect(extractReplicationSqlStatements(text)).toHaveLength(1);
  });

  // The real regression this extractor exists to avoid: a query with NO semicolon that
  // is immediately followed by more prose containing its OWN semicolon much later. A
  // naive "capture to the first `;` anywhere in the field" would glue unrelated prose
  // onto valid SQL and manufacture a false-positive syntax error.
  it('stops at a bare sentence-ending period, not a later unrelated semicolon', () => {
    const text =
      "GRADE: SELECT tool_name, status, args_json, invoked_at FROM harness_shared.tool_invocations " +
      "WHERE coord_owner_id='<subject>' ORDER BY invoked_at. Count calls with tool_name LIKE 'plur%' " +
      "or any blocked/hallucinated-tool error; find the longest run of IDENTICAL blocked calls.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT tool_name, status, args_json, invoked_at FROM harness_shared.tool_invocations " +
        "WHERE coord_owner_id='<subject>' ORDER BY invoked_at",
    ]);
  });

  it('never treats a `;` inside a string literal as a terminator', () => {
    const text = "SELECT * FROM foo WHERE reason = 'text; more text' AND ok = true.";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT * FROM foo WHERE reason = 'text; more text' AND ok = true",
    ]);
  });

  it('never treats a `.`+whitespace inside a string literal as a terminator', () => {
    const text = "SELECT * FROM foo WHERE note = 'e.g. this is fine' ORDER BY id;";
    expect(extractReplicationSqlStatements(text)).toEqual([
      "SELECT * FROM foo WHERE note = 'e.g. this is fine' ORDER BY id",
    ]);
  });

  it('handles a schema-qualified dotted identifier without splitting on it', () => {
    expect(extractReplicationSqlStatements('SELECT * FROM harness_shared.autoloop_state LIMIT 10;')).toEqual([
      'SELECT * FROM harness_shared.autoloop_state LIMIT 10',
    ]);
  });

  it('extracts multiple independent statements from one field', () => {
    const text =
      "SELECT 1 AS a; some connecting prose. SELECT 2 AS b;";
    expect(extractReplicationSqlStatements(text)).toEqual(['SELECT 1 AS a', 'SELECT 2 AS b']);
  });

  it('extracts a WITH…SELECT (CTE) as one statement', () => {
    const text = 'WITH t AS (SELECT 1 AS n) SELECT * FROM t;';
    expect(extractReplicationSqlStatements(text)).toEqual(['WITH t AS (SELECT 1 AS n) SELECT * FROM t']);
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(extractReplicationSqlStatements('select 1 as n;')).toEqual(['select 1 as n']);
  });
});

/**
 * EI-19988213173207009 — bind placeholders. These are the guard against the failure mode
 * that made the fix necessary in the first place: substituting in the WRONG place would
 * mangle valid SQL and manufacture fresh false findings, which is strictly worse than the
 * 42601 noise being removed. Every "leaves … untouched" case below is a real SQL construct
 * that contains a colon.
 */
describe('substituteBindPlaceholders', () => {
  it('leaves a statement with no placeholders byte-identical', () => {
    const sql = "SELECT count(*) FROM t WHERE a = 'x' AND b > 3";
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('substitutes an untyped NULL for a :name placeholder and reports the token', () => {
    expect(substituteBindPlaceholders('SELECT 1 FROM t WHERE ws = :ws')).toEqual({
      sql: 'SELECT 1 FROM t WHERE ws = NULL',
      placeholders: [':ws'],
    });
  });

  it('reports several placeholders in order of first appearance, deduped', () => {
    const r = substituteBindPlaceholders(
      'SELECT 1 FROM t WHERE ws = :ws AND s = :subject AND ws2 = :ws AND ts > :run_start',
    );
    expect(r.placeholders).toEqual([':ws', ':subject', ':run_start']);
    expect(r.sql).toBe(
      'SELECT 1 FROM t WHERE ws = NULL AND s = NULL AND ws2 = NULL AND ts > NULL',
    );
  });

  it('never touches the :: cast operator', () => {
    const sql = 'SELECT 1 FROM t WHERE a = b::text AND c = d::int';
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('substitutes a placeholder that is itself cast, keeping the cast', () => {
    expect(substituteBindPlaceholders('SELECT 1 WHERE a = :ws::text')).toEqual({
      sql: 'SELECT 1 WHERE a = NULL::text',
      placeholders: [':ws'],
    });
  });

  it('leaves a colon inside a single-quoted string literal untouched', () => {
    const sql = "SELECT 1 FROM t WHERE label = '12:30 and :notaparam'";
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it("handles a doubled '' escape without losing string state", () => {
    const sql = "SELECT 1 FROM t WHERE a = 'it''s :not a param' AND b = :real";
    expect(substituteBindPlaceholders(sql)).toEqual({
      sql: "SELECT 1 FROM t WHERE a = 'it''s :not a param' AND b = NULL",
      placeholders: [':real'],
    });
  });

  it('leaves a colon inside a double-quoted identifier untouched', () => {
    const sql = 'SELECT "weird:col" FROM t';
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('leaves an array slice (x[1:3]) untouched — a digit is not an identifier start', () => {
    const sql = 'SELECT arr[1:3] FROM t';
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('leaves a bare colon followed by whitespace untouched', () => {
    const sql = 'SELECT 1 FROM t -- note: see the drill';
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('leaves a colon-identifier inside a line comment untouched', () => {
    const sql = 'SELECT 1 FROM t -- TODO:fixme later\nWHERE a = :ws';
    expect(substituteBindPlaceholders(sql)).toEqual({
      sql: 'SELECT 1 FROM t -- TODO:fixme later\nWHERE a = NULL',
      placeholders: [':ws'],
    });
  });

  it('leaves a colon-identifier inside a nested block comment untouched', () => {
    const sql = 'SELECT 1 /* outer /* :inner */ :still */ FROM t WHERE a = :ws';
    expect(substituteBindPlaceholders(sql)).toEqual({
      sql: 'SELECT 1 /* outer /* :inner */ :still */ FROM t WHERE a = NULL',
      placeholders: [':ws'],
    });
  });

  it('leaves a colon-identifier inside a dollar-quoted body untouched', () => {
    const sql = "SELECT $tag$ :notaparam $tag$ FROM t WHERE a = :ws";
    expect(substituteBindPlaceholders(sql)).toEqual({
      sql: 'SELECT $tag$ :notaparam $tag$ FROM t WHERE a = NULL',
      placeholders: [':ws'],
    });
  });

  it('never mistakes := for a placeholder', () => {
    const sql = 'SELECT 1 FROM t WHERE a := 3';
    expect(substituteBindPlaceholders(sql)).toEqual({ sql, placeholders: [] });
  });

  it('substitutes a placeholder at the very end of the statement', () => {
    expect(substituteBindPlaceholders('SELECT 1 FROM t LIMIT :n')).toEqual({
      sql: 'SELECT 1 FROM t LIMIT NULL',
      placeholders: [':n'],
    });
  });
});

describe('summarizeReplicationSqlCheck', () => {
  const base = { checked: 0, findings: [], undeterminable: [], placeholderOnly: 0, ok: true };

  it('says so plainly when there was nothing to check', () => {
    expect(summarizeReplicationSqlCheck(base)).toBe('no embedded drill SQL to check');
  });

  it('leads with the REAL count so a reviewer never re-derives the split', () => {
    expect(summarizeReplicationSqlCheck({ ...base, checked: 19, placeholderOnly: 16 })).toBe(
      '19 statement(s) checked · 0 real finding(s) · 16 parameterised drill(s) clean once bind placeholders were substituted',
    );
  });

  it('names the undeterminable bucket when it is non-empty', () => {
    const summary = summarizeReplicationSqlCheck({
      ...base,
      checked: 3,
      undeterminable: [
        { criterionKey: 'k', sql: 'SELECT 1', error: { message: 'x', code: '42725' } },
      ],
    });
    expect(summary).toContain('1 undeterminable');
    expect(summary).toContain('see undeterminable[]');
  });
});
