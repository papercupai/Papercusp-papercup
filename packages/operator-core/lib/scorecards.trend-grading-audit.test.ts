/**
 * scorecards.trend-grading-audit.test.ts — P-013 (D-004 grade-the-grader): a TERMINAL
 * card whose gradingAudit is still 'pending' is final but UNVERIFIED — it must NOT
 * move the trend, and its exclusion must be REPORTED. Only a passed audit under
 * the current audit contract admits a standard card; historical rows stay readable.
 *
 * The settled-card-counts case is the falsifiability control: an implementation that
 * excludes on stamp PRESENCE (rather than state === 'pending') fails it.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const DB_ROWS = [
  // newest-first, as the real SELECT returns them
  {
    issue_id: 'EI-audited',
    created_by: 'agent-a',
    created_at: '2026-08-03T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
        gradingAudit: {
          state: 'passed',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-03T00:00:00.000Z',
          auditIssueId: 'EI-AUDIT-9',
          auditor: 'agent-b',
          auditedAt: '2026-08-03T01:00:00.000Z',
          rubricRevision: 1,
          criteriaHash: 'criteria-v1',
        },
      },
    },
  },
  {
    issue_id: 'EI-pending',
    created_by: 'agent-a',
    created_at: '2026-08-02T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'broken', evidence: 'e' } },
        gradingAudit: {
          state: 'pending',
          metaRubricRef: 'grading-integrity',
          stampedAt: '2026-08-02T00:00:00.000Z',
        },
      },
    },
  },
  {
    issue_id: 'EI-prestamp',
    created_by: 'agent-a',
    created_at: '2026-08-01T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
];

let rowsForQuery: unknown[] = DB_ROWS;
let rubricKind = 'standard';
beforeEach(() => { rowsForQuery = DB_ROWS; rubricKind = 'standard'; });

const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(rowsForQuery.map(row => {
      const value = row as typeof DB_ROWS[0];
      return { ...value, payload: { observation: {
        rubricRevision: 1, criteriaHash: 'criteria-v1', ...value.payload.observation,
      } } };
    }));
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};

// scorecards.ts now reads through boundedPgReadTxn. Execute that callback on
// the tagged mock and absorb its READ ONLY/session setup statements so the
// fixture returns DB_ROWS instead of the old empty-begin undefined.
const sqlMock = Object.assign(sqlTag, {
  begin: vi.fn(async <T>(transaction: (tx: unknown) => Promise<T>) => transaction(sqlMock)),
  unsafe: vi.fn(async () => []),
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('./issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./issues-engineer')>()),
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: async () => new Map(),
  issuesSupersededByRevision: async () => new Set<string>(),
}));

vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getRubric: async () => ({ rubricId: 'test-rubric', kind: rubricKind, revision: 1,
    criteriaHash: 'criteria-v1', criteria: [{ key: 'alpha' }] }),
  getRubricWithoutSeeding: async (ref: string) => ({ rubricId: ref, kind: rubricKind, revision: 1,
    criteriaHash: 'criteria-v1', criteria: [{ key: 'alpha' }] }),
  rubricInstrumentContract: () => null,
}));

describe('scorecardTrend — audit-pending cards are excluded and the exclusion reported (P-013)', () => {
  it('keeps current independently passed grading and reports pending and missing audits', async () => {
    const { scorecardTrend, listScorecards } = await import('./scorecards');

    // The LIST keeps all three (real, auditable filings; the stamp is projected)…
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.issueId === 'EI-pending')?.gradingAudit).toMatchObject({ state: 'pending' });
    expect(rows.find((r) => r.issueId === 'EI-audited')?.gradingAudit).toMatchObject({
      state: 'passed',
      auditIssueId: 'EI-AUDIT-9',
    });

    // The pre-stamp row is readable history; it cannot become audited by omission.
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
    expect(trend.gradingAuditPendingExcluded).toBe(1);
    expect(trend.provisionalExcluded).toBe(0);
    expect(trend.scorecardCount).toBe(1);
    expect(trend.sample.excludedCounts).toEqual({ 'grading-audit-pending': 1, 'grading-audit-missing': 1 });

    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    // The pending card's 'broken' never entered; the settled + pre-stamp cards did.
    expect(alpha.count).toBe(1);
    expect(alpha.distribution).toEqual({ healthy: 1 });
  });

  it.each([
    ['stale', { rubricRevision: 2, criteriaHash: 'changed' }, 'grading-audit-stale'],
    ['unknown', { metaRubricRef: 'missing-audit-rubric' }, 'grading-audit-unknown'],
    ['failed', { state: 'failed' }, 'grading-audit-failed'],
  ])('does not admit a %s audit as settled proof', async (_label, patch, reason) => {
    const row = DB_ROWS[0];
    rowsForQuery = [{ ...row, payload: { observation: { ...row.payload.observation,
      gradingAudit: { ...row.payload.observation.gradingAudit, ...patch },
    } } }];
    const { listScorecards, scorecardTrend } = await import('./scorecards');
    const history = await listScorecards({ rubricRef: 'test-rubric' });
    expect(history[0].exclusionReasons).toContain(reason);
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
    expect(trend.scorecardCount).toBe(0);
    expect(trend.sample.excludedCounts).toEqual({ [reason]: 1 });
    expect(trend.staleness.reason).toContain(reason);
  });

  it('keeps acceptance cards exempt from a second recursive audit', async () => {
    rubricKind = 'acceptance';
    rowsForQuery = [DB_ROWS[2]];
    const { scorecardTrend } = await import('./scorecards');
    expect((await scorecardTrend({ rubricRef: 'test-rubric' })).scorecardCount).toBe(1);
  });

  it.each(['sourceHive', 'ref', 'kind', 'windowStart', 'windowEnd'])(
    'does not infer a direction across different %s cohorts', async field => {
      const row = DB_ROWS[0];
      const subject = { ref: 'WI-subject', kind: 'work-item', windowStart: '2026-08-01T00:00:00Z', windowEnd: '2026-08-02T00:00:00Z' };
      rowsForQuery = [0, 1].map(index => ({ ...row, issue_id: `EI-cohort-${index}`,
        created_at: `2026-08-0${3 - index}T00:00:00.000Z`, payload: { observation: {
          ...row.payload.observation, sourceHive: field === 'sourceHive' && index ? 'another-hive' : 'papercusp',
          subject: { ...subject, ...(field !== 'sourceHive' && index ? { [field]: 'different' } : {}) },
          ratings: { alpha: { rating: index ? 'broken' : 'healthy', evidence: 'Measured independently.' } },
        } } }));
      const { scorecardTrend } = await import('./scorecards');
      const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
      expect(trend.scorecardCount).toBe(2);
      expect(trend.criteria[0].direction).toBe('unknown');
      expect(trend.comparison?.compatible).toBe(false);
    });
});
