/**
 * plans:get narrowed decision reads — CONTINUATION contract (EI-21573289806322713).
 *
 * The reporter's ask: "size explicit decision batches against the aggregate
 * output budget, or return a continuation that preserves all requested
 * IDs/bodies rather than an incomplete summary envelope."
 *
 * The property under test is therefore NOT "the response is small". It is
 * that a bounded response never silently loses a requested ruling: every body
 * that comes back is COMPLETE, every id that did not come back is NAMED, and
 * following the continuation terminates having covered all of them exactly
 * once.
 *
 * Why these tests are written against byte-identity of bodies rather than
 * lengths: the defect being prevented is a body that arrives clipped and
 * still reads as the whole ruling. A length assertion passes on a clipped
 * body that happens to be short; an equality assertion cannot.
 */
import { describe, expect, it } from "vitest";
import { narrowDecisionPayload, pageDecisionsToBudget, decisionPageBudgetChars } from "./get";

interface TestDecision {
  id: string;
  title: string;
  body: string;
}

function decision(id: string, bodyChars: number): TestDecision {
  return {
    id,
    title: `decision ${id}`,
    // Distinct leading + trailing markers: a truncation anywhere is detectable
    // by equality, and a head- or tail-slice is distinguishable in a failure.
    body: `START-${id}${"x".repeat(Math.max(0, bodyChars - 20))}END-${id}`,
  };
}

/** The identity/CAS envelope narrowDecisionPayload keeps, plus fields it must strip. */
const BASE = {
  slug: "governing-plan-2026-08-27",
  harness: "papercusp",
  version: 7,
  contentHash: "abc123",
  counts: { items: 12, decisions: 5, sections: 9 },
  // Not identity fields — must not survive into a narrowed payload.
  prose: "z".repeat(5_000),
  items: [{ id: "P-001" }],
};

describe("pageDecisionsToBudget", () => {
  it("returns everything and defers nothing when the set fits", () => {
    const selected = [decision("D-001", 100), decision("D-002", 100)];
    const page = pageDecisionsToBudget({}, selected, 10_000);
    expect(page.returned).toHaveLength(2);
    expect(page.deferred).toEqual([]);
  });

  it("splits rather than clipping when the set does not fit", () => {
    const selected = [decision("D-001", 2_000), decision("D-002", 2_000), decision("D-003", 2_000)];
    const page = pageDecisionsToBudget({}, selected, 4_000);
    expect(page.returned.length).toBeGreaterThan(0);
    expect(page.returned.length).toBeLessThan(3);
    // Whatever came back is byte-identical to the input record.
    for (const returned of page.returned) {
      const original = selected.find((d) => d.id === returned.id);
      expect(returned.body).toBe(original?.body);
    }
    expect(page.deferred).toEqual(
      selected.slice(page.returned.length).map((d) => d.id),
    );
  });

  it("PROGRESS GUARANTEE: returns a lone oversized decision instead of an empty page", () => {
    // A single ruling bigger than the whole budget. Returning nothing here
    // would make the continuation non-terminating — the caller would re-issue
    // the same call forever.
    const selected = [decision("D-001", 50_000), decision("D-002", 100)];
    const page = pageDecisionsToBudget({}, selected, 1_000);
    expect(page.returned).toHaveLength(1);
    expect(page.returned[0]?.id).toBe("D-001");
    expect(page.returned[0]?.body).toBe(selected[0]?.body);
    expect(page.deferred).toEqual(["D-002"]);
  });

  it("charges the identity envelope against the budget, not just the bodies", () => {
    const selected = [decision("D-001", 400), decision("D-002", 400)];
    const bare = pageDecisionsToBudget({}, selected, 2_400);
    const withEnvelope = pageDecisionsToBudget(
      { slug: "s", padding: "p".repeat(1_500) },
      selected,
      2_400,
    );
    // Same decisions, same budget — the only difference is envelope cost, and
    // it must be able to change the page boundary. Otherwise the response
    // overflows the door by exactly the envelope size.
    expect(bare.returned.length).toBeGreaterThan(withEnvelope.returned.length);
  });

  it("is inert when no budget is supplied (browse-read compatibility)", () => {
    const selected = [decision("D-001", 9_000), decision("D-002", 9_000)];
    expect(pageDecisionsToBudget({}, selected, undefined).deferred).toEqual([]);
    expect(pageDecisionsToBudget({}, selected, 0).deferred).toEqual([]);
    expect(pageDecisionsToBudget({}, selected, Number.NaN).deferred).toEqual([]);
  });
});

