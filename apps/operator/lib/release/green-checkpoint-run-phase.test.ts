/**
 * WI-6554700010029556 (owner #2439) — make the live green-checkpoint run legible.
 *
 * Measured 2026-10-26: a frozen-repair run (verify the repair head, then 26 repair-tick legs)
 * wrote `materializing` into its run-lock `phase.json` at the start of its pass and never wrote
 * another phase. For 2h+ every reader (dev:pipeline_position, release:trace, pc-heavy) reported
 * "materializing, last progress 15:34:29" for a run that had finished every test leg, and
 * pc-heavy kept the fleet clamped to one heavy slot the whole time.
 *
 * These tests pin the writer side:
 *   · the marker carries activity + leg, and pc-heavy's REAL shell parser still reads the
 *     phase from the richer marker (it uses a greedy `"phase":"…"` sed match);
 *   · a materialization borrows `materializing` and hands the caller's phase back;
 *   · the tick-leg runner reports each leg start, and a throwing reporter never fails it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginPublishedMaterialization,
  measureRepairTickLegs,
  readCheckpointRunPhaseMarker,
  withPublishedMaterialization,
  writeCheckpointRunPhase,
} from "./green-checkpoint";
import { runPhaseDetailFields } from "@papercusp/operator-core/lib/release-checkpoint-launch";

const HEAD = "a".repeat(40);
const PC_HEAVY = fileURLToPath(new URL("../../../../scripts/pc-heavy.sh", import.meta.url));

let lockDir: string;
beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "gc-run-phase-"));
});
afterEach(() => {
  rmSync(lockDir, { recursive: true, force: true });
});

const rawMarker = () => JSON.parse(readFileSync(join(lockDir, "phase.json"), "utf8")) as Record<string, unknown>;

/** Run pc-heavy's own `_gate_clamp_divisor` against `lockDir`, extracted verbatim from the
 *  script so this pins the parser that actually throttles the fleet, not a re-implementation. */
