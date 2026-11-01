/**
 * BM25 lexical latency budgets (plan bm25-lexical-search-evoke-adoption-2026-10-10:
 * requirements R-2 p95 <= 50 ms and R-3 p50 <= 10 ms; item P-004).
 *
 * The budgets are judged on the real work-item corpus by the bake-off bench and by the
 * health check's canary timing on the live server. This suite pins the measuring code and
 * its verdict on a preloaded server: the canary queries run against the work-item index,
 * the percentiles are ordered, the seeded corpus meets both budgets, and a p95 over budget
 * turns the health check to `degraded`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  BM25_LATENCY_CANARY_QUERIES,
  BM25_LATENCY_REPETITIONS_PER_QUERY,
  BM25_P95_BUDGET_MS,
  bm25Health,
  measureBm25Latency,
  percentileMs,
  resetBm25Availability,
} from './rank';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

const P50_BUDGET_MS = 10;

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('lexical latency budgets (R-2, R-3)', () => {
  it('times every canary through the guarded top-k path on the work-item index', async () => {
    const latency = await measureBm25Latency(sql);
    expect(latency?.corpusIndex).toBe('work_items_bm25');
    expect(latency?.samplesMs).toHaveLength(
      BM25_LATENCY_CANARY_QUERIES.length * BM25_LATENCY_REPETITIONS_PER_QUERY,
    );
    expect(latency!.budgetMs).toBe(BM25_P95_BUDGET_MS);
    expect(latency!.p95Ms).toBeGreaterThanOrEqual(latency!.p50Ms);
    expect(latency!.p50Ms).toBe(percentileMs(latency!.samplesMs, 50));
  });

  it('meets the p95 and p50 budgets on the seeded corpus, warm', async () => {
    await measureBm25Latency(sql); // warm the index pages and the plan cache
    const latency = await measureBm25Latency(sql);
    expect(latency!.p95Ms).toBeLessThanOrEqual(BM25_P95_BUDGET_MS);
    expect(latency!.p50Ms).toBeLessThanOrEqual(P50_BUDGET_MS);
  });

  it('reports degraded when the p95 exceeds the budget, and ok within it', async () => {
    const latency = await measureBm25Latency(sql);
    const within = { ...latency!, p95Ms: latency!.budgetMs - 1 };
    expect((await bm25Health(sql, { latency: within })).status).toBe('ok');
    const slow = { ...latency!, p95Ms: latency!.budgetMs + 1 };
    const verdict = await bm25Health(sql, { latency: slow });
    expect(verdict.status).toBe('degraded');
    expect(verdict.reason).toContain(`exceeds the ${BM25_P95_BUDGET_MS}ms budget`);
    expect(verdict.latency).toEqual(slow);
  });
});
