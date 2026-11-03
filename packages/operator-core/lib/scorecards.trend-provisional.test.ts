/**
 * scorecards.trend-provisional.test.ts — P-008 (EI-20581177540737568): a PROVISIONAL
 * scorecard (mid-run rating of 'violatable' criteria, stamped by scorecards:emit) is a
 * working note (D-004) — it must NOT move the trend, and its exclusion must be
 * REPORTED, never silent (same contract as supersededExcluded / preContractResetExcluded).
 *
 * The fixture is the measured WI-39348 shape: an interim card graded the run 'broken'
 * mid-run; the terminal cards say 'healthy'. Pre-P-008 the interim entered the series
 * and flipped the direction — here it is excluded and counted.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const DB_ROWS = [
  // newest-first, as the real SELECT returns them
  {
    issue_id: 'EI-final-2',
    created_by: 'agent-a',
    created_at: '2026-08-03T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        rubricRevision: 1,
        criteriaHash: 'criteria-v1',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
  {
    issue_id: 'EI-interim',
    created_by: 'agent-a',
    created_at: '2026-08-02T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        rubricRevision: 1,
        criteriaHash: 'criteria-v1',
        ratings: { alpha: { rating: 'broken', evidence: 'e' } },
        provisional: { violatableKeys: ['alpha'], stampedAt: '2026-08-02T00:00:00.000Z' },
      },
    },
  },
  {
    issue_id: 'EI-final-1',
    created_by: 'agent-a',
    created_at: '2026-08-01T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        rubricRevision: 1,
        criteriaHash: 'criteria-v1',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
];

const ALL_PROVISIONAL_ROWS = DB_ROWS.map((row) => ({
  ...row,
  payload: {
    ...row.payload,
    observation: {
      ...row.payload.observation,
      provisional: { violatableKeys: ['alpha'], stampedAt: row.created_at },
    },
  },
}));

let rowsForQuery = DB_ROWS;

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const FRESH_END = '2026-10-05T11:59:00.000Z';
const OLD_END = '2026-08-01T00:00:00.000Z';

function observedRows(ends: Array<string | null>, rating = 'healthy', evidence = 'e') {
  return ends.map((end, index) => ({
    issue_id: `EI-observation-${index}`,
    created_by: 'agent-a',
    created_at: '2026-10-05T12:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        rubricRevision: 1,
        criteriaHash: 'criteria-v1',
        ratings: { alpha: { rating, evidence } },
        ...(end === null ? {} : {
          subject: { ref: `subject-${index}`, windowStart: '2026-07-01T00:00:00.000Z', windowEnd: end },
        }),
      },
    },
  }));
}

beforeEach(() => { rowsForQuery = DB_ROWS; });

const RUBRIC_DEFINITION = {
  rubricId: 'test-rubric',
  revision: 1,
  criteriaHash: 'criteria-v1',
  workspaceId: 'test-workspace',
  kind: 'standard',
  characteristic: 'test-quality',
  title: 'Test rubric',
  description: 'Definition payload fixture',
  criteria: [
    {
      key: 'alpha',
      title: 'Alpha',
      model: 'Expected alpha behavior',
      method: 'Run the alpha test',
      driftMarkers: 'The alpha test fails',
    },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'agent-a',
  proposedBy: 'agent-a',
  ratifiedBy: 'agent-b',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as const;

const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(rowsForQuery.map(row => ({ ...row, payload: { observation: {
      ...row.payload.observation,
      gradingAudit: {
        state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: row.created_at,
        rubricRevision: 1, criteriaHash: 'criteria-v1', auditIssueId: 'EI-independent-audit',
        auditor: 'agent-b', auditedAt: row.created_at,
      },
    } } }))) as unknown as Promise<unknown[]>;
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};

// scorecards.ts now reads through boundedPgReadTxn. Execute that callback on
// the tagged mock and absorb its READ ONLY/session setup statements so the
// fixture returns rowsForQuery instead of the old empty-begin undefined.
const sqlMock = Object.assign(sqlTag, {
  begin: vi.fn(async <T>(transaction: (tx: unknown) => Promise<T>) => transaction(sqlMock)),
  unsafe: vi.fn(async () => []),
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('./issues-engineer', () => ({
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: async () => new Map(),
  issuesSupersededByRevision: async () => new Set<string>(),
}));

vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getRubric: async () => RUBRIC_DEFINITION,
  getRubricWithoutSeeding: async (ref: string) => ({ ...RUBRIC_DEFINITION, rubricId: ref }),
  rubricInstrumentContract: () => null,
}));

describe('scorecardTrend — provisional cards are excluded and the exclusion reported (P-008)', () => {
  it('drops the provisional interim from the series and counts it in provisionalExcluded', async () => {
    const { scorecardTrend, listScorecards } = await import('./scorecards');

    // The LIST keeps the interim (a real, auditable filing, provisional flag projected)…
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.issueId === 'EI-interim')?.provisional).toMatchObject({
      violatableKeys: ['alpha'],
    });
    expect(rows.find((r) => r.issueId === 'EI-final-2')?.provisional).toBeUndefined();

    // …the TREND excludes it, reported.
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
    expect(trend.provisionalExcluded).toBe(1);
    expect(trend.supersededExcluded).toBe(0);
    expect(trend.scorecardCount).toBe(2);

    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    // The interim's 'broken' never entered: two 'healthy' samples, stable direction.
    expect(alpha.count).toBe(2);
    expect(alpha.distribution).toEqual({ healthy: 2 });
    expect(alpha.direction).toBe('stable');
    expect(alpha.latest.at).toBe('2026-08-03T00:00:00.000Z');
  });

  it('includes the already-resolved rubric definition only when requested', async () => {
    const { scorecardTrend } = await import('./scorecards');

    const compact = await scorecardTrend({ rubricRef: 'test-rubric' });
    const definitionAware = await scorecardTrend({
      rubricRef: 'test-rubric',
      includeDefinition: true,
    });

    expect(compact.definition).toBeUndefined();
    expect(definitionAware.definition).toEqual(RUBRIC_DEFINITION);
  });

  it('names a provisional-only window instead of claiming the rubric was never graded', async () => {
    rowsForQuery = ALL_PROVISIONAL_ROWS;
    const { scorecardTrend } = await import('./scorecards');

    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });

    expect(trend.scorecardCount).toBe(0);
    expect(trend.provisionalExcluded).toBe(3);
    expect(trend.staleness.reason).toContain('3 scorecards in the window were excluded');
    expect(trend.staleness.reason).toContain('3 provisional');
    expect(trend.staleness.reason).not.toContain('never been graded');

    rowsForQuery = DB_ROWS;
  });
});

describe('scorecardTrend — observation age is independent of filing and criterion staleness', () => {
  async function trend(observationMaxAgeSec: number | undefined = 3600, nowMs = NOW) {
    const { scorecardTrend } = await import('./scorecards');
    return scorecardTrend({ rubricRef: 'test-rubric', observationMaxAgeSec, nowMs });
  }

  it('reports old observations as stale even when recently filed and assessable', async () => {
    rowsForQuery = observedRows([OLD_END, OLD_END, OLD_END]);
    const out = await trend();
    expect(out.filingWindow?.to).toBe('2026-10-05T12:00:00.000Z');
    expect(out.observationAge).toMatchObject({ status: 'stale', horizonSec: 3600, freshCount: 0, staleCount: 3 });
    expect(out.observationAge.ageSec?.min).toBeGreaterThan(3600);
    expect(out.staleness).toMatchObject({ assessed: true, stale: false });
  });

  it('uses observation ends rather than filing times for fresh evidence', async () => {
    rowsForQuery = observedRows([FRESH_END]).map((row) => ({ ...row, created_at: '2026-08-01T00:00:00.000Z' }));
    const out = await trend();
    expect(out.filingWindow?.to).toBe('2026-08-01T00:00:00.000Z');
    expect(out.observationAge).toMatchObject({ status: 'fresh', ageSec: { min: 60, max: 60 }, freshCount: 1, staleCount: 0 });
  });

  it.each([
    ['unassessable', 'no instrument', true, true],
    ['idle', 'idle: stage did not run', false, false],
  ])('keeps %s criterion staleness separate from fresh observations', async (_label, evidence, assessed, stale) => {
    rowsForQuery = observedRows([FRESH_END, FRESH_END, FRESH_END], 'unknown', evidence as string);
    const out = await trend();
    expect(out.observationAge.status).toBe('fresh');
    expect(out.staleness).toMatchObject({ assessed, stale });
  });

  it('names a mixed retained cohort and exposes its timestamp coverage', async () => {
    rowsForQuery = observedRows([FRESH_END, OLD_END]);
    const out = await trend();
    expect(out.observationAge).toMatchObject({
      status: 'mixed', freshCount: 1, staleCount: 1, asOf: '2026-10-05T12:00:00.000Z',
      coverage: { population: 'retained-scorecards', total: 2, timed: 2, missing: 0, invalid: 0, future: 0 },
    });
  });

  it('includes the exact horizon boundary and zero-age observations', async () => {
    rowsForQuery = observedRows(['2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.000Z']);
    expect((await trend()).observationAge).toMatchObject({ status: 'fresh', ageSec: { min: 0, max: 3600 } });
  });

  it('does not invent a horizon when the caller omits it', async () => {
    rowsForQuery = observedRows([FRESH_END]);
    const { scorecardTrend } = await import('./scorecards');
    const out = await scorecardTrend({ rubricRef: 'test-rubric', nowMs: NOW });
    expect(out.observationAge.status).toBe('unknown');
    expect(out.observationAge.horizonSec).toBeUndefined();
    expect(out.observationAge.freshCount).toBeUndefined();
  });

  it.each([0, -1, NaN, Infinity])('returns unknown for an invalid direct-call horizon %s', async (horizon) => {
    rowsForQuery = observedRows([FRESH_END]);
    expect((await trend(horizon)).observationAge.status).toBe('unknown');
  });

  it('does not let one known timestamp certify a partially timed cohort', async () => {
    rowsForQuery = observedRows([FRESH_END, null]);
    expect((await trend()).observationAge).toMatchObject({
      status: 'unknown', freshCount: 1, staleCount: 0,
      coverage: { total: 2, timed: 1, missing: 1, invalid: 0, future: 0 },
    });
  });

  it.each([
    ['missing', null, 'missing'],
    ['invalid', 'not-a-time', 'invalid'],
    ['future', '2026-10-05T12:00:01.000Z', 'future'],
  ])('preserves unknown for %s observation ends', async (_label, end, bucket) => {
    rowsForQuery = observedRows([end]);
    const out = await trend();
    expect(out.observationAge.status).toBe('unknown');
    expect(out.observationAge.coverage).toMatchObject({ total: 1, timed: 0, [bucket as string]: 1 });
    expect(out.observationAge.ageSec).toBeUndefined();
  });

  it.each(['not-a-time', '2026-10-05T12:00:01.000Z'])('rejects invalid or reversed supplied observation starts %s', async (start) => {
    rowsForQuery = observedRows([FRESH_END]).map((row) => ({
      ...row, payload: { observation: { ...row.payload.observation, subject: { ...row.payload.observation.subject!, windowStart: start } } },
    }));
    expect((await trend()).observationAge).toMatchObject({ status: 'unknown', coverage: { invalid: 1, timed: 0 } });
  });

  it('returns unknown for an empty retained cohort', async () => {
    rowsForQuery = [];
    expect((await trend()).observationAge).toMatchObject({ status: 'unknown', coverage: { total: 0, timed: 0 } });
  });

  it('ages only cards admitted into the trend', async () => {
    const rows = observedRows([FRESH_END, OLD_END]);
    rowsForQuery = rows.map((row, index) => index === 0 ? row : ({
      ...row, payload: { observation: { ...row.payload.observation, provisional: { violatableKeys: ['alpha'], stampedAt: row.created_at } } },
    }));
    const out = await trend();
    expect(out.provisionalExcluded).toBe(1);
    expect(out.scorecardCount).toBe(1);
    expect(out.observationAge).toMatchObject({ status: 'fresh', coverage: { total: 1, timed: 1 } });

    rowsForQuery = ALL_PROVISIONAL_ROWS;
    expect((await trend()).observationAge).toMatchObject({ status: 'unknown', coverage: { total: 0 } });
  });
});
