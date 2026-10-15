/**
 * Pins agent-insights/identifier-scope-invariant — the normative convention of plan
 * scope-unique-identifiers-2026-07-26 (item P-002) — to the code it describes.
 *
 * The page says how each id scheme complies with the invariant and which lookups refuse an
 * ambiguous id. Those are statements about code, and they drifted: on 2026-10-11 the page
 * still called migration 1444 "a draft", listed two refusal gaps that had already been
 * closed, and called the P-007 recurrence guard "planned".
 *
 * Every expectation below is DERIVED from the code, never hand-maintained:
 *   1. An armed migration creates UNIQUE (workspace_id, feature_id) on work_items, so the page
 *      names that key beside 1444 and never calls 1444 a draft.
 *   2. rubrics.ts throws RubricRefAmbiguousError, so the page names `rubric_ref_ambiguous` and
 *      does not list the `LIMIT 1` rubric read as an open gap.
 *   3. issues-engineer.ts calls assertWorkspaceChoice, so the page names it and does not list
 *      the freshest-foreign-row fallback as an open gap.
 *   4. The P-007 guard module exists, so the page cites it and does not call it planned.
 *   5. Every repo path the page cites resolves.
 * When a fact is false (the code is reverted), the matching claim is not demanded, so the page
 * that described the pre-fix code passes against pre-fix code (see the controls).
 *
 * The .mdx is a generated projection of the Postgres-canonical doc: fix the doc with
 * docs:author { overwrite: true }, never by editing the file. The controls feed deliberately
 * broken copies, and the calibration test proves each detector sees the real code, so no
 * derived check can pass vacuously.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings, stripSqlComments } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const REPO = new URL('../../../../', import.meta.url);
const readRepo = (rel: string): string => readFileSync(new URL(rel, REPO), 'utf8');
const existsInRepo = (rel: string): boolean => existsSync(new URL(rel, REPO));

const PAGE = readRepo('apps/operator-docs/src/content/docs/agent-insights/identifier-scope-invariant.mdx');
const SQL_DIR = new URL('libs/papercusp/libs/db/sql/', REPO);
const RUBRICS = 'packages/operator-core/lib/rubrics.ts';
const ISSUES_ENGINEER = 'packages/operator-core/lib/issues-engineer.ts';
const GUARD = 'packages/operator-core/lib/db-schema-reference/harness-scoped-id-uniqueness.ts';

const WORKSPACE_UNIQUE_KEY = 'UNIQUE (workspace_id, feature_id)';
const WORKSPACE_UNIQUE_DDL =
  /CREATE\s+UNIQUE\s+INDEX\b[^;]*?\bON\s+harness_shared\.work_items\s*(?:USING\s+\w+\s*)?\(\s*workspace_id\s*,\s*feature_id\s*\)/i;
const RUBRIC_REFUSAL = /\bthrow\s+new\s+RubricRefAmbiguousError\s*\(/;
const WORKSPACE_REFUSAL_CALL = /\bassertWorkspaceChoice\s*\(/;

const STALE_1444 = /1444[^\n.]*\b(?:still\s+a\s+draft|is\s+a\s+draft|unarmed)\b|until\s+(?:migration\s+)?1444\s+is\s+armed/i;
const RUBRIC_GAP = /resolves?\s+a\s+rubric\s+ref\s+with\s+`?LIMIT 1/i;
const GETISSUE_GAP = /returns\s+the\s+freshest\s+foreign\s+row/i;
const GUARD_PLANNED = /planned\s+as\s+P-007|P-007[^\n.]*\bplanned\b/i;
const CITED_PATH = /[`"]((?:packages|scripts|libs|apps)\/[^`"\s]+)[`"]/g;

interface CodeFacts {
  workspaceUniqueArmed: boolean;
  rubricRefusesAmbiguousRef: boolean;
  getIssueRefusesSeveralWorkspaces: boolean;
  recurrenceGuardShipped: boolean;
}

/*
 * Masking goes through the shared parser-backed strippers (EI-25706078725120945). The TS facts
 * are CODE tokens (a `throw new …(` and a call), so comments AND strings are blanked; the SQL
 * fact is DDL that may sit inside a `DO $$ … $$` body, so SQL is comments-only.
 */
const codeOf = (src: string, fileName: string): string => stripCommentsAndStrings(src, fileName);

