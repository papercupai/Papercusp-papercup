/** WI-6554700010029054: preparation must agree with the runner before materialization. */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginCheckpointPreflight,
  checkpointRunnerCandidate,
  ensureCheckpointDependencyGeneration,
  runCmd,
  runGreenCheckpoint,
  type CheckpointDeps,
  type CheckpointOpts,
} from "./green-checkpoint";
import { releaseConfig } from "./release-config";
import {
  markFrozenRepairAdmitted,
  settleFrozenRepairRetestRequest,
  type FrozenCandidateRepairQueue,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";

afterEach(() => vi.unstubAllEnvs());

async function fixture(alreadyGreen = false) {
  const root = mkdtempSync(join(tmpdir(), "ready-to-test-selection-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const integration = join(root, "integration");
  mkdirSync(join(integration, "node_modules", "fixture-dep"), { recursive: true });
  vi.stubEnv("PC_HEAVY_DIR", join(root, "pc-heavy"));
  vi.stubEnv("PAPERCUSP_DEPENDENCY_GENERATION_ROOT", join(root, "generations"));
  vi.stubEnv("DEPENDENCY_GENERATION_COPY_LOCK_FILE", join(root, "copy.lock"));
  vi.stubEnv("PAPERCUSP_QUIET_CUT", "0");
  const forward = console.error.bind(console);
  const narration = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && / dependency-prewarm (stdout|stderr): /.test(args[0])) return;
    forward(...args);
  });
  onTestFinished(() => narration.mockRestore());
  const exec: typeof runCmd = (command, args, options = {}) => runCmd(command, args, {
    ...options, timeoutMs: 60_000, hardTimeoutMs: 60_000,
    killProcessGroupOnTimeout: true, signal: controller.signal,
  });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", integration, ...args], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "staging");
  git("config", "user.name", "Candidate selection regression");
  git("config", "user.email", "selection@example.invalid");
  const commit = (version: string) => {
    writeFileSync(join(integration, "package.json"), JSON.stringify({ name: "selection-fixture", private: true }));
    writeFileSync(join(integration, "package-lock.json"), JSON.stringify({
      name: "selection-fixture", lockfileVersion: 3,
      packages: { "node_modules/fixture-dep": { version } },
    }));
    writeFileSync(join(integration, "node_modules", "fixture-dep", "package.json"),
      JSON.stringify({ name: "fixture-dep", version }));
    writeFileSync(join(integration, "node_modules", "fixture-dep", "index.js"), `module.exports = '${version}';\n`);
    git("add", "package.json", "package-lock.json");
    git("commit", "-qm", `fixture dependency ${version}`);
    return git("rev-parse", "HEAD");
  };
  const base = commit("1.0.0");
  const candidate = commit("2.0.0");
  git("branch", "main", alreadyGreen ? candidate : base);
  const cfg = releaseConfig({ integrationRoot: integration, releaseRoot: join(root, "release"),
    checkpointRoot: join(root, "checkpoint"), checkpointLogDir: join(root, "logs"),
    integrationBranch: "staging", releaseRef: "main" });
  const candidateGeneration = await ensureCheckpointDependencyGeneration(cfg, candidate, exec);
  const repairHead = commit("3.0.0");
  const repairGeneration = await ensureCheckpointDependencyGeneration(cfg, repairHead, exec);
  expect(candidateGeneration.inputFingerprint).not.toBe(repairGeneration.inputFingerprint);
  const openedAtMs = Date.now();
  const queue: FrozenCandidateRepairQueue = markFrozenRepairAdmitted({
    schemaVersion: 4, phase: "ready-to-test", candidate, repairHead: candidate, base,
    attempts: 0, openedAtMs: Date.now(), updatedAtMs: Date.now(),
    fixerSpawnId: null, failingTests: [], signature: [],
  }, {
    atMs: openedAtMs + 1, actor: "fixture", source: { ref: "staging", sha: repairHead },
    fromRepairHead: candidate, toRepairHead: repairHead,
    paths: ["package-lock.json"], unchanged: [], blobs: {},
  });
  const setupTree = vi.fn(async () => { throw new Error("fixture must stop before materialization"); });
  const runGreen = vi.fn(async () => { throw new Error("fixture must not execute a suite"); });
  const writeQueue: NonNullable<CheckpointDeps["writeFrozenRepairQueue"]> = vi.fn(async (next, options) => {
    expect(options.expectedUpdatedAtMs).toBe(queue.updatedAtMs);
    if (!next) throw new Error("fixture must preserve its frozen queue");
    Object.assign(queue, next);
  });
  const deps: CheckpointDeps = {
    setupTree, runGreen,
    advance: async () => { throw new Error("fixture must not promote"); },
    push: async () => {}, broadcast: async () => {}, escalate: async () => {},
    clearEscalation: async () => {}, emitEvent: async () => {}, log: () => {},
    readFrozenRepairQueue: async () => queue,
    writeFrozenRepairQueue: writeQueue,
    checkDiskHeadroom: async () => ({ ok: false, summary: "fixture reached post-selection boundary" }),
  };
  const prepare = async (opts: CheckpointOpts) => {
    const result = await beginCheckpointPreflight(cfg, repairHead, exec, {
      target: null, checkpointSelection: { deps, opts },
    });
    if (result.kind !== "ready") throw new Error("fixture must be applicable");
    onTestFinished(() => { if (result.lock.acquired) result.lock.release(); });
    return result;
  };
  return { cfg, queue, candidate, repairHead, candidateGeneration, repairGeneration,
    setupTree, runGreen, deps, prepare };
}

