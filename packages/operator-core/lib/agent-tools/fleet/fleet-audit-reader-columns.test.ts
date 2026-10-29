import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { defaultFleetAuditReaders } from './fleet-audit';

// WI-135860. fleet-audit.test.ts injects a fake reader for all five legs, so the SQL in
// defaultReaders is never executed by any test. That is how `harness_slug` — not a column on
// harness_shared.adv_sessions — sat in the sessions reader throwing 42703 on every real call
// while the suite stayed 6/6 green; only a human-driven live call ever caught it.
//
// The obvious guard is barred: EI-19311807188719573 forbids unit tests from touching a real DB.
// So this is the derived-truth-ladder PIN rung instead — no connection, no testcontainer:
//   1. run each real reader against a RECORDING `sql` tagged template that captures the SQL and
//      returns no rows. The reader code actually executes, so the captured text is what the
//      reader really emits, including its conditional `${cond ? sql`...` : sql``}` branches.
//   2. assert every column identifier that SQL names exists on the table it is read from,
//      according to the checked-in schema snapshot that pull-schema.mjs regenerates.
//
// This cannot drift the way a hand-copied column list would: it re-derives the column set from
// the reader source on every run.

const SCHEMA_SNAPSHOT = join(
  __dirname,
  '../../../../../libs/papercusp/libs/db/src/schema/generated.ts',
);

/**
 * Recording tagged template: captures SQL, returns no rows, satisfies the `Sql` call shape.
 * A nested `sql``` fragment records itself as its own entry; callers join every capture, so a
 * conditional fragment's text is still checked even though it splices into its parent as a
 * bound-value placeholder.
 */
function recordingSql(): { sql: Sql; captured: string[] } {
  const captured: string[] = [];
  const tag = (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
    const parts = Array.isArray(strings) ? strings : Array.from(strings);
    // Placeholders become a neutral token so a bound value can never look like an identifier.
    const text = parts.reduce(
      (acc, part, i) => acc + part + (i < values.length ? ' $P ' : ''),
      '',
    );
    captured.push(text);
    return Promise.resolve([]);
  };
  // `sql.array(...)` is used for the ownerIds bindings.
  (tag as unknown as { array: (v: unknown) => unknown }).array = (v: unknown) => v;
  return { sql: tag as unknown as Sql, captured };
}

