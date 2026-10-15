/**
 * scorecards.contention.test.ts — the scorecard primary-read reliability seam
 * (EI-21592547181442895).
 *
 * The SELECT must run through the bounded READ ONLY transaction and shared
 * contention retry. Exhausted PG 55P03/57014 errors are normalized only after
 * the retry helper gives up; unrelated failures remain unchanged.
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

const { listScorecards } = await import('./scorecards');
import { OrgTxnTimeoutError } from './pg-bounded-txn';

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

  it('normalizes exhausted raw PG contention to OrgTxnTimeoutError', async () => {
    const raw = pgError('57014');
    h.boundedPgReadTxn.mockRejectedValue(raw);
    h.acquireWithContentionRetry.mockImplementation(async (run: () => Promise<unknown>) => {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await run();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    });

    const error = await listScorecards({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(OrgTxnTimeoutError);
    expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '57014', cause: raw });
    expect(h.boundedPgReadTxn).toHaveBeenCalledTimes(3);
  });

  it('does not normalize unrelated database failures', async () => {
    const raw = new Error('undefined column');
    h.boundedPgReadTxn.mockRejectedValue(raw);

    await expect(listScorecards({})).rejects.toBe(raw);
  });
});