describe("prepared frozen candidate selection", () => {
  it("prepares the untested original despite admitted repairs and a stale queue-selection hint", async () => {
    const f = await fixture();
    const before = structuredClone(f.queue);
    const prepared = await f.prepare({ candidate: f.repairHead, candidateSource: "frozen-repair-queue" });
    expect(prepared.candidate).toBe(f.candidate);
    expect(prepared.prewarmedDependencyGeneration.inputFingerprint).toBe(f.candidateGeneration.inputFingerprint);
    expect(prepared.preparedSelection?.queue).toEqual(before);
    const result = await runGreenCheckpoint(f.cfg, f.deps, {
      noPush: true, candidate: prepared.candidate, candidateSource: "frozen-repair-queue",
      preparedSelection: prepared.preparedSelection,
    });
    expect(result).toMatchObject({ candidate: f.candidate, green: null, reason: "disk-headroom",
      summary: "fixture reached post-selection boundary" });
    expect(f.queue).toEqual(before);
    expect(f.setupTree).not.toHaveBeenCalled();
    expect(f.runGreen).not.toHaveBeenCalled();
  }, 180_000);

  // WI-6554700010010801: release-checkpoint-launch.ts transports an exact `--candidate <sha>`.
  // The CLI forwarded that raw INPUT to the runner after the preflight resolved a different
  // prepared candidate, so the entry guard crashed the run ("prepared selection candidate
  // changed") — 7 crashed gate runs on 2026-10-25/26, each recording the frozen candidate.
  it.each(["frozen-repair-queue", "tip"] as const)(
    "the CLI runner options judge the prepared candidate when preflight overrides an explicit --candidate (%s)",
    async (candidateSource) => {
      const f = await fixture();
      const before = structuredClone(f.queue);
      const candidateArg = f.repairHead;
      const prepared = await f.prepare({ candidate: candidateArg, candidateSource });
      // Precondition: this case only proves anything while the preflight overrides the input.
      expect(prepared.candidate).not.toBe(candidateArg);
      expect(prepared.preparedSelection?.candidate).toBe(prepared.candidate);
      expect(checkpointRunnerCandidate(candidateArg, prepared.preparedSelection)).toBe(prepared.candidate);
      // No explicit --candidate keeps the runner's own selection path untouched.
      expect(checkpointRunnerCandidate(undefined, prepared.preparedSelection)).toBeUndefined();
      const result = await runGreenCheckpoint(f.cfg, f.deps, {
        noPush: true, candidateSource, preparedSelection: prepared.preparedSelection,
        candidate: checkpointRunnerCandidate(candidateArg, prepared.preparedSelection),
      });
      expect(result).toMatchObject({ candidate: prepared.candidate, green: null, reason: "disk-headroom",
        summary: "fixture reached post-selection boundary" });
      expect(f.queue).toEqual(before);
      expect(f.setupTree).not.toHaveBeenCalled();
      expect(f.runGreen).not.toHaveBeenCalled();
      // The raw input is exactly what crashed before the fix: the guard itself is unchanged.
      await expect(runGreenCheckpoint(f.cfg, f.deps, {
        noPush: true, candidateSource, preparedSelection: prepared.preparedSelection, candidate: candidateArg,
      })).rejects.toThrow("prepared selection candidate changed");
    },
    180_000,
  );

  it("selects the original when no caller supplied a candidate", async () => {
    const f = await fixture();
    const prepared = await f.prepare({});
    expect(prepared.candidate).toBe(f.candidate);
    expect(prepared.prewarmedDependencyGeneration.inputFingerprint).toBe(f.candidateGeneration.inputFingerprint);
  }, 180_000);

  it("retains the pending repair after a prepared original exhausts its disk retry", async () => {
    const f = await fixture();
    const before = structuredClone(f.queue);
    const prepared = await f.prepare({ candidate: f.repairHead, candidateSource: "frozen-repair-queue" });
    expect(prepared.candidate).toBe(f.candidate);
    const logs: string[] = [];
    f.deps.log = (line) => logs.push(line);
    f.deps.preconditionRetryDelayMs = 0;
    f.deps.reclaimDependencyHeadroom = vi.fn(async () => "fixture retains its prepared generation");
    const headroom = vi.fn(async () => ({
      ok: false, blocker: "disk-headroom" as const, summary: "fixture headroom still unavailable",
    }));
    f.deps.checkDiskHeadroom = headroom;
    const consume = vi.fn<NonNullable<CheckpointDeps["consumeFrozenRepairRetestRequest"]>>(async (input) => {
      if (f.queue.retestRequested?.repairHead === input.judgedRepairHead && !input.settleJudgedHead) {
        return { kind: "none", queue: f.queue, request: null };
      }
      const decision = settleFrozenRepairRetestRequest(f.queue, input.judgedRepairHead);
      Object.assign(f.queue, decision.queue);
      return decision;
    });
    f.deps.consumeFrozenRepairRetestRequest = consume;

    const result = await runGreenCheckpoint(f.cfg, f.deps, {
      noPush: true, candidate: prepared.candidate, preparedSelection: prepared.preparedSelection,
    });

    expect(result).toMatchObject({ candidate: f.candidate, green: null, advanced: false,
      reason: "disk-headroom", preconditionRetry: { blocker: "disk-headroom", delayMs: 0 } });
    expect(headroom).toHaveBeenCalledTimes(2);
    expect(f.deps.reclaimDependencyHeadroom).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledExactlyOnceWith({ judgedRepairHead: f.candidate, settleJudgedHead: false });
    expect(f.queue).toEqual(before);
    expect(f.queue.retestRequested?.repairHead).toBe(f.repairHead);
    expect(prepared.preparedSelection?.candidate).toBe(f.candidate);
    expect(logs.some((line) => line.includes("admission retest deferred") && line.includes("unlocked preparation"))).toBe(true);
    expect(f.setupTree).not.toHaveBeenCalled();
    expect(f.runGreen).not.toHaveBeenCalled();
    // Deferral never weakens the guard against callers changing the committed selection.
    await expect(runGreenCheckpoint(f.cfg, f.deps, {
      candidate: f.repairHead, preparedSelection: prepared.preparedSelection,
    })).rejects.toThrow("prepared selection candidate changed");
  }, 180_000);

  it.each(["already-green", "ready-to-verify"] as const)("prepares the admitted head for %s", async (state) => {
    const f = await fixture(state === "already-green");
    if (state === "ready-to-verify") f.queue.phase = "ready-to-verify";
    const before = structuredClone(f.queue);
    const prepared = await f.prepare({ candidateSource: "frozen-repair-queue" });
    expect(prepared.candidate).toBe(f.repairHead);
    expect(prepared.prewarmedDependencyGeneration.inputFingerprint).toBe(f.repairGeneration.inputFingerprint);
    expect(f.queue).toEqual(before);
    const result = await runGreenCheckpoint(f.cfg, f.deps, {
      noPush: true, candidate: prepared.candidate, candidateSource: "frozen-repair-queue",
      preparedSelection: prepared.preparedSelection,
    });
    expect(result).toMatchObject({ candidate: f.repairHead, green: null, reason: "disk-headroom" });
    expect(f.queue.phase).toBe("ready-to-verify");
    expect(f.queue.candidate).toBe(f.candidate);
    expect(f.setupTree).not.toHaveBeenCalled();
    expect(f.runGreen).not.toHaveBeenCalled();
  }, 180_000);

  it("preserves an explicit diagnostic pin", async () => {
    const f = await fixture();
    const prepared = await f.prepare({ candidate: f.repairHead, candidateSource: "pinned" });
    expect(prepared.candidate).toBe(f.repairHead);
    expect(prepared.preparedSelection?.candidateSource).toBe("pinned");
  }, 180_000);
});
