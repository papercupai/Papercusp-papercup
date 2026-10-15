/**
 * recall-stats — recall-quality telemetry (EI-366 / consume-edges P-031,
 * migration 240). Pins: the fire-and-forget writer's row shape + its
 * never-throws contract, the fragment regression-canary counter, and the
 * health aggregate's mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';
import { countFragmentHits, describeRecallQuery, readRecallHealth, recordRecallStats } from './recall-stats';

const entry = (id: string, score?: number, metadata?: Record<string, unknown>): MemoryEntry => ({
  id,
  text: id,
  scope: 's',
  ...(score !== undefined ? { score } : {}),
  ...(metadata !== undefined ? { metadata } : {}),
});

describe('countFragmentHits', () => {
  it('counts entries whose metadata carries entityType', () => {
    expect(countFragmentHits([
      entry('a', 0.5),
      entry('b', 0.4, { entityType: 'COMPOUND', linkedMemoryIds: ['x'] }),
      entry('c', 0.3, { kind: 'reference' }),
    ])).toBe(1);
  });
});

/**
 * P-041 / migration 706 — the QUERY side. Everything else in this suite pins
 * what a recall returned; these pin what it was asked.
 */
describe('describeRecallQuery', () => {
  const envelope = (nonce: string) => `⟦turn-origin:loop-fire nonce:${nonce}⟧`;

  // THE test for this migration. The nonce is freshly minted per turn, so
  // hashing the raw prompt would make every machine-injected query unique BY
  // CONSTRUCTION — the duplicate rate would read a permanent 0.0%, which reads
  // as healthy. If this ever regresses, the instrument silently stops being
  // able to detect the exact condition it exists to detect.
  it('hashes the ENVELOPE-STRIPPED body, so a per-turn nonce cannot manufacture uniqueness', () => {
    const body = '\n🔁 Loop wake. Continue toward: implement the plan.';
    const a = describeRecallQuery(`${envelope('a1b2c3d4e5f60718')}${body}`);
    const b = describeRecallQuery(`${envelope('99887766554433ff')}${body}`);
    expect(a.sha256).toBe(b.sha256);
    // ...and the stripped hash is the hash of the body alone, not of the whole.
    expect(a.sha256).toBe(describeRecallQuery(body).sha256);
  });

  it('still separates genuinely different bodies under the same origin', () => {
    const a = describeRecallQuery(`${envelope('a1b2c3d4e5f60718')}\nfix the parser`);
    const b = describeRecallQuery(`${envelope('a1b2c3d4e5f60718')}\nship the release`);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('records the CLAIMED origin, and null when there is no envelope', () => {
    expect(describeRecallQuery(`${envelope('a1b2c3d4e5f60718')}\nhi`).origin).toBe('loop-fire');
    expect(
      describeRecallQuery('⟦turn-origin:self-compaction nonce:0011223344556677⟧\nhi').origin,
    ).toBe('self-compaction');
    expect(describeRecallQuery('what did we decide about the migration?').origin).toBeNull();
  });

  // chars is what the EMBEDDER saw, so the envelope counts toward it — an
  // agent turn really is carrying ~50 chars of machine preamble into the query.
  it('counts the RAW length, envelope included (it was embedded)', () => {
    const raw = `${envelope('a1b2c3d4e5f60718')}\nhi`;
    expect(describeRecallQuery(raw).chars).toBe(raw.length);
    expect(describeRecallQuery(raw).chars).toBeGreaterThan('\nhi'.length);
  });

  it('is stable across CRLF transit mangling (PTY line endings)', () => {
    expect(describeRecallQuery('a\r\nb').sha256).toBe(describeRecallQuery('a\nb').sha256);
  });
});

describe('recordRecallStats', () => {
  // Column order: surface, hit_count, top_score, scores, fragment_count, pools,
  // workspace_id, pot_slug, score_scale, query_chars, query_sha256,
  // query_origin, session_id.
  const QUERY_CHARS = 9;
  const QUERY_SHA = 10;
  const QUERY_ORIGIN = 11;
  const SESSION_ID = 12;
  const ADMISSION = 14;

  it('records the query SHAPE and the session (P-041)', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    const query = '⟦turn-origin:wake-pump nonce:00112233aabbccdd⟧\ncheck the deploy';
    await recordRecallStats(sql, {
      surface: 'turn-start',
      entries: [entry('a', 0.5)],
      query,
      sessionId: 'su-abc',
    });
    expect(calls[0][QUERY_CHARS]).toBe(query.length);
    expect(calls[0][QUERY_SHA]).toBe(describeRecallQuery(query).sha256);
    expect(calls[0][QUERY_ORIGIN]).toBe('wake-pump');
    expect(calls[0][SESSION_ID]).toBe('su-abc');
  });

  // A caller that records no query must contribute NULLs, not a zero-length
  // row: a 0-char query is a real and meaningful observation, and conflating
  // "not instrumented" with "asked nothing" would corrupt the short-query rate.
  it('records NULLs — not zeros — when no query is supplied', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, { surface: 'search', entries: [] });
    expect(calls[0][QUERY_CHARS]).toBeNull();
    expect(calls[0][QUERY_SHA]).toBeNull();
    expect(calls[0][QUERY_ORIGIN]).toBeNull();
    expect(calls[0][SESSION_ID]).toBeNull();
  });

  it('records an EMPTY query as 0 chars, distinctly from not-instrumented', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, { surface: 'search', entries: [], query: '' });
    expect(calls[0][QUERY_CHARS]).toBe(0);
    expect(calls[0][QUERY_SHA]).toEqual(expect.any(String));
  });

  it('writes surface, counts, top score and the score list', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, {
      surface: 'search',
      entries: [entry('a', 0.8), entry('b', 0.5), entry('c')],
    });
    expect(calls).toHaveLength(1);
    const [surface, hitCount, topScore, scoresJson, fragmentCount] = calls[0];
    expect(surface).toBe('search');
    expect(hitCount).toBe(3);
    expect(topScore).toBe(0.8);
    expect(JSON.parse(scoresJson as string)).toEqual([0.8, 0.5]);
    expect(fragmentCount).toBe(0);
  });

  it('records a zero-hit recall with a NULL top score', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await recordRecallStats(sql, { surface: 'injection', entries: [] });
    const [surface, hitCount, topScore] = calls[0];
    expect(surface).toBe('injection');
    expect(hitCount).toBe(0);
    expect(topScore).toBeNull();
  });

  it('persists only safe timeout facts in the existing admission JSON', async () => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    const timeout = { scope: 'request-budget' as const, phase: 'shared-budget' as const, elapsedMs: 5000 };
    await recordRecallStats(sql, {
      surface: 'injection',
      entries: [],
      query: 'raw private query',
      sessionId: 'private-session-id',
      admission: {
        returned: 0,
        admitted: 0,
        truncated: false,
        dropped: { pack: 0, feedback: 0, workspace: 0, dedup: 0, jev: 0, nearDuplicate: 0, budget: 0 },
        byLeg: { cosineOnly: 0, lexicalOnly: 0, both: 0 },
        timeout,
      },
    });

    const admissionJson = calls[0]![ADMISSION] as string;
    const persisted = JSON.parse(admissionJson) as { timeout: Record<string, unknown> };
    expect(persisted.timeout).toEqual(timeout);
    expect(Object.keys(persisted.timeout).sort()).toEqual(['elapsedMs', 'phase', 'scope']);
    expect(admissionJson).not.toContain('raw private query');
    expect(admissionJson).not.toContain('private-session-id');
  });

  it('NEVER throws — a failed insert is swallowed (telemetry is not load-bearing)', async () => {
    const sql = (() => Promise.reject(new Error('pg down'))) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordRecallStats(sql, { surface: 'search', entries: [entry('a', 0.5)] }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('serializes concurrent writes per SQL handle without dropping a recall', async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      started.push(values[0] as string);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<unknown[]>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve([]);
        });
      });
    }) as unknown as Sql;

    const writes = ['turn-start', 'compact', 'brief'].map((surface) =>
      recordRecallStats(sql, { surface, entries: [] }),
    );
    // A resolved predecessor must not start telemetry in the same microtask
    // drain; foreground recall work gets an event-loop turn to acquire the
    // shared org pool first.
    await Promise.resolve();
    expect(started).toEqual([]);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(started).toEqual(['turn-start']);

    for (let index = 0; index < writes.length; index += 1) {
      expect(releases).toHaveLength(1);
      releases.shift()!();
      await writes[index];
      if (index + 1 < writes.length) {
        await vi.waitFor(() => expect(started).toHaveLength(index + 2));
      }
    }

    expect(started).toEqual(['turn-start', 'compact', 'brief']);
    expect(maxActive).toBe(1);
  });

  // memory-delivery-unification-2026-07-12 P-005 (D-006): the surface column is
  // free-text, so each per-entry-point PORT records under its own label — the
  // union is documentation, not a DB constraint. Pins that a port label writes
  // through verbatim so per-port recall quality is measurable separately.
  it('records each injection PORT under its own surface label (P-005)', async () => {
    for (const port of ['initialize', 'compact', 'turn-start', 'brief', 'claim', 'create'] as const) {
      const calls: unknown[][] = [];
      const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(values);
        return Promise.resolve([]);
      }) as unknown as Sql;
      await recordRecallStats(sql, { surface: port, entries: [entry('a', 0.6)] });
      expect(calls[0]?.[0]).toBe(port);
    }
  });
});