describe("narrowDecisionPayload continuation envelope", () => {
  it("omits returned/deferred/continuation entirely when nothing was split", () => {
    const selected = [decision("D-001", 100), decision("D-002", 100)];
    const out = narrowDecisionPayload(BASE, ["D-001", "D-002"], selected, 10_000);
    const selection = out.decisionSelection as Record<string, unknown>;
    // Absence IS the "this read is complete" signal — asserted explicitly so a
    // future change cannot start emitting them unconditionally and silently
    // invert that meaning.
    expect(selection).not.toHaveProperty("returned");
    expect(selection).not.toHaveProperty("deferred");
    expect(out).not.toHaveProperty("decisionContinuation");
    expect(selection.matched).toEqual(["D-001", "D-002"]);
  });

  it("keeps `matched` meaning found-in-plan even when the page is split", () => {
    const selected = [decision("D-001", 3_000), decision("D-002", 3_000), decision("D-003", 3_000)];
    const out = narrowDecisionPayload(BASE, ["D-001", "D-002", "D-003"], selected, 4_000);
    const selection = out.decisionSelection as Record<string, unknown>;
    // Regression guard for existing callers: `matched`/`missing` must not
    // change meaning just because paging was added.
    expect(selection.matched).toEqual(["D-001", "D-002", "D-003"]);
    expect(selection.missing).toEqual([]);
    const returned = selection.returned as string[];
    const deferred = selection.deferred as string[];
    expect([...returned, ...deferred]).toEqual(["D-001", "D-002", "D-003"]);
  });

  it("NEVER routes a deferred id into `missing` — not-found and not-yet-sent stay distinct", () => {
    // The failure this prevents: a caller treats `missing` as "no such
    // decision" and concludes a governing ruling does not exist, when in fact
    // it merely did not fit.
    const selected = [decision("D-001", 3_000), decision("D-002", 3_000)];
    const out = narrowDecisionPayload(
      BASE,
      ["D-001", "D-002", "D-404"],
      selected,
      3_600,
    );
    const selection = out.decisionSelection as Record<string, unknown>;
    expect(selection.missing).toEqual(["D-404"]);
    expect(selection.deferred).toEqual(["D-002"]);
    expect(selection.missing).not.toContain("D-002");
    expect(selection.deferred).not.toContain("D-404");
  });

  it("emits a stateless, directly re-issuable continuation call", () => {
    const selected = [decision("D-001", 3_000), decision("D-002", 3_000)];
    const out = narrowDecisionPayload(BASE, ["D-001", "D-002"], selected, 3_600);
    const continuation = out.decisionContinuation as {
      deferred: string[];
      call: { slug: string; harness: string; decisions: string[] };
      note: string;
    };
    expect(continuation.call).toEqual({
      slug: BASE.slug,
      harness: BASE.harness,
      decisions: continuation.deferred,
    });
    // No opaque cursor/token: re-issuing must not depend on server-side state
    // that a restart or a different process could lose.
    expect(JSON.stringify(continuation.call)).not.toMatch(/cursor|token|pageId/i);
    expect(continuation.note).toMatch(/DEFERRED, not truncated/);
  });

  it("terminates and covers every requested id exactly once when followed", () => {
    // The end-to-end property the reporter actually asked for: "preserves all
    // requested IDs/bodies". Drive the continuation to exhaustion the way a
    // caller would.
    const all = [
      decision("D-001", 2_201),
      decision("D-002", 3_319),
      decision("D-003", 4_782),
      decision("D-004", 1_152),
      decision("D-005", 962),
    ];
    const budget = 6_000; // the baked 1500-token door × 4 chars/token
    let outstanding = all.map((d) => d.id);
    const collected = new Map<string, string>();
    let pages = 0;

    while (outstanding.length > 0) {
      pages += 1;
      expect(pages).toBeLessThanOrEqual(all.length); // cannot loop forever
      const selected = all.filter((d) => outstanding.includes(d.id));
      const out = narrowDecisionPayload(BASE, outstanding, selected, budget);
      for (const returned of out.decisions as TestDecision[]) {
        expect(collected.has(returned.id)).toBe(false); // exactly once
        collected.set(returned.id, returned.body);
      }
      const continuation = out.decisionContinuation as { call: { decisions: string[] } } | undefined;
      outstanding = continuation ? continuation.call.decisions : [];
    }

    expect([...collected.keys()].sort()).toEqual(["D-001", "D-002", "D-003", "D-004", "D-005"]);
    // Every body complete, byte-for-byte.
    for (const original of all) {
      expect(collected.get(original.id)).toBe(original.body);
    }
    // And it genuinely split — otherwise this test would pass trivially and
    // prove nothing about the continuation.
    expect(pages).toBeGreaterThan(1);
  });

  it("still strips non-identity fields on a paged read", () => {
    const selected = [decision("D-001", 3_000), decision("D-002", 3_000)];
    const out = narrowDecisionPayload(BASE, ["D-001", "D-002"], selected, 3_600);
    expect(out).not.toHaveProperty("prose");
    expect(out).not.toHaveProperty("items");
    expect(out.slug).toBe(BASE.slug);
    expect(out.version).toBe(7);
  });

  it("preserves a selected item payload when item and decision selectors are combined", () => {
    const selected = [decision("D-001", 100)];
    const itemPayload = {
      items: [{ id: "P-003", text: "selected item" }],
      itemSelection: {
        requested: ["P-003", "P-404"],
        matched: ["P-003"],
        missing: ["P-404"],
      },
      linkedFeatures: { "P-003": { featureId: "F-003" } },
      blockingIssues: { "P-003": ["EI-003"] },
    };
    const out = narrowDecisionPayload(BASE, ["D-001"], selected, 10_000, itemPayload);

    expect(out.items).toEqual(itemPayload.items);
    expect(out.itemSelection).toEqual(itemPayload.itemSelection);
    expect(out.linkedFeatures).toEqual(itemPayload.linkedFeatures);
    // planItemTests is retired with inline VAL-* (verification-system-improvements-2026-10-10 P-003).
    expect(out).not.toHaveProperty("planItemTests");
    expect(out.blockingIssues).toEqual(itemPayload.blockingIssues);
    expect(out.decisions).toEqual(selected);
  });

  it("keeps decision-only reads free of the optional item payload", () => {
    const selected = [decision("D-001", 100)];
    const out = narrowDecisionPayload(BASE, ["D-001"], selected, 10_000);

    expect(out).not.toHaveProperty("items");
    expect(out).not.toHaveProperty("itemSelection");
    expect(out).not.toHaveProperty("linkedFeatures");
    expect(out).not.toHaveProperty("planItemTests");
    expect(out).not.toHaveProperty("blockingIssues");
  });
});

describe("decisionPageBudgetChars", () => {
  it("derives a positive per-response budget and splits it across plans", () => {
    const one = decisionPageBudgetChars(null, 1);
    expect(one).toBeGreaterThan(0);
    expect(decisionPageBudgetChars(null, 3)).toBe(Math.floor(one / 3));
  });

  it("treats a zero/negative plan count as one plan rather than dividing by zero", () => {
    const one = decisionPageBudgetChars(null, 1);
    expect(decisionPageBudgetChars(null, 0)).toBe(one);
    expect(Number.isFinite(decisionPageBudgetChars(null, -4))).toBe(true);
  });
});
