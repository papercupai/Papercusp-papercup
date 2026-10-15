import { describe, expect, it } from "vitest";
import { composeTemplates, resolveRequiresClosure, resolveSelection, validateTemplateSet } from "./composition.js";
import {
  PAPERCUSP_ANDROID_APP_TEMPLATE,
  PAPERCUSP_APP_TEMPLATE,
  PAPERCUSP_IPHONE_APP_TEMPLATE,
  PAPERCUSP_OPS_HIVES_TEMPLATE,
  REFERENCE_TEMPLATES,
  TAURI_DESKTOP_SHELL_TEMPLATE,
} from "./reference-templates.js";
import type { TemplateManifest } from "./template-manifest.js";

function aspect(id: string, over: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    id,
    version: "1.0.0",
    scope: "aspect",
    category: "data",
    summary: `${id} aspect`,
    components: [{ id: `${id}-lib`, version: "1.0.0" }],
    contracts: [],
    decisionPoints: [],
    composesWith: [],
    checks: [{ id: "smoke", run: "checks/smoke.test.ts" }],
    ...over,
  };
}

describe("validateTemplateSet", () => {
  it("accepts a set with unique ids and resolvable composesWith", () => {
    const a = aspect("a", { composesWith: ["b"] });
    const b = aspect("b");
    expect(validateTemplateSet([a, b])).toEqual({ ok: true, errors: [] });
  });

  it("collects invalid entries, duplicate ids, and dangling composesWith", () => {
    const a = aspect("a", { composesWith: ["ghost"] });
    const { ok, errors } = validateTemplateSet([a, aspect("a"), { junk: true }]);
    expect(ok).toBe(false);
    expect(errors).toContain("entry[1]: duplicate template id 'a'");
    expect(errors).toContain("'a' composesWith unknown template 'ghost'");
    expect(errors.some((e) => e.startsWith("entry[2]: "))).toBe(true);
  });

  it("allowExternalComposesWith accepts a chosen SUBSET whose aspects name outside apps (WI-2881) — requires stays hard", () => {
    // A web-only chosen set: the aspect's composesWith names an app the set
    // deliberately excludes. Strict (registry) mode rejects; subset mode passes.
    const a = aspect("a", { composesWith: ["papercusp-tauri-desktop-shell"] });
    expect(validateTemplateSet([a]).errors).toContain("'a' composesWith unknown template 'papercusp-tauri-desktop-shell'");
    expect(validateTemplateSet([a], { allowExternalComposesWith: true })).toEqual({ ok: true, errors: [] });
    // requires is NOT relaxed by the flag.
    const withReq = { ...aspect("r"), requires: [{ id: "missing", version: "0.1.0" }] };
    expect(
      validateTemplateSet([withReq], { allowExternalComposesWith: true }).errors.join(";"),
    ).toContain("requires unknown template 'missing'");
  });
});

