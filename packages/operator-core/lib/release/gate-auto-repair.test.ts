import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AUTO_REPAIRABLE_CATEGORIES,
  assessRepairOutcomes,
  decideAutoRepair,
  type RepairOutcome,
} from "./gate-auto-repair.ts";
import {
  EXPLICIT_HYGIENE_GATE_SCRIPTS,
  classifyGateFailure,
  deriveGeneratedArtifactHygiene,
  type HygieneCategory,
  type HygieneClassificationContext,
} from "./gate-hygiene-split.ts";

/* The REAL root package.json, read rather than restated — same reasoning as the
 * gate-hygiene-split suite: a hardcoded script set proves only that someone once copied
 * it correctly, where this fails when the repo changes underneath the derivation. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const rootScripts: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).scripts;

const ctx: HygieneClassificationContext = { rootScripts };

/** Every `gen:X:check` in the real repo that has a generator behind it. */
const derivedCheckers = [...deriveGeneratedArtifactHygiene(rootScripts).keys()];

/** Every hygiene category a bare entry can produce, each with a REAL entry that produces it.
 *  Kept as one table so the enumeration tests below cover each such category; a sample that
 *  stops classifying to its stated category fails the first positive control. Not runtime-
 *  enumerated: a NEW category needs a row added here by hand.
 *  `detector-coverage-drift` has no row because a bare entry cannot produce it — it needs
 *  `ctx.failingCasesByFile`, and gate-hygiene-split.test.ts covers it with that context.
 *  `fixture-drift` was RETIRED with `lint:migration-fixture-drift:check` (WI-6554700010009165). */
const CATEGORY_SAMPLES: { category: HygieneCategory; entry: string }[] = [
  { category: "generated-artifact-stale", entry: derivedCheckers[0] },
  { category: "budget-exceeded", entry: "lint:tool-prompts" },
];

