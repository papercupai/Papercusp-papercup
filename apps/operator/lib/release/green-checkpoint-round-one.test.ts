import { describe, expect, it } from "vitest";
import {
  classifyEnvironmentDominatedInfraFault,
  classifyInfraFault,
  confirmSuiteEstimateSeedMs,
  repairSignatureFromVerdict,
} from "./green-checkpoint";

// P-016 (green-main-ratchet-convergence-2026-10-17#D-004) wiring in the gate.
describe("P-016 repairSignatureFromVerdict after an early typecheck red", () => {
  const typecheckPreflight = { status: "failed" };

  it("records no suite kinds when the early stop skipped the sweep (later rounds)", () => {
    expect(
      repairSignatureFromVerdict({ failingTests: ["lint:tsc"], typecheckPreflight }).measuredKinds,
    ).toEqual([]);
  });

  it("records the suite kinds when round 1 ran the sweep despite the early red", () => {
    const { measuredKinds, failingTests } = repairSignatureFromVerdict({
      failingTests: ["lint:tsc", "pkg/a.test.ts"],
      typecheckPreflight,
      suiteMeasured: true,
    });
    expect(measuredKinds).toEqual(["test-file", "workspace-task", "seed"]);
    expect(failingTests).toEqual(["lint:tsc", "pkg/a.test.ts"]);
  });

  it("an explicit suiteMeasured:false wins over a passing preflight", () => {
    expect(repairSignatureFromVerdict({ failingTests: [], suiteMeasured: false }).measuredKinds).toEqual([]);
  });
});

describe("P-016 environment-dominated infra fault", () => {
  const enospcRed = Array.from({ length: 6 }, (_, index) => [
    ` FAIL  packages/x/f${index}.test.ts > case`,
    "Error: ENOSPC: no space left on device, open '/tmp/vitest-cache/x'",
  ])
    .flat()
    .join("\n");

  it("renders no code verdict for a red dominated by ENOSPC", () => {
    const fault = classifyEnvironmentDominatedInfraFault(enospcRed);
    expect(fault).toMatchObject({ kind: "environment-dominated", occurrences: 6 });
    expect(fault?.note).toContain("6 of 6 failing file(s)");
  });

  it("is reached from classifyInfraFault when the disk sample shows nothing (space freed before sampling)", () => {
    // No disk policy/snapshots: classifyDiskInfraFault returns null, as it did for 54150acf.
    expect(classifyInfraFault(enospcRed, undefined)?.kind).toBe("environment-dominated");
  });

  it("leaves an ordinary red alone", () => {
    const red = " FAIL  packages/x/a.test.ts > case\nAssertionError: expected 1 to be 2";
    expect(classifyEnvironmentDominatedInfraFault(red)).toBeNull();
    expect(classifyInfraFault(red, undefined)).toBeNull();
  });
});

describe("run-level Vitest errors without file failures", () => {
  it("renders an inconclusive no-code verdict for a structured unhandled run error", () => {
    const output = [
      ">>> @papercusp/operator-core :: npm run test",
      "Errors  1 error",
      "Unhandled Errors",
      "⎯⎯⎯ Unhandled Rejection ⎯⎯⎯",
      "TypeError: fetch failed",
    ].join("\n");
    expect(classifyInfraFault(output)).toMatchObject({
      kind: "run-level-unhandled",
      occurrences: 1,
      note: expect.stringContaining("no code verdict"),
    });
  });

  it("does not infer a run-level fault from fetch text alone", () => {
    expect(classifyInfraFault("fetch failed")).toBeNull();
  });

  it("keeps a measured file failure red when the same invocation has an unhandled error", () => {
    const output = [
      ">>> @papercusp/operator-core :: npm run test",
      " FAIL  lib/known-failure.test.ts > real regression",
      "AssertionError: expected 1 to be 2",
      "Errors  1 error",
      "Unhandled Errors",
    ].join("\n");
    expect(classifyInfraFault(output)).toBeNull();
  });
});

// WI-41655's guard, now that only a repair-head round can skip the suite after an early red.
describe("WI-41655 / P-016 confirmSuiteEstimateSeedMs", () => {
  const nowMs = 10_000_000;
  const runStartedAtMs = nowMs - 55 * 60_000; // 55m of one-time setup spent
  const candidateSuiteStartedAtMs = nowMs - 2_000; // the suite itself took 2s

  it("a skipped suite falls back to the conservative whole-run figure", () => {
    expect(
      confirmSuiteEstimateSeedMs({ suiteSkipped: true, nowMs, runStartedAtMs, candidateSuiteStartedAtMs }),
    ).toBe(55 * 60_000);
  });

  it("a measured suite seeds from that suite alone, never charging setup", () => {
    expect(
      confirmSuiteEstimateSeedMs({ suiteSkipped: false, nowMs, runStartedAtMs, candidateSuiteStartedAtMs }),
    ).toBe(2_000);
  });

  it("never returns a zero estimate", () => {
    expect(
      confirmSuiteEstimateSeedMs({ suiteSkipped: false, nowMs, runStartedAtMs, candidateSuiteStartedAtMs: nowMs }),
    ).toBe(1);
  });
});
