/**
 * work_items:list / work_items:get cache integration (cache-expensive-tool-reads-2026-06-22
 * P-005). REAL handlers + REAL operator cache; only the data layer is mocked.
 * Pins: hit-on-repeat, per-item invalidation, table-level invalidation, no cross-arg /
 * cross-workspace leak, CACHE_LAYER bypass.
 *
 * WI-4491 REGRESSION GUARD: the invalidation tests bump the tags a REAL work-item write
 * emits — derived from the ECA rule (`tagsForTableChange` for a `harness_shared.work_items.changed`
 * event), NOT the literal tag string the tool happens to use. The old tests hardcoded
 * `harness_features_consolidated` (the tool's own tag) on BOTH sides, so they stayed green
 * while the tool tagged a stale compat-VIEW name that no write ever bumps — the cache was
 * invalidated by nothing but TTL, and a read-after-write served the pre-write row (proven
 * live, WI-4508). Tying the bump to the rule's output means a tool that tags the wrong
 * table now FAILS here instead of silently going stale.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";
import { tagsForTableChange } from "../../events/cache-eca-rule";
// Type-only: erased at compile time, so it does NOT defeat the vi.mock('../../work-items')
// factory below. It exists so the listWorkItems mock declares the REAL filter parameter —
// without it vitest infers the mock's call-args tuple as `[]`, and the projection
// assertions below (which read `mock.calls[n][0]`) cannot index it.
import type { ListWorkItemsFilter } from "../../work-items";

// The base TABLE that carries emit_change_notify (mig-374 unified work-items here). A
// write to ANY work-item — feature OR issue family, raw-SQL or federated — fires
// `harness_shared.work_items.changed`, and the CACHE_TAG_ECA rule bumps exactly these
// tags. This is the SINGLE SOURCE OF TRUTH for "what a work-item write invalidates" —
// the tool's cache tags MUST intersect it or reads go stale.
const WORK_ITEM_TABLE = "work_items";
/** Tags a real `work_items.changed` event bumps for row `id` (table tag + row tag). */
const writeTags = (id: string): string[] => tagsForTableChange(WORK_ITEM_TABLE, id);
/** Tags a real work_items write emits when the trigger yields no row PK (table tag only). */
const writeTableTag = (): string[] => tagsForTableChange(WORK_ITEM_TABLE, null);

const M = vi.hoisted(() => ({
  listWorkItems: vi.fn(async (_filter: ListWorkItemsFilter = {}) => [] as unknown[]),
  countWorkItems: vi.fn<typeof import("../../work-items").countWorkItems>(async () => 0),
  getWorkItem: vi.fn(async (id: string) => ({
    id,
    kind: "feature",
    title: `t-${id}`,
    state: "todo",
  })),
  getWorkItemDetail: vi.fn(async (id: string) => ({
    id,
    kind: "feature",
    title: `t-${id}`,
    state: "todo",
    detail: true,
  })),
}));

// Checkpoint enrichment deliberately sits outside work_items:get's cached base-row
// read. Keep the integration suite deterministic so the regression below can change
// the stored checkpoint between two calls while the work-item row remains a cache hit.
const CHECKPOINT = vi.hoisted(() => ({
  getWorkItemCheckpointWithMeta: vi.fn<
    typeof import("../../work-item-checkpoint").getWorkItemCheckpointWithMeta
  >(async () => ({ checkpoint: null, updatedAtMs: null })),
  getWorkItemCheckpointFreshness: vi.fn(async () => undefined),
}));

vi.mock("../../work-items", async (orig) => {
  const actual = await orig<typeof import("../../work-items")>();
  return {
    ...actual,
    listWorkItems: M.listWorkItems,
    countWorkItems: M.countWorkItems,
    getWorkItem: M.getWorkItem,
    getWorkItemDetail: M.getWorkItemDetail,
  };
});

vi.mock("../../work-item-checkpoint", () => ({
  getWorkItemCheckpointWithMeta: CHECKPOINT.getWorkItemCheckpointWithMeta,
  getWorkItemCheckpointFreshness: CHECKPOINT.getWorkItemCheckpointFreshness,
}));

import listTool from "./list";
import getTool from "./get";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const ctx = (
  workspaceId: string,
  contextTier?: "trimmed" | "standard" | "full",
  payloadTierOverride?: "trimmed" | "standard" | "full",
): never =>
  ({
    workspaceId,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
    ...(contextTier !== undefined ? { contextTier } : {}),
    ...(payloadTierOverride !== undefined ? { payloadTierOverride } : {}),
  }) as never;

