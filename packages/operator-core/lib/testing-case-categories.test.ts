/**
 * Plan test-rubric-unification-2026-10-12 P-003 / R-3: every per-case category is derived at
 * read time from its source record. Each block proves the R-3 drift marker stays false for
 * one category: changing the source record changes the reported value.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CASE_ROW_CAP,
  type CaseRunRecord,
  type CoverageRecord,
  type DomainRecord,
  type SqlLike,
  type SurfaceRecord,
  deriveCaseCitations,
  deriveCaseCost,
  deriveCaseFlakiness,
  deriveCaseLayer,
  deriveCaseSubsystems,
  deriveCaseSurfaces,
  deriveTestCaseCategories,
  deriveUncoveredSurfaces,
  readTestCaseCategories,
} from './testing-case-categories';

const FILE = 'packages/operator-core/lib/widgets/widget.test.ts';
const CASE = 'widget store > refuses a write';

const run = (over: Partial<CaseRunRecord> = {}): CaseRunRecord => ({
  file: FILE,
  caseKey: CASE,
  status: 'pass',
  durationMs: 10,
  finishedAt: '2026-10-12T10:00:00.000Z',
  testRunId: 1,
  ...over,
});

const surface = (id: number, surfaceId = `tool:${id}`): SurfaceRecord => ({
  id,
  kind: 'mcp-tool',
  surfaceId,
  sourceFile: null,
});

describe('layer is derived from the file path', () => {
  it('changes when the path changes', () => {
    expect(deriveCaseLayer(FILE)).toEqual(['unit']);
    expect(deriveCaseLayer('packages/operator-core/lib/widgets/widget.integration.test.ts')).toEqual(['integration']);
    expect(deriveCaseLayer('apps/operator/e2e/widget.spec.ts')).toEqual(['e2e']);
  });

  it('reports a non-test path as unclassified rather than guessing', () => {
    expect(deriveCaseLayer('packages/operator-core/lib/widgets/widget.ts')).toEqual([]);
  });
});

describe('subsystem is derived from the testing domain registry', () => {
  const domains = (glob: string): DomainRecord[] => [
    { id: 'widgets', sections: [{ id: 'store', globs: [glob] }, { id: 'none' }] },
    { id: 'other', sections: [{ id: 'x', globs: ['apps/**/*.test.ts'] }] },
  ];

  it('reports every matching domain section', () => {
    expect(deriveCaseSubsystems(FILE, domains('packages/operator-core/lib/widgets/**/*.test.ts'))).toEqual([
      { domainId: 'widgets', sectionId: 'store' },
    ]);
  });

  it('changes when the registry globs change', () => {
    expect(deriveCaseSubsystems(FILE, domains('packages/operator-core/lib/gadgets/**/*.test.ts'))).toEqual([]);
  });
});

describe('surfaces are derived from coverage evidence over live testing_surfaces', () => {
  const live = new Map([[7, surface(7, 'widgets:get')], [8, surface(8, 'widgets:set')]]);

  it('links a coverage row naming the case (complete title suffix)', () => {
    const coverage: CoverageRecord[] = [{ surfaceRef: 7, testFile: FILE, testCase: 'refuses a write', verdict: 'pass' }];
    expect(deriveCaseSurfaces(FILE, CASE, coverage, live)).toEqual([
      { surfaceRef: 7, kind: 'mcp-tool', surfaceId: 'widgets:get', verdict: 'pass' },
    ]);
  });

  it('changes when the coverage row names a different case', () => {
    const coverage: CoverageRecord[] = [{ surfaceRef: 7, testFile: FILE, testCase: 'accepts a read', verdict: 'pass' }];
    expect(deriveCaseSurfaces(FILE, CASE, coverage, live)).toEqual([]);
  });

  it('applies file-level evidence to every case and drops retired surfaces', () => {
    const coverage: CoverageRecord[] = [
      { surfaceRef: 8, testFile: FILE, testCase: null, verdict: null },
      { surfaceRef: 99, testFile: FILE, testCase: null, verdict: 'pass' },
    ];
    expect(deriveCaseSurfaces(FILE, CASE, coverage, live).map((s) => s.surfaceRef)).toEqual([8]);
  });

  it('never matches a substring inside one title segment', () => {
    const coverage: CoverageRecord[] = [{ surfaceRef: 7, testFile: FILE, testCase: 'a write', verdict: 'pass' }];
    expect(deriveCaseSurfaces(FILE, CASE, coverage, live)).toEqual([]);
  });
});

