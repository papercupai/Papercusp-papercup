/**
 * P-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31) — repair-tick cheap legs.
 *
 * While a frozen repair queue is `awaiting-fixer`, a cron tick renders NO suite verdict for
 * hours; before P-009, every such hold also stamped `failingTestsMeasured:false`, and the
 * non-test legs (tsc/lint) were structurally invisible to test_runs — the exact staleness
 * that sent agents chasing stale failing names (D-001). These tests pin the two CLI-side
 * halves in `green-checkpoint.ts`:
 *
 *   · `measureRepairTickLegs` — the MEASUREMENT: every registry leg runs (no short-circuit;
 *     a first-failure floor would defeat the point), per-GATE-ID records, and an honest
 *     `null` when results cannot be attributed to the requested head.
 *   · `augmentWithRepairTickLegs` — the ONE choke point downstream of every hold-return
 *     site: attaches the measurement to exactly the `repair-in-progress` + `awaiting-fixer`
 *     result shape, additively and fail-safe.
 *
 * The routine-side consumption (ledger persist + gate_health refresh) is pinned in
 * packages/operator-core/lib/harness/routines/release-actions*.test.ts.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFrozenCandidateQueue } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import {
  augmentWithRepairTickLegs,
  checkNpmScript,
  DERIVED_FREEZE_DISPOSITION_DEADLINE_MS,
  FROZEN_REPAIR_LEG_ROUTING_DEADLINE_MS,
  isTransientSetupLockContention,
  measureRepairTickLegs,
  NON_TEST_GATE_SCRIPTS,
  POST_VERDICT_DEADLINE_RECORD_BOUND_MS,
  POST_VERDICT_FINALIZE_WATCHDOG_MS,
  POST_VERDICT_WATCHDOG_MS,
  REPAIR_TICK_LEGS_ABORT_GRACE_MS,
  REPAIR_TICK_LEGS_DEADLINE_MS,
  REPAIR_TICK_LEGS_MIN_WINDOW_MS,
  REPAIR_TICK_LEGS_TAIL_RESERVE_MS,
  REPAIR_TICK_SETUP_LOCK_MAX_RETRIES,
  repairTickLegFailureTails,
  repairTickLegsDeadline,
  type CheckpointDeps,
  type CheckpointResult,
  type RepairTickLegs,
} from "./green-checkpoint";

/** The git fatal observed in the 2026-09-21T17:23Z papercusp gate log — a live writer
 *  holding the checkpoint WORKTREE's own index.lock. The git WORDING is kept verbatim so a
 *  wording change fails here rather than silently disabling the retry (WI-10002399); the
 *  leading directory is derived, never a hardcoded home path (EI-18759401203875869 — a
 *  literal one reds the identity-lint leg and freezes `main` for the whole fleet). */
const LIVE_INDEX_LOCK_FATAL =
  "bash apps/operator/bin/release/setup-release-checkout.sh --ref a8bff3dc exited 128: " +
  `fatal: Unable to create '${join(tmpdir(), "papercusp")}/.git/worktrees/` +
  "papercusp-checkpoint/index.lock': File exists.";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

function makeIo(overrides: Partial<Parameters<typeof measureRepairTickLegs>[0]> = {}) {
  return {
    setupTree: vi.fn(async () => undefined),
    resolveHead: vi.fn(async () => HEAD),
    runScript: vi.fn(async (_script: string) => ({ code: 0, tail: "" })),
    log: vi.fn(),
    now: () => 1_000,
    ...overrides,
  };
}

function awaitingFixerQueue(failingTests: string[] = ["a/one.test.ts"]) {
  return {
    ...createFrozenCandidateQueue({
      candidate: OTHER,
      base: null,
      nowMs: 1_000,
      failingTests,
    }),
    phase: "awaiting-fixer" as const,
    repairHead: HEAD,
  };
}

function holdResult(overrides: Partial<CheckpointResult> = {}): CheckpointResult {
  return {
    advanced: false,
    candidate: OTHER,
    from: null,
    green: null,
    reason: "repair-in-progress",
    summary: "held",
    repairQueue: awaitingFixerQueue(),
    ...overrides,
  };
}