describe("gate-auto-repair", () => {
  describe("positive controls: the fixture is real", () => {
    it("the root package.json was actually read", () => {
      expect(Object.keys(rootScripts).length).toBeGreaterThan(50);
    });

    it("the derived generated-artifact set is non-empty", () => {
      // Without this, every "is repairable" assertion below could pass vacuously
      // against an empty derivation.
      expect(derivedCheckers.length).toBeGreaterThan(0);
    });

    it("each category sample really does classify to the category it claims", () => {
      // Guards the table itself: if a sample stopped producing its stated category, the
      // enumeration tests below would be asserting about the wrong thing while still
      // passing — the quiet way a coverage table goes blind.
      for (const { category, entry } of CATEGORY_SAMPLES) {
        const c = classifyGateFailure(entry, ctx);
        expect(c.klass, `sample '${entry}' should be hygiene`).toBe("hygiene");
        expect(c.category, `sample '${entry}'`).toBe(category);
      }
    });
  });

  describe("the admitted set is exactly the DERIVED generated-artifact pairs", () => {
    it("every derived gen:X:check yields a repairable step", () => {
      const d = decideAutoRepair({ failures: derivedCheckers, ctx });
      expect(d.repair).toBe(true);
      expect(d.steps.map((s) => s.entry).sort()).toEqual([...derivedCheckers].sort());
      expect(d.unrepairable).toEqual([]);
    });

    it("the repair command is the GENERATOR and the verifier is its :check", () => {
      const d = decideAutoRepair({ failures: derivedCheckers, ctx });
      for (const step of d.steps) {
        expect(step.repairCommand).toBe(`npm run ${step.entry.replace(/:check$/, "")}`);
        expect(step.verifyCommand).toBe(`npm run ${step.entry}`);
      }
    });

    it("the repair command is NEVER the same as its verifier", () => {
      // The lint:tool-prompts failure shape: a "fix" that is really the failing check.
      const d = decideAutoRepair({ failures: derivedCheckers, ctx });
      for (const step of d.steps) {
        expect(step.repairCommand).not.toBe(step.verifyCommand);
      }
    });

    it("both halves of every emitted pair are REAL scripts in package.json", () => {
      // A plan naming a script that does not exist would fail at actuation time, on the
      // gate, in the dark. Catch it here instead.
      const d = decideAutoRepair({ failures: derivedCheckers, ctx });
      for (const step of d.steps) {
        const repairScript = step.repairCommand.replace(/^npm run /, "");
        const verifyScript = step.verifyCommand.replace(/^npm run /, "");
        expect(rootScripts, `repair '${repairScript}'`).toHaveProperty(repairScript);
        expect(rootScripts, `verify '${verifyScript}'`).toHaveProperty(verifyScript);
      }
    });
  });

  describe("explicit hygiene entries are refused BY CATEGORY", () => {
    it("THE MEASUREMENT this rule rests on: lint:tool-prompts' remedy IS its checker", () => {
      // This is the load-bearing fact behind refusing the whole explicit set. Pinned so
      // that if someone ever corrects that remedy to a real fixer, this test fails and
      // forces the decision to be revisited deliberately rather than by drift.
      expect(EXPLICIT_HYGIENE_GATE_SCRIPTS["lint:tool-prompts"].remedy).toBe(
        "npm run lint:tool-prompts",
      );
    });

    it("lint:tool-prompts is hygiene but NOT auto-repairable", () => {
      const d = decideAutoRepair({ failures: ["lint:tool-prompts"], ctx });
      expect(d.repair).toBe(false);
      expect(d.steps).toEqual([]);
      expect(d.unrepairable.map((u) => u.entry)).toEqual(["lint:tool-prompts"]);
      expect(d.unrepairable[0].why).toMatch(/hand-written|not reliably a fixer/i);
    });

    it("EVERY explicitly-registered hygiene script is refused, by enumeration", () => {
      // Not by example: a new explicit entry must not become auto-repairable by default.
      const entries = Object.keys(EXPLICIT_HYGIENE_GATE_SCRIPTS);
      const d = decideAutoRepair({ failures: entries, ctx });
      expect(d.steps).toEqual([]);
      expect(d.unrepairable.map((u) => u.entry).sort()).toEqual([...entries].sort());
    });
  });

  describe("fail-closed: only generated-artifact-stale is admitted", () => {
    it("AUTO_REPAIRABLE_CATEGORIES contains exactly the one category", () => {
      expect([...AUTO_REPAIRABLE_CATEGORIES]).toEqual(["generated-artifact-stale"]);
    });

    it("every category NOT in the admitted set is refused", () => {
      for (const { category, entry } of CATEGORY_SAMPLES) {
        const d = decideAutoRepair({ failures: [entry], ctx });
        if (AUTO_REPAIRABLE_CATEGORIES.includes(category)) {
          expect(d.steps.map((s) => s.entry), `${category} should repair`).toContain(entry);
        } else {
          expect(d.steps, `${category} must NOT repair`).toEqual([]);
          expect(d.unrepairable.map((u) => u.entry)).toContain(entry);
        }
      }
    });
  });

  describe("product failures are never repaired", () => {
    it.each([
      ["a test file path", "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts"],
      ["a bare workspace", "@papercusp/web"],
      ["an unknown script", "lint:some-check-nobody-registered"],
      ["a lone checker with no generator", "gen:not-a-real-generator:check"],
      ["an empty entry", "   "],
    ])("%s is product, never a repair step", (_label, entry) => {
      const d = decideAutoRepair({ failures: [entry], ctx });
      expect(d.repair).toBe(false);
      expect(d.steps).toEqual([]);
      expect(d.productFailures.map((p) => p.entry)).toContain(entry);
    });

    it("a product failure alongside a repairable one still repairs, and still reports the product red", () => {
      // Regenerating a stale artifact is correct work regardless of what else is red;
      // what must NOT happen is the product failure disappearing from the report.
      const d = decideAutoRepair({
        failures: [derivedCheckers[0], "packages/operator-core/lib/foo.test.ts"],
        ctx,
      });
      expect(d.repair).toBe(true);
      expect(d.steps.map((s) => s.entry)).toEqual([derivedCheckers[0]]);
      expect(d.productFailures.map((p) => p.entry)).toEqual([
        "packages/operator-core/lib/foo.test.ts",
      ]);
      expect(d.reason).toMatch(/product failure\(s\) remain/);
    });

    it("no failures at all is not a repair", () => {
      const d = decideAutoRepair({ failures: [], ctx });
      expect(d.repair).toBe(false);
      expect(d.steps).toEqual([]);
    });
  });

  describe("FALSIFIABILITY CONTROL: a naive implementation that trusts `remedy` is wrong", () => {
    /* A deliberately-wrong implementation, kept permanently as a control (per the repo's
     * guard-falsifiability rule — never mutate the real module to prove this). It does
     * the obvious thing: treat any hygiene `remedy` as the repair command. If our real
     * decision ever collapsed into this, the tests above would still pass unless
     * something asserts the two genuinely DIVERGE. This does. */
    function naiveTrustsRemedy(entry: string): string | null {
      const explicit = EXPLICIT_HYGIENE_GATE_SCRIPTS[entry];
      if (explicit) return explicit.remedy;
      return deriveGeneratedArtifactHygiene(rootScripts).get(entry) ?? null;
    }

    it("the naive version WOULD run the failing checker as a repair (this is the bug)", () => {
      expect(naiveTrustsRemedy("lint:tool-prompts")).toBe("npm run lint:tool-prompts");
    });

    it("the real decision refuses exactly that entry — so the guard has teeth", () => {
      const d = decideAutoRepair({ failures: ["lint:tool-prompts"], ctx });
      expect(d.steps).toEqual([]);
    });

    it("CALIBRATION: on a derived pair the two agree, so the divergence above is real", () => {
      // Without this, the control could be 'passing' merely because the naive version
      // and the real one disagree about everything.
      const entry = derivedCheckers[0];
      const d = decideAutoRepair({ failures: [entry], ctx });
      expect(naiveTrustsRemedy(entry)).toBe(d.steps[0].repairCommand);
    });
  });

  describe("assessRepairOutcomes: the checker is the authority, not the generator", () => {
    const base: RepairOutcome = {
      entry: "gen:declarations:check",
      repairExitCode: 0,
      verifyExitCode: 0,
      producedDiff: true,
    };

    it("regenerated + checker passes ⇒ repaired", () => {
      const a = assessRepairOutcomes([base]);
      expect(a.allRepaired).toBe(true);
      expect(a.results[0].verdict).toBe("repaired");
      expect(a.stillBlocking).toEqual([]);
    });

    it("generator itself failed ⇒ repair-failed, still blocking", () => {
      const a = assessRepairOutcomes([{ ...base, repairExitCode: 1 }]);
      expect(a.allRepaired).toBe(false);
      expect(a.results[0].verdict).toBe("repair-failed");
      expect(a.stillBlocking).toEqual([base.entry]);
    });

    it("generator exits 0 but the CHECKER still fails ⇒ not repaired", () => {
      // The precise trap: trusting the generator's exit code would call this fixed.
      const a = assessRepairOutcomes([
        { ...base, repairExitCode: 0, verifyExitCode: 1, producedDiff: true },
      ]);
      expect(a.allRepaired).toBe(false);
      expect(a.results[0].verdict).toBe("still-failing");
    });

    it("changed NOTHING and still fails ⇒ it was never stale, reclassified to product", () => {
      const a = assessRepairOutcomes([
        { ...base, verifyExitCode: 1, producedDiff: false },
      ]);
      expect(a.results[0].verdict).toBe("not-stale-product");
      expect(a.results[0].reason).toMatch(/never stale|misclassified/i);
      expect(a.stillBlocking).toEqual([base.entry]);
    });

    it("an EMPTY outcome list is never vacuously 'all repaired'", () => {
      // The empty-set-is-not-a-clean-result trap, arriving here by a third route.
      const a = assessRepairOutcomes([]);
      expect(a.allRepaired).toBe(false);
      expect(a.reason).toMatch(/nothing is verified/i);
    });

    it("mixed outcomes ⇒ not all repaired, and only the bad ones block", () => {
      const a = assessRepairOutcomes([
        base,
        { ...base, entry: "gen:contract:check", verifyExitCode: 1, producedDiff: true },
      ]);
      expect(a.allRepaired).toBe(false);
      expect(a.stillBlocking).toEqual(["gen:contract:check"]);
    });

    it("a retry is NEVER recommended, on any outcome shape", () => {
      // A second automatic pass is how auto-repair becomes a loop that hides a real bug.
      const shapes: RepairOutcome[][] = [
        [],
        [base],
        [{ ...base, repairExitCode: 1 }],
        [{ ...base, verifyExitCode: 1, producedDiff: false }],
        [{ ...base, verifyExitCode: 1, producedDiff: true }],
      ];
      for (const s of shapes) {
        expect(assessRepairOutcomes(s).retryRecommended).toBe(false);
      }
    });
  });

  describe("a DELIBERATE REFUSAL is not a broken generator (WI-41770)", () => {
    const base: RepairOutcome = {
      entry: "gen:authored-docs:check",
      repairExitCode: 1,
      verifyExitCode: 1,
      producedDiff: false,
    };

    it("refused:true ⇒ repair-refused, not repair-failed", () => {
      const a = assessRepairOutcomes([{ ...base, refused: true }]);
      expect(a.results[0].verdict).toBe("repair-refused");
    });

    it("the refused reason FORBIDS forcing the overwrite — that is the data-loss path", () => {
      // The live case: gen:authored-docs refuses because 24 doc files hold hand-edits
      // that exist nowhere else. "Fixing" it by making it overwrite would destroy them.
      const a = assessRepairOutcomes([{ ...base, refused: true }]);
      expect(a.results[0].reason).toMatch(/do not .*forcing an overwrite/i);
      expect(a.results[0].reason).toMatch(/working correctly/i);
    });

    it("a refusal STILL BLOCKS — it is not a pass", () => {
      const a = assessRepairOutcomes([{ ...base, refused: true }]);
      expect(a.allRepaired).toBe(false);
      expect(a.stillBlocking).toEqual([base.entry]);
      expect(a.retryRecommended).toBe(false);
    });

    it("UNKNOWN (refused omitted) falls to repair-failed but WARNS about the ambiguity", () => {
      // The safety property that makes the signature list non-load-bearing: even when
      // nobody classifies the refusal, the reader is told not to force the write.
      const a = assessRepairOutcomes([base]);
      expect(a.results[0].verdict).toBe("repair-failed");
      expect(a.results[0].reason).toMatch(/deliberate refusal/i);
      expect(a.results[0].reason).toMatch(/data loss/i);
    });

    it("refused:false is treated as a genuine failure", () => {
      const a = assessRepairOutcomes([{ ...base, refused: false }]);
      expect(a.results[0].verdict).toBe("repair-failed");
    });

    it("`refused` is consulted ONLY on a non-zero exit — a clean repair still wins", () => {
      // Otherwise a stray refused:true would poison a repair that actually succeeded.
      const a = assessRepairOutcomes([
        { ...base, repairExitCode: 0, verifyExitCode: 0, refused: true },
      ]);
      expect(a.results[0].verdict).toBe("repaired");
      expect(a.allRepaired).toBe(true);
    });
  });

  describe("inertness: this module cannot act", () => {
    it("decideAutoRepair returns commands as STRINGS and runs nothing", () => {
      const d = decideAutoRepair({ failures: derivedCheckers, ctx });
      for (const step of d.steps) {
        expect(typeof step.repairCommand).toBe("string");
        expect(typeof step.verifyCommand).toBe("string");
      }
    });
  });
});