describe('citations are derived from rubric tests checks and spec evidence bindings', () => {
  it('reports a rubric check naming the file and case', () => {
    const cited = deriveCaseCitations(FILE, CASE, [
      { rubricId: 'r1', criterionKey: 'c1', files: [FILE], testName: 'refuses a write' },
      { rubricId: 'r2', criterionKey: 'c2', files: [FILE] },
      { rubricId: 'r3', criterionKey: 'c3', files: ['other.test.ts'] },
    ], []);
    expect(cited.rubricChecks).toEqual([
      { rubricId: 'r1', criterionKey: 'c1', testName: 'refuses a write' },
      { rubricId: 'r2', criterionKey: 'c2' },
    ]);
  });

  it('changes when the rubric check filters to a different case', () => {
    const cited = deriveCaseCitations(FILE, CASE, [
      { rubricId: 'r1', criterionKey: 'c1', files: [FILE], testName: 'accepts a read' },
    ], []);
    expect(cited.rubricChecks).toEqual([]);
  });

  it('reports and drops a spec binding as its declared cases change', () => {
    const binding = (testCases: string[]) => [{ planSlug: 'p', specId: 'AUTO-BAR-R-1-P-001', testFile: FILE, testCases }];
    expect(deriveCaseCitations(FILE, CASE, [], binding([CASE])).specBindings).toEqual([
      { planSlug: 'p', specId: 'AUTO-BAR-R-1-P-001' },
    ]);
    expect(deriveCaseCitations(FILE, CASE, [], binding(['widget store > accepts a read'])).specBindings).toEqual([]);
  });
});

describe('cost is derived from recorded durations of executed occurrences', () => {
  const durations = (ms: number[]) => ms.map((durationMs, i) => run({ durationMs, testRunId: i + 1 }));

  it('reports nearest-rank p50 and p95', () => {
    expect(deriveCaseCost(durations([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]))).toEqual({
      p50Ms: 50,
      p95Ms: 100,
      samples: 10,
    });
  });

  it('changes when a recorded duration changes', () => {
    expect(deriveCaseCost(durations([10, 20, 30, 40, 50, 60, 70, 80, 90, 400])).p95Ms).toBe(400);
  });

  it('ignores skips and null durations, and reports no samples as null', () => {
    expect(deriveCaseCost([run({ status: 'skip', durationMs: 999 }), run({ durationMs: null })])).toEqual({
      p50Ms: null,
      p95Ms: null,
      samples: 0,
    });
  });
});

describe('flakiness is derived from the ordered history of executed statuses', () => {
  it('counts flips across consecutive runs ordered by finish time, not input order', () => {
    const history = [
      run({ status: 'pass', finishedAt: '2026-10-12T03:00:00Z', testRunId: 3 }),
      run({ status: 'pass', finishedAt: '2026-10-12T01:00:00Z', testRunId: 1 }),
      run({ status: 'fail', finishedAt: '2026-10-12T02:00:00Z', testRunId: 2 }),
    ];
    expect(deriveCaseFlakiness(history)).toEqual({ flips: 2, flipRate: 1, passCount: 2, failCount: 1, executedRuns: 3 });
  });

  it('changes when a recorded status changes', () => {
    const history = [
      run({ status: 'pass', finishedAt: '2026-10-12T01:00:00Z', testRunId: 1 }),
      run({ status: 'pass', finishedAt: '2026-10-12T02:00:00Z', testRunId: 2 }),
      run({ status: 'pass', finishedAt: '2026-10-12T03:00:00Z', testRunId: 3 }),
    ];
    expect(deriveCaseFlakiness(history).flipRate).toBe(0);
  });

  it('does not count a skip as a verdict', () => {
    const history = [
      run({ status: 'pass', finishedAt: '2026-10-12T01:00:00Z', testRunId: 1 }),
      run({ status: 'skip', finishedAt: '2026-10-12T02:00:00Z', testRunId: 2 }),
      run({ status: 'pass', finishedAt: '2026-10-12T03:00:00Z', testRunId: 3 }),
    ];
    expect(deriveCaseFlakiness(history)).toMatchObject({ flips: 0, executedRuns: 2 });
  });
});

