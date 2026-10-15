/**
 * R-3 (enterprise-data-sources-2026-10-01, spec AUTO-BAR-R-3-P-009): the work-predicate lint
 * fails a claim or placement path that adds a hardcoded item_kind IN list, and no census
 * selection path decides claimability from its own kind list.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORK_SELECTION_CENSUS } from '../work-selection-census';
import { claimPathAnchors, lintClaimPathSources, lintWorkPredicateTree } from './work-predicate-lint';

// Repo root = packages/operator-core/lib/work-nature/../../../..
const ROOT = resolve(__dirname, '..', '..', '..', '..');

const ANCHOR = 'AND ${agentWorkWhereSql(sql)}';

/** A claim path whose kind decider is `body`, plus an unrelated listing function. */
function fixture(body: string, extra = ''): string {
  return [
    "import { agentWorkWhereSql, issueFamilyRouteSql } from './agent-work-predicate';",
    extra,
    'export async function claimFixture(sql: any, id: string) {',
    '  return sql`SELECT feature_id FROM harness_shared.work_items wi',
    '    WHERE wi.feature_id = ${id}',
    `      ${ANCHOR}`,
    `      ${body}`,
    '    LIMIT 1`;',
    '}',
    '',
    'export async function unrelatedRollup(sql: any) {',
    "  return sql`SELECT count(*) FROM harness_shared.work_items WHERE item_kind IN ('feature', 'chunk')`;",
    '}',
  ].join('\n');
}

function lintFixture(source: string) {
  return lintClaimPathSources([{ file: 'fixture/claim.ts', source, anchors: [ANCHOR] }]);
}

describe('work-predicate lint (R-3)', () => {
  it('fails a claim path that adds a hardcoded item_kind IN list', () => {
    const r = lintFixture(fixture("AND wi.item_kind IN ('bug', 'change', 'task')"));
    expect(r.unresolvedAnchors).toEqual([]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ file: 'fixture/claim.ts', scope: 'claimFixture', finding: 'sql-in-list' });
  });

  it('fails a NOT IN list and an ANY(ARRAY[...]) list', () => {
    expect(lintFixture(fixture("AND item_kind NOT IN ('chunk')")).violations.map((v) => v.finding)).toEqual([
      'sql-in-list',
    ]);
    expect(
      lintFixture(fixture("AND wi.item_kind = ANY (ARRAY['feature', 'chunk'])")).violations.map((v) => v.finding),
    ).toEqual(['sql-any-array']);
  });

  it('follows a kind list hoisted to a module-level const the claim path references', () => {
    const r = lintFixture(
      fixture('AND wi.item_kind = ANY(${CLAIM_KINDS})', "const CLAIM_KINDS = ['bug', 'change'];"),
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ scope: 'CLAIM_KINDS', finding: 'kind-array' });
  });

  it('follows a same-file helper the claim path calls', () => {
    const helper = "function kindGate(sql: any) { return sql`wi.item_kind IN ('bug', 'task')`; }";
    const r = lintFixture(fixture('AND ${kindGate(sql)}', helper));
    expect(r.violations.map((v) => [v.scope, v.finding])).toEqual([['kindGate', 'sql-in-list']]);
  });

  it('passes the shared route surface, a comment, and code no claim path reaches', () => {
    const r = lintFixture(
      fixture("AND ${issueFamilyRouteSql(sql, 'wi')} -- routed, not gated", "// item_kind IN ('bug', 'change')"),
    );
    // unrelatedRollup carries a literal list but no claim path references it.
    expect(r.violations).toEqual([]);
    expect(r.scopes).toEqual([{ file: 'fixture/claim.ts', names: ['claimFixture'] }]);
  });

  it('reports an anchor it cannot find instead of scanning nothing', () => {
    const r = lintClaimPathSources([{ file: 'fixture/claim.ts', source: fixture(''), anchors: ['no such anchor'] }]);
    expect(r.unresolvedAnchors).toEqual([{ file: 'fixture/claim.ts', anchor: 'no such anchor' }]);
    expect(r.scopes).toEqual([{ file: 'fixture/claim.ts', names: [] }]);
  });

  it('scans every census selection path, and none carries its own kind list', () => {
    const selection = WORK_SELECTION_CENSUS.filter((row) => row.role === 'selection');
    expect(selection.length).toBeGreaterThan(0);
    const files = new Set(claimPathAnchors().map((e) => e.file));
    for (const row of selection) {
      expect(files.has(row.file)).toBe(true);
      for (const site of row.sites ?? []) expect(files.has(site.file)).toBe(true);
    }

    const r = lintWorkPredicateTree(ROOT);
    expect(r.unresolvedAnchors).toEqual([]);
    // Positive control: every resolved file contributed at least one scanned declaration.
    for (const scope of r.scopes) expect(scope.names.length, scope.file).toBeGreaterThan(0);
    expect(r.violations).toEqual([]);
  });
});
