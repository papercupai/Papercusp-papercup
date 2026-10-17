/**
 * green-main-ratchet-convergence-2026-10-17 P-004 (R-3) at the frozen repair head.
 *
 * The full suite's promotion rule treats a failing file covered by an active downgrade as
 * non-blocking. The selective repair-head verification must apply the SAME rule, or a queue
 * whose only remaining failures are downgraded stays red forever and never reaches the full
 * gate that would promote it. Fail-closed cases: no coverage, a critical-area row without its
 * acknowledgement, an unknown workspace directory, and an uncovered file beside a covered one.
 */
import { describe, expect, it } from "vitest";
import {
  createFrozenCandidateRepairQueue,
  frozenRepairRoundExecution,
  selectFrozenRepairAdmissionPaths,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import type {
  RatchetDowngrade,
  RepairDowngradeCoverage,
} from "@papercusp/operator-core/lib/release/promotion-ratchet";
import {
  checkpointResultMarkerPayload,
  interpretRepairHeadMeasurements,
  type CheckpointResult,
  type FailingFile,
  type TargetedFileResult,
  type TargetedGateResult,
} from "./green-checkpoint";

const WS = "@papercusp/ui";
const DIR = "packages/ui";
const A = "src/button.test.tsx";
const B = "src/menu.test.tsx";
const LANE = `${WS} :: test`;
const GATE_WS = "@papercusp/operator-core";
const GATE_FILE = "lib/release/green-checkpoint-health.test.ts";

const down = (testFile: string, extra: Partial<RatchetDowngrade> = {}): RatchetDowngrade => ({
  testFile,
  testCase: "",
  revokedAt: null,
  criticalArea: null,
  riskAcknowledgement: null,
  ...extra,
});

const coverage = (downgrades: RatchetDowngrade[]): RepairDowngradeCoverage => ({
  downgrades,
  dirByWorkspace: { [WS]: DIR, [GATE_WS]: "packages/operator-core" },
});

const candidate = "c".repeat(40);

function interpretFiles(files: FailingFile[], downgradeCoverage?: RepairDowngradeCoverage | null) {
  const queue = createFrozenCandidateRepairQueue({
    candidate,
    base: null,
    failingTests: files.map((f) => f.file),
    nowMs: 100,
  });
  const fileRun: TargetedFileResult = { pass: false, summary: "files: FAIL", measuredHead: queue.repairHead };
  return interpretRepairHeadMeasurements({
    queue,
    fileList: files,
    gateList: [],
    fileRun,
    gateRun: undefined,
    selection: selectFrozenRepairAdmissionPaths(queue),
    radiusCoverageComplete: true,
    radiusNote: "no admitted paths",
    executed: frozenRepairRoundExecution({
      mode: "targeted",
      fileKeys: files.map((f) => `${f.workspace} :: ${f.file}`),
      gateIds: [],
      radiusMode: "cumulative",
    }),
    ...(downgradeCoverage !== undefined ? { downgradeCoverage } : {}),
  });
}

describe("interpretRepairHeadMeasurements applies the promotion ratchet (P-004)", () => {
  it("stays red with no downgrade coverage (unchanged behaviour)", () => {
    const v = interpretFiles([{ workspace: WS, file: A }]);
    expect(v.kind).toBe("red");
    const nullCov = interpretFiles([{ workspace: WS, file: A }], null);
    expect(nullCov.kind).toBe("red");
  });

  it("goes selectively green when every failing file is downgraded, and says so", () => {
    const v = interpretFiles(
      [{ workspace: WS, file: A }, { workspace: WS, file: B }],
      coverage([down(`${DIR}/${A}`), down(`${DIR}/${B}`)]),
    );
    expect(v.kind).toBe("green");
    expect(v.summary).toContain("2 failing file(s) downgraded (non-blocking)");
    expect(v.summary).toContain("the full gate at");
  });

  it("keeps only the uncovered file (and its workspace marker) in the next signature", () => {
    const v = interpretFiles(
      [{ workspace: WS, file: A }, { workspace: WS, file: B }],
      coverage([down(`${DIR}/${A}`)]),
    );
    expect(v.kind).toBe("red");
    if (v.kind !== "red") return;
    expect(v.failingTests).toEqual([B, WS]);
    expect(v.summary).toContain("1 failing file(s) downgraded");
  });

  it("does not honour a critical-area downgrade without its risk acknowledgement", () => {
    const files = [{ workspace: GATE_WS, file: GATE_FILE }];
    const path = `packages/operator-core/${GATE_FILE}`;
    expect(interpretFiles(files, coverage([down(path, { criticalArea: "gate" })])).kind).toBe("red");
    expect(
      interpretFiles(files, coverage([down(path, { criticalArea: "gate", riskAcknowledgement: "gate: accepted" })])).kind,
    ).toBe("green");
  });

  it("covers nothing for a workspace whose directory is unknown", () => {
    const v = interpretFiles([{ workspace: "@papercusp/mystery", file: A }], coverage([down(`${DIR}/${A}`), down(A)]));
    expect(v.kind).toBe("red");
  });

  it("drops a downgraded file from a narrowed lane", () => {
    const queue = createFrozenCandidateRepairQueue({ candidate, base: null, failingTests: [LANE], nowMs: 100 });
    const gateRun: TargetedGateResult = {
      pass: false,
      perGate: [{ id: LANE, status: "fail", narrowedFiles: [{ workspace: WS, file: A }, { workspace: WS, file: B }] }],
      measuredHead: queue.repairHead,
      coverageComplete: true,
      summary: `${LANE}: FAIL`,
    };
    const run = (downgradeCoverage: RepairDowngradeCoverage) =>
      interpretRepairHeadMeasurements({
        queue,
        fileList: [],
        gateList: [LANE],
        fileRun: undefined,
        gateRun,
        selection: selectFrozenRepairAdmissionPaths(queue),
        radiusCoverageComplete: true,
        radiusNote: "no admitted paths",
        executed: frozenRepairRoundExecution({ mode: "targeted", fileKeys: [], gateIds: [LANE], radiusMode: "cumulative" }),
        downgradeCoverage,
      });
    const partial = run(coverage([down(`${DIR}/${A}`)]));
    expect(partial.kind === "red" ? partial.failingTests : []).toEqual([B, WS]);
    expect(run(coverage([down(`${DIR}/${A}`), down(`${DIR}/${B}`)])).kind).toBe("green");
  });
});

describe("the result marker keeps the ratchet counts but trims its samples (P-004)", () => {
  it("caps each sample list at 3 and names the compaction", () => {
    const many = Array.from({ length: 20 }, (_, i) => `${DIR}/src/f${i}.test.tsx`);
    const result = {
      green: false,
      reason: "not-green",
      candidate,
      promotionRatchet: {
        measured: true,
        blockingFailureCount: 20,
        downgradedFailingCount: 20,
        blocking: many,
        downgraded: many,
        ignoredDowngrades: [],
        promotedBecauseAllDowngraded: false,
      },
    } as unknown as CheckpointResult;
    const payload = checkpointResultMarkerPayload(result) as {
      promotionRatchet: { blockingFailureCount: number; blocking: string[]; downgraded: string[] };
      markerCompacted: { omitted: string[] };
    };
    expect(payload.promotionRatchet.blockingFailureCount).toBe(20);
    expect(payload.promotionRatchet.blocking).toHaveLength(3);
    expect(payload.promotionRatchet.downgraded).toHaveLength(3);
    expect(payload.markerCompacted.omitted).toContain("promotionRatchet(samples)");
  });
});
