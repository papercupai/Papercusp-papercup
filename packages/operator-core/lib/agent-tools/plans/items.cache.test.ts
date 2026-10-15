/**
 * plans:items cache integration (cache-expensive-tool-reads-round2-2026-06-23 P-002).
 *
 * Drives the REAL handler against a mocked source layer + the REAL operator cache to pin
 * the caching CONTRACT specific to plans:items: a repeat cross-plan query HITS (listPlanIndexRows
 * runs once); a plan-table write busts it (tag invalidation); different args / workspaces
 * never share an entry (no cross-key / cross-workspace leak); the CACHE_LAYER kill-switch
 * disables caching. (Generic SWR/key semantics are pinned in cache/cached-read.test.ts.)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";
import { FLAGS } from "@papercusp/flags";

const M = vi.hoisted(() => ({
  planHarnessesForSlugs: vi.fn(async () => new Map<string, string[]>()),
  listPlanIndexRows: vi.fn(async () => [] as unknown[]),
  getPlanSlugsWithSpecTriadDeclaration: vi.fn(async () => new Set<string>()),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  getPlanRow: vi.fn(async () => null as unknown),
  planItemsForRow: vi.fn(() => [] as unknown[]),
  getAllPlanItemCoverage: vi.fn(async () => new Map()),
  ctxToPlanSourceOpts: vi.fn(async (ctx: { harnessSlug?: string }) => ({
    harnessSlug: ctx.harnessSlug ?? "papercup",
  })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    planHarnessesForSlugs: M.planHarnessesForSlugs,
    listPlanIndexRows: M.listPlanIndexRows,
    getPlanSlugsWithSpecTriadDeclaration: M.getPlanSlugsWithSpecTriadDeclaration,
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
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";
const CACHE_L2 = "papercusp-cache-l2";

const ctx = (workspaceId: string, harnessSlug = "papercup"): never =>
  ({
    workspaceId,
    harnessSlug,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (
  args: Record<string, unknown>,
  workspaceId = "ws-items",
  harnessSlug = "papercup",
): Promise<unknown> => {
  return tool.handler(args as never, ctx(workspaceId, harnessSlug));
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.listPlanIndexRows.mockClear();
  M.getPlanSlugsWithSpecTriadDeclaration.mockReset();
  M.getPlanSlugsWithSpecTriadDeclaration.mockResolvedValue(new Set());
  M.getPlanContentsBySlugs.mockClear();
  M.getPlanRow.mockReset();
  M.getPlanRow.mockResolvedValue(null);
  M.planHarnessesForSlugs.mockReset();
  M.planHarnessesForSlugs.mockResolvedValue(new Map());
  M.ctxToPlanSourceOpts.mockClear();
  M.getAllPlanItemCoverage.mockReset();
  M.getAllPlanItemCoverage.mockResolvedValue(new Map());
  // This suite pins the L1 invalidation/key contract. Keep the now-production
  // L2 leg off so durable entries from another test/process cannot satisfy a
  // read before the mocked source is exercised.
  setFlagOverridesForTest({ [CACHE_LAYER]: true, [CACHE_L2]: false });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:items — cache wiring", () => {
  it("recovers a missing harness from an exact slug before reading its items", async () => {
    M.planHarnessesForSlugs.mockResolvedValueOnce(
      new Map([["alpha", ["recovered-harness"]]]),
    );

    await run({ slug: "alpha" }, "ws-items", "*");

    expect(M.planHarnessesForSlugs).toHaveBeenCalledWith("ws-items", ["alpha"]);
    expect(M.ctxToPlanSourceOpts).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: "recovered-harness" }),
    );
    expect(M.getPlanRow).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ harnessSlug: "recovered-harness" }),
    );
  });

  it("discloses an ambient-harness mismatch for an exact slug instead of a bare not_found", async () => {
    M.planHarnessesForSlugs.mockResolvedValueOnce(
      new Map([["foreign-plan", ["papercusp"]]]),
    );

    const result = (await run({ slug: "foreign-plan" }, "ws-items", "sb-devboard-hive")) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: "not_found",
      slug: "foreign-plan",
      harness: "sb-devboard-hive",
      harnessMismatch: {
        callerHarness: "sb-devboard-hive",
        reportedHarness: "papercusp",
        availableHarnesses: ["papercusp"],
        harnessSource: "ambient",
      },
    });
    expect((body.harnessMismatch as { warning: string }).warning).toContain(
      "Pass harness:'papercusp'",
    );
    expect(M.getPlanRow).not.toHaveBeenCalled();
  });

  it("explains an explicit-harness miss without adding a lookup to hits", async () => {
    M.getPlanRow.mockResolvedValueOnce(null);
    M.planHarnessesForSlugs.mockResolvedValueOnce(
      new Map([["foreign-plan", ["papercusp"]]]),
    );

    const result = (await run(
      { slug: "foreign-plan", harness: "sb-devboard-hive" },
      "ws-items",
      "sb-devboard-hive",
    )) as { isError?: boolean; content: Array<{ text: string }> };
    const body = JSON.parse(result.content[0].text) as Record<string, unknown>;

    expect(result.isError).toBe(true);
    expect(body).toMatchObject({
      error: "not_found",
      slug: "foreign-plan",
      harness: "sb-devboard-hive",
      harnessMismatch: {
        callerHarness: "sb-devboard-hive",
        reportedHarness: "papercusp",
        availableHarnesses: ["papercusp"],
        harnessSource: "explicit",
      },
    });
    expect((body.harnessMismatch as { warning: string }).warning).toContain(
      "omit harness to auto-resolve",
    );
    expect(M.getPlanRow).toHaveBeenCalledTimes(1);
  });

  it("a repeat cross-plan query HITS (listPlanIndexRows runs once)", async () => {
    await run({ actionable: true });
    await run({ actionable: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
  });

  it("a harness_plans write BUSTS the entry (tag invalidation rebuilds)", async () => {
    await run({ actionable: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
    getOperatorCache().invalidateByTags("ws-items", ["harness_plans"]);
    await run({ actionable: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("a plan_revisions write also busts (every tagged table invalidates)", async () => {
    await run({ actionable: true });
    getOperatorCache().invalidateByTags("ws-items", ["plan_revisions"]);
    await run({ actionable: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("different filters do NOT share an entry (no cross-arg leak)", async () => {
    await run({ actionable: true });
    await run({ needsHuman: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
    // each independently cached on repeat
    await run({ actionable: true });
    await run({ needsHuman: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry (no cross-workspace leak)", async () => {
    await run({ actionable: true }, "ws-A");
    await run({ actionable: true }, "ws-B");
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
    getOperatorCache().invalidateByTags("ws-A", ["harness_plans"]);
    await run({ actionable: true }, "ws-A");
    await run({ actionable: true }, "ws-B");
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(3);
  });

  it("CACHE_LAYER OFF ⇒ bypass: listPlanIndexRows runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({ actionable: true });
    await run({ actionable: true });
    await run({ actionable: true });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(3);
  });

  it("refreshes coverage on a plan-cache hit instead of replaying stale liveness", async () => {
    const planItem = {
      id: "P-001",
      text: "live coverage",
      storedStatus: "todo",
      importance: "normal",
      blockedBy: [],
      decisionRefs: [],
      phase: "Phase 1",
      lineNumber: 0,
      rawLine: "",
      effectiveStatus: "todo",
      unresolvedBlockers: [],
      needsHuman: false,
      staleBlockedHint: null,
    };
    M.listPlanIndexRows.mockResolvedValue([{
      planSlug: "coverage-plan",
      archived: false,
      isLegacy: false,
      status: "active",
      content: "",
      created: "2026-08-01T00:00:00.000Z",
    }]);
    M.planItemsForRow.mockReturnValue([planItem]);
    const coverage = (level: "held-not-live" | "full") => new Map([
      ["coverage-plan#P-001", {
        ref: "coverage-plan#P-001",
        links: [],
        directlyClaimed: false,
        directHolder: null,
        directActivity: null,
        holder: null,
        level,
        workers: [],
        lastActivityAt: null,
      }],
    ]);
    M.getAllPlanItemCoverage.mockResolvedValueOnce(coverage("held-not-live"));
    const first = await run({}) as { data: { items: Array<{ coverage?: { level: string } }> } };
    expect(first.data.items[0]?.coverage?.level).toBe("held-not-live");

    M.getAllPlanItemCoverage.mockResolvedValueOnce(coverage("full"));
    const second = await run({}) as { data: { items: Array<{ coverage?: { level: string } }> } };
    expect(second.data.items[0]?.coverage?.level).toBe("full");
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
    expect(M.getAllPlanItemCoverage).toHaveBeenCalledTimes(2);
    expect(M.getAllPlanItemCoverage).toHaveBeenLastCalledWith({
      planItemRefs: ["coverage-plan#P-001"],
    });
  });

  it("skips the live coverage overlay for the UI display feed that projects it away", async () => {
    M.listPlanIndexRows.mockResolvedValue([{
      planSlug: "ui-plan",
      archived: false,
      isLegacy: false,
      status: "active",
      content: "",
      created: "2026-08-01T00:00:00.000Z",
    }]);
    M.planItemsForRow.mockReturnValue([{
      id: "P-001",
      text: "display row",
      storedStatus: "todo",
      importance: "normal",
      blockedBy: [],
      decisionRefs: [],
      phase: "Phase 1",
      lineNumber: 0,
      rawLine: "",
      effectiveStatus: "todo",
      unresolvedBlockers: [],
      needsHuman: false,
      staleBlockedHint: null,
    }]);

    const result = await tool.handler(
      { actionable: true } as never,
      {
        workspaceId: "ws-ui",
        harnessSlug: "papercup",
        uiClientId: "pc-admin-plans-ui",
        metadata: vi.fn(),
        log: vi.fn(),
        progress: vi.fn(),
      } as never,
    ) as { data: { items: unknown[] } };

    expect(result.data.items).toHaveLength(1);
    expect(M.getAllPlanItemCoverage).not.toHaveBeenCalled();
  });

  it("hides a todo item linked to a blocked work-item from actionable results", async () => {
    const planItem = {
      id: "P-001",
      text: "blocked linked work-item",
      storedStatus: "todo",
      importance: "normal",
      blockedBy: [],
      decisionRefs: [],
      phase: "Phase 1",
      lineNumber: 0,
      rawLine: "",
      effectiveStatus: "todo",
      unresolvedBlockers: [],
      needsHuman: false,
      staleBlockedHint: null,
    };
    M.listPlanIndexRows.mockResolvedValue([{
      planSlug: "blocked-linked-plan",
      archived: false,
      isLegacy: false,
      status: "active",
      content: "",
      created: "2026-08-01T00:00:00.000Z",
    }]);
    M.planItemsForRow.mockReturnValue([planItem]);
    M.getAllPlanItemCoverage.mockResolvedValue(new Map([
      ["blocked-linked-plan#P-001", {
        ref: "blocked-linked-plan#P-001",
        links: [{
          workItemId: "WI-BLOCKED",
          rel: "relates",
          terminal: false,
          blocked: true,
          activity: "free",
          holder: null,
        }],
        directlyClaimed: false,
        directHolder: null,
        directActivity: null,
        holder: null,
        level: "unclaimed",
        workers: [],
        lastActivityAt: null,
      }],
    ]));

    const actionable = await run({ actionable: true }) as { data: { items: unknown[] } };
    expect(actionable.data.items).toEqual([]);

    const all = await run({}) as {
      data: { items: Array<{ coverage?: { links?: Array<{ blocked?: boolean }> } }> };
    };
    expect(all.data.items[0]?.coverage?.links?.[0]?.blocked).toBe(true);
  });

  it("surfaces a gated plan diagnostic when actionable filtering removes every row", async () => {
    setFlagOverridesForTest({
      [CACHE_LAYER]: true,
      [CACHE_L2]: false,
      [FLAGS.SPEC_TRIAD_REQUIRED]: true,
    });
    await _refreshCacheLayerForTests();

    const planItem = {
      id: "P-001",
      text: "triad-gated item",
      storedStatus: "todo",
      importance: "normal",
      blockedBy: [],
      decisionRefs: [],
      phase: "Phase 1",
      lineNumber: 0,
      rawLine: "",
      effectiveStatus: "todo",
      unresolvedBlockers: [],
      needsHuman: false,
      staleBlockedHint: null,
    };
    M.listPlanIndexRows.mockResolvedValue([{
      planSlug: "triad-gated-plan",
      archived: false,
      isLegacy: false,
      status: "active",
      content: "",
      created: "2026-08-10T00:00:00.000Z",
    }]);
    M.getPlanContentsBySlugs.mockResolvedValue(new Map([
      ["triad-gated-plan", "---\nslug: triad-gated-plan\n---\n"],
    ]));
    M.planItemsForRow.mockReturnValue([planItem]);

    const actionable = await run({ actionable: true }) as {
      data: {
        items: unknown[];
        specTriadDiagnostics: Array<{
          plan: string;
          missing: string[];
          scopeReason: string;
          note: string;
        }>;
      };
    };
    expect(actionable.data.items).toEqual([]);
    expect(actionable.data.specTriadDiagnostics).toEqual([
      expect.objectContaining({
        plan: "triad-gated-plan",
        missing: ["requirements", "design"],
        scopeReason: "created-after-epoch",
        note: expect.stringContaining("triad-gated-plan"),
      }),
    ]);

    const all = await run({}) as {
      data: {
        items: Array<{ specTriadMissing?: string[] }>;
        specTriadDiagnostics: unknown[];
      };
    };
    expect(all.data.items[0]?.specTriadMissing).toEqual(["requirements", "design"]);
    expect(all.data.specTriadDiagnostics).toHaveLength(1);
  });

  it("keeps rubric templates actionable and outside the spec-triad gate", async () => {
    setFlagOverridesForTest({
      [CACHE_LAYER]: true,
      [CACHE_L2]: false,
      [FLAGS.SPEC_TRIAD_REQUIRED]: true,
    });
    await _refreshCacheLayerForTests();

    const planSlug = "acceptance-rubric-plan";
    const planItem = {
      id: "P-001",
      text: "rubric item",
      storedStatus: "todo",
      importance: "normal",
      blockedBy: [],
      decisionRefs: [],
      phase: "Phase 1",
      lineNumber: 0,
      rawLine: "",
      effectiveStatus: "todo",
      unresolvedBlockers: [],
      needsHuman: false,
      staleBlockedHint: null,
    };
    M.listPlanIndexRows.mockResolvedValue([{
      planSlug,
      archived: false,
      isLegacy: false,
      status: "active",
      items: [planItem],
      content: "",
      created: "2026-10-01T00:00:00.000Z",
      template: "rubric",
    }]);
    M.getPlanContentsBySlugs.mockResolvedValue(new Map([
      [planSlug, `---\nslug: ${planSlug}\n---\n`],
    ]));
    M.planItemsForRow.mockReturnValue([planItem]);

    const actionable = await run({ actionable: true }) as {
      data: { items: unknown[]; specTriadDiagnostics: unknown[] };
    };
    expect(actionable.data.items).toHaveLength(1);
    expect(actionable.data.specTriadDiagnostics ?? []).toEqual([]);
    expect(M.getPlanContentsBySlugs).not.toHaveBeenCalled();
  });
});
