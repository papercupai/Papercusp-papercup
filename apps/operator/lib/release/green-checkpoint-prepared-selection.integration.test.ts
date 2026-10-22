/**
 * Independent prospective tests for fresh-cut-prewarm-ordering-2026-10-22.
 * WI-6554700010020448; production boundary agreed in D-008.
 * These tests use the existing exports, real temporary Git history and real
 * dependency publication/materialization. Selection itself is never replaced.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginCheckpointPreflight,
  checkpointRunLockDir,
  ensureCheckpointDependencyGeneration,
  realCheckpointDeps,
  runCmd,
  runGreenCheckpoint,
  type CheckpointDeps,
  type CheckpointOpts,
} from "./green-checkpoint";
import { releaseConfig } from "./release-config";
import { advanceReady } from "./git-ops";
import type { FrozenRepairPendingCarry } from "@papercusp/operator-core/lib/release/frozen-repair-carry";

type SelectionInput = NonNullable<
  Parameters<typeof beginCheckpointPreflight>[3]
> & {
  checkpointSelection: { deps: CheckpointDeps; opts?: CheckpointOpts };
};
type PreparedOpts = CheckpointOpts & { preparedSelection?: unknown };

afterEach(() => vi.unstubAllEnvs());

async function lineage() {
  const root = mkdtempSync(
    join(tmpdir(), "p023-independent-prepared-selection-"),
  );
  const integration = join(root, "integration");
  mkdirSync(join(integration, "node_modules", "fixture-dep"), {
    recursive: true,
  });
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv("PC_HEAVY_DIR", join(root, "pc-heavy"));
  vi.stubEnv("PAPERCUSP_DEPENDENCY_GENERATION_ROOT", join(root, "generations"));
  vi.stubEnv("PAPERCUSP_QUIET_CUT", "0");
  const forward = console.error.bind(console);
  const narration = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        / dependency-prewarm (stdout|stderr): /.test(args[0])
      )
        return;
      forward(...args);
    });
  onTestFinished(() => narration.mockRestore());
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", integration, ...args], {
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`fixture git failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "staging");
  git("config", "user.name", "Independent acceptance fixture");
  git("config", "user.email", "independent@example.invalid");
  const commit = (version: string) => {
    writeFileSync(
      join(integration, "package.json"),
      JSON.stringify({ name: "preparation-fixture", private: true }),
    );
    writeFileSync(
      join(integration, "package-lock.json"),
      JSON.stringify({
        name: "preparation-fixture",
        lockfileVersion: 3,
        packages: { "node_modules/fixture-dep": { version } },
      }),
    );
    writeFileSync(
      join(integration, "node_modules", "fixture-dep", "package.json"),
      JSON.stringify({ name: "fixture-dep", version }),
    );
    writeFileSync(
      join(integration, "node_modules", "fixture-dep", "index.js"),
      `module.exports = '${version}';\n`,
    );
    git("add", "package.json", "package-lock.json");
    git("commit", "-qm", `fixture dependencies ${version}`);
    return git("rev-parse", "HEAD");
  };
  const ready = commit("1.0.0");
  git("branch", "main", ready);
  const cfg = releaseConfig({
    integrationRoot: integration,
    releaseRoot: join(root, "release"),
    checkpointRoot: join(root, "checkpoint"),
    checkpointLogDir: join(root, "logs"),
    integrationBranch: "staging",
    releaseRef: "main",
  });
  const knownGood = commit("2.0.0");
  const knownGoodGeneration = await ensureCheckpointDependencyGeneration(
    cfg,
    knownGood,
    runCmd,
  );
  const tip = commit("3.0.0");
  const tipGeneration = await ensureCheckpointDependencyGeneration(
    cfg,
    tip,
    runCmd,
  );
  expect(knownGoodGeneration.inputFingerprint).not.toBe(
    tipGeneration.inputFingerprint,
  );
  const lockDir = checkpointRunLockDir(cfg.checkpointLogDir, integration);
  const events: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async () => {
      throw new Error("selection may not materialize before preparation");
    },
    runGreen: async () => {
      throw new Error("selection may not execute a suite");
    },
    advance: (candidate) => advanceReady(integration, candidate, "main"),
    push: async () => {},
    broadcast: async () => {},
    escalate: async () => {},
    clearEscalation: async () => {},
    emitEvent: async () => {},
    log: () => {},
    readFrozenRepairQueue: async () => {
      events.push("read-authority");
      return null;
    },
    resolveKnownGoodRecutTarget: async () => {
      events.push("select-known-good");
      return knownGood;
    },
  };
  const prepare = async (opts: CheckpointOpts = {}) => {
    const input: SelectionInput = {
      target: null,
      checkpointSelection: { deps, opts },
    };
    const result = await beginCheckpointPreflight(cfg, tip, runCmd, input);
    if (result.kind !== "ready")
      throw new Error("fixture candidate must be applicable");
    onTestFinished(() => {
      if (result.lock.acquired) result.lock.release();
    });
    return result;
  };
  const carry = (): FrozenRepairPendingCarry => ({
    schemaVersion: 1,
    fromCandidate: knownGood,
    fromRepairHead: tip,
    reason: "owner-retire",
    retiredAtMs: 1,
    truncated: false,
    admitted: [
      {
        path: "package-lock.json",
        blob: git("rev-parse", `${tip}:package-lock.json`),
      },
    ],
  });
  return {
    root,
    cfg,
    integration,
    ready,
    knownGood,
    tip,
    knownGoodGeneration,
    tipGeneration,
    lockDir,
    deps,
    events,
    prepare,
    carry,
  };
}

describe("fresh candidate preparation: independent production-boundary acceptance", () => {
  it("selects known-good before preparing the exact distinct dependency inputs", async () => {
    const f = await lineage();
    const prepared = await f.prepare({ noPush: true });
    expect(prepared.candidate).toBe(f.knownGood);
    expect(prepared.prewarmedDependencyGeneration).toMatchObject({
      candidate: f.knownGood,
      identity: f.knownGoodGeneration.identity,
      token: f.knownGoodGeneration.token,
      inputFingerprint: f.knownGoodGeneration.inputFingerprint,
    });
    expect(f.events).toContain("select-known-good");
    expect(prepared.lock.acquired).toBe(true);
    expect(Reflect.get(prepared, "preparedSelection")).toBeDefined();
  }, 180_000);

  it("an explicit candidate keeps precedence and prepares its own exact generation", async () => {
    const f = await lineage();
    const prepared = await f.prepare({
      candidate: f.tip,
      candidateSource: "pinned",
      noPush: true,
    });
    expect(prepared.candidate).toBe(f.tip);
    expect(prepared.prewarmedDependencyGeneration).toMatchObject({
      candidate: f.tip,
      identity: f.tipGeneration.identity,
      token: f.tipGeneration.token,
      inputFingerprint: f.tipGeneration.inputFingerprint,
    });
    expect(f.events).not.toContain("select-known-good");
    expect(prepared.lock.acquired).toBe(true);
  }, 180_000);

  it("the runner consumes the same prepared selection without a second known-good decision", async () => {
    const f = await lineage();
    const prepared = await f.prepare({ noPush: true });
    const proposal = Reflect.get(prepared, "preparedSelection");
    expect(proposal).toBeDefined();
    let reselected = false;
    f.deps.resolveKnownGoodRecutTarget = async () => {
      reselected = true;
      return f.tip;
    };
    const real = realCheckpointDeps(
      f.cfg,
      runCmd,
      "independent-prepared-run",
      undefined,
      undefined,
      undefined,
      prepared.prewarmedDependencyGeneration,
    );
    const opts: PreparedOpts = { noPush: true, preparedSelection: proposal };
    const result = await runGreenCheckpoint(
      f.cfg,
      {
        ...f.deps,
        prepareSource: real.prepareSource,
        setupTree: real.setupTree,
        runGreen: async (tree) => {
          expect(
            readFileSync(join(tree, "package-lock.json"), "utf8"),
          ).toContain("2.0.0");
          expect(
            readFileSync(
              join(tree, "node_modules", "fixture-dep", "index.js"),
              "utf8",
            ),
          ).toContain("2.0.0");
          return {
            green: true,
            summary: "exact prepared fixture bytes executed",
            failingTests: [],
          };
        },
      },
      opts,
    );
    expect(reselected).toBe(false);
    expect(result.candidate).toBe(f.knownGood);
    expect(result.freezeCut).toMatchObject({
      source: "known-good",
      candidate: f.knownGood,
      tip: f.tip,
    });
    expect(result.green).toBe(true);
  }, 180_000);

  it("dependency publication occurs before acquiring the serializer", async () => {
    const f = await lineage();
    expect(existsSync(f.lockDir)).toBe(false);
    const order: string[] = [];
    const exec: typeof runCmd = async (cmd, args, options) => {
      if (args.includes("--ensure-ref")) {
        expect(existsSync(f.lockDir)).toBe(false);
        order.push("prepare-unlocked");
      }
      return runCmd(cmd, args, options);
    };
    const input: SelectionInput = {
      target: null,
      checkpointSelection: { deps: f.deps, opts: { candidate: f.tip } },
    };
    const prepared = await beginCheckpointPreflight(f.cfg, f.tip, exec, input);
    if (prepared.kind !== "ready")
      throw new Error("fixture candidate must be applicable");
    onTestFinished(() => {
      if (prepared.lock.acquired) prepared.lock.release();
    });
    expect(order).toEqual(["prepare-unlocked"]);
    expect(prepared.lock.acquired).toBe(true);
  }, 180_000);

  it("commits carried fixes exactly once under the serializer after preparing the carried candidate", async () => {
    const f = await lineage();
    const pending = f.carry();
    let consumed = 0;
    f.deps.readFrozenRepairPendingCarry = async () => pending;
    f.deps.consumeFrozenRepairCarry = async (expected, record) => {
      expect(existsSync(f.lockDir)).toBe(true);
      expect(expected).toEqual(pending);
      expect(record.judgedCandidate).toBe(f.tip);
      consumed += 1;
      return true;
    };
    const prepared = await f.prepare({ noPush: true });
    expect(prepared.candidate).toBe(f.tip);
    expect(prepared.prewarmedDependencyGeneration).toMatchObject({
      candidate: f.tip,
      inputFingerprint: f.tipGeneration.inputFingerprint,
    });
    expect(consumed).toBe(1);
    expect(prepared.lock.acquired).toBe(true);
  }, 180_000);

  it("a failed preparation leaves carry authority untouched and acquires no serializer", async () => {
    const f = await lineage();
    const pending = f.carry();
    let consumed = 0;
    f.deps.readFrozenRepairPendingCarry = async () => pending;
    f.deps.consumeFrozenRepairCarry = async () => {
      consumed += 1;
      return true;
    };
    const exec: typeof runCmd = async (cmd, args, options) => {
      if (args.includes("--ensure-ref"))
        throw new Error("independent fixture: publication failed");
      return runCmd(cmd, args, options);
    };
    const input: SelectionInput = {
      target: null,
      checkpointSelection: { deps: f.deps, opts: { noPush: true } },
    };
    await expect(
      beginCheckpointPreflight(f.cfg, f.tip, exec, input),
    ).rejects.toThrow("publication failed");
    expect(consumed).toBe(0);
    expect(existsSync(f.lockDir)).toBe(false);
    expect(pending).toEqual(f.carry());
  }, 180_000);

  it.each([
    ["inherited deadline", { runStartedAtMs: 1, totalRefires: 0 }],
    [
      "absolute retry ceiling",
      { runStartedAtMs: Date.now(), totalRefires: Number.MAX_SAFE_INTEGER },
    ],
  ] as const)(
    "authority churn terminates at the exhausted %s without leaving a lock",
    async (_label, budget) => {
      const f = await lineage();
      let revision = 0;
      let preparationCount = 0;
      f.deps.readFrozenRepairPendingCarry = async () => ({
        ...f.carry(),
        retiredAtMs: ++revision,
      });
      f.deps.consumeFrozenRepairCarry = async () => false;
      const exec: typeof runCmd = async (cmd, args, options) => {
        if (args.includes("--ensure-ref")) {
          expect(existsSync(f.lockDir)).toBe(false);
          preparationCount += 1;
        }
        return runCmd(cmd, args, options);
      };
      const opts: CheckpointOpts = { ...budget, noPush: true };
      const input: SelectionInput = {
        target: null,
        checkpointSelection: { deps: f.deps, opts },
      };
      const outcome = await beginCheckpointPreflight(
        f.cfg,
        f.tip,
        exec,
        input,
      ).then(
        (result) => {
          // Release even a faulty implementation's ready result, after measuring the leak.
          const held = existsSync(f.lockDir);
          if (result.kind === "ready" && result.lock.acquired)
            result.lock.release();
          return { kind: result.kind, held, error: "" };
        },
        (error) => ({
          kind: "refused",
          held: existsSync(f.lockDir),
          error: String(error),
        }),
      );
      expect(outcome.kind).not.toBe("ready");
      expect(outcome.held).toBe(false);
      if (outcome.kind === "refused")
        expect(outcome.error).toMatch(
          /budget|deadline|exhaust|churn|refire|authority|invalid/i,
        );
      expect(preparationCount).toBeLessThanOrEqual(1);
      expect(opts).toEqual({ ...budget, noPush: true });
    },
    180_000,
  );
});
