/**
 * Persistent runtime-override layer (audit P-070, EI-76).
 *
 * Precedence under test: env var > test overrides > stored override >
 * PostHog/defaults. The store is injected (Papercusp wires a PG-backed one
 * in operator-core's flag-bus); here a fake in-memory store stands in.
 */
import {
  listPinnedModuleKeys,
  pinModuleState,
} from "@papercusp/module-singleton";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bustOverrideReadCache,
  clearAllFlagOverrides,
  getAllFlags,
  getFlag,
  getFlagAttestation,
  initFlagBackend,
  initFlagOverrideStore,
  isOverrideStoreConfigured,
  resetOverrideStoreWarningForTest,
  setFlagOverride,
  type FlagOverrideStore,
} from "./server";
import { setFlagOverridesForTest } from "./test";
import { FLAGS, FLAG_DEFAULTS, type FlagKey } from "./types";

const KEY = FLAGS.TESTING; // default false — a visible flip target
const ENV_KEY = `PAPERCUSP_FLAG_${KEY.toUpperCase().replace(/-/g, "_")}`;

// A second, ARBITRARY override key — the clear-all test needs *some* flag other
// than KEY, never a particular one. Derived from the registry rather than naming
// a flag, so retiring any single flag can no longer strand this test: it used to
// pin FLAGS.POT_CONTROL, which was deleted once its consumers went away
// (EI-20112620689800573).
const OTHER_KEY = (Object.keys(FLAG_DEFAULTS) as FlagKey[]).find(
  (k) => k !== KEY,
);
if (!OTHER_KEY) {
  throw new Error(
    "flag registry exposes fewer than 2 flags — this suite needs a second key",
  );
}

function makeFakeStore(initial: Partial<Record<FlagKey, boolean>> = {}) {
  const map: Partial<Record<FlagKey, boolean>> = { ...initial };
  let loads = 0;
  const store: FlagOverrideStore = {
    async load() {
      loads++;
      return { ...map };
    },
    async set(key, enabled) {
      if (enabled === null) delete map[key];
      else map[key] = enabled;
    },
  };
  return { store, map, loads: () => loads };
}

beforeEach(() => {
  initFlagBackend(null);
  setFlagOverridesForTest(null);
  delete process.env[ENV_KEY];
  delete process.env.PAPERCUSP_FLAG_OVERRIDE_CACHE_TTL_MS;
  // The hanging-store test drops this to 1ms; leaking it would silently shorten
  // every later backend call in this file.
  delete process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS;
});

afterEach(() => {
  initFlagOverrideStore(null);
  setFlagOverridesForTest(null);
  delete process.env[ENV_KEY];
  delete process.env.PAPERCUSP_FLAG_OVERRIDE_CACHE_TTL_MS;
  // The hanging-store test drops this to 1ms; leaking it would silently shorten
  // every later backend call in this file.
  delete process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS;
});

