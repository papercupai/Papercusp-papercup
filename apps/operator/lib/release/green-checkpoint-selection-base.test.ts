/**
 * green-checkpoint-selection-base.test.ts — P-011 / D-009
 * (gate-verdict-liveness-and-repair-reliability-2026-08-31).
 *
 * Pins the WIRING of the selection-base resolver into the gate's candidate-suite run:
 * `resolveSuiteSelectionBaseForRun` (the extracted choke point — the P-009
 * `augmentWithRepairTickLegs` pattern) and its containment at the one call site that
 * feeds `runGreen`'s `base` argument. The resolver's own decision table is pinned in
 * selection-base.test.ts; these tests cover only what the extraction added:
 * seam precedence, fault degradation, default-path fail-safety, input threading,
 * and the call-site containment itself.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveSuiteSelectionBaseForRun } from "./green-checkpoint";
import type { SelectionBaseInput, SelectionBaseResult } from "./selection-base";

const LAST_READY = "a".repeat(40);
const HEAD = "b".repeat(40);
const WATERMARK = "c".repeat(40);
const FROZEN = "d".repeat(40);

// Overridable so scripts/mutation-probe.sh can point the containment assertions at a
// COPY outside the tree (tier-2) rather than mutating this shared checkout.
const GREEN_CHECKPOINT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  process.env.PROBE_GREEN_CHECKPOINT ?? "./green-checkpoint.ts",
);

function makeDeps(
  resolver?: (
    input: SelectionBaseInput & { repo: string },
  ) => Promise<SelectionBaseResult>,
) {
  const lines: string[] = [];
  return {
    deps: {
      ...(resolver ? { resolveSelectionBase: resolver } : {}),
      log: (line: string) => {
        lines.push(line);
      },
    },
    lines,
  };
}

describe("resolveSuiteSelectionBaseForRun: seam precedence + provenance", () => {
  it("uses the injected resolver's base and logs the advanced provenance line", async () => {
    const { deps, lines } = makeDeps(async () => ({
      base: WATERMARK,
      source: "watermark",
      reason: "watermark",
    }));
    const base = await resolveSuiteSelectionBaseForRun(deps, "/unused", {
      lastReady: LAST_READY,
      judgedHead: HEAD,
    });
    expect(base).toBe(WATERMARK);
    expect(lines.join("\n")).toContain("SELECTION_BASE source=watermark");
    expect(lines.join("\n")).toContain(`advancedFrom=${LAST_READY.slice(0, 12)}`);
  });

  it("threads frozenCandidate and judgedHead through to the resolver", async () => {
    const seen: Array<SelectionBaseInput & { repo: string }> = [];
    const { deps } = makeDeps(async (input) => {
      seen.push(input);
      return { base: FROZEN, source: "frozen-verdict", reason: "frozen-verdict" };
    });
    const base = await resolveSuiteSelectionBaseForRun(deps, "/the-repo", {
      lastReady: LAST_READY,
      judgedHead: HEAD,
      frozenCandidate: FROZEN,
    });
    expect(base).toBe(FROZEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      repo: "/the-repo",
      lastReady: LAST_READY,
      judgedHead: HEAD,
      frozenCandidate: FROZEN,
    });
  });

  it("logs the fallback provenance line when the resolver falls back", async () => {
    const { deps, lines } = makeDeps(async () => ({
      base: LAST_READY,
      source: "last-ready",
      reason: "no-watermark",
    }));
    const base = await resolveSuiteSelectionBaseForRun(deps, "/unused", {
      lastReady: LAST_READY,
      judgedHead: HEAD,
    });
    expect(base).toBe(LAST_READY);
    expect(lines.join("\n")).toContain("source=last-ready");
    expect(lines.join("\n")).toContain("reason=no-watermark");
  });
});

describe("resolveSuiteSelectionBaseForRun: fault degradation (fail-safe, never narrower)", () => {
  it("degrades to lastReady and logs when the injected resolver THROWS", async () => {
    const { deps, lines } = makeDeps(async () => {
      throw new Error("resolver exploded");
    });
    const base = await resolveSuiteSelectionBaseForRun(deps, "/unused", {
      lastReady: LAST_READY,
      judgedHead: HEAD,
    });
    expect(base).toBe(LAST_READY);
    const log = lines.join("\n");
    expect(log).toContain("SELECTION_BASE resolver errored");
    expect(log).toContain("resolver exploded");
    expect(log).toContain("fail-safe, P-011/D-009");
  });

  it("default path (no injected resolver) degrades to lastReady in a non-git repo — never throws", async () => {
    const { deps, lines } = makeDeps();
    const base = await resolveSuiteSelectionBaseForRun(
      deps,
      "/nonexistent/selection-base-wiring-test-dir",
      { lastReady: LAST_READY, judgedHead: HEAD },
    );
    // The real git runner fails per-call → resolver reads that as no-watermark → the
    // historical pin. This is the exact behaviour every pre-existing fixture relies on.
    expect(base).toBe(LAST_READY);
    expect(lines.join("\n")).toContain("reason=no-watermark");
  });
});

describe("call-site containment (the wiring cannot silently drift)", () => {
  const src = readFileSync(GREEN_CHECKPOINT_PATH, "utf8");

  it("the candidate suite runs against the RESOLVED base, not the raw last-green pin", () => {
    expect(src).toContain("deps.runGreen(cfg.checkpointRoot, suiteSelectionBase, {");
  });

  it("the resolved base comes from the extracted helper at the suite call site", () => {
    expect(src).toContain(
      "await resolveSuiteSelectionBaseForRun(deps, cfg.checkpointRoot, {",
    );
  });

  it("the early-preflight short-circuit keeps the historical pin (no resolver work on a run that will not judge)", () => {
    // The short-circuit keys on `suiteSkipped`: an early preflight red skips the suite
    // UNLESS round one still measures it, and only a skipped suite keeps the raw pin.
    expect(src).toContain(
      "const suiteSkipped = earlyPreflightFailure !== null && !roundOneMeasuresSuite;",
    );
    expect(src).toContain("const suiteSelectionBase: string | null = suiteSkipped\n    ? lastReady");
  });
});
