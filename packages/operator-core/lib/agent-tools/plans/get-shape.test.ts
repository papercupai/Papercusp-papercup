/**
 * get-shape.test.ts — plans:get payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Contract: prose/section bodies capped with a heading-narrowing pointer,
 * browse-read item text capped (rawLine dropped), decisions capped to the
 * newest few, trimmed drops the UI decoration maps LOUDLY (trimmedOmitted).
 * Explicit item/heading detail reads preserve the selected text. Errors + junk
 * pass through untouched.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/get-shape.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { applyPayloadTier, PAYLOAD_TIER_HARD_CEILING_CHARS } from "@papercusp/tooldef";
import { shapePlansGet, summarizeProofHistory } from "./get-shape";

function envelope() {
  return {
    ok: true,
    counts: { ok: 1, failed: 1 },
    results: [
      {
        ok: true,
        slug: "big-plan",
        frontmatter: { slug: "big-plan", title: "Big" },
        now: { state: "s", next: "n" },
        sectionIndex: [{ heading: "Now", level: 2, chars: 100 }],
        prose: "p".repeat(30_000),
        items: Array.from({ length: 12 }, (_, i) => ({
          id: `P-00${i}`,
          text: `item ${i} ${"x".repeat(500)}`,
          storedStatus: "todo",
          effectiveStatus: "todo",
          rawLine: `- [ ] P-00${i} raw ${"y".repeat(500)}`,
        })),
        decisions: Array.from({ length: 12 }, (_, i) => ({
          id: `D-00${i}`,
          title: `d${i}`,
          body: `body ${i} ${"z".repeat(800)}`,
        })),
        linkedFeatures: { "P-001": { featureId: "F-1", status: "todo", harnessSlug: "h" } },
        blockingIssues: { "P-002": ["EI-9"] },
      },
      { ok: false, slug: "missing", error: "not_found" },
    ],
  };
}

describe("shapePlansGet trimmed", () => {
  const out = shapePlansGet(envelope(), "trimmed") as {
    payloadTier: string;
    results: Array<Record<string, unknown>>;
  };
  const r = out.results[0]!;

  it("caps prose with a loud heading-narrowing pointer", () => {
    expect((r.prose as string).length).toBeLessThanOrEqual(6_000);
    expect(r.prose_truncated).toBe(true);
    expect(r.prose_full_chars).toBe(30_000);
    expect(String(r.prose_hint)).toContain("heading");
    expect(String(r.prose_hint)).toContain("tools:invoke { name:'plans:get'");
    expect(out.payloadTier).toBe("trimmed");
  });

  it("caps item text and drops rawLine", () => {
    const items = r.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(12); // structure kept — never drops items
    expect(items[0]!.rawLine).toBeUndefined();
    expect((items[0]!.text as string).length).toBeLessThanOrEqual(200);
    expect(items[0]!.text_truncated).toBe(true);
  });

  it("preserves complete text for an explicit item selection while dropping rawLine", () => {
    const text = "selected item detail ".repeat(180);
    const out = shapePlansGet(
      {
        ok: true,
        results: [
          {
            ok: true,
            slug: "big-plan",
            itemSelection: { requested: ["P-019"], matched: ["P-019"], missing: [] },
            items: [{ id: "P-019", text, rawLine: "- [ ] P-019 duplicate" }],
          },
        ],
      },
      "trimmed",
    ) as { results: Array<Record<string, unknown>> };
    const item = (out.results[0]!.items as Array<Record<string, unknown>>)[0]!;

    expect(item.text).toBe(text);
    expect(item.text_truncated).toBeUndefined();
    expect(item.rawLine).toBeUndefined();
  });

  it("keeps the NEWEST decisions with a truncation marker", () => {
    const decisions = r.decisions as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(8);
    expect(decisions[7]!.id).toBe("D-0011"); // tail kept, head cut
    expect((decisions[0]!.body as string).length).toBeLessThanOrEqual(240);
    expect(r.decisionsTruncated).toMatchObject({ total: 12, shown: 8 });
  });

  it("drops the UI decoration map loudly, keeps blockingIssues", () => {
    expect(r.linkedFeatures).toBeUndefined();
    expect(r.trimmedOmitted).toMatchObject({
      fields: ["linkedFeatures"],
    });
    expect(r.blockingIssues).toEqual({ "P-002": ["EI-9"] });
  });

  it("passes error results + junk through untouched", () => {
    expect(out.results[1]).toEqual({ ok: false, slug: "missing", error: "not_found" });
    expect(shapePlansGet(null, "trimmed")).toBeNull();
    expect(shapePlansGet({ no: "results" }, "trimmed")).toEqual({ no: "results" });
  });
});

describe("shapePlansGet standard", () => {
  it("is a looser projection that keeps the decoration maps", () => {
    const out = shapePlansGet(envelope(), "standard") as {
      results: Array<Record<string, unknown>>;
    };
    const r = out.results[0]!;
    expect((r.prose as string).length).toBeLessThanOrEqual(20_000);
    expect(r.linkedFeatures).toBeDefined();
    expect(r.trimmedOmitted).toBeUndefined();
    expect((r.decisions as unknown[]).length).toBe(12); // under the 20 cap
    expect(r.decisionsTruncated).toBeUndefined();
  });

  it("preserves the complete body for a heading-narrowed read", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, slug: "s", heading: "Now", section: { heading: "Now", level: 2, body: "b".repeat(30_000) } },
      ],
    };
    const out = shapePlansGet(env, "standard") as { results: Array<Record<string, unknown>> };
    const sec = out.results[0]!.section as Record<string, unknown>;
    expect(sec.body).toBe("b".repeat(30_000));
    expect(sec.body_truncated).toBeUndefined();
    expect(sec.body_full_chars).toBeUndefined();
  });

  it('keeps a 51-decision `heading: "Decisions"` read intact for the MCP result-door', () => {
    const body = Array.from({ length: 51 }, (_, i) =>
      `### D-${String(i + 1).padStart(3, "0")} Decision ${i + 1}\n\n${"decision-body-".repeat(55)}`,
    ).join("\n\n");
    const data = {
      ok: true,
      results: [
        {
          ok: true,
          slug: "plan-with-51-decisions",
          heading: "Decisions",
          section: { heading: "Decisions", level: 2, body },
        },
      ],
    };
    const shape = {
      trimmed: (value: unknown) => shapePlansGet(value, "trimmed"),
      standard: (value: unknown) => shapePlansGet(value, "standard"),
    };
    const out = applyPayloadTier({
      toolName: "plans:get",
      shape,
      response: { data },
      tier: "full",
      args: { slug: "plan-with-51-decisions", heading: "Decisions" },
      deferHardCeilingToResultDoor: true,
      log: vi.fn(),
    });

    expect(JSON.stringify(data).length).toBeGreaterThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect((out.data as typeof data).results[0]!.section.body).toBe(body);
    expect(out.payloadProjection).toBeUndefined();
  });

  it("still caps an unmarked section body", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, slug: "s", section: { heading: "Now", level: 2, body: "b".repeat(30_000) } },
      ],
    };
    const out = shapePlansGet(env, "standard") as { results: Array<Record<string, unknown>> };
    const sec = out.results[0]!.section as Record<string, unknown>;
    expect((sec.body as string).length).toBeLessThanOrEqual(20_000);
    expect(sec.body_truncated).toBe(true);
    expect(sec.body_full_chars).toBe(30_000);
  });
});

/**
 * EI-21573289806322713 — a NARROWED decision read is exempt from both cuts.
 *
 * `plans:get { decisions:[ids] }` routes through `narrowDecisionPayload`
 * (./get.ts), which documents itself as existing "specifically to recover a
 * governing ruling whose complete body did not fit in a plan read" and whose
 * arg is published as returning those ids "with complete bodies". Applying the
 * newest-N slice or the body clip there truncates the escape hatch that exists
 * BECAUSE of truncation — and does it while `decisionSelection.missing` still
 * reads `[]`, the field that is "deliberately in-band so a missing id cannot be
 * mistaken for a complete read".
 *
 * Measured before the fix: 5 explicitly-requested ids returned matched:5 /
 * missing:[] with every body clipped, one at 186 of 4,782 chars.
 *
 * `narrowedEnvelope` mirrors what narrowDecisionPayload actually emits —
 * identity/CAS fields + decisions + decisionSelection, and deliberately NO
 * prose/items/decorations, since stripping those is how that selector already
 * pays its own budget.
 */