/**
 * context-injection-audit-2026-07-28 P-026 (migration 703) — the RECURRENCE
 * GUARD for the defect class "telemetry that collapses distinguishable states
 * into one indistinguishable number".
 *
 * The push path fans out over three independently-budgeted pools and recorded
 * ONE hit_count. That is not a missing nice-to-have; it destroyed the only
 * information that could separate a healthy recall from a pool returning zero
 * on every single call. These tests fail if the collapse comes back.
 */
describe('recordRecallStats per-pool breakdown (P-026)', () => {
  const capture = (): { calls: unknown[][]; sql: Sql } => {
    const calls: unknown[][] = [];
    const sql = ((_s: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve([]);
    }) as unknown as Sql;
    return { calls, sql };
  };
  // Positional, matching the INSERT column order.
  const POOLS = 5, WORKSPACE = 6, POT = 7;
  const poolsOf = (call: unknown[]) => JSON.parse(call[POOLS] as string);

  // THE bug, stated as a test. Both recalls return six memories, so both write
  // hit_count=6 — but one of them has a harness pool that contributed NOTHING.
  // Before P-026 those two rows were byte-identical, which is exactly why an
  // orphaned pool hid behind a surface reporting a 0.0% zero-hit rate.
  it('distinguishes two recalls with the SAME hit_count but different pool shapes', async () => {
    const healthy = capture();
    await recordRecallStats(healthy.sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.9), entry('u2', 0.8), entry('u3', 0.7)], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.6), entry('h2', 0.5), entry('h3', 0.4)], limit: 3, scopes: ['harness:papercusp'] },
        hive: { entries: [], limit: 3, scopes: ['hive:papercusp'] },
      },
    });

    const orphaned = capture();
    await recordRecallStats(orphaned.sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [1, 2, 3, 4, 5, 6].map((n) => entry(`u${n}`, 0.9)), limit: 6, scopes: ['u:1'] },
        // The pool exists, is queried, and returns nothing — every call.
        harness: { entries: [], limit: 3, scopes: ['harness:papercup'] },
        hive: { entries: [], limit: 3, scopes: ['hive:papercusp'] },
      },
    });

    // The flat columns are IDENTICAL — that is the point.
    expect(healthy.calls[0]![1]).toBe(6);
    expect(orphaned.calls[0]![1]).toBe(6);

    // The pool breakdown is not.
    expect(poolsOf(healthy.calls[0]!).harness).toMatchObject({ hits: 3, limit: 3 });
    expect(poolsOf(orphaned.calls[0]!).harness).toMatchObject({ hits: 0, top: null, limit: 3 });
    expect(poolsOf(healthy.calls[0]!)).not.toEqual(poolsOf(orphaned.calls[0]!));
  });

  it('records each pool OWN top score — a strong sibling cannot mask a weak pool', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.95)], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.02)], limit: 3, scopes: ['harness:papercusp'] },
        hive: { entries: [], limit: 3, scopes: [] },
      },
    });
    // Flat top_score is the max across pools and says nothing about the harness pool.
    expect(calls[0]![2]).toBe(0.95);
    const pools = poolsOf(calls[0]!);
    expect(pools.user.top).toBe(0.95);
    expect(pools.harness.top).toBe(0.02);
    expect(pools.hive.top).toBeNull();
  });

  // The budget is recorded, not inferred. P-032/P-033 both retune these
  // constants; a saturation measurement that compares a stored hit count
  // against TODAY's constant silently misreads every older row.
  it('stores the per-pool budget and scopes IN EFFECT for the call', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        harness: { entries: [entry('h1', 0.3)], limit: 9, scopes: ['harness:a', 'harness:b'] },
      },
    });
    expect(poolsOf(calls[0]!).harness).toEqual({
      hits: 1, top: 0.3, limit: 9, scopes: ['harness:a', 'harness:b'],
    });
  });

  it('DERIVES the flat totals from the pools — hit_count can never drift from the breakdown', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      pools: {
        user: { entries: [entry('u1', 0.9), entry('u2')], limit: 6, scopes: ['u:1'] },
        harness: { entries: [entry('h1', 0.4)], limit: 3, scopes: ['harness:x'] },
        hive: { entries: [], limit: 3, scopes: [] },
      },
    });
    const [, hitCount, topScore, scoresJson] = calls[0]!;
    const pools = poolsOf(calls[0]!);
    // `Object.values(pools)` is `unknown[]`, so the untyped overload of reduce
    // infers an `unknown` accumulator (TS18046). Pin it to number — the initial
    // value already is one, so this annotates rather than changes behaviour.
    const summed = Object.values(pools).reduce<number>((n, p) => n + (p as { hits: number }).hits, 0);
    expect(hitCount).toBe(3);
    expect(summed).toBe(hitCount);
    expect(topScore).toBe(0.9);
    // An entry with no score contributes to hits but not to the score list.
    expect(JSON.parse(scoresJson as string)).toEqual([0.9, 0.4]);
  });

  it('leaves pools NULL on a flat (pull-path) recall — single-pool stays distinguishable', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, { surface: 'search', entries: [entry('a', 0.5)] });
    expect(calls[0]![POOLS]).toBeNull();
  });

  // Migration 290 added these columns; nothing wrote them for 56,841 rows.
  it('writes workspace_id and pot_slug (dead since migration 290 until P-026)', async () => {
    const { calls, sql } = capture();
    await recordRecallStats(sql, {
      surface: 'turn-start',
      workspaceId: 'ws-1',
      potSlug: 'papercusp',
      pools: { user: { entries: [], limit: 6, scopes: ['u:1'] } },
    });
    expect(calls[0]![WORKSPACE]).toBe('ws-1');
    expect(calls[0]![POT]).toBe('papercusp');
  });

  it('still NEVER throws when a per-pool write fails', async () => {
    const sql = (() => Promise.reject(new Error('pg down'))) as unknown as Sql;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordRecallStats(sql, {
        surface: 'turn-start',
        pools: { user: { entries: [entry('a', 0.5)], limit: 6, scopes: ['u:1'] } },
      }),
    ).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('readRecallHealthByPool (P-026)', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('surfaces a pool at a 100% zero-hit rate beside a healthy sibling', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    const rows = await readRecallHealthByPool(sqlReturning([
      { surface: 'turn-start', pool: 'user', recalls: 100, zero_hits: 0, saturated: 97,
        hits_p50: '6', top_p50: '0.03', scope_keys: ['u:1'] },
      // The gate-2 signature: never returns anything, and the scope set moved.
      { surface: 'turn-start', pool: 'harness', recalls: 100, zero_hits: 100, saturated: 0,
        hits_p50: '0', top_p50: null, scope_keys: ['harness:papercup', 'harness:papercusp'] },
    ]));
    expect(rows[0]).toMatchObject({ pool: 'user', zeroHitRate: 0, saturationRate: 0.97, topScoreP50: 0.03 });
    expect(rows[1]).toMatchObject({ pool: 'harness', zeroHitRate: 1, saturationRate: 0, topScoreP50: null });
    expect(rows[1]!.scopes).toEqual(['harness:papercup', 'harness:papercusp']);
  });

  it('an empty window yields an empty list (degrade-to-empty, never a throw)', async () => {
    const { readRecallHealthByPool } = await import('./recall-stats');
    expect(await readRecallHealthByPool(sqlReturning([]))).toEqual([]);
  });
});

