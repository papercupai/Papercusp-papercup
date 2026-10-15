/**
 * l2-tier — the durable L2 read-through/write-through seam (no-http-anywhere P-007 / D-082).
 *
 * Drives the REAL `withL2` against a fake `PgL2Store` (the store itself has its own
 * integration test against Postgres — `libs/papercusp/libs/db/src/cache-l2.integration.test.ts`;
 * what is untested until here is the SEAM). Only the flag backend is stubbed, via the
 * same `setFlagOverridesForTest` path `cached-read.test.ts` uses.
 *
 * The two contracts worth the most here are the ones that encode a DESIGN decision
 * rather than a mechanism, because a future edit can silently undo either:
 *   - L2 rows expire at the SOFT ttl, so L2 can never serve a value that would already
 *     have gone stale in L1 (otherwise an SWR background revalidate reads its own old
 *     value back out of L2 and the soft TTL stops meaning anything);
 *   - CACHE_L2 is SUBORDINATE to CACHE_LAYER, so the panic switch really does mean
 *     "no cache" and not "no L1".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as recorder from '../degradation/fallback-observations';

beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); });
import { setFlagOverridesForTest } from "@papercusp/flags/test";

import { _refreshCacheLayerForTests } from "./instance";
import {
  withL2,
  invalidateL2ByTags,
  invalidateL2ByTagsWithRetry,
  isRetryableL2InvalidationError,
  l2TierEnabled,
  installL2StoreForTests,
  _refreshL2FlagForTests,
  resetL2ErrorLogForTests,
  __resetL2StateForTests,
  l2RowTtlMs,
  type L2Outcome,
} from './l2-tier';
import type { PgL2Store } from "./pg-l2-store";

const CACHE_LAYER = "papercusp-cache-layer";
const CACHE_L2 = "papercusp-cache-l2";

/** A minimal in-memory stand-in for PgL2Store, recording how it was called. */
function fakeStore(seed?: { value: unknown }) {
  const calls = {
    get: 0,
    set: [] as Array<{ key: string; value: unknown; hardTtlMs?: number; tags?: readonly string[] }>,
    invalidated: [] as string[][],
  };
  let stored = seed;
  const store = {
    get: async () => {
      calls.get++;
      return stored ? { value: stored.value, tags: [], generation: 0, expiresAt: null } : undefined;
    },
    set: async (_ws: string, key: string, value: unknown, opts: { tags?: readonly string[]; hardTtlMs?: number } = {}) => {
      calls.set.push({ key, value, ...opts });
      stored = { value };
    },
    invalidateByTags: async (_ws: string, tags: readonly string[]) => {
      calls.invalidated.push([...tags]);
      stored = undefined;
      return 1;
    },
  };
  return { store: store as unknown as PgL2Store, calls };
}

