import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countNeverAttemptedCandidates,
  reconcileProposedCompletionsAtCommit,
  type CompletionSettlementReconcilerDeps,
} from './completion-settlement-reconciler';
import type { SettlementFireObservation } from './completion-settlement-health';

// WI-10004400: the reconciler's per-fire result used to be discarded by its only caller, so the
// standing guard is fed from INSIDE the reconciler. These cases pin that wiring: which fires are
// observed, what a cut-short fire reports (null stats, never a fabricated zero), and that the
// guard can never fail the settlement pass it watches.

const SHA = 'a'.repeat(40);
const scope = { installSlug: 'papercusp', workspaceId: 'papercusp-workspace', repositoryRoot: '/repo' };
type Sql = NonNullable<CompletionSettlementReconcilerDeps['sql']>;

function fakeSql(handlers: { select?: () => unknown; count?: () => unknown } = {}) {
  const queries: string[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    queries.push(text);
    if (/count\(\*\)/.test(text)) return (await handlers.count?.()) ?? [];
    if (/SELECT feature_id, harness_slug, payload/.test(text)) return (await handlers.select?.()) ?? [];
    return [];
  }) as unknown as Sql;
  (sql as unknown as { json: (value: unknown) => unknown }).json = (value) => value;
  return { sql, queries };
}

afterEach(() => vi.restoreAllMocks());

describe('standing-guard wiring in reconcileProposedCompletionsAtCommit', () => {
  it('observes a completed fire with the DB-measured never-attempted count', async () => {
    const { sql } = fakeSql({ count: () => [{ n: '4' }] });
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth });
    expect(recordHealth).toHaveBeenCalledTimes(1);
    expect(recordHealth.mock.calls[0]![0]).toEqual({
      outcome: 'completed',
      inspected: 0,
      upgraded: 0,
      residual: 0,
      unreadable: 0,
      floorRejected: 0,
      lookupUnavailable: 0,
      neverAttemptedRemaining: 4,
    });
  });

  it('observes a cut-short fire as budget-exceeded with null per-row stats, and rethrows', async () => {
    const { sql } = fakeSql({ count: () => [{ n: '7' }] });
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    const controller = new AbortController();
    const budget = new Error('settlement budget');
    controller.abort(budget);
    await expect(
      reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth, signal: controller.signal }),
    ).rejects.toBe(budget);
    expect(recordHealth.mock.calls[0]![0]).toEqual({
      outcome: 'budget-exceeded',
      neverAttemptedRemaining: 7,
      error: 'settlement budget',
    });
  });

  it('observes a non-abort failure as an error and rethrows the original', async () => {
    const boom = new Error('pg exploded');
    const { sql } = fakeSql({
      select: () => {
        throw boom;
      },
      count: () => [{ n: '2' }],
    });
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await expect(reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth })).rejects.toBe(boom);
    expect(recordHealth.mock.calls[0]![0]).toMatchObject({ outcome: 'error', neverAttemptedRemaining: 2, error: 'pg exploded' });
  });

  it('records an unmeasured count as null and still records the fire', async () => {
    const { sql } = fakeSql({
      count: () => {
        throw new Error('count failed');
      },
    });
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth });
    expect(recordHealth.mock.calls[0]![0]).toMatchObject({ outcome: 'completed', neverAttemptedRemaining: null });
  });

  it('does not observe a no-op call (bad sha / blank root measured nothing)', async () => {
    const { sql, queries } = fakeSql();
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit('not-a-sha', scope, { sql, recordHealth });
    await reconcileProposedCompletionsAtCommit(SHA, { ...scope, repositoryRoot: '  ' }, { sql, recordHealth });
    expect(recordHealth).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it('stays hermetic for a fixture that injects sql without a recorder: no count query, no write', async () => {
    const { sql, queries } = fakeSql();
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/SELECT feature_id, harness_slug, payload/);
  });

  it('never fails the settlement pass when the recorder itself throws', async () => {
    const { sql } = fakeSql();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordHealth = vi.fn(async () => {
      throw new Error('routine row locked');
    });
    await expect(reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth })).resolves.toMatchObject({
      inspected: 0,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record the standing-guard observation: routine row locked'));
  });
});

