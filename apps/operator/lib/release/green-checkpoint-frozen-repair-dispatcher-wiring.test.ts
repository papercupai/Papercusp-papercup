/**
 * WI-10000758 — the frozen-repair DISPATCHER must be wired whenever the reservation trio is.
 *
 * `dispatchFrozenRepair` (green-checkpoint.ts) optional-chains `deps.dispatchFrozenRepairFixer`,
 * so a production wiring that supplies reserve/renew/finalize but NOT the dispatcher does not
 * fail — it takes the reservation, gets `fired = null`, releases the reservation and logs
 * "fixer dispatch did not return a spawn … queue remains unassigned for retry", forever.
 * That is exactly what sweep c076b0dd95 (2026-09-04) did by deleting the dispatcher together
 * with the repair-worktree code: `attempts` stayed 0 across 14 consecutive reds, and because
 * `recordCheckpointVerdict`'s own dispatch is gated `!verdict.repairQueue`, no path at all
 * could spawn a fixer for a frozen candidate.
 *
 * The guard is at the WIRING, not the call site: a call-site guard cannot see what the
 * production deps object omits.
 *
 * WI-10007408 — the same sweep ALSO deleted the fixer liveness probe
 * (`frozenRepairFixerAlive`) and the dead-fixer classifier (`classifyDeadFrozenRepairFixer`),
 * and only the dispatcher came back. With the probe absent the gate read `fixerAlive` as
 * `undefined`; the queue policy re-dispatches only on `=== false`, so a dead fixer was
 * `wait-for-fixer` / "unknown" on every tick, forever (candidate ad82b273, 2026-10-08: 13h
 * behind a dead release-fixer). Every frozen-repair dep the gate optional-chains is pinned
 * here, present iff the reservation trio is.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATE_VERDICT_HARNESS_ENV,
  GATE_VERDICT_WORKSPACE_ENV,
} from "@papercusp/operator-core/lib/release/gate-verdict-target";
import type { FrozenCandidateRepairQueue } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

const dispatchReleaseFixer = vi.fn(
  async (..._args: unknown[]): Promise<{ spawnId: string | null; runId: string | null } | null> => ({
    spawnId: "s-wiring-test",
    runId: "r-wiring-test",
  }),
);

vi.mock(
  "@papercusp/operator-core/lib/harness/routines/release-actions",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@papercusp/operator-core/lib/harness/routines/release-actions")
    >()),
    dispatchReleaseFixer,
  }),
);

const ORG_SQL = { orgSqlSentinel: true };
const releaseFixerSpawnAlive = vi.fn(async (): Promise<boolean | null> => false);
const classifyDeadReleaseFixerSpawn = vi.fn(
  async (): Promise<{ infrastructure: boolean; reason: string } | null> => ({
    infrastructure: true,
    reason: "wiring-test",
  }),
);

vi.mock("@papercusp/db-org", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@papercusp/db-org")>()),
  getOrgPg: () => ({ sql: ORG_SQL }),
}));

vi.mock(
  "@papercusp/operator-core/lib/release/fixer-liveness",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@papercusp/operator-core/lib/release/fixer-liveness")
    >()),
    releaseFixerSpawnAlive,
    classifyDeadReleaseFixerSpawn,
  }),
);

const { realCheckpointDeps, frozenRepairNoSpawnDetail } = await import("./green-checkpoint");
const { releaseConfig } = await import("./release-config");

const RESERVATION_TRIO = [
  "reserveFrozenRepairFixer",
  "renewFrozenRepairFixerReservation",
  "finalizeFrozenRepairFixer",
] as const;

/** Every frozen-repair dep the gate optional-chains — absent ⇒ a silent no-op, never an error. */
const FIXER_DEPS = [
  "dispatchFrozenRepairFixer",
  "frozenRepairFixerAlive",
  "classifyDeadFrozenRepairFixer",
] as const;

/**
 * The half-wiring this file exists to catch: the reservation trio is supplied but a fixer dep
 * is not. Returns the missing fixer deps (empty when the wiring is whole, or when the trio is
 * itself absent — that case is pinned separately below).
 */
function halfWiredFixerDeps(deps: Record<string, unknown>): string[] {
  const trioPresent = RESERVATION_TRIO.every((key) => typeof deps[key] === "function");
  if (!trioPresent) return [];
  return FIXER_DEPS.filter((key) => typeof deps[key] !== "function");
}