function narrowedEnvelope(opts: { withSelection: boolean; count?: number }) {
  const count = opts.count ?? 12;
  const ids = Array.from({ length: count }, (_, i) => `D-${String(i).padStart(3, "0")}`);
  return {
    ok: true,
    counts: { ok: 1, failed: 0 },
    results: [
      {
        ok: true,
        slug: "big-plan",
        frontmatter: { slug: "big-plan", title: "Big" },
        contentHash: "abc123",
        version: 30,
        counts: { items: 7, decisions: count, sections: 10 },
        decisions: ids.map((id, i) => ({
          id,
          title: `d${i}`,
          // Comfortably past both decisionBody caps (trimmed 240, standard 600).
          body: `body ${i} ${"z".repeat(4_000)}`,
        })),
        ...(opts.withSelection
          ? { decisionSelection: { requested: ids, matched: ids, missing: [] as string[] } }
          : {}),
      },
    ],
  };
}

describe("shapePlansGet: narrowed decision reads keep COMPLETE bodies (EI-21573289806322713)", () => {
  for (const tier of ["trimmed", "standard"] as const) {
    it(`${tier}: every requested decision survives with an uncut body`, () => {
      const env = narrowedEnvelope({ withSelection: true });
      // Snapshot the EXACT input bodies and compare against those rather than a
      // reconstructed length — strings are immutable, so this is a true
      // before-image, and it cannot drift from the fixture the way a hand-built
      // expected length can (it did: `body 10 ` is one char longer than
      // `body 0 `, so a reconstruction was wrong for every two-digit index).
      const expectedBodies = new Map(
        (env.results[0]!.decisions as Array<{ id: string; body: string }>).map((d) => [d.id, d.body]),
      );
      const out = shapePlansGet(env, tier) as {
        results: Array<Record<string, unknown>>;
      };
      const r = out.results[0]!;
      const decisions = r.decisions as Array<Record<string, unknown>>;

      // The tail-slice is the more dangerous of the two cuts: it drops
      // explicitly-requested ids from the HEAD. 12 > the trimmed cap of 8.
      expect(decisions).toHaveLength(12);
      expect(decisions[0]!.id).toBe("D-000"); // the head the slice would have cut
      expect(r.decisionsTruncated).toBeUndefined();

      // ...and every body is byte-for-byte what went in, at either tier.
      for (const d of decisions) {
        expect(d.body).toBe(expectedBodies.get(String(d.id)));
        expect(d.body_truncated).toBeUndefined();
        expect(d.body_full_chars).toBeUndefined();
      }

      // The honesty field still means what it says.
      expect(r.decisionSelection).toMatchObject({ missing: [] });
    });
  }

  it("is keyed on decisionSelection: the SAME payload without it is still cut", () => {
    // The differential control. Identical decisions array; the only difference
    // is the presence of `decisionSelection`. This pins the guard's TRIGGER, not
    // merely its effect — a future edit that exempts the wrong reads, or that
    // stops detecting narrowed ones, fails exactly here.
    const browse = shapePlansGet(narrowedEnvelope({ withSelection: false }), "trimmed") as {
      results: Array<Record<string, unknown>>;
    };
    const b = browse.results[0]!;
    const browsed = b.decisions as Array<Record<string, unknown>>;

    expect(browsed).toHaveLength(8); // newest-N still applies to a browse read
    expect(browsed[0]!.id).not.toBe("D-000"); // head still cut
    expect((browsed[0]!.body as string).length).toBeLessThanOrEqual(240);
    expect(browsed[0]!.body_truncated).toBe(true);
    expect(b.decisionsTruncated).toMatchObject({ total: 12, shown: 8 });
  });

  it("a narrowed read UNDER the caps is unchanged either way", () => {
    // Guards against a fix that accidentally makes the exempt path special in
    // some other way: a small selection should look identical to what the
    // unexempted shaper would already have produced.
    const out = shapePlansGet(
      { ok: true, results: [{ ok: true, slug: "s", decisions: [{ id: "D-001", title: "t", body: "short" }], decisionSelection: { requested: ["D-001"], matched: ["D-001"], missing: [] } }] },
      "trimmed",
    ) as { results: Array<Record<string, unknown>> };
    const decisions = out.results[0]!.decisions as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.body).toBe("short");
    expect(decisions[0]!.body_truncated).toBeUndefined();
  });
});

