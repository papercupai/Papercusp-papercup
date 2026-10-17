import { describe, expect, it, vi } from 'vitest';

import tool, {
  classifyPgStatStatementsError,
  diffPgStatements,
  samplePgHotQueries,
  type PgStatementSnapshotRow,
  type PgStatementsSnapshot,
} from './pg_hot_queries';

const T0 = Date.parse('2026-07-26T12:00:00.000Z');

function row(
  queryId: string,
  query: string,
  values: Partial<Pick<PgStatementSnapshotRow, 'calls' | 'totalExecMs' | 'rows' | 'statsSinceMs'>> = {},
): PgStatementSnapshotRow {
  return {
    key: `10:20:true:${queryId}`,
    userId: '10',
    dbId: '20',
    topLevel: true,
    queryId,
    query,
    calls: values.calls ?? 0n,
    totalExecMs: values.totalExecMs ?? 0,
    rows: values.rows ?? 0n,
    statsSinceMs: values.statsSinceMs ?? T0 - 1_000_000,
  };
}

function snapshot(
  at: number,
  rows: PgStatementSnapshotRow[],
  capStats: Partial<Pick<PgStatementsSnapshot, 'dealloc' | 'entryCount' | 'capMax'>> = {},
): PgStatementsSnapshot {
  return {
    capturedAtMs: at,
    rows,
    dealloc: capStats.dealloc ?? 0,
    entryCount: capStats.entryCount ?? rows.length,
    capMax: capStats.capMax ?? 10_000,
  };
}