describe("WI-10000758: realCheckpointDeps wires the frozen-repair dispatcher", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    dispatchReleaseFixer.mockClear();
    releaseFixerSpawnAlive.mockClear();
    classifyDeadReleaseFixerSpawn.mockClear();
  });

  it("supplies the dispatcher, the liveness probe and the dead-fixer classifier whenever it supplies the reservation trio", () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));
    for (const key of RESERVATION_TRIO) {
      expect(typeof deps[key], key).toBe("function");
    }
    // The regressions this file exists for: trio present, a fixer dep absent.
    expect(halfWiredFixerDeps(deps as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("control: the half-wiring check flags the exact shape sweep c076b0dd95 shipped (trio present, fixer deps gone)", () => {
    const fn = async () => null;
    // The 2026-09-04 shape: reservation trio wired, dispatcher + liveness probe + classifier
    // deleted. The real wiring must not look like this; the check must say so.
    const sweptShape: Record<string, unknown> = {
      reserveFrozenRepairFixer: fn,
      renewFrozenRepairFixerReservation: fn,
      finalizeFrozenRepairFixer: fn,
    };
    expect(halfWiredFixerDeps(sweptShape)).toEqual([...FIXER_DEPS]);
    // The intermediate shape after WI-10000758 restored only the dispatcher (WI-10007408).
    expect(halfWiredFixerDeps({ ...sweptShape, dispatchFrozenRepairFixer: fn })).toEqual([
      "frozenRepairFixerAlive",
      "classifyDeadFrozenRepairFixer",
    ]);
    // Calibration: a whole wiring passes.
    expect(
      halfWiredFixerDeps({
        ...sweptShape,
        dispatchFrozenRepairFixer: fn,
        frozenRepairFixerAlive: fn,
        classifyDeadFrozenRepairFixer: fn,
      }),
    ).toEqual([]);
  });

  it("answers fixer liveness through releaseFixerSpawnAlive, so a dead fixer reads false (not undefined)", async () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));

    await expect(deps.frozenRepairFixerAlive!("spawn-dead")).resolves.toBe(false);
    expect(releaseFixerSpawnAlive).toHaveBeenCalledTimes(1);
    expect(releaseFixerSpawnAlive).toHaveBeenCalledWith(ORG_SQL, "spawn-dead");
  });

  it("classifies a dead fixer through classifyDeadReleaseFixerSpawn", async () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));

    await expect(deps.classifyDeadFrozenRepairFixer!("spawn-dead")).resolves.toEqual({
      infrastructure: true,
      reason: "wiring-test",
    });
    expect(classifyDeadReleaseFixerSpawn).toHaveBeenCalledTimes(1);
    expect(classifyDeadReleaseFixerSpawn).toHaveBeenCalledWith(ORG_SQL, "spawn-dead");
  });

  it("forwards the frozen queue to dispatchReleaseFixer with the stamped target, repairHead, failingTests and the queue itself", async () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));
    const queue = {
      candidate: "c".repeat(40),
      repairHead: "d".repeat(40),
      failingTests: ["lib/broken.test.ts"],
      phase: "awaiting-fixer",
      attempts: 0,
      fixerSpawnId: null,
    } as unknown as FrozenCandidateRepairQueue;

    const fired = await deps.dispatchFrozenRepairFixer!(queue);

    expect(fired).toEqual({ spawnId: "s-wiring-test", runId: "r-wiring-test" });
    expect(dispatchReleaseFixer).toHaveBeenCalledTimes(1);
    // The 5th argument is the checkpoint evidence the dispatcher forwards when the gate has
    // one; this call supplies none, so it is forwarded as undefined. The 6th carries the
    // gate's onSkip (WI-6554700010029683) — none here either.
    expect(dispatchReleaseFixer).toHaveBeenCalledWith(
      { workspaceId: "papercusp-workspace", installSlug: "papercusp" },
      queue.repairHead,
      queue.failingTests,
      queue,
      undefined,
      { onSkip: undefined },
    );
  });

  it("WI-6554700010029683: forwards the gate's onSkip so a refused dispatch reports its typed reason", async () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "papercusp-workspace");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "papercusp");
    const deps = realCheckpointDeps(releaseConfig({}));
    const queue = {
      candidate: "c".repeat(40),
      repairHead: "d".repeat(40),
      failingTests: ["lib/broken.test.ts"],
      phase: "awaiting-fixer",
      attempts: 0,
      fixerSpawnId: null,
    } as unknown as FrozenCandidateRepairQueue;
    const refusal = {
      code: "snapshot-mismatch" as const,
      reason: "candidate snapshot does not match the queue",
      retryable: true,
    };
    dispatchReleaseFixer.mockImplementationOnce(async (...args: unknown[]) => {
      (args[5] as { onSkip?: (skip: typeof refusal) => void } | undefined)?.onSkip?.(refusal);
      return null;
    });
    const skips: unknown[] = [];

    const fired = await deps.dispatchFrozenRepairFixer!(queue, undefined, (skip) => {
      skips.push(skip);
    });

    expect(fired).toBeNull();
    expect(skips).toEqual([refusal]);
  });

  it("WI-6554700010029683: phrases the no-spawn detail, and stays silent when the dispatcher reported nothing", () => {
    expect(frozenRepairNoSpawnDetail(null)).toBe("");
    expect(frozenRepairNoSpawnDetail(undefined)).toBe("");
    expect(
      frozenRepairNoSpawnDetail({ code: "covered", reason: "a live fixer covers it", retryable: true }),
    ).toBe(" (dispatcher refused: covered — a live fixer covers it)");
    expect(
      frozenRepairNoSpawnDetail({ code: "scope", reason: "install out of scope", retryable: false }),
    ).toBe(
      " (dispatcher refused: scope — install out of scope; another dispatch cannot help until the verdict or head changes)",
    );
  });

  it("supplies neither the dispatcher nor the reservation trio without a stamped gate-verdict target (no half-wiring)", () => {
    vi.stubEnv(GATE_VERDICT_WORKSPACE_ENV, "");
    vi.stubEnv(GATE_VERDICT_HARNESS_ENV, "");
    const deps = realCheckpointDeps(releaseConfig({}));
    for (const key of RESERVATION_TRIO) {
      expect(deps[key], key).toBeUndefined();
    }
    for (const key of FIXER_DEPS) {
      expect(deps[key], key).toBeUndefined();
    }
  });
});