/** Flush the fire-and-forget write-through (`void store.set(...)`). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function enable(l2: boolean, cacheLayer = true): Promise<void> {
  setFlagOverridesForTest({ [CACHE_LAYER]: cacheLayer, [CACHE_L2]: l2 });
  await _refreshCacheLayerForTests();
  await _refreshL2FlagForTests();
}

beforeEach(async () => {
  installL2StoreForTests(null);
  // The error log is rate-limited PER OPERATION with a 60s window, and that window is
  // module state — without this reset one test's logged 'get' error suppresses the
  // next test's, so a rate-limit assertion sees 0 instead of 1.
  resetL2ErrorLogForTests();
  await enable(true);
});

describe("withL2 — the read-through seam", () => {
  it("returns the factory UNCHANGED when the tier is off (byte-identical to L1-only)", async () => {
    await enable(false);
    const factory = async (): Promise<string> => "built";
    // Identity, not just equivalence: a disabled L2 must not even add a wrapper frame.
    expect(withL2("ws", "k", factory, { tags: [], softTtlMs: 1000 })).toBe(factory);
  });

  it("serves an L2 hit WITHOUT running the factory — the cold build this exists to avoid", async () => {
    const { store, calls } = fakeStore({ value: "from-l2" });
    installL2StoreForTests(store);
    const factory = vi.fn(async () => "rebuilt");
    const outcomes: L2Outcome[] = [];

    const wrapped = withL2("ws", "plans:attention|k", factory, {
      tags: ["harness_plans"],
      softTtlMs: 20_000,
      onL2Outcome: (o) => outcomes.push(o),
    });

    await expect(wrapped()).resolves.toBe("from-l2");
    expect(factory).not.toHaveBeenCalled();
    expect(calls.get).toBe(1);
    expect(outcomes).toEqual(["hit"]);
  });

  it("builds and writes through on an L2 miss", async () => {
    const { store, calls } = fakeStore();
    installL2StoreForTests(store);
    const factory = vi.fn(async () => "built");
    const outcomes: L2Outcome[] = [];

    const wrapped = withL2("ws", "plans:list|k", factory, {
      tags: ["harness_plans"],
      softTtlMs: 5_000,
      onL2Outcome: (o) => outcomes.push(o),
    });

    await expect(wrapped()).resolves.toBe("built");
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(["miss"]);
    expect(calls.set).toHaveLength(1);
    expect(calls.set[0]?.value).toBe("built");
    expect(calls.set[0]?.tags).toEqual(["harness_plans"]);
  });

  // ── THE SEMANTIC INVARIANT ────────────────────────────────────────────────────
  it("bounds the L2 row by the SOFT ttl, not the hard one — so L2 never outlives L1 freshness", async () => {
    const { store, calls } = fakeStore();
    installL2StoreForTests(store);

    const wrapped = withL2("ws", "k", async () => "v", {
      tags: [],
      softTtlMs: 20_000,
      hardTtlMs: 600_000, // the cachedRead default — deliberately NOT what L2 uses
    });
    await wrapped();
    await settle();

    // If this ever reads 600_000, an SWR background revalidate can read its own stale
    // value back out of L2 and the soft TTL silently stops bounding anything.
    expect(calls.set[0]?.hardTtlMs).toBe(20_000);
  });

  it("falls back to the hard ttl only when no soft ttl was given", async () => {
    const { store, calls } = fakeStore();
    installL2StoreForTests(store);
    await withL2("ws", "k", async () => "v", { tags: [], hardTtlMs: 90_000 })();
    await settle();
    expect(calls.set[0]?.hardTtlMs).toBe(90_000);
  });

  it("refuses to cache with NO usable ttl (an unbounded durable row)", async () => {
    const factory = async (): Promise<string> => "v";
    expect(withL2("ws", "k", factory, { tags: [] })).toBe(factory);
    expect(withL2("ws", "k", factory, { tags: [], softTtlMs: 0 })).toBe(factory);
    expect(withL2("ws", "k", factory, { tags: [], softTtlMs: Infinity })).toBe(factory);
  });

  it("degrades to a real build when the store THROWS — a cache tier never fails a read, but it LOGS", async () => {
    installL2StoreForTests({
      get: async () => {
        throw new Error("pg down");
      },
      set: async () => undefined,
    } as unknown as PgL2Store);
    const outcomes: L2Outcome[] = [];
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = withL2("ws", "k", async () => "built-anyway", {
      tags: [],
      softTtlMs: 1_000,
      onL2Outcome: (o) => outcomes.push(o),
    });

    await expect(wrapped()).resolves.toBe("built-anyway");
    expect(outcomes).toEqual(["error"]);
    // The LOG is load-bearing, not noise: a silently-swallowed error is how this tier
    // ran 100% inert on :3170 while every counter and test looked plausible. The
    // message is what turned that into a one-line diagnosis.
    expect(errs).toHaveBeenCalledTimes(1);
    expect(errs.mock.calls[0]?.[0]).toContain("[cache-l2] get FAILED");
    expect(errs.mock.calls[0]?.[0]).toContain("pg down");
    errs.mockRestore();
  });

  it("rate-limits the error log so a cold herd cannot storm the journal", async () => {
    installL2StoreForTests({
      get: async () => {
        throw new Error("pg down");
      },
      set: async () => undefined,
    } as unknown as PgL2Store);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const wrapped = withL2("ws", "k", async () => "v", { tags: [], softTtlMs: 1_000 });

    await wrapped();
    await wrapped();
    await wrapped();

    // First one always logs (that is the one that says the tier never worked); the
    // rest are suppressed inside the window.
    expect(errs).toHaveBeenCalledTimes(1);
    errs.mockRestore();
  });

  it("does not write through a null/undefined build result", async () => {
    const { store, calls } = fakeStore();
    installL2StoreForTests(store);
    await withL2("ws", "k", async () => null, { tags: [], softTtlMs: 1_000 })();
    await settle();
    expect(calls.set).toHaveLength(0);
  });
});

// ── THE SUBORDINATION INVARIANT ─────────────────────────────────────────────────
describe("CACHE_LAYER subordination", () => {
  it("disables L2 when CACHE_LAYER is off, even with CACHE_L2 ON", async () => {
    await enable(true, /* cacheLayer */ false);
    expect(l2TierEnabled()).toBe(false);

    const factory = async (): Promise<string> => "v";
    // The panic switch must mean "no cache", not "no L1" — otherwise pulling it
    // leaves a DURABLE tier still serving, which is the opposite of a kill-switch.
    expect(withL2("ws", "k", factory, { tags: [], softTtlMs: 1_000 })).toBe(factory);
  });

  it("is enabled only when BOTH flags are on", async () => {
    await enable(false, true);
    expect(l2TierEnabled()).toBe(false);
    await enable(true, true);
    expect(l2TierEnabled()).toBe(true);
  });
});