describe('readRecallHealthBySurface (orient-recall-quality P-006)', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('maps each surface row independently (a single-surface regression stays visible)', async () => {
    const { readRecallHealthBySurface } = await import('./recall-stats');
    const rows = await readRecallHealthBySurface(sqlReturning([
      {
        surface: 'search', recalls: 100, zero_hits: 10, fragment_hits: 0,
        per_scale: [{ scale: 'cosine', scored: 100, p50: '0.6', p90: '0.8' }],
      },
      // orient regressing alone: zero-hit rate 0.9 while search sits at 0.1.
      { surface: 'orient', recalls: 20, zero_hits: 18, fragment_hits: 0, per_scale: [] },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ surface: 'search', recalls7d: 100, zeroHitRate7d: 0.1, topScoreP50: 0.6 });
    expect(rows[1]).toMatchObject({ surface: 'orient', recalls7d: 20, zeroHit7d: 18, zeroHitRate7d: 0.9, topScoreP50: null });
  });

  // P-036. Measured on the live table: a SINGLE surface carries both scales on
  // the same day (2026-07-28 `search`: 17 rrf-scale rows alongside 94 cosine).
  // So grouping by surface does NOT segment by scale, and this reader has to.
  it('never medians a surface across MIXED scales — it reports the dominant one', async () => {
    const { readRecallHealthBySurface } = await import('./recall-stats');
    const rows = await readRecallHealthBySurface(sqlReturning([
      {
        surface: 'search', recalls: 111, zero_hits: 0, fragment_hits: 0,
        per_scale: [
          { scale: 'cosine', scored: 94, p50: '0.83', p90: '0.9' },
          { scale: 'rrf', scored: 17, p50: '0.032', p90: '0.0328' },
        ],
      },
    ]));
    // The blended median of these two populations would be a number that
    // describes the workload mix, not retrieval quality.
    expect(rows[0]).toMatchObject({ topScoreScale: 'cosine', topScoreP50: 0.83, topScoreSamples: 94 });
    expect(rows[0]!.scaleMix).toEqual({ cosine: 94, rrf: 17 });
  });

  it('an empty window yields an empty list (degrade-to-empty, never a throw)', async () => {
    const { readRecallHealthBySurface } = await import('./recall-stats');
    expect(await readRecallHealthBySurface(sqlReturning([]))).toEqual([]);
  });
});

