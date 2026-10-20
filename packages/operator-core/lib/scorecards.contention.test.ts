/**
 * scorecards.contention.test.ts — the scorecard primary-read reliability seam
 * (EI-21592547181442895).
 *
 * The SELECT must run through the bounded READ ONLY transaction and shared
 * contention retry. Lock contention (55P03) is retried and normalized after the
 * helper gives up; a statement_timeout (57014) is a slow read and is normalized
 * without a retry (WI-6554700010018139); unrelated failures remain unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  boundedPgReadTxn: vi.fn(),
  acquireWithContentionRetry: vi.fn(),
  issuesScopeWorkspace: vi.fn(() => 'default'),
  issuesOutLinksMany: vi.fn(async (_ids: readonly string[]) => new Map()),
}));

vi.mock('./pg-read-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pg-read-query')>()),
  boundedPgReadTxn: (...args: unknown[]) => h.boundedPgReadTxn(...args),
}));

vi.mock('./agent-tools/locks/contention-retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/locks/contention-retry')>()),
  acquireWithContentionRetry: (...args: unknown[]) => h.acquireWithContentionRetry(...args),
}));

vi.mock('./issues-engineer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./issues-engineer')>()),
  issuesScopeWorkspace: () => h.issuesScopeWorkspace(),
  issuesOutLinksMany: (ids: readonly string[]) => h.issuesOutLinksMany(ids),
}));

const {
  listScorecards,
  readScorecardEvidence,
  isScorecardReadRetryable,
  scorecardTimeoutLeadIn,
  SCORECARD_READ_LOCK_TIMEOUT_MS,
} = await import('./scorecards');
import { OrgTxnTimeoutError } from './pg-bounded-txn';

const realRetry = await vi.importActual<typeof import('./agent-tools/locks/contention-retry')>(
  './agent-tools/locks/contention-retry',
);
/** Delegate to the REAL retry helper (zero backoffs) so the caller's isRetryable decides. */
const useRealRetry = (): void => {
  h.acquireWithContentionRetry.mockImplementation(
    (run: () => Promise<unknown>, opts: { isRetryable?: (e: unknown) => boolean } = {}) =>
      realRetry.acquireWithContentionRetry(run, { ...opts, backoffsMs: [0, 0, 0] }),
  );
};

const fakeTx = vi.fn(() => Promise.resolve([] as unknown[]));
const pgError = (code: string): Error & { code: string } => Object.assign(new Error(`pg ${code}`), { code });