function pcHeavyDivisor(): string {
  const src = readFileSync(PC_HEAVY, "utf8");
  const fn = src.match(/^_gate_clamp_divisor\(\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  if (!fn) throw new Error("could not extract _gate_clamp_divisor from scripts/pc-heavy.sh");
  const r = spawnSync("bash", ["-c", `${fn}\n_gate_lockdir="$1"\n_gate_clamp_divisor`, "bash", lockDir], {
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

describe("writeCheckpointRunPhase detail", () => {
  it("persists activity and leg beside the phase and reads them back", () => {
    writeCheckpointRunPhase(lockDir, "suite", {
      activity: "repair-tick-legs",
      leg: { label: "lint:tsc", index: 1, total: 26 },
    });
    expect(rawMarker()).toMatchObject({
      phase: "suite",
      activity: "repair-tick-legs",
      leg: { label: "lint:tsc", index: 1, total: 26 },
      phaseProtocol: expect.any(Number),
      at: expect.any(String),
    });
    expect(readCheckpointRunPhaseMarker(lockDir)).toEqual({
      phase: "suite",
      activity: "repair-tick-legs",
      leg: { label: "lint:tsc", index: 1, total: 26 },
    });
  });

  it("keeps the bare marker shape when no detail is given", () => {
    writeCheckpointRunPhase(lockDir, "delivering");
    expect(Object.keys(rawMarker()).sort()).toEqual(["at", "phase", "phaseProtocol"]);
  });

  it("advances `at` on every leg transition, so progressAtMs moves with the run", async () => {
    writeCheckpointRunPhase(lockDir, "suite", { activity: "repair-tick-legs", leg: { label: "a", index: 1, total: 2 } });
    const first = Date.parse(rawMarker().at as string);
    await new Promise((r) => setTimeout(r, 5));
    writeCheckpointRunPhase(lockDir, "suite", { activity: "repair-tick-legs", leg: { label: "b", index: 2, total: 2 } });
    expect(Date.parse(rawMarker().at as string)).toBeGreaterThan(first);
  });

  it("pc-heavy's real parser still reads the phase from the richer marker", () => {
    writeCheckpointRunPhase(lockDir, "suite", {
      activity: "repair-tick-legs",
      leg: { label: "lint:plane-guards", index: 9, total: 26 },
    });
    expect(pcHeavyDivisor()).toBe("2");
    writeCheckpointRunPhase(lockDir, "materializing", { activity: "materialization" });
    expect(pcHeavyDivisor()).toBe("999999");
    writeCheckpointRunPhase(lockDir, "isolating");
    expect(pcHeavyDivisor()).toBe("4");
  });

  it("reads an absent, malformed or unknown-phase marker as null", () => {
    expect(readCheckpointRunPhaseMarker(lockDir)).toBeNull();
    writeFileSync(join(lockDir, "phase.json"), "{not json");
    expect(readCheckpointRunPhaseMarker(lockDir)).toBeNull();
    writeFileSync(join(lockDir, "phase.json"), JSON.stringify({ phase: "wedged" }));
    expect(readCheckpointRunPhaseMarker(lockDir)).toBeNull();
  });
});

describe("published materialization", () => {
  const noHeartbeat = () => () => {};

  it("borrows `materializing` for the duration and restores the caller's phase, activity and leg", async () => {
    writeCheckpointRunPhase(lockDir, "suite", {
      activity: "repair-tick-legs",
      leg: { label: "lint:tsc", index: 1, total: 26 },
    });
    let during: unknown;
    const out = await withPublishedMaterialization(
      lockDir,
      async () => {
        during = readCheckpointRunPhaseMarker(lockDir);
        return 42;
      },
      { heartbeat: noHeartbeat },
    );
    expect(out).toBe(42);
    expect(during).toEqual({ phase: "materializing", activity: "materialization" });
    expect(readCheckpointRunPhaseMarker(lockDir)).toEqual({
      phase: "suite",
      activity: "repair-tick-legs",
      leg: { label: "lint:tsc", index: 1, total: 26 },
    });
  });

  it("restores even when the materialization throws", async () => {
    writeCheckpointRunPhase(lockDir, "suite", { activity: "repair-head-verification" });
    await expect(
      withPublishedMaterialization(lockDir, async () => { throw new Error("setup failed"); }, { heartbeat: noHeartbeat }),
    ).rejects.toThrow("setup failed");
    expect(readCheckpointRunPhaseMarker(lockDir)).toEqual({ phase: "suite", activity: "repair-head-verification" });
  });

  it("leaves the marker to the caller when there was no measurement phase to restore", () => {
    const write = vi.fn(writeCheckpointRunPhase);
    beginPublishedMaterialization(lockDir, { write, heartbeat: noHeartbeat })();
    expect(write).toHaveBeenCalledTimes(1);
    writeCheckpointRunPhase(lockDir, "materializing");
    const write2 = vi.fn(writeCheckpointRunPhase);
    beginPublishedMaterialization(lockDir, { write: write2, heartbeat: noHeartbeat })();
    expect(write2).toHaveBeenCalledTimes(1);
    expect(readCheckpointRunPhaseMarker(lockDir)?.phase).toBe("materializing");
  });

  it("stops the heartbeat and restores exactly once", () => {
    writeCheckpointRunPhase(lockDir, "suite");
    const stop = vi.fn();
    const write = vi.fn(writeCheckpointRunPhase);
    const end = beginPublishedMaterialization(lockDir, { write, heartbeat: () => stop });
    end();
    end();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("measureRepairTickLegs onLegStart", () => {
  const io = (overrides: Partial<Parameters<typeof measureRepairTickLegs>[0]> = {}) => ({
    setupTree: vi.fn(async () => undefined),
    resolveHead: vi.fn(async () => HEAD),
    runScript: vi.fn(async () => ({ code: 0, tail: "" })),
    log: vi.fn(),
    now: () => 1_000,
    ...overrides,
  });

  it("reports every leg, in order, with its 1-based index and total", async () => {
    const onLegStart = vi.fn();
    const measured = await measureRepairTickLegs(io({ onLegStart }), HEAD, {
      "lint:tsc": ["lint:tsc"],
      "lint:migrations": ["lint:migrations"],
    });
    expect(measured).not.toBeNull();
    expect(onLegStart.mock.calls.map(([leg]) => leg)).toEqual([
      { label: "lint:tsc", index: 1, total: 2 },
      { label: "lint:migrations", index: 2, total: 2 },
    ]);
  });

  it("a throwing reporter never fails the measurement", async () => {
    const measured = await measureRepairTickLegs(
      io({ onLegStart: () => { throw new Error("disk full"); } }),
      HEAD,
      { "lint:tsc": ["lint:tsc"] },
    );
    expect(measured?.legs).toHaveLength(1);
  });
});

describe("runPhaseDetailFields (launch-side reader)", () => {
  it("projects a published activity and leg onto the probe result", () => {
    expect(
      runPhaseDetailFields({
        phase: "suite",
        activity: "repair-tick-legs",
        leg: { label: "lint:tsc", index: 3, total: 26 },
      }),
    ).toEqual({ current_activity: "repair-tick-legs", current_leg: { label: "lint:tsc", index: 3, total: 26 } });
  });

  it("drops absent or malformed detail rather than guessing", () => {
    expect(runPhaseDetailFields(null)).toEqual({});
    expect(runPhaseDetailFields({ phase: "suite" })).toEqual({});
    expect(runPhaseDetailFields({ phase: "suite", activity: "", leg: { label: "x", index: "1", total: 2 } })).toEqual({});
  });
});