/**
 * FALSIFIABILITY CONTROL (repo rule: a guard that has never failed is untested).
 * The soft-over-hard invariant is the one design decision in this file, and the
 * happy-path assertion above cannot on its own prove the check discriminates —
 * both orderings return a plausible number. So the WRONG implementation is kept
 * here permanently as a control and asserted to FAIL the property the real one
 * passes. No production code is mutated, so there is no sweep race and nothing to
 * restore (the tree-mutation shape this repo has already had committed once).
 */
describe("l2RowTtlMs — falsifiability of the soft-over-hard invariant", () => {
  /** Deliberately wrong: prefers the HARD ttl. This is what the bug looks like. */
  const wrongTtl = (o: { softTtlMs?: number; hardTtlMs?: number }): number | undefined =>
    o.hardTtlMs ?? o.softTtlMs;

  const swrCase = { softTtlMs: 20_000, hardTtlMs: 600_000 };

  it("the REAL implementation prefers the soft ttl", () => {
    expect(l2RowTtlMs(swrCase)).toBe(20_000);
  });

  it("the WRONG implementation is CAUGHT by that same assertion", () => {
    // If this ever passes, the assertion above has stopped discriminating and the
    // soft-ttl guard is decorative.
    expect(wrongTtl(swrCase)).not.toBe(20_000);
    expect(wrongTtl(swrCase)).toBe(600_000);
  });

  it("calibration: both agree when only ONE ttl is present, so the case above is what separates them", () => {
    expect(l2RowTtlMs({ hardTtlMs: 90_000 })).toBe(wrongTtl({ hardTtlMs: 90_000 }));
    expect(l2RowTtlMs({ softTtlMs: 5_000 })).toBe(wrongTtl({ softTtlMs: 5_000 }));
  });

  it("rejects every unusable bound", () => {
    expect(l2RowTtlMs({})).toBeUndefined();
    expect(l2RowTtlMs({ softTtlMs: 0 })).toBeUndefined();
    expect(l2RowTtlMs({ softTtlMs: Infinity })).toBeUndefined();
    expect(l2RowTtlMs({ softTtlMs: Number.NaN })).toBeUndefined();
  });
});

/**
 * COLD-START WINDOW (regression guard, found live on :3170 2026-08-08).
 * `ensureFlagWiring` starts the flag read with `void` — it is ASYNC — so the seeded
 * value governs every read during a process's first moments. Seeded `false`, L2 was
 * disabled for exactly the cold-start window it exists to serve: measured on :3170, a
 * 5s-old process moved NONE of the three L2 counters while a warm one reported a miss.
 * On a real deploy all 16 workers boot at once, so the tier would have been inert at
 * precisely the moment D-078 measured the 10s deadline hits.
 */