describe("flag override store", () => {
  it("without a store, behavior is unchanged (defaults)", async () => {
    initFlagOverrideStore(null);
    expect(isOverrideStoreConfigured()).toBe(false);
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);
    const r = await setFlagOverride(KEY, true);
    expect(r).toEqual({ ok: false, reason: "override-store-not-configured" });
  });

  it("a stored override beats the default", async () => {
    const { store } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, "u")).toBe(!FLAG_DEFAULTS[KEY]);
  });

  it("env var beats a stored override", async () => {
    const { store } = makeFakeStore({ [KEY]: false });
    initFlagOverrideStore(store);
    process.env[ENV_KEY] = "1";
    expect(await getFlag(KEY, "u")).toBe(true);
  });

  it("test overrides beat a stored override", async () => {
    const { store } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    setFlagOverridesForTest({ [KEY]: false });
    expect(await getFlag(KEY, "u")).toBe(false);
  });

  it("setFlagOverride writes through and is visible immediately (cache busted)", async () => {
    const { store, map } = makeFakeStore();
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]); // cache primed

    expect(await setFlagOverride(KEY, !FLAG_DEFAULTS[KEY])).toEqual({
      ok: true,
    });
    expect(map[KEY]).toBe(!FLAG_DEFAULTS[KEY]);
    expect(await getFlag(KEY, "u")).toBe(!FLAG_DEFAULTS[KEY]);

    expect(await setFlagOverride(KEY, null)).toEqual({ ok: true }); // clear
    expect(map[KEY]).toBeUndefined();
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);
  });

  it("clearAllFlagOverrides removes every stored override (the leave-testing reset)", async () => {
    // The "Full testing" / per-flag toggles pin flags on as stored overrides;
    // leaving testing mode must clear them so flags return to bundled defaults
    // (flag-testing-toggle-clears-overrides 2026-06-18).
    const { store, map } = makeFakeStore({ [KEY]: true, [OTHER_KEY]: true });
    initFlagOverrideStore(store);
    expect(await getFlag(KEY, "u")).toBe(true); // override active (shadows default)

    const cleared = await clearAllFlagOverrides();
    expect([...cleared].sort()).toEqual([OTHER_KEY, KEY].sort());
    expect(map[KEY]).toBeUndefined();
    expect(map[OTHER_KEY]).toBeUndefined();
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]); // back to default
  });

  it("clearAllFlagOverrides with no store configured is a safe no-op", async () => {
    initFlagOverrideStore(null);
    expect(await clearAllFlagOverrides()).toEqual([]);
  });

  it("reads are TTL-cached — repeated getFlag calls do not re-hit the store", async () => {
    const { store, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    await getFlag(KEY, "u");
    await getFlag(KEY, "u");
    await getFlag(KEY, "u");
    expect(loads()).toBe(1);
  });

  it("attests the exact override resolution path and process-local cache generation", async () => {
    const { store, loads } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
    initFlagOverrideStore(store);

    const loaded = await getFlagAttestation(KEY, "u");
    expect(loaded).toMatchObject({
      key: KEY,
      resolvedValue: !FLAG_DEFAULTS[KEY],
      compiledDefault: FLAG_DEFAULTS[KEY],
      source: "override-store",
      overrideRead: {
        kind: "store-load",
        storeConfigured: true,
        cacheGeneration: expect.any(Number),
      },
    });
    expect(loaded.overrideRead.ttlRemainingMs).toBeGreaterThan(0);

    const cached = await getFlagAttestation(KEY, "u");
    expect(cached).toMatchObject({
      resolvedValue: loaded.resolvedValue,
      source: "process-cache",
      overrideRead: {
        kind: "cache-hit",
        cacheGeneration: loaded.overrideRead.cacheGeneration,
      },
    });
    expect(loads()).toBe(1);

    bustOverrideReadCache();
    const reloaded = await getFlagAttestation(KEY, "u");
    expect(reloaded.source).toBe("override-store");
    expect(reloaded.overrideRead.kind).toBe("store-load");
    expect(reloaded.overrideRead.cacheGeneration).toBeGreaterThan(
      loaded.overrideRead.cacheGeneration ?? 0,
    );
  });

  it("carries the store's load error on a degraded read, and null on a healthy one (WI-10006242)", async () => {
    const failing: FlagOverrideStore = {
      async load() {
        throw new Error("store refused: forbidden by policy");
      },
      async set() {},
    };
    initFlagOverrideStore(failing);
    const degraded = await getFlagAttestation(KEY, "u");
    expect(degraded.overrideRead.kind).toBe("store-error");
    expect(degraded.overrideRead.loadError).toBe(
      "Error: store refused: forbidden by policy",
    );

    const { store } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    const healthy = await getFlagAttestation(KEY, "u");
    expect(healthy.overrideRead.kind).toBe("store-load");
    expect(healthy.overrideRead.loadError).toBeNull();
  });

  it("attests a missing store as a compiled default instead of implying a live override read", async () => {
    initFlagOverrideStore(null);
    const attestation = await getFlagAttestation(KEY, "u");
    expect(attestation).toMatchObject({
      resolvedValue: FLAG_DEFAULTS[KEY],
      compiledDefault: FLAG_DEFAULTS[KEY],
      source: "compiled-default",
      backendConfigured: false,
      overrideRead: {
        kind: "unconfigured",
        storeConfigured: false,
        cacheGeneration: null,
        ttlRemainingMs: 0,
      },
    });
  });

  it("attests an env override without pretending the override store was read", async () => {
    const { store, loads } = makeFakeStore({ [KEY]: false });
    initFlagOverrideStore(store);
    process.env[ENV_KEY] = "1";

    const attestation = await getFlagAttestation(KEY, "u");
    expect(attestation).toMatchObject({
      resolvedValue: true,
      source: "env-override",
      overrideRead: { kind: "not-read", storeConfigured: true },
    });
    expect(loads()).toBe(0);
  });

  it("the read-cache TTL is env-configurable — TTL=0 disables caching so every getFlag re-reads (WI-3800: lets a high-throughput process tune down its override-read churn)", async () => {
    process.env.PAPERCUSP_FLAG_OVERRIDE_CACHE_TTL_MS = "0";
    const { store, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store); // clears the cache
    await getFlag(KEY, "u");
    await getFlag(KEY, "u");
    await getFlag(KEY, "u");
    // TTL 0 ⇒ the cache entry is never within-window ⇒ each call re-hits the store.
    expect(loads()).toBe(3);
  });

  it("partitions the read-cache per scope — no cross-workspace bleed", async () => {
    // load() resolves overrides for whatever scope is active at call time
    // (Papercusp: WHERE workspace_id = activeWorkspaceId()). A single global
    // cache would serve the first-loaded scope's overrides to every other
    // scope for the TTL window; cacheKey() partitions the cache so a scope
    // only ever sees its own row.
    let scope = "ws-a";
    const rows: Record<string, Partial<Record<FlagKey, boolean>>> = {
      "ws-a": { [KEY]: true }, // ws-a overrides KEY ON
      "ws-b": {}, // ws-b has no override → resolves to the default
    };
    const store: FlagOverrideStore = {
      async load() {
        return { ...(rows[scope] ?? {}) };
      },
      async set(key, enabled) {
        rows[scope] ??= {};
        if (enabled === null) delete rows[scope][key];
        else rows[scope][key] = enabled;
      },
      cacheKey: () => scope,
    };
    initFlagOverrideStore(store);

    scope = "ws-a";
    expect(await getFlag(KEY, "u")).toBe(true); // ws-a override, now cached

    // Switch scope WITHIN the TTL window — must NOT inherit ws-a's cached value.
    scope = "ws-b";
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]); // ws-b → default, no bleed

    // ws-a still resolves its own override (its cache entry is independent).
    scope = "ws-a";
    expect(await getFlag(KEY, "u")).toBe(true);
  });

  it("a write invalidates every cached scope when the store has a shared layer (EI-1831)", async () => {
    let scope = "ws-a";
    let shared: Partial<Record<FlagKey, boolean>> = {};
    const store: FlagOverrideStore = {
      async load() {
        return { ...shared };
      },
      async set(key, enabled) {
        shared = { ...shared };
        if (enabled === null) delete shared[key];
        else shared[key] = enabled;
      },
      cacheKey: () => scope,
    };
    initFlagOverrideStore(store);

    // Prime two independent scope caches with the old shared value.
    scope = "ws-a";
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);
    scope = "ws-b";
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);

    // The write originates in A, but B must not keep its old cache entry.
    scope = "ws-a";
    expect(await setFlagOverride(KEY, !FLAG_DEFAULTS[KEY])).toEqual({
      ok: true,
    });
    scope = "ws-b";
    expect(await getFlag(KEY, "u")).toBe(!FLAG_DEFAULTS[KEY]);
  });

  it("getAllFlags overlays stored overrides onto defaults", async () => {
    const { store } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
    initFlagOverrideStore(store);
    const payload = await getAllFlags("u");
    expect(payload.flags[KEY]).toBe(!FLAG_DEFAULTS[KEY]);
    expect(payload.source).toBe("defaults"); // base source unchanged
  });

  it("getAllFlags drops stored keys for RETIRED flags instead of leaking them into the payload", async () => {
    // The PG row outlives flag retirements (e.g. papercusp-oracle folded into
    // papercusp-testing 2026-06-10): a raw spread of the stored map would
    // re-introduce the dead key into every client payload forever.
    const { store } = makeFakeStore({
      [KEY]: true,
      ["papercusp-retired-ghost" as FlagKey]: true,
    });
    initFlagOverrideStore(store);
    const payload = await getAllFlags("u");
    expect(payload.flags[KEY]).toBe(true); // live override still applies
    expect("papercusp-retired-ghost" in payload.flags).toBe(false);
  });

  it("a failing store falls back to defaults instead of throwing", async () => {
    initFlagOverrideStore({
      async load() {
        throw new Error("pg down");
      },
      async set() {
        throw new Error("pg down");
      },
    });
    expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);
    const r = await setFlagOverride(KEY, true);
    expect(r.ok).toBe(false);
  });

  /**
   * EI-21733487918833986 — the sibling of the test above, and the one that was
   * missing. A store that REJECTS was always handled; a store that simply never
   * SETTLES was not: `loadStoredOverrides()` awaited `overrideStore.load()`
   * unbounded, and `getFlag()` awaits that BEFORE its own try/catch, so a hung
   * store parked every caller in the process forever — with no CPU, no libuv
   * request and no PG session, i.e. invisible to every instrument an
   * investigator reaches for.
   *
   * The `timeout` here is the assertion: without the fix this test does not
   * fail on a bad value, it HANGS, so a short bound is what makes the red legible.
   */
  it(
    "a HANGING store falls back to defaults instead of blocking forever",
    { timeout: 5_000 },
    async () => {
      // CALIBRATION CONTROL — prove the store is actually consulted on this path.
      // Without it, "returns the default" would also be true if the override layer
      // were never reached at all, and a dead instrument would read as a pass.
      const { store: healthy } = makeFakeStore({ [KEY]: !FLAG_DEFAULTS[KEY] });
      initFlagOverrideStore(healthy);
      expect(await getFlag(KEY, "u")).toBe(!FLAG_DEFAULTS[KEY]);

      // Now the real subject. initFlagOverrideStore() clears the read-cache, so the
      // next getFlag MUST consult load() — it cannot be served the primed value,
      // which would make this pass for the wrong reason.
      process.env.PAPERCUSP_FLAG_BACKEND_TIMEOUT_MS = "1";
      initFlagOverrideStore({
        load: () => new Promise(() => {}), // never settles
        async set() {},
      });

      expect(await getFlag(KEY, "u")).toBe(FLAG_DEFAULTS[KEY]);
    },
  );
});

