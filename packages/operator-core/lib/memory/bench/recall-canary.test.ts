/**
 * recall-canary — the live recall canary (EI-10047, live-store half).
 * Dep-injected so no PG/embedder is needed: the pure query derivation +
 * pair building, the measurement loop, and the orchestration edges (flag
 * gate, seed, decay-reseed, ok/degraded transitions and their alert/resolve
 * wiring, non-fatal failure).
 */
import { describe, it, expect } from 'vitest';
import {
  buildCanaryPairs,
  deriveCanaryQuery,
  measureCanaryPairs,
  runRecallCanary,
  RECALL_CANARY_TARGET_PAIRS,
  type CanaryCandidate,
  type RecallCanaryDeps,
} from './recall-canary';
import type { RecallCanaryPair, RecallCanarySet, RecallCanaryStatus } from './recall-canary-read';
import type { MemoryEntry } from '../backend';

const LONG_TEXT =
  '[self:su-abc 2026-07-01] The embed sidecar exposes a shared harrier endpoint on port 3384 ' +
  'so every operator process reuses one model instance instead of loading duplicate ONNX ' +
  'runtimes; saturation shows up as op-deadline timeouts rather than crashes.';

function candidates(n: number, scope = 'pool-a'): CanaryCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem-${i}`,
    scope,
    text: `${LONG_TEXT} variant ${i} with extra distinguishing trailing words appended here`,
  }));
}

function entry(id: string): MemoryEntry {
  return { id, text: 'x', scope: 'pool-a' };
}

function frozenSet(pairs: RecallCanaryPair[], baseline: number, backend = 'hybrid'): RecallCanarySet {
  return { id: 1, version: 3, backend, pairs, baselineRAt10: baseline, createdAt: '2026-07-01T00:00:00Z' };
}

function pairsOf(n: number): RecallCanaryPair[] {
  return Array.from({ length: n }, (_, i) => ({
    memoryId: `mem-${i}`,
    scope: 'pool-a',
    query: `query ${i}`,
    style: 'fragment' as const,
  }));
}

/** Deps where every seam is a controllable stub; tests override what they exercise. */
function stubDeps(over: Partial<RecallCanaryDeps> = {}): {
  deps: RecallCanaryDeps;
  recorded: Array<{ status: RecallCanaryStatus }>;
  notified: string[];
  resolved: string[];
} {
  const recorded: Array<{ status: RecallCanaryStatus }> = [];
  const notified: string[] = [];
  const resolved: string[] = [];
  const deps: RecallCanaryDeps = {
    flag: async () => true,
    sql: {} as never,
    backend: { name: 'hybrid', search: async () => [] },
    sample: async () => candidates(30),
    verifyTargets: async (_sql, ids) => new Map(ids.map((id) => [id, 'pool-a'])),
    loadSet: async () => null,
    saveSet: async () => ({ id: 9, version: 4 }),
    record: async (_sql, _ws, m) => {
      recorded.push({ status: m.status });
      return recorded.length;
    },
    prevStatus: async () => 'ok',
    // Hermetic: never reach for the live embedder-cooldown probe. Healthy regime by default,
    // which is also the fail-soft default in the run path.
    degradedRegime: () => false,
    notify: async (n) => {
      notified.push(n.conditionKey);
    },
    resolve: async (n) => {
      resolved.push(n.conditionKey);
    },
    log: () => {},
    ...over,
  };
  return { deps, recorded, notified, resolved };
}

const INPUT = { workspaceId: 'ws-1', installSlug: 'op' };

describe('deriveCanaryQuery', () => {
  it('fragment: ~10 mid-body words, provenance brackets stripped', () => {
    const q = deriveCanaryQuery(LONG_TEXT, 'fragment');
    expect(q).toBeTruthy();
    expect(q!.split(' ').length).toBe(10);
    expect(q).not.toContain('[self:');
    expect(LONG_TEXT).toContain(q!.split(' ')[0]);
  });

  it('keyword: distinct long words in original order, no exact phrase', () => {
    const q = deriveCanaryQuery(LONG_TEXT, 'keyword');
    expect(q).toBeTruthy();
    const words = q!.split(' ');
    expect(words.length).toBeLessThanOrEqual(6);
    expect(words.every((w) => w.length >= 5)).toBe(true);
    expect(LONG_TEXT).not.toContain(q!); // not a verbatim substring
  });

  it('returns null for bodies too thin to probe', () => {
    expect(deriveCanaryQuery('too short to derive anything from', 'fragment')).toBeNull();
  });

  it('is deterministic', () => {
    expect(deriveCanaryQuery(LONG_TEXT, 'fragment')).toBe(deriveCanaryQuery(LONG_TEXT, 'fragment'));
  });
});

describe('buildCanaryPairs', () => {
  it('caps at the target and mixes styles', () => {
    const pairs = buildCanaryPairs(
      candidates(60, 'a').concat(candidates(60, 'b'), candidates(60, 'c')),
    );
    expect(pairs.length).toBe(RECALL_CANARY_TARGET_PAIRS);
    expect(new Set(pairs.map((p) => p.style)).size).toBe(2);
  });

  it('spreads across scopes (per-scope cap)', () => {
    const pairs = buildCanaryPairs(candidates(60, 'only-scope'));
    expect(pairs.length).toBe(10); // MAX_PAIRS_PER_SCOPE
  });

  it('skips candidates whose body cannot yield a query', () => {
    const thin: CanaryCandidate[] = [{ id: 'm', scope: 's', text: 'tiny' }];
    expect(buildCanaryPairs(thin)).toEqual([]);
  });
});

describe('measureCanaryPairs', () => {
  it('counts hits within top-10 and zero-hit queries', async () => {
    const pairs = pairsOf(4);
    const m = await measureCanaryPairs(async (q) => {
      if (q === 'query 0') return [entry('mem-0')]; // hit
      if (q === 'query 1') return [entry('other')]; // miss, non-empty
      return []; // queries 2,3: zero-hit
    }, pairs);
    expect(m.scored).toBe(4);
    expect(m.hits).toBe(1);
    expect(m.zeroHits).toBe(2);
    expect(m.latencyP50Ms).not.toBeNull();
  });

  /**
   * EI-10666 — THE BUG THIS CANARY USED TO HAVE.
   *
   * `zeroHits` meant "the backend returned nothing". But an agent receives what survives the
   * consumer-admission gates, and in the degraded regime the relevance floor can discard a
   * complete, healthy-looking retrieval. That is EI-10372 exactly: the backend returned 5 rows,
   * orient's floor dropped all 5, every agent's fold was EMPTY — and the old canary, reading
   * only `top.length`, would have scored 5 HITS and reported GREEN through the blackout.
   */
  describe('measures what a CONSUMER receives, not what the backend returned (EI-10666)', () => {
    /** A full retrieval of low-band scores — healthy RRF values, and also what noise looks like. */
    const lowBand = (id: string): MemoryEntry => ({ id, text: 'x', scope: 'pool-a', score: 0.0164 });
    /** A PERFECT retrieval: every probe gets its own target back, plus filler. The store is fine. */
    const fullRetrieval = async (q: string) => [
      lowBand(`mem-${q.split(' ')[1]}`),
      lowBand('o1'),
      lowBand('o2'),
    ];

    it('DEGRADED regime: the floor eats a full retrieval ⇒ CONSUMER zero-hit, though retrieval was not empty', async () => {
      const m = await measureCanaryPairs(fullRetrieval, pairsOf(4), {
        degraded: true,
        scoreScale: 'cosine',
      });
      // What an agent actually got: nothing, on every probe.
      expect(m.zeroHits).toBe(4);
      expect(m.hits).toBe(0);
      // ...while the store was answering fine the whole time. This is the pair of numbers that
      // says WHICH layer went dark — and the old canary only had the second one.
      expect(m.retrievalZeroHits).toBe(0);
      expect(m.retrievalHits).toBe(4);
    });

    it('the OLD definition would have called that exact run PERFECTLY HEALTHY', async () => {
      const m = await measureCanaryPairs(fullRetrieval, pairsOf(4), {
        degraded: true,
        scoreScale: 'cosine',
      });
      // The old code was `if (top.length === 0) zeroHits += 1` and `top.some(...)` for hits —
      // i.e. today's retrieval-level counters. Pin the discrimination: on this run the old
      // numbers are a flawless 0% zero-hit / 100% recall, and the new ones are a total blackout.
      expect(m.retrievalZeroHits / m.scored).toBe(0); // old zeroHitRate → "perfect"
      expect(m.retrievalHits / m.scored).toBe(1); // old r@10 → "perfect"
      expect(m.zeroHits / m.scored).toBe(1); // new zeroHitRate → total blackout
      expect(m.hits / m.scored).toBe(0);
    });

    it('HEALTHY regime: the same low-band RRF scores are NOT floored (no cry-wolf)', async () => {
      // The floor must stay regime-scoped. Applying it unconditionally — the tempting way to
      // "model the consumer" — re-creates EI-10372 inside the canary and alarms forever.
      const m = await measureCanaryPairs(fullRetrieval, pairsOf(4), { degraded: false });
      expect(m.zeroHits).toBe(0);
      expect(m.hits).toBe(4);
      expect(m.zeroHits).toBe(m.retrievalZeroHits); // consumer == retrieval when nothing gates
    });

    it.each(['rrf', 'lexical', 'unknown', undefined] as const)(
      'DEGRADED %s scores are not compared to the cosine floor',
      async (scoreScale) => {
        const m = await measureCanaryPairs(fullRetrieval, pairsOf(4), {
          degraded: true,
          scoreScale,
        });
        expect(m.zeroHits).toBe(0);
        expect(m.hits).toBe(4);
        expect(m.retrievalHits).toBe(4);
      },
    );

    it('an empty retrieval is still a zero-hit at BOTH layers (the store-dark case)', async () => {
      const m = await measureCanaryPairs(async () => [], pairsOf(3), { degraded: false });
      expect(m.zeroHits).toBe(3);
      expect(m.retrievalZeroHits).toBe(3);
    });
  });
});

describe('runRecallCanary', () => {
  it('skips when the flag is OFF', async () => {
    const { deps, recorded } = stubDeps({ flag: async () => false });
    const out = await runRecallCanary(INPUT, deps);
    expect(out).toEqual({ ran: false, skipReason: 'flag-off' });
    expect(recorded).toEqual([]);
  });

  it('seeds a fresh set when none exists and records status seeded', async () => {
    const { deps, recorded, notified } = stubDeps({
      backend: { name: 'hybrid', search: async (q: string) => [entry('mem-0')] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran).toBe(true);
    if (out.ran) expect(out.status).toBe('seeded');
    expect(recorded).toEqual([{ status: 'seeded' }]);
    expect(notified).toEqual([]); // seeding never alerts
  });

  it('reseeds when the live backend name differs from the frozen set', async () => {
    const { deps } = stubDeps({
      loadSet: async () => frozenSet(pairsOf(10), 0.9, 'claude-file'),
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('seeded');
    if (out.ran) expect(out.metrics.notes).toContain('backend changed');
  });

  it('healthy run: status ok, no alert', async () => {
    const pairs = pairsOf(10);
    const { deps, notified, resolved } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // every probe finds its target → r@10 = 1.0 ≥ baseline
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    expect(notified).toEqual([]);
    expect(resolved).toEqual([]);
  });

  it('alerts on the ok→degraded edge (recall drop > 5pt)', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // half the probes miss (non-empty results, so not a blackout): r@10 = .5 vs .9
      backend: {
        name: 'hybrid',
        search: async (q: string) => {
          const i = Number(q.split(' ')[1]);
          return i < 5 ? [entry(`mem-${i}`)] : [entry('other')];
        },
      },
      prevStatus: async () => 'ok',
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('degraded');
    expect(notified).toEqual(['memory-live-recall-canary:degraded']);
  });

  it('classifies a zero-hit blackout as degraded even with a low baseline', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.04), // baseline so low a drop alone wouldn't trip
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('degraded');
    if (out.ran) expect(out.metrics.notes).toContain('blackout');
    expect(notified.length).toBe(1);
  });

  it('EI-10666: a DECISION-SIDE blackout alerts, and the alert names the layer', async () => {
    // The store is healthy — every probe returns its target — but the consumer is in the
    // degraded regime, so the relevance floor discards the whole (low-band) retrieval and
    // agents receive nothing. Pre-EI-10666 this run recorded a flawless r@10 = 1.0 and status
    // 'ok'. It must now be a LOUD degradation, and the alert must not send anyone to the store.
    const pairs = pairsOf(10);
    const { deps, notified, recorded } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      degradedRegime: () => true,
      backend: {
        name: 'hybrid',
        scoreScale: 'cosine',
        search: async (q: string) => [
          { id: `mem-${q.split(' ')[1]}`, text: 'x', scope: 'pool-a', score: 0.0164 },
        ],
      },
    });
    const out = await runRecallCanary(INPUT, deps);

    expect(out.ran && out.status).toBe('degraded');
    expect(notified).toEqual(['memory-live-recall-canary:degraded']);
    expect(recorded.length).toBe(1);
    if (out.ran) {
      expect(out.metrics.zeroHitRate).toBe(1); // the consumer got NOTHING
      expect(out.metrics.retrievalZeroHitRate).toBe(0); // ...and the store was fine
      expect(out.metrics.retrievalRAt10).toBe(1); // it returned the target every time
      expect(out.metrics.rAt10).toBe(0); // none of which reached an agent
      // The note must point DOWNSTREAM, not at the store — a blackout alert that misdirects
      // the reader to the database costs the same hours the canary was built to save.
      expect(out.metrics.notes).toContain('DOWNSTREAM');
      expect(out.metrics.notes).not.toContain('swallowed-store-error');
    }
  });

  it('does not floor a degraded low-band RRF response in the canary', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      degradedRegime: () => true,
      backend: {
        name: 'hybrid',
        scoreScale: 'rrf',
        search: async (q: string) => [
          { id: `mem-${q.split(' ')[1]}`, text: 'x', scope: 'pool-a', score: 0.0164 },
        ],
      },
    });
    const out = await runRecallCanary(INPUT, deps);

    expect(out.ran && out.status).toBe('ok');
    expect(notified).toEqual([]);
    if (out.ran) {
      expect(out.metrics.zeroHitRate).toBe(0);
      expect(out.metrics.rAt10).toBe(1);
    }
  });

  it('P-010: a BLIND lexical leg alerts even while fused recall is perfect', async () => {
    // The failure the probe exists for: cosine carries the fused product, so
    // recall@10 looks flawless while the exact-identifier column is dark.
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9, 'hybrid-pg'),
      backend: {
        name: 'hybrid-pg',
        search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)],
        searchLexical: async () => [], // the leg is dark
      },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('degraded');
    expect(notified).toEqual(['memory-live-recall-canary:degraded']);
    if (out.ran) expect(out.metrics.notes).toContain('LEXICAL LEG BLIND');
  });

  it('P-010: a live lexical leg stamps its r@10 into notes and stays ok', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      backend: {
        name: 'hybrid',
        search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)],
        searchLexical: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)],
      },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    expect(notified).toEqual([]);
    if (out.ran) expect(out.metrics.notes).toContain('lex r@10 1.000');
  });

  it('does not re-alert while already degraded; resolves on recovery', async () => {
    const pairs = pairsOf(10);
    const still = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      backend: { name: 'hybrid', search: async () => [entry('other')] },
      prevStatus: async () => 'degraded',
    });
    const out1 = await runRecallCanary(INPUT, still.deps);
    expect(out1.ran && out1.status).toBe('degraded');
    expect(still.notified).toEqual([]); // no duplicate alert

    const healed = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
      prevStatus: async () => 'degraded',
    });
    const out2 = await runRecallCanary(INPUT, healed.deps);
    expect(out2.ran && out2.status).toBe('ok');
    expect(healed.resolved).toEqual(['memory-live-recall-canary:degraded']);
  });

  it('resolves the last scored degradation after an intervening decayed run', async () => {
    const pairs = pairsOf(10);
    const queryTexts: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queryTexts.push(query);
      const history = ['decayed', 'degraded'];
      const comparableOnly = query.includes("status IN ('ok', 'degraded')");
      const prior = comparableOnly ? history.filter((status) => status === 'degraded') : history;
      return prior.slice(0, 1).map((status) => ({ status }));
    };
    const { deps, resolved } = stubDeps({
      sql: sql as never,
      loadSet: async () => frozenSet(pairs, 0.9),
      verifyTargets: async (_sql, ids) => new Map(ids.map((id) => [id, 'pool-a'])),
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
      prevStatus: undefined,
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    expect(queryTexts[0]).toContain("status IN ('ok', 'degraded')");
    expect(resolved).toEqual(['memory-live-recall-canary:degraded']);
  });

  it('excludes forgotten targets from scoring (natural churn is not degradation)', async () => {
    const pairs = pairsOf(10);
    const { deps, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // 2 targets gone (under the decay threshold); the other 8 all hit
      verifyTargets: async (_sql, ids) => new Map(ids.slice(2).map((id) => [id, 'pool-a'])),
      backend: { name: 'hybrid', search: async (q: string) => [entry(`mem-${q.split(' ')[1]}`)] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('ok');
    if (out.ran) {
      expect(out.metrics.pairsMissing).toBe(2);
      expect(out.metrics.pairsScored).toBe(8);
      expect(out.metrics.rAt10).toBe(1);
    }
    expect(notified).toEqual([]);
  });

  it('invalidates and reseeds without alert when an active target moves recall scope', async () => {
    const pairs = pairsOf(10);
    const { deps, recorded, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      // One moved target is enough to make the set incomparable to its frozen baseline.
      verifyTargets: async (_sql, ids) =>
        new Map(ids.map((id) => [id, id === 'mem-3' ? 'pool-b' : 'pool-a'])),
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('decayed');
    if (out.ran) {
      expect(out.metrics.pairsScored).toBe(0);
      expect(out.metrics.pairsMissing).toBe(0);
      expect(out.metrics.notes).toContain('1/10 active targets changed scope');
    }
    expect(recorded).toEqual([{ status: 'decayed' }]);
    expect(notified).toEqual([]);
  });

  it('reseeds (status decayed, no alert) when too many targets are gone', async () => {
    const pairs = pairsOf(10);
    const { deps, recorded, notified } = stubDeps({
      loadSet: async () => frozenSet(pairs, 0.9),
      verifyTargets: async () => new Map([['mem-0', 'pool-a'], ['mem-1', 'pool-a']]), // 8/10 gone
      backend: { name: 'hybrid', search: async () => [] },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out.ran && out.status).toBe('decayed');
    expect(recorded).toEqual([{ status: 'decayed' }]);
    expect(notified).toEqual([]);
  });

  it('turns any thrown failure into a non-fatal failed outcome', async () => {
    const { deps } = stubDeps({
      loadSet: async () => {
        throw new Error('pg down');
      },
    });
    const out = await runRecallCanary(INPUT, deps);
    expect(out).toEqual({ ran: false, skipReason: 'failed', error: 'pg down' });
  });
});
