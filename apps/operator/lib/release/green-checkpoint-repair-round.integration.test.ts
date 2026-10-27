import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildGreenCheckpointEnv,
  verifyRepairHead,
  type FailingFile,
  type RepairHeadVerificationDeps,
} from "./green-checkpoint";
import {
  createFrozenCandidateQueue,
  markFrozenCandidateVerificationRed,
  markFrozenRepairAdmitted,
  markFrozenRepairFixerDispatched,
  markFrozenRepairVerificationGreen,
  markFrozenRepairVerificationRed,
  parseFrozenCandidateRepairQueue,
  summarizeFrozenRepairConvergence,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import {
  buildPassingTaskVerdictIdentity,
  decidePassingTaskVerdict,
  emptyPassingTaskVerdictCache,
  mergePassingTaskVerdictUpdates,
  passingTaskVerdictCacheEntry,
  passingTaskVerdictDependencyProvenance,
  passingTaskVerdictEntry,
  passingTaskVerdictIdentityEnvironment,
  readPassingTaskVerdictCache,
  shouldStorePassingTaskVerdict,
  writePassingTaskVerdictCacheAtomic,
  type PassingTaskVerdictIdentity,
} from "../../../../scripts/lib/passing-task-verdict-cache.mjs";

/**
 * Integration proof for plan repair-round-evidence-preserving-convergence-2026-09-13
 * (R-1..R-5), across the real seams the unit suites stub out.
 *
 * - A REAL git repository holds the frozen candidate and every admitted repair head. The
 *   runners materialize the ref they are handed in a separate REAL worktree (the way the
 *   production `setupTree` checkout does) and report the HEAD git actually checked out, so
 *   "which commit was measured" is git's answer, never an echo of the argument.
 * - The test ORACLE is independent of the code under test: a test file passes iff its
 *   subject file at the measured commit says FIXED, fails on BROKEN, and errors (crashed /
 *   unexecuted) on CRASH or a missing test file. It never reads the queue or the gate.
 * - The queue moves only through the production transitions (create → red → dispatch →
 *   admit → verify → red/green), and every persisted state survives a JSON round trip through
 *   `parseFrozenCandidateRepairQueue`, the way the gate re-reads it from Postgres each tick.
 * - R-3 uses the peer-owned passing-task verdict cache on disk (atomic write + re-read).
 */

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "repair-round-fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "repair-round-fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

const WORKSPACES = ["a", "b", "c", "d"] as const;
type Unit = (typeof WORKSPACES)[number];
const ws = (unit: Unit) => `@fixture/${unit}`;
const testFile = (unit: Unit) => `lib/${unit}.test.ts`;
const subjectFile = (unit: Unit) => `lib/${unit}.ts`;
const LINT_GATE = "lint:remaining";

let root = "";
let repo = "";
let checkout = "";
let base = "";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Commit `files` on top of `parent` (detached) and return the new commit sha. */
function commitOn(parent: string, files: Record<string, string>, message: string): string {
  git(repo, ["checkout", "-q", "--detach", parent]);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-verify", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function candidateTree(states: Record<Unit, string>, lint: string): Record<string, string> {
  const files: Record<string, string> = { "lint.cfg": `${lint}\n` };
  for (const unit of WORKSPACES) {
    files[subjectFile(unit)] = `${states[unit]}\n`;
    files[testFile(unit)] = `expect(${unit}).toBe("FIXED")\n`;
  }
  return files;
}

/** Materialize `ref` in the measuring worktree; return the commit git actually checked out. */
function materialize(ref: string): string {
  git(checkout, ["checkout", "-q", "--detach", ref]);
  return git(checkout, ["rev-parse", "HEAD"]);
}

/** The independent oracle: judged from the checked-out tree only. */
function oracle(unit: Unit): "pass" | "fail" | "errored" {
  if (!existsSync(join(checkout, testFile(unit)))) return "errored";
  const subject = readFileSync(join(checkout, subjectFile(unit)), "utf8");
  if (subject.includes("CRASH")) return "errored";
  if (subject.includes("BROKEN")) return "fail";
  return subject.includes("FIXED") ? "pass" : "errored";
}

function unitOf(file: string): Unit {
  const match = /^lib\/([a-d])\.test\.ts$/.exec(file);
  if (!match) throw new Error(`fixture has no unit for ${file}`);
  return match[1] as Unit;
}

function unitOfWorkspace(id: string): Unit | null {
  const match = /^@fixture\/([a-d])$/.exec(id);
  return match ? (match[1] as Unit) : null;
}

interface RunnerLog {
  handed: string[];
  measured: string[];
  radiusPaths: string[][];
  fileRuns: string[][];
  gateRuns: string[][];
}

function realDeps(opts: { measureInstead?: string; crashFiles?: boolean } = {}): {
  deps: RepairHeadVerificationDeps;
  log: RunnerLog;
} {
  const log: RunnerLog = { handed: [], measured: [], radiusPaths: [], fileRuns: [], gateRuns: [] };
  const measure = (ref: string): string => {
    log.handed.push(ref);
    const head = materialize(opts.measureInstead ?? ref);
    log.measured.push(head);
    return head;
  };
  const deps: RepairHeadVerificationDeps = {
    affectedTestsAtRef: async (ref, paths) => {
      measure(ref);
      log.radiusPaths.push([...paths]);
      const files: FailingFile[] = [];
      const gateIds: string[] = [];
      for (const path of paths) {
        const match = /^lib\/([a-d])\.ts$/.exec(path);
        if (match && existsSync(join(checkout, testFile(match[1] as Unit)))) {
          files.push({ workspace: ws(match[1] as Unit), file: testFile(match[1] as Unit) });
        } else if (path === "lint.cfg") {
          gateIds.push(LINT_GATE);
        }
      }
      return {
        files,
        gateIds,
        summary: `related radius files=${files.length} gates=${gateIds.length}`,
        coverageComplete: true,
      };
    },
    runTestsAtRef: async (ref, files) => {
      if (opts.crashFiles) throw new Error("runner process died before measuring");
      const head = measure(ref);
      log.fileRuns.push(files.map((f) => f.file));
      const groups = new Map<string, string[]>();
      for (const f of files) groups.set(f.workspace, [...(groups.get(f.workspace) ?? []), f.file]);
      const perWorkspace = [...groups].map(([workspace, groupFiles]) => {
        const statuses = groupFiles.map((file) => oracle(unitOf(file)));
        const status = statuses.includes("errored")
          ? ("errored" as const)
          : statuses.includes("fail")
            ? ("fail" as const)
            : ("pass" as const);
        return { workspace, files: groupFiles, status };
      });
      const pass = perWorkspace.every((g) => g.status === "pass");
      return {
        pass,
        summary: `${perWorkspace.filter((g) => g.status === "pass").length}/${perWorkspace.length} group(s) passed`,
        measuredHead: head,
        coverageComplete: true,
        perWorkspace,
      };
    },
    runGateAtRef: async (ref, ids) => {
      const head = measure(ref);
      log.gateRuns.push([...ids]);
      const perGate = ids.map((id) => {
        const unit = unitOfWorkspace(id);
        if (unit) return { id, status: oracle(unit) };
        if (id === LINT_GATE) {
          const lint = readFileSync(join(checkout, "lint.cfg"), "utf8");
          return { id, status: lint.includes("clean") ? ("pass" as const) : ("fail" as const) };
        }
        return { id, status: "errored" as const };
      });
      return {
        pass: perGate.every((g) => g.status === "pass"),
        summary: `${perGate.filter((g) => g.status === "pass").length}/${perGate.length} gate(s) passed`,
        measuredHead: head,
        coverageComplete: true,
        perGate,
      };
    },
  };
  return { deps, log };
}

/** What the gate re-reads each tick: the persisted JSON, parsed back. */
function persist(queue: FrozenCandidateRepairQueue): FrozenCandidateRepairQueue {
  const reread = parseFrozenCandidateRepairQueue(JSON.parse(JSON.stringify(queue)));
  if (!reread) throw new Error("persisted repair queue did not parse back");
  return reread;
}

function redSignature(units: Unit[], lint: boolean) {
  return [
    ...units.flatMap((unit) => [
      {
        kind: "test-file" as const,
        id: testFile(unit),
        recipe: `npm run test:file -- ${testFile(unit)}`,
        workspace: ws(unit),
      },
      {
        kind: "workspace-task" as const,
        id: ws(unit),
        recipe: `npm run test -w ${ws(unit)}`,
        workspace: ws(unit),
      },
    ]),
    ...(lint ? [{ kind: "lint-leg" as const, id: LINT_GATE, recipe: `npm run ${LINT_GATE}` }] : []),
  ];
}

let clock = 1_000;
const tick = () => (clock += 10);

/** Open a real cycle on `candidate`: red at the candidate, fixer dispatched. */
function openCycle(candidate: string, units: Unit[], lint: boolean): FrozenCandidateRepairQueue {
  const created = createFrozenCandidateQueue({ candidate, base, nowMs: tick() });
  const red = markFrozenCandidateVerificationRed(created, {
    signature: redSignature(units, lint),
    nowMs: tick(),
  });
  return persist(markFrozenRepairFixerDispatched(red, { spawnId: `fixer-${clock}`, nowMs: tick() }));
}

function admission(queue: FrozenCandidateRepairQueue, head: string, paths: string[]): FrozenRepairAdmission {
  return {
    atMs: tick(),
    actor: "integration-fixer",
    source: { ref: "staging", sha: head },
    fromRepairHead: queue.repairHead,
    toRepairHead: head,
    paths,
    unchanged: [],
    blobs: Object.fromEntries(paths.map((p) => [p, git(repo, ["rev-parse", `${head}:${p}`])])),
  };
}

function admit(queue: FrozenCandidateRepairQueue, head: string, paths: string[]): FrozenCandidateRepairQueue {
  return persist(markFrozenRepairAdmitted(queue, admission(queue, head, paths)));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "repair-round-integration-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "README.md"), "repair-round fixture\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--no-verify", "-m", "base"]);
  base = git(repo, ["rev-parse", "HEAD"]);
  checkout = join(root, "checkout");
  git(repo, ["worktree", "add", "-q", "--detach", checkout, base]);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("repair-round convergence over a real git lineage (R-1..R-5 integration)", () => {
  it("R-1: per-task measurement removes only genuine passes; crashed, unexecuted and unmeasured work stays on the frontier", async () => {
    const candidate = commitOn(
      base,
      candidateTree({ a: "BROKEN", b: "BROKEN", c: "CRASH", d: "FIXED" }, "dirty"),
      "r1 candidate",
    );
    let queue = openCycle(candidate, ["a", "b", "c"], true);
    const h1 = commitOn(candidate, { [subjectFile("a")]: "FIXED\n" }, "r1 fix a");
    queue = admit(queue, h1, [subjectFile("a")]);

    // A runner that dies before measuring discharges NOTHING.
    const crashed = realDeps({ crashFiles: true });
    const unavailable = await verifyRepairHead(crashed.deps, queue);
    expect(unavailable.kind).toBe("unavailable");
    expect(persist(queue).failingTests).toEqual(queue.failingTests);

    const { deps } = realDeps();
    const result = await verifyRepairHead(deps, queue);
    if (result.kind !== "red") throw new Error(`expected red, got ${result.kind}: ${result.summary}`);
    // a genuinely passed at h1 → removed. b genuinely failed, c crashed (errored) → retained.
    expect(result.failingTests).not.toContain(testFile("a"));
    expect(result.failingTests).toEqual(
      expect.arrayContaining([testFile("b"), testFile("c"), LINT_GATE]),
    );
    // A crashed group is not complete coverage, so no reusable receipt is minted from it.
    expect(result).not.toHaveProperty("selectiveCoverage");

    const measured = persist(
      markFrozenRepairVerificationRed(queue, {
        repairHead: h1,
        nowMs: tick(),
        failingTests: result.failingTests,
        signature: result.signature,
      }),
    );
    expect(measured.failingTests).toEqual(expect.arrayContaining([testFile("b"), testFile("c"), LINT_GATE]));
    expect(measured.failingTests).not.toContain(testFile("a"));
    expect(measured.selectiveCoverage).toBeUndefined();
  });

  it("R-2: after a complete head-bound receipt the next round selects only the new admission radius; missing or malformed proof falls back to cumulative", async () => {
    const candidate = commitOn(
      base,
      candidateTree({ a: "BROKEN", b: "BROKEN", c: "FIXED", d: "FIXED" }, "dirty"),
      "r2 candidate",
    );
    let queue = openCycle(candidate, ["a", "b"], true);
    const h1 = commitOn(candidate, { [subjectFile("a")]: "FIXED\n" }, "r2 fix a");
    queue = admit(queue, h1, [subjectFile("a")]);

    const round1 = realDeps();
    const first = await verifyRepairHead(round1.deps, queue);
    if (first.kind !== "red") throw new Error(`expected red, got ${first.kind}: ${first.summary}`);
    expect(first.summary).toContain("REPAIR_RADIUS mode=cumulative reason=no-complete-coverage paths=1");
    expect(first.selectiveCoverage).toEqual({ schemaVersion: 1, candidate, head: h1 });
    expect(round1.log.radiusPaths).toEqual([[subjectFile("a")]]);

    queue = persist(
      markFrozenRepairVerificationRed(queue, {
        repairHead: h1,
        nowMs: tick(),
        failingTests: first.failingTests,
        signature: first.signature,
        selectiveCoverage: first.selectiveCoverage,
      }),
    );
    expect(queue.selectiveCoverage).toEqual({ schemaVersion: 1, candidate, head: h1 });
    queue = persist(markFrozenRepairFixerDispatched(queue, { spawnId: "fixer-r2-2", nowMs: tick() }));
    const h2 = commitOn(h1, { [subjectFile("b")]: "FIXED\n" }, "r2 fix b");
    queue = admit(queue, h2, [subjectFile("b")]);

    const round2 = realDeps();
    const second = await verifyRepairHead(round2.deps, queue);
    expect(second.summary).toContain("REPAIR_RADIUS mode=delta reason=complete-admission-suffix paths=1");
    expect(round2.log.radiusPaths).toEqual([[subjectFile("b")]]);

    // Missing proof → cumulative radius over EVERY admission.
    const missing = persist({ ...queue, selectiveCoverage: undefined });
    const noReceipt = realDeps();
    const cumulative = await verifyRepairHead(noReceipt.deps, missing);
    expect(cumulative.summary).toContain("REPAIR_RADIUS mode=cumulative reason=no-complete-coverage paths=2");
    expect(noReceipt.log.radiusPaths).toEqual([[subjectFile("a"), subjectFile("b")]]);

    // Malformed / foreign proof (a head the ledger never produced) → cumulative.
    const foreign = persist({
      ...queue,
      selectiveCoverage: { schemaVersion: 1, candidate, head: commitOn(base, { "x.txt": "x\n" }, "foreign") },
    });
    const foreignRun = realDeps();
    const foreignResult = await verifyRepairHead(foreignRun.deps, foreign);
    expect(foreignResult.summary).toContain("REPAIR_RADIUS mode=cumulative reason=coverage-head-not-in-ledger paths=2");
    expect(foreignRun.log.radiusPaths).toEqual([[subjectFile("a"), subjectFile("b")]]);

    // Incomplete admission proof (a path without its blob) → cumulative.
    const incomplete = persist({
      ...queue,
      admissions: (queue.admissions ?? []).map((entry, index) =>
        index === (queue.admissions ?? []).length - 1 ? { ...entry, blobs: {} } : entry,
      ),
    });
    const incompleteRun = realDeps();
    const incompleteResult = await verifyRepairHead(incompleteRun.deps, incomplete);
    expect(incompleteResult.summary).toContain("REPAIR_RADIUS mode=cumulative reason=admission-path-proof-incomplete");

    // A possibly-truncated failure frontier (a duplicated id is not a lossless set) never
    // trusts the receipt.
    const truncated = persist({ ...queue, failingTests: [...queue.failingTests, queue.failingTests[0]!] });
    const truncatedRun = realDeps();
    const truncatedResult = await verifyRepairHead(truncatedRun.deps, truncated);
    expect(truncatedResult.summary).toContain("REPAIR_RADIUS mode=cumulative reason=failure-frontier-possibly-truncated");
  });

  it("R-3: the peer-owned passing-task cache ignores scheduler/transport noise but invalidates on semantic inputs", () => {
    const cacheRoot = join(root, "cache-fixture");
    const cachePath = join(cacheRoot, ".cache", "passing.json");
    const files = [
      "package-lock.json",
      "scripts/affected-tests.mjs",
      "packages/clean/src/index.ts",
      "packages/clean/src/index.test.ts",
    ];
    for (const file of files) {
      mkdirSync(dirname(join(cacheRoot, file)), { recursive: true });
      writeFileSync(join(cacheRoot, file), `${file}:initial\n`);
    }
    const workspaces = new Map([["@fixture/clean", { dir: "packages/clean", deps: [] as string[] }]]);
    const task = { key: "@fixture/clean :: test", script: "test", workspace: "@fixture/clean" };
    // Controlled runtime input for the cache-on-disk fixture; no test process
    // is launched by this case. Production runtime capture has separate guards.
    const runtimeIdentity = {
      name: "node", version: "25.9.0", executable: "/fixture/node",
      binarySha256: "a".repeat(64), platform: "linux", arch: "x64",
      nativeDependencyGeneration: "b".repeat(64), lockfileSha256: "c".repeat(64),
      configurationSha256: "d".repeat(64),
    };
    const gateConfig = { retryFailed: true, scheduler: { workers: 2, memoryMb: 4096 } };
    const launch = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: join(cacheRoot, "home"),
      USER: "gate",
      LANG: "C.UTF-8",
    };
    const identityFor = (
      environment: Record<string, unknown>,
      config: typeof gateConfig = gateConfig,
    ): PassingTaskVerdictIdentity | null => {
      const provenance = passingTaskVerdictDependencyProvenance({
        root: cacheRoot,
        taskKey: task.key,
        script: task.script,
        workspaceName: task.workspace,
        workspaces,
        trackedScan: { files, unscannedPresent: [] as string[] },
        repoWideTaskKeys: new Set<string>(),
      });
      if (!provenance.ok) return null;
      return buildPassingTaskVerdictIdentity({
        taskKey: task.key,
        command: {
          cmd: "npm",
          argv: ["run", task.script, "--workspace", task.workspace],
          cwd: cacheRoot,
          scriptText: `vitest run ${task.workspace}`,
        },
        environment,
        gateConfig: config,
        dependencyHash: provenance.hash,
        runtimeIdentity,
      });
    };

    const INITIAL_RUN = "r3-initial-proof";
    const initialEnv = passingTaskVerdictIdentityEnvironment(
      buildGreenCheckpointEnv(base, { ...launch, INVOCATION_ID: "manual-a", JOURNAL_STREAM: "8:1" }, INITIAL_RUN),
    ).environment;
    const initialIdentity = identityFor(initialEnv);
    expect(initialIdentity).not.toBeNull();
    expect(
      shouldStorePassingTaskVerdict({
        enabled: true,
        cacheStatus: "miss",
        initialStatus: 0,
        finalStatus: 0,
        absorptionRan: false,
        identity: initialIdentity,
      }),
    ).toBe(true);
    writePassingTaskVerdictCacheAtomic(
      cachePath,
      mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        INITIAL_RUN,
        { [task.key]: passingTaskVerdictEntry(initialIdentity!, "initial-pass") },
        "initial-pass",
      ),
      "initial",
    );

    // The repair verifier resolves the SAME proof group the queue carries — no second cache.
    const queue = createFrozenCandidateQueue({
      candidate: base,
      base,
      affectedTestProofGroup: INITIAL_RUN,
      nowMs: tick(),
    });
    expect(queue.affectedTestProofGroup).toBe(INITIAL_RUN);
    const verifierEnv = (config?: typeof gateConfig) =>
      identityFor(
        passingTaskVerdictIdentityEnvironment(
          buildGreenCheckpointEnv(
            base,
            {
              ...launch,
              INVOCATION_ID: "repair-b",
              JOURNAL_STREAM: "8:2",
              SYSTEMD_EXEC_PID: "4242",
              MEMORY_PRESSURE_WATCH: "/sys/fs/cgroup/bg-host/memory.pressure",
            },
            "r3-repair-verifier",
            "shared",
            queue.affectedTestProofGroup,
          ),
        ).environment,
        config,
      );
    const decide = (identity: PassingTaskVerdictIdentity | null) => {
      const persisted = readPassingTaskVerdictCache(cachePath);
      return decidePassingTaskVerdict({
        enabled: true,
        cacheRead: persisted,
        entry: passingTaskVerdictCacheEntry(persisted.cache, INITIAL_RUN, task.key),
        identity,
      });
    };

    // Scheduler/transport noise (a different launch unit, pid, journal stream, run id).
    expect(decide(verifierEnv())).toEqual({ hit: true, reason: "identity-match" });

    // Semantic input: the task's own assertions changed.
    writeFileSync(join(cacheRoot, "packages/clean/src/index.test.ts"), "assertion changed\n");
    expect(decide(verifierEnv()).hit).toBe(false);
    writeFileSync(join(cacheRoot, "packages/clean/src/index.test.ts"), "packages/clean/src/index.test.ts:initial\n");
    expect(decide(verifierEnv()).hit).toBe(true);

    // Semantic input: the shared runner/setup changed.
    writeFileSync(join(cacheRoot, "scripts/affected-tests.mjs"), "runner changed\n");
    expect(decide(verifierEnv()).hit).toBe(false);
    writeFileSync(join(cacheRoot, "scripts/affected-tests.mjs"), "scripts/affected-tests.mjs:initial\n");
    expect(decide(verifierEnv()).hit).toBe(true);

    // Semantic input: result interpretation (retry policy) changed.
    expect(decide(verifierEnv({ ...gateConfig, retryFailed: false })).hit).toBe(false);

    // A corrupt cache on disk fails closed.
    writeFileSync(cachePath, "{not json");
    expect(decide(verifierEnv()).hit).toBe(false);
  });

  it("R-4: every runner executes the exact repairHead; superseded evidence never certifies a newer head; selective green is not promotion proof", async () => {
    const candidate = commitOn(
      base,
      candidateTree({ a: "BROKEN", b: "BROKEN", c: "FIXED", d: "FIXED" }, "clean"),
      "r4 candidate",
    );
    let queue = openCycle(candidate, ["a", "b"], false);
    const h1 = commitOn(candidate, { [subjectFile("a")]: "FIXED\n" }, "r4 fix a");
    queue = admit(queue, h1, [subjectFile("a")]);

    const round1 = realDeps();
    const first = await verifyRepairHead(round1.deps, queue);
    if (first.kind !== "red") throw new Error(`expected red, got ${first.kind}: ${first.summary}`);
    expect(new Set(round1.log.handed)).toEqual(new Set([h1]));
    expect(new Set(round1.log.measured)).toEqual(new Set([h1]));
    expect(round1.log.handed).not.toContain(candidate);

    queue = persist(
      markFrozenRepairVerificationRed(queue, {
        repairHead: h1,
        nowMs: tick(),
        failingTests: first.failingTests,
        signature: first.signature,
        selectiveCoverage: first.selectiveCoverage,
      }),
    );
    queue = persist(markFrozenRepairFixerDispatched(queue, { spawnId: "fixer-r4-2", nowMs: tick() }));
    const h2 = commitOn(h1, { [subjectFile("b")]: "FIXED\n" }, "r4 fix b");
    queue = admit(queue, h2, [subjectFile("b")]);

    // A runner whose checkout is stuck on the superseded head h1 cannot certify h2.
    const stale = realDeps({ measureInstead: h1 });
    const staleResult = await verifyRepairHead(stale.deps, queue);
    expect(staleResult.kind).toBe("unavailable");
    expect(new Set(stale.log.measured)).toEqual(new Set([h1]));

    // Superseded verdicts/receipts are refused against the newer head.
    expect(() =>
      markFrozenRepairVerificationGreen(queue, { repairHead: h1, nowMs: tick() }),
    ).toThrow();
    expect(() =>
      markFrozenRepairVerificationRed(queue, {
        repairHead: h2,
        nowMs: tick(),
        failingTests: first.failingTests,
        signature: first.signature,
        selectiveCoverage: { schemaVersion: 1, candidate, head: h1 },
      }),
    ).toThrow();

    const round2 = realDeps();
    const green = await verifyRepairHead(round2.deps, queue);
    expect(green.kind).toBe("green");
    expect(new Set(round2.log.measured)).toEqual(new Set([h2]));
    expect(green.summary).toContain("the full gate at");
    expect(green.summary).toContain("is the promotion proof");
    const ready = persist(markFrozenRepairVerificationGreen(queue, { repairHead: h2, nowMs: tick() }));
    // Selective success only makes the head READY for the full gate; it promotes nothing.
    expect(ready.phase).toBe("ready-to-promote");
    expect(ready.repairHead).toBe(h2);
    expect(ready.candidate).toBe(candidate);
  });

  it("R-5: the radius explanation names delta vs cumulative, and a newly affected regression grows the failure count honestly", async () => {
    const candidate = commitOn(
      base,
      candidateTree({ a: "BROKEN", b: "BROKEN", c: "FIXED", d: "FIXED" }, "clean"),
      "r5 candidate",
    );
    let queue = openCycle(candidate, ["a", "b"], false);
    const h1 = commitOn(candidate, { [subjectFile("a")]: "FIXED\n" }, "r5 fix a");
    queue = admit(queue, h1, [subjectFile("a")]);
    const first = await verifyRepairHead(realDeps().deps, queue);
    if (first.kind !== "red") throw new Error(`expected red, got ${first.kind}: ${first.summary}`);
    expect(first.summary).toMatch(/REPAIR_RADIUS mode=cumulative reason=no-complete-coverage paths=1; 1 admitted path\(s\) → /);
    queue = persist(
      markFrozenRepairVerificationRed(queue, {
        repairHead: h1,
        nowMs: tick(),
        failingTests: first.failingTests,
        signature: first.signature,
        selectiveCoverage: first.selectiveCoverage,
      }),
    );
    const afterFirst = queue.failingTests.length;

    queue = persist(markFrozenRepairFixerDispatched(queue, { spawnId: "fixer-r5-2", nowMs: tick() }));
    // The next admission touches d and BREAKS it — a newly affected regression.
    const h2 = commitOn(h1, { [subjectFile("d")]: "BROKEN\n" }, "r5 regress d");
    queue = admit(queue, h2, [subjectFile("d")]);
    const second = await verifyRepairHead(realDeps().deps, queue);
    if (second.kind !== "red") throw new Error(`expected red, got ${second.kind}: ${second.summary}`);
    expect(second.summary).toMatch(/REPAIR_RADIUS mode=delta reason=complete-admission-suffix paths=1; 1 admitted path\(s\) → /);
    expect(second.failingTests).toEqual(expect.arrayContaining([testFile("b"), testFile("d")]));
    queue = persist(
      markFrozenRepairVerificationRed(queue, {
        repairHead: h2,
        nowMs: tick(),
        failingTests: second.failingTests,
        signature: second.signature,
        selectiveCoverage: second.selectiveCoverage,
      }),
    );
    expect(queue.failingTests.length).toBeGreaterThan(afterFirst);

    const summary = summarizeFrozenRepairConvergence(queue, tick());
    const last = summary.shrinkPerRound[summary.shrinkPerRound.length - 1]!;
    expect(last.failingCount).toBe(queue.failingTests.length);
    expect(last.delta).toBeGreaterThan(0);
    expect(summary.converging).toBe(false);
  });
});
