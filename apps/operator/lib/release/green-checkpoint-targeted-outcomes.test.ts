import { describe, expect, it, vi } from "vitest";
import {
  measureTargetedGateRuns,
  RESCUE_TASK_TIMEOUT_FLOOR_MS,
  RESCUE_TASK_TIMEOUT_MAX_MS,
  rescueTaskWatchdogOptions,
  validateTargetedGateOutcomes,
  type TargetedGateResult,
} from "./green-checkpoint";

const HEAD = "a".repeat(40);

describe("targeted gate outcome evidence", () => {
  it("retains bounded stdout and stderr for a clean nonzero task, including failure before test reporting", async () => {
    const result = await measureTargetedGateRuns(["lint:broken", "lint:after"], async (script) => ({
      code: script === "lint:broken" ? 1 : 0,
      stdout: "x".repeat(10_000) + "\nSTDOUT-LAST-LINE",
      stderr: "y".repeat(10_000) + "\nCONFIG-LOAD-FAILED; module missing",
    }));
    expect(result.pass).toBe(false);
    expect(result.coverageComplete).toBe(true);
    const failed = result.perGate?.[0];
    expect(failed).toMatchObject({ id: "lint:broken", status: "fail" });
    expect(failed?.outputTail).toContain("STDOUT-LAST-LINE");
    expect(failed?.outputTail).toContain("CONFIG-LOAD-FAILED; module missing");
    expect(failed?.outputTail!.length).toBeLessThanOrEqual(2_000);
    expect(result.summary).toContain("CONFIG-LOAD-FAILED, module missing");
    expect(result.perGate?.[1]).toEqual({ id: "lint:after", status: "pass" });
  });

  it("names the failing test in both outputTail and summary, not npm's footer (WI-10007516)", async () => {
    // pipeline_events 601064's shape: vitest on stdout, ending in the source-map receipt;
    // npm's lifecycle footer on stderr. Pre-fix, both artifacts held only the footer.
    const failCase = "admission fix precheck exec > kills the backgrounded grandchild";
    const stdout = [
      ` FAIL  lib/release/admission-fix-precheck-exec.test.ts > ${failCase}`,
      "AssertionError: expected false to be true // Object.is equality",
      ...Array.from({ length: 40 }, (_, i) => `     ${i}|     frame line ${"·".repeat(40)}`),
      " Test Files  1 failed | 904 passed (905)",
      "[executed-source-map] written ws=@papercusp/operator-core rows=905 skipped=14 sha=f07043ba dirty=false",
    ].join("\n");
    const stderr = [
      "npm error Lifecycle script `test:lane-stateful` failed with error:",
      "npm error code 1",
      "npm error command failed",
      "npm error command sh -c PC_TEST_LANE=stateful ../../scripts/pc-heavy.sh -- vitest run --passWithNoTests",
    ].join("\n");
    const result = await measureTargetedGateRuns(["lint:broken"], async () => ({ code: 1, stdout, stderr }));
    const tail = result.perGate?.[0]?.outputTail ?? "";
    expect(tail.startsWith("lint:broken:  FAIL  lib/release/admission-fix-precheck-exec.test.ts")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(2_000);
    expect(result.summary).toContain(failCase);
    expect(result.summary).toContain("Test Files 1 failed");
    expect(result.summary).not.toContain("npm error");
    expect(result.summary).not.toContain("[executed-source-map]");
  });

  it("runs beyond the first failure and retains each task's actual result", async () => {
    const run = vi.fn(async (script: string) => ({ code: script === "lint:broken" ? 1 : 0 }));
    const result = await measureTargetedGateRuns(["lint:before", "lint:broken", "lint:after"], run);
    expect(run.mock.calls.map(([script]) => script)).toEqual(["lint:before", "lint:broken", "lint:after"]);
    expect(result).toMatchObject({
      pass: false,
      coverageComplete: true,
      perGate: [
        { id: "lint:before", status: "pass" },
        { id: "lint:broken", status: "fail" },
        { id: "lint:after", status: "pass" },
      ],
    });
  });

  it("executes a duplicate physical task once without duplicating its outcome", async () => {
    const run = vi.fn(async () => ({ code: 0 }));
    const result = await measureTargetedGateRuns(["lint:tsc", "lint:tsc"], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.perGate).toEqual([{ id: "lint:tsc", status: "pass" }]);
  });

  it("reports thrown and unmapped tasks as unmeasured, never successful coverage", async () => {
    const run = vi.fn(async (script: string) => {
      if (script === "lint:throws") throw new Error("spawn failed");
      return { code: 0 };
    });
    const result = await measureTargetedGateRuns(["lint:throws", "unmapped", "lint:after"], run);
    expect(result).toMatchObject({
      pass: false,
      coverageComplete: false,
      perGate: [
        { id: "lint:throws", status: "errored" },
        { id: "unmapped", status: "errored" },
        { id: "lint:after", status: "pass" },
      ],
    });
  });

  it("treats a registered non-gating NOT CHECKED leg as coverage-neutral, an unregistered exit 2 as fail (WI-10004928 / D-129)", async () => {
    // Exit 2 = EXIT_NOT_CHECKED. Only the registered diff-vs-HEAD detector is forgiven;
    // it examines nothing in the gate's clean checkout at EVERY head, so counting it as
    // missing coverage blocked every repair-round selectiveCoverage receipt.
    const run = vi.fn(async (script: string) => ({
      code: script === "lint:vimock-export-strands" || script === "lint:unregistered" ? 2 : 0,
    }));
    const result = await measureTargetedGateRuns(
      ["lint:vimock-export-strands", "lint:unregistered", "lint:after"],
      run,
    );
    expect(result).toMatchObject({
      pass: false,
      coverageComplete: true,
      perGate: [
        { id: "lint:vimock-export-strands", status: "not-checked" },
        { id: "lint:unregistered", status: "fail" },
        { id: "lint:after", status: "pass" },
      ],
    });
    // A not-checked leg beside an ERRORED one still leaves the measurement incomplete.
    const errored = await measureTargetedGateRuns(
      ["lint:vimock-export-strands", "lint:throws"],
      vi.fn(async (script: string) => {
        if (script === "lint:throws") throw new Error("spawn failed");
        return { code: 2 };
      }),
    );
    expect(errored.coverageComplete).toBe(false);
  });

  it("names WHY a leg errored in the summary instead of a bare ERRORED (WI-10003211)", async () => {
    const run = vi.fn(async (script: string) => {
      if (script === "lint:throws") {
        throw new Error(
          "npm run lint:throws timed out after 2700000ms; still busy\n--- last captured child output ---\n✓ a.test.ts",
        );
      }
      return { code: 0 };
    });
    const result = await measureTargetedGateRuns(["lint:throws", "lint:after"], run);
    expect(result.perGate?.[0]).toEqual({ id: "lint:throws", status: "errored" });
    // First line only, and the `;` summary separator is neutralized so one entry stays one entry.
    expect(result.summary).toContain(
      "lint:throws: ERRORED (npm run lint:throws timed out after 2700000ms, still busy)",
    );
    expect(result.summary).not.toContain("last captured child output");
  });

  const valid = (): TargetedGateResult => ({
    pass: false,
    summary: "one failure",
    measuredHead: HEAD,
    perGate: [{ id: "lint:a", status: "pass" }, { id: "lint:b", status: "fail" }],
  });

  it("accepts exact complete head-bound outcomes with matching aggregate", () => {
    const result = valid();
    expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toEqual(result.perGate);
  });

  it("does not accept an arbitrary gating task relabeled NOT CHECKED", () => {
    const result = valid();
    result.perGate![0]!.status = "not-checked";
    expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toBeNull();
  });

  it.each(["missing", "duplicate", "foreign", "head", "aggregate", "status"] as const)(
    "rejects %s evidence without discharging obligations",
    (kind) => {
      const result = valid();
      if (kind === "missing") result.perGate!.pop();
      if (kind === "duplicate") result.perGate![1] = result.perGate![0]!;
      if (kind === "foreign") result.perGate![1]!.id = "lint:foreign";
      if (kind === "head") result.measuredHead = "b".repeat(40);
      if (kind === "aggregate") result.pass = true;
      if (kind === "status") (result.perGate![0] as { status: string }).status = "unknown";
      expect(validateTargetedGateOutcomes(result, ["lint:a", "lint:b"], HEAD)).toBeNull();
    },
  );
});

describe("rescue task watchdog policy (WI-10003211)", () => {
  it("lets a still-progressing test task outlive the floor, bounded by the ceiling", () => {
    // The live failure: a whole `test:lane-stateful` rescue at the 2-fork gate cap was killed at
    // exactly the 45-min floor while still completing files. The floor must be an IDLE budget.
    const opts = rescueTaskWatchdogOptions("test:lane-stateful", {});
    expect(opts).toEqual({
      timeoutMs: RESCUE_TASK_TIMEOUT_FLOOR_MS,
      timeoutResetsOnProgress: true,
      hardTimeoutMs: RESCUE_TASK_TIMEOUT_MAX_MS,
      killProcessGroupOnTimeout: true,
    });
  });

  it("never kills earlier than the old absolute floor (monotone) and stays bounded", () => {
    for (const script of ["test", "test:lane-pure", "test:lane-stateful", "test:integration"]) {
      const opts = rescueTaskWatchdogOptions(script, {});
      // An idle window of >= the floor cannot expire before the floor has elapsed ...
      expect(opts.timeoutMs).toBeGreaterThanOrEqual(RESCUE_TASK_TIMEOUT_FLOOR_MS);
      // ... and the absolute ceiling is never below the idle window, and is finite.
      expect(opts.hardTimeoutMs).toBeGreaterThanOrEqual(opts.timeoutMs!);
      expect(opts.hardTimeoutMs).toBe(RESCUE_TASK_TIMEOUT_MAX_MS);
      expect(opts.killProcessGroupOnTimeout).toBe(true);
    }
  });

  it("keeps an explicit operator override as an ABSOLUTE deadline", () => {
    expect(rescueTaskWatchdogOptions("test:lane-stateful", { AFFECTED_BATCH_TIMEOUT_MS: "600000" })).toEqual({
      timeoutMs: 600_000,
      killProcessGroupOnTimeout: true,
    });
  });

  it("ignores an invalid override rather than treating it as absolute", () => {
    for (const bad of ["", "0", "-5", "soon"]) {
      expect(rescueTaskWatchdogOptions("test", { AFFECTED_BATCH_TIMEOUT_MS: bad }).timeoutResetsOnProgress).toBe(true);
    }
  });

  it("does not bound non-test scripts", () => {
    expect(rescueTaskWatchdogOptions("lint:tsc", {})).toEqual({});
  });
});
