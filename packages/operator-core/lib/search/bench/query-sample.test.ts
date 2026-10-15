/**
 * The sampling rules D-079 fixed, tested offline at $0.
 *
 * Each of these is a rule that changes WHICH SYSTEM the $12-15 pass measures if
 * it silently breaks — a stratum dropped, a frequency-weighted draw, an
 * unseeded sample, or the nested `args_json` accessor that returns zero rows
 * and reads as "no telemetry".
 */
import { describe, expect, it } from 'vitest';

import {
  allocateProportional,
  MIN_QUERY_TERMS,
  queryCensusSql,
  querySampleSql,
  SEARCH_STACK_TOOLS,
  SECONDARY_STRATUM_TOOLS,
  type QueryStratum,
} from './query-sample';

/** The census measured 2026-08-10 that D-079 allocates over. */
const CENSUS: QueryStratum[] = [
  { tool: 'search:fulltext', distinct: 412 },
  { tool: 'sessions:search', distinct: 185 },
  { tool: 'docs:search', distinct: 134 },
  { tool: 'work_items:search', distinct: 87 },
  { tool: 'plans:search', distinct: 29 },
  { tool: 'search:semantic', distinct: 13 },
];

describe('strata', () => {
  it('EXCLUDES the long agent-intent tools from the primary population', () => {
    // 84% of all query volume, and the lazy default. They are intents aimed at
    // the memory/recipe backends, not queries put to the search stack.
    for (const t of SECONDARY_STRATUM_TOOLS) {
      expect(SEARCH_STACK_TOOLS).not.toContain(t);
    }
    expect(SECONDARY_STRATUM_TOOLS).toEqual(['memory:search', 'recipes:search']);
  });
});

describe('allocateProportional', () => {
  it('sums EXACTLY to the requested total', () => {
    // Plain rounding over this census under/overshoots, which quietly turns a
    // "150-query pass" into 147 or 153 and stops two runs being comparable.
    for (const total of [150, 100, 37, 1, 860]) {
      const got = allocateProportional(CENSUS, total);
      expect(got.reduce((a, s) => a + s.want, 0)).toBe(total);
    }
  });

  it('allocates in proportion to the distinct counts', () => {
    const got = allocateProportional(CENSUS, 150);
    const by = new Map(got.map((g) => [g.tool, g.want]));
    // Ideals over 860: 71.86, 32.27, 23.37, 15.17, 5.06, 2.27 — floors sum to
    // 148, so the 2-draw residue goes to the two largest fractions (fulltext,
    // docs).
    expect(by.get('search:fulltext')).toBe(72);
    expect(by.get('sessions:search')).toBe(32);
    expect(by.get('docs:search')).toBe(24);
    expect(by.get('work_items:search')).toBe(15);
    expect(by.get('plans:search')).toBe(5);
    expect(by.get('search:semantic')).toBe(2);
  });

  it('never starves a small stratum while a large one takes more than one', () => {
    // search:semantic is 1.5% of the population and the stratum whose queries
    // differ MOST from the bulk — dropping it narrows the pass at the exact
    // edge it was drawn to cover.
    const got = allocateProportional(CENSUS, 150);
    for (const s of got) expect(s.want).toBeGreaterThan(0);
  });

  it('is a function of the census alone, not of row order', () => {
    const shuffled = [...CENSUS].reverse();
    const a = new Map(allocateProportional(CENSUS, 150).map((s) => [s.tool, s.want]));
    const b = new Map(allocateProportional(shuffled, 150).map((s) => [s.tool, s.want]));
    for (const [tool, want] of a) expect(b.get(tool)).toBe(want);
  });

  it('caps a stratum at its own census and redistributes the residue', () => {
    // Asking for more than exists must not manufacture draws that cannot be
    // made — the SQL would silently return fewer rows and the run would report
    // a smaller n than it claimed.
    const tiny: QueryStratum[] = [
      { tool: 'a:x', distinct: 2 },
      { tool: 'b:x', distinct: 100 },
    ];
    const got = allocateProportional(tiny, 50);
    const by = new Map(got.map((g) => [g.tool, g.want]));
    expect(by.get('a:x')).toBeLessThanOrEqual(2);
    expect(got.reduce((a, s) => a + s.want, 0)).toBe(50);
  });

  it('stops instead of looping when every stratum is at its ceiling', () => {
    const got = allocateProportional([{ tool: 'a:x', distinct: 3 }], 10);
    expect(got[0]?.want).toBe(3);
  });

  it('returns all-zero for an empty total or an empty census', () => {
    expect(allocateProportional(CENSUS, 0).every((s) => s.want === 0)).toBe(true);
    expect(allocateProportional([{ tool: 'a:x', distinct: 0 }], 10)[0]?.want).toBe(0);
  });

  it('refuses a non-integer or negative total', () => {
    expect(() => allocateProportional(CENSUS, -1)).toThrow(/non-negative integer/);
    expect(() => allocateProportional(CENSUS, 1.5)).toThrow(/non-negative integer/);
  });
});