/**
 * EI-8867 — the read path must be as honest as the write path.
 *
 * Root cause recap: `setFlagOverride()` reports `override-store-not-configured`, but
 * `loadStoredOverrides()` silently returned `{}` — so a process with no store served
 * FLAG_DEFAULTS while `flags:set` (run in the operator process, which HAS a store) reported
 * success. No single process saw the contradiction. The inference gateway sat in exactly this
 * state and a dark flag "wouldn't turn on" with nothing logged.
 */
describe("EI-8867: missing override store is announced, once", () => {
  // The warn is suppressed under test runners by design, so exercise it the way a real
  // process sees it: with the runner env stubbed off.
  function asRealProcess(fn: () => Promise<void> | void) {
    return async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("VITEST", "");
      vi.stubEnv("PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN", "");
      try {
        await fn();
      } finally {
        vi.unstubAllEnvs();
      }
    };
  }

  beforeEach(() => {
    initFlagOverrideStore(null); // the buggy state: no store
    resetOverrideStoreWarningForTest();
  });
  afterEach(() => {
    initFlagOverrideStore(null);
    vi.restoreAllMocks();
  });

  it(
    "warns exactly ONCE per process even across many getFlag() reads",
    asRealProcess(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await getFlag(KEY, "u");
      await getFlag(KEY, "u");
      await getAllFlags("u");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/serving FLAG_DEFAULTS/);
    }),
  );

  it(
    "still fails SOFT — a missing store degrades to defaults, never throws",
    asRealProcess(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(getFlag(KEY, "u")).resolves.toBe(FLAG_DEFAULTS[KEY]);
    }),
  );

  it(
    "does NOT warn once a store is installed (the fixed state)",
    asRealProcess(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      initFlagOverrideStore(makeFakeStore({ [KEY]: true }).store);
      expect(await getFlag(KEY, "u")).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    }),
  );

  it(
    "re-arms after a LATE install so an early read never permanently mutes it",
    asRealProcess(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await getFlag(KEY, "u"); // warns (no store)
      expect(warn).toHaveBeenCalledTimes(1);
      initFlagOverrideStore(makeFakeStore().store); // late install re-arms the latch
      initFlagOverrideStore(null); // ...and the store is torn down again
      await getFlag(KEY, "u");
      expect(warn).toHaveBeenCalledTimes(2);
    }),
  );

  it(
    "is silent under the env opt-out, and the opt-out does not consume the one shot",
    asRealProcess(async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.stubEnv("PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN", "1");
      await getFlag(KEY, "u");
      expect(warn).not.toHaveBeenCalled();
      // Un-silence: the latch must NOT have been burned by the suppressed call.
      vi.stubEnv("PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN", "");
      await getFlag(KEY, "u");
      expect(warn).toHaveBeenCalledTimes(1);
    }),
  );

  it("is silent under a test runner (why this suite stubs the env at all)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await getFlag(KEY, "u");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("fork-safety — store AND override cache are pinned to the realm", () => {
  // WI-4275 pinned the STORE to globalThis because a second module record (tsx's
  // CJS preflight, a symlinked workspace path, a bundled copy) held its own
  // `store` and every runtime flags:set went silently invisible. That fix left
  // `overrideCache` module-local, which half-closed the bug one level down: on a
  // split, an invalidation reaching record A clears A's map while record B keeps
  // serving the stale override map for the rest of its TTL. Both now live in ONE
  // pinned state object (EI-19479108855357092).
  const STATE_KEY = "@papercusp/flags.server";
  type PinnedState = {
    store: FlagOverrideStore | null;
    overrideCache: Map<
      string,
      { flags: Partial<Record<FlagKey, boolean>>; ts: number }
    >;
  };

  // What a duplicate module record does on evaluation: pin the SAME key. The
  // primitive hands back the state the first record built.
  const asSecondRecord = (): PinnedState =>
    pinModuleState<PinnedState>(STATE_KEY, () => ({
      store: null,
      overrideCache: new Map(),
    }));

  it("CONTROL: a module-LOCAL cache is invisible through the pin (the pre-fix shape)", async () => {
    // Permanent known-positive control. Without it the two assertions below can
    // pass vacuously — `asSecondRecord().overrideCache` would read `size: 1` for
    // any reason at all, and a guard that can only pass is not a guard.
    // This is what `const overrideCache = new Map()` at module scope did: the
    // second record's view stays EMPTY however much the first record cached.
    const moduleLocal = new Map<
      string,
      { flags: Partial<Record<FlagKey, boolean>>; ts: number }
    >();
    moduleLocal.set("scope", { flags: { [KEY]: true }, ts: Date.now() });

    expect(moduleLocal.size).toBe(1);
    expect(asSecondRecord().overrideCache).not.toBe(moduleLocal);
    expect(asSecondRecord().overrideCache.size).toBe(0); // the split, verbatim
  });

  it("registers its key with @papercusp/module-singleton", () => {
    // Pinning THROUGH the primitive rather than hand-rolling a Symbol.for slot is
    // the point: listModuleDuplications() only knows about keys pinned this way,
    // so a hand-rolled pin leaves the realm-wide report answering a clean `[]`
    // while this module is split.
    expect(listPinnedModuleKeys()).toContain(STATE_KEY);
  });

  it("a second module record sees the store installed by the first", async () => {
    const { store } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);
    expect(asSecondRecord().store).toBe(store);
  });

  it("a second module record shares the override read cache", async () => {
    const { store, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);

    await getFlag(KEY, "u"); // primes the cache
    expect(loads()).toBe(1);

    // A split record reading within the TTL must HIT the same cache, not build
    // its own. Before the cache was pinned this map was per-record, so the
    // second record re-loaded (loads() === 2) and — worse — kept serving that
    // copy after the first record's invalidation.
    expect(asSecondRecord().overrideCache.size).toBe(1);
    await getFlag(KEY, "u");
    expect(loads()).toBe(1);
  });

  it("an invalidation through one record is visible to the other", async () => {
    const { store, map, loads } = makeFakeStore({ [KEY]: true });
    initFlagOverrideStore(store);

    expect(await getFlag(KEY, "u")).toBe(true);
    expect(loads()).toBe(1);

    // Mutate underneath, then invalidate. A split cache would keep serving the
    // stale `true` from the second record for the rest of the TTL.
    map[KEY] = false;
    bustOverrideReadCache();
    expect(asSecondRecord().overrideCache.size).toBe(0);
    expect(await getFlag(KEY, "u")).toBe(false);
    expect(loads()).toBe(2);
  });
});