/** True when an ARMED migration (`*.sql`; a `.DRAFT` is invisible to every runner) creates the key. */
function workspaceUniqueArmed(sqlDir: URL): boolean {
  return readdirSync(sqlDir)
    .filter((name) => name.endsWith('.sql'))
    .some((name) => WORKSPACE_UNIQUE_DDL.test(stripSqlComments(readFileSync(new URL(name, sqlDir), 'utf8'))));
}

function measureCode(): CodeFacts {
  return {
    workspaceUniqueArmed: workspaceUniqueArmed(SQL_DIR),
    rubricRefusesAmbiguousRef: RUBRIC_REFUSAL.test(codeOf(readRepo(RUBRICS), RUBRICS)),
    getIssueRefusesSeveralWorkspaces: WORKSPACE_REFUSAL_CALL.test(codeOf(readRepo(ISSUES_ENGINEER), ISSUES_ENGINEER)),
    recurrenceGuardShipped: existsInRepo(GUARD),
  };
}

function invariantViolations(page: string, facts: CodeFacts, exists: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const lines = page.split('\n');
  if (facts.workspaceUniqueArmed) {
    if (!lines.some((line) => line.includes(WORKSPACE_UNIQUE_KEY) && line.includes('1444'))) {
      out.push(`no line names ${WORKSPACE_UNIQUE_KEY} with migration 1444 although an armed migration creates it`);
    }
    if (STALE_1444.test(page)) out.push('page still describes migration 1444 as a draft or unarmed');
  }
  if (facts.rubricRefusesAmbiguousRef) {
    if (!page.includes('rubric_ref_ambiguous')) out.push('page omits the rubric_ref_ambiguous refusal');
    if (RUBRIC_GAP.test(page)) out.push('page lists the LIMIT 1 rubric read as an open gap although it refuses');
  }
  if (facts.getIssueRefusesSeveralWorkspaces) {
    if (!page.includes('assertWorkspaceChoice')) out.push('page omits the assertWorkspaceChoice refusal');
    if (GETISSUE_GAP.test(page)) out.push('page lists the freshest-foreign-row fallback as an open gap although it refuses');
  }
  if (facts.recurrenceGuardShipped) {
    if (!page.includes(GUARD)) out.push(`page does not cite the recurrence guard ${GUARD}`);
    if (GUARD_PLANNED.test(page)) out.push('page still calls the P-007 recurrence guard planned');
  }
  for (const match of page.matchAll(CITED_PATH)) {
    const rel = match[1].replace(/[),.;:]+$/, '');
    if (!exists(rel)) out.push(`cited path does not resolve: ${rel}`);
  }
  return out;
}

const FACTS = measureCode();
const ALL_TRUE: CodeFacts = {
  workspaceUniqueArmed: true,
  rubricRefusesAmbiguousRef: true,
  getIssueRefusesSeveralWorkspaces: true,
  recurrenceGuardShipped: true,
};
const ALL_FALSE: CodeFacts = {
  workspaceUniqueArmed: false,
  rubricRefusesAmbiguousRef: false,
  getIssueRefusesSeveralWorkspaces: false,
  recurrenceGuardShipped: false,
};

/** Apply one edit to the page; refuse an edit that changed nothing, so no control is vacuous. */
function edit(page: string, from: string | RegExp, to: string): string {
  const out = page.replace(from, to);
  if (out === page) throw new Error(`control edit matched nothing: ${String(from)}`);
  return out;
}

/** The pre-fix text of the four drifted claims, as the page carried it before 2026-10-11 10:20Z. */
const PRE_FIX_LINES = [
  '| `WI-` + number | Minted from per-database disjoint ranges (P-010); `UNIQUE (workspace_id, feature_id)` is migration 1444, still a draft (P-012). |',
  '- Rubric reads resolve a rubric ref with `LIMIT 1` and no harness (WI-6554700010008395).',
  '- `getIssue` falls back across workspaces and returns the freshest foreign row when the ambient workspace lacks the id (WI-6554700010008365).',
  'A recurrence guard that fails on a new harness-scoped text key unless it is allowlisted with a reason is planned as P-007.',
].join('\n');

describe('identifier-scope-invariant page ↔ code', () => {
  it('measures every code fact the page describes (calibration: no derived check is vacuous)', () => {
    expect(FACTS).toEqual(ALL_TRUE);
  });

  it('states every enforcement claim the code supports, lists no closed gap, and cites only real paths', () => {
    expect(invariantViolations(PAGE, FACTS, existsInRepo)).toEqual([]);
  });
});

