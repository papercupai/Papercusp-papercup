import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { namedQueryStageTimings, withNamedQueryDiagnosticContext } from './agent-tools/db-diagnostic-correlation-wiring';

const h = vi.hoisted(() => ({ sql: vi.fn(), boundedPgReadTxn: vi.fn() }));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql as never }),
  };
});

vi.mock('./pg-read-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pg-read-query')>();
  return {
    ...actual,
    boundedPgReadTxn: (...args: unknown[]) => h.boundedPgReadTxn(...args),
  };
});

const {
  checkAcceptanceBarApproverEligibility,
  getRubricWithoutSeeding,
  previewAcceptanceBarAmendment,
  readRubric,
  readRubricWithoutSeeding,
} = await import('./rubrics');

describe('rubric read-only lookups', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.sql.mockReset();
    h.boundedPgReadTxn.mockReset();
    h.boundedPgReadTxn.mockImplementation(
      async (run: (tx: unknown) => Promise<unknown>) => run(h.sql),
    );
  });

  it.each([
    ['missing row', []],
    ['malformed row', [{
      plan_slug: 'malformed-rubric',
      workspace_id: 'workspace-test',
      harness_slug: 'papercusp',
      title: 'Malformed rubric',
      status: 'active',
      created: new Date('2026-01-01T00:00:00.000Z'),
      updated: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-01T00:00:00.000Z'),
      version: '1',
      owner: 'su-test',
      archived: false,
      template_data: null,
    }]],
  ])('%s returns null without scanning the seedable rubric library', async (_label, rows) => {
    h.sql.mockResolvedValue(rows);

    await expect(getRubricWithoutSeeding('malformed-rubric')).resolves.toBeNull();

    // The helper performs one direct id lookup. A regression to getRubric's broad
    // fallback would issue a second rubric-library query (and can trigger seeding).
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function));
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('preserves a transient backing-row read failure instead of reporting a miss', async () => {
    h.sql.mockRejectedValueOnce(new Error('connection reset'));

    await expect(readRubricWithoutSeeding('active-rubric')).resolves.toEqual({
      kind: 'read-failed', diagnostic: { phase: 'plan-row-read', reason: 'exception' },
    });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('reports a successful empty direct lookup as a genuine miss', async () => {
    h.sql.mockResolvedValueOnce([]);

    await expect(readRubricWithoutSeeding('absent-rubric')).resolves.toEqual({ kind: 'missing' });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
  });

  it('keeps writer lookup failures distinct from a missing rubric', async () => {
    h.sql.mockRejectedValueOnce(new Error('connection reset'));

    await expect(readRubric('active-rubric')).resolves.toEqual({
      kind: 'read-failed', diagnostic: { phase: 'plan-row-read', reason: 'exception' },
    });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
  });

  it('keeps writer lookup misses distinct without running the seedable library scan in tests', async () => {
    h.sql.mockResolvedValueOnce([]);

    await expect(readRubric('absent-rubric')).resolves.toEqual({ kind: 'missing' });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
  });

  it('an amendment preview preserves a backing read failure instead of reporting a missing rubric', async () => {
    h.sql.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      previewAcceptanceBarAmendment({ rubricId: 'active-rubric' }),
    ).rejects.toThrow('rubric_read_failed:');
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('an amendment preview returns null only for a successful missing lookup without seeding', async () => {
    h.sql.mockResolvedValueOnce([]);

    await expect(
      previewAcceptanceBarAmendment({ rubricId: 'absent-rubric' }),
    ).resolves.toBeNull();
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('reports an approver-screen backing read failure separately from a missing rubric', async () => {
    h.sql.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      checkAcceptanceBarApproverEligibility({ rubricId: 'active-rubric', ownerId: 'reviewer' }),
    ).rejects.toThrow('acceptance_bar_approver_check_rubric_read_failed');
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('reports an authoritative missing rubric separately from a backing read failure', async () => {
    h.sql.mockResolvedValueOnce([]);

    await expect(
      checkAcceptanceBarApproverEligibility({ rubricId: 'absent-rubric', ownerId: 'reviewer' }),
    ).rejects.toThrow('acceptance_bar_approver_check_rubric_missing');
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('retains query timeout phase and request correlation without exposing exception or row data', async () => {
    const error = Object.assign(new Error('secret SQL and credential'), {
      code: '57014', hint: 'secret hint', detail: 'secret detail',
      boundedPgReadTxn: { phase: 'acquire', acquirePool: 'secret pool' },
    });
    h.sql.mockRejectedValueOnce(error);

    await withNamedQueryDiagnosticContext('scorecards.get', async correlationId => {
      const result = await readRubricWithoutSeeding('secret-rubric');
      expect(result).toEqual({ kind: 'read-failed', diagnostic: {
        phase: 'plan-row-read', reason: 'exception', code: '57014', timeoutPhase: 'acquire', correlationId,
      } });
      expect(namedQueryStageTimings()?.stages).toEqual([
        expect.objectContaining({ stage: 'rubric-plan-row-read', outcome: 'rejected' }),
      ]);
      expect(console.warn).toHaveBeenCalledWith('[rubrics:read-failed]', JSON.stringify(result.kind === 'read-failed' && result.diagnostic));
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret');
    });
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a mapping exception from a query failure and keeps the same request identity', async () => {
    h.sql.mockResolvedValueOnce([{ plan_slug: 'active-rubric', get template_data() {
      throw Object.assign(new Error('secret malformed content'), { code: 'secret-code-must-not-escape' });
    } }]);

    await withNamedQueryDiagnosticContext('scorecards.get', async correlationId => {
      const result = await readRubricWithoutSeeding('active-rubric');
      expect(result).toEqual({ kind: 'read-failed', diagnostic: {
        phase: 'row-map', reason: 'exception', correlationId,
      } });
      expect(namedQueryStageTimings()?.stages).toEqual([
        expect.objectContaining({ stage: 'rubric-plan-row-read', outcome: 'fulfilled' }),
        expect.objectContaining({ stage: 'rubric-row-map', outcome: 'rejected' }),
      ]);
      expect(JSON.stringify(result)).not.toContain('secret');
    });
    expect(h.sql).toHaveBeenCalledTimes(1);
  });

  it('labels an invalid present row and logs failures for null-returning compatibility readers', async () => {
    h.sql.mockResolvedValueOnce([{ plan_slug: 'bad-rubric', template_data: null }]);
    await expect(readRubricWithoutSeeding('bad-rubric')).resolves.toEqual({
      kind: 'read-failed', diagnostic: { phase: 'row-map', reason: 'invalid-row' },
    });
    h.sql.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'ECONNRESET' }));
    await expect(getRubricWithoutSeeding('bad-rubric')).resolves.toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith('[rubrics:read-failed]', JSON.stringify({
      phase: 'plan-row-read', reason: 'exception', code: 'ECONNRESET',
    }));
  });
});