describe('readRecallHealth', () => {
  const sqlReturning = (rows: Array<Record<string, unknown>>): Sql =>
    ((_s: TemplateStringsArray, ..._v: unknown[]) => Promise.resolve(rows)) as unknown as Sql;

  it('maps the trailing-window aggregate', async () => {
    const health = await readRecallHealth(sqlReturning([
      {
        recalls: 20, zero_hits: 5, fragment_hits: 2,
        per_scale: [{ scale: 'cosine', scored: 20, p50: '0.51', p90: '0.7' }],
      },
    ]));
    expect(health).toEqual({
      recalls7d: 20,
      zeroHit7d: 5,
      zeroHitRate7d: 0.25,
      topScoreP50: 0.51,
      topScoreP90: 0.7,
      topScoreScale: 'cosine',
      topScoreSamples: 20,
      scaleMix: { cosine: 20 },
      fragmentHits7d: 2,
    });
  });

  it('an empty window yields zero rate and null percentiles', async () => {
    const health = await readRecallHealth(sqlReturning([
      { recalls: 0, zero_hits: 0, fragment_hits: 0, per_scale: [] },
    ]));
    expect(health).toEqual({
      recalls7d: 0,
      zeroHit7d: 0,
      zeroHitRate7d: 0,
      topScoreP50: null,
      topScoreP90: null,
      topScoreScale: null,
      topScoreSamples: 0,
      scaleMix: {},
      fragmentHits7d: 0,
    });
  });

  // P-036: 'unknown' rows are of INDETERMINATE scale, so a percentile over them
  // is the same mixing bug wearing a label. They count in the mix and can never
  // be chosen as the reported scale — even when they are the largest bucket.
  it('never reports percentiles from the unknown-scale bucket, even when it dominates', async () => {
    const health = await readRecallHealth(sqlReturning([
      {
        recalls: 500, zero_hits: 0, fragment_hits: 0,
        per_scale: [
          { scale: 'unknown', scored: 400, p50: '0.44', p90: '0.9' },
          { scale: 'rrf', scored: 60, p50: '0.031', p90: '0.0328' },
        ],
      },
    ]));
    expect(health.topScoreScale).toBe('rrf');
    expect(health.topScoreP50).toBe(0.031);
    expect(health.scaleMix).toEqual({ unknown: 400, rrf: 60 });
  });
});

