import { describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  ADMISSION_CENSUS_LOCK_RETRY_BACKOFFS_MS,
  ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS,
  buildAdmissionShardPlan,
  isLockNotAvailable,
  lexicalHardEdges,
  LEXICAL_PAIR_GROUP_CAP,
  partitionTextContextIds,
  withCensusStatementTimeout,
  TEXT_CONTEXT_BATCH_SIZE,
  type AdmissionCensusEdge,
  type AdmissionCensusItem,
  type AdmissionCensusRunOptions,
} from './work-items-admission-census';

function item(
  id: string,
  tokens: number,
  originClass: AdmissionCensusItem['originClass'] = 'agent-filed',
): AdmissionCensusItem {
  return {
    id,
    title: id,
    summary: '',
    estimatedTokens: tokens,
    originClass,
    hasEmbedding: true,
    embeddingMode: 'gemma',
    embeddingProfile: EMBEDDER_DIM_SPECS.gemma.profileId,
    titleKey: null,
    conditionKey: null,
  };
}

function edge(a: string, b: string, similarity: number): AdmissionCensusEdge {
  return { a, b, similarity, source: 'cosine' };
}

describe('buildAdmissionShardPlan', () => {
  it('is deterministic and covers every corpus item exactly once as a member', () => {
    const items = [item('a', 60), item('b', 50), item('c', 60), item('d', 50), item('e', 20)];
    const edges = [edge('a', 'b', 0.95), edge('c', 'd', 0.94), edge('a', 'c', 0.88)];
    const first = buildAdmissionShardPlan(
      items,
      edges,
      edges.filter((e) => e.similarity >= 0.9),
      {
        targetTokens: 130,
        ghostFraction: 0.5,
      },
    );
    const second = buildAdmissionShardPlan(
      [...items].reverse(),
      [...edges].reverse(),
      edges.filter((e) => e.similarity >= 0.9),
      {
        targetTokens: 130,
        ghostFraction: 0.5,
      },
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.memberRows).toBe(items.length);
    expect(new Set(first.shards.flatMap((shard) => shard.members)).size).toBe(items.length);
    expect(first.shards.every((shard) => shard.memberTokens <= 130)).toBe(true);
  });

  it('allows one item to be ghost context in multiple shards without duplicating its home membership', () => {
    const items = [item('g', 10), item('a', 100), item('b', 100), item('c', 100)];
    const edges = [edge('g', 'a', 0.89), edge('g', 'b', 0.88), edge('g', 'c', 0.87)];
    const plan = buildAdmissionShardPlan(items, edges, [], { targetTokens: 110, ghostFraction: 0.5 });

    expect(plan.shards.filter((shard) => shard.members.includes('g'))).toHaveLength(1);
    expect(plan.shards.filter((shard) => shard.ghosts.includes('g')).length).toBeGreaterThanOrEqual(2);
    expect(plan.memberRows).toBe(4);
  });

  it('splits an oversized hard component by raising its threshold and preserves severed edges as ghost candidates', () => {
    const items = [item('a', 70), item('b', 70), item('c', 70)];
    const edges = [edge('a', 'b', 0.91), edge('b', 'c', 0.95)];
    const plan = buildAdmissionShardPlan(items, edges, edges, { targetTokens: 150, ghostFraction: 0.5 });

    expect(plan.splitOversizedComponents).toBe(1);
    expect(plan.shards.every((shard) => shard.memberTokens <= 150)).toBe(true);
    expect(plan.memberRows).toBe(3);
  });

  it('projects full-corpus bulk work only above the D-002 outside-machine threshold', () => {
    const items = [
      item('m1', 10, 'machine-emitter'),
      item('m2', 10, 'machine-emitter'),
      item('a1', 10, 'agent-filed'),
      item('a2', 10, 'agent-filed'),
    ];
    const pairs = [edge('m1', 'm2', 0.96), edge('a1', 'a2', 0.95)];
    const targeted = buildAdmissionShardPlan(items, pairs, pairs, { fullCorpusPairThreshold: 1 });
    const full = buildAdmissionShardPlan(items, pairs, pairs, { fullCorpusPairThreshold: 0 });

    expect(targeted.projection.recommendedBulkScope).toBe('machine-emitter-targeted');
    expect(full.projection.recommendedBulkScope).toBe('full-corpus');
    expect(full.projection.outsideMachineEmitterPairs).toBe(1);
  });

  it('refuses duplicate ids and items above the evidence-gated shard ceiling', () => {
    expect(() => buildAdmissionShardPlan([item('a', 1), item('a', 1)], [])).toThrow(/duplicate census item/);
    expect(() =>
      buildAdmissionShardPlan([item('huge', 101)], [], [], { targetTokens: 50, ceilingTokens: 100 }),
    ).toThrow(/ceiling/);
  });
});