describe('countNeverAttemptedCandidates', () => {
  it('counts the uncapped never-attempted tier for exactly this workspace and checkout', async () => {
    const { sql, queries } = fakeSql({ count: () => [{ n: '28' }] });
    await expect(countNeverAttemptedCandidates(scope, { sql })).resolves.toBe(28);
    expect(sql).toHaveBeenCalledTimes(1);
    const [strings, ...values] = vi.mocked(sql).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values).toContain('papercusp-workspace');
    expect(values).toContain('/repo');
    // mirrors the candidate SELECT's scope and its "no residualPaths array" tier — and is
    // deliberately NOT capped, or a starved tail would read as a constant batch size
    expect(queries[0]).toMatch(/authority = 'proposed'/);
    expect(queries[0]).toMatch(/jsonb_typeof\([^)]*\) IS DISTINCT FROM 'array'/);
    expect(queries[0]).not.toMatch(/LIMIT/);
    expect(strings.length).toBeGreaterThan(1);
  });

  it('reads an empty result as zero', async () => {
    const { sql } = fakeSql({ count: () => [] });
    await expect(countNeverAttemptedCandidates(scope, { sql })).resolves.toBe(0);
  });

  // EI-24758680272435881: a close that lands mid-pass is the next pass's to attempt. Counting
  // it held the streak non-zero under steady close traffic (failing / streak 32 on a pass that
  // wrote its first row), so the count takes a written-before cutoff.
  it('counts only rows last written before the cutoff when one is given', async () => {
    const { sql, queries } = fakeSql({ count: () => [{ n: '2' }] });
    await expect(countNeverAttemptedCandidates(scope, { sql, eligibleBeforeMs: 1_790_846_000_000 })).resolves.toBe(2);
    const [, ...values] = vi.mocked(sql).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(queries[0]).toMatch(/AND updated_ts < \?$/);
    expect(values[values.length - 1]).toBe(1_790_846_000_000);
  });

  it('applies no effective cutoff when none is given (all-time census)', async () => {
    const { sql } = fakeSql({ count: () => [{ n: '28' }] });
    await expect(countNeverAttemptedCandidates(scope, { sql })).resolves.toBe(28);
    const [, ...values] = vi.mocked(sql).mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(values[values.length - 1]).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('never-attempted cutoff wiring (EI-24758680272435881)', () => {
  it('measures the remaining tier against the fire start, stamped before the candidate SELECT', async () => {
    let selectIssuedAt = 0;
    const { sql } = fakeSql({
      select: () => {
        selectIssuedAt = Date.now();
        return [];
      },
      count: () => [{ n: '0' }],
    });
    const before = Date.now();
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth });
    const countCall = vi
      .mocked(sql)
      .mock.calls.find((call) => /count\(\*\)/.test((call[0] as unknown as TemplateStringsArray).join('?')));
    expect(countCall).toBeDefined();
    const cutoff = (countCall as unknown as unknown[])[(countCall as unknown as unknown[]).length - 1] as number;
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(selectIssuedAt);
    expect(recordHealth.mock.calls[0]![0]).toMatchObject({ outcome: 'completed', neverAttemptedRemaining: 0 });
  });

  it('passes the same fire-start cutoff when the pass is cut short', async () => {
    const controller = new AbortController();
    const { sql } = fakeSql({
      select: () => {
        controller.abort(new Error('budget'));
        return [];
      },
      count: () => [{ n: '1' }],
    });
    const before = Date.now();
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await expect(
      reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth, signal: controller.signal }),
    ).rejects.toThrow('budget');
    const countCall = vi
      .mocked(sql)
      .mock.calls.find((call) => /count\(\*\)/.test((call[0] as unknown as TemplateStringsArray).join('?')));
    const cutoff = (countCall as unknown as unknown[])[(countCall as unknown as unknown[]).length - 1] as number;
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(Date.now());
    expect(recordHealth.mock.calls[0]![0]).toMatchObject({ outcome: 'budget-exceeded', neverAttemptedRemaining: 1 });
  });
});

describe('WI-10005560: history memo persistence wiring', () => {
  const emptyStore = () => ({
    load: vi.fn(async (_limit: number) => []),
    save: vi.fn(async () => {}),
  });

  it('loads the stored verdicts before the candidate SELECT, once per pass', async () => {
    const { sql, queries } = fakeSql();
    const store = emptyStore();
    const queriesAtLoad: number[] = [];
    store.load.mockImplementation(async () => {
      queriesAtLoad.push(queries.length);
      return [];
    });
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth, historyMemoStore: store });
    await reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth, historyMemoStore: store });
    // An injected store stands for a fresh process per pass, so each pass hydrates.
    expect(queriesAtLoad).toEqual([0, queries.length / 2]);
    // Nothing was learned (no candidates), so nothing is written.
    expect(store.save).not.toHaveBeenCalled();
  });

  it('a store that cannot load never fails the pass', async () => {
    const { sql } = fakeSql();
    const store = emptyStore();
    store.load.mockRejectedValue(new Error('memo table missing'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await expect(
      reconcileProposedCompletionsAtCommit(SHA, scope, { sql, recordHealth, historyMemoStore: store }),
    ).resolves.toMatchObject({ inspected: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not load the history search memo: memo table missing'));
    expect(recordHealth.mock.calls[0]![0]).toMatchObject({ outcome: 'completed' });
  });

  it('a lookup seam runs no history reader, so the store is never touched', async () => {
    const { sql } = fakeSql();
    const store = emptyStore();
    const recordHealth = vi.fn(async (_o: SettlementFireObservation) => {});
    await reconcileProposedCompletionsAtCommit(SHA, scope, {
      sql,
      recordHealth,
      historyMemoStore: store,
      lookup: async () => new Map(),
    });
    expect(store.load).not.toHaveBeenCalled();
  });
});
