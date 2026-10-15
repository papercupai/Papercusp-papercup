/**
 * scorecards.trend-grading-audit.test.ts — P-013 (D-004 grade-the-grader): a TERMINAL
 * card whose gradingAudit is still 'pending' is final but UNVERIFIED — it must NOT
 * move the trend, and its exclusion must be REPORTED (same contract as
 * provisionalExcluded). A SETTLED audit (passed/failed) re-enters the series: the
 * audit verifies the grading, it never re-grades the subject.
 *
 * The settled-card-counts case is the falsifiability control: an implementation that
 * excludes on stamp PRESENCE (rather than state === 'pending') fails it.
 */
import { describe, it, expect, vi } from 'vitest';

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

const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(DB_ROWS) as unknown as Promise<unknown[]>;
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

vi.mock('./issues-engineer', () => ({
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: async () => new Map(),
  issuesSupersededByRevision: async () => new Set<string>(),
}));

vi.mock('./rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rubrics')>()),
  getRubric: async () => null,
  getRubricWithoutSeeding: async () => null,
  rubricInstrumentContract: () => null,
}));

describe('scorecardTrend — audit-pending cards are excluded and the exclusion reported (P-013)', () => {
  it('drops the pending card, keeps pre-stamp and SETTLED cards, and reports the count', async () => {
    const { scorecardTrend, listScorecards } = await import('./scorecards');

    // The LIST keeps all three (real, auditable filings; the stamp is projected)…
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.issueId === 'EI-pending')?.gradingAudit).toMatchObject({ state: 'pending' });
    expect(rows.find((r) => r.issueId === 'EI-audited')?.gradingAudit).toMatchObject({
      state: 'passed',
      auditIssueId: 'EI-AUDIT-9',
    });

    // …the TREND excludes only the pending one, reported.
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });
    expect(trend.gradingAuditPendingExcluded).toBe(1);
    expect(trend.provisionalExcluded).toBe(0);
    expect(trend.scorecardCount).toBe(2);

    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    // The pending card's 'broken' never entered; the settled + pre-stamp cards did.
    expect(alpha.count).toBe(2);
    expect(alpha.distribution).toEqual({ healthy: 2 });
  });
});