describe('lexicalHardEdges', () => {
  it('pairs identical normalized titles as hard lexical edges regardless of embedding state', () => {
    const edges = lexicalHardEdges([
      { ...item('e1', 5), title: 'Dup twin' },
      { ...item('e2', 5), title: 'Dup twin', hasEmbedding: false, embeddingMode: null },
      { ...item('other', 5), title: 'Unrelated thing entirely' },
    ]);
    expect(edges).toEqual([{ a: 'e1', b: 'e2', similarity: 1, trgm: null, source: 'lexical', hard: true }]);
  });

  it('pairs persisted titleKeys and shared condition keys across differing display titles', () => {
    const byKey = lexicalHardEdges([
      { ...item('a', 5), title: 'Original phrasing', titleKey: 'title:persisted key' },
      { ...item('b', 5), title: 'Edited later phrasing', titleKey: 'title:persisted key' },
    ]);
    expect(byKey.map((edge) => [edge.a, edge.b])).toEqual([['a', 'b']]);

    const byCondition = lexicalHardEdges([
      { ...item('m1', 5, 'machine-emitter'), title: 'Watcher saw red', conditionKey: 'watch:same' },
      { ...item('m2', 5, 'machine-emitter'), title: 'Watcher saw blue', conditionKey: 'watch:same' },
    ]);
    expect(byCondition.map((edge) => [edge.a, edge.b])).toEqual([['m1', 'm2']]);
  });

  it('emits nothing for singletons or blank identities and dedupes overlapping buckets to one pair', () => {
    expect(
      lexicalHardEdges([
        { ...item('solo', 5), title: 'Only one of these' },
        { ...item('blank1', 5), title: '   ' },
        { ...item('blank2', 5), title: '' },
      ]),
    ).toEqual([]);

    // Same title AND same titleKey AND same conditionKey => still exactly one edge.
    const overlapping = lexicalHardEdges([
      { ...item('x', 5), title: 'Twin pair', titleKey: 'title:twin pair', conditionKey: 'watch:t' },
      { ...item('y', 5), title: 'Twin pair', titleKey: 'title:twin pair', conditionKey: 'watch:t' },
    ]);
    expect(overlapping).toHaveLength(1);
  });

  it('caps an oversized identity group to a connectivity star instead of a quadratic clique', () => {
    const big = Array.from({ length: LEXICAL_PAIR_GROUP_CAP + 2 }, (_, i) => ({
      ...item(`g${String(i).padStart(3, '0')}`, 5),
      title: 'Recurring detector condition title',
    }));
    const edges = lexicalHardEdges(big);
    expect(edges).toHaveLength(big.length - 1); // star, not n*(n-1)/2
    expect(new Set(edges.flatMap((edge) => [edge.a, edge.b])).size).toBe(big.length); // connectivity kept
  });

  it('glues lexical twins into one hard component and surfaces them in the merge projection', () => {
    const items = [
      { ...item('e1', 5), title: 'Dup twin' },
      { ...item('e2', 5), title: 'Dup twin' },
      { ...item('lone', 5), title: 'Unrelated item' },
    ];
    const lexical = lexicalHardEdges(items);
    const plan = buildAdmissionShardPlan(items, lexical, lexical, { targetTokens: 10 });
    const shardOf = (id: string) => plan.shards.find((shard) => shard.members.includes(id))?.shardId;
    expect(shardOf('e1')).toBe(shardOf('e2'));
    expect(plan.projection.byPairClass).toEqual({ 'agent-filed × agent-filed': 1 });
    expect(plan.projection.outsideMachineEmitterPairs).toBe(1);
    expect(plan.projection.componentCollapseUpperBound).toEqual({ 'agent-filed': 1 });
  });
});

describe('text-context scan bounds', () => {
  it('partitions missing-embedding anchors into deterministic bounded batches', () => {
    const ids = Array.from({ length: TEXT_CONTEXT_BATCH_SIZE * 2 + 1 }, (_, i) => `missing-${i}`);
    const batches = partitionTextContextIds(ids);

    expect(batches).toHaveLength(3);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(TEXT_CONTEXT_BATCH_SIZE);
    expect(batches.flat()).toEqual(ids);
    expect(partitionTextContextIds([...ids].reverse()).flat()).toEqual([...ids].reverse());
  });
});