describe('uncovered surfaces are the live surfaces no recorded case covers', () => {
  const live = [surface(1), surface(2), surface(3)];
  const coverage: CoverageRecord[] = [
    { surfaceRef: 1, testFile: FILE, testCase: 'refuses a write', verdict: 'pass' },
    { surfaceRef: 2, testFile: FILE, testCase: null, verdict: 'pass' },
    { surfaceRef: 3, testFile: 'never-recorded.test.ts', testCase: null, verdict: 'pass' },
  ];

  it('lists a surface whose evidence names a file with no recorded cases', () => {
    const keys = new Map([[FILE, [CASE]]]);
    expect(deriveUncoveredSurfaces(live, coverage, keys).map((s) => s.id)).toEqual([3]);
  });

  it('changes when the recorded case behind a coverage row disappears', () => {
    const keys = new Map([[FILE, ['widget store > accepts a read']]]);
    expect(deriveUncoveredSurfaces(live, coverage, keys).map((s) => s.id)).toEqual([1, 3]);
  });

  it('lists a live surface with no coverage evidence at all', () => {
    expect(deriveUncoveredSurfaces([surface(4)], [], new Map()).map((s) => s.id)).toEqual([4]);
  });
});

describe('deriveTestCaseCategories composes every derivation per recorded case', () => {
  it('groups occurrences by file and case key and reports the latest status', () => {
    const result = deriveTestCaseCategories({
      runs: [
        run({ status: 'pass', durationMs: 10, finishedAt: '2026-10-12T01:00:00Z', testRunId: 1 }),
        run({ status: 'fail', durationMs: 30, finishedAt: '2026-10-12T02:00:00Z', testRunId: 2 }),
        run({ caseKey: 'widget store > accepts a read', durationMs: 5, testRunId: 2 }),
      ],
      liveSurfaces: [surface(7)],
      coverage: [{ surfaceRef: 7, testFile: FILE, testCase: CASE, verdict: 'pass' }],
      rubricChecks: [{ rubricId: 'r1', criterionKey: 'c1', files: [FILE], testName: CASE }],
      specBindings: [],
      domains: [{ id: 'widgets', sections: [{ id: 'store', globs: ['packages/operator-core/lib/widgets/**'] }] }],
      coverageCaseKeysByFile: new Map([[FILE, [CASE]]]),
    });
    expect(result.cases.map((c) => c.caseKey)).toEqual(['widget store > accepts a read', CASE]);
    const target = result.cases[1]!;
    expect(target).toMatchObject({
      layer: ['unit'],
      subsystem: [{ domainId: 'widgets', sectionId: 'store' }],
      surfaces: [{ surfaceRef: 7 }],
      citations: { rubricChecks: [{ rubricId: 'r1' }], specBindings: [] },
      cost: { p50Ms: 10, p95Ms: 30, samples: 2 },
      flakiness: { flips: 1, executedRuns: 2 },
      lastStatus: 'fail',
      lastRunAt: '2026-10-12T02:00:00Z',
    });
    expect(result.uncoveredSurfaces).toEqual([]);
  });
});

