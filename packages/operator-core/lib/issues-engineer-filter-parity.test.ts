/**
 * issues-engineer-filter-parity.test.ts — WI-564691.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, stated once: `harness_shared.engineer_issues` is read
 * by five sibling functions that each hand-maintained their own copy of the same WHERE
 * clause — a row read (`listIssuesWithLimit`) and four aggregates (`countIssues`,
 * `countIssuesByState`, `countIssuesBySourceRole`, `countObservationsByKind`). Five filter
 * fields had drifted: `countIssuesByState` and `countObservationsByKind` silently dropped
 * `q` and `severities`, `countObservationsByKind` also dropped `titlePrefix` and
 * `excludeObservationLane`, and `watchdogKeyed` was honoured only by the row read.
 *
 * `q` is the one that reached a caller. `issues:list { q, rollup:'state' }` passes `q`
 * straight through, so the rollup counted the WHOLE issue population (126,956) while row
 * mode counted 8 — the same filter answering two ways, with no error to notice.
 *
 * WHY A SOURCE-LEVEL GUARD, and not "just an integration test": a missing predicate is
 * INVISIBLE to any test that does not think to pass that exact field. The integration
 * test in issues-engineer.integration.test.ts proves `q` narrows the rollup TODAY; it
 * says nothing about the sixth field someone adds tomorrow to one site and forgets at the
 * other four. This test is the one that generalises — it compares the sites to EACH OTHER,
 * so a new predicate added anywhere must be added everywhere (or routed through a shared
 * fragment) before it can land.
 *
 * That generality is the whole point. The previous line of defence was PROSE: the
 * `countIssuesBySourceRole` docblock accurately recorded that byState "omits `q` and
 * `severities`, which is safe for its callers" — and that remained sitting there,
 * unedited and no longer true, while a caller that passes `q` was added. A known
 * divergence written down in a comment is not a guard.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), 'issues-engineer.ts');

/** The five functions that turn a `ListIssuesFilter` into SQL against the issue view. */
const READERS = [
  'listIssuesWithLimit',
  'countIssues',
  'countIssuesByState',
  'countIssuesBySourceRole',
  'countObservationsByKind',
] as const;

/**
 * Options that are not membership predicates, though the source scanner sees them as
 * `filter.<field>` references. `limit` caps returned rows; `payloadProjection` selects
 * result columns and can choose metric ordering. Neither changes which issues match.
 * Keep this list narrow: every other field divergence remains a defect.
 */
const NON_PREDICATE_OPTIONS = new Set(['limit', 'payloadProjection']);

/** Shared WHERE fragments every reader must apply, so their predicates cannot drift. */
const SHARED_FRAGMENTS = ['issueShapeWhereSql', 'issueMatchWhereSql'] as const;

/**
 * The fields `issueMatchWhereSql` is responsible for. Pinned so that "parity" cannot be
 * restored the wrong way — by DELETING `q` from the shared fragment, which would make all
 * five sites agree while reintroducing the original bug at every one of them.
 */
const MATCH_FRAGMENT_FIELDS = [
  'q',
  'severity',
  'severities',
  'titlePrefix',
  'excludeObservationLane',
  'watchdogKeyed',
  'watchdogCloseRoutes',
] as const;

/** Line span of a top-level `function <name>` up to the next function in READERS order. */
function functionSpans(source: string, names: readonly string[]): Record<string, string> {
  const lines = source.split('\n');
  const starts: Array<[string, number]> = [];
  lines.forEach((line, i) => {
    for (const n of names) {
      if (new RegExp(`(export )?(async )?function ${n}\\b`).test(line)) starts.push([n, i]);
    }
  });
  starts.sort((a, b) => a[1] - b[1]);
  const out: Record<string, string> = {};
  starts.forEach(([name, start], idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1][1] : lines.length;
    out[name] = lines.slice(start, end).join('\n');
  });
  return out;
}

/** Every `filter.<field>` a function body references directly. */
function directFilterFields(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of body.matchAll(/filter\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1]);
  return out;
}

/**
 * The parity check itself, over an arbitrary source string so the CONTROLS below can
 * exercise it against known-divergent and known-agreeing input. Returns the offending
 * (field, functions-missing-it) pairs — empty means parity.
 */
export function findFilterDivergence(
  source: string,
  names: readonly string[] = READERS,
  exempt: ReadonlySet<string> = NON_PREDICATE_OPTIONS,
): Array<{ field: string; missingFrom: string[] }> {
  const bodies = functionSpans(source, names);
  const fields: Record<string, Set<string>> = {};
  for (const n of names) fields[n] = directFilterFields(bodies[n] ?? '');
  const all = new Set<string>(Object.values(fields).flatMap((s) => [...s]));
  const divergent: Array<{ field: string; missingFrom: string[] }> = [];
  for (const field of [...all].sort()) {
    if (exempt.has(field)) continue;
    const missingFrom = names.filter((n) => !fields[n].has(field));
    if (missingFrom.length > 0) divergent.push({ field, missingFrom: [...missingFrom] });
  }
  return divergent;
}

