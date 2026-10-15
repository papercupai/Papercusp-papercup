/**
 * P-005 stage 3 (green-main-cycle-time-2026-10-08#D-003 step 3): a repair round that finds a
 * whole test LANE red re-queues the lane's failing FILES, not the lane, so the next round re-runs
 * those files instead of the whole lane. Narrowing is refused whenever the lane's own output
 * cannot prove it names every failure, and a malformed narrowing never erases a red.
 */
import { describe, expect, it } from "vitest";
import {
  createFrozenCandidateRepairQueue,
  frozenRepairRoundExecution,
  selectFrozenRepairAdmissionPaths,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import {
  interpretRepairHeadMeasurements,
  measureTargetedGateRuns,
  narrowFailingTestLeg,
  soundNarrowedFiles,
  type TargetedGateOutcome,
  type TargetedGateResult,
} from "./green-checkpoint";

const WS = "@papercusp/operator-core";
const LANE = `${WS} :: test:lane-stateful`;
const A = "lib/release/a.test.ts";
const B = "lib/sync/b.test.ts";

/** A real-shaped red vitest run: colourised rollup rows, a FAIL row, one summary row. */
function redRun(files: readonly string[], opts: { counted?: number; extra?: string[] } = {}): string {
  return [
    ...files.map((f) => `\u001b[31m ❯\u001b[39m ${f} (12 tests | 1 failed) 85ms`),
    ...files.slice(0, 1).map((f) => ` FAIL  ${f} > suite > case`),
    "AssertionError: expected 1 to be 2",
    ...(opts.extra ?? []),
    `\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m${opts.counted ?? files.length} failed\u001b[39m\u001b[22m | 900 passed (902)`,
    `      Tests  ${files.length} failed | 8000 passed (8002)`,
  ].join("\n");
}

describe("narrowFailingTestLeg — narrows only when the output proves it names every failure", () => {
  it("narrows a single-summary red run to exactly the files it names", () => {
    expect(narrowFailingTestLeg("test:lane-stateful", [redRun([A, B]), "npm error code 1"])).toEqual({
      narrowed: true,
      files: [A, B],
    });
    expect(narrowFailingTestLeg("test", [redRun([A])])).toEqual({ narrowed: true, files: [A] });
  });

  it("keeps a non-test task whole", () => {
    expect(narrowFailingTestLeg("lint:tsc", [redRun([A])])).toEqual({ narrowed: false, reason: "not-a-test-script" });
  });

  it.each([
    ["a vitest worker-pool crash", "Error: [vitest-pool]: Worker forks emitted error."],
    ["an npm signal footer", "npm error signal SIGKILL"],
    ["a pure-lane shard signal", "VITEST_PURE_LANE_SHARD state=signaled shard=2/4"],
  ])("keeps the task whole after %s", (_name, line) => {
    expect(narrowFailingTestLeg("test:lane-stateful", [redRun([A], { extra: [line] })])).toEqual({
      narrowed: false,
      reason: "abnormal-termination",
    });
  });

  it("keeps the task whole when vitest reports unhandled errors (they belong to no file)", () => {
    expect(narrowFailingTestLeg("test", [redRun([A], { extra: ["      Errors  1 error"] })])).toEqual({
      narrowed: false,
      reason: "unhandled-errors",
    });
    expect(narrowFailingTestLeg("test", [redRun([A], { extra: ["⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯"] })])).toEqual({
      narrowed: false,
      reason: "unhandled-errors",
    });
  });

  it("keeps the task whole with no summary row, or with one per shard", () => {
    expect(narrowFailingTestLeg("test", [` FAIL  ${A} > x`])).toEqual({ narrowed: false, reason: "no-summary-row" });
    expect(narrowFailingTestLeg("test:lane-pure", [redRun([A]), redRun([B])])).toEqual({
      narrowed: false,
      reason: "multiple-summary-rows",
    });
  });

  it("keeps the task whole when the summary counts no failed file, or more files than it names", () => {
    expect(narrowFailingTestLeg("test", [" Test Files  12 passed (12)"])).toEqual({
      narrowed: false,
      reason: "no-failed-files-counted",
    });
    expect(narrowFailingTestLeg("test", [redRun([A], { counted: 2 })])).toEqual({
      narrowed: false,
      reason: "failing-file-count-mismatch",
    });
  });
});

describe("measureTargetedGateRuns — records the narrowing on the failed task", () => {
  it("a narrowed lane carries its files paired with the lane's workspace, and says so in the summary", async () => {
    const result = await measureTargetedGateRuns([LANE, "lint:after"], async (script) =>
      script === "test:lane-stateful" ? { code: 1, stdout: redRun([A, B]), stderr: "npm error code 1" } : { code: 0 });
    expect(result.perGate?.[0]).toMatchObject({
      id: LANE,
      status: "fail",
      narrowedFiles: [{ workspace: WS, file: A }, { workspace: WS, file: B }],
    });
    expect(result.perGate?.[0]?.narrowWithheld).toBeUndefined();
    expect(result.perGate?.[1]).toEqual({ id: "lint:after", status: "pass" });
    expect(result.summary).toContain(`${LANE}: FAIL [narrowed to 2 failing file(s)]`);
  });

  it("a lane that cannot be narrowed names why, and a failed lint leg carries no narrowing at all", async () => {
    const result = await measureTargetedGateRuns([LANE, "lint:broken"], async (script) =>
      script === "test:lane-stateful"
        ? { code: 1, stdout: redRun([A], { extra: ["npm error signal SIGTERM"] }) }
        : { code: 1, stdout: "lint failed" });
    expect(result.perGate?.[0]).toMatchObject({ id: LANE, status: "fail", narrowWithheld: "abnormal-termination" });
    expect(result.perGate?.[0]?.narrowedFiles).toBeUndefined();
    expect(result.summary).toContain(`${LANE}: FAIL [kept whole: abnormal-termination]`);
    expect(result.perGate?.[1]).not.toHaveProperty("narrowedFiles");
    expect(result.perGate?.[1]).not.toHaveProperty("narrowWithheld");
  });

  it("a passing lane carries no narrowing", async () => {
    const result = await measureTargetedGateRuns([LANE], async () => ({ code: 0, stdout: redRun([A]) }));
    expect(result.perGate).toEqual([{ id: LANE, status: "pass" }]);
  });
});

describe("soundNarrowedFiles — a malformed narrowing never replaces a task", () => {
  const ok: TargetedGateOutcome = { id: LANE, status: "fail", narrowedFiles: [{ workspace: WS, file: A }] };

  it("accepts a failed one-workspace task whose files are test paths of that workspace", () => {
    expect(soundNarrowedFiles(ok)).toEqual([{ workspace: WS, file: A }]);
  });

  it.each<[string, TargetedGateOutcome]>([
    ["a passing outcome", { ...ok, status: "pass" }],
    ["an errored outcome", { ...ok, status: "errored" }],
    ["an empty file list", { ...ok, narrowedFiles: [] }],
    ["a file of another workspace", { ...ok, narrowedFiles: [{ workspace: "@papercusp/operator-vite", file: A }] }],
    ["a path that is not a test file", { ...ok, narrowedFiles: [{ workspace: WS, file: "lib/release/a.ts" }] }],
    ["a registry id with no single workspace run", { id: "lint:tsc", status: "fail", narrowedFiles: [{ workspace: WS, file: A }] }],
  ])("rejects %s", (_name, outcome) => {
    expect(soundNarrowedFiles(outcome)).toBeNull();
  });
});

describe("interpretRepairHeadMeasurements — the next signature carries the lane's files, not the lane", () => {
  const candidate = "c".repeat(40);
  const interpret = (perGate: TargetedGateOutcome[]) => {
    const queue = createFrozenCandidateRepairQueue({ candidate, base: null, failingTests: [LANE], nowMs: 100 });
    const gateRun: TargetedGateResult = {
      pass: false,
      perGate,
      measuredHead: queue.repairHead,
      coverageComplete: true,
      summary: `${LANE}: FAIL`,
    };
    return interpretRepairHeadMeasurements({
      queue,
      fileList: [],
      gateList: [LANE],
      fileRun: undefined,
      gateRun,
      selection: selectFrozenRepairAdmissionPaths(queue),
      radiusCoverageComplete: true,
      radiusNote: "no admitted paths",
      executed: frozenRepairRoundExecution({ mode: "targeted", fileKeys: [], gateIds: [LANE], radiusMode: "cumulative" }),
    });
  };

  it("re-queues a narrowed lane as its failing files plus the workspace marker", () => {
    const verdict = interpret([{ id: LANE, status: "fail", narrowedFiles: [{ workspace: WS, file: A }, { workspace: WS, file: B }] }]);
    expect(verdict.kind).toBe("red");
    if (verdict.kind !== "red") return;
    expect(verdict.signature).toEqual([
      { kind: "test-file", id: A, recipe: `npm run test:file -- ${A}`, workspace: WS },
      { kind: "workspace-task", id: WS, recipe: `npm run test -w ${WS}`, workspace: WS },
      { kind: "test-file", id: B, recipe: `npm run test:file -- ${B}`, workspace: WS },
    ]);
    expect(verdict.failingTests).not.toContain(LANE);
  });

  it("keeps the lane id when the lane was not narrowed", () => {
    const verdict = interpret([{ id: LANE, status: "fail", narrowWithheld: "multiple-summary-rows" }]);
    expect(verdict.kind === "red" ? verdict.failingTests : []).toEqual([LANE]);
  });

  it("keeps the lane id when the narrowing is malformed", () => {
    const verdict = interpret([{ id: LANE, status: "fail", narrowedFiles: [{ workspace: "@papercusp/other", file: A }] }]);
    expect(verdict.kind === "red" ? verdict.failingTests : []).toEqual([LANE]);
  });
});
