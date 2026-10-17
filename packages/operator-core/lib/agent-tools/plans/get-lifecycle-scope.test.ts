/**
 * plans:get — the read-time lifecycle overlay is scoped to the PLAN ROW's workspace
 * (EI-22103498805895390).
 *
 * WHY THIS EXISTS. `derivePlanLifecycleForRead` gathers its signals by `workspace_id`:
 * the acceptance-rubric signal is a lookup of ACTIVE rubric plans filtered by that id.
 * get.ts used to pass the legacy `DEFAULT_WORKSPACE_ID` constant there, so a plan under
 * any other workspace read `lifecycle.acceptance.rubricActive:false` while
 * `acceptanceRubric` — resolved from the SAME row a few lines later — was populated.
 * That is a false-negative "no rubric" verdict on the exact surface an agent reads to
 * decide whether a plan is shippable, and it was reported as a fact (measured on
 * papercup-chat-public-release-2026-09-01, whose rubric was active under
 * 'papercusp-workspace' the whole time).
 *
 * WHAT THIS PINS: the signal lookup receives `row.workspaceId` — the workspace the plan
 * row was actually read under — and falls back to the constant ONLY when the row carries
 * none. Reverting the call site to the bare constant fails the first case; dropping the
 * fallback fails the second.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setFlagOverridesForTest } from "@papercusp/flags/test";

const M = vi.hoisted(() => {
  const planFixture = (slug: string, workspaceId: string | null = "ws-lifecycle-scope") => ({
    parsed: {
      isLegacy: false,
      slug,
      prose: "## Now\nbody\n",
      raw: `slug: ${slug}\n`,
      frontmatter: { slug },
      now: { state: "s", next: "n" },
      decisions: [],
      items: [],
    },
    archived: false,
    row: {
      workspaceId,
      planSlug: slug,
      harnessSlug: "papercup",
      version: 1,
      promotePolicy: null,
      forcedPast: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  type PlanRead = ReturnType<typeof planFixture> | null;
  return {
    planFixture,
    planHarnessesForSlugs: vi.fn(async () => new Map<string, string[]>()),
    readPlanBySlug: vi.fn(async (slug: string): Promise<PlanRead> => planFixture(slug)),
    ctxToPlanSourceOpts: vi.fn(async (ctx: { harnessSlug?: string }) => ({
      harnessSlug: ctx.harnessSlug ?? "papercup",
    })),
    resolveCtxHarnessSlug: vi.fn(() => "papercup"),
    resolveEffectiveHarnessSlug: vi.fn(() => "papercup"),
    getAcceptanceRubricForPlan: vi.fn(async () => null),
    getLatestPlanAudit: vi.fn(async () => null),
    derivePlanLifecycleForRead: vi.fn(async () => null),
    overlayIssueBlocksForPlan: vi.fn(async (_slug: string, items: unknown[]) => ({ items, blockingIssues: {} })),
    withWorkspace: vi.fn(async (_workspace: string, _read: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      throw new Error("no-db-in-unit-test");
    }),
  };
});

vi.mock("./source", async (orig) => {
  const actual = await orig<typeof import("./source")>();
  return {
    ...actual,
    planHarnessesForSlugs: M.planHarnessesForSlugs,
    readPlanBySlug: M.readPlanBySlug,
  };
});
vi.mock("./_ctx-opts", () => ({
  ctxToPlanSourceOpts: M.ctxToPlanSourceOpts,
  resolveCtxHarnessSlug: M.resolveCtxHarnessSlug,
  resolveEffectiveHarnessSlug: M.resolveEffectiveHarnessSlug,
}));
vi.mock("../../issue-blocks-merge", async (orig) => {
  const actual = await orig<typeof import("../../issue-blocks-merge")>();
  return {
    ...actual,
    overlayIssueBlocksForPlan: M.overlayIssueBlocksForPlan,
  };
});
vi.mock("@papercusp/db-org", async (orig) => {
  const actual = await orig<typeof import("@papercusp/db-org")>();
  return {
    ...actual,
    withWorkspace: M.withWorkspace,
  };
});
vi.mock("../../rubrics", () => ({
  getAcceptanceRubricForPlan: M.getAcceptanceRubricForPlan,
}));
vi.mock("../../plan-audits", () => ({
  getLatestPlanAudit: M.getLatestPlanAudit,
}));
vi.mock("./plan-lifecycle-derivation", async (orig) => ({
  ...await orig<typeof import("./plan-lifecycle-derivation")>(),
  derivePlanLifecycleForRead: M.derivePlanLifecycleForRead,
}));

import tool from "./get";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-registry";
import {
  resetOperatorCacheForTests,
  resetCachedReadStatsForTests,
  __setCachedReadEnabledForTests,
} from "../../cache";
import { _refreshCacheLayerForTests } from "../../cache/instance";

const CACHE_LAYER = "papercusp-cache-layer";

const ctx = (workspaceId = "ws-lifecycle-scope", harnessSlug = "papercup"): never =>
  ({
    workspaceId,
    harnessSlug,
    metadata: vi.fn(),
    log: vi.fn(),
    progress: vi.fn(),
  }) as never;

const run = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, ctx())) as {
    data: { results: Array<Record<string, unknown>> };
  }).data;

const signalsOfLastCall = () => {
  const calls = M.derivePlanLifecycleForRead.mock.calls as unknown as Array<
    [{ signals: { workspaceId: string; planSlug: string } }]
  >;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].signals;
};

beforeEach(async () => {
  resetOperatorCacheForTests();
  resetCachedReadStatsForTests();
  __setCachedReadEnabledForTests(true);
  M.readPlanBySlug.mockClear();
  M.derivePlanLifecycleForRead.mockClear();
  M.getAcceptanceRubricForPlan.mockClear();
  M.getLatestPlanAudit.mockClear();
  M.planHarnessesForSlugs.mockReset();
  M.planHarnessesForSlugs.mockResolvedValue(new Map());
  M.overlayIssueBlocksForPlan.mockReset();
  M.overlayIssueBlocksForPlan.mockImplementation(async (_slug, items) => ({ items, blockingIssues: {} }));
  M.withWorkspace.mockReset();
  M.withWorkspace.mockRejectedValue(new Error("no-db-in-unit-test"));
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

describe("plans:get — lifecycle signals are scoped to the plan row's workspace", () => {
  it("returns fast-body reads while lifecycle is stalled and still derives enriched follow-ups", async () => {
    let release!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => { release = resolve; });
    M.derivePlanLifecycleForRead.mockImplementationOnce(async () => {
      await lifecycleGate;
      return null;
    });
    let body: Record<string, unknown> | undefined;
    const fastRead = run({
      slug: "stalled-lifecycle", mode: "full", includeHistory: false, includeEnrichments: false,
    }).then((value) => {
      body = value.results[0];
      return value;
    });
    try {
      await vi.waitFor(() => expect(body).toMatchObject({
        slug: "stalled-lifecycle", enrichmentsDeferred: true,
      }), { timeout: 1000 });
      expect(M.derivePlanLifecycleForRead).not.toHaveBeenCalled();
      expect(body?.lifecycle).toBeUndefined();

      let enrichedSettled = false;
      const enrichedRead = run({
        slug: "stalled-lifecycle", mode: "full", includeHistory: false,
      }).then((value) => {
        enrichedSettled = true;
        return value;
      });
      await vi.waitFor(() => expect(M.derivePlanLifecycleForRead).toHaveBeenCalledOnce());
      expect(enrichedSettled).toBe(false);
      release();
      const enriched = (await enrichedRead).results[0];
      expect(enriched.enrichmentsDeferred).toBeUndefined();
      expect(M.readPlanBySlug).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await fastRead;
    }
  });

  it.each([
    { mode: "meta" },
    { heading: "Now" },
    { decisions: ["D-001"] },
  ])("skips unused rubric and audit reads for narrow request %j", async (request) => {
    await run({ slug: "narrow", includeHistory: false, ...request });
    expect(M.getAcceptanceRubricForPlan).not.toHaveBeenCalled();
    expect(M.getLatestPlanAudit).not.toHaveBeenCalled();
  });

  it('passes item selectors to per-item lifecycle enrichment without narrowing the plan census', async () => {
    const fixture = M.planFixture("narrow-selection") as any;
    fixture.parsed.items = [
      { id: "P-001", text: "selected", storedStatus: "todo", importance: "normal", blockedBy: [], decisionRefs: [], phase: null },
      { id: "P-002", text: "unselected", storedStatus: "done", importance: "normal", blockedBy: [], decisionRefs: [], phase: null },
    ];
    M.readPlanBySlug.mockImplementationOnce(async () => fixture);
    const result = await run({ slug: "narrow-selection", items: ["P-001"] });
    const calls = M.derivePlanLifecycleForRead.mock.calls as unknown as Array<[
      { items: Array<{ id: string }>; enrichmentItemIds?: readonly string[] }
    ]>;
    expect(calls.at(-1)?.[0]).toMatchObject({ enrichmentItemIds: ["P-001"] });
    expect(calls.at(-1)?.[0].items.map((item) => item.id)).toEqual(["P-001", "P-002"]);
    expect(result.results[0]).toMatchObject({
      counts: { items: 2 },
      itemSelection: { requested: ["P-001"], matched: ["P-001"], missing: [] },
      items: [{ id: "P-001" }],
    });
  });

  it("starts independent reads while issue blocks are pending and joins their results before lifecycle", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    M.overlayIssueBlocksForPlan.mockImplementationOnce(async (_slug, items) => {
      started.push("issues");
      await gate;
      return { items, blockingIssues: { "P-001": ["EI-1"] } };
    });
    M.getAcceptanceRubricForPlan.mockImplementationOnce(async () => {
      started.push("rubric");
      await gate;
      return null;
    });
    M.getLatestPlanAudit.mockImplementationOnce(async () => {
      started.push("audit");
      await gate;
      return null;
    });
    M.withWorkspace.mockImplementation(async (_workspace, read) => read(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("harness_features_consolidated")) {
        started.push("features");
        await gate;
        return [{ feature_id: "WI-1", status: "wip", source_plan_slug: "overlap",
          source_plan_item_ids: ["P-001"], harness_slug: "papercup", updated_ts: "2026-09-24T12:00:00Z" }];
      }
      // No harness_plan_assertions branch: the coverage read is retired with inline
      // VAL-* (verification-system-improvements-2026-10-10 P-003), so it must throw.
      throw new Error(`Unexpected query: ${sql}`);
    }));
    const pending = run({ slug: "overlap", includeHistory: false });
    try {
      // Every independent read must start before issue blocks are released.
      await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining([
        "issues", "features", "rubric", "audit",
      ])));
      expect(started).not.toContain("coverage");
      expect(M.derivePlanLifecycleForRead).not.toHaveBeenCalled();
    } finally {
      release();
    }
    const result = (await pending).results[0];
    expect(result).toMatchObject({ slug: "overlap", blockingIssues: { "P-001": ["EI-1"] },
      linkedFeatures: { "P-001": { featureId: "WI-1", status: "wip", harnessSlug: "papercup" } } });
    expect(result).not.toHaveProperty("planItemTests");
    expect(signalsOfLastCall()).toMatchObject({ linkedWorkItemUpdatedAt: "2026-09-24T12:00:00.000Z" });
  });

  it("retains the plan and issue blocks when parallel badge reads fail", async () => {
    M.overlayIssueBlocksForPlan.mockImplementationOnce(async (_slug, items) => ({
      items, blockingIssues: { "P-001": ["EI-1"] },
    }));
    const result = await run({ slug: "failed-badges", includeHistory: false });
    expect(result.results[0]).toMatchObject({ slug: "failed-badges", blockingIssues: { "P-001": ["EI-1"] },
      linkedFeatures: {} });
    expect(signalsOfLastCall()).toMatchObject({ linkedWorkItemUpdatedAt: null });
  });

  it.each(["acceptance-alpha", null])("reuses the source snapshot's measured acceptance ref %s", async (ref) => {
    M.readPlanBySlug.mockImplementationOnce(async (slug: string) => {
      const fixture = M.planFixture(slug);
      return { ...fixture, row: { ...fixture.row, activeAcceptanceRubricRef: ref } };
    });
    await run({ slug: "alpha" });
    expect(M.readPlanBySlug).toHaveBeenCalledWith("alpha",
      expect.objectContaining({ prefetchAcceptance: true }), expect.any(Object));
    expect(signalsOfLastCall()).toMatchObject({ acceptanceRubricRef: ref });
  });

  it("passes row.workspaceId to the signal lookup, NOT the legacy default constant", async () => {
    // Guard the guard: the fixture workspace must differ from the constant, or the
    // assertion below could not tell the fix from the regression.
    expect("ws-lifecycle-scope").not.toBe(DEFAULT_WORKSPACE_ID);

    await run({ slug: "alpha" });

    const signals = signalsOfLastCall();
    expect(signals.planSlug).toBe("alpha");
    expect(signals.workspaceId).toBe("ws-lifecycle-scope");
    expect(signals.workspaceId).not.toBe(DEFAULT_WORKSPACE_ID);
  });

  it("falls back to DEFAULT_WORKSPACE_ID only when the row carries no workspace", async () => {
    M.readPlanBySlug.mockImplementationOnce(async (slug: string) =>
      M.planFixture(slug, null),
    );

    await run({ slug: "beta" });

    const signals = signalsOfLastCall();
    expect(signals.planSlug).toBe("beta");
    expect(signals.workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  // scope-unique-identifiers-2026-07-26 P-003. The badge (linkedFeatures) and coverage
  // (planItemTests) reads were pinned to DEFAULT_WORKSPACE_ID, so outside workspace
  // 'default' they always came back empty. They now read the plan row's workspace, and
  // every item carries the work-item id it resolves through.
  const linkedRow = (featureId: string, status: string, itemId: string) => ({
    feature_id: featureId, status, source_plan_slug: "linked", source_plan_item_ids: [itemId],
    harness_slug: "papercup", updated_ts: "2026-10-01T00:00:00Z",
  });
  const recordEnrichmentScopes = () => {
    const scopes: Array<{ workspace: string; table: string }> = [];
    M.withWorkspace.mockImplementation(async (workspace, read) => read(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("harness_features_consolidated")) {
        scopes.push({ workspace, table: "features" });
        return [
          linkedRow("WI-11", "wip", "P-001"), // one live link
          linkedRow("WI-21", "done", "P-002"), // terminal + live: the live one resolves
          linkedRow("WI-22", "open", "P-002"),
          linkedRow("WI-31", "wip", "P-003"), // two live links: ambiguous, report both
          linkedRow("WI-32", "open", "P-003"),
        ];
      }
      if (sql.includes("harness_plan_assertions")) {
        scopes.push({ workspace, table: "assertions" });
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    }));
    return scopes;
  };
  const planItems = ["P-001", "P-002", "P-003", "P-004"].map((id) => ({ id, text: id, status: "todo" }));

  it("P-003: badge and coverage reads use the plan row's workspace; each item carries its linked workItemId", async () => {
    expect("ws-lifecycle-scope").not.toBe(DEFAULT_WORKSPACE_ID);
    M.overlayIssueBlocksForPlan.mockImplementationOnce(async () => ({ items: planItems, blockingIssues: {} }));
    const scopes = recordEnrichmentScopes();

    const result = (await run({ slug: "linked", includeHistory: false })).results[0] as {
      items: Array<Record<string, unknown>>;
      linkedFeatures: Record<string, { featureId: string }>;
    };

    // The coverage (harness_plan_assertions) read is retired with inline VAL-*
    // (verification-system-improvements-2026-10-10 P-003): only the badge read remains.
    expect(scopes.map((s) => s.table)).toEqual(["features"]);
    expect(scopes.every((s) => s.workspace === "ws-lifecycle-scope")).toBe(true);

    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get("P-001")).toMatchObject({ workItemId: "WI-11" });
    expect(byId.get("P-001")).not.toHaveProperty("workItemIds");
    expect(byId.get("P-002")).toMatchObject({ workItemId: "WI-22", workItemIds: ["WI-22", "WI-21"] });
    expect(byId.get("P-003")).toMatchObject({ workItemId: null, workItemIds: ["WI-31", "WI-32"] });
    expect(byId.get("P-004")).toMatchObject({ workItemId: null });
    expect(byId.get("P-004")).not.toHaveProperty("workItemIds");

    // The badge shows the resolvable work-item; an ambiguous item keeps the first row seen.
    expect(result.linkedFeatures["P-001"]?.featureId).toBe("WI-11");
    expect(result.linkedFeatures["P-002"]?.featureId).toBe("WI-22");
    expect(result.linkedFeatures["P-003"]?.featureId).toBe("WI-31");
  });

  it("P-003: enrichment reads fall back to DEFAULT_WORKSPACE_ID only when the row carries no workspace", async () => {
    M.readPlanBySlug.mockImplementationOnce(async (slug: string) => M.planFixture(slug, null));
    M.overlayIssueBlocksForPlan.mockImplementationOnce(async () => ({ items: planItems, blockingIssues: {} }));
    const scopes = recordEnrichmentScopes();

    await run({ slug: "linked-default", includeHistory: false });

    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((s) => s.workspace === DEFAULT_WORKSPACE_ID)).toBe(true);
  });

  it("a failed signal derivation never fails the plan read (advisory overlay)", async () => {
    M.derivePlanLifecycleForRead.mockImplementationOnce(async () => {
      throw new Error("signal-lookup-down");
    });

    const result = await run({ slug: "gamma" });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ slug: "gamma" });
  });
});
