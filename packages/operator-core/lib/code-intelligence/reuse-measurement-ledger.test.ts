import { describe, expect, it } from 'vitest';
import { buildReuseSourcePopulation } from './reuse-source-population';
import { collectRecordedReuseMetrics, readRecordedReuseWindows } from './reuse-measurement';
import { readRecipeOutcomeReport } from '../code-run-adoption';

/**
 * code-intel-delivery-and-outcomes-2026-10-26 P-006, SPEC-P-006-C (EI-27013395716645252):
 * reuse-measurement records are measurements, not deliveries, so they are written to and
 * read from harness_shared.code_intel_reuse_measurements and never touch the delivered-push
 * log (harness_shared.code_intel_pushes), where a zero-char row with a JSON blob in
 * suggested_call was counted as push output. The real-database round trip is covered by
 * reuse-measurement.integration.test.ts; this file pins which table each statement uses.
 */
type Sql = Parameters<typeof readRecordedReuseWindows>[0];

/** A tagged-template stand-in for postgres.js `sql` that records each statement's text. */
function recordingSql(answer: (text: string) => unknown[] = () => []) {
  const statements: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim();
    statements.push(text);
    return Promise.resolve(answer(text));
  }) as unknown as Sql;
  return { sql, statements };
}

const MEASUREMENT_TABLE = 'harness_shared.code_intel_reuse_measurements';
const PUSH_LOG = 'code_intel_pushes';

it('R9 unknown coverage remains unknown', async () => {
  const report = await readRecipeOutcomeReport(async <T>() => [{ report: { attempts: 0 } }] as unknown as T[], {
    workspaceId: 'ws', harnessSlug: 'fixture', windowStart: '2026-10-01T00:00:00Z', windowEnd: '2026-10-02T00:00:00Z',
  });
  expect(report.coverage).toMatchObject({ state: 'unknown', complete: false, backlog: null,
    clients: { claude: 'unknown', codex: 'unknown', omp: 'unknown' } });
  expect(report.benefit).toMatchObject({ state: 'unknown', measuredSavings: null });
});

describe('reuse-measurement ledger (P-006, SPEC-P-006-C)', () => {
  it('SPEC-P-006-C: a collected metric population is written to the measurement ledger, not the delivered-push log', async () => {
    const { sql, statements } = recordingSql();
    const scope = { workspaceId: 'ws', harnessSlug: 'fixture', windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-02T00:00:00.000Z' };
    const load = async () => ({ ...buildReuseSourcePopulation({ sources: [{ path: 'a.ts', source: 'export function a() {} a();' }],
      addedLines: { 'a.ts': [1] }, complete: true }), sourceRefs: ['git:controlled-base', 'git:controlled-end'],
      base: 'controlled-base', commit: 'controlled-end' });
    await collectRecordedReuseMetrics(sql, scope, load);
    const inserts = statements.filter(s => /^INSERT INTO/i.test(s));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(`INSERT INTO ${MEASUREMENT_TABLE}`);
    expect(inserts[0]).toContain("'reuse-metrics'");
    expect(statements.filter(s => s.includes(PUSH_LOG))).toEqual([]);
  });

  it('SPEC-P-006-C: recorded reuse windows are read from the measurement ledger only', async () => {
    const { sql, statements } = recordingSql();
    await expect(readRecordedReuseWindows(sql, { workspaceId: 'ws', start: '2026-10-01T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' }))
      .resolves.toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain(`FROM ${MEASUREMENT_TABLE}`);
    expect(statements[0]).toContain("kind = 'reuse-measurement'");
    expect(statements[0]).not.toContain(PUSH_LOG);
  });

  it('fixture calibration: the recorder sees a statement that names the push log', async () => {
    const { sql, statements } = recordingSql();
    await sql`SELECT 1 FROM harness_shared.code_intel_pushes`;
    expect(statements.filter(s => s.includes(PUSH_LOG))).toHaveLength(1);
  });
});
