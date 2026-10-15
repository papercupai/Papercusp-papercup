import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COVERAGE_CLASS_TEST_CASES,
  EXPLICIT_HYGIENE_GATE_SCRIPTS,
  classifyGateFailure,
  decidePromotion,
  decideGateSuite,
  captureGateSuiteVerdictReplay,
  parseGateSuiteVerdictReplay,
  checkGateSuiteVerdictReplay,
  type GateSuiteDecisionInput,
  gateReplayCanonical,
  deriveGeneratedArtifactHygiene,
  type HygieneClassificationContext,
} from "./gate-hygiene-split.ts";

describe('P-014 recorded measured-suite replay', () => {
  it('compares JSONB object order canonically while preserving array order', () => {
    expect(gateReplayCanonical({ b: { z: 1, a: 2 }, a: 3 })).toBe(gateReplayCanonical({ a: 3, b: { a: 2, z: 1 } }));
    expect(gateReplayCanonical([1, 2])).not.toBe(gateReplayCanonical([2, 1]));
  });

  it.each([{ kind: '', args: [], expected: false }, { kind: 'ready-advance', args: {} },
    { kind: 'ready-advance', args: [] }])('rejects malformed downstream replay %s', entry => {
    const snapshot = captureGateSuiteVerdictReplay({ candidate: 'a', runId: null, measuredAtMs: 0 }, {
      green: true, infraFault: false, failures: [], rootScripts: null, failingCasesByFile: null });
    expect(parseGateSuiteVerdictReplay({ ...snapshot, decisions: [entry] })).toBeNull();
  });
  const input = (overrides: Partial<GateSuiteDecisionInput> = {}): GateSuiteDecisionInput => ({
    green: false, infraFault: false, failures: ['packages/product.test.ts'],
    rootScripts: {}, failingCasesByFile: null, ...overrides,
  });
  const identity = { candidate: 'a'.repeat(40), runId: 'measured-run', measuredAtMs: 100 };

  it.each([
    [input({ green: true, failures: [] }), 'green'],
    [input(), 'red'],
    [input({ infraFault: true }), 'inconclusive'],
    [input({ green: null }), 'red'],
    [input({ failures: [] }), 'red'],
  ] as const)('reproduces the measured %s decision', (observations, disposition) => {
    const snapshot = captureGateSuiteVerdictReplay(identity, observations);
    expect(snapshot.expected.disposition).toBe(disposition);
    const stored = parseGateSuiteVerdictReplay(JSON.parse(JSON.stringify(snapshot)));
    expect(stored).not.toBeNull();
    expect(checkGateSuiteVerdictReplay(stored!).ok).toBe(true);
  });

  it('captures failing-case attribution and scripts without sharing mutable inputs', () => {
    const observations = input({ failingCasesByFile: [['packages/product.test.ts', ['a case']]], rootScripts: { check: 'node check.mjs' } });
    const snapshot = captureGateSuiteVerdictReplay(identity, observations);
    observations.failures.push('another.test.ts');
    observations.failingCasesByFile![0]![1].push('another case');
    observations.rootScripts!.check = 'changed';
    expect(snapshot.input).toMatchObject({ failures: ['packages/product.test.ts'],
      failingCasesByFile: [['packages/product.test.ts', ['a case']]], rootScripts: { check: 'node check.mjs' } });
    expect(checkGateSuiteVerdictReplay(snapshot).ok).toBe(true);
  });

  it('rejects a prior classifier that promoted a product failure', () => {
    const prior = captureGateSuiteVerdictReplay(identity, input());
    prior.expected.disposition = 'green';
    const replay = checkGateSuiteVerdictReplay(prior);
    expect(replay.ok).toBe(false);
    expect(replay.detail).toContain('was green, now red');
  });

  it('detects failure reclassification even when the top-level verdict remains red', () => {
    const prior = captureGateSuiteVerdictReplay(identity, input());
    prior.expected.productFailures = [];
    expect(checkGateSuiteVerdictReplay(prior)).toMatchObject({ ok: false, detail: expect.stringContaining('productFailures') });
  });

  it('keeps absent scripts fail-closed and preserves the current hygiene decision', () => {
    const observations = input({ failures: ['gen:example:check'], rootScripts: {
      'gen:example': 'node scripts/gen-example.mjs', 'gen:example:check': 'node scripts/gen-example.mjs --check',
    } });
    const current = decideGateSuite(observations);
    expect(current.hygieneSplit).toEqual(decidePromotion({ failures: observations.failures, verdictRendered: true,
      ctx: { rootScripts: observations.rootScripts! } }));
    expect(decideGateSuite({ ...observations, rootScripts: null }).signature.disposition).toBe('red');
  });

  it.each([null, {}, { version: 2 }, { ...captureGateSuiteVerdictReplay(identity, input()), input: {} },
    { ...captureGateSuiteVerdictReplay(identity, input()), expected: {} },
  ])('rejects malformed or unsupported stored replay %s', value => {
    expect(parseGateSuiteVerdictReplay(value)).toBeNull();
  });
});