const list = (
  args: Record<string, unknown>,
  ws = "ws-wi",
  contextTier?: "trimmed" | "standard" | "full",
  payloadTierOverride?: "trimmed" | "standard" | "full",
): Promise<unknown> => listTool.handler(args as never, ctx(ws, contextTier, payloadTierOverride));
const get = (args: Record<string, unknown>, ws = "ws-wi"): Promise<unknown> =>
  getTool.handler(args as never, ctx(ws));

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.listWorkItems.mockClear();
  M.countWorkItems.mockClear();
  M.getWorkItem.mockClear();
  M.getWorkItemDetail.mockClear();
  CHECKPOINT.getWorkItemCheckpointWithMeta.mockReset().mockResolvedValue({ checkpoint: null, updatedAtMs: null });
  CHECKPOINT.getWorkItemCheckpointFreshness.mockReset().mockResolvedValue(undefined);
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("work_items:list — cache wiring", () => {
  it("a repeat call HITS (the read runs once)", async () => {
    await list({});
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(1);
    expect(M.countWorkItems).toHaveBeenCalledTimes(2);
    expect(M.countWorkItems.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ audience: "agent" }),
    );
    expect(M.countWorkItems.mock.calls[1]![0]?.audience).toBeUndefined();
  });

  it("a q search omits unknown population counts and remains cached", async () => {
    await list({ q: "needle" });
    await list({ q: "needle" });
    expect(M.listWorkItems).toHaveBeenCalledTimes(1);
    expect(M.countWorkItems).not.toHaveBeenCalled();
  });

  it("ambient trimmed/standard reads request the lean SQL projection", async () => {
    await list({}, "ws-wi", "trimmed");
    expect(M.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ includeBody: false, includePayload: false }),
    );

    await list({}, "ws-wi", "standard");
    expect(M.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ includeBody: false, includePayload: false }),
    );
  });

  it("explicit lean source flags override a full compound context and remain cache-keyed", async () => {
    // coord:orient clears the ambient context tier while redispatching this read.
    // Keep the override effective even when the handler sees a full-tier context,
    // and keep that lean source entry separate from the ordinary full read.
    await list({ includeBody: false, includePayload: false }, "ws-wi", "full");
    await list({ includeBody: false, includePayload: false }, "ws-wi", "full");
    await list({}, "ws-wi", "full");

    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    expect(M.listWorkItems.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ includeBody: false, includePayload: false }),
    );
    expect(M.listWorkItems.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ includeBody: true, includePayload: true }),
    );
  });

  it("keeps full and lean source reads in separate cache entries, with an explicit full escape", async () => {
    await list({}, "ws-wi", "trimmed");
    await list({}, "ws-wi");
    await list({}, "ws-wi", "trimmed", "full");

    // The explicit full escape reuses the already-populated full entry; it must
    // not trigger a third database read, but it must never hit the lean entry.
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    expect(M.listWorkItems.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ includeBody: false, includePayload: false }),
    );
    expect(M.listWorkItems.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ includeBody: true, includePayload: true }),
    );
  });

  it("a REAL work-item write BUSTS it (bumps the work_items base-table tag the ECA emits)", async () => {
    await list({});
    // Exactly what the ECA fires on a work_items.changed with no row PK (today's trigger).
    getOperatorCache().invalidateByTags("ws-wi", writeTableTag());
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    expect(M.countWorkItems).toHaveBeenCalledTimes(4);
  });

  it("a per-row work-item write also busts the list (table tag rides alongside the row tag)", async () => {
    await list({});
    getOperatorCache().invalidateByTags("ws-wi", writeTags("WI-9"));
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    expect(M.countWorkItems).toHaveBeenCalledTimes(4);
  });

  it("different filter args do NOT share an entry (no cross-arg leak)", async () => {
    await list({ state: "todo" });
    await list({ state: "done" });
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    await list({ state: "todo" }); // cached
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it("plural states alias reaches the store and shares its order-insensitive cache key", async () => {
    await list({ states: ["open", "wip"] });
    expect(M.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ state: undefined, states: ["open", "wip"] }),
    );

    // `states` compiles to ANY(...), so equivalent orderings should reuse the same
    // cache entry rather than issuing another database read.
    await list({ states: ["wip", "open"] });
    expect(M.listWorkItems).toHaveBeenCalledTimes(1);
  });

  it("assignedBy participates in the cache key (no delegator-filter leak)", async () => {
    await list({ assignedBy: "owner-a" });
    await list({ assignedBy: "owner-b" });
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
    await list({ assignedBy: "owner-a" }); // cached
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry", async () => {
    await list({}, "ws-A");
    await list({}, "ws-B");
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it("CACHE_LAYER OFF ⇒ bypass", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await list({});
    await list({});
    expect(M.listWorkItems).toHaveBeenCalledTimes(2);
  });
});