describe("measureRepairTickLegs", () => {
  it("P036: retains bounded structured subjects outside truncated output and folds them into the queue", async () => {
    const files = Array.from({ length: 50 }, (_, i) => `packages/core/file${i}.ts`);
    const measured = await measureRepairTickLegs(makeIo({
      runScript: async () => ({ code: 1, tail: "trailer only", subjectPaths: files }),
    }), HEAD, { "lint:tsc": ["lint:tsc"] });
    expect(measured!.legs[0]!.subjectPaths).toEqual(files.slice(0, 40));
    const result = await augmentWithRepairTickLegs(holdResult({ repairQueue: awaitingFixerQueue(['lint:tsc']) }), {
      runRepairTickLegs: async () => measured, log: vi.fn(), writeFrozenRepairQueue: vi.fn(async () => {}),
    });
    expect(result.repairQueue?.manifest?.rows.find((row) => row.legId === "lint:tsc")).toMatchObject({
      subjectPaths: files.slice(0, 40), admitCommand: expect.stringContaining(files[0]!),
    });
  });
  it("runs EVERY leg with no short-circuit and reports the complete failing set", async () => {
    const runScript = vi.fn(async (script: string) => {
      if (script === "s2a") return { code: 1, tail: "boom" };
      if (script === "s3") throw new Error("spawn failed");
      return { code: 0, tail: "" };
    });
    const io = makeIo({ runScript });
    const measured = await measureRepairTickLegs(io, HEAD, {
      a: ["s1"],
      b: ["s2a", "s2b"],
      c: ["s3"],
    });
    expect(measured).not.toBeNull();
    // Every script ran despite the mid-registry failure AND the throw — a measurement,
    // not a rescue: the value IS the complete failing set.
    expect(runScript.mock.calls.map((c) => c[0])).toEqual(["s1", "s2a", "s2b", "s3"]);
    expect(measured!.legs).toEqual([
      { id: "a", status: "pass", durationMs: 0 },
      { id: "b", status: "fail", durationMs: 0, outputTail: expect.stringContaining("s2a: exit 1") },
      { id: "c", status: "errored", durationMs: 0, outputTail: expect.stringContaining("spawn failed") },
    ]);
    expect(measured!.failingSignatures).toEqual(["b", "c"]);
    expect(measured!.ok).toBe(false);
    expect(measured!.head).toBe(HEAD);
  });

  // WI-6554700010018556: a deadline abort mid-pass yields an UNMEASURED tick — never a partial
  // leg set reported as the complete failing set — and no later leg starts.
  it("returns null once aborted mid-pass and starts no later leg; logs each leg on entry and exit", async () => {
    const controller = new AbortController();
    const runScript = vi.fn(async (script: string) => {
      if (script === "s2") {
        controller.abort();
        throw new Error("npm run s2 aborted by caller deadline");
      }
      return { code: 0, tail: "" };
    });
    const log = vi.fn((_line: string) => {});
    const io = makeIo({ runScript, signal: controller.signal, log });
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"], b: ["s2"], c: ["s3"] });
    expect(measured).toBeNull();
    expect(runScript.mock.calls.map((c) => c[0])).toEqual(["s1", "s2"]);
    const lines: string[] = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("repair-tick leg 1/3 s1 started");
    expect(lines.some((l) => /^repair-tick leg 1\/3 s1 exit 0 in \d+ms$/.test(l))).toBe(true);
    expect(lines).toContain("repair-tick leg 2/3 s2 started");
    expect(lines.some((l) => l.includes("repair-tick legs aborted during s2"))).toBe(true);
    expect(lines.some((l) => l.includes("s3"))).toBe(false);
  });

  it("returns null without setting up the tree when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const io = makeIo({ signal: controller.signal });
    expect(await measureRepairTickLegs(io, HEAD, { a: ["s1"] })).toBeNull();
    expect(io.setupTree).not.toHaveBeenCalled();
    expect(io.runScript).not.toHaveBeenCalled();
  });

  it("reports ok with no outputTail noise when every leg passes", async () => {
    const io = makeIo();
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"], b: ["s2"] });
    expect(measured).toMatchObject({ ok: true, failingSignatures: [] });
    for (const leg of measured!.legs) {
      expect(leg.status).toBe("pass");
      expect(leg).not.toHaveProperty("outputTail");
    }
  });

  // WI-10001529: the measurement half. A queued `<ws> :: <script>` signature must run IN its
  // workspace and must NOT be filtered by the root-manifest availability pre-check — that
  // check reads the checkout root's package.json, so consulting it for a workspace script
  // returns "absent" and silently skips the one leg whose result can retire the queue.
  it("runs a workspace leg in its workspace, and never pre-checks it against the root manifest", async () => {
    const runScript = vi.fn(async (_script: string, _workspace: string | null) => ({
      code: 1,
      tail: "2 failed",
    }));
    // Would report every workspace script absent, as the real root-manifest check does.
    const scriptAvailability = vi.fn(() => "absent" as const);
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability }),
      HEAD,
      {
        "lint:tsc": ["lint:tsc"],
        "@papercusp/web :: test": [{ script: "test", workspace: "@papercusp/web" }],
      },
    );

    expect(scriptAvailability).toHaveBeenCalledTimes(1);
    expect(scriptAvailability).toHaveBeenCalledWith("lint:tsc");
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript).toHaveBeenCalledWith("test", "@papercusp/web");
    expect(measured!.legs).toEqual([
      { id: "lint:tsc", status: "skipped", durationMs: 0 },
      {
        id: "@papercusp/web :: test",
        status: "fail",
        durationMs: 0,
        outputTail: "@papercusp/web :: test: exit 1 — 2 failed",
      },
    ]);
    expect(measured!.failingSignatures).toEqual(["@papercusp/web :: test"]);
  });

  it("passes workspace null for a bare root script, so the registry form is unchanged", async () => {
    const runScript = vi.fn(async (_script: string, _workspace: string | null) => ({
      code: 0,
      tail: "",
    }));
    await measureRepairTickLegs(makeIo({ runScript }), HEAD, { a: ["s1"] });
    expect(runScript).toHaveBeenCalledWith("s1", null);
  });

  it("skips absent platform scripts for a subject hive without false failures", async () => {
    const subjectRoot = mkdtempSync(join(tmpdir(), "repair-tick-subject-"));
    try {
      // A repo-less subject hive has ordinary build/typecheck/test scripts but none of
      // Papercusp's platform lint registry. This is the production shape that used to
      // turn every registry id into a false Missing script failure.
      writeFileSync(
        join(subjectRoot, "package.json"),
        JSON.stringify({ scripts: { build: "echo build", typecheck: "echo typecheck", test: "echo test" } }),
      );
      const runScript = vi.fn(async (_script: string) => ({ code: 1, tail: "Missing script" }));
      const measured = await measureRepairTickLegs(
        makeIo({
          runScript,
          scriptAvailability: (script) => checkNpmScript(subjectRoot, script),
        }),
        HEAD,
        {
          "lint:tsc": ["lint:tsc"],
          "lint:identity-leak": ["lint:no-owner-name-tags", "lint:no-box-identity"],
        },
      );

      expect(runScript).not.toHaveBeenCalled();
      expect(measured).toMatchObject({ ok: true, failingSignatures: [] });
      expect(measured?.legs).toEqual([
        { id: "lint:tsc", status: "skipped", durationMs: 0 },
        { id: "lint:identity-leak", status: "skipped", durationMs: 0 },
      ]);
    } finally {
      rmSync(subjectRoot, { recursive: true, force: true });
    }
  });

  it("still measures declared scripts when a registry id mixes absent and present scripts", async () => {
    const runScript = vi.fn(async (script: string) =>
      script === "real-fail" ? { code: 1, tail: "boom" } : { code: 0, tail: "" },
    );
    const scriptAvailability = vi.fn((script: string) =>
      script === "optional" ? ("absent" as const) : ("present" as const),
    );
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability }),
      HEAD,
      { gate: ["optional", "real-fail"] },
    );

    expect(runScript.mock.calls.map(([script]) => script)).toEqual(["real-fail"]);
    expect(measured?.legs).toEqual([
      { id: "gate", status: "fail", durationMs: 0, outputTail: "real-fail: exit 1 — boom" },
    ]);
    expect(measured?.failingSignatures).toEqual(["gate"]);
  });

  it("fails closed when the subject package metadata is unreadable", async () => {
    const runScript = vi.fn(async (_script: string) => ({ code: 0, tail: "" }));
    const measured = await measureRepairTickLegs(
      makeIo({ runScript, scriptAvailability: vi.fn(() => "unreadable" as const) }),
      HEAD,
      { gate: ["lint:tsc"] },
    );

    expect(runScript).not.toHaveBeenCalled();
    expect(measured?.legs).toEqual([
      { id: "gate", status: "errored", durationMs: 0, outputTail: "lint:tsc: package.json unreadable" },
    ]);
    expect(measured?.failingSignatures).toEqual(["gate"]);
    expect(measured?.ok).toBe(false);
  });

  it("returns null on a head mismatch — results must never be attributed to a sha the tree is not at", async () => {
    const io = makeIo({ resolveHead: vi.fn(async () => OTHER) });
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });
    expect(measured).toBeNull();
    expect(io.runScript).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("head mismatch"));
  });

  it("returns null when setup fails, without running any script", async () => {
    const io = makeIo({
      setupTree: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });
    expect(measured).toBeNull();
    expect(io.runScript).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
  });

  // WI-10002399 — setup contention. The checkpoint tree is a worktree of the SHARED
  // checkout, so setupTree's git calls race the fleet's own writers; a live writer holds
  // index.lock for milliseconds. Losing a whole convergence tick to that is a workaround,
  // not a fix — but the retry must stay narrow enough never to mask a real break.
  describe("transient setup lock contention (WI-10002399)", () => {
    it("rides out a live index.lock holder and still measures the tick", async () => {
      const sleep = vi.fn(async (_ms: number) => undefined);
      let calls = 0;
      const io = makeIo({
        sleep,
        setupTree: vi.fn(async () => {
          if (++calls <= 2) throw new Error(LIVE_INDEX_LOCK_FATAL);
          return undefined;
        }),
      });

      const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });

      // The tick is MEASURED, not lost.
      expect(measured).not.toBeNull();
      expect(measured?.head).toBe(HEAD);
      expect(io.setupTree).toHaveBeenCalledTimes(3);
      expect(io.runScript).toHaveBeenCalledTimes(1);
      // Exponential backoff, and no real wall-clock burned.
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
      // Never reported as a failure — it succeeded.
      expect(io.log).not.toHaveBeenCalledWith(
        expect.stringContaining("setup failed"),
      );
    });

    it("does NOT retry a non-contention failure — a real break must surface on the FIRST attempt", async () => {
      const sleep = vi.fn(async (_ms: number) => undefined);
      // Exit 127 (command not found) and exit 74 both occurred in the measured population
      // and are environment breaks, NOT contention. Retrying them would delay the report.
      const io = makeIo({
        sleep,
        setupTree: vi.fn(async () => {
          throw new Error(
            "setup-release-checkout.sh exited 127: dependency-generation.sh: command not found",
          );
        }),
      });

      const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });

      expect(measured).toBeNull();
      expect(io.setupTree).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(io.runScript).not.toHaveBeenCalled();
      expect(io.log).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
    });

    it("an EXHAUSTED budget still returns null — a wedged lock must never be claimed as a measurement", async () => {
      const sleep = vi.fn(async (_ms: number) => undefined);
      const io = makeIo({
        sleep,
        setupTree: vi.fn(async () => {
          throw new Error(LIVE_INDEX_LOCK_FATAL);
        }),
      });

      const measured = await measureRepairTickLegs(io, HEAD, { a: ["s1"] });

      expect(measured).toBeNull();
      expect(io.setupTree).toHaveBeenCalledTimes(
        REPAIR_TICK_SETUP_LOCK_MAX_RETRIES + 1,
      );
      expect(sleep).toHaveBeenCalledTimes(REPAIR_TICK_SETUP_LOCK_MAX_RETRIES);
      expect(io.runScript).not.toHaveBeenCalled();
      expect(io.log).toHaveBeenCalledWith(expect.stringContaining("setup failed"));
    });

    it("classifies only live git-lock contention — a wording change must fail here, not silently disable the retry", () => {
      // The two real wordings, including a WORKTREE index.lock (the observed one).
      expect(isTransientSetupLockContention(LIVE_INDEX_LOCK_FATAL)).toBe(true);
      expect(
        isTransientSetupLockContention(
          "fatal: Unable to create '/repo/.git/index.lock': File exists",
        ),
      ).toBe(true);
      expect(
        isTransientSetupLockContention(
          "error: could not lock config file /repo/.git/config: File exists",
        ),
      ).toBe(true);

      // Near-misses that must NOT be retried.
      expect(isTransientSetupLockContention("fetch failed")).toBe(false);
      expect(
        isTransientSetupLockContention("exited 127: command not found"),
      ).toBe(false);
      // Informational, not a fault: npm-install-safe.mjs logs this when it RUNS a
      // command under its mutex. Reading it as contention was a real misdiagnosis.
      expect(
        isTransientSetupLockContention(
          "NPM_INSTALL_SAFE guarding reader: bash dependency-generation.sh (lock=npm-install-79e4)",
        ),
      ).toBe(false);
      // A lock that is GONE is a different failure than one that EXISTS.
      expect(
        isTransientSetupLockContention(
          "fatal: Unable to create '/repo/.git/index.lock': Permission denied",
        ),
      ).toBe(false);
    });
  });
});

