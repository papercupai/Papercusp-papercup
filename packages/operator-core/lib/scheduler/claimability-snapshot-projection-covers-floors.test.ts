/**
 * claimability-snapshot-projection-covers-floors.test.ts — WI-524804 recurrence guard.
 *
 * THE CLASS THIS KILLS: `issueClaimCandidateSubquery`'s `claimability-snapshot` projection
 * lists base columns EXPLICITLY (the base table has 80+ columns and the snapshot is
 * materialized, so a narrow projection is deliberate). On the `filterPushdown` path the outer
 * SELECT's FROM-source is the `filtered_claim_candidates` CTE rather than the base table — so
 * any column a floor references but the projection omits genuinely does not exist at the outer
 * level.
 *
 * That failure is SILENT in every cheap way:
 *   - no TypeScript error (it is SQL text, not a typed column set);
 *   - the non-pushdown path keeps working, because there `wi` IS the base table;
 *   - so it only breaks for callers passing a spec — i.e. in production, not in review.
 *
 * It has already cost a real regression. EI-21580597231511770 hit `column wi.lane does not
 * exist` (a spec-scoped repro, hence the pushdown path), concluded the STORED generated
 * column had been dropped, and "repaired" it by reverting observationLaneExclusionSql to
 * `COALESCE(payload,'{}')->>'lane'` — reintroducing the per-row JSONB detoast that migration
 * 721 (WI-6934) added the column expressly to eliminate, on the floor evaluated over the
 * LARGEST population of any floor. The column had never been removed; the projection had
 * dropped it.
 *
 * So this asserts the invariant directly, at the only place it is checkable: every `wi.<col>`
 * the rendered subquery references must be a column the projection actually projects.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/claimability-snapshot-projection-covers-floors.test.ts
 */
import { describe, expect, it } from 'vitest';
import { issueClaimCandidateSubquery } from './get-next';

/** Render the SQL text carried by the fake postgres.js fragments, including nested ones. */
function renderSqlFragment(fragment: unknown): string {
  if (fragment === undefined || fragment === null) return '';
  if (typeof fragment === 'string') return fragment;
  if (!fragment || typeof fragment !== 'object') return '?';
  const value = fragment as { strings?: unknown[]; args?: unknown[] };
  if (!Array.isArray(value.strings)) return '?';
  const args = value.args ?? [];
  return value.strings.map((part, index) => `${String(part)}${renderSqlFragment(args[index])}`).join('');
}

/** A postgres-js-shaped fake that only has to BUILD fragments: this subquery never awaits. */
type FakeFragment = { strings: readonly unknown[]; args: readonly unknown[] };
/** Callable AS a tagged template, plus the postgres-js helpers these builders reach for. */
type FakeHandle = ((strings: TemplateStringsArray, ...values: unknown[]) => FakeFragment) & {
  unsafe: (text: string) => FakeFragment;
  json: (value: unknown) => FakeFragment;
  array: (value: unknown) => FakeFragment;
};

function makeHandle(): FakeHandle {
  const handle = ((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: Array.from(strings),
    args: values,
  })) as unknown as FakeHandle;
  // `unsafe` interpolates trusted SQL STRUCTURE (an alias-qualified column name), so it must
  // render as its literal text rather than as a bound parameter.
  handle.unsafe = (text: string) => ({ strings: [text], args: [] });
  handle.json = () => ({ strings: ['?'], args: [] });
  handle.array = () => ({ strings: ['?'], args: [] });
  return handle;
}

/** Extract the substring of `text` starting at `open` (index of a '(') through its match. */
function balancedSlice(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced parentheses in rendered CTE');
}

/** Return only the outer SELECT list, excluding floor expressions after the projection. */
function outerSelectList(rendered: string): string {
  const text = stripComments(rendered).replace(/\s+/g, ' ');
  const cteStart = text.indexOf('(', text.indexOf('AS MATERIALIZED'));
  const cte = balancedSlice(text, cteStart);
  const outer = text.slice(cteStart + cte.length);
  const selectAt = outer.indexOf('SELECT');
  const fromAt = outer.indexOf('FROM filtered_claim_candidates wi');
  if (selectAt < 0 || fromAt <= selectAt) throw new Error('could not locate the outer SELECT list');
  return outer.slice(selectAt + 'SELECT'.length, fromAt);
}

function renderPushdownSubquery(): string {
  const sql = makeHandle();
  const compiled = sql`TRUE` as unknown as never;
  return renderSqlFragment(
    issueClaimCandidateSubquery(sql as never, {
      compiled,
      // A pushdown filter is what selects the CTE path — the only path with the defect.
      filterPushdown: sql`TRUE` as unknown as never,
      projection: 'claimability-snapshot',
      assignee: 'su-test',
      cooldown: 60,
      harness: 'papercusp',
      states: ['open'],
      issueWs: 'papercusp-workspace',
      operatorScopeSlug: 'operator:papercusp-workspace',
      rigAvailable: false,
    }),
  );
  // NOTE: returned with NEWLINES INTACT on purpose. Flattening here is what broke this file
  // twice: line comments are `--` to end-of-LINE, so any consumer that strips them after a
  // flatten deletes the rest of the statement. Callers that want one line flatten locally,
  // AFTER comments are stripped.
}

/** SQL line comments are documentation, not projected columns — strip them so a column
 *  merely NAMED in a comment can never satisfy the invariant. */
const stripComments = (s: string) => s.replace(/--[^\n]*/g, ' ');

const columnsIn = (s: string) => new Set([...stripComments(s).matchAll(/\bwi\.([a-z_]+)/g)].map((m) => m[1]!));