describe("cold-start window", () => {
  it("is ENABLED before any flag read has settled (the as-constructed seed)", () => {
    __resetL2StateForTests();
    // No flag read has happened yet — this is a worker in its first moments.
    expect(l2TierEnabled()).toBe(true);
  });

  it("wraps the factory during that window, rather than silently skipping L2", () => {
    __resetL2StateForTests();
    const factory = async (): Promise<string> => "v";
    // The live symptom of the bug was `withL2` returning the factory UNCHANGED, which
    // moves no counters at all — indistinguishable from "L2 was consulted and missed".
    expect(withL2("ws", "k", factory, { tags: [], softTtlMs: 20_000 })).not.toBe(factory);
  });

  it("KEEPS the current value when the flag read throws (one hiccup must not disable the tier for the process lifetime)", async () => {
    __resetL2StateForTests();
    setFlagOverridesForTest({
      get [CACHE_L2]() {
        throw new Error("flag store down");
      },
    } as unknown as Record<string, boolean>);
    await _refreshL2FlagForTests();
    expect(l2TierEnabled()).toBe(true);
  });
});

describe("invalidateL2ByTags", () => {
  it('classifies pool lifecycle failures as safe to retry, but not SQL failures', () => {
    expect(
      isRetryableL2InvalidationError(Object.assign(new Error('write CONNECTION_ENDED'), { code: 'CONNECTION_ENDED' })),
    ).toBe(true);
    expect(isRetryableL2InvalidationError(new Error('write CONNECTION_DESTROYED 127.0.0.1:6432'))).toBe(true);
    expect(isRetryableL2InvalidationError(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false);
  });

  it('retries an idempotent invalidation after a pool client ends', async () => {
    let attempts = 0;
    const store = {
      invalidateByTags: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('write CONNECTION_ENDED 127.0.0.1:6432'), {
            code: 'CONNECTION_ENDED',
          });
        }
        return 3;
      },
    } as unknown as PgL2Store;
    installL2StoreForTests(store);

    await expect(invalidateL2ByTagsWithRetry('ws', ['harness_plans'], { sleep: async () => {} })).resolves.toBe(3);
    expect(attempts).toBe(2);
  });

  it('does not replay a non-retryable invalidation failure', async () => {
    let attempts = 0;
    const failure = Object.assign(new Error('relation cache_l2 does not exist'), { code: '42P01' });
    installL2StoreForTests({
      invalidateByTags: async () => {
        attempts += 1;
        throw failure;
      },
    } as unknown as PgL2Store);

    await expect(invalidateL2ByTagsWithRetry('ws', ['harness_plans'], { sleep: async () => {} })).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it("deletes matching rows so a tag bust reaches the durable tier", async () => {
    const { store, calls } = fakeStore({ value: "stale" });
    installL2StoreForTests(store);

    invalidateL2ByTags("ws", ["harness_plans"]);
    await settle();
    expect(calls.invalidated).toEqual([["harness_plans"]]);

    // and the row is genuinely gone — the next read rebuilds
    const factory = vi.fn(async () => "fresh");
    await expect(withL2("ws", "k", factory, { tags: [], softTtlMs: 1_000 })()).resolves.toBe("fresh");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the tier is off, and never throws when the store fails", async () => {
    const { store, calls } = fakeStore();
    installL2StoreForTests(store);
    await enable(false);
    invalidateL2ByTags("ws", ["harness_plans"]);
    await settle();
    expect(calls.invalidated).toHaveLength(0);

    await enable(true);
    installL2StoreForTests({
      invalidateByTags: async () => {
        throw new Error("pg down");
      },
    } as unknown as PgL2Store);
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => invalidateL2ByTags("ws", ["harness_plans"])).not.toThrow();
    await settle();
    expect(errs.mock.calls[0]?.[0]).toContain("[cache-l2] invalidateByTags FAILED");
    errs.mockRestore();
  });
});