// oversized-tool-results-reduction-2026-10-12 P-006: shipReadiness carries the BAR
// snapshot, whose bars[].proof.history re-listed every evidence row with raw
// `details` (measured ~93% of a 1.5MB snapshot). Browse tiers summarize the rows.
describe("shapePlansGet: shipReadiness proof history is summarized, verdict kept", () => {
  function proofRow(id: number, specId: string, overall: string, reasons: string[], active = true) {
    return {
      id,
      specId,
      evidenceKind: "test",
      activeAttempt: active,
      details: { measurementPin: "m".repeat(2_000) },
      currentness: { overall, staleReasons: reasons, unknownReasons: [], dimensions: { spec: overall } },
    };
  }
  function shipEnvelope() {
    return {
      ok: true,
      results: [
        {
          ok: true,
          slug: "plan-x",
          shipReadiness: {
            satisfied: false,
            code: "bar_snapshot_proof_stale",
            repairAction: "rebind",
            acceptanceBarContractSnapshot: {
              contentHash: "h",
              bars: [
                {
                  barKey: "R-1",
                  readiness: { state: "blocked" },
                  proof: {
                    state: "stale",
                    currentEvidence: 1,
                    staleEvidence: 3,
                    history: [
                      proofRow(1, "S-1", "stale", ["spec-stale"]),
                      proofRow(2, "S-2", "stale", ["spec-stale", "source-stale"]),
                      proofRow(3, "S-1", "stale", ["spec-stale"]),
                      proofRow(4, "S-3", "current", []),
                      proofRow(5, "S-1", "stale", ["spec-stale"], false),
                    ],
                  },
                },
                { barKey: "R-2", proof: { state: "missing", currentEvidence: 0, staleEvidence: 0, history: [] } },
              ],
            },
          },
        },
      ],
    };
  }
  type Bar = { barKey: string; readiness?: unknown; proof: Record<string, unknown> };
  const barsOf = (shaped: unknown) =>
    ((shaped as { results: Array<{ shipReadiness: { acceptanceBarContractSnapshot: { bars: Bar[] } } }> })
      .results[0]!.shipReadiness.acceptanceBarContractSnapshot.bars);

  for (const tier of ["trimmed", "standard"] as const) {
    it(`${tier}: replaces rows with an in-band summary of the ACTIVE rows`, () => {
      const input = shipEnvelope();
      const shaped = shapePlansGet(input, tier) as { results: Array<{ shipReadiness: Record<string, unknown> }> };
      const sr = shaped.results[0]!.shipReadiness;
      expect(sr.satisfied).toBe(false);
      expect(sr.code).toBe("bar_snapshot_proof_stale");
      expect(sr.repairAction).toBe("rebind");
      const [bar] = barsOf(shaped);
      expect(bar!.readiness).toEqual({ state: "blocked" });
      expect(bar!.proof.history).toBeUndefined();
      expect(bar!.proof.staleEvidence).toBe(3);
      const summary = bar!.proof.historySummary as {
        rows: number;
        activeRows: number;
        byCurrentness: Record<string, number>;
        reasons: Array<{ reason: string; count: number; sampleSpecIds: string[]; sampleIds: unknown[] }>;
        rowsCut: string;
      };
      expect(summary.rows).toBe(5);
      expect(summary.activeRows).toBe(4);
      expect(summary.byCurrentness).toEqual({ stale: 3, current: 1 });
      expect(summary.reasons[0]).toEqual({
        reason: "spec-stale",
        count: 3,
        sampleSpecIds: ["S-1", "S-2"],
        sampleIds: [1, 2, 3],
      });
      expect(summary.reasons[1]).toMatchObject({ reason: "source-stale", count: 1, sampleIds: [2] });
      expect(summary.rowsCut).toContain("TRUNCATED 5 proof rows");
      expect(summary.rowsCut).toContain("payloadTier:'full'");
      expect(JSON.stringify(shaped)).not.toContain("m".repeat(100));
      // the caller's object is not mutated (one cached read serves every tier)
      expect(input.results[0]!.shipReadiness.acceptanceBarContractSnapshot.bars[0]!.proof.history).toHaveLength(5);
    });
  }

  // Second cut (2026-10-13): a default-tier body still spilled at the door, whose notice
  // routes to payloadTier:'full', so callers escalated to 98-842KB reads. Falsifier: a long
  // prose field survives in full, its length is lost, a short one is altered, the revision
  // pins keep their rows, or the verdict changes.
  for (const tier of ["trimmed", "standard"] as const) {
    it(`${tier}: clips bar contract prose to a marked head and turns revision pins into counts`, () => {
      const input = shipEnvelope();
      const snap = input.results[0]!.shipReadiness.acceptanceBarContractSnapshot as unknown as Record<string, unknown> & {
        bars: Array<Record<string, unknown>>;
      };
      snap.bars[0]!.requirement = "r".repeat(1_900);
      snap.bars[0]!.method = "short method";
      snap.bars[1]!.falsifier = "f".repeat(300);
      snap.sourceRevisions = {
        subjectPlan: 7,
        rubricPlan: 3,
        clauses: Array.from({ length: 40 }, (_, i) => ({ specId: `S-${i}`, revision: 1, contentHash: "h".repeat(64) })),
        workContracts: [],
        scorecardIds: ["sc-1", "sc-2"],
      };
      const shaped = shapePlansGet(input, tier) as {
        results: Array<{ shipReadiness: { satisfied: boolean; code: string; acceptanceBarContractSnapshot: Record<string, unknown> } }>;
      };
      const sr = shaped.results[0]!.shipReadiness;
      expect(sr.satisfied).toBe(false);
      expect(sr.code).toBe("bar_snapshot_proof_stale");
      const [bar0, bar1] = barsOf(shaped) as unknown as Array<Record<string, unknown>>;
      expect(String(bar0!.requirement).length).toBeLessThanOrEqual(160);
      expect(String(bar0!.requirement)).toMatch(/TRUNCATED/);
      expect(bar0!.requirement_full_chars).toBe(1_900);
      expect(bar0!.method).toBe("short method");
      expect(bar0).not.toHaveProperty("method_full_chars");
      expect(bar1!.falsifier_full_chars).toBe(300);
      const outSnap = sr.acceptanceBarContractSnapshot;
      expect(outSnap.proseCut).toContain("payloadTier:'full'");
      const revisions = outSnap.sourceRevisions as Record<string, unknown>;
      expect(revisions.subjectPlan).toBe(7);
      expect(revisions.clauses).toEqual({ count: 40 });
      expect(revisions.scorecardIds).toEqual({ count: 2 });
      expect(revisions.workContracts).toEqual([]);
      expect(revisions.rowsCut).toContain("payloadTier:'full'");
      expect(JSON.stringify(shaped)).not.toContain("r".repeat(200));
      // the caller's object is not mutated (one cached read serves every tier)
      expect(snap.bars[0]!.requirement).toHaveLength(1_900);
      expect((snap.sourceRevisions as { clauses: unknown[] }).clauses).toHaveLength(40);
    });
  }

  it("leaves a bar with an empty history, and a verdict without a snapshot, untouched", () => {
    const shaped = shapePlansGet(shipEnvelope(), "trimmed");
    expect(barsOf(shaped)[1]!.proof.history).toEqual([]);
    const unavailable = {
      ok: true,
      results: [{ ok: true, slug: "p", shipReadiness: { satisfied: false, unavailableReason: "resolver-unavailable" } }],
    };
    const out = shapePlansGet(unavailable, "trimmed") as { results: Array<{ shipReadiness: unknown }> };
    expect(out.results[0]!.shipReadiness).toBe(unavailable.results[0]!.shipReadiness);
  });

  it("caps reason groups per bar and says how many were omitted", () => {
    const rows = Array.from({ length: 11 }, (_, i) => proofRow(i, `S-${i}`, "stale", [`reason-${i}`]));
    const summary = summarizeProofHistory(rows) as { reasons: unknown[]; reasonsOmitted?: number };
    expect(summary.reasons).toHaveLength(8);
    expect(summary.reasonsOmitted).toBe(3);
  });
});
