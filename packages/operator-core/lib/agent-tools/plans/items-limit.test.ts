/**
 * plans:items bounded-window contract (EI-20219728144911356).
 *
 * The tool must expose a validated limit so callers can bound a cross-plan
 * read without sending an undeclared argument. The cap is applied after the
 * handler's importance ordering and advertises truncation; the limit also
 * belongs in the cache key so different windows cannot share a response.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  listPlanIndexRows: vi.fn(async () => [] as unknown[]),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  getPlanRow: vi.fn(async () => null as unknown),
  planItemsForRow: vi.fn((row: unknown) => (row as { planItems?: unknown[] }).planItems ?? []),
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanIndexRows: M.listPlanIndexRows,
    getPlanContentsBySlugs: M.getPlanContentsBySlugs,
    getPlanRow: M.getPlanRow,
    planItemsForRow: M.planItemsForRow,
  };
});
vi.mock("./_ctx-opts", () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock("../../issue-blocks-merge", async (orig) => {
  const actual = await orig<typeof import("../../issue-blocks-merge")>();
  return {
    ...actual,
    getAllBlockedPlanItems: vi.fn(async () => new Map<string, string[]>()),
  };
});
vi.mock("../../plan-item-coverage", async (orig) => {
  const actual = await orig<typeof import("../../plan-item-coverage")>();
  return { ...actual, getAllPlanItemCoverage: M.getAllPlanItemCoverage };
});

import tool from "./items";
import {
  resetCachedReadStatsForTests,
  resetOperatorCacheForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const CACHE_L2 = "papercusp-cache-l2";

const item = (id: string, importance: "urgent" | "high" | "normal") => ({
  id,
  text: id,
  storedStatus: "todo",
  importance,
  blockedBy: [],
  decisionRefs: [],
  phase: "Phase 1",
  lineNumber: 1,
  rawLine: `- [ ] ${id}`,
  effectiveStatus: "todo",
  unresolvedBlockers: [],
  needsHuman: false,
  staleBlockedHint: null,
});

const plan = (slug: string, planItems: unknown[]) => ({
  planSlug: slug,
  archived: false,
  isLegacy: false,
  status: "active",
  content: "",
  created: "2026-08-01T00:00:00.000Z",
  planItems,
});

const contexts: Array<{ metadata: ReturnType<typeof vi.fn> }> = [];
const ctx = () => {
  const metadata = vi.fn();
  contexts.push({ metadata });
  return {
    workspaceId: "ws-items-limit",
    harnessSlug: "papercup",
    metadata,
    log: vi.fn(),
    progress: vi.fn(),
  } as never;
};

const run = async (args: Record<string, unknown>) =>
  tool.handler(args as never, ctx());

// Mirrors production dispatch: args pass through the schema (whose preprocess
// folds the unadvertised exact-item alias spellings into itemIds) before the
// handler sees them. Use this for any test that sends an alias spelling.
const runParsed = async (args: Record<string, unknown>) =>
  tool.handler(tool.args.parse(args) as never, ctx());

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  M.listPlanIndexRows.mockReset();
  M.getPlanContentsBySlugs.mockReset();
  M.getPlanContentsBySlugs.mockResolvedValue(new Map());
  M.getPlanRow.mockReset();
  M.getPlanRow.mockResolvedValue(null);
  M.planItemsForRow.mockClear();
  M.getAllPlanItemCoverage.mockReset();
  M.getAllPlanItemCoverage.mockResolvedValue(new Map());
  contexts.length = 0;
  setFlagOverridesForTest({ [CACHE_LAYER]: true, [CACHE_L2]: false });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

/** scope-unique-identifiers P-003: every row carries its linked work-item fields; these
 *  fixtures have no coverage links, so the item resolves through nothing. */
const UNLINKED = { workItemId: null, workItemIds: [] };

