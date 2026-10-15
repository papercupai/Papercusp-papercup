/**
 * Unit tests for the index-bloat reindex sweep
 * (db-performance-remediation-2026-07-26 P-004).
 *
 * The sweep is guard-heavy by design — it issues REINDEX ... CONCURRENTLY against the
 * live shared database — so these tests pin the GUARDS and the failure isolation rather
 * than the SQL text: that a long-open transaction or low disk aborts the run before any
 * DDL, that an orphaned *_ccnew duplicate is dropped even when nothing else qualifies,
 * that dryRun issues no DDL at all, and that one failing rebuild never strands the rest.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { runIndexBloatReindexOnce } from './db-index-bloat-reindex';

/** Statements the fake driver was asked to execute, in order. */
interface FakeCall {
  kind: 'template' | 'unsafe' | 'release';
  text: string;
}

interface FakeOpts {
  openTxnSeconds?: number;
  orphans?: Array<{ schema_name: string; index_name: string }>;
  candidates?: Array<{
    schema_name: string;
    index_name: string;
    table_name: string;
    index_bytes: string;
  }>;
  /** Size reported for an index AFTER its rebuild. Default: 10% of before. */
  afterBytes?: Record<string, number>;
  /** Index names whose REINDEX should throw. */
  failOn?: string[];
  dataDirectory?: string;
}

/**
 * Minimal stand-in for the postgres.js tagged-template driver. Dispatches on
 * distinctive text in the query so the tests do not depend on exact formatting.
 */
function makeFakeSql(opts: FakeOpts = {}) {
  const calls: FakeCall[] = [];
  const sizes = new Map<string, number>();
  for (const c of opts.candidates ?? []) {
    const after = opts.afterBytes?.[c.index_name] ?? Math.floor(Number(c.index_bytes) * 0.1);
    sizes.set(c.index_name, after);
  }

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ kind: 'template', text });

    if (text.includes('max_open_seconds')) {
      return Promise.resolve([{ max_open_seconds: opts.openTxnSeconds ?? 0 }]);
    }
    if (text.includes('_ccnew') || text.includes('_ccold')) {
      return Promise.resolve(opts.orphans ?? []);
    }
    if (text.includes('data_directory')) {
      return Promise.resolve(
        opts.dataDirectory ? [{ data_directory: opts.dataDirectory }] : [],
      );
    }
    if (text.includes('amname')) {
      return Promise.resolve(opts.candidates ?? []);
    }
    if (text.includes('pg_relation_size')) {
      // Post-rebuild size probe: the bound value is 'schema.index'.
      const ref = String(values[0] ?? '');
      const idx = ref.split('.').pop() ?? '';
      return Promise.resolve([{ bytes: String(sizes.get(idx) ?? 0) }]);
    }
    return Promise.resolve([]);
  }) as unknown as postgres.Sql & { __calls: FakeCall[] };

  const unsafe = (q: string) => {
    calls.push({ kind: 'unsafe', text: q });
    const failing = (opts.failOn ?? []).find((n) => q.includes(n));
    if (failing) return Promise.reject(new Error(`boom: ${failing}`));
    return Promise.resolve([]);
  };
  (sql as unknown as { unsafe: typeof unsafe }).unsafe = unsafe;
  // A reserved connection shares the call log so ordering across both is observable.
  (sql as unknown as { reserve: () => Promise<unknown> }).reserve = () =>
    Promise.resolve({ unsafe, release: () => calls.push({ kind: 'release', text: 'release' }) });

  (sql as unknown as { __calls: FakeCall[] }).__calls = calls;
  return sql as postgres.Sql & { __calls: FakeCall[] };
}

const candidate = (name: string, bytes = 500 * 1024 * 1024) => ({
  schema_name: 'harness_shared',
  index_name: name,
  table_name: 'route_invocations',
  index_bytes: String(bytes),
});