describe('classifyLegacyScoreScale (P-036 — pre-migration-705 rows only)', () => {
  it('separates the two live populations at their structural bounds', async () => {
    const { classifyLegacyScoreScale, RRF_SCORE_CEILING } = await import('./recall-stats');
    // 1/61 — an entry ranked 1st in ONE leg; the observed live minimum.
    expect(classifyLegacyScoreScale(1 / 61)).toBe('rrf');
    // 2/61 — rank 1 in BOTH legs; the exact RRF ceiling at k=60/lexWeight=1.
    expect(classifyLegacyScoreScale(RRF_SCORE_CEILING)).toBe('rrf');
    // 0.50 is the observed live minimum for an admitted cosine hit.
    expect(classifyLegacyScoreScale(0.5)).toBe('cosine');
    expect(classifyLegacyScoreScale(0.9)).toBe('cosine');
  });

  it('returns unknown inside the gap rather than guessing', async () => {
    const { classifyLegacyScoreScale } = await import('./recall-stats');
    // The 5 rows (0.011% of 45,069 over 30d) that live in the dead zone are
    // lexical-fallback fractions — 5/32, 2/9, 3/8. Guessing a scale for these
    // is what would put a wrong number in a comparison; 'unknown' excludes them.
    expect(classifyLegacyScoreScale(0.15625)).toBe('unknown');
    expect(classifyLegacyScoreScale(0.375)).toBe('unknown');
  });

  it('treats an absent or non-finite score as unknown, never as zero', async () => {
    const { classifyLegacyScoreScale } = await import('./recall-stats');
    expect(classifyLegacyScoreScale(null)).toBe('unknown');
    expect(classifyLegacyScoreScale(undefined)).toBe('unknown');
    expect(classifyLegacyScoreScale(Number.NaN)).toBe('unknown');
  });
});