describe('dev:pg_hot_queries delta engine', () => {
  it('ranks by IN-WINDOW exec time and still captures high-frequency short queries', () => {
    const before = snapshot(T0, [
      row('slow', 'SELECT slow()', { calls: 10n, totalExecMs: 1000, rows: 10n }),
      row('fast', 'SELECT fast()', { calls: 100n, totalExecMs: 100, rows: 1000n }),
    ]);
    const after = snapshot(T0 + 10_000, [
      row('slow', 'SELECT slow()', { calls: 12n, totalExecMs: 2000, rows: 12n }),
      row('fast', 'SELECT fast()', { calls: 1100n, totalExecMs: 150, rows: 51_000n }),
    ]);

    const result = diffPgStatements(before, after, { limit: 15 });

    expect(result.hot.map((r) => r.queryId)).toEqual(['slow', 'fast']);
    expect(result.hot[0].inWindow).toMatchObject({ execMs: 1000, calls: '2', msPerCall: 500 });
    expect(result.hot[1].inWindow).toMatchObject({
      execMs: 50,
      calls: '1000',
      callsPerSec: 100,
      msPerCall: 0.05,
      rowsPerCall: 50,
    });
    expect(result.sample.activeStatements).toBe(2);
  });

  it('labels a powered zero dead while refusing to overclaim for a rare query', () => {
    const statsSince = T0 - 1000_000;
    const beforeRows = [
      row('dead', 'SELECT formerly_hot()', {
        calls: 10_000n,
        totalExecMs: 500_000,
        statsSinceMs: statsSince,
      }),
      row('rare', 'COPY rare_archive', {
        calls: 1n,
        totalExecMs: 400_000,
        statsSinceMs: statsSince,
      }),
    ];
    const result = diffPgStatements(snapshot(T0, beforeRows), snapshot(T0 + 10_000, beforeRows), { limit: 15 });

    expect(result.hot).toEqual([]);
    expect(result.staleLifetimeLeaders).toHaveLength(2);
    const dead = result.staleLifetimeLeaders.find((r) => r.queryId === 'dead')!;
    const rare = result.staleLifetimeLeaders.find((r) => r.queryId === 'rare')!;
    expect(dead).toMatchObject({ stale: true, zeroCallVerdict: 'dead' });
    expect(dead.statisticalPower?.confidencePct).toBeGreaterThanOrEqual(95);
    expect(rare).toMatchObject({ stale: true, zeroCallVerdict: 'too-rare-to-tell' });
    expect(rare.statisticalPower?.confidencePct).toBeLessThan(95);
    expect(result.note).toContain('not proof');
  });

  it('never emits negative deltas after a counter reset and marks the reset', () => {
    const result = diffPgStatements(
      snapshot(T0, [row('q', 'SELECT reset()', { calls: 100n, totalExecMs: 5000, rows: 200n })]),
      snapshot(T0 + 5000, [row('q', 'SELECT reset()', { calls: 2n, totalExecMs: 20, rows: 4n })]),
      { limit: 5 },
    );

    expect(result.hot[0]).toMatchObject({ counterReset: true });
    expect(result.hot[0].inWindow).toMatchObject({ calls: '2', execMs: 20, rows: '4' });
  });

  it('EI-19447625969710283: reports no eviction pressure when dealloc did not move', () => {
    const before = snapshot(T0, [row('q', 'SELECT stable()', { calls: 1n, totalExecMs: 1 })], {
      dealloc: 331,
      entryCount: 9571,
      capMax: 10_000,
    });
    const after = snapshot(T0 + 5000, [row('q', 'SELECT stable()', { calls: 2n, totalExecMs: 2 })], {
      dealloc: 331,
      entryCount: 9575,
      capMax: 10_000,
    });

    const result = diffPgStatements(before, after, { limit: 5 });

    expect(result.sample.capPressure).toMatchObject({
      entryCount: 9575,
      capMax: 10_000,
      occupancyPct: 95.8,
      deallocBefore: 331,
      deallocAfter: 331,
      deallocDuringWindow: 0,
      evictedDuringWindow: false,
    });
    expect(result.note).not.toContain('evictedDuringWindow');
  });

  it('EI-19447625969710283: flags cluster-wide eviction during the window and warns a counterReset row is a phantom spike', () => {
    // The row itself was evicted-and-recreated mid-window (counterReset), AND the
    // cluster-wide dealloc counter moved — the whole-cluster confirmation that this
    // was genuinely a cap eviction, not e.g. a targeted per-dbid stats reset of just
    // this one entry.
    const before = snapshot(T0, [row('q', 'SELECT hot()', { calls: 500n, totalExecMs: 9000 })], {
      dealloc: 331,
      entryCount: 9999,
      capMax: 10_000,
    });
    const after = snapshot(T0 + 5000, [row('q', 'SELECT hot()', { calls: 3n, totalExecMs: 12 })], {
      dealloc: 334,
      entryCount: 10_000,
      capMax: 10_000,
    });

    const result = diffPgStatements(before, after, { limit: 5 });

    expect(result.hot[0]).toMatchObject({ counterReset: true });
    expect(result.sample.capPressure).toMatchObject({
      entryCount: 10_000,
      capMax: 10_000,
      occupancyPct: 100,
      deallocBefore: 331,
      deallocAfter: 334,
      deallocDuringWindow: 3,
      evictedDuringWindow: true,
    });
    expect(result.note).toContain('evictedDuringWindow=true');
    expect(result.note).toContain('3 entries evicted cluster-wide');
  });

  it('treats a dealloc counter that went backwards as a global reset, not a negative eviction count', () => {
    // pg_stat_statements_reset(0,0,0,false) zeroes dealloc along with everything else.
    // A naive after-before would report -331 evictions; the shared deltaNumber helper
    // (same one used for calls/execMs/rows) must read this as "331" (a fresh start),
    // matching how every other counter in this tool already handles a reset.
    const before = snapshot(T0, [], { dealloc: 331, entryCount: 9571, capMax: 10_000 });
    const after = snapshot(T0 + 5000, [], { dealloc: 0, entryCount: 3, capMax: 10_000 });

    const result = diffPgStatements(before, after, { limit: 5 });

    expect(result.sample.capPressure.deallocDuringWindow).toBe(0);
    expect(result.sample.capPressure.evictedDuringWindow).toBe(false);
  });

  it('filters case-insensitively and excludes the sampler from its own answer', () => {
    const before = snapshot(T0, []);
    const after = snapshot(T0 + 1000, [
      row('wanted', 'SELECT * FROM Important_Table', { calls: 2n, totalExecMs: 10 }),
      row('other', 'SELECT * FROM elsewhere', { calls: 3n, totalExecMs: 30 }),
      row('self', 'SELECT /* dev:pg_hot_queries sampler */ * FROM pg_stat_statements', {
        calls: 1n,
        totalExecMs: 50,
      }),
    ]);

    const result = diffPgStatements(before, after, { limit: 15, filter: 'important_table' });
    expect(result.hot.map((r) => r.queryId)).toEqual(['wanted']);
    expect(result.sample.matchedStatements).toBe(1);
  });

  it('waits exactly once between snapshots and reports the requested versus actual window', async () => {
    const reads = [snapshot(T0, []), snapshot(T0 + 2200, [])];
    const sleep = vi.fn(async () => undefined);
    const result = await samplePgHotQueries({ windowSec: 2, limit: 7 }, undefined, {
      readSnapshot: vi.fn(async () => reads.shift()!),
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(result).toMatchObject({ requestedWindowSec: 2, limit: 7 });
    expect(result.sample.actualWindowSec).toBe(2.2);
  });
});

describe('dev:pg_hot_queries tool contract', () => {
  it('does not retain an ambient workspace transaction while sampling', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('declares enough handler time for the maximum sampling window and snapshots', () => {
    expect((tool as unknown as { timeoutSec?: number }).timeoutSec).toBe(660);
  });

  it('classifies extension absence, preload absence and permission denial distinctly', () => {
    expect(classifyPgStatStatementsError(Object.assign(new Error('missing'), { code: '42P01' }))).toMatchObject({
      reason: 'pg_stat_statements_not_installed',
    });
    expect(
      classifyPgStatStatementsError(
        Object.assign(new Error('pg_stat_statements must be loaded via shared_preload_libraries'), {
          code: '55000',
        }),
      ),
    ).toMatchObject({ reason: 'pg_stat_statements_not_loaded' });
    expect(classifyPgStatStatementsError(Object.assign(new Error('denied'), { code: '42501' }))).toMatchObject({
      reason: 'pg_stat_statements_permission_denied',
    });
  });
});