describe('listScorecards primary read contention handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.issuesScopeWorkspace.mockReturnValue('default');
    h.issuesOutLinksMany.mockResolvedValue(new Map());
    h.acquireWithContentionRetry.mockImplementation(async (run: () => Promise<unknown>) => run());
    h.boundedPgReadTxn.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(fakeTx));
  });

  it('uses the shared retry helper and bounded transaction for the primary SELECT', async () => {
    await expect(listScorecards({ subjectRef: 'EI-subject', limit: 1 })).resolves.toEqual([]);

    expect(h.acquireWithContentionRetry).toHaveBeenCalledTimes(1);
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    // The same transaction-local tag builds the main statement and its dynamic
    // SQL fragments, so the exact count is an implementation detail.
    expect(fakeTx).toHaveBeenCalled();
  });

  it('applies the internal typed-subject predicate to the primary SELECT', async () => {
    await expect(listScorecards({ subjectRef: 'plan-alpha#SPEC-P-001@1', subjectKind: 'plan', limit: 1 })).resolves.toEqual([]);

    const calls = fakeTx.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
    const fragments = calls.map(([strings, ...values]) => ({
      sql: Array.from(strings).join('?'),
      values,
    }));
    expect(fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sql: expect.stringContaining("scorecard.payload -> 'observation' -> 'subject' ->> 'ref' = ?"),
        values: ['plan-alpha#SPEC-P-001@1'],
      }),
      expect.objectContaining({
        sql: expect.stringContaining("scorecard.payload -> 'observation' -> 'subject' ->> 'kind' = ?"),
        values: ['plan'],
      }),
    ]));
  });

  it('retries raw PG contention and returns once the bounded read recovers', async () => {
    let attempts = 0;
    h.boundedPgReadTxn.mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw pgError('55P03');
      return [];
    });
    h.acquireWithContentionRetry.mockImplementation(async (run: () => Promise<unknown>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await run();
        } catch (error) {
          if (attempt >= 2) throw error;
        }
      }
    });

    await expect(listScorecards({})).resolves.toEqual([]);
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(2);
  });

  // WI-6554700010018139: a lock_timeout below the statement_timeout makes lock waits
  // surface as 55P03, so 57014 means a slow statement — which a retry only multiplies.
  it('installs the lock timeout and the 57014-excluding retry predicate on the primary SELECT', async () => {
    await listScorecards({ limit: 1 });

    expect(h.boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function), {
      lockTimeoutMs: SCORECARD_READ_LOCK_TIMEOUT_MS,
    });
    expect(h.acquireWithContentionRetry).toHaveBeenCalledWith(expect.any(Function), {
      isRetryable: isScorecardReadRetryable,
    });
  });

  it('does not retry a statement_timeout (57014) and labels it a slow read, not contention', async () => {
    useRealRetry();
    const raw = pgError('57014');
    h.boundedPgReadTxn.mockRejectedValue(raw);

    const error = await listScorecards({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(OrgTxnTimeoutError);
    expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '57014', cause: raw });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect((error as Error).message).toContain('operator read query');
    expect((error as Error).message).toContain('listScorecards');
    expect((error as Error).message).toContain('not lock contention');
  });

  it('retries lock contention (55P03) to exhaustion, then normalizes it as a read lock wait', async () => {
    useRealRetry();
    const raw = pgError('55P03');
    h.boundedPgReadTxn.mockRejectedValue(raw);

    const error = await listScorecards({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(OrgTxnTimeoutError);
    expect(error).toMatchObject({ pgCode: '55P03', cause: raw });
    // One attempt plus one retry per backoff slot.
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(4);
    expect((error as Error).message).toContain('operator read query timed out waiting for a row/advisory lock');
  });

  it('applies the same lock timeout, predicate and normalization to the single-scorecard read', async () => {
    useRealRetry();
    const raw = pgError('57014');
    h.boundedPgReadTxn.mockRejectedValue(raw);

    const error = await readScorecardEvidence('EI-card').catch((caught) => caught);
    expect(error).toBeInstanceOf(OrgTxnTimeoutError);
    expect(error).toMatchObject({ pgCode: '57014', cause: raw });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(1);
    expect(h.boundedPgReadTxn).toHaveBeenCalledWith(expect.any(Function), {
      lockTimeoutMs: SCORECARD_READ_LOCK_TIMEOUT_MS,
    });
    expect((error as Error).message).toContain('readScorecard(evidence)');
  });

  it('scorecardTimeoutLeadIn never labels a statement_timeout as contention', () => {
    expect(scorecardTimeoutLeadIn(new OrgTxnTimeoutError('57014', pgError('57014')), 'scorecards:list read')).toBe(
      'scorecards:list read exceeded its statement timeout (pg 57014: a slow query, not lock contention)',
    );
    expect(scorecardTimeoutLeadIn(new OrgTxnTimeoutError('55P03', pgError('55P03')), 'scorecards:emit')).toBe(
      'scorecards:emit hit transient database contention',
    );
    expect(scorecardTimeoutLeadIn({ name: 'DbCallDeadlineError' }, 'scorecards:get read')).toBe(
      'scorecards:get read hit transient database contention',
    );
  });

  it('isScorecardReadRetryable keeps lock and pool contention, drops statement_timeout', () => {
    expect(isScorecardReadRetryable(pgError('55P03'))).toBe(true);
    expect(isScorecardReadRetryable({ name: 'DbCallDeadlineError', retryable: true })).toBe(true);
    expect(isScorecardReadRetryable(pgError('57014'))).toBe(false);
    expect(isScorecardReadRetryable({ pgCode: '57014' })).toBe(false);
    expect(isScorecardReadRetryable(new Error('undefined column'))).toBe(false);
  });

  it('does not normalize unrelated database failures', async () => {
    const raw = new Error('undefined column');
    h.boundedPgReadTxn.mockRejectedValue(raw);

    await expect(listScorecards({})).rejects.toBe(raw);
  });
});