describe('ADMISSION_STAGE_DESIGN_INTENT — every drop stage declares WHY it drops (D-076)', () => {
  // This guard exists because three work-items in the context-injection lane filed a
  // DELIBERATE design behaviour as a defect off a bare `dropped` counter (D-063,
  // D-073, D-074). `Record<AdmissionStage, string>` already makes a MISSING stage a
  // compile error; these assertions cover what the type cannot — an entry added as an
  // empty/placeholder string, or the two lists silently drifting apart.
  it('covers exactly ADMISSION_STAGES — no missing stage, no orphan key', async () => {
    const { ADMISSION_STAGES, ADMISSION_STAGE_DESIGN_INTENT } = await import('./recall-stats');
    expect(Object.keys(ADMISSION_STAGE_DESIGN_INTENT).sort()).toEqual([...ADMISSION_STAGES].sort());
  });

  it('states a real intent for every stage, not a placeholder', async () => {
    const { ADMISSION_STAGES, ADMISSION_STAGE_DESIGN_INTENT } = await import('./recall-stats');
    for (const stage of ADMISSION_STAGES) {
      const intent = ADMISSION_STAGE_DESIGN_INTENT[stage];
      // A one-word "expected" would satisfy a non-empty check while teaching nothing;
      // the point is that a reader can decide defect-vs-design from this string alone.
      expect(intent.length, `${stage} intent is too short to be useful`).toBeGreaterThan(40);
      expect(intent, `${stage} intent looks like a placeholder`).not.toMatch(/^(TODO|TBD|n\/a)/i);
    }
  });

  it('keeps the two warnings that cost the most to rediscover', async () => {
    const { ADMISSION_STAGE_DESIGN_INTENT } = await import('./recall-stats');
    // budget: the port-mix artifact (D-073) — the single most-misread counter here.
    expect(ADMISSION_STAGE_DESIGN_INTENT.budget).toMatch(/mid-turn/i);
    // dedup: a high value indicts the EPOCH, not the filter (D-072).
    expect(ADMISSION_STAGE_DESIGN_INTENT.dedup).toMatch(/epoch/i);
  });
});