/* The REAL root package.json, read rather than restated. A test that hardcodes the
 * script set proves only that someone once copied it correctly; this one fails when
 * the repo changes underneath the derivation, which is the whole point of deriving. */
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const rootScripts: Record<string, string> = JSON.parse(
  readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
).scripts;

const ctx: HygieneClassificationContext = { rootScripts };

describe("gate-hygiene-split", () => {
  describe("positive controls: the fixture is real", () => {
    it("the root package.json was actually read and has the scripts we reason about", () => {
      expect(Object.keys(rootScripts).length).toBeGreaterThan(50);
      expect(rootScripts).toHaveProperty("lint:tsc");
      expect(rootScripts).toHaveProperty("lint:tool-prompts");
    });

    it("every explicitly-registered hygiene script actually exists in package.json", () => {
      // Catches a registry entry that was renamed away, which would otherwise sit here
      // classifying a script that no longer exists while the real one holds the gate.
      for (const key of Object.keys(EXPLICIT_HYGIENE_GATE_SCRIPTS)) {
        expect(rootScripts, `explicit hygiene entry '${key}'`).toHaveProperty(key);
      }
    });
  });

  describe("the derived generated-artifact set", () => {
    it("derives a non-trivial set from the real repo", () => {
      const derived = deriveGeneratedArtifactHygiene(rootScripts);
      // A derivation that silently produced nothing would make every gen check
      // product-classified and this whole module a no-op — indistinguishable from
      // "the split is working" unless asserted.
      expect(derived.size).toBeGreaterThanOrEqual(10);
    });

    it("every derived entry is a real gen:*:check with a real generator behind it", () => {
      for (const [key, remedy] of deriveGeneratedArtifactHygiene(rootScripts)) {
        expect(key).toMatch(/^gen:.+:check$/);
        const generator = key.replace(/:check$/, "");
        expect(rootScripts, `generator for '${key}'`).toHaveProperty(generator);
        expect(remedy).toBe(`npm run ${generator}`);
      }
    });

    it("REFUSES a :check with no generator behind it — the pair is the evidence", () => {
      const synthetic = { "gen:phantom:check": "node nope.mjs" };
      expect(deriveGeneratedArtifactHygiene(synthetic).size).toBe(0);

      const paired = { ...synthetic, "gen:phantom": "node gen.mjs" };
      expect(deriveGeneratedArtifactHygiene(paired).has("gen:phantom:check")).toBe(true);
    });
  });

  describe("fails closed", () => {
    // Enumerated, not exampled: each of these is a DIFFERENT way an entry can be
    // unrecognised, and every one must land on product.
    const mustBeProduct = [
      "lint:tsc",
      "lint:migrations",
      "@papercusp/operator-core :: test:lane-stateful",
      "@papercusp/web",
      "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
      "apps/operator/lib/release/green-checkpoint.test.ts",
      "gen:phantom:check",
      "totally-unknown-signature",
      "",
      "   ",
    ];

    for (const entry of mustBeProduct) {
      it(`classifies ${JSON.stringify(entry)} as product`, () => {
        expect(classifyGateFailure(entry, ctx).klass).toBe("product");
      });
    }

    it("every product classification explains itself", () => {
      for (const entry of mustBeProduct) {
        expect(classifyGateFailure(entry, ctx).reason.length).toBeGreaterThan(20);
      }
    });
  });

  describe("admits exactly the hygiene shapes, and no others", () => {
    it("admits a derived generated-artifact check", () => {
      const derived = [...deriveGeneratedArtifactHygiene(rootScripts).keys()];
      const sample = derived[0];
      const got = classifyGateFailure(sample, ctx);
      expect(got.klass).toBe("hygiene");
      expect(got.category).toBe("generated-artifact-stale");
      expect(got.remedy).toMatch(/^npm run gen:/);
    });

    it("admits the registered budget check", () => {
      expect(classifyGateFailure("lint:tool-prompts", ctx).klass).toBe("hygiene");
    });

    it("a RETIRED hygiene script fails closed to product (WI-6554700010009165)", () => {
      // `lint:migration-fixture-drift:check` was deleted with its registry entry. Pinned so
      // that re-adding the npm script WITHOUT a deliberate registry decision holds the gate
      // instead of being waved through as hygiene by a stale entry.
      expect(EXPLICIT_HYGIENE_GATE_SCRIPTS).not.toHaveProperty(
        "lint:migration-fixture-drift:check",
      );
      expect(classifyGateFailure("lint:migration-fixture-drift:check", ctx).klass).toBe(
        "product",
      );
    });

    it("admits a hygiene check reported in workspace-scoped form", () => {
      const got = classifyGateFailure(
        "@papercusp/operator-core :: lint:tool-prompts",
        ctx,
      );
      expect(got.klass).toBe("hygiene");
    });

    it("does NOT admit doc-claims, as a directory or as a file — D-008", () => {
      // The load-bearing negative. gate-candidate-ref mixes a substantive pin with a
      // coverage floor inside ONE it(); exempting the file disables the pin too.
      const docClaims = [
        "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
        "packages/operator-core/lib/doc-claims/state-plane-stamp.test.ts",
        "@papercusp/operator-core :: packages/operator-core/lib/doc-claims/retired-surfaces.test.ts",
      ];
      for (const f of docClaims) {
        expect(classifyGateFailure(f, ctx).klass, f).toBe("product");
      }
    });
  });

  describe("promotion decision", () => {
    it("promotes a clean rendered verdict", () => {
      const d = decidePromotion({ failures: [], verdictRendered: true, ctx });
      expect(d.promote).toBe(true);
    });

    it("REFUSES to promote when no verdict was rendered, even with zero failures", () => {
      // The vacuous-truth trap: "no product failures" is trivially true for a run that
      // measured nothing. A crash must never read as a green.
      const d = decidePromotion({ failures: [], verdictRendered: false, ctx });
      expect(d.promote).toBe(false);
      expect(d.reason).toMatch(/nothing was measured|No verdict/i);
    });

    it("promotes past a pure-hygiene red and hands back items to file", () => {
      const d = decidePromotion({
        failures: ["lint:tool-prompts", "gen:contract:check"],
        verdictRendered: true,
        ctx,
      });
      expect(d.promote).toBe(true);
      expect(d.productFailures).toEqual([]);
      expect(d.hygieneWorkItems).toHaveLength(2);
      expect(d.hygieneWorkItems.every((w) => w.remedy.length > 0)).toBe(true);
    });

    it("BLOCKS on one product failure even among many hygiene failures", () => {
      const d = decidePromotion({
        failures: ["lint:tool-prompts", "gen:contract:check", "lint:tsc"],
        verdictRendered: true,
        ctx,
      });
      expect(d.promote).toBe(false);
      expect(d.productFailures.map((p) => p.entry)).toEqual(["lint:tsc"]);
    });

    it("still files hygiene debt when promotion is blocked — a split is not a suppression", () => {
      const d = decidePromotion({
        failures: ["lint:tool-prompts", "lint:tsc"],
        verdictRendered: true,
        ctx,
      });
      expect(d.promote).toBe(false);
      expect(d.hygieneWorkItems).toHaveLength(1);
    });
  });

  /* ── Permanent falsifiability controls ────────────────────────────────────────
   *
   * A guard that has never failed is a guard nobody has tested. These two keep a
   * deliberately-wrong implementation in the file forever, so the safety property is
   * demonstrated against a live counter-example rather than asserted.
   */
  describe("falsifiability controls", () => {
    /** The WRONG implementation D-008 rejects: exempt drift-guard DIRECTORIES. */
    function naiveDirectoryPromote(failures: readonly string[]): boolean {
      const isDriftGuard = (f: string) =>
        f.includes("/doc-claims/") || /^gen:.+:check$/.test(f);
      return failures.every(isDriftGuard);
    }

    it("CONTROL: the naive directory rule promotes past a substantive doc-claim failure", () => {
      // gate-candidate-ref failing because the gate started FETCHING is a real,
      // dangerous regression reported through the very same file path as tonight's
      // harmless coverage-floor drift. The naive rule cannot tell them apart.
      const failures = [
        "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
      ];
      expect(naiveDirectoryPromote(failures)).toBe(true);
    });

    it("and this module does NOT — the control and the subject disagree", () => {
      const failures = [
        "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
      ];
      const d = decidePromotion({ failures, verdictRendered: true, ctx });
      expect(d.promote).toBe(false);
    });

    it("CALIBRATION: the subject still promotes something, so the control is not passing merely because everything is refused", () => {
      // Without this, a module that classified EVERYTHING as product would pass the
      // control above while being useless — the exact failure mode a falsifiability
      // control is supposed to expose rather than hide.
      const d = decidePromotion({
        failures: ["lint:tool-prompts"],
        verdictRendered: true,
        ctx,
      });
      expect(d.promote).toBe(true);
    });
  });

  /* WI-41765 / D-010 — coverage-class test FILES.
   *
   * Driven off the REAL registry entry rather than a restated copy: a test that hardcodes
   * the case name would keep passing after someone renamed the case, which is precisely
   * the silent-stale mode this branch must not have. */
  describe("coverage-class test files (the one admitted path exception)", () => {
    const entry = COVERAGE_CLASS_TEST_CASES[0];
    const withCases = (
      byFile: Record<string, string[]>,
    ): HygieneClassificationContext => ({
      rootScripts,
      failingCasesByFile: new Map(Object.entries(byFile)),
    });

    it("admits a file whose every failing case is registered coverage-class", () => {
      const c = classifyGateFailure(
        entry.file,
        withCases({ [entry.file]: [entry.caseName] }),
      );
      expect(c.klass).toBe("hygiene");
      expect(c.category).toBe("detector-coverage-drift");
      // The remedy must never suggest lowering the floor — that converts a loud
      // instrument failure into a quiet false-clean.
      expect(c.remedy).toMatch(/never lower the floor/i);
    });

    it("promotes when a registered coverage case is the ONLY failure", () => {
      const d = decidePromotion({
        failures: [entry.file],
        verdictRendered: true,
        ctx: withCases({ [entry.file]: [entry.caseName] }),
      });
      expect(d.promote).toBe(true);
    });

    it("THE RULE THAT MATTERS: a file with ANY unregistered failing case stays product", () => {
      // The substantive pin lives in a sibling case in this same file. If that one fails
      // too, the file must hold `main` — admitting it here would switch off the pin, which
      // is the D-008 hazard this whole design exists to avoid.
      const c = classifyGateFailure(
        entry.file,
        withCases({
          [entry.file]: [
            entry.caseName,
            "cuts the candidate from the LOCAL integration branch, and never fetches",
          ],
        }),
      );
      expect(c.klass).toBe("product");
    });

    it("stays product when the gate supplied no case attribution at all", () => {
      // Byte-identical to the behaviour before this branch existed.
      expect(classifyGateFailure(entry.file, ctx).klass).toBe("product");
    });

    it("stays product when the file failed with no parsed cases (a crash names nothing)", () => {
      expect(
        classifyGateFailure(entry.file, withCases({ [entry.file]: [] })).klass,
      ).toBe("product");
    });

    it("stays product for an UNREGISTERED file even when its cases parsed cleanly", () => {
      expect(
        classifyGateFailure(
          "lib/release/some-other.test.ts",
          withCases({ "lib/release/some-other.test.ts": ["anything at all"] }),
        ).klass,
      ).toBe("product");
    });

    it("stays product for a bare workspace, which names a whole suite and not one case", () => {
      expect(
        classifyGateFailure(
          "@papercusp/web",
          withCases({ "@papercusp/web": [entry.caseName] }),
        ).klass,
      ).toBe("product");
    });

    it("CALIBRATION: the registered case name is REALLY in the file it points at", () => {
      // Without this, every assertion above could be passing against a registry that
      // matches nothing at gate time — green, and completely inert.
      const source = readFileSync(join(REPO_ROOT, entry.repoPath), "utf8");
      expect(source).toContain(entry.caseName);
    });
  });
});