describe("composeTemplates", () => {
  it("rejects an empty selection", () => {
    expect(composeTemplates([])).toEqual({
      ok: false,
      errors: ["composition requires at least one template"],
      composition: null,
    });
  });

  it("rejects duplicate templates and two ROOT app-scope templates", () => {
    const app1 = aspect("app-one", { scope: "app", components: [], composesWith: ["x"] });
    const app2 = aspect("app-two", { scope: "app" });
    const dup = composeTemplates([app1, app1]);
    expect(dup.ok).toBe(false);
    expect(dup.errors).toContain("duplicate template 'app-one' in the composition");
    const twoApps = composeTemplates([app1, app2]);
    expect(twoApps.ok).toBe(false);
    expect(twoApps.errors).toContain(
      "at most ONE ROOT app-scope template per composition — got 'app-one', 'app-two' (an app template may only join another's composition as its requires-BASE)",
    );
  });

  it("P-022: an app template may require another app template as its BASE — the root owns the composition", () => {
    const base = aspect("base-app", { scope: "app", components: [] });
    const derived = aspect("derived-app", {
      scope: "app",
      components: [],
      requires: [{ id: "base-app", version: "1.0.0" }],
    });
    const { ok, errors, composition } = composeTemplates([base, derived]);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("app");
    expect(composition!.appTemplateId).toBe("derived-app"); // the ROOT, not the base
    // the base's checks still join the union
    expect(composition!.checks.map((c) => c.templateId).sort()).toEqual(["base-app", "derived-app"]);

    // two DERIVED apps over one shared base = two roots — still rejected
    const second = aspect("second-app", {
      scope: "app",
      components: [],
      requires: [{ id: "base-app", version: "1.0.0" }],
    });
    const twoRoots = composeTemplates([base, derived, second]);
    expect(twoRoots.ok).toBe(false);
    expect(twoRoots.errors.join(";")).toContain("at most ONE ROOT app-scope template");

    // mutual requires between apps = no root — rejected as a cycle
    const x = aspect("x-app", { scope: "app", components: [], requires: [{ id: "y-app", version: "1.0.0" }] });
    const y = aspect("y-app", { scope: "app", components: [], requires: [{ id: "x-app", version: "1.0.0" }] });
    expect(composeTemplates([x, y]).errors.join(";")).toContain("requires cycle — no root app");
  });

  it("flags component pin conflicts instead of silently resolving them", () => {
    const a = aspect("a", { components: [{ id: "shared", version: "1.0.0" }] });
    const b = aspect("b", { components: [{ id: "shared", version: "2.0.0" }] });
    const { ok, errors } = composeTemplates([a, b]);
    expect(ok).toBe(false);
    expect(errors).toContain("component pin conflict on 'shared': 'a' pins 1.0.0, 'b' pins 2.0.0");
  });

  it("dedupes agreeing component refs and unions everything tagged by source", () => {
    const a = aspect("a", {
      components: [{ id: "shared", version: "1.0.0" }, { id: "a-lib", version: "1.0.0" }],
      blueprints: ["a-print"],
      contracts: ["a-contract"],
      decisionPoints: [{ id: "a-choice", prompt: "?" }],
    });
    const b = aspect("b", { components: [{ id: "shared", version: "1.0.0" }] });
    const { ok, composition } = composeTemplates([a, b]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("aspect");
    expect(composition!.appTemplateId).toBeUndefined();
    expect(composition!.components).toEqual([
      { id: "shared", version: "1.0.0" },
      { id: "a-lib", version: "1.0.0" },
    ]);
    expect(composition!.blueprints).toEqual([{ templateId: "a", item: "a-print" }]);
    expect(composition!.contracts).toEqual([{ templateId: "a", item: "a-contract" }]);
    expect(composition!.decisionPoints).toEqual([{ templateId: "a", item: { id: "a-choice", prompt: "?" } }]);
    // The union-of-checks: same check id from two templates stays TWO entries.
    expect(composition!.checks).toEqual([
      { templateId: "a", item: { id: "smoke", run: "checks/smoke.test.ts" } },
      { templateId: "b", item: { id: "smoke", run: "checks/smoke.test.ts" } },
    ]);
  });
});

describe("the reference composition (P-014 acceptance: template #1 as a 3-way split)", () => {
  it("REFERENCE_TEMPLATES validates as a set (all composesWith resolve)", () => {
    expect(validateTemplateSet(REFERENCE_TEMPLATES)).toEqual({ ok: true, errors: [] });
  });

  // Template #1's composition is now reached by ANSWERING papercusp-app's
  // decision points, not by picking one of four fixed roots (plan
  // unified-app-template-2026-08-23, P-002/P-003/P-004). `target: desktop` +
  // `agents: pots` is the selection that the retired papercusp-agentic-desktop-app
  // root used to name, so this is the same composition reached a different way —
  // which is exactly what the retirement had to preserve.
  const template1 = () =>
    resolveSelection(PAPERCUSP_APP_TEMPLATE, { target: "desktop", agents: "pots" }, REFERENCE_TEMPLATES).templates;

  it("papercusp-app with target:desktop + agents:pots composes, and papercusp-app is the single ROOT app", () => {
    const { ok, errors, composition } = composeTemplates(template1());
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("app");
    expect(composition!.appTemplateId).toBe("papercusp-app");
    // RETIREMENT EQUIVALENCE: this is byte-for-byte the component set the
    // retired papercusp-agentic-desktop-app root produced. The four old roots
    // were named compositions, so collapsing them must not change what an app
    // is built from — only how it is asked for.
    expect(composition!.components.map((c) => c.id).sort()).toEqual([
      "dock-workbench",
      "embedded-pg-discovery",
      "embedded-postgres-server",
      "hono-host",
      "lexicon",
      "papergrid",
      "pot-app-seam",
      "tauri-release-kit",
      "tauri-shell",
      "typed-contracts",
      "ui-primitives",
    ]);
  });

  it("the union-of-checks carries every selected member's checks — chassis and agent plane included", () => {
    const { composition } = composeTemplates(template1());
    const keys = composition!.checks.map((c) => `${c.templateId}:${c.item.id}`).sort();
    expect(keys).toEqual([
      "papercusp-app:composition-integrity",
      "papercusp-app:package-test-targets",
      "papercusp-data-layer:components-integrated",
      "papercusp-ops-pots:confinement-guard",
      "papercusp-ops-pots:gym-signals",
      "papercusp-ops-pots:operation-first-triggers",
      "papercusp-ops-pots:seam-round-trip",
      "papercusp-tauri-desktop-shell:boot-e2e",
      "papercusp-ui:components-integrated",
      "papercusp-ui:theme-tokens",
    ]);
    // The old two-app stack carried composition-integrity TWICE (once for the
    // agentic root, once for the desktop base). One root ⇒ one.
    expect(keys.filter((k) => k.endsWith(":composition-integrity"))).toEqual(["papercusp-app:composition-integrity"]);
  });

  it("aspects also compose WITHOUT the app template (aspect-only composition)", () => {
    const { ok, composition } = composeTemplates([PAPERCUSP_OPS_HIVES_TEMPLATE, TAURI_DESKTOP_SHELL_TEMPLATE]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("aspect");
    expect(composition!.appTemplateId).toBeUndefined();
    // papercusp-app reaches both chassis and the agent plane by composesWith —
    // the chassis pair is what `target` selects between.
    expect(PAPERCUSP_APP_TEMPLATE.composesWith).toEqual(
      expect.arrayContaining(["papercusp-tauri-desktop-shell", "papercusp-web-host", "papercusp-ops-pots"]),
    );
  });
});

/**
 * The P-022 BASE-app rule, on a SYNTHETIC pair.
 *
 * `composeTemplates` still implements it: an app-scope template may REQUIRE
 * another app-scope template, and the required one joins the composition as a
 * member without owning it. As of the four-root retirement (plan
 * unified-app-template-2026-08-23, P-004) NO reference pair exercises it —
 * papercusp-agentic-desktop-app-over-papercusp-desktop-app was the only one, and
 * the `agents` decision point replaced it with an ASPECT join. So the rule is
 * covered here with controlled inputs rather than silently going untested; if a
 * future reference set reintroduces a real base-app pair, assert on that too
 * instead of replacing this.
 */
describe("composeTemplates: the base-app rule (P-022) — synthetic, no reference pair survives", () => {
  const app = (id: string, over: Partial<TemplateManifest> = {}) =>
    aspect(id, { scope: "app", category: "app", ...over });

  it("a required BASE app is a member but never the owner — the root app owns the composition", () => {
    const base = app("base-app");
    const root = app("root-app", { requires: [{ id: "base-app", version: "1.0.0" }] });
    const { ok, errors, composition } = composeTemplates([base, root]);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
    expect(composition!.scope).toBe("app");
    expect(composition!.appTemplateId).toBe("root-app");
    // Both app templates' checks are in the union — the base is a real member.
    expect(composition!.checks.map((c) => c.templateId).sort()).toEqual(["base-app", "root-app"]);
  });

  it("two INDEPENDENT app roots are still the 'two scaffolds cannot both own an app' conflict", () => {
    const { ok, errors } = composeTemplates([app("one"), app("two")]);
    expect(ok).toBe(false);
    expect(errors.join(";")).toContain("at most ONE ROOT app-scope template");
  });

  it("app templates in a requires CYCLE leave no root", () => {
    const x = app("x", { requires: [{ id: "y", version: "1.0.0" }] });
    const y = app("y", { requires: [{ id: "x", version: "1.0.0" }] });
    const { ok, errors } = composeTemplates([x, y]);
    expect(ok).toBe(false);
    expect(errors.join(";")).toContain("no root app");
  });
});

describe("the official mobile app roots (official-mobile-app-templates P-015)", () => {
  const cases = [
    {
      root: PAPERCUSP_ANDROID_APP_TEMPLATE,
      closure: ["papercusp-mobile-base", "papercusp-android-shell", "papercusp-android-app"],
      checks: [
        "papercusp-mobile-base:mobile-base-contract",
        "papercusp-mobile-base:mobile-base-commands",
        "papercusp-android-shell:android-shell-contract",
        "papercusp-android-shell:android-shell-assertions",
        "papercusp-android-app:composition-integrity",
      ],
    },
    {
      root: PAPERCUSP_IPHONE_APP_TEMPLATE,
      closure: ["papercusp-mobile-base", "papercusp-iphone-shell", "papercusp-iphone-app"],
      checks: [
        "papercusp-mobile-base:mobile-base-contract",
        "papercusp-mobile-base:mobile-base-commands",
        "papercusp-iphone-shell:iphone-shell-contract",
        "papercusp-iphone-shell:iphone-shell-assertions",
        "papercusp-iphone-app:composition-integrity",
      ],
    },
  ];

  for (const { root, closure, checks } of cases) {
    it(`${root.id} resolves the exact pinned closure and additive check union`, () => {
      expect(root.scope).toBe("app");
      expect(root.category).toBe("app");
      expect(root.requires).toEqual(
        closure.slice(0, -1).map((id) => ({ id, version: "0.1.0" })),
      );

      const resolved = resolveRequiresClosure([root], REFERENCE_TEMPLATES);
      expect(resolved).toMatchObject({ ok: true, errors: [] });
      expect(resolved.templates.map((template) => template.id)).toEqual(closure);

      const composed = composeTemplates(resolved.templates);
      expect(composed).toMatchObject({ ok: true, errors: [] });
      expect(composed.composition?.scope).toBe("app");
      expect(composed.composition?.appTemplateId).toBe(root.id);
      expect(composed.composition?.components.map((component) => component.id)).toEqual([
        "rust-uniffi-mobile-base",
      ]);
      expect(
        composed.composition?.checks.map((check) => `${check.templateId}:${check.item.id}`),
      ).toEqual(checks);
    });
  }
});

describe("P-015 — requires: hard pinned cross-template deps", () => {
  it("validateTemplateSet resolves requires refs and checks the pin", () => {
    const b = aspect("b");
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }] });
    expect(validateTemplateSet([a, b])).toEqual({ ok: true, errors: [] });
    expect(validateTemplateSet([a]).errors.join(";")).toContain("requires unknown template 'b'");
    const stale = aspect("a", { requires: [{ id: "b", version: "9.9.9" }] });
    expect(validateTemplateSet([stale, b]).errors.join(";")).toContain("stale pin");
  });

  it("composeTemplates enforces closure completeness (requires satisfied IN the selection)", () => {
    const b = aspect("b");
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }] });
    expect(composeTemplates([a, b]).ok).toBe(true);
    const missing = composeTemplates([a]);
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(";")).toContain("not in the composition");
    const wrongPin = composeTemplates([aspect("a", { requires: [{ id: "b", version: "2.0.0" }] }), b]);
    expect(wrongPin.ok).toBe(false);
    expect(wrongPin.errors.join(";")).toContain("stale pin");
  });

  it("resolveRequiresClosure expands roots dep-first, deduped", () => {
    const c = aspect("c");
    const b = aspect("b", { requires: [{ id: "c", version: "1.0.0" }] });
    const a = aspect("a", { requires: [{ id: "b", version: "1.0.0" }, { id: "c", version: "1.0.0" }] });
    const res = resolveRequiresClosure([a], [a, b, c]);
    expect(res.ok).toBe(true);
    expect(res.templates.map((t) => t.id)).toEqual(["c", "b", "a"]);
    // the closure then composes clean
    expect(composeTemplates(res.templates).ok).toBe(true);
  });

  it("resolveRequiresClosure errors on unknown ref, stale pin, and cycles", () => {
    const a = aspect("a", { requires: [{ id: "ghost", version: "1.0.0" }] });
    expect(resolveRequiresClosure([a], [a]).errors.join(";")).toContain("unknown template 'ghost'");

    const b = aspect("b");
    const stale = aspect("a", { requires: [{ id: "b", version: "0.0.9" }] });
    expect(resolveRequiresClosure([stale], [stale, b]).errors.join(";")).toContain("stale pin");

    const x = aspect("x", { requires: [{ id: "y", version: "1.0.0" }] });
    const y = aspect("y", { requires: [{ id: "x", version: "1.0.0" }] });
    expect(resolveRequiresClosure([x], [x, y]).errors.join(";")).toContain("requires cycle");
  });

  it("the reference set: papercusp-app's requires-closure is the INVARIANT half only — the chassis is selected, not required", () => {
    const res = resolveRequiresClosure([PAPERCUSP_APP_TEMPLATE], REFERENCE_TEMPLATES);
    expect(res.ok).toBe(true);
    // Data + UI are hard requires, so they are in the closure unconditionally.
    // NEITHER chassis is — that is the whole point of the `target` decision
    // point, and it is why one root can serve desktop, web, or both.
    expect(new Set(res.templates.map((t) => t.id))).toEqual(
      new Set(["papercusp-app", "papercusp-data-layer", "papercusp-ui"]),
    );
    expect(res.templates[res.templates.length - 1]!.id).toBe("papercusp-app"); // deps first

    // And the requires-closure ALONE is deliberately NOT composable: `target`
    // is a REQUIRED selecting decision point, so a chassis-less papercusp-app is
    // refused with the same force a stale pin would be. That refusal is what
    // makes "the chassis is selected, not required" safe — the chassis cannot
    // be silently omitted, only chosen.
    const bare = composeTemplates(res.templates);
    expect(bare.ok).toBe(false);
    expect(bare.errors.join(";")).toContain("decision point 'target' selects a REQUIRED template axis");

    // Answering it composes.
    const answered = resolveSelection(PAPERCUSP_APP_TEMPLATE, { target: "web" }, REFERENCE_TEMPLATES);
    expect(answered.ok).toBe(true);
    const composed = composeTemplates(answered.templates);
    expect(composed.errors).toEqual([]);
    expect(composed.ok).toBe(true);
    expect(composed.composition!.appTemplateId).toBe("papercusp-app");
  });
});

