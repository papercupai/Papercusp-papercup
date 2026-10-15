/**
 * Recurrence guard for EI-19478970139996135 — `plans:get { heading }` shipping a
 * meta envelope several times larger than the section it was asked for.
 *
 * The original defect was a one-token spread (`...base`), which is exactly the
 * kind of thing that gets reintroduced by someone adding a field to the meta
 * envelope and never thinking about the heading path. So these assert the
 * PROPERTY (the requested body dominates the payload), not just the current
 * field list — a new bulky meta field reds this without anyone remembering the
 * bug existed.
 */
import { describe, expect, it } from "vitest";

import { findSection, narrowHeadingPayload, splitSections } from "./get.js";

type Sec = { heading: string; level: number; chars: number; body: string };

const NOW_STATE = "state ".repeat(200);
const NOW_NEXT = "next ".repeat(130);

function makeBase() {
  return {
    slug: "a-plan-2026-08-03",
    harness: "papercusp",
    archived: false,
    legacy: false as const,
    frontmatter: {
      // `raw` duplicates the parsed fields beside it.
      raw: "---\ntitle: A Plan\nstatus: active\n---",
      title: "A Plan",
      slug: "a-plan-2026-08-03",
      status: "active",
    },
    now: { state: NOW_STATE, next: NOW_NEXT, raw: `${NOW_STATE}\n${NOW_NEXT}`, lineNumber: 3 },
    contentHash: "sha256:" + "0".repeat(56),
    version: 7,
    promotePolicy: { policy: "manual", warnings: [] },
    sectionIndex: Array.from({ length: 10 }, (_, i) => ({
      heading: `Phase ${i} — a reasonably long heading that costs real bytes`,
      level: 2,
      chars: 900,
    })),
    lifecycle: {
      liveItems: [{ id: "P-001", effectiveStatus: "wip" }],
      liveItemsTruncated: true,
    },
    counts: { items: 12, decisions: 4, sections: 10 },
  };
}

const HIT: Sec = { heading: "Phase B", level: 2, chars: 40, body: "the body you asked for" };

describe("plans:get { heading } narrowing (EI-19478970139996135)", () => {
  it("drops the meta fields a heading read did not ask for", () => {
    const out = narrowHeadingPayload(makeBase(), "Phase B", HIT);

    // The ## Now block was 53% of the measured payload, and on heading:'Now'
    // its `raw` is byte-identical to the section body being returned anyway.
    expect(out).not.toHaveProperty("now");
    expect(out).not.toHaveProperty("promotePolicy");
    // Nothing anywhere in the payload should still carry the Now prose.
    expect(JSON.stringify(out)).not.toContain(NOW_STATE);
  });

  it("keeps identity + the CAS baseline, so a caller can edit what it just read", () => {
    const out = narrowHeadingPayload(makeBase(), "Phase B", HIT);
    expect(out.slug).toBe("a-plan-2026-08-03");
    expect(out.harness).toBe("papercusp");
    expect(out.contentHash).toBe("sha256:" + "0".repeat(56));
    expect(out.version).toBe(7);
    expect(out.counts).toEqual({ items: 12, decisions: 4, sections: 10 });
    expect(out.section).toEqual({ heading: "Phase B", level: 2, body: "the body you asked for" });
  });

  it("keeps parsed frontmatter but drops frontmatter.raw, which duplicates it", () => {
    const out = narrowHeadingPayload(makeBase(), "Phase B", HIT);
    const fm = out.frontmatter as Record<string, unknown>;
    expect(fm.title).toBe("A Plan");
    expect(fm.status).toBe("active");
    expect(fm).not.toHaveProperty("raw");
  });

  it("returns sectionIndex ONLY on a miss — it is how you find the heading you meant", () => {
    const hit = narrowHeadingPayload(makeBase(), "Phase B", HIT);
    expect(hit).not.toHaveProperty("sectionIndex");
    expect(hit.section).not.toBeNull();

    const miss = narrowHeadingPayload(makeBase(), "Phase Nope", null);
    expect(miss.section).toBeNull();
    expect(Array.isArray(miss.sectionIndex)).toBe(true);
    expect((miss.sectionIndex as unknown[]).length).toBe(10);
  });

  it("drops unrelated lifecycle truncation markers while preserving a large requested body", () => {
    const body = "requirement record ".repeat(400);
    const out = narrowHeadingPayload(makeBase(), "Requirements", {
      heading: "Requirements",
      level: 2,
      chars: body.length,
      body,
    });

    expect(out).not.toHaveProperty("lifecycle");
    expect(JSON.stringify(out)).not.toContain("liveItemsTruncated");
    expect((out.section as Record<string, unknown>).body).toBe(body);
  });

  it("makes the requested body the DOMINANT term, not a minority of the payload", () => {
    // The property that actually matters, and the one a future bulky meta field
    // would violate even if it is not on the drop-list above. Measured before
    // the fix: body was 2041 of 7538 chars (27%).
    const body = "x".repeat(2000);
    const out = narrowHeadingPayload(makeBase(), "Phase B", {
      heading: "Phase B",
      level: 2,
      chars: body.length,
      body,
    });
    const totalChars = JSON.stringify(out).length;
    expect(body.length / totalChars).toBeGreaterThan(0.6);
  });

  it("CONTROL: the pre-fix `...base` spread violates every assertion above", () => {
    // Falsifiability control, kept PERMANENTLY. A guard that has never failed is
    // a guard nobody has tested — and the repo rule is to prove that by keeping a
    // deliberately-wrong implementation here, never by mutating the shared tree
    // (a mutation probe races git-sync, which has committed a mutant before).
    //
    // This reconstructs exactly what the code used to do: spread the whole meta
    // base and bolt the section on. If a future refactor makes the assertions
    // above vacuous, THIS test starts failing too.
    const body = "x".repeat(2000);
    const preFix: Record<string, unknown> = {
      ...makeBase(),
      heading: "Phase B",
      section: { heading: "Phase B", level: 2, body },
    };

    expect(preFix).toHaveProperty("now"); // vs. "drops the meta fields"
    expect(preFix).toHaveProperty("promotePolicy");
    expect(JSON.stringify(preFix)).toContain(NOW_STATE);
    expect(preFix.frontmatter).toHaveProperty("raw"); // vs. "drops frontmatter.raw"
    expect(preFix).toHaveProperty("sectionIndex"); // vs. "ONLY on a miss"
    // vs. "makes the requested body the DOMINANT term" — this is the 27% the
    // original measurement found.
    expect(body.length / JSON.stringify(preFix).length).toBeLessThan(0.6);
  });

  it("is a no-op for the fields a legacy plan does not carry", () => {
    // The legacy branch shares this helper; its base has no now/frontmatter/
    // promotePolicy, so those rules must simply not fire (and must not throw).
    const legacyBase = {
      slug: "old-plan",
      harness: "papercusp",
      archived: false,
      legacy: true as const,
      contentHash: "sha256:" + "1".repeat(56),
      version: 2,
      filename: "old-plan.md",
      sectionIndex: [{ heading: "Notes", level: 2, chars: 10 }],
      counts: { sections: 1 },
    };
    const out = narrowHeadingPayload(legacyBase, "Notes", {
      heading: "Notes",
      level: 2,
      chars: 10,
      body: "notes body",
    });
    expect(out.legacy).toBe(true);
    expect(out.filename).toBe("old-plan.md");
    expect(out).not.toHaveProperty("sectionIndex");
    expect(out.section).toEqual({ heading: "Notes", level: 2, body: "notes body" });
  });
});