// WI-6554700010018714: a routed lint-leg item said "none recorded for this leg" while the
// verdict line carried its tail, because the routing read tails only from test_runs.
describe("repairTickLegFailureTails", () => {
  const measuredAtHead: RepairTickLegs = {
    head: HEAD,
    atMs: 1_000,
    ok: false,
    failingSignatures: ["lint:condition-rail", "lint:tsc", "lint:design-primitives"],
    legs: [
      { id: "lint:condition-rail", status: "fail", durationMs: 5, outputTail: "  sqlstate=28P01  " },
      { id: "lint:tsc", status: "errored", durationMs: 5, outputTail: "spawn failed" },
      { id: "lint:no-raw-setinterval", status: "pass", durationMs: 5 },
      { id: "lint:design-primitives", status: "fail", durationMs: 5 },
      { id: "lint:timer-classification", status: "skipped", durationMs: 0, outputTail: "not declared" },
    ],
  };

  it("keys each non-passing leg's trimmed tail by leg id when measured at repairHead", () => {
    expect(repairTickLegFailureTails(measuredAtHead, HEAD)).toEqual(
      new Map([
        ["lint:condition-rail", "sqlstate=28P01"],
        ["lint:tsc", "spawn failed"],
      ]),
    );
  });

  it("accepts an abbreviated repairHead for the same commit", () => {
    expect(repairTickLegFailureTails(measuredAtHead, HEAD.slice(0, 12)).size).toBe(2);
  });

  it("carries nothing from a measurement taken at a different head", () => {
    const other = HEAD === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
    expect(repairTickLegFailureTails(measuredAtHead, other).size).toBe(0);
  });

  it("carries nothing without a measurement or a repairHead", () => {
    expect(repairTickLegFailureTails(undefined, HEAD).size).toBe(0);
    expect(repairTickLegFailureTails(measuredAtHead, undefined).size).toBe(0);
  });

  it("runGreenCheckpoint hands those tails to the per-leg routing", () => {
    const source = readFileSync(new URL("./green-checkpoint.ts", import.meta.url), "utf8");
    const run = source.slice(source.indexOf("export async function runGreenCheckpoint"));
    const route = run.slice(run.indexOf("routeLegs({"));
    expect(route.slice(0, 400)).toMatch(
      /failureTails: repairTickLegFailureTails\(\s*finalResult\.repairTickLegs,\s*queueForRouting\?\.repairHead,?\s*\)/,
    );
  });
});

