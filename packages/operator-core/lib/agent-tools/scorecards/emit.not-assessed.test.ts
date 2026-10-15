/**
 * emit.not-assessed.test.ts — goal-grading-live-coverage-and-holder-followthrough-2026-10-08
 * P-001 / R-1 (EI-25425148387198503).
 *
 * The 2026-10-08 goal-mode-e2e card carried 37 unknowns; 26 of them were criteria the
 * grader simply had not finished, filed as `instrument-unavailable`. The owner read
 * that as 26 broken instruments. These tests pin the fix:
 *   1. `not-assessed` is an accepted unknownReason on the emit/evaluate path and is
 *      preserved through the read path (one shared vocabulary).
 *   2. rubrics:trend counts unfinished grading separately from instrument failures,
 *      per criterion and rubric-wide, and never as rubric staleness.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = {
  issue_id: string;
  created_by: string;
  created_at: string;
  payload: { observation: { rubricRef: string; ratings: Record<string, Record<string, unknown>> } };
};

function card(id: string, at: string, ratings: Record<string, Record<string, unknown>>): Row {
  return {
    issue_id: id,
    created_by: 'grader-a',
    created_at: at,
    payload: { observation: { rubricRef: 'goal-test-rubric', ratings } },
  };
}

const unknown = (unknownReason?: string, evidence = 'grader has not reached this criterion') => ({
  rating: 'unknown',
  evidence,
  ...(unknownReason ? { unknownReason } : {}),
});
const healthy = { rating: 'healthy', evidence: 'measured' };

// Newest-first, as the real SELECT returns them. alpha = unfinished grading,
// beta = a real measurement failure, gamma = assessed.
const ROWS: Row[] = [3, 2, 1].map((n) =>
  card(`EI-card-${n}`, `2026-10-0${n}T00:00:00.000Z`, {
    alpha: unknown('not-assessed'),
    beta: unknown('instrument-unavailable', 'collector query timed out'),
    gamma: healthy,
  }),
);

let rowsForQuery: Row[] = ROWS;
beforeEach(() => {
  rowsForQuery = ROWS;
});

const RUBRIC = {
  rubricId: 'goal-test-rubric',
  workspaceId: 'test-workspace',
  kind: 'standard',
  characteristic: 'goal-quality',
  title: 'Goal test rubric',
  description: 'fixture',
  criteria: ['alpha', 'beta', 'gamma'].map((key) => ({
    key,
    title: key,
    model: `${key} works`,
    method: `check ${key}`,
    driftMarkers: `${key} fails`,
  })),
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: 'author',
  proposedBy: 'author',
  ratifiedBy: 'ratifier',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
} as const;

const sqlTag = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
  const text = strings.join(' ? ');
  if (text.includes('FROM harness_shared.engineer_issues')) {
    return Promise.resolve(rowsForQuery) as unknown as Promise<unknown[]>;
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};
const sqlMock = Object.assign(sqlTag, {
  begin: vi.fn(async <T>(transaction: (tx: unknown) => Promise<T>) => transaction(sqlMock)),
  unsafe: vi.fn(async () => []),
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMock }),
}));

vi.mock('../../issues-engineer', () => ({
  issuesScopeWorkspace: () => 'test-workspace',
  issuesOutLinksMany: async () => new Map(),
  issuesSupersededByRevision: async () => new Set<string>(),
}));

vi.mock('../../rubrics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rubrics')>()),
  getRubric: async () => RUBRIC,
  getRubricWithoutSeeding: async () => RUBRIC,
  rubricInstrumentContract: () => null,
}));

describe("unknownReason 'not-assessed' — one vocabulary, accepted on emit and kept on read", () => {
  it('is part of the shared unknown-reason vocabulary', async () => {
    const { OBSERVATION_UNKNOWN_REASONS } = await import('../../harness/improvements/observation-types');
    expect(OBSERVATION_UNKNOWN_REASONS).toContain('not-assessed');
    expect(OBSERVATION_UNKNOWN_REASONS).toContain('instrument-unavailable');
  });

  it('the emit/evaluate rating schema accepts not-assessed and still refuses an invented reason', async () => {
    const { scorecardRatingEntrySchema } = await import('./evaluate');
    expect(
      scorecardRatingEntrySchema.safeParse({ rating: 'unknown', evidence: 'not graded yet', unknownReason: 'not-assessed' }).success,
    ).toBe(true);
    // Negative control: the enum is still closed, so the positive case above is not vacuous.
    expect(
      scorecardRatingEntrySchema.safeParse({ rating: 'unknown', evidence: 'x', unknownReason: 'grader-was-busy' }).success,
    ).toBe(false);
  });

  it('every reason the read path knows is accepted by the emit schema (no second hand-copied list)', async () => {
    const { scorecardRatingEntrySchema } = await import('./evaluate');
    const { OBSERVATION_UNKNOWN_REASONS } = await import('../../harness/improvements/observation-types');
    for (const reason of OBSERVATION_UNKNOWN_REASONS) {
      expect(scorecardRatingEntrySchema.safeParse({ rating: 'unknown', evidence: 'e', unknownReason: reason }).success).toBe(true);
    }
  });

  it('listScorecards preserves the structured not-assessed reason', async () => {
    const { listScorecards } = await import('../../scorecards');
    const rows = await listScorecards({ rubricRef: 'goal-test-rubric', limit: 10 });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.ratings.alpha!.unknownReason).toBe('not-assessed');
    expect(rows[0]!.ratings.beta!.unknownReason).toBe('instrument-unavailable');
  });
});

describe('rubrics:trend separates unfinished grading from instrument failures', () => {
  it('splits unknowns per criterion and rubric-wide', async () => {
    const { scorecardTrend } = await import('../../scorecards');
    const trend = await scorecardTrend({ rubricRef: 'goal-test-rubric' });

    expect(trend.unknownBreakdown).toEqual({
      total: 6,
      graderIncomplete: 3,
      instrumentUnavailable: 3,
      byReason: { 'not-assessed': 3, 'instrument-unavailable': 3 },
    });
    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    const beta = trend.criteria.find((c) => c.criterion === 'beta')!;
    const gamma = trend.criteria.find((c) => c.criterion === 'gamma')!;
    expect(alpha.notAssessedCount).toBe(3);
    expect(alpha.unknownReasons).toEqual({ 'not-assessed': 3 });
    expect(beta.notAssessedCount).toBe(0);
    expect(beta.unknownReasons).toEqual({ 'instrument-unavailable': 3 });
    expect(gamma.unknownReasons).toEqual({});
  });

  it('unfinished grading is not rubric staleness; a real instrument failure still is', async () => {
    const { scorecardTrend } = await import('../../scorecards');
    const trend = await scorecardTrend({ rubricRef: 'goal-test-rubric' });
    const staleKeys = trend.staleness.staleCriteria.map((c) => c.criterion);
    expect(staleKeys).toContain('beta');
    expect(staleKeys).not.toContain('alpha');
  });

  it('a legacy unknown without a structured reason is reported as unspecified', async () => {
    rowsForQuery = [card('EI-legacy', '2026-10-01T00:00:00.000Z', { alpha: unknown(), beta: healthy, gamma: healthy })];
    const { scorecardTrend } = await import('../../scorecards');
    const trend = await scorecardTrend({ rubricRef: 'goal-test-rubric' });
    expect(trend.unknownBreakdown).toEqual({
      total: 1,
      graderIncomplete: 0,
      instrumentUnavailable: 0,
      byReason: { unspecified: 1 },
    });
  });

  it('an idle-prefixed not-assessed unknown is counted idle once, never twice', async () => {
    rowsForQuery = [1, 2, 3].map((n) =>
      card(`EI-idle-${n}`, `2026-10-0${n}T00:00:00.000Z`, {
        alpha: unknown('not-assessed', 'idle: no holder tenure in window'),
        beta: healthy,
        gamma: healthy,
      }),
    );
    const { scorecardTrend } = await import('../../scorecards');
    const trend = await scorecardTrend({ rubricRef: 'goal-test-rubric' });
    const alpha = trend.criteria.find((c) => c.criterion === 'alpha')!;
    expect(alpha.idleCount).toBe(3);
    expect(alpha.notAssessedCount).toBe(0);
    expect(alpha.unknownReasons).toEqual({ 'not-assessed': 3 });
  });
});