/**
 * EI-19459526252132133 — `heading` resolving a level-3 (`### `) subsection.
 *
 * Decisions are `### D-NNN` records under `## Decisions`, and splitSections
 * indexes levels 1-2 only, so ONE decision was unreachable by any read while
 * three tools could WRITE one by id. The whole `## Decisions` section was the
 * smallest readable unit, and on a mature plan that section is exactly what
 * overflows the result door.
 *
 * What these guard is not "the fallback works" but the two properties that let
 * it be added safely: an existing top-level lookup can NEVER change meaning,
 * and the section INDEX is untouched (no payload inflation).
 */
describe("plans:get heading — level-3 subsection fallback", () => {
  const PLAN = [
    "## Now",
    "doing things",
    "",
    "## Decisions",
    "preamble prose that belongs to no record",
    "",
    "### D-001 — first ruling",
    "the first body",
    "",
    "### D-097 — the governing ruling",
    "the ruling that actually governs the work",
    "```",
    "### not a heading — inside a fence",
    "```",
    "still D-097",
    "",
    "### D-098 — a later ruling",
    "the last body",
    "",
    "## Decisions Appendix",
    "appendix body",
  ].join("\n");

  const sections = () => splitSections(PLAN);

  it("resolves a ### record by id, returning only that record", () => {
    const sec = findSection(sections(), "D-097");
    expect(sec?.level).toBe(3);
    expect(sec?.heading).toBe("D-097 — the governing ruling");
    expect(sec?.body).toContain("the ruling that actually governs");
    // Bounded by the NEXT record, not by the end of the section.
    expect(sec?.body).not.toContain("the last body");
    expect(sec?.body).not.toContain("the first body");
  });

  it("does not treat a ### line inside a fence as a record boundary", () => {
    const sec = findSection(sections(), "D-097");
    expect(sec?.body).toContain("inside a fence");
    expect(sec?.body).toContain("still D-097");
  });

  it("a level-2 section still WINS over a level-3 record — an existing call cannot change meaning", () => {
    // The top-level lookup is tried to exhaustion first, so a call that
    // resolves to a section today can never start resolving to a subsection.
    const sec = findSection(sections(), "Decisions");
    expect(sec?.level).toBe(2);
    expect(sec?.heading).toBe("Decisions");
    expect(sec?.body).toContain("### D-001");
  });

  it("falls back to substring on level-2 before ever reaching level-3", () => {
    const sec = findSection(sections(), "Appendix");
    expect(sec?.level).toBe(2);
    expect(sec?.heading).toBe("Decisions Appendix");
  });

  it("a PREFIX of a record heading resolves — the property the truncation pointer relies on", () => {
    // shape-clip quotes a heading clipped to 48 chars; that pointer is only
    // honest if a clipped heading is still a working `heading` argument.
    const full = "D-097 — the governing ruling";
    for (const n of [5, 10, full.length]) {
      const sec = findSection(sections(), full.slice(0, n));
      expect(sec?.heading, `prefix of length ${n}`).toBe(full);
    }
  });

  it("still returns null for a heading that matches nothing", () => {
    expect(findSection(sections(), "D-404")).toBeNull();
  });

  it("leaves the section INDEX at levels 1-2 — the fallback is lookup-only", () => {
    // The reason this is not folded into splitSections: sectionIndex and
    // counts.sections stay byte-identical, so no existing payload grows.
    expect(sections().map((s) => s.heading)).toEqual([
      "Now",
      "Decisions",
      "Decisions Appendix",
    ]);
    expect(sections().every((s) => s.level <= 2)).toBe(true);
  });
});