describe('ADMISSION_STAGE_SHORT_WHY — the one-clause gloss the dossier renders (WI-37549)', () => {
  // Same drift guard as its long-form sibling above, for the same reason: this
  // one is SHIPPED TO A HUMAN on every injection row, so a stage that gains a
  // key here without a gloss would render a bare count — the exact "8" with no
  // "why" that the whole panel exists to eliminate.
  it('covers exactly ADMISSION_STAGES — no missing stage, no orphan key', async () => {
    const { ADMISSION_STAGES, ADMISSION_STAGE_SHORT_WHY } = await import('./recall-stats');
    expect(Object.keys(ADMISSION_STAGE_SHORT_WHY).sort()).toEqual([...ADMISSION_STAGES].sort());
  });

  it('reads as a REASON that completes "N dropped because …", not as a label', async () => {
    const { ADMISSION_STAGES, ADMISSION_STAGE_SHORT_WHY } = await import('./recall-stats');
    for (const stage of ADMISSION_STAGES) {
      const why = ADMISSION_STAGE_SHORT_WHY[stage];
      // Long enough to be a clause rather than a restatement of the key, short
      // enough to sit inline after a count on one row.
      expect(why.length, `${stage} gloss is too short to explain anything`).toBeGreaterThan(20);
      expect(why.length, `${stage} gloss is too long for an inline row`).toBeLessThan(90);
      expect(why, `${stage} gloss should not restate the stage key`).not.toBe(stage);
      // Sentence-cased prose would read wrong after "8 — ".
      expect(why[0], `${stage} gloss should start lowercase`).toBe(why[0].toLowerCase());
    }
  });
});
