/**
 * planning-reads-shape.test.ts — payload-tier shapers for the planning reads
 * (context-trimming-tiers-2026-07-01 P-021: plans:list / plans:items /
 * plans:attention). Pure projections; the loud-cap contract (D-004) is the
 * thing under test: uniform TOON-tabular keys, visible truncation notices,
 * and full-tier bytes untouched (full = unshaped by construction).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/planning-reads-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { PLANS_LIST_TIER_CAPS, shapePlansList } from "./list-shape";
import { PLANS_ITEMS_TIER_CAPS, shapePlansItems } from "./items-shape";
import { ATTENTION_TIER_CAPS, shapePlansAttention } from "./attention-shape";

function listRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    slug: `plan-${String(i).padStart(3, "0")}`,
    title: `Plan ${i} — a reasonably descriptive title`,
    status: "active",
    updated: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    created: "2026-06-01",
    owner: "avi@example.com",
    initiative: null,
    template: null,
    archived: false,
    isLegacy: false,
    itemCounts: { todo: 3, wip: 1, blocked: 1, done: 9, dropped: 2 },
    nextAction: "Do the next thing, which is described at some length here.",
    harness: "papercusp",
    startStatus: "started",
    priority: null,
    maxImportance: "high",
    origin: null,
    scheduled: false,
    scheduleActive: false,
    scheduleKind: null,
    triggered: false,
    triggerSources: [],
    ...overrides,
  };
}

describe("shapePlansList (P-021)", () => {
  it("projects rows to uniform keys and flattens itemCounts to open/done", () => {
    const lifecycle = {
      verdict: "active",
      disposition: "contradicted",
      contradiction: {
        claim: "status: shipped",
        evidence: "one item is still live",
      },
    };
    const out = shapePlansList(
      { plans: [listRow(1, { derivedLifecycle: lifecycle })] },
      "trimmed",
    ) as {
      plans: Record<string, unknown>[];
    };
    expect(out.plans).toHaveLength(1);
    const r = out.plans[0];
    expect(r.open).toBe(5); // todo 3 + wip 1 + blocked 1
    expect(r.slug).toBe("plan-001");
    expect(r).not.toHaveProperty("itemCounts");
    expect(r).not.toHaveProperty("owner");
    expect(r.triggered).toBe(false);
    expect(r.lifecycleVerdict).toBe("active");
    expect(r.lifecycleDisposition).toBe("contradicted");
    expect(r.lifecycleContradiction).toBe("one item is still live");
    // standard keeps the wider field set + done count
    const std = shapePlansList(
      { plans: [listRow(1, { derivedLifecycle: lifecycle })] },
      "standard",
    ) as {
      plans: Record<string, unknown>[];
    };
    expect(std.plans[0].done).toBe(11); // done 9 + dropped 2
    expect(std.plans[0].owner).toBe("avi@example.com");
    expect(std.plans[0].triggerSources).toEqual([]);
    expect(std.plans[0].lifecycleDisposition).toBe("contradicted");
  });

  it("over-cap without an explicit order keeps the most-recently-updated rows + a notice row", () => {
    const cap = PLANS_LIST_TIER_CAPS.trimmed.rows;
    const plans = Array.from({ length: cap + 20 }, (_, i) =>
      listRow(i, { updated: `2026-0${(i % 5) + 1}-01T00:00:00.000Z` }),
    );
    const out = shapePlansList({ plans }, "trimmed", {}) as {
      plans: Record<string, unknown>[];
    };
    expect(out.plans).toHaveLength(cap + 1); // cap rows + notice
    const notice = out.plans.at(-1)!;
    expect(notice.slug).toBe("(truncated)");
    expect(notice.title).toContain(`of ${plans.length}`);
    expect(notice.title).toContain("tools:invoke { name:'plans:list'");
    // recency-kept: every kept row's updated >= the max dropped month bucket
    const keptUpdated = out.plans
      .slice(0, cap)
      .map((r) => String(r.updated ?? ""));
    expect([...keptUpdated].sort().reverse()).toEqual(keptUpdated);
    // uniform keys incl. the notice row (TOON tabular safety)
    const keys = Object.keys(out.plans[0]).sort();
    for (const row of out.plans)
      expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("an explicit order arg keeps the handler's head order", () => {
    const cap = PLANS_LIST_TIER_CAPS.trimmed.rows;
    const plans = Array.from({ length: cap + 5 }, (_, i) => listRow(i));
    const out = shapePlansList({ plans }, "trimmed", { order: "slug" }) as {
      plans: Record<string, unknown>[];
    };
    expect(out.plans[0].slug).toBe("plan-000");
    expect(String(out.plans.at(-1)!.title)).toContain("in requested order");
  });

  it("non-conforming data passes through untouched", () => {
    const weird = { error: "not_found" };
    expect(shapePlansList(weird, "trimmed")).toBe(weird);
  });
});

function itemRow(i: number, overrides: Record<string, unknown> = {}) {
  return {
    plan: `plan-${i}`,
    archived: false,
    item: {
      id: `P-${String(i).padStart(3, "0")}`,
      text: "Implement the thing with a fairly long description that goes on and on and exceeds the trimmed cap for sure because it keeps going well past one hundred and twenty characters in total length",
      storedStatus: "todo",
      importance: "high",
      blockedBy: ["P-001", "P-002"],
      decisionRefs: [],
      phase: "Phase 2 — The middle part",
      lineNumber: 12,
      rawLine: "- [ ] P-003 …",
      effectiveStatus: "blocked",
      unresolvedBlockers: ["P-001"],
      needsHuman: false,
    },
    blockedByIssues: ["EI-9"],
    coverage: { level: "partial", workers: ["su-abc"] },
    ...overrides,
  };
}

describe("shapePlansItems (P-021)", () => {
  it("flattens the nested item to scalar TOON-safe cells with a blocker count", () => {
    const out = shapePlansItems({ items: [itemRow(3)] }, "trimmed") as {
      items: Record<string, unknown>[];
    };
    const r = out.items[0];
    expect(r.id).toBe("P-003");
    expect(r.status).toBe("blocked"); // effectiveStatus, not stored
    expect(r.blockers).toBe(2); // 1 unresolved + 1 issue-block
    expect(r.working).toBe("partial");
    expect(String(r.text).length).toBeLessThanOrEqual(
      PLANS_ITEMS_TIER_CAPS.trimmed.text,
    );
    expect(r).not.toHaveProperty("item");
    expect(r).not.toHaveProperty("blockedBy"); // trimmed drops the ref lists
    // standard joins the ref arrays to comma strings
    const std = shapePlansItems({ items: [itemRow(3)] }, "standard") as {
      items: Record<string, unknown>[];
    };
    expect(std.items[0].blockedBy).toBe("P-001,P-002");
    expect(std.items[0].blockedByIssues).toBe("EI-9");
    expect(std.items[0].workers).toBe("su-abc");
  });

  it("caps rows (importance head) with a uniform-key notice row", () => {
    const cap = PLANS_ITEMS_TIER_CAPS.trimmed.rows;
    const items = Array.from({ length: cap + 7 }, (_, i) => itemRow(i));
    const out = shapePlansItems({ items }, "trimmed") as {
      items: Record<string, unknown>[];
    };
    expect(out.items).toHaveLength(cap + 1);
    const notice = out.items.at(-1)!;
    expect(notice.plan).toBe("(truncated)");
    expect(notice.text).toContain(`top ${cap} of ${items.length}`);
    const keys = Object.keys(out.items[0]).sort();
    for (const row of out.items) expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("non-conforming data (not_found error shape) passes through", () => {
    const err = { error: "not_found", slug: "x" };
    expect(shapePlansItems(err, "trimmed")).toBe(err);
  });
});

function attnItem(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `plan-item:p${i}`,
    kind: "plan-item",
    source: "plan",
    harnessSlug: "papercusp",
    planSlug: `plan-${i % 3}`,
    itemRef: `P-00${i}`,
    title: `Attention item ${i} with a title that runs long enough to be clipped by the trimmed cap of one hundred and ten characters`,
    body: "x".repeat(2000),
    status: "todo",
    importance: "normal",
    tier: "activity",
    needsHuman: false,
    actions: [{ id: "set-status" }],
    ref: { kind: "plan-item" },
    triageState: "untriaged",
    ...overrides,
  };
}

describe("shapePlansAttention (P-021)", () => {
  const groups = [
    {
      key: "plan-0",
      kind: "plan",
      planSlug: "plan-0",
      harnessSlug: "papercusp",
      title: "Plan zero",
      maxImportance: "urgent",
      items: [
        attnItem(1, { tier: "decision", needsHuman: true, importance: "normal" }),
        attnItem(2, { importance: "urgent" }),
        attnItem(3),
      ],
    },
    {
      key: "alerts:papercusp",
      kind: "alerts",
      planSlug: null,
      harnessSlug: "papercusp",
      title: "Alerts",
      maxImportance: "high",
      items: [attnItem(4, { importance: "high" })],
    },
  ];
  const data = { groups, tierCounts: { decision: 1, activity: 3 } };

  it("collapses groups to count summaries and drops item bodies entirely", () => {
    const out = shapePlansAttention(data, "trimmed") as Record<string, unknown>;
    const g = (out.groups as Record<string, unknown>[])[0];
    expect(g.itemCount).toBe(3);
    expect(g.decisions).toBe(1);
    expect(g).not.toHaveProperty("items");
    expect(out.itemsTotal).toBe(4);
    expect(out.tierCounts).toEqual({ decision: 1, activity: 3 });
    expect(JSON.stringify(out)).not.toContain("xxxx"); // no 2KB bodies survive
  });

  it("top-N ranks decisions first, then importance; standard widens the rows", () => {
    const out = shapePlansAttention(data, "trimmed") as {
      top: Record<string, unknown>[];
      hint: string;
    };
    expect(out.top[0].id).toBe("plan-item:p1"); // the decision beats urgent activity
    expect(out.top[1].id).toBe("plan-item:p2"); // then urgent
    expect(out.top[0]).not.toHaveProperty("needsHuman");
    expect(out.hint).toContain("tools:invoke { name:'plans:attention'");
    const std = shapePlansAttention(data, "standard") as {
      top: Record<string, unknown>[];
    };
    expect(std.top[0].needsHuman).toBe(true);
    expect(std.top[0].itemRef).toBe("P-001");
  });

  it("caps top at the tier N and keeps uniform top-row keys", () => {
    const many = {
      groups: [
        {
          key: "g",
          title: "G",
          maxImportance: "normal",
          items: Array.from({ length: 60 }, (_, i) => attnItem(i)),
        },
      ],
      tierCounts: {},
    };
    const out = shapePlansAttention(many, "trimmed") as {
      top: Record<string, unknown>[];
      itemsTotal: number;
    };
    expect(out.top).toHaveLength(ATTENTION_TIER_CAPS.trimmed.top);
    expect(out.itemsTotal).toBe(60);
    const keys = Object.keys(out.top[0]).sort();
    for (const row of out.top) expect(Object.keys(row).sort()).toEqual(keys);
  });

  it("non-conforming data passes through untouched", () => {
    const weird = { nope: true };
    expect(shapePlansAttention(weird, "trimmed")).toBe(weird);
  });
});