/**
 * REGRESSION GUARD — the census's declared statement_timeout must not open a
 * NESTED transaction on a handle the caller already has in one.
 *
 * WI-1194246 correctly wrapped the two long scans in `sql.begin` to carry
 * `SET LOCAL statement_timeout`. A postgres.js TRANSACTION handle has no
 * `.begin` (it exposes `savepoint`), so on the `withinTransaction: true` path
 * that wrapper threw `TypeError: sql.begin is not a function` and took the
 * whole scheduled bulk-dedup stage down with it — the census runs on the
 * stage's own `tx`.
 *
 * The escape was that NOTHING CHEAP looked: typecheck passed, and the census's
 * own integration test passed because it only exercises the bare-pool path.
 * The test that did catch it lives in a sibling *.integration.test.ts that a
 * plain `test:affected` on this file never selects. So the guard belongs HERE,
 * in the unit suite, where editing this file actually runs it.
 */
describe('withCensusStatementTimeout', () => {
  const opts = (withinTransaction: boolean): AdmissionCensusRunOptions =>
    ({ workspaceId: 'ws', harnessSlug: 'h', withinTransaction }) as AdmissionCensusRunOptions;

  it('declares the bound on the CALLER handle when already inside a transaction', async () => {
    const statements: string[] = [];
    // Shaped like a real postgres.js transaction handle: `unsafe` but NO
    // `begin`. Reaching for `.begin` here is the exact production crash.
    const tx = {
      unsafe: async (sql: string) => {
        statements.push(sql);
      },
    } as never;

    const result = await withCensusStatementTimeout(tx, opts(true), async (handle) => {
      expect(handle).toBe(tx);
      return 'ran-on-caller-handle';
    });

    expect(result).toBe('ran-on-caller-handle');
    expect(statements).toEqual([`SET LOCAL statement_timeout = ${ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}`]);
  });

  it('still opens its own transaction on a bare pool checkout', async () => {
    const statements: string[] = [];
    let begins = 0;
    const inner = {
      unsafe: async (sql: string) => {
        statements.push(sql);
      },
    };
    const pool = {
      begin: async (body: (tx: unknown) => Promise<unknown>) => {
        begins += 1;
        return body(inner);
      },
    } as never;

    const result = await withCensusStatementTimeout(pool, opts(false), async (handle) => {
      expect(handle).toBe(inner as never);
      return 'ran-in-own-tx';
    });

    expect(begins).toBe(1);
    expect(result).toBe('ran-in-own-tx');
    expect(statements).toEqual([`SET LOCAL statement_timeout = ${ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}`]);
  });

  it('control: an unconditional-begin implementation FAILS on the transaction handle', async () => {
    // Non-vacuity. The pre-fix shape, which always reached for `sql.begin` and
    // never consulted withinTransaction. Against the same no-begin handle the
    // transaction case supplies, it reproduces the production TypeError.
    const nestedBegin = async (sql: Record<string, unknown>): Promise<void> => {
      await (sql.begin as (body: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(async () => undefined);
    };
    const transactionHandle: Record<string, unknown> = { unsafe: async () => undefined };
    await expect(nestedBegin(transactionHandle)).rejects.toThrow(/is not a function/);
  });
});

describe('census lock_not_available retry policy (WI-10004951)', () => {
  it('retries only 55P03, never the statement_timeout the census sets on purpose', () => {
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
    expect(isLockNotAvailable({ pgCode: '55P03' })).toBe(true);
    expect(isLockNotAvailable({ code: '57014' })).toBe(false);
    expect(isLockNotAvailable({ name: 'WorkspaceContendedError' })).toBe(false);
    expect(isLockNotAvailable(new Error('canceling statement due to lock timeout'))).toBe(false);
    expect(isLockNotAvailable(null)).toBe(false);
  });

  it('waits long enough to outlast a table-rewrite lock but stays bounded', () => {
    const total = ADMISSION_CENSUS_LOCK_RETRY_BACKOFFS_MS.reduce((a, b) => a + b, 0);
    // The 16:59Z refusal window was ~30s; the role lock_timeout is 15s per attempt.
    expect(total).toBeGreaterThanOrEqual(60_000);
    expect(total).toBeLessThan(ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS);
  });
});