/**
 * THE INVARIANT, as a pure function so it can be aimed at a known-BAD input too.
 *
 * Returns the columns the rendered statement references but the CTE does not project — i.e.
 * the columns that will not exist at the outer level on the pushdown path. Empty = healthy.
 */
export function missingProjectedColumns(rendered: string): string[] {
  // ORDER IS LOAD-BEARING: strip line comments while newlines still exist, THEN flatten.
  // Flattening first turns every `--` into a comment that runs to the END of the statement,
  // so the detector silently sees almost no columns and reports a confident, empty "healthy".
  // That is not hypothetical — it is what this file did on its first run, and the real
  // assertion passed VACUOUSLY until the controls below caught it.
  const text = stripComments(rendered).replace(/\s+/g, ' ');
  const cteStart = text.indexOf('(', text.indexOf('AS MATERIALIZED'));
  const cte = balancedSlice(text, cteStart);

  const selectAt = cte.indexOf('SELECT');
  const fromAt = cte.indexOf('FROM harness_shared.work_items');
  if (selectAt < 0 || fromAt <= selectAt) throw new Error('could not locate the CTE projection list');

  const projected = columnsIn(cte.slice(selectAt + 'SELECT'.length, fromAt));

  // Only the OUTER references matter. Columns used INSIDE the CTE (its own WHERE — the
  // base-table scan, e.g. wi.item_kind / wi.status) resolve against harness_shared.work_items
  // and need no projection; demanding them would be a false positive that pressures the next
  // author to widen the projection the narrowness of which is the entire point.
  const outer = text.slice(cteStart + cte.length);
  return [...columnsIn(outer)].filter((col) => !projected.has(col)).sort();
}

describe('the projection-coverage detector itself is falsifiable', () => {
  // A guard that has never failed is a guard nobody has tested. This aims the SAME function
  // the real assertion uses at a deliberately-broken rendering: `lane` is referenced by a
  // floor at the outer level but absent from the CTE projection — precisely the WI-524804
  // shape. If this control ever returns [], the detector has stopped detecting and the
  // passing test below is worthless.
  const brokenRendering = `
    WITH filtered_claim_candidates AS MATERIALIZED (
      SELECT wi.workspace_id, wi.feature_id, wi.payload
      FROM harness_shared.work_items wi
      WHERE wi.status = ANY($1)
    )
    SELECT wi.workspace_id, wi.feature_id, wi.payload,
           (wi.lane IS DISTINCT FROM 'observation') AS ok_observation
    FROM filtered_claim_candidates wi
  `;

  it('reports a referenced-but-unprojected column', () => {
    expect(missingProjectedColumns(brokenRendering)).toEqual(['lane']);
  });

  it('reports nothing once that column is projected', () => {
    expect(missingProjectedColumns(brokenRendering.replace('wi.payload\n', 'wi.payload, wi.lane\n'))).toEqual(
      [],
    );
  });

  it('is not fooled by a column named only in a comment', () => {
    const commentOnly = brokenRendering.replace(
      'SELECT wi.workspace_id, wi.feature_id, wi.payload\n',
      'SELECT wi.workspace_id, wi.feature_id, wi.payload, -- wi.lane lives here\n',
    );
    expect(missingProjectedColumns(commentOnly)).toEqual(['lane']);
  });
});

describe('claimability-snapshot projection covers every column the floors reference', () => {
  it('renders the pushdown CTE form (guard precondition)', () => {
    const text = renderPushdownSubquery().replace(/\s+/g, ' ');
    // If this stops holding, the guard below is silently measuring the WRONG shape — the
    // non-pushdown form has `wi` bound to the base table, where every column resolves and
    // the invariant is vacuous.
    expect(text).toContain('filtered_claim_candidates');
    expect(text).toContain('AS MATERIALIZED');
  });

  it('keeps duplicate_of in the materialized snapshot row projection', () => {
    // The CTE source must expose duplicate_of for ok_admission, and the outer narrow
    // projection must retain it in the temp table shape for downstream snapshot consumers.
    // The latter is distinct from the floor expression, so isolate the outer SELECT list.
    expect(outerSelectList(renderPushdownSubquery())).toMatch(/\bwi\.duplicate_of\s*,/);
  });

  it('projects every wi.<column> referenced anywhere in the rendered subquery', () => {
    const text = renderPushdownSubquery();
    const missing = missingProjectedColumns(text);
    expect(
      missing,
      `claimability-snapshot projection omits column(s) the floors reference: ${missing.join(
        ', ',
      )}. On the filterPushdown path the outer SELECT reads the filtered_claim_candidates CTE, ` +
        `so an omitted column does not exist there — add it to baseColumns in ` +
        `issueClaimCandidateSubquery. Do NOT "fix" this by rewriting the floor to read payload ` +
        `instead (that is the WI-524804 regression).`,
    ).toEqual([]);
  });

  it('keeps the observation-lane floor on the generated column, not a payload detoast', () => {
    // Strip comments BEFORE flattening (see missingProjectedColumns) — otherwise the prose
    // in the projection comment, which legitimately mentions the payload form it replaced,
    // would be scanned as if it were SQL.
    const text = stripComments(renderPushdownSubquery()).replace(/\s+/g, ' ');
    // WI-524804: the floor runs over the largest population of any floor, so the difference
    // between a stored generated column and a per-row JSONB extraction is not cosmetic.
    expect(text).toContain('wi.lane IS DISTINCT FROM');
    expect(text).not.toMatch(/->>\s*'lane'/);
  });
});