describe("work_items:get — per-item cache wiring", () => {
  it("a repeat get of the same id HITS (read runs once)", async () => {
    await get({ id: "WI-1" });
    await get({ id: "WI-1" });
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
  });

  it("READ-YOUR-CHECKPOINT-WRITES: a cache-primed base row still reads the latest checkpoint", async () => {
    let checkpoint = "before checkpoint write";
    CHECKPOINT.getWorkItemCheckpointWithMeta.mockImplementation(async () => ({
      checkpoint,
      updatedAtMs: Date.now(),
    }));

    const first = (await get({ id: "WI-1" })) as { data: { results: Array<{ checkpoint: string }> } };
    checkpoint = "after checkpoint write";
    const second = (await get({ id: "WI-1" })) as { data: { results: Array<{ checkpoint: string }> } };

    expect(first.data.results[0].checkpoint).toBe("before checkpoint write");
    expect(second.data.results[0].checkpoint).toBe("after checkpoint write");
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
    expect(CHECKPOINT.getWorkItemCheckpointWithMeta).toHaveBeenCalledTimes(2);
  });

  it("READ-YOUR-WRITES: a real work-item write busts the get cache (base-table tag)", async () => {
    // The primary WI-4491 guard: the table tag a work_items write emits TODAY (no row PK)
    // MUST bust the get entry — else a read-after-write serves the pre-write row.
    await get({ id: "WI-1" });
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-wi", writeTableTag());
    await get({ id: "WI-1" }); // rebuilt — reflects the write
    expect(M.getWorkItem).toHaveBeenCalledTimes(2);
  });

  it("PER-ITEM invalidation: a per-row work_items write busts WI-1 but NOT WI-2", async () => {
    // Row-tag readiness (WI-4491): the tool's `work_items:<id>` row tag is correctly named
    // for the ECA's row-tag scheme. NOTE the row tag only fires LIVE once emit_change_notify
    // emits work_items' PK (feature_id) — tracked as the separate row-PK defect; until then
    // correctness rides the table tag above. This asserts the tag CORRESPONDENCE regardless.
    await get({ id: "WI-1" });
    await get({ id: "WI-2" });
    expect(M.getWorkItem).toHaveBeenCalledTimes(2);
    // Bump ONLY the row tag (writeTags also carries the table tag, which would bust every
    // entry) — isolates the per-row dimension.
    const rowTagOnly = writeTags("WI-1").filter((t) => t !== WORK_ITEM_TABLE);
    getOperatorCache().invalidateByTags("ws-wi", rowTagOnly);
    await get({ id: "WI-1" }); // rebuilt
    await get({ id: "WI-2" }); // still cached
    expect(M.getWorkItem).toHaveBeenCalledTimes(3);
  });

  it("a table-wide work-item write busts every id", async () => {
    await get({ id: "WI-1" });
    await get({ id: "WI-2" });
    getOperatorCache().invalidateByTags("ws-wi", writeTableTag());
    await get({ id: "WI-1" });
    await get({ id: "WI-2" });
    expect(M.getWorkItem).toHaveBeenCalledTimes(4);
  });

  it("detail vs non-detail are separate entries", async () => {
    await get({ id: "WI-1" });
    await get({ id: "WI-1", detail: true });
    expect(M.getWorkItem).toHaveBeenCalledTimes(1);
    expect(M.getWorkItemDetail).toHaveBeenCalledTimes(1);
  });

  it("detail reads are invalidated by every coordination table they fold in", async () => {
    const dependencies = ["coord_links", "coord_threads", "coord_thread_posts"];

    for (const [index, table] of dependencies.entries()) {
      const id = `WI-detail-${index}`;
      await get({ id, detail: true });
      await get({ id, detail: true }); // warm the detail entry
      expect(M.getWorkItemDetail).toHaveBeenCalledTimes(index * 2 + 1);

      // Simulate the cache-ECA output for a real <table>.changed event. The table tag
      // is the dependency; the row tag is included to keep this coupled to the ECA's
      // canonical tag shape rather than a hand-written cache string.
      getOperatorCache().invalidateByTags("ws-wi", tagsForTableChange(table, `row-${index}`));
      await get({ id, detail: true });
    }

    expect(M.getWorkItemDetail).toHaveBeenCalledTimes(dependencies.length * 2);
  });

  it("CACHE_LAYER OFF ⇒ bypass", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await get({ id: "WI-1" });
    await get({ id: "WI-1" });
    expect(M.getWorkItem).toHaveBeenCalledTimes(2);
  });
});