/**
 * SELECTING decision points (plan unified-app-template-2026-08-23, D-001).
 *
 * These cover the SEMANTICS at the unit level; the papercusp-app template's own
 * shipped check covers the same rules against the real registry. Both matter:
 * the shipped check would still pass if the rule were vacuously true, so the
 * negative cases live here, where the inputs are controlled.
 */
describe("selecting decision points (D-001)", () => {
  const chassisA = aspect("chassis-a", { checks: [{ id: "boot-a", run: "checks/boot.test.ts" }] });
  const chassisB = aspect("chassis-b", { checks: [{ id: "boot-b", run: "checks/boot.test.ts" }] });
  const plane = aspect("plane", { checks: [{ id: "seam", run: "checks/seam.test.ts" }] });
  const shared = aspect("shared");

  /** A root whose chassis axis is REQUIRED (no empty option) and combinable. */
  const root = (over: Partial<TemplateManifest> = {}): TemplateManifest =>
    aspect("root", {
      scope: "app",
      category: "app",
      components: [],
      composesWith: ["chassis-a", "chassis-b", "shared"],
      requires: [{ id: "shared", version: "1.0.0" }],
      decisionPoints: [
        {
          id: "target",
          prompt: "which chassis?",
          selects: {
            arity: "one-or-more",
            options: [
              { value: "a", templates: [{ id: "chassis-a", version: "1.0.0" }] },
              { value: "b", templates: [{ id: "chassis-b", version: "1.0.0" }] },
            ],
          },
        },
      ],
      ...over,
    });

  const strictRoot = (): TemplateManifest =>
    root({
      decisionPoints: [
        {
          id: "target",
          prompt: "which chassis?",
          selects: {
            options: [
              { value: "a", templates: [{ id: "chassis-a", version: "1.0.0" }] },
              { value: "b", templates: [{ id: "chassis-b", version: "1.0.0" }] },
            ],
          },
        },
      ],
    });

  const optionalRoot = (): TemplateManifest =>
    root({
      decisionPoints: [
        {
          id: "agents",
          prompt: "agent plane?",
          selects: {
            options: [
              { value: "none", templates: [] },
              { value: "pots", templates: [{ id: "plane", version: "1.0.0" }] },
            ],
          },
        },
      ],
    });

  const registry = [root(), chassisA, chassisB, plane, shared];

  describe("composeTemplates enforces the selection structurally", () => {
    it("REJECTS a composition satisfying no option of a required axis", () => {
      const { ok, errors } = composeTemplates([root(), shared]);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("'target' selects a REQUIRED template axis");
    });

    it("ACCEPTS a composition satisfying one option", () => {
      expect(composeTemplates([root(), shared, chassisA]).ok).toBe(true);
    });

    it("ACCEPTS both options when arity is 'one-or-more'", () => {
      expect(composeTemplates([root(), shared, chassisA, chassisB]).ok).toBe(true);
    });

    it("REJECTS two options when arity is 'one' (the default)", () => {
      const { ok, errors } = composeTemplates([strictRoot(), shared, chassisA, chassisB]);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("arity 'one'");
    });

    it("an EMPTY option makes the axis optional — zero chosen is legal", () => {
      expect(composeTemplates([optionalRoot(), shared]).ok).toBe(true);
      expect(composeTemplates([optionalRoot(), shared, plane]).ok).toBe(true);
    });

    it("reports a STALE PIN distinctly, not as 'you forgot to add it'", () => {
      const bumped = aspect("chassis-a", { version: "2.0.0" });
      const { ok, errors } = composeTemplates([root(), shared, bumped]);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("stale pin");
    });
  });

  describe("resolveSelection expands answers into the full closure", () => {
    it("pulls in the answered chassis and NOT the other", () => {
      const res = resolveSelection(root(), { target: "a" }, registry);
      expect(res.ok, res.errors.join("; ")).toBe(true);
      const ids = res.templates.map((t) => t.id);
      expect(ids).toContain("chassis-a");
      expect(ids).not.toContain("chassis-b");
      expect(ids).toContain("shared");
      expect(res.selections).toEqual([{ decisionPointId: "target", templateId: "root", values: ["a"] }]);
    });

    it("combines answers, and the check union carries BOTH chassis suites", () => {
      const res = resolveSelection(root(), { target: ["a", "b"] }, registry);
      expect(res.ok, res.errors.join("; ")).toBe(true);
      const composed = composeTemplates(res.templates);
      expect(composed.ok).toBe(true);
      const ids = composed.composition!.checks.map((c) => `${c.templateId}:${c.item.id}`);
      expect(ids).toContain("chassis-a:boot-a");
      expect(ids).toContain("chassis-b:boot-b");
    });

    it("ERRORS on an unanswered required axis rather than defaulting a chassis", () => {
      const { ok, errors } = resolveSelection(root(), {}, registry);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("is unanswered");
    });

    it("ERRORS on an unknown answer, naming what was expected", () => {
      const { ok, errors } = resolveSelection(root(), { target: "mainframe" }, registry);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("unknown answer 'mainframe'");
      expect(errors.join("; ")).toContain("'a'");
    });

    it("ERRORS on several answers to an arity 'one' axis", () => {
      const strict = strictRoot();
      const { ok, errors } = resolveSelection(strict, { target: ["a", "b"] }, [strict, chassisA, chassisB, shared]);
      expect(ok).toBe(false);
      expect(errors.join("; ")).toContain("arity 'one'");
    });

    it("an OPTIONAL axis left unanswered resolves fine", () => {
      const optional = optionalRoot();
      const res = resolveSelection(optional, {}, [optional, plane, shared]);
      expect(res.ok, res.errors.join("; ")).toBe(true);
      expect(res.templates.map((t) => t.id)).not.toContain("plane");
    });

    it("follows a NESTED select — a template an answer pulls in may itself select", () => {
      const leaf = aspect("leaf");
      const middle = aspect("middle", {
        decisionPoints: [
          {
            id: "extra",
            prompt: "extra?",
            selects: {
              options: [
                { value: "none", templates: [] },
                { value: "leaf", templates: [{ id: "leaf", version: "1.0.0" }] },
              ],
            },
          },
        ],
      });
      const nesting = root({
        decisionPoints: [
          {
            id: "target",
            prompt: "which chassis?",
            selects: {
              options: [
                { value: "m", templates: [{ id: "middle", version: "1.0.0" }] },
                { value: "a", templates: [{ id: "chassis-a", version: "1.0.0" }] },
              ],
            },
          },
        ],
      });
      const res = resolveSelection(nesting, { target: "m", extra: "leaf" }, [nesting, middle, leaf, chassisA, shared]);
      expect(res.ok, res.errors.join("; ")).toBe(true);
      expect(res.templates.map((t) => t.id)).toEqual(expect.arrayContaining(["middle", "leaf"]));
    });
  });

  it("the REAL papercusp-app root behaves this way against the reference registry", () => {
    const real = REFERENCE_TEMPLATES.find((t) => t.id === "papercusp-app")!;
    expect(real).toBeDefined();
    const web = resolveSelection(real, { target: "web" }, REFERENCE_TEMPLATES);
    expect(web.ok, web.errors.join("; ")).toBe(true);
    expect(web.templates.map((t) => t.id)).toContain("papercusp-web-host");
    expect(web.templates.map((t) => t.id)).not.toContain("papercusp-tauri-desktop-shell");
    expect(resolveSelection(real, {}, REFERENCE_TEMPLATES).ok).toBe(false);
  });
});