const SCOPE = {
  workspaceId: 'workspace-a',
  fleetSlug: 'fleet-a',
  harnessSlug: 'papercusp',
  sinceAt: '2026-08-26T09:00:00.000Z',
  snapshotAt: '2026-08-27T09:00:00.000Z',
  ownerIds: ['su-a', 'su-b'],
  nowMs: Date.parse('2026-08-27T09:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// Schema snapshot -> { table: Set<column> }
// ---------------------------------------------------------------------------

const snakeCase = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function parseHarnessSharedSchema(source: string): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const tableRe = /harnessShared\.table\(\s*"([a-z0-9_]+)"\s*,\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(source)) !== null) {
    const tableName = match[1];
    const body = source.slice(match.index + match[0].length);
    // The column object literal ends at the first line closing it at column 0:
    // `}, (table) => [` or `});`.
    const endIdx = body.search(/\n\}/);
    const columnBlock = endIdx === -1 ? body : body.slice(0, endIdx);
    const columns = new Set<string>();
    for (const line of columnBlock.split('\n')) {
      // `  workspaceId: text("workspace_id").notNull(),`  -> workspace_id
      // `  mode: text().notNull(),`                       -> mode  (implicit snake_case)
      // `  id: bigserial({ mode: "bigint" })...`          -> id    (options object, not a name)
      const col = /^\s+([A-Za-z0-9_]+):\s*[A-Za-z0-9_]+\((.?)/.exec(line);
      if (!col) continue;
      if (col[2] === '"') {
        const named = /^\s+[A-Za-z0-9_]+:\s*[A-Za-z0-9_]+\("([a-z0-9_]+)"/.exec(line);
        if (named) columns.add(named[1]);
      } else {
        columns.add(snakeCase(col[1]));
      }
    }
    if (columns.size > 0) tables.set(tableName, columns);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// SQL -> column references, attributed to a table
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  'with', 'as', 'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral', 'using',
  'order', 'by', 'group', 'having', 'limit', 'offset', 'distinct', 'union', 'all',
  'asc', 'desc', 'nulls', 'first', 'last', 'over', 'partition', 'case', 'when', 'then',
  'else', 'end', 'between', 'like', 'ilike', 'any', 'exists', 'true', 'false',
  'text', 'timestamptz', 'jsonb', 'int', 'integer', 'bigint', 'boolean', 'numeric',
  'harness_shared', 'public', 'p',
]);

interface Extraction {
  tables: string[];
  qualified: Array<{ alias: string; column: string }>;
  bare: string[];
  aliasToTable: Map<string, string>;
}

function extractColumnRefs(rawSql: string): Extraction {
  // Strip string literals so their contents can never look like identifiers.
  const sql = rawSql.replace(/'[^']*'/g, " '' ");

  const aliasToTable = new Map<string, string>();
  const tables: string[] = [];
  const tableRe =
    /\b(?:FROM|JOIN)\s+harness_shared\.([a-z0-9_]+)(?:\s+(?:AS\s+)?([a-z][a-z0-9_]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(sql)) !== null) {
    const table = m[1];
    tables.push(table);
    aliasToTable.set(table, table);
    const alias = m[2];
    if (alias && !SQL_KEYWORDS.has(alias.toLowerCase())) aliasToTable.set(alias, table);
  }

  // Names the query introduces itself are not columns of any table.
  const declared = new Set<string>();
  // Every CTE in a WITH list, not just the first: `WITH a AS (…), ranked AS (…)`.
  for (const cte of sql.matchAll(
    /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*([a-z0-9_]+)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi,
  )) declared.add(cte[1]);
  for (const alias of sql.matchAll(/\bAS\s+([a-z0-9_]+)/gi)) declared.add(alias[1]);
  // Lateral column aliases: `) h(value)`
  for (const lat of sql.matchAll(/\)\s*([a-z0-9_]+)\s*\(([^)]*)\)/gi)) {
    declared.add(lat[1]);
    for (const part of lat[2].split(',')) {
      const name = part.trim();
      if (name) declared.add(name);
    }
  }

  const qualified: Array<{ alias: string; column: string }> = [];
  for (const ref of sql.matchAll(/\b([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/gi)) {
    if (ref[1].toLowerCase() === 'harness_shared') continue;
    qualified.push({ alias: ref[1], column: ref[2] });
  }

  // Bare identifiers are only attributable when exactly one real table is in play.
  const bare: string[] = [];
  const uniqueTables = Array.from(new Set(tables));
  if (uniqueTables.length === 1) {
    // Drop qualified refs, function calls and casts before looking at what is left.
    const stripped = sql
      .replace(/\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/gi, ' ')
      .replace(/\b([a-z][a-z0-9_]*)\s*\(/gi, ' ( ')
      .replace(/::\s*[a-z][a-z0-9_]*(\[\])?/gi, ' ');
    for (const id of stripped.matchAll(/\b([a-z][a-z0-9_]*)\b/gi)) {
      const name = id[1];
      if (SQL_KEYWORDS.has(name.toLowerCase())) continue;
      if (declared.has(name)) continue;
      if (aliasToTable.has(name)) continue;
      bare.push(name);
    }
  }

  return { tables: uniqueTables, qualified, bare, aliasToTable };
}

/**
 * Returns the columns this SQL names that the schema does not have, AND how many references
 * were actually resolved against a real table. The `checked` count is the positive control:
 * an empty `unknown` list means nothing only if `checked` is also 0 (the extractor matched
 * nothing at all), which is indistinguishable from a clean result without it.
 */
function auditColumns(
  rawSql: string,
  schema: Map<string, Set<string>>,
): { unknown: string[]; checked: number } {
  const { qualified, bare, aliasToTable, tables } = extractColumnRefs(rawSql);
  const problems: string[] = [];
  const resolved = new Set<string>();

  for (const { alias, column } of qualified) {
    const table = aliasToTable.get(alias);
    if (!table) continue; // an alias we cannot resolve (e.g. a lateral) proves nothing
    const columns = schema.get(table);
    if (!columns) continue;
    resolved.add(`${table}.${column}`);
    if (!columns.has(column)) problems.push(`${table}.${column}`);
  }

  if (tables.length === 1) {
    const columns = schema.get(tables[0]);
    if (columns) {
      for (const name of bare) {
        resolved.add(`${tables[0]}.${name}`);
        if (!columns.has(name)) problems.push(`${tables[0]}.${name}`);
      }
    }
  }

  return { unknown: Array.from(new Set(problems)).sort(), checked: resolved.size };
}

const unknownColumns = (rawSql: string, schema: Map<string, Set<string>>): string[] =>
  auditColumns(rawSql, schema).unknown;

// ---------------------------------------------------------------------------

const schema = parseHarnessSharedSchema(readFileSync(SCHEMA_SNAPSHOT, 'utf8'));

const READERS = [
  'membership',
  'sessions',
  'currentClaims',
  'claimTransitions',
  'completions',
] as const;

async function captureReaderSql(
  name: (typeof READERS)[number],
  harnessSlug: string | null,
): Promise<string> {
  const { sql, captured } = recordingSql();
  const reader = defaultFleetAuditReaders[name] as (
    input: typeof SCOPE,
    sql: Sql,
  ) => Promise<unknown>;
  await reader({ ...SCOPE, harnessSlug } as typeof SCOPE, sql);
  return captured.join('\n');
}

describe('fleet:audit defaultReaders name only columns that exist', () => {
  it('parses the checked-in schema snapshot (positive control)', () => {
    // Without this, every assertion below would pass vacuously on an empty parse.
    expect(schema.size).toBeGreaterThan(50);
    const advSessions = schema.get('adv_sessions');
    expect(advSessions).toBeDefined();
    expect(advSessions!.has('coord_owner_id')).toBe(true);
    expect(advSessions!.has('started_at')).toBe(true);
    // The exact column whose absence caused the 42703 this guard exists to catch.
    expect(advSessions!.has('harness_slug')).toBe(false);
    // ...and it genuinely exists elsewhere, so the check above is about the table, not the name.
    expect(schema.get('work_items')!.has('harness_slug')).toBe(true);
  });

  for (const name of READERS) {
    for (const harnessSlug of [null, 'papercusp']) {
      it(`${name} (harnessSlug=${harnessSlug ?? 'null'}) references only real columns`, async () => {
        const sql = await captureReaderSql(name, harnessSlug);
        expect(sql.length).toBeGreaterThan(0);
        const { unknown, checked } = auditColumns(sql, schema);
        // Positive control FIRST: an empty `unknown` proves nothing if nothing was resolved.
        // The floor is the measured minimum across all ten cases — claimTransitions with no
        // harness filter, which resolves exactly 3 (wi.workspace_id, wi.feature_id,
        // wi.worked_by_history; its `h.value` lateral refs are deliberately unresolvable).
        // It exists to catch checked===0, i.e. an extractor that silently matched nothing.
        expect(checked, `${name} resolved too few columns to be meaningful`).toBeGreaterThanOrEqual(3);
        expect(unknown).toEqual([]);
      });
    }
  }

  it('every reader actually reads a harness_shared table (probe is not silently empty)', async () => {
    for (const name of READERS) {
      const sql = await captureReaderSql(name, 'papercusp');
      expect(extractColumnRefs(sql).tables.length, `${name} named no table`).toBeGreaterThan(0);
    }
  });

  // Falsifiability controls, kept permanently in the test rather than mutating the shared tree
  // (a copy-out/in-tree mutation probe races git-sync's sweep). These are the pre-fix shapes.
  describe('the detector catches the defect it was built for', () => {
    it('catches a bare column that does not exist on the single table read', () => {
      const preFixSessionsSql = `
        WITH ranked AS (
          SELECT coord_owner_id, id, agent, harness_slug, started_at,
                 row_number() OVER (PARTITION BY coord_owner_id ORDER BY started_at DESC) AS rn
            FROM harness_shared.adv_sessions
           WHERE workspace_id =  $P  AND harness_slug =  $P )
        SELECT * FROM ranked WHERE rn <=  $P `;
      expect(unknownColumns(preFixSessionsSql, schema)).toEqual(['adv_sessions.harness_slug']);
    });

    it('catches a qualified column that does not exist on the aliased table', () => {
      const bogus = `
        SELECT wi.feature_id, wi.no_such_column
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id =  $P `;
      expect(unknownColumns(bogus, schema)).toEqual(['work_items.no_such_column']);
    });

    it('does not flag legitimate CTE names, output aliases or lateral aliases', () => {
      const legitimate = `
        WITH ranked AS (
          SELECT h.value->>'owner' AS owner_id, wi.feature_id
            FROM harness_shared.work_items wi
            CROSS JOIN LATERAL jsonb_array_elements(wi.worked_by_history) h(value)
           WHERE wi.workspace_id =  $P )
        SELECT owner_id, feature_id FROM ranked ORDER BY owner_id`;
      expect(unknownColumns(legitimate, schema)).toEqual([]);
    });
  });
});