describe('issues-engineer filter parity across the row read and its aggregates', () => {
  const source = readFileSync(SOURCE, 'utf8');

  it('every reader applies the same filter fields (the row read may add only `limit`)', () => {
    // A divergence here is the WI-564691 defect class: a filter honoured by the list and
    // dropped by its count yields a plausible number, never an error.
    expect(findFilterDivergence(source)).toEqual([]);
  });

  it('every reader routes through the shared WHERE fragments', () => {
    const bodies = functionSpans(source, READERS);
    for (const name of READERS) {
      for (const fragment of SHARED_FRAGMENTS) {
        expect(
          bodies[name]?.includes(`${fragment}(sql,`),
          `${name} must apply ${fragment} — a hand-written copy is what drifted last time`,
        ).toBe(true);
      }
    }
  });

  it('the shared match fragment still carries every field it absorbed', () => {
    // Guards the wrong repair: making all five sites agree by removing `q` from the
    // fragment would satisfy the parity test above while restoring the original bug.
    const [fragment] = Object.values(functionSpans(source, ['issueMatchWhereSql']));
    expect(fragment, 'issueMatchWhereSql must exist').toBeTruthy();
    for (const field of MATCH_FRAGMENT_FIELDS) {
      expect(fragment.includes(`filter.${field}`), `issueMatchWhereSql must apply ${field}`).toBe(
        true,
      );
    }
  });

  /**
   * CONTROLS — a guard that has never failed is a guard nobody has tested, and the repo
   * forbids proving that by mutating the shared tree (git-sync would commit the mutant).
   * These fixtures are permanent, in-file, and exercise the real checker.
   */
  describe('controls: the checker itself can fail, and does not always fail', () => {
    // Deliberately wrong: `countIssuesByState` drops `filter.q` — the exact shape of
    // WI-564691, reduced to its skeleton.
    const DIVERGENT_FIXTURE = `
      async function listIssuesWithLimit(filter) {
        return sql\`WHERE \${filter.q} AND \${filter.state}\`;
      }
      async function countIssues(filter) {
        return sql\`WHERE \${filter.q} AND \${filter.state}\`;
      }
      async function countIssuesByState(filter) {
        return sql\`WHERE \${filter.state}\`;
      }
      async function countIssuesBySourceRole(filter) {
        return sql\`WHERE \${filter.q} AND \${filter.state}\`;
      }
      async function countObservationsByKind(filter) {
        return sql\`WHERE \${filter.q} AND \${filter.state}\`;
      }`;

    const AGREEING_FIXTURE = DIVERGENT_FIXTURE.replace(
      'async function countIssuesByState(filter) {\n        return sql`WHERE ${filter.state}`;',
      'async function countIssuesByState(filter) {\n        return sql`WHERE ${filter.q} AND ${filter.state}`;',
    );

    it('CATCHES a dropped predicate (proves the assertion is falsifiable)', () => {
      expect(findFilterDivergence(DIVERGENT_FIXTURE)).toEqual([
        { field: 'q', missingFrom: ['countIssuesByState'] },
      ]);
    });

    it('CALIBRATION: passes when the same fixture agrees (not a checker that always fails)', () => {
      // Without this, the control above would also pass if findFilterDivergence were
      // broken into always reporting a divergence.
      expect(AGREEING_FIXTURE).not.toEqual(DIVERGENT_FIXTURE);
      expect(findFilterDivergence(AGREEING_FIXTURE)).toEqual([]);
    });

    it('does not mistake a projection option for a membership predicate', () => {
      const withProjection = AGREEING_FIXTURE.replace(
        'async function listIssuesWithLimit(filter) {',
        'async function listIssuesWithLimit(filter) {\n        const columns = filter.payloadProjection;',
      );
      expect(findFilterDivergence(withProjection)).toEqual([]);
      // The scanner still sees the field; only the explicit non-predicate exemption
      // prevents this output-shape option from looking like a dropped WHERE clause.
      expect(findFilterDivergence(withProjection, READERS, new Set()).map((d) => d.field)).toEqual([
        'payloadProjection',
      ]);
    });

    it('CALIBRATION: the exemption set is honoured, and only for what it names', () => {
      const withLimit = DIVERGENT_FIXTURE.replace(
        'async function listIssuesWithLimit(filter) {\n        return sql`WHERE ${filter.q} AND ${filter.state}`;',
        'async function listIssuesWithLimit(filter) {\n        return sql`WHERE ${filter.q} AND ${filter.state} LIMIT ${filter.limit}`;',
      );
      // `limit` is exempt, so it must NOT be reported; `q` still must be.
      expect(findFilterDivergence(withLimit)).toEqual([
        { field: 'q', missingFrom: ['countIssuesByState'] },
      ]);
      // ...and with an EMPTY exemption set, `limit` is reported — proving the exemption
      // is what suppressed it, not an inability to see the field at all.
      expect(findFilterDivergence(withLimit, READERS, new Set()).map((d) => d.field)).toEqual([
        'limit',
        'q',
      ]);
    });
  });
});