describe('SQL', () => {
  it('includes one/two-term queries and freezes census and draw to the same window', () => {
    const window = { since: '2026-10-01T00:00:00Z', until: '2026-10-09T00:00:00Z', maxTerms: 2 };
    expect(MIN_QUERY_TERMS).toBe(1);
    for (const sql of [queryCensusSql('ws', SEARCH_STACK_TOOLS, 1, window), querySampleSql('ws', 'docs:search', 5, 's', 1, window)]) {
      expect(sql).toContain('>= 1');
      expect(sql).toContain('<= 2');
      expect(sql).toContain("created_at >= '2026-10-01T00:00:00.000Z'");
      expect(sql).toContain("created_at < '2026-10-09T00:00:00.000Z'");
      expect(sql).toContain('"usageCount"');
    }
  });

  it('rejects malformed or reversed windows before building SQL', () => {
    const sample = (since: string, until: string) => querySampleSql('ws', 'docs:search', 5, 's', 1, { since, until });
    expect(() => sample("2026-10-01'; DROP TABLE x--", '2026-10-09T00:00:00Z')).toThrow(/UTC ISO/);
    expect(() => sample('2026-10-09T00:00:00Z', '2026-10-01T00:00:00Z')).toThrow(/precede/);
  });
  it('reads the query with the DIRECT accessor, never the nested path', () => {
    // The nested `args_json->'tool_input'->'args'->>'query'` returns 0 rows on
    // this table — an empty result that reads as "no telemetry" rather than as
    // a wrong path.
    const sql = querySampleSql('papercusp-workspace', 'docs:search', 10, 'seed-1');
    expect(sql).toContain(`args_json->>'query'`);
    expect(sql).not.toContain('tool_input');
    expect(queryCensusSql('papercusp-workspace')).toContain(`args_json->>'query'`);
  });

  it('draws uniformly over DISTINCT queries, seeded — not frequency-weighted', () => {
    const sql = querySampleSql('papercusp-workspace', 'docs:search', 10, 'seed-1');
    // DISTINCT collapses a query issued 200 times to one row, so a handful of
    // repeated agent probes cannot dominate the sample.
    expect(sql).toContain(`SELECT DISTINCT btrim(args_json->>'query')`);
    // Seeded, so a re-run judges the SAME queries: a frozen contract freezes
    // model, rubric AND sample.
    expect(sql).toContain(`ORDER BY md5(q || 'seed-1')`);
    expect(sql).not.toContain('random()');
  });

  it('restricts to mid/long queries in both the census and the sample', () => {
    expect(queryCensusSql('papercusp-workspace')).toContain(`>= ${MIN_QUERY_TERMS}`);
    expect(querySampleSql('papercusp-workspace', 'docs:search', 10, 's')).toContain(
      `>= ${MIN_QUERY_TERMS}`,
    );
  });

  it('constrains every interpolated value to a grammar', () => {
    // These are interpolated rather than bound, so the grammar IS the guard.
    expect(() => querySampleSql('ws', "docs:search'; DROP TABLE x --", 10, 's')).toThrow(/tool must be/);
    expect(() => querySampleSql('ws', 'docs:search', 10, "s' OR 1=1 --")).toThrow(/seed must be/);
    expect(() => querySampleSql("ws' --", 'docs:search', 10, 's')).toThrow(/workspaceId must be/);
    expect(() => queryCensusSql('ws', ['not a tool'])).toThrow(/tool must be/);
    expect(() => querySampleSql('ws', 'docs:search', -1, 's')).toThrow(/non-negative integer/);
    expect(() => queryCensusSql('ws', SEARCH_STACK_TOOLS, 0)).toThrow(/positive integer/);
    expect(() => queryCensusSql('ws', [])).toThrow(/at least one tool/);
  });
});