describe('identifier-scope-invariant checker — controls', () => {
  it('flags 1444 described as a draft, and a page that drops the 1444 key', () => {
    const draft = `${PAGE}\n${PRE_FIX_LINES.split('\n')[0]}`;
    expect(invariantViolations(draft, ALL_TRUE, existsInRepo)).toContain(
      'page still describes migration 1444 as a draft or unarmed',
    );
    const dropped = edit(PAGE, /through migration 1444/g, 'through a migration');
    expect(invariantViolations(dropped, ALL_TRUE, existsInRepo).join('\n')).toMatch(/no line names UNIQUE/);
  });

  it('flags the closed rubric and getIssue gaps re-listed as open, and their refusals omitted', () => {
    const gaps = `${PAGE}\n${PRE_FIX_LINES}`;
    const found = invariantViolations(gaps, ALL_TRUE, existsInRepo);
    expect(found).toContain('page lists the LIMIT 1 rubric read as an open gap although it refuses');
    expect(found).toContain('page lists the freshest-foreign-row fallback as an open gap although it refuses');
    const silent = edit(edit(PAGE, /rubric_ref_ambiguous/g, 'an error'), /assertWorkspaceChoice/g, 'a check');
    const missing = invariantViolations(silent, ALL_TRUE, existsInRepo);
    expect(missing).toContain('page omits the rubric_ref_ambiguous refusal');
    expect(missing).toContain('page omits the assertWorkspaceChoice refusal');
  });

  it('flags the shipped recurrence guard called planned, or left uncited', () => {
    const planned = `${PAGE}\n${PRE_FIX_LINES.split('\n')[3]}`;
    expect(invariantViolations(planned, ALL_TRUE, existsInRepo)).toContain(
      'page still calls the P-007 recurrence guard planned',
    );
    const uncited = edit(PAGE, new RegExp(GUARD.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'), 'the guard');
    expect(invariantViolations(uncited, ALL_TRUE, existsInRepo)).toContain(
      `page does not cite the recurrence guard ${GUARD}`,
    );
  });

  it('flags a cited path that does not resolve', () => {
    const ghost = `${PAGE}\nSee \`packages/operator-core/lib/no-such-module.ts\`.`;
    expect(invariantViolations(ghost, ALL_TRUE, existsInRepo)).toContain(
      'cited path does not resolve: packages/operator-core/lib/no-such-module.ts',
    );
  });

  it('accepts the pre-fix claims against pre-fix code: every check is derived, not hard-coded', () => {
    const preFix = edit(
      edit(edit(PAGE, /`UNIQUE \(workspace_id, feature_id\)`[^\n|]*1444 \(P-012\)\./, 'pending.'), /rubric_ref_ambiguous/g, 'x'),
      /assertWorkspaceChoice/g,
      'y',
    );
    const page = `${preFix}\n${PRE_FIX_LINES}`;
    expect(invariantViolations(page, ALL_FALSE, existsInRepo)).toEqual([]);
  });

  it('measures facts from code only: commented-out refusals and DDL do not count', () => {
    expect(RUBRIC_REFUSAL.test(codeOf('// throw new RubricRefAmbiguousError(id, hs);', 'x.ts'))).toBe(false);
    expect(RUBRIC_REFUSAL.test(codeOf('if (x) throw new RubricRefAmbiguousError(id, hs);', 'x.ts'))).toBe(true);
    expect(WORKSPACE_REFUSAL_CALL.test(codeOf('import { assertWorkspaceChoice } from "./x";', 'x.ts'))).toBe(false);
    expect(WORKSPACE_REFUSAL_CALL.test(codeOf('/* assertWorkspaceChoice(a, b, c, d); */', 'x.ts'))).toBe(false);
    // A quoted call is not a call: the prior regex stripper left string contents in place.
    expect(WORKSPACE_REFUSAL_CALL.test(codeOf('const msg = "assertWorkspaceChoice(a)";', 'x.ts'))).toBe(false);
    const ddl = 'CREATE UNIQUE INDEX work_items_ws_uq ON harness_shared.work_items (workspace_id, feature_id);';
    expect(WORKSPACE_UNIQUE_DDL.test(stripSqlComments(ddl))).toBe(true);
    expect(WORKSPACE_UNIQUE_DDL.test(stripSqlComments(`-- ${ddl}`))).toBe(false);
  });
});