describe("augmentWithRepairTickLegs", () => {
  const measured: RepairTickLegs = {
    head: HEAD,
    atMs: 1_000,
    ok: false,
    failingSignatures: ["lint:tsc"],
    legs: [{ id: "lint:tsc", status: "fail", durationMs: 5 }],
  };

  it("routes after repair-tick augmentation so fixed legs are not re-opened from a stale snapshot", () => {
    const source = readFileSync(new URL("./green-checkpoint.ts", import.meta.url), "utf8");
    const run = source.slice(source.indexOf("export async function runGreenCheckpoint"));
    const augment = run.indexOf("finalResult = await augmentWithRepairTickLegs(finalResult, deps);");
    const route = run.indexOf("deps.routeFrozenRepairLegsToAgents &&");
    expect(augment).toBeGreaterThanOrEqual(0);
    expect(route).toBeGreaterThan(augment);
  });

  it("attaches the measurement on an awaiting-fixer repair hold, asking for the full registry at repairHead", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const log = vi.fn();
    const result = await augmentWithRepairTickLegs(holdResult(), { runRepairTickLegs, log });
    // A failing TEST FILE is the fixer's subject, not a cheap leg, so the asked-for set is
    // exactly the registry — this hold's queue holds `a/one.test.ts` and nothing re-runnable.
    // WI-10004340: the frozen queue's clock rides along, so a guard leg measured on the
    // hold tick judges sidecar reviewBy as of the freeze, not the wall clock.
    // WI-6554700010018556: plus the legs-deadline abort signal.
    expect(runRepairTickLegs).toHaveBeenCalledWith(HEAD, Object.keys(NON_TEST_GATE_SCRIPTS), {
      frozenCandidateOpenedAtMs: 1_000,
      signal: expect.any(AbortSignal),
    });
    expect(result.repairTickLegs).toEqual(measured);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("FAILING lint:tsc"));
  });

  // WI-10001529: the deadlock. The tick asked for the static registry ONLY, so a queued
  // workspace-task signature was never re-measured, `queue.failingTests` never lost it, and
  // the dispatch guard's signature comparison could never converge — an awaiting-fixer hold
  // that no fix to the subject could clear.
  it("also asks for a queued workspace-task signature — the only thing that can retire it", async () => {
    const runRepairTickLegs = vi.fn(async (_ref: string, _gateIds: readonly string[]) => measured);
    const queue = awaitingFixerQueue(["@papercusp/web :: test", "a/one.test.ts"]);
    expect(queue.failingTests).toContain("@papercusp/web :: test");
    await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
      runRepairTickLegs,
      log: vi.fn(),
    });
    const askedFor = runRepairTickLegs.mock.calls[0][1];
    expect(askedFor).toContain("@papercusp/web :: test");
    // Still the whole registry, and still no failing test FILE.
    expect(askedFor).toEqual(
      expect.arrayContaining(Object.keys(NON_TEST_GATE_SCRIPTS)),
    );
    expect(askedFor).not.toContain("a/one.test.ts");
  });

  it("asks for a queued signature exactly once even when it is already a registry id", async () => {
    const runRepairTickLegs = vi.fn(async (_ref: string, _gateIds: readonly string[]) => measured);
    const queue = awaitingFixerQueue(["lint:tsc"]);
    await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
      runRepairTickLegs,
      log: vi.fn(),
    });
    const askedFor = runRepairTickLegs.mock.calls[0][1];
    expect(askedFor.filter((id) => id === "lint:tsc")).toHaveLength(1);
  });

  it("does nothing for a non-hold reason", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const base = holdResult({ reason: "not-green", green: false });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("does nothing when the queue is past awaiting-fixer (verification owns the next measurement)", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const queue = { ...awaitingFixerQueue(), phase: "ready-to-verify" as const };
    const base = holdResult({ repairQueue: queue });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("does nothing when the dep is absent (stubs/older deps keep exact current behaviour)", async () => {
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { log: vi.fn() });
    expect(result).toBe(base);
    expect(result.repairTickLegs).toBeUndefined();
  });

  it("measures exactly once per tick — an auto-refire re-entry must not re-measure", async () => {
    const runRepairTickLegs = vi.fn(async () => measured);
    const base = holdResult({ repairTickLegs: measured });
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(runRepairTickLegs).not.toHaveBeenCalled();
    expect(result).toBe(base);
  });

  it("leaves the result untouched when the measurement is null (unmeasured, never green)", async () => {
    const runRepairTickLegs = vi.fn(async () => null);
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log: vi.fn() });
    expect(result).toBe(base);
    expect(result.repairTickLegs).toBeUndefined();
  });

  // WI-6554700010018556: run fc4e96c0 recorded its verdict (~22:15Z), entered these legs under
  // the 60m post-verdict ceiling, and was SIGKILLed by the self-watchdog at 23:15Z — so its
  // terminal read `error`. A leg pass that never finishes must NOT hold the run past its bound.
  describe("legs deadline (WI-6554700010018556)", () => {
    it("a measurement that never finishes is aborted at the deadline and the tick stays unmeasured", async () => {
      let seenSignal: AbortSignal | undefined;
      const runRepairTickLegs = vi.fn(
        (_ref: string, _ids: readonly string[], opts?: { signal?: AbortSignal }) =>
          new Promise<RepairTickLegs | null>((resolve) => {
            seenSignal = opts?.signal;
            // Unwinds ONLY when aborted, like a killed leg.
            opts?.signal?.addEventListener("abort", () => resolve(null), { once: true });
          }),
      );
      const recordPostVerdictStepDeadline = vi.fn(async () => {});
      const log = vi.fn();
      const base = holdResult();
      const startedAt = Date.now();
      const result = await augmentWithRepairTickLegs(
        base,
        { runRepairTickLegs, log, recordPostVerdictStepDeadline },
        { deadlineMs: 30, abortGraceMs: 1_000 },
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(result).toBe(base);
      expect(result.repairTickLegs).toBeUndefined();
      expect(seenSignal?.aborted).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/repair-tick legs deadline-exceeded .*in-flight leg aborted; tick stays unmeasured/),
      );
      expect(recordPostVerdictStepDeadline).toHaveBeenCalledTimes(1);
      expect(recordPostVerdictStepDeadline).toHaveBeenCalledWith(
        expect.objectContaining({ label: "P-009 repair-tick legs", deadlineMs: 30 }),
      );
    });

    it("a measurement that ignores the abort still cannot hold the run past deadline + grace", async () => {
      const runRepairTickLegs = vi.fn(() => new Promise<RepairTickLegs | null>(() => {}));
      const log = vi.fn();
      const base = holdResult();
      const result = await augmentWithRepairTickLegs(
        base,
        { runRepairTickLegs, log },
        { deadlineMs: 20, abortGraceMs: 20 },
      );
      expect(result).toBe(base);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("did not unwind within 20ms"));
    });

    it("a measurement that finishes inside the deadline is attached exactly as before", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const recordPostVerdictStepDeadline = vi.fn(async () => {});
      const result = await augmentWithRepairTickLegs(
        holdResult(),
        { runRepairTickLegs, log: vi.fn(), recordPostVerdictStepDeadline },
        { deadlineMs: 5_000 },
      );
      expect(result.repairTickLegs).toEqual(measured);
      expect(recordPostVerdictStepDeadline).not.toHaveBeenCalled();
    });

    it("the legs deadline + every other bounded post-verdict step + terminal finalize fit inside the post-verdict ceiling", () => {
      const postVerdictBudgetMs =
        DERIVED_FREEZE_DISPOSITION_DEADLINE_MS +
        REPAIR_TICK_LEGS_DEADLINE_MS +
        REPAIR_TICK_LEGS_ABORT_GRACE_MS +
        FROZEN_REPAIR_LEG_ROUTING_DEADLINE_MS +
        // one bounded overrun record per bounded step
        3 * POST_VERDICT_DEADLINE_RECORD_BOUND_MS +
        POST_VERDICT_FINALIZE_WATCHDOG_MS;
      expect(postVerdictBudgetMs).toBeLessThanOrEqual(POST_VERDICT_WATCHDOG_MS);
      // And still roomy above the measured ~20m baseline pass (1,170,263ms at 19:45Z), so the
      // bound cuts a runaway, not an ordinary tick.
      expect(REPAIR_TICK_LEGS_DEADLINE_MS).toBeGreaterThanOrEqual(30 * 60_000);
    });
  });

  it("swallows a thrown measurement — the hold verdict must never break on a leg run", async () => {
    const runRepairTickLegs = vi.fn(async () => {
      throw new Error("worktree busy");
    });
    const log = vi.fn();
    const base = holdResult();
    const result = await augmentWithRepairTickLegs(base, { runRepairTickLegs, log });
    expect(result).toBe(base);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("measurement failed"));
  });

  // WI-6554700010008915: a hold tick returns BEFORE the candidate path's disk preflight, so
  // a full /tmp made every leg fail with ENOSPC and those were folded into queue.legs as
  // code reds. The tick must apply the same admission check and leave the legs unmeasured.
  describe("disk-headroom admission (WI-6554700010008915)", () => {
    it("does not run the legs when headroom is insufficient, and says why", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const writeFrozenRepairQueue = vi.fn();
      const log = vi.fn();
      const base = holdResult();
      const result = await augmentWithRepairTickLegs(base, {
        runRepairTickLegs,
        writeFrozenRepairQueue,
        log,
        checkDiskHeadroom: async () => ({ ok: false, summary: "/tmp 3.1 GiB free" }),
      });
      expect(runRepairTickLegs).not.toHaveBeenCalled();
      expect(writeFrozenRepairQueue).not.toHaveBeenCalled();
      expect(result).toBe(base);
      expect(result.repairTickLegs).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("NOT measured: disk-headroom — /tmp 3.1 GiB free"),
      );
    });

    it("fails closed when the headroom probe throws", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const log = vi.fn();
      const base = holdResult();
      const result = await augmentWithRepairTickLegs(base, {
        runRepairTickLegs,
        log,
        checkDiskHeadroom: async () => {
          throw new Error("statfs EIO");
        },
      });
      expect(runRepairTickLegs).not.toHaveBeenCalled();
      expect(result).toBe(base);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("disk headroom probe failed: statfs EIO"));
    });

    it("measures as before when headroom is sufficient", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const result = await augmentWithRepairTickLegs(holdResult(), {
        runRepairTickLegs,
        log: vi.fn(),
        checkDiskHeadroom: async () => ({ ok: true, summary: "ok" }),
      });
      expect(runRepairTickLegs).toHaveBeenCalledTimes(1);
      expect(result.repairTickLegs).toEqual(measured);
    });

    it("never probes disk for a tick that would not measure anyway", async () => {
      const checkDiskHeadroom = vi.fn(async () => ({ ok: false, summary: "x" }));
      const base = holdResult({ reason: "not-green", green: false });
      await augmentWithRepairTickLegs(base, {
        runRepairTickLegs: vi.fn(async () => measured),
        log: vi.fn(),
        checkDiskHeadroom,
      });
      expect(checkDiskHeadroom).not.toHaveBeenCalled();
    });
  });

  // WI-10005728: the tick's measurement used to reach gate_health only; queue.legs stayed
  // empty, so every leg read `never-admitted` and leg shrink / fixedAtHead never moved.
  describe("folds the measurement into the queue's leg lifecycle (WI-10005728)", () => {
    const NEXT_HEAD = "b".repeat(40);

    it("admits a measured-red leg as failing and persists it with the snapshot's CAS token", async () => {
      const queue = awaitingFixerQueue();
      const writeFrozenRepairQueue = vi.fn(async () => {});
      const result = await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
        runRepairTickLegs: vi.fn(async () => measured),
        writeFrozenRepairQueue,
        log: vi.fn(),
      });
      expect(writeFrozenRepairQueue).toHaveBeenCalledTimes(1);
      const [written, options] = writeFrozenRepairQueue.mock.calls[0] as unknown as [
        NonNullable<CheckpointResult["repairQueue"]>,
        { expectedUpdatedAtMs: number | null },
      ];
      expect(options).toEqual({ expectedUpdatedAtMs: queue.updatedAtMs });
      expect(written.legs).toEqual([
        expect.objectContaining({ id: "lint:tsc", state: "failing", admittedHead: HEAD }),
      ]);
      expect(written.updatedAtMs).toBeGreaterThan(queue.updatedAtMs);
      expect(result.repairQueue).toEqual(written);
    });

    it("marks the leg fixed when a later tick measures it passing at a newer head", async () => {
      const writes: NonNullable<CheckpointResult["repairQueue"]>[] = [];
      const writeFrozenRepairQueue = vi.fn(async (q: NonNullable<CheckpointResult["repairQueue"]> | null) => {
        if (q) writes.push(q);
      });
      await augmentWithRepairTickLegs(holdResult({ repairQueue: awaitingFixerQueue() }), {
        runRepairTickLegs: vi.fn(async () => measured),
        writeFrozenRepairQueue,
        log: vi.fn(),
      });
      const afterFix = { ...writes[0], repairHead: NEXT_HEAD };
      const passed: RepairTickLegs = {
        head: NEXT_HEAD,
        atMs: 2_000,
        ok: true,
        failingSignatures: [],
        legs: [{ id: "lint:tsc", status: "pass", durationMs: 5 }],
      };
      await augmentWithRepairTickLegs(holdResult({ repairQueue: afterFix }), {
        runRepairTickLegs: vi.fn(async () => passed),
        writeFrozenRepairQueue,
        log: vi.fn(),
      });
      expect(writes[1].legs).toEqual([
        expect.objectContaining({ id: "lint:tsc", state: "fixed", resolvedHead: NEXT_HEAD }),
      ]);
    });

    it("folds into the FRESH row and leaves a different frozen candidate untouched", async () => {
      const snapshot = awaitingFixerQueue();
      const reopened = { ...snapshot, candidate: "c".repeat(40), updatedAtMs: 5_000 };
      const transitionFrozenRepairQueue = vi.fn(
        async (transition: (fresh: typeof snapshot) => typeof snapshot) => ({
          queue: transition(reopened),
        }),
      );
      const result = await augmentWithRepairTickLegs(holdResult({ repairQueue: snapshot }), {
        runRepairTickLegs: vi.fn(async () => measured),
        transitionFrozenRepairQueue:
          transitionFrozenRepairQueue as unknown as CheckpointDeps["transitionFrozenRepairQueue"],
        log: vi.fn(),
      });
      expect(transitionFrozenRepairQueue).toHaveBeenCalledTimes(1);
      expect(result.repairQueue).toBe(reopened);
      expect(result.repairQueue?.legs).toBeUndefined();
    });

    it("keeps the hold result (with its measurement) when the lifecycle write fails", async () => {
      const queue = awaitingFixerQueue();
      const log = vi.fn();
      const result = await augmentWithRepairTickLegs(holdResult({ repairQueue: queue }), {
        runRepairTickLegs: vi.fn(async () => measured),
        writeFrozenRepairQueue: vi.fn(async () => {
          throw new Error("conflict");
        }),
        log,
      });
      expect(result.repairTickLegs).toEqual(measured);
      expect(result.repairQueue).toBe(queue);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("leg lifecycle write failed"));
    });
  });

  // WI-6554700010019444: run 113fe179 (2026-10-21) settled its retest ~2h20m into the run. The
  // POST_VERDICT_WATCHDOG_MS tighten only pulls the ceiling IN, so the fixed 40m legs deadline sat
  // PAST the 3h ceiling; leg 25/36 was still running at 180m and the kill replaced the recorded
  // still-red hold with a tip-labelled no-verdict that raised WEDGED.
  describe("WI-6554700010019444: the legs deadline clamps to the self-watchdog's remaining budget", () => {
    const fixed = {
      run: true,
      deadlineMs: REPAIR_TICK_LEGS_DEADLINE_MS,
      clampedByCeiling: false,
    };

    it("keeps the fixed deadline when no ceiling is known or it is far enough away", () => {
      expect(repairTickLegsDeadline({ fixedMs: REPAIR_TICK_LEGS_DEADLINE_MS })).toEqual(fixed);
      expect(
        repairTickLegsDeadline({
          fixedMs: REPAIR_TICK_LEGS_DEADLINE_MS,
          remainingMs: Number.POSITIVE_INFINITY,
        }),
      ).toEqual(fixed);
      expect(
        repairTickLegsDeadline({
          fixedMs: REPAIR_TICK_LEGS_DEADLINE_MS,
          remainingMs: POST_VERDICT_WATCHDOG_MS,
        }),
      ).toEqual(fixed);
    });

    it("clamps to what is left minus the tail reserve when the ceiling is closer (113fe179's shape)", () => {
      const remainingMs = 41 * 60_000;
      expect(
        repairTickLegsDeadline({ fixedMs: REPAIR_TICK_LEGS_DEADLINE_MS, remainingMs }),
      ).toEqual({
        run: true,
        deadlineMs: remainingMs - REPAIR_TICK_LEGS_TAIL_RESERVE_MS,
        clampedByCeiling: true,
      });
    });

    it("skips the pass when the usable window is below the minimum", () => {
      const remainingMs = REPAIR_TICK_LEGS_TAIL_RESERVE_MS + REPAIR_TICK_LEGS_MIN_WINDOW_MS - 1;
      expect(
        repairTickLegsDeadline({ fixedMs: REPAIR_TICK_LEGS_DEADLINE_MS, remainingMs }),
      ).toEqual({ run: false, availableMs: REPAIR_TICK_LEGS_MIN_WINDOW_MS - 1 });
    });

    it("reserves exactly the slack the fixed deadline already assumed inside the post-verdict ceiling", () => {
      expect(REPAIR_TICK_LEGS_DEADLINE_MS + REPAIR_TICK_LEGS_TAIL_RESERVE_MS).toBe(
        POST_VERDICT_WATCHDOG_MS,
      );
      expect(REPAIR_TICK_LEGS_TAIL_RESERVE_MS).toBeGreaterThan(REPAIR_TICK_LEGS_ABORT_GRACE_MS);
    });

    it("does not start the legs when the remaining budget cannot fit them; the hold stays as recorded", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const log = vi.fn();
      const hold = holdResult();
      const result = await augmentWithRepairTickLegs(hold, {
        runRepairTickLegs,
        log,
        postVerdictRemainingMs: () => REPAIR_TICK_LEGS_TAIL_RESERVE_MS + 60_000,
      });
      expect(runRepairTickLegs).not.toHaveBeenCalled();
      expect(result).toBe(hold);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("NOT measured: post-verdict budget"),
      );
    });

    it("runs the legs under the clamped deadline when the ceiling is closer than the fixed deadline", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const log = vi.fn();
      const result = await augmentWithRepairTickLegs(holdResult(), {
        runRepairTickLegs,
        log,
        postVerdictRemainingMs: () => REPAIR_TICK_LEGS_TAIL_RESERVE_MS + 10 * 60_000,
      });
      expect(runRepairTickLegs).toHaveBeenCalledTimes(1);
      expect(result.repairTickLegs).toEqual(measured);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(`deadline clamped to ${10 * 60_000}ms`),
      );
    });

    it("a throwing budget read degrades to the fixed deadline instead of skipping the measurement", async () => {
      const runRepairTickLegs = vi.fn(async () => measured);
      const log = vi.fn();
      const result = await augmentWithRepairTickLegs(holdResult(), {
        runRepairTickLegs,
        log,
        postVerdictRemainingMs: () => {
          throw new Error("watchdog gone");
        },
      });
      expect(runRepairTickLegs).toHaveBeenCalledTimes(1);
      expect(result.repairTickLegs).toEqual(measured);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("budget read failed"));
    });
  });
});
