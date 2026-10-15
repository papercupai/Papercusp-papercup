/**
 * Pins agent-insights/identifier-uniqueness-scopes — the identifier inventory of plan
 * scope-unique-identifiers-2026-07-26 (item P-001, acceptance BAR R-9) — to the code it describes.
 *
 * The page is a census: every identifier scheme, the key that actually enforces its uniqueness,
 * and whether the id is quoted outside that scope. Two parts of it drift silently:
 *   1. a scheme row can be dropped, or left with an empty "Enforced key" cell;
 *   2. the work-items row can keep describing the pre-1444 keys after the migration arms. It did:
 *      on 2026-10-11 the page still called migration 1444 "a draft" after it had been applied.
 *
 * Part 2 is DERIVED from the migration SQL, not hand-maintained: whenever an armed migration (a
 * `.sql` file, never a `.DRAFT`) creates a UNIQUE index on harness_shared.work_items
 * (workspace_id, feature_id), the page must name that key and must not carry the
 * "until 1444 is armed" caveat.
 *
 * The .mdx is a generated projection of the Postgres-canonical doc: fix the doc with
 * docs:author { overwrite: true }, never by editing the .mdx. The controls at the bottom keep the
 * checker falsifiable (each feeds a deliberately broken copy and expects a violation).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const REPO = new URL('../../../../', import.meta.url);
const PAGE = readFileSync(
  new URL('apps/operator-docs/src/content/docs/agent-insights/identifier-uniqueness-scopes.mdx', REPO),
  'utf8',
);
const SQL_DIR = new URL('libs/papercusp/libs/db/sql/', REPO);

/** The schemes the P-001 inventory measured. Each must keep exactly one row in the page's tables. */
const INVENTORIED_SCHEMES: readonly { label: string; match: RegExp }[] = [
  { label: 'work items', match: /`WI-n`/ },
  { label: 'engineer issues', match: /`EI-`/ },
  { label: 'features', match: /`F-`/ },
  { label: 'plan slugs', match: /^Plan slugs$/ },
  { label: 'rubric refs', match: /^Rubric refs$/ },
  { label: 'plan items', match: /`P-NNN`/ },
  { label: 'decisions', match: /`D-NNN`/ },
  { label: 'spec clauses', match: /^Spec clauses$/ },
  { label: 'assertions', match: /`VAL-`/ },
  { label: 'harness slugs', match: /^Harness slugs$/ },
  { label: 'blueprints', match: /^Blueprints$/ },
  { label: 'docs', match: /^Docs$/ },
  { label: 'workspace ids', match: /^Workspace ids$/ },
  { label: 'event keys', match: /^Event keys/ },
  { label: 'fleet slugs', match: /^Fleet slugs$/ },
  { label: 'topic slugs', match: /^Topic slugs$/ },
  { label: 'routines', match: /^Routines$/ },
  { label: 'reports', match: /^Reports$/ },
  { label: 'code recipes', match: /^Code recipes$/ },
  { label: 'coord messages', match: /^Coord messages$/ },
  { label: 'owner directives', match: /^Owner directives/ },
  { label: 'test runs', match: /^Test runs/ },
  { label: 'owner and session ids', match: /`su-`/ },
  { label: 'memory ids', match: /^Memory ids$/ },
  { label: 'migration numbers', match: /^Migration numbers$/ },
];

const WORK_ITEMS_ROW = /`WI-n`/;
const WORKSPACE_UNIQUE_KEY = '(workspace_id, feature_id)';
const STALE_1444_CAVEAT = /Until migration 1444 is armed|1444, still a draft/;
const WORKSPACE_UNIQUE_DDL =
  /CREATE\s+UNIQUE\s+INDEX\b[^;]*?\bON\s+harness_shared\.work_items\s*(?:USING\s+\w+\s*)?\(\s*workspace_id\s*,\s*feature_id\s*\)/i;

interface SchemeRow {
  scheme: string;
  enforcedKey: string;
}

function cells(line: string): string[] | null {
  if (!line.startsWith('|')) return null;
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** Every body row of every table whose header carries both a `Scheme` and an `Enforced key` column. */
function schemeRows(page: string): SchemeRow[] {
  const lines = page.split('\n').map((line) => line.trim());
  const rows: SchemeRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = cells(lines[i] ?? '');
    if (!header) continue;
    const schemeCol = header.indexOf('Scheme');
    const keyCol = header.indexOf('Enforced key');
    if (schemeCol < 0 || keyCol < 0) continue;
    let j = i + 2; // skip the |---| separator
    for (; j < lines.length; j++) {
      const row = cells(lines[j] ?? '');
      if (!row) break;
      rows.push({ scheme: row[schemeCol] ?? '', enforcedKey: row[keyCol] ?? '' });
    }
    i = j;
  }
  return rows;
}

