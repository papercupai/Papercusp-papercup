/**
 * plans:list cache integration (cache-expensive-tool-reads-2026-06-22 P-002).
 *
 * Drives the REAL handler against a mocked source layer + the REAL operator cache
 * to pin the caching CONTRACT specific to plans:list: a repeat call hits (the source
 * fetch runs once); a plan-table write busts it (tag invalidation); different args /
 * workspaces never share an entry (no cross-arg / cross-workspace leak); the
 * CACHE_LAYER kill-switch disables caching. (The generic SWR/key semantics are pinned
 * in cache/cached-read.test.ts; this file proves the wiring — right tags, right key.)
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => ({
  activeWorkspace: "ws-active",
  l2Get: vi.fn(async () => undefined),
  l2Set: vi.fn(async () => {}),
  listPlanIndexRows: vi.fn(async () => [] as unknown[]),
  listPlanIndexRowsForWorkspace: vi.fn(async () => [] as unknown[]),
  getPlanContentsBySlugs: vi.fn(async () => new Map<string, string>()),
  resolveHarnessPlansDir: vi.fn(async (slug: string) => ({
    harnessSlug: slug,
  })),
  ctxToPlanSourceOpts: vi.fn(async () => ({ harnessSlug: "papercup" })),
}));

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    listPlanIndexRows: M.listPlanIndexRows,
    listPlanIndexRowsForWorkspace: M.listPlanIndexRowsForWorkspace,
    getPlanContentsBySlugs: M.getPlanContentsBySlugs,
    resolveHarnessPlansDir: M.resolveHarnessPlansDir,
  };
});
vi.mock("./_ctx-opts", () => ({ ctxToPlanSourceOpts: M.ctxToPlanSourceOpts }));
vi.mock("../../workspace-registry", async (orig) => ({
  ...await orig<typeof import("../../workspace-registry")>(),
  activeWorkspaceId: () => M.activeWorkspace,
}));
vi.mock("../../issue-blocks-merge", async (orig) => {
  const actual = await orig<typeof import("../../issue-blocks-merge")>();
  return {
    ...actual,
    getAllBlockedPlanItems: vi.fn(async () => new Map<string, string[]>()),
  };
});
vi.mock("../../scout/routed-ledger", () => ({
  readScoutPlanRefs: vi.fn(async () => new Set<string>()),
  readRoutedIdeas: vi.fn(async () => []),
}));

import tool from "./list";
import {
  getOperatorCache,
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";
import { installL2StoreForTests, setL2EnabledForTests, __resetL2StateForTests } from "../../cache/l2-tier";
import type { PgL2Store } from "../../cache/pg-l2-store";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (workspaceId: string): never =>
  ({
    workspaceId,
    harnessSlug: "papercup",
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (
  args: Record<string, unknown>,
  workspaceId = "ws-list",
): Promise<unknown[]> => {
  // The handler returns a {data} envelope (context-trimming-tiers P-021) —
  // serialization to content[] happens in defineTool dispatch, not here.
  const res = (await tool.handler(args as never, ctx(workspaceId))) as {
    data: { plans: unknown[] };
  };
  return res.data.plans;
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.listPlanIndexRows.mockClear();
  M.listPlanIndexRowsForWorkspace.mockClear();
  M.activeWorkspace = "ws-active";
  M.l2Get.mockClear();
  M.l2Set.mockClear();
  // This suite tests the real L1 wiring with a durable-tier miss. The
  // separate private PG workflow verifies L2; no unit case opens real PG.
  installL2StoreForTests({ get: M.l2Get, set: M.l2Set,
    invalidateByTags: async () => 0 } as unknown as PgL2Store);
  setL2EnabledForTests(true);
  setFlagOverridesForTest({ [CACHE_LAYER]: true });
  await _refreshCacheLayerForTests();
});

afterEach(async () => {
  __resetL2StateForTests();
  __setCachedReadEnabledForTests(false);
  setFlagOverridesForTest(null);
  await _refreshCacheLayerForTests();
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
});

describe("plans:list — cache wiring", () => {
  it("a repeat call with the same args HITS (the source fetch runs once)", async () => {
    await run({});
    await run({});
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
    expect(M.l2Get).toHaveBeenCalledWith("ws-list", expect.any(String));
  });

  it("a plan-table write BUSTS the entry (tags=harness_plans → ECA bump rebuilds)", async () => {
    await run({});
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(1);
    // Simulate the cache-ECA reacting to a harness_plans.changed event.
    getOperatorCache().invalidateByTags("ws-list", ["harness_plans"]);
    await run({});
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("a plan_revisions write also busts (every tagged table invalidates)", async () => {
    await run({});
    getOperatorCache().invalidateByTags("ws-list", ["plan_revisions"]);
    await run({});
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it.each(["*", "ws-admitted"])(
    "workspace-wide context %s caches in the concrete workspace its rows use",
    async (workspaceId) => {
      const viewedWorkspace = workspaceId === "*" ? M.activeWorkspace : workspaceId;
      await run({ workspaceWide: true }, workspaceId);
      expect(M.listPlanIndexRowsForWorkspace).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: viewedWorkspace }),
      );
      getOperatorCache().invalidateByTags(viewedWorkspace, ["harness_plans"]);
      await run({ workspaceWide: true }, workspaceId);
      expect(M.listPlanIndexRowsForWorkspace).toHaveBeenCalledTimes(2);
    },
  );

  it("passes the admitted workspace to each harness source read", async () => {
    await run({}, "ws-admitted");
    expect(M.listPlanIndexRows).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "ws-admitted", harnessSlug: "papercup" }),
    );
  });

  it("different args do NOT share an entry (no cross-arg leak)", async () => {
    await run({ status: "active" });
    await run({ status: "ready" });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
    // ...and each of those is independently cached on repeat.
    await run({ status: "active" });
    await run({ status: "ready" });
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
  });

  it("different workspaces do NOT share an entry (no cross-workspace leak)", async () => {
    await run({}, "ws-A");
    await run({}, "ws-B");
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(2);
    // a bump in ws-A leaves ws-B's entry warm
    getOperatorCache().invalidateByTags("ws-A", ["harness_plans"]);
    await run({}, "ws-A");
    await run({}, "ws-B");
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(3);
  });

  it("CACHE_LAYER OFF ⇒ bypass: the source fetch runs on every call", async () => {
    setFlagOverridesForTest({ [CACHE_LAYER]: false });
    await _refreshCacheLayerForTests();
    await run({});
    await run({});
    await run({});
    expect(M.listPlanIndexRows).toHaveBeenCalledTimes(3);
  });
});