describe("plans:items bounded limit", () => {
  it("accepts a positive bounded limit and rejects invalid values", () => {
    expect(tool.args.safeParse({ harness: "papercup", limit: 1 }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", limit: 500 }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", limit: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", limit: 501 }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", limit: 1.5 }).success).toBe(false);
  });

  it("validates itemIds as an exact-slug homogeneous selector", () => {
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", itemIds: ["P-001", "P-002"] }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", itemIds: ["P-001"] }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", itemIds: ["P-01"] }).success).toBe(false);
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", itemIds: [] }).success).toBe(false);
  });

  it("EI-21588504660347963: accepts the singular `item` selector as a compatibility alias for itemIds", () => {
    // plans:get-item already uses `item` for its single-read shorthand; two
    // independent callers reached for the same convention here and hit
    // invalid_args before this alias existed.
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", item: "P-007" }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", item: "P-007" }).success).toBe(false); // still requires slug
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", item: "P-07" }).success).toBe(false); // still P-NNN
  });

  it("filters exact itemIds from the requested plan only", async () => {
    M.getPlanRow.mockResolvedValue(
      plan("plan-a", [item("P-001", "normal"), item("P-002", "high")]),
    );

    const result = (await run({ harness: "papercup", slug: "plan-a", itemIds: ["P-002"] })) as {
      data: { items: Array<{ plan: string; item: { id: string } }> };
    };

    expect(result.data.items).toEqual([{ plan: "plan-a", archived: false, item: expect.objectContaining({ id: "P-002" }), ...UNLINKED }]);
    expect(M.getPlanRow).toHaveBeenCalledWith("plan-a", expect.anything());
    expect(M.listPlanIndexRows).not.toHaveBeenCalled();
  });

  it("EI-21588504660347963: the singular `item` alias filters the same as one-element itemIds", async () => {
    M.getPlanRow.mockResolvedValue(
      plan("plan-a", [item("P-001", "normal"), item("P-002", "high")]),
    );

    const result = (await runParsed({ harness: "papercup", slug: "plan-a", item: "P-002" })) as {
      data: { items: Array<{ plan: string; item: { id: string } }> };
    };

    expect(result.data.items).toEqual([{ plan: "plan-a", archived: false, item: expect.objectContaining({ id: "P-002" }), ...UNLINKED }]);
  });

  it("EI-21913867956922477: accepts the plural `ids` selector as a compatibility alias for itemIds", () => {
    // work_items:get uses the id/ids singular/plural naming convention; a
    // caller reached for the same shape here (`ids:['P-024']`) and hit
    // invalid_args before this alias existed.
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", ids: ["P-007"] }).success).toBe(true);
    expect(tool.args.safeParse({ harness: "papercup", ids: ["P-007"] }).success).toBe(false); // still requires slug
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", ids: ["P-07"] }).success).toBe(false); // still P-NNN
    expect(tool.args.safeParse({ harness: "papercup", slug: "plan-a", ids: [] }).success).toBe(false);
  });

  it("EI-21913867956922477: the plural `ids` alias filters the same as itemIds", async () => {
    M.getPlanRow.mockResolvedValue(
      plan("plan-a", [item("P-001", "normal"), item("P-002", "high")]),
    );

    const result = (await runParsed({ harness: "papercup", slug: "plan-a", ids: ["P-002"] })) as {
      data: { items: Array<{ plan: string; item: { id: string } }> };
    };

    expect(result.data.items).toEqual([{ plan: "plan-a", archived: false, item: expect.objectContaining({ id: "P-002" }), ...UNLINKED }]);
  });

  it("EI-21913867956922477: itemIds wins when both itemIds and ids are supplied", async () => {
    M.getPlanRow.mockResolvedValue(
      plan("plan-a", [item("P-001", "normal"), item("P-002", "high")]),
    );

    const result = (await run({
      harness: "papercup",
      slug: "plan-a",
      itemIds: ["P-001"],
      ids: ["P-002"],
    })) as {
      data: { items: Array<{ plan: string; item: { id: string } }> };
    };

    expect(result.data.items).toEqual([{ plan: "plan-a", archived: false, item: expect.objectContaining({ id: "P-001" }), ...UNLINKED }]);
  });

  it("keeps different itemIds selections in separate cache entries", async () => {
    M.getPlanRow.mockResolvedValue(
      plan("plan-a", [item("P-001", "normal"), item("P-002", "high")]),
    );

    const first = (await run({ harness: "papercup", slug: "plan-a", itemIds: ["P-001"] })) as {
      data: { items: Array<{ item: { id: string } }> };
    };
    const second = (await run({ harness: "papercup", slug: "plan-a", itemIds: ["P-002"] })) as {
      data: { items: Array<{ item: { id: string } }> };
    };

    expect(first.data.items.map((row) => row.item.id)).toEqual(["P-001"]);
    expect(second.data.items.map((row) => row.item.id)).toEqual(["P-002"]);
    expect(M.getPlanRow).toHaveBeenCalledTimes(2);
  });

  it("caps after importance ordering and reports truncation", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      plan("p-normal", [item("P-003", "normal")]),
      plan("p-urgent", [item("P-001", "urgent")]),
      plan("p-high", [item("P-002", "high")]),
    ]);

    const result = (await run({ harness: "papercup", limit: 2 })) as {
      data: { items: Array<{ item: { id: string } }>; truncated?: boolean };
    };

    expect(result.data.items.map((row) => row.item.id)).toEqual(["P-001", "P-002"]);
    expect(result.data.truncated).toBe(true);
    expect(contexts[0].metadata).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, totalCount: 3, truncated: true }),
    );
  });

  it("keeps different limits in separate cache entries", async () => {
    M.listPlanIndexRows.mockResolvedValue([
      plan("p-urgent", [item("P-001", "urgent")]),
      plan("p-high", [item("P-002", "high")]),
    ]);

    const first = (await run({ harness: "papercup", limit: 1 })) as {
      data: { items: unknown[] };
    };
    const second = (await run({ harness: "papercup", limit: 2 })) as {
      data: { items: unknown[] };
    };

    expect(first.data.items).toHaveLength(1);
    expect(second.data.items).toHaveLength(2);
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });
});