/** True when this migration SQL (comments stripped) creates UNIQUE (workspace_id, feature_id) on work_items. */
function ddlArmsWorkspaceUnique(sql: string): boolean {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return WORKSPACE_UNIQUE_DDL.test(code);
}

/** True when an ARMED migration (`*.sql`; a `.DRAFT` is invisible to every runner) creates that index. */
function workspaceUniqueArmed(sqlDir: URL): boolean {
  return readdirSync(sqlDir)
    .filter((name) => name.endsWith('.sql'))
    .some((name) => ddlArmsWorkspaceUnique(readFileSync(new URL(name, sqlDir), 'utf8')));
}

function inventoryViolations(page: string, armed: boolean): string[] {
  const rows = schemeRows(page);
  const out = new Set<string>();
  for (const { label, match } of INVENTORIED_SCHEMES) {
    const hits = rows.filter((row) => match.test(row.scheme));
    if (hits.length !== 1) out.add(`${label}: expected exactly one row, found ${hits.length}`);
  }
  for (const row of rows) {
    if (!row.enforcedKey) out.add(`row "${row.scheme}": empty Enforced key cell`);
  }
  if (armed) {
    const workItems = rows.find((row) => WORK_ITEMS_ROW.test(row.scheme));
    if (workItems && !workItems.enforcedKey.includes(WORKSPACE_UNIQUE_KEY)) {
      out.add(`work items: Enforced key omits ${WORKSPACE_UNIQUE_KEY} although an armed migration creates that unique index`);
    }
    if (STALE_1444_CAVEAT.test(page)) out.add('page still describes migration 1444 as unarmed');
  }
  return [...out];
}

describe('identifier-uniqueness-scopes inventory ↔ code', () => {
  it('derives from the armed migrations that UNIQUE (workspace_id, feature_id) holds on work_items', () => {
    // Positive control for the derivation: migration 1444 is armed, so a regex that silently
    // matched nothing would fail here instead of letting the work-items check pass vacuously.
    expect(workspaceUniqueArmed(SQL_DIR)).toBe(true);
  });

  it('keeps one row with an enforced key per inventoried scheme, and the work-items row states the armed key', () => {
    expect(schemeRows(PAGE).length).toBeGreaterThanOrEqual(INVENTORIED_SCHEMES.length);
    expect(inventoryViolations(PAGE, workspaceUniqueArmed(SQL_DIR))).toEqual([]);
  });
});

describe('identifier-uniqueness-scopes checker — controls', () => {
  it('flags a dropped scheme row', () => {
    expect(PAGE).toContain('`P-NNN`');
    const dropped = PAGE.split('\n')
      .filter((line) => !line.includes('`P-NNN`'))
      .join('\n');
    expect(inventoryViolations(dropped, true)).toContain('plan items: expected exactly one row, found 0');
  });

  it('flags an emptied Enforced key cell', () => {
    const emptied = PAGE.split('\n')
      .map((line) => (line.trim().startsWith('| Blueprints |') ? '| Blueprints |  | No | One per harness. |' : line))
      .join('\n');
    expect(emptied).not.toEqual(PAGE);
    expect(inventoryViolations(emptied, true)).toContain('row "Blueprints": empty Enforced key cell');
  });

  it('flags the pre-1444 work-items key and caveat once the index is armed, and accepts them before', () => {
    const armedClause = '; unique `(workspace_id, feature_id)` (`work_items_workspace_feature_id_uq`, migration 1444)';
    expect(PAGE).toContain(armedClause);
    const stale = `${PAGE.replace(armedClause, '')}\n\nUntil migration 1444 is armed, the database alone does not prevent a twin.\n`;
    const violations = inventoryViolations(stale, true);
    expect(violations).toContain(
      `work items: Enforced key omits ${WORKSPACE_UNIQUE_KEY} although an armed migration creates that unique index`,
    );
    expect(violations).toContain('page still describes migration 1444 as unarmed');
    // Calibration: before the index is armed, the same wording is correct, not a violation.
    expect(inventoryViolations(stale, false)).toEqual([]);
  });

  it('recognises only armed, uncommented DDL for the work-items workspace key', () => {
    expect(ddlArmsWorkspaceUnique('CREATE UNIQUE INDEX IF NOT EXISTS x\n  ON harness_shared.work_items (workspace_id, feature_id);')).toBe(true);
    expect(ddlArmsWorkspaceUnique('-- CREATE UNIQUE INDEX x ON harness_shared.work_items (workspace_id, feature_id);')).toBe(false);
    expect(ddlArmsWorkspaceUnique('CREATE UNIQUE INDEX x ON harness_shared.work_items (workspace_id, harness_slug, feature_id);')).toBe(false);
    expect(ddlArmsWorkspaceUnique('CREATE INDEX x ON harness_shared.work_items (workspace_id, feature_id);')).toBe(false);
  });
});