describe('runIndexBloatReindexOnce', () => {
  it('refuses to run while a long transaction is open (CONCURRENTLY would just park)', async () => {
    const sql = makeFakeSql({ openTxnSeconds: 900, candidates: [candidate('idx_a')] });
    const r = await runIndexBloatReindexOnce(sql, { maxOpenTxnSeconds: 60 });

    expect(r.skipped).toBe('long-running-transaction');
    expect(r.reindexed).toHaveLength(0);
    // The critical assertion: it bailed BEFORE issuing any DDL.
    expect(sql.__calls.filter((c) => c.kind === 'unsafe')).toHaveLength(0);
  });

  it('rebuilds a bloated index and reports the space reclaimed', async () => {
    const sql = makeFakeSql({
      candidates: [candidate('route_invocations_ws_time_idx', 4117 * 1024 * 1024)],
      afterBytes: { route_invocations_ws_time_idx: 99 * 1024 * 1024 },
    });
    const r = await runIndexBloatReindexOnce(sql);

    expect(r.skipped).toBeUndefined();
    expect(r.reindexed).toHaveLength(1);
    expect(r.reindexed[0]?.error).toBeUndefined();
    expect(r.bytesReclaimed).toBe((4117 - 99) * 1024 * 1024);

    const ddl = sql.__calls.filter((c) => c.kind === 'unsafe');
    expect(ddl).toHaveLength(1);
    // CONCURRENTLY is the whole safety story — assert it explicitly.
    expect(ddl[0]?.text).toContain('REINDEX INDEX CONCURRENTLY');
    expect(ddl[0]?.text).toContain('route_invocations_ws_time_idx');
  });

  it('drops an orphaned *_ccnew duplicate even when no index needs rebuilding', async () => {
    const sql = makeFakeSql({
      orphans: [{ schema_name: 'harness_shared', index_name: 'harness_plans_search_idx_ccnew' }],
      candidates: [],
    });
    const r = await runIndexBloatReindexOnce(sql);

    expect(r.orphansDropped).toEqual(['harness_shared.harness_plans_search_idx_ccnew']);
    // No candidates, but an orphan WAS cleaned — so this is not a "nothing happened" run.
    expect(r.skipped).toBeUndefined();
    const drops = sql.__calls.filter((c) => c.text.includes('DROP INDEX CONCURRENTLY'));
    expect(drops).toHaveLength(1);
  });

  // WI-6554700010008628: the cleanup used to sit behind the long-transaction guard, so a
  // pg_dump open at tick time skipped it every day and 8 orphans (~740 MB) accumulated.
  it('drops orphans even while a long transaction blocks the REINDEX, under a bounded lock_timeout', async () => {
    const sql = makeFakeSql({
      openTxnSeconds: 900,
      orphans: [{ schema_name: 'harness_shared', index_name: 'route_invocations_ws_time_idx_ccnew' }],
      candidates: [candidate('idx_a')],
    });
    const r = await runIndexBloatReindexOnce(sql, { maxOpenTxnSeconds: 60, orphanLockTimeoutMs: 5000 });

    expect(r.skipped).toBe('long-running-transaction');
    expect(r.orphansDropped).toEqual(['harness_shared.route_invocations_ws_time_idx_ccnew']);
    expect(r.orphanDropFailures).toEqual([]);
    const seq = sql.__calls.filter((c) => c.kind !== 'template').map((c) => c.text);
    expect(seq).toEqual([
      'SET lock_timeout = 5000',
      'DROP INDEX CONCURRENTLY IF EXISTS "harness_shared"."route_invocations_ws_time_idx_ccnew"',
      'RESET lock_timeout',
      'release',
    ]);
    // The REINDEX half still honours the guard.
    expect(seq.some((t) => t.includes('REINDEX'))).toBe(false);
  });

  it('reports an orphan it cannot drop instead of swallowing the error', async () => {
    const sql = makeFakeSql({
      orphans: [{ schema_name: 'harness_shared', index_name: 'carry_notes_bm25_ccnew' }],
      failOn: ['carry_notes_bm25_ccnew'],
    });
    const r = await runIndexBloatReindexOnce(sql);

    expect(r.orphansDropped).toEqual([]);
    expect(r.orphanDropFailures).toEqual([
      { index: 'harness_shared.carry_notes_bm25_ccnew', error: 'boom: carry_notes_bm25_ccnew' },
    ]);
    // The session setting is still reset and the connection released after a failure.
    const seq = sql.__calls.filter((c) => c.kind !== 'template').map((c) => c.text);
    expect(seq).toEqual([
      'SET lock_timeout = 10000',
      'DROP INDEX CONCURRENTLY IF EXISTS "harness_shared"."carry_notes_bm25_ccnew"',
      'RESET lock_timeout',
      'release',
    ]);
  });

  it('never targets a table whose index build is in flight', async () => {
    const sql = makeFakeSql({ orphans: [] });
    await runIndexBloatReindexOnce(sql);
    const orphanQuery = sql.__calls.find((c) => c.kind === 'template' && c.text.includes('_ccnew'));
    expect(orphanQuery?.text).toContain('pg_stat_progress_create_index');
  });

  it('dryRun lists orphans without dropping them', async () => {
    const sql = makeFakeSql({
      orphans: [{ schema_name: 'harness_shared', index_name: 'shared_presence_pkey_ccnew' }],
    });
    const r = await runIndexBloatReindexOnce(sql, { dryRun: true });

    expect(r.orphansFound).toEqual(['harness_shared.shared_presence_pkey_ccnew']);
    expect(r.orphansDropped).toEqual([]);
    expect(sql.__calls.filter((c) => c.kind !== 'template')).toHaveLength(0);
  });

  it('reports no-candidates when there is genuinely nothing to do', async () => {
    const sql = makeFakeSql({ candidates: [], orphans: [] });
    const r = await runIndexBloatReindexOnce(sql);

    expect(r.skipped).toBe('no-candidates');
    expect(sql.__calls.filter((c) => c.kind === 'unsafe')).toHaveLength(0);
  });

  it('dryRun lists candidates without issuing any DDL', async () => {
    const sql = makeFakeSql({ candidates: [candidate('idx_a'), candidate('idx_b')] });
    const r = await runIndexBloatReindexOnce(sql, { dryRun: true });

    expect(r.reindexed).toHaveLength(2);
    expect(r.bytesReclaimed).toBe(0);
    expect(sql.__calls.filter((c) => c.kind === 'unsafe')).toHaveLength(0);
  });

  it('isolates a failed rebuild so the rest of the sweep still runs', async () => {
    const sql = makeFakeSql({
      candidates: [candidate('idx_bad'), candidate('idx_good')],
      failOn: ['idx_bad'],
    });
    const r = await runIndexBloatReindexOnce(sql);

    expect(r.reindexed).toHaveLength(2);
    const bad = r.reindexed.find((x) => x.index === 'idx_bad');
    const good = r.reindexed.find((x) => x.index === 'idx_good');
    expect(bad?.error).toMatch(/boom/);
    expect(good?.error).toBeUndefined();
    // The failed one must not be counted as space reclaimed.
    expect(r.bytesReclaimed).toBe(Number(candidate('idx_good').index_bytes) * 0.9);
  });

  it('honours the per-run cap by passing it through as the query LIMIT', async () => {
    const sql = makeFakeSql({ candidates: [candidate('idx_a')] });
    await runIndexBloatReindexOnce(sql, { maxIndexesPerRun: 3 });

    const sel = sql.__calls.find((c) => c.text.includes('amname'));
    expect(sel).toBeDefined();
    expect(sel?.text).toContain('LIMIT');
  });
});