describe('readTestCaseCategories loads source records with reads only', () => {
  function stubSql(rowsFor: (query: string) => unknown[]) {
    const queries: string[] = [];
    const sql: SqlLike = (strings) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim();
      queries.push(query);
      return Promise.resolve(rowsFor(query));
    };
    return { sql, queries };
  }

  it('composes ledger, surfaces, coverage and bindings into categories', async () => {
    const { sql, queries } = stubSql((q) => {
      if (q.includes('FROM harness_shared.test_case_runs c JOIN harness_shared.test_runs r ON r.id = c.test_run_id WHERE r.finished_at')) {
        return [
          { test_run_id: '11', file_path: FILE, finished_at: new Date('2026-10-12T01:00:00Z'), case_key: CASE, status: 'pass', duration_ms: 12 },
        ];
      }
      if (q.includes('FROM harness_shared.testing_surfaces')) {
        return [{ id: '7', kind: 'mcp-tool', surface_id: 'widgets:get', source_file: null }, { id: '8', kind: 'http-route', surface_id: 'GET /w', source_file: null }];
      }
      if (q.includes('FROM harness_shared.coverage_evidence')) {
        return [{ surface_ref: '7', test_file: FILE, test_case: null, verdict: 'pass' }];
      }
      if (q.startsWith('SELECT DISTINCT r.file_path, c.case_key')) return [{ file_path: FILE, case_key: CASE }];
      if (q.includes('FROM harness_shared.spec_evidence_bindings')) {
        return [{ plan_slug: 'p', spec_id: 'S-1', evidence_ref: FILE, test_cases: ['refuses a write', 42] }];
      }
      return [];
    });
    const result = await readTestCaseCategories({
      sql,
      workspaceId: 'ws',
      loadRubricChecks: async () => [],
      loadDomains: async () => [],
    });
    expect(result.casesTotal).toBe(1);
    expect(result.truncatedByLimit).toBe(false);
    expect(result.cases[0]).toMatchObject({
      file: FILE,
      caseKey: CASE,
      surfaces: [{ surfaceRef: 7, surfaceId: 'widgets:get' }],
      citations: { specBindings: [{ planSlug: 'p', specId: 'S-1' }] },
      cost: { p50Ms: 12, samples: 1 },
      lastRunAt: '2026-10-12T01:00:00.000Z',
    });
    expect(result.uncoveredSurfaces).toMatchObject({ total: 1, liveSurfaces: 2, items: [{ id: 8 }] });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.startsWith('SELECT'))).toBe(true);
  });

  it('reports a capped occurrence fetch as truncated instead of a total', async () => {
    const capped = Array.from({ length: CASE_ROW_CAP }, (_, i) => ({
      test_run_id: i + 1,
      file_path: FILE,
      finished_at: '2026-10-12T01:00:00Z',
      case_key: CASE,
      status: 'pass',
      duration_ms: 1,
    }));
    const { sql } = stubSql((q) => (q.includes('LIMIT') ? capped : []));
    const result = await readTestCaseCategories({ sql, loadRubricChecks: async () => [], loadDomains: async () => [] });
    expect(result.truncatedByLimit).toBe(true);
    expect(result.occurrenceRows).toBe(CASE_ROW_CAP);
  });
});

describe('no migration stores a category on the results ledger', () => {
  // R-3 drift marker (2): a writable category column or stored hand label. Categories are
  // derived by this module; a column holding one would be a second copy that drifts.
  const CATEGORY_COLUMNS = new Set([
    'layer', 'test_layer', 'subsystem', 'domain', 'surface', 'surfaces', 'citation', 'citations',
    'category', 'categories', 'label', 'labels', 'tag', 'tags', 'cost_p50', 'cost_p95', 'p50_ms',
    'p95_ms', 'flaky', 'flakiness', 'flip_rate', 'flakiness_rate',
  ]);
  const sqlDir = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url));

  it('finds no category column on test_case_runs or test_runs in any migration', () => {
    const offenders: string[] = [];
    const files = readdirSync(sqlDir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(100); // positive control: the directory resolved
    let sawCaseTable = false;
    for (const file of files) {
      const text = readFileSync(`${sqlDir}${file}`, 'utf8');
      const create = /CREATE TABLE(?: IF NOT EXISTS)?\s+harness_shared\.(test_case_runs|test_runs)\s*\(([\s\S]*?)\n\);/gi;
      for (const m of text.matchAll(create)) {
        if (m[1]!.toLowerCase() === 'test_case_runs') sawCaseTable = true;
        for (const line of m[2]!.split('\n')) {
          const col = line.trim().split(/\s+/)[0]?.replace(/"/g, '').toLowerCase();
          if (col && CATEGORY_COLUMNS.has(col)) offenders.push(`${file}: ${m[1]}.${col}`);
        }
      }
      const alter = /ALTER TABLE(?: IF EXISTS)?\s+harness_shared\.(test_case_runs|test_runs)\b([^;]*);/gi;
      for (const m of text.matchAll(alter)) {
        for (const add of m[2]!.matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+"?([a-z_]+)"?/gi)) {
          if (CATEGORY_COLUMNS.has(add[1]!.toLowerCase())) offenders.push(`${file}: ${m[1]}.${add[1]}`);
        }
      }
    }
    expect(sawCaseTable).toBe(true); // positive control: the case table's DDL was parsed
    expect(offenders).toEqual([]);
  });
});
