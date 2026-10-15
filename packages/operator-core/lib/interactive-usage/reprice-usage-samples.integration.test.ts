/**
 * WI-10004517 / agent-economy-flywheel D-018 against real migrations (1280 column, 1281 index).
 * This is the guard for "the next price change leaves stored estimates stale": a row stamped
 * with any other table version is re-derived and stamped, NULL-cost rows for priced models are
 * costed, provider cost is never touched, and a finished pass is a no-op.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { PRICE_TABLE_VERSION, costFromTokens, type CostOptions, type TokenUsage } from '@papercusp/model-pricing';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  PG_BIGINT_AS_NUMBER_TYPES,
  PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES,
  installNumericArrayTyping,
  restoreRawDateSerializers,
  restoreRawJsonbSerializer,
  seedBuiltinArrayTypes,
} from '../../../../libs/papercusp/libs/db/src/raw-serializers';
import { repriceUsageSamples } from './reprice-usage-samples';

const WS = 'ws-reprice-it';
let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
});

interface Seed {
  source: string;
  provider: string;
  model: string | null;
  cost: number | null;
  costSource: string | null;
  version: string | null;
  grain?: string;
}

async function seed(s: Seed): Promise<number> {
  const [r] = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cache_creation_5m_tokens, cache_creation_1h_tokens,
       cost_usd, model, cost_source, usage_provenance, price_table_version)
    VALUES (${WS}, ${Date.now()}, ${`${s.provider}:x`}, ${s.provider}, 'x', ${s.source},
      1200, 300, 50000, 2000, ${s.provider === 'anthropic' ? 1500 : null}, ${s.provider === 'anthropic' ? 500 : null},
      ${s.cost}, ${s.model}, ${s.costSource}, ${JSON.stringify(s.grain ? { grain: s.grain } : {})}::jsonb, ${s.version})
    RETURNING id::text AS id`;
  return Number(r!.id);
}

async function read(id: number) {
  const [r] = await sql<Array<{ cost_usd: number | null; cost_source: string | null; price_table_version: string | null }>>`
    SELECT cost_usd, cost_source, price_table_version FROM harness_shared.agent_usage_samples WHERE id = ${id}`;
  return r!;
}

describe('repriceUsageSamples', () => {
  it('re-derives stale and never-stamped estimates, costs now-priced NULL rows, and leaves provider cost alone', async () => {
    const frozen = await seed({ source: 'interactive', provider: 'anthropic', model: 'claude-opus-4-8', cost: 999, costSource: 'estimated', version: null, grain: 'request' });
    const oldTable = await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cost: 7, costSource: 'estimated', version: 'an-older-table' });
    const wasUnpriced = await seed({ source: 'headers', provider: 'openai', model: 'gpt-5.5', cost: null, costSource: null, version: 'an-older-table' });
    const stillUnknown = await seed({ source: 'jsonl', provider: 'openai', model: 'probe', cost: null, costSource: null, version: null });
    const provider = await seed({ source: 'jsonl', provider: 'anthropic', model: 'claude-opus-4-8', cost: 0.42, costSource: 'provider', version: null });
    const current = await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cost: 123, costSource: 'estimated', version: PRICE_TABLE_VERSION });

    const result = await repriceUsageSamples(sql, { workspaceId: WS, batchSize: 2 });

    expect(result).toMatchObject({ version: PRICE_TABLE_VERSION, stamped: 4, changed: 3, newlyPriced: 1, newlyUnpriced: 0, skippedConcurrent: 0, complete: true });
    // Fixed sheet-rate arithmetic: Opus 5/25/0.5/6.25/10; GPT-5.5 2.5/20/0.25/2.5 per million.
    expect(await read(frozen)).toEqual({ cost_usd: 0.052875, cost_source: 'estimated', price_table_version: PRICE_TABLE_VERSION });
    expect(await read(oldTable)).toEqual({ cost_usd: 0.0265, cost_source: 'estimated', price_table_version: PRICE_TABLE_VERSION });
    expect(await read(wasUnpriced)).toEqual({ cost_usd: 0.0265, cost_source: 'estimated', price_table_version: PRICE_TABLE_VERSION });
    expect(await read(stillUnknown)).toEqual({ cost_usd: null, cost_source: null, price_table_version: PRICE_TABLE_VERSION });
    // An observation is never re-priced or stamped.
    expect(await read(provider)).toEqual({ cost_usd: 0.42, cost_source: 'provider', price_table_version: null });
    // A row already on the running table is not revisited, whatever its value.
    expect(await read(current)).toEqual({ cost_usd: 123, cost_source: 'estimated', price_table_version: PRICE_TABLE_VERSION });

    // A finished pass is a no-op.
    expect(await repriceUsageSamples(sql, { workspaceId: WS })).toMatchObject({ stamped: 0, changed: 0, complete: true });
  });

  it('a price change re-prices every estimate, and a model leaving the table unprices it', async () => {
    const a = await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cost: null, costSource: null, version: null });
    const b = await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-4o', cost: null, costSource: null, version: null });
    await repriceUsageSamples(sql, { workspaceId: WS });
    expect((await read(a)).cost_usd).toBe(0.0265);

    // The next table: gpt-5.5 doubles, gpt-4o is withdrawn.
    const nextTable = (model: string, usage: TokenUsage, options?: CostOptions) => {
      if (model === 'gpt-4o') return { usd: 0, priced: false };
      const est = costFromTokens(model, usage, options);
      return { ...est, usd: est.usd * 2 };
    };
    const result = await repriceUsageSamples(sql, { workspaceId: WS, version: 'next-table', price: nextTable });

    expect(result).toMatchObject({ stamped: 2, changed: 2, newlyPriced: 0, newlyUnpriced: 1, complete: true });
    expect((await read(a)).cost_usd).toBeCloseTo(0.053, 12);
    expect(await read(b)).toEqual({ cost_usd: null, cost_source: null, price_table_version: 'next-table' });
  });

  it('keeps a pre-split cache-write row priced at the 5-minute floor instead of nulling it', async () => {
    // WI-10004517 dry run, 2026-10-01: re-deriving these rows under the tier-unknown rule would
    // have turned ~8.5k priced live rows (opus-4-7/4-8, sonnet-4-6, opus-5) into NULL.
    const [r] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, cost_usd, model, cost_source, usage_provenance)
      VALUES (${WS}, ${Date.now()}, 'anthropic:x', 'anthropic', 'x', 'interactive', 1200, 300, 50000, 2000,
        5.5, 'claude-opus-4-8', 'estimated', '{"grain":"request"}'::jsonb)
      RETURNING id::text AS id`;
    const id = Number(r!.id);
    const result = await repriceUsageSamples(sql, { workspaceId: WS });
    expect(result).toMatchObject({ stamped: 1, newlyUnpriced: 0, complete: true });
    const [after] = await sql<Array<{ cost_usd: number | null; cost_source: string | null; bound: string | null; grain: string | null }>>`
      SELECT cost_usd, cost_source, usage_provenance->>'costBound' AS bound, usage_provenance->>'grain' AS grain
        FROM harness_shared.agent_usage_samples WHERE id = ${id}`;
    expect(after).toEqual({ cost_usd: 0.051, cost_source: 'estimated', bound: 'lower', grain: 'request' });
    // Once the TTL split is known, the bound clears and the exact price replaces the floor.
    await sql`UPDATE harness_shared.agent_usage_samples
                 SET cache_creation_5m_tokens = 1500, cache_creation_1h_tokens = 500, price_table_version = NULL
               WHERE id = ${id}`;
    await repriceUsageSamples(sql, { workspaceId: WS });
    const [exact] = await sql<Array<{ bound: string | null; cost_usd: number }>>`
      SELECT usage_provenance->>'costBound' AS bound, cost_usd FROM harness_shared.agent_usage_samples WHERE id = ${id}`;
    expect(exact!.bound).toBeNull();
    expect(exact!.cost_usd).toBe(0.052875);
  });

  it('stops at the batch budget and resumes on the next call', async () => {
    for (let i = 0; i < 5; i++) await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cost: null, costSource: null, version: null });
    const first = await repriceUsageSamples(sql, { workspaceId: WS, batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ stamped: 2, skippedConcurrent: 0, complete: false });
    const [{ left }] = await sql<Array<{ left: number }>>`
      SELECT count(*)::int AS left FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND price_table_version IS NULL`;
    expect(left).toBe(3);
    const rest = await repriceUsageSamples(sql, { workspaceId: WS, batchSize: 2, maxBatches: 10 });
    expect(rest).toMatchObject({ stamped: 3, skippedConcurrent: 0, complete: true });
  });

  it('walks ids in NUMERIC order across a digit-length boundary', async () => {
    // WI-10004517 live backfill, 2026-10-01: the keyset was ordered by the TEXT output alias
    // (`id::text AS id` ... ORDER BY id) while the cursor compared numerically. Text order puts
    // '1000000001' before '900000001', so the first batch's cursor jumped past 900000001 and the
    // pass reported complete with that row still stale. On the live table it left 934,532 of
    // 1,272,436 rows untouched. Seeded ids elsewhere in this file share one digit length, so text
    // and numeric order agree, which is why nothing else here could see it.
    const ids = [900_000_001, 1_000_000_001, 9_000_000_001];
    for (const id of ids) {
      await sql`
        INSERT INTO harness_shared.agent_usage_samples
          (id, workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens, model)
        OVERRIDING SYSTEM VALUE
        VALUES (${id}, ${WS}, ${Date.now()}, 'openai:x', 'openai', 'x', 'jsonl', 10, 10, 'gpt-5.5')`;
    }
    const result = await repriceUsageSamples(sql, { workspaceId: WS, batchSize: 1, maxBatches: 10 });
    expect(result).toMatchObject({ stamped: 3, complete: true });
    for (const id of ids) expect((await read(id)).price_table_version).toBe(PRICE_TABLE_VERSION);
  });

  it('runs as the FIRST query on a fresh canonical-shaped client', async () => {
    // WI-10004517: every other case here runs on a pool already warmed by seed(), so none of
    // them exercises a cold pool. This builds a client the way buildClient() does (the raw
    // serializer fixes) and makes the repricer its first statement — the shape of a one-off
    // backfill script and of the first ingest tick after an operator restart.
    const id = await seed({ source: 'jsonl', provider: 'openai', model: 'gpt-5.5', cost: null, costSource: null, version: null });
    const fresh = postgres(org.adminDsn, {
      max: 1, idle_timeout: 1, prepare: false, onnotice: () => {},
      types: { ...PG_BIGINT_AS_NUMBER_TYPES, ...PG_TIMESTAMP_NO_TZ_AS_UTC_TYPES },
    });
    restoreRawDateSerializers(fresh);
    restoreRawJsonbSerializer(fresh);
    seedBuiltinArrayTypes(fresh);
    installNumericArrayTyping(fresh);
    try {
      const result = await repriceUsageSamples(fresh, { workspaceId: WS });
      expect(result).toMatchObject({ stamped: 1, newlyPriced: 1, complete: true });
    } finally {
      await fresh.end();
    }
    expect((await read(id)).price_table_version).toBe(PRICE_TABLE_VERSION);
  });

  it('only touches the requested workspace', async () => {
    const other = 'ws-reprice-other';
    await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${other}`;
    const [r] = await sql<Array<{ id: string }>>`
      INSERT INTO harness_shared.agent_usage_samples (workspace_id, ts, bucket_key, provider, model_class, source, input_tokens, output_tokens, model)
      VALUES (${other}, ${Date.now()}, 'openai:x', 'openai', 'x', 'jsonl', 10, 10, 'gpt-5.5') RETURNING id::text AS id`;
    await repriceUsageSamples(sql, { workspaceId: WS });
    expect((await read(Number(r!.id))).price_table_version).toBeNull();
    await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${other}`;
  });
});
