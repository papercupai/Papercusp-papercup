/**
 * Independent prospective tests for fresh-cut-prewarm-ordering-2026-10-22.
 * WI-6554700010020448; production boundary agreed in D-008.
 * These tests use the existing exports, real temporary Git history and real
 * dependency publication/materialization. Selection itself is never replaced.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
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
  type PrewarmedCheckpointDependencyGeneration,
} from "./green-checkpoint";
import { releaseConfig } from "./release-config";
import { advanceReady } from "./git-ops";
import type { FrozenRepairCarryRecord, FrozenRepairPendingCarry } from "@papercusp/operator-core/lib/release/frozen-repair-carry";
import type { FrozenCandidateRepairQueue } from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import type { CheckpointCandidateSource } from "@papercusp/operator-core/lib/release/checkpoint-candidate-source";
import type { FreezeCutRecord } from "@papercusp/operator-core/lib/release/known-good-freeze";

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
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  const exec: typeof runCmd = async (cmd, args, options = {}) => {
    const tail: string[] = [];
    try {
      return await runCmd(cmd, args, {
        ...options,
        timeoutMs: 60_000,
        hardTimeoutMs: 60_000,
        killProcessGroupOnTimeout: true,
        signal: controller.signal,
        onOutput: (stream, text) => {
          options.onOutput?.(stream, text);
          tail.push(text.slice(-500));
          if (tail.length > 6) tail.shift();
        },
      });
    } catch (error) {
      throw new Error(
        `fixture command ${cmd} ${args.join(" ")}: ${String(error)}\n${tail.join("")}`,
      );
    }
  };
  vi.stubEnv("PC_HEAVY_DIR", join(root, "pc-heavy"));
  vi.stubEnv("PAPERCUSP_DEPENDENCY_GENERATION_ROOT", join(root, "generations"));
  vi.stubEnv("DEPENDENCY_GENERATION_COPY_LOCK_FILE", join(root, "dependency-copy.lock"));
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
    exec,
  );
  const tip = commit("3.0.0");
  const tipGeneration = await ensureCheckpointDependencyGeneration(
    cfg,
    tip,
    exec,
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
  const prepare = async (opts: CheckpointOpts = {}, execute = exec, selectionDeps = deps) => {
    const input: SelectionInput = {
      target: null,
      checkpointSelection: { deps: selectionDeps, opts },
    };
    const result = await beginCheckpointPreflight(cfg, tip, execute, input);
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
    exec,
    carry,
  };
}

type Lineage = Awaited<ReturnType<typeof lineage>>;

// D-010's public record shape, available before the source implementation exists.
type FixturePreparedSelection = {
  schemaVersion: 1;
  attemptId: string;
  integrationRoot: string;
  checkpointRoot: string;
  candidate: string;
  tip: string;
  base: string | null;
  candidateSource: CheckpointCandidateSource;
  quietCutApplied: boolean;
  freezeCut: FreezeCutRecord | null;
  generation: PrewarmedCheckpointDependencyGeneration & { root: string };
  carry: FrozenRepairCarryRecord | null;
};
type FixtureSelectionAuthority = {
  pending: FrozenRepairPendingCarry | null;
  committed: FrozenRepairCarryRecord | null;
  selection: FixturePreparedSelection | null;
  consumed: number;
};

function durablePreparedSelectionHooks(f: Lineage, authority: string, afterCommit?: () => void) {
  const read = (): FixtureSelectionAuthority => JSON.parse(readFileSync(authority, "utf8"));
  return {
    readPreparedCheckpointSelection: async (requested: {
      attemptId: string; integrationRoot: string; checkpointRoot: string;
    }) => {
      const record = read().selection;
      if (record && (record.schemaVersion !== 1 || record.attemptId !== requested.attemptId ||
          record.integrationRoot !== requested.integrationRoot || record.checkpointRoot !== requested.checkpointRoot))
        throw new Error("malformed or mismatched committed authority");
      return record;
    },
    commitPreparedCheckpointSelection: async (record: FixturePreparedSelection, expected: {
      queue: FrozenCandidateRepairQueue | null; pendingCarry: FrozenRepairPendingCarry | null;
    }) => {
      expect(existsSync(f.lockDir)).toBe(true);
      const state = read();
      if (expected.queue !== null || JSON.stringify(state.pending) !== JSON.stringify(expected.pendingCarry)) return false;
      if (state.selection) throw new Error("rejoin must not commit or consume twice");
      const next: FixtureSelectionAuthority = {
        pending: null, committed: record.carry, selection: record,
        consumed: state.consumed + (state.pending ? 1 : 0),
      };
      const temporary = `${authority}.${process.pid}`;
      const fd = openSync(temporary, "w");
      try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, authority);
      const directory = openSync(f.root, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
      afterCommit?.();
      return true;
    },
  };
}

// The child program lives in the frozen test itself: its checksum covers every recovery effect.
const RESTART_WORKER_SOURCE = `/** Test-only process adapter for the public D-010 checkpoint dependency seam. */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginCheckpointPreflight, realCheckpointDeps, runCmd, runGreenCheckpoint } from "__CHECKPOINT_MODULE_URL__";
import { releaseConfig } from "__CONFIG_MODULE_URL__";
import { advanceReady } from "__GIT_MODULE_URL__";
const input = JSON.parse(process.argv[2]);
const authority = join(input.root, "restart-authority.json");
const read = () => JSON.parse(readFileSync(authority, "utf8"));
// The fixture models an atomic durable authority write, not a selection algorithm.
function persist(state) {
    const temporary = \`\${authority}.\${process.pid}\`;
    const fd = openSync(temporary, "w");
    try {
        writeFileSync(fd, JSON.stringify(state));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(temporary, authority);
    const directory = openSync(input.root, "r");
    try {
        fsyncSync(directory);
    }
    finally {
        closeSync(directory);
    }
}
function count(key) {
    const state = read();
    state[key] += 1;
    persist(state);
}
const cfg = releaseConfig({ integrationRoot: join(input.root, "integration"),
    checkpointRoot: join(input.root, "checkpoint"), releaseRoot: join(input.root, "release"),
    checkpointLogDir: join(input.root, "logs"), integrationBranch: "staging", releaseRef: "main" });
const exec = (cmd, args, options) => runCmd(cmd, args, {
    ...options, timeoutMs: 60_000, hardTimeoutMs: 60_000, killProcessGroupOnTimeout: true,
});
const deps = {
    runId: input.attemptId, qualificationAttemptId: input.attemptId,
    setupTree: async () => { throw new Error("preflight may not materialize"); },
    runGreen: async () => { throw new Error("preflight may not run a suite"); },
    advance: (candidate) => advanceReady(cfg.integrationRoot, candidate, "main"),
    push: async () => { }, broadcast: async () => { },
    escalate: async () => { }, clearEscalation: async () => { }, emitEvent: async () => { }, log: () => { },
    readFrozenRepairQueue: async () => null,
    readFrozenRepairPendingCarry: async () => {
        const state = read();
        if (state.casLosses > 0) throw new Error("injected authority unavailable after atomic CAS loss");
        return state.pending;
    },
    consumeFrozenRepairCarry: async () => { throw new Error("durable selection must commit atomically with carry"); },
    resolveKnownGoodRecutTarget: async () => {
        count("selections");
        if (read().committed)
            throw new Error("restart may not select known-good again");
        return input.knownGood;
    },
    readPreparedCheckpointSelection: async (requested) => {
        count("reads");
        if (input.mode === "unreadable")
            throw new Error("injected unreadable committed authority");
        const record = read().committed;
        if (!record)
            return null;
        if (record.schemaVersion !== 1 || record.attemptId !== requested.attemptId ||
            record.integrationRoot !== requested.integrationRoot || record.checkpointRoot !== requested.checkpointRoot)
            throw new Error("malformed or mismatched committed authority");
        // Round-trip JSON: this process has no objects/closures from the writer.
        return record;
    },
    commitPreparedCheckpointSelection: async (record, expected) => {
        const state = read();
        if (input.mode === "cas-loss") {
            state.casLosses += 1;
            persist(state);
            return false;
        }
        if (expected.queue !== null || JSON.stringify(expected.pendingCarry) !== JSON.stringify(state.pending))
            return false;
        if (state.committed)
            throw new Error("restart may not commit or consume again");
        state.committed = record;
        state.commits += 1;
        if (state.pending)
            state.consumeCount += 1;
        state.pending = null;
        persist(state);
        // Abrupt process death leaves the real serializer behind. Rejoin must recover it.
        if (input.mode === "commit-crash")
            process.kill(process.pid, "SIGKILL");
        return true;
    },
};
let prepared;
try {
    const options = { target: null, checkpointSelection: { deps, opts: { noPush: true } } };
    prepared = await beginCheckpointPreflight(cfg, input.tip, exec, options);
    if (prepared.kind !== "ready")
        throw new Error("fixture integration candidate disappeared");
    if (input.mode === "resume") {
        const real = realCheckpointDeps(cfg, exec, input.attemptId, undefined, undefined, undefined, prepared.prewarmedDependencyGeneration);
        await runGreenCheckpoint(cfg, { ...deps, prepareSource: real.prepareSource,
            setupTree: async (...args) => { count("materialized"); return real.setupTree(...args); },
            runGreen: async () => { count("suites"); throw new Error("injected stop after real materialization"); },
        }, { noPush: true, preparedSelection: Reflect.get(prepared, "preparedSelection") });
    }
    console.log("PREPARED_RESTART_RESULT " + JSON.stringify({ kind: "ready", pid: process.pid,
        candidate: prepared.candidate, generation: prepared.prewarmedDependencyGeneration, state: read() }));
}
catch (error) {
    console.log("PREPARED_RESTART_RESULT " + JSON.stringify({ kind: "refused", pid: process.pid,
        error: String(error), state: read() }));
}
finally {
    if (prepared?.kind === "ready" && prepared.lock.acquired)
        prepared.lock.release();
}
`;

function restartWorker(f: Lineage, mode: string, attemptId = "independent-durable-restart") {
  const worker = "independent-prepared-selection-restart";
  const workerProgram = RESTART_WORKER_SOURCE
    .replaceAll("__CHECKPOINT_MODULE_URL__", new URL("./green-checkpoint.ts", import.meta.url).href)
    .replaceAll("__CONFIG_MODULE_URL__", new URL("./release-config.ts", import.meta.url).href)
    .replaceAll("__GIT_MODULE_URL__", new URL("./git-ops.ts", import.meta.url).href);
  // Preserve the maintained committed-source loader while allowing native ESM TS.
  // This is the same child-loader boundary used by cut-seed-cli.test.ts.
  const resolver = `export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    if (result.url.startsWith("file:") && /\\.tsx?$/.test(new URL(result.url).pathname) &&
        !result.url.includes("/node_modules/")) return { ...result, format: "module-typescript" };
    return result;
  }
  export async function load(url, context, nextLoad) {
    const result = await nextLoad(url, context);
    // Vitest supplies the CommonJS path globals in these existing modules.
    // Supply their native ESM equivalent after the inherited source guard reads
    // the original bytes; neither source selection nor the guard is replaced.
    if (context.format === "module-typescript" && result.source &&
        (url.endsWith("/release-config.ts") || url.endsWith("/green-checkpoint.ts")))
      return { ...result, source:
        "import { createRequire as __fixtureCreateRequire } from 'node:module';\\n" +
        "const require = __fixtureCreateRequire(import.meta.url); const module = { exports: {} };\\n" +
        "const __dirname = import.meta.dirname;\\n" + result.source.toString() };
    return result;
  }`;
  const input = { root: f.root, tip: f.tip, knownGood: f.knownGood, attemptId, mode };
  const bootstrap = `import { register } from "node:module";
    register("data:text/javascript," + encodeURIComponent(${JSON.stringify(resolver)}), import.meta.url);
    process.argv = [process.execPath, ${JSON.stringify(worker)}, ${JSON.stringify(JSON.stringify(input))}];
    await import("data:text/javascript," + encodeURIComponent(${JSON.stringify(workerProgram)}));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", bootstrap], {
    encoding: "utf8", env: { ...process.env }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  const line = result.stdout.split("\n").find(text => text.startsWith("PREPARED_RESTART_RESULT "));
  if (!line && result.signal !== "SIGKILL") throw new Error(`restart worker did not report: ${result.stderr}\n${result.stdout}`);
  return { ...result, report: line ? JSON.parse(line.slice("PREPARED_RESTART_RESULT ".length)) : null };
}

function durableRestartState(f: Lineage) {
  return JSON.parse(readFileSync(join(f.root, "restart-authority.json"), "utf8"));
}

function initializeRestart(f: Lineage) {
  writeFileSync(join(f.root, "restart-authority.json"), JSON.stringify({
    pending: f.carry(), committed: null, consumeCount: 0, commits: 0, reads: 0,
    selections: 0, materialized: 0, suites: 0, casLosses: 0,
  }));
}

describe("D-010 durable selection recovery across actual process death", () => {
  it("reconstructs committed selection and carry in a fresh process without a second selection or consumption", async () => {
    const f = await lineage();
    initializeRestart(f);
    const writer = restartWorker(f, "commit-crash");
    expect(writer.signal, writer.stdout + writer.stderr).toBe("SIGKILL");
    const committed = durableRestartState(f);
    expect(committed).toMatchObject({ pending: null, consumeCount: 1, commits: 1, materialized: 0, suites: 0 });
    expect(committed.committed).toMatchObject({ schemaVersion: 1, attemptId: "independent-durable-restart",
      integrationRoot: f.integration, checkpointRoot: f.cfg.checkpointRoot, candidate: f.tip, tip: f.tip,
      base: f.ready, candidateSource: expect.any(String), quietCutApplied: false, freezeCut: null,
      generation: { candidate: f.tip, identity: f.tipGeneration.identity, token: f.tipGeneration.token,
        inputFingerprint: f.tipGeneration.inputFingerprint },
      carry: { judgedCandidate: f.tip, fromCandidate: f.knownGood, fromRepairHead: f.tip },
    });
    expect(existsSync(committed.committed.generation.root)).toBe(true);
    const restarted = restartWorker(f, "resume");
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(restarted.report.pid).not.toBe(process.pid);
    expect(restarted.report.pid).not.toBe(writer.pid);
    const recovered = durableRestartState(f);
    expect(recovered.committed).toEqual(committed.committed);
    expect(recovered.reads).toBeGreaterThan(committed.reads);
    expect(recovered.selections).toBe(committed.selections);
    expect(recovered).toMatchObject({ pending: null, consumeCount: 1, commits: 1, materialized: 1, suites: 1 });
    expect(existsSync(f.lockDir)).toBe(false);

    // A new process must forward a malformed durable-authority refusal before
    // another materialization, even though the real candidate still exists.
    recovered.committed.schemaVersion = 2;
    writeFileSync(join(f.root, "restart-authority.json"), JSON.stringify(recovered));
    const malformed = restartWorker(f, "resume");
    expect(malformed.report.kind).toBe("refused");
    expect(malformed.report.error).toMatch(/malformed|authority|mismatch/i);
    expect(durableRestartState(f)).toMatchObject({ consumeCount: 1, commits: 1, materialized: 1, suites: 1 });
    expect(existsSync(f.lockDir)).toBe(false);

    // Exercise the actual atomic companion's false result, independently of
    // the legacy consumeFrozenRepairCarry CAS assertions retained below.
    initializeRestart(f);
    const lost = restartWorker(f, "cas-loss", "independent-atomic-cas-loss");
    expect(lost.report.kind).toBe("refused");
    expect(lost.report.error).toMatch(/CAS|authority|invalid/i);
    expect(durableRestartState(f)).toMatchObject({ pending: f.carry(), committed: null,
      casLosses: 1, consumeCount: 0, commits: 0, materialized: 0, suites: 0 });
    expect(existsSync(f.lockDir)).toBe(false);
  }, 360_000);

  it.each(["token", "attempt", "checkpoint root", "unreadable"] as const)(
    "refuses %s authority on fresh-process recovery before materialization", async (corruption) => {
      const f = await lineage();
      initializeRestart(f);
      const writer = restartWorker(f, "commit-crash");
      expect(writer.signal, writer.stdout + writer.stderr).toBe("SIGKILL");
      const before = durableRestartState(f);
      if (corruption === "token") {
        const marker = join(f.root, "generations", before.committed.generation.identity, ".papercusp-dependency-generation");
        chmodSync(marker, 0o600);
        writeFileSync(marker, readFileSync(marker, "utf8").replace(/^publication_token=.*$/m, `publication_token=v3:${"0".repeat(64)}`));
      } else if (corruption === "attempt") before.committed.attemptId = "unrelated-attempt";
      else if (corruption === "checkpoint root") before.committed.checkpointRoot = join(f.root, "unrelated-checkpoint");
      writeFileSync(join(f.root, "restart-authority.json"), JSON.stringify(before));
      const restarted = restartWorker(f, corruption === "unreadable" ? "unreadable" : "resume");
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(restarted.report.kind).toBe("refused");
      expect(restarted.report.error).toMatch(/authority|generation|token|identity|invalid|mismatch|unreadable/i);
      const after = durableRestartState(f);
      expect(after).toMatchObject({ pending: null, consumeCount: 1, commits: 1, materialized: 0, suites: 0 });
      expect(after.selections).toBe(before.selections);
      expect(existsSync(f.lockDir)).toBe(false);
    }, 360_000,
  );
});

function liveQueue(f: Lineage): FrozenCandidateRepairQueue {
  return {
    schemaVersion: 4,
    phase: "awaiting-fixer",
    candidate: f.knownGood,
    repairHead: f.knownGood,
    base: f.ready,
    attempts: 1000,
    openedAtMs: 1,
    updatedAtMs: 1,
    fixerSpawnId: null,
    failingTests: ["fixture.test.ts"],
    signature: [],
  };
}

async function consumePrepared(f: Lineage, prepared: Awaited<ReturnType<Lineage["prepare"]>>) {
  const real = realCheckpointDeps(f.cfg, f.exec, "independent-prepared-identity", undefined,
    undefined, undefined, prepared.prewarmedDependencyGeneration);
  let materialized = 0;
  let executed = 0;
  const outcome = await runGreenCheckpoint(f.cfg, {
    ...f.deps,
    prepareSource: real.prepareSource,
    setupTree: async (...args) => { materialized += 1; return real.setupTree(...args); },
    runGreen: async () => { executed += 1; return { green: true, failingTests: [], summary: "fixture" }; },
  }, { noPush: true, candidate: f.tip, candidateSource: "pinned",
    preparedSelection: Reflect.get(prepared, "preparedSelection") } as PreparedOpts).then(
    result => ({ result, error: "" }), error => ({ result: null, error: String(error) }));
  return { ...outcome, materialized, executed };
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

  it("re-cuts a tip-sourced candidate hint before preparing its exact dependency inputs", async () => {
    const f = await lineage();
    const prepared = await f.prepare({
      candidate: f.tip,
      candidateSource: "tip",
      noPush: true,
    });
    const selection = Reflect.get(prepared, "preparedSelection");

    expect(prepared.candidate).toBe(f.knownGood);
    expect(prepared.prewarmedDependencyGeneration).toMatchObject({
      candidate: f.knownGood,
      identity: f.knownGoodGeneration.identity,
      inputFingerprint: f.knownGoodGeneration.inputFingerprint,
    });
    expect(selection).toMatchObject({
      candidate: f.knownGood,
      tip: f.tip,
      freezeCut: {
        source: "known-good",
        candidate: f.knownGood,
        tip: f.tip,
      },
    });
    expect(f.events).toContain("select-known-good");
    expect(prepared.lock.acquired).toBe(true);
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
      f.exec,
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

  it("publishes private fixture dependencies while an unrelated inherited copy lock stays held", async () => {
    const unrelated = mkdtempSync(join(tmpdir(), "p023-unrelated-copy-"));
    const lock = join(unrelated, "copy.lock");
    const holder = spawn("flock", ["--no-fork", "--exclusive", lock, process.execPath, "-e",
      "process.stdout.write('COPY_LOCK_HELD\\n'); process.stdin.resume();"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    onTestFinished(async () => {
      const closed = new Promise<void>(resolve => holder.once("close", () => resolve()));
      holder.stdin.end();
      if (holder.exitCode === null && holder.signalCode === null) await closed;
      rmSync(unrelated, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("unrelated copy-lock holder did not become ready")), 5_000);
      holder.once("error", error => { clearTimeout(timer); reject(error); });
      holder.once("exit", code => { clearTimeout(timer); reject(new Error(`copy-lock holder exited early: ${code}`)); });
      holder.stdout.once("data", chunk => {
        clearTimeout(timer);
        if (String(chunk).trim() === "COPY_LOCK_HELD") resolve();
        else reject(new Error("copy-lock holder returned an unexpected readiness signal"));
      });
    });
    const stillHeld = () => spawnSync("flock", ["--nonblock", lock, "true"], {
      encoding: "utf8", timeout: 2_000,
    }).status;
    expect(stillHeld()).toBe(1);
    vi.stubEnv("DEPENDENCY_GENERATION_COPY_LOCK_FILE", lock);
    const f = await lineage();
    expect(existsSync(join(f.root, "generations", f.knownGoodGeneration.identity))).toBe(true);
    expect(existsSync(join(f.root, "generations", f.tipGeneration.identity))).toBe(true);
    expect(stillHeld()).toBe(1);
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
      return f.exec(cmd, args, options);
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
      return f.exec(cmd, args, options);
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
        return f.exec(cmd, args, options);
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

  it.each(["token", "root", "input fingerprint"] as const)(
    "refuses same-SHA %s replacement before materialization",
    async (replacement) => {
      const f = await lineage();
      const prepared = await f.prepare({ candidate: f.tip, candidateSource: "pinned", noPush: true });
      const generation = prepared.prewarmedDependencyGeneration;
      expect(generation.candidate).toBe(f.tip);
      if (replacement === "token") {
        const marker = join(f.root, "generations", generation.identity, ".papercusp-dependency-generation");
        const before = readFileSync(marker, "utf8");
        expect(before).toContain(`publication_token=${generation.token}`);
        chmodSync(marker, 0o600);
        writeFileSync(marker, before.replace(/^publication_token=.*$/m,
          `publication_token=v3:${"0".repeat(64)}`));
      } else if (replacement === "root") {
        const other = join(f.root, "replacement-store");
        mkdirSync(other);
        vi.stubEnv("PAPERCUSP_DEPENDENCY_GENERATION_ROOT", other);
      } else {
        // The public dependency handoff is untrusted at the consumer boundary.
        // Its SHA alone must not authorize a different input fingerprint.
        generation.inputFingerprint = "0".repeat(64);
      }
      const observed = await consumePrepared(f, prepared);
      expect(observed.materialized).toBe(0);
      expect(observed.executed).toBe(0);
      expect(observed.result?.green).not.toBe(true);
      expect(observed.error || observed.result?.summary || "").toMatch(/generation|token|root|input|identity|prepar|invalid/i);
    }, 180_000,
  );

  it("preserves an aged exhausted live repair queue without automatic retirement or a fresh cut", async () => {
    const f = await lineage();
    const queue = liveQueue(f);
    const before = structuredClone(queue);
    let retirements = 0;
    let writes = 0;
    f.deps.readFrozenRepairQueue = async () => queue;
    f.deps.readFrozenRepairBoundedLifeState = async () => ({ schemaVersion: 1,
      lastRetire: null, lastRateLimitedEscalation: null, history: [] });
    f.deps.retireFrozenRepairQueueForBoundedLife = async () => { retirements += 1; return { retired: true }; };
    f.deps.writeFrozenRepairQueue = async () => { writes += 1; };
    const prepared = await f.prepare({ noPush: true });
    expect(prepared.candidate).toBe(queue.repairHead);
    expect(prepared.prewarmedDependencyGeneration.inputFingerprint).toBe(f.knownGoodGeneration.inputFingerprint);
    expect(retirements).toBe(0);
    expect(writes).toBe(0);
    expect(queue).toEqual(before);
    expect(f.events).not.toContain("select-known-good");
  }, 180_000);

  it.each(["queue", "carry"] as const)(
    "revalidates same-SHA %s ABA after unlocked publication before consuming authority",
    async (authority) => {
      const f = await lineage();
      let queue = liveQueue(f);
      let pending = f.carry();
      let version = 1;
      const observed: number[] = [];
      f.deps.readFrozenRepairQueue = async () => { observed.push(version); return authority === "queue" ? queue : null; };
      f.deps.readFrozenRepairPendingCarry = async () => { observed.push(version); return authority === "carry" ? pending : null; };
      let consumed = 0;
      f.deps.consumeFrozenRepairCarry = async (expected) => {
        expect(existsSync(f.lockDir)).toBe(true);
        expect(expected).toEqual(pending);
        consumed += 1;
        return true;
      };
      let changed = false;
      const exec: typeof runCmd = async (cmd, args, opts) => {
        const result = await f.exec(cmd, args, opts);
        if (!changed && args.includes("--ensure-ref")) {
          expect(existsSync(f.lockDir)).toBe(false);
          changed = true;
          // The value returns to the same candidate/head; the durable version does not.
          queue = { ...queue, updatedAtMs: 3 };
          pending = { ...pending, retiredAtMs: 3 };
          version = 3;
        }
        return result;
      };
      const prepared = await f.prepare({ noPush: true }, exec);
      expect(changed).toBe(true);
      expect(observed).toContain(1);
      expect(observed).toContain(3);
      expect(prepared.candidate).toBe(authority === "queue" ? queue.repairHead : f.tip);
      expect(consumed).toBe(authority === "carry" ? 1 : 0);
    }, 180_000,
  );

  it("two concurrent proposals permit only the serialized winner to consume the carry", async () => {
    const f = await lineage();
    let pending: FrozenRepairPendingCarry | null = f.carry();
    let consumed = 0;
    f.deps.readFrozenRepairPendingCarry = async () => pending;
    f.deps.consumeFrozenRepairCarry = async (expected) => {
      expect(existsSync(f.lockDir)).toBe(true);
      if (!pending || JSON.stringify(expected) !== JSON.stringify(pending)) return false;
      pending = null;
      consumed += 1;
      return true;
    };
    let arrivals = 0;
    let open!: () => void;
    const barrier = new Promise<void>(resolve => { open = resolve; });
    const exec: typeof runCmd = async (cmd, args, opts) => {
      const result = await f.exec(cmd, args, opts);
      if (args.includes("--ensure-ref")) {
        if (++arrivals === 2) open();
        await barrier;
      }
      return result;
    };
    const results = await Promise.allSettled([f.prepare({ noPush: true }, exec), f.prepare({ noPush: true }, exec)]);
    const winners = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<Lineage["prepare"]>>> =>
      r.status === "fulfilled" && r.value.lock.acquired);
    expect(arrivals).toBe(2);
    expect(winners).toHaveLength(1);
    expect(consumed).toBe(1);
    expect(pending).toBeNull();
    expect(winners[0].value.candidate).toBe(f.tip);
  }, 180_000);

  it("rejoins after a crash immediately after carry consumption without losing or consuming the carry twice", async () => {
    const f = await lineage();
    const durable = join(f.root, "carry-authority.json");
    writeFileSync(durable, JSON.stringify({ pending: f.carry(), committed: null, selection: null, consumed: 0 }));
    f.deps.runId = "independent-crash-rejoin";
    f.deps.qualificationAttemptId = "independent-crash-rejoin";
    f.deps.readFrozenRepairPendingCarry = async () => JSON.parse(readFileSync(durable, "utf8")).pending;
    let consumed = 0;
    f.deps.consumeFrozenRepairCarry = async () => {
      throw new Error("durable selection and carry must commit atomically");
    };
    Object.assign(f.deps, durablePreparedSelectionHooks(f, durable, () => {
      consumed += 1;
      throw new Error("injected crash after durable carry consumption");
    }));
    const first = await f.prepare({ noPush: true }).then(result => {
      if (result.lock.acquired) result.lock.release();
      return "ready";
    }, () => "crashed");
    expect(consumed).toBe(1);
    expect(first).toBe("crashed");
    expect(existsSync(f.lockDir)).toBe(false);
    const restartedDeps = { ...f.deps, ...durablePreparedSelectionHooks(f, durable) };
    const rejoined = await f.prepare({ noPush: true }, f.exec, restartedDeps);
    expect(rejoined.lock.acquired).toBe(true);
    expect(rejoined.candidate).toBe(f.tip);
    expect(rejoined.prewarmedDependencyGeneration.inputFingerprint).toBe(f.tipGeneration.inputFingerprint);
    expect(consumed).toBe(1);
    const state = JSON.parse(readFileSync(durable, "utf8"));
    expect(state.pending).toBeNull();
    expect(state.consumed).toBe(1);
    expect(state.committed.judgedCandidate).toBe(rejoined.candidate);
    expect(state.selection.candidate).toBe(rejoined.candidate);
  }, 180_000);

  it("a joined qualification retains its selected candidate and attempt identity", async () => {
    const f = await lineage();
    f.deps.qualificationAttemptId = "independent-joined-attempt";
    f.deps.runId = "independent-joined-run";
    const options: CheckpointOpts = { candidate: f.knownGood, candidateSource: "tip", noPush: true };
    const prepared = await f.prepare(options);
    expect(prepared.candidate).toBe(f.knownGood);
    expect(prepared.prewarmedDependencyGeneration).toMatchObject({ candidate: f.knownGood,
      identity: f.knownGoodGeneration.identity, inputFingerprint: f.knownGoodGeneration.inputFingerprint });
    expect(f.deps.qualificationAttemptId).toBe("independent-joined-attempt");
    expect(options).toEqual({ candidate: f.knownGood, candidateSource: "tip", noPush: true });
    expect(f.events).not.toContain("select-known-good");
  }, 180_000);

  it("a known-good point already at the green pin cannot replace the unjudged tip", async () => {
    const f = await lineage();
    f.deps.resolveKnownGoodRecutTarget = async () => f.ready;
    const prepared = await f.prepare({ noPush: true });
    expect(prepared.candidate).toBe(f.tip);
    expect(prepared.prewarmedDependencyGeneration.inputFingerprint).toBe(f.tipGeneration.inputFingerprint);
  }, 180_000);

  it.each(["queue", "carry"] as const)("unreadable %s authority refuses before acquiring or consuming", async (authority) => {
    const f = await lineage();
    let consumed = 0;
    f.deps.consumeFrozenRepairCarry = async () => { consumed += 1; return true; };
    if (authority === "queue") f.deps.readFrozenRepairQueue = async () => { throw new Error("fixture queue unavailable"); };
    else f.deps.readFrozenRepairPendingCarry = async () => { throw new Error("fixture carry unavailable"); };
    const observed = await f.prepare({ noPush: true }).then(result => {
      if (result.lock.acquired) result.lock.release();
      return { kind: "ready", error: "" };
    }, error => ({ kind: "refused", error: String(error) }));
    expect(observed.kind).toBe("refused");
    expect(observed.error).toMatch(/authority|queue|carry|unavailable/i);
    expect(consumed).toBe(0);
    expect(existsSync(f.lockDir)).toBe(false);
  }, 180_000);

  it("a refused carry CAS cannot publish a runnable proposal or leak the serializer", async () => {
    const f = await lineage();
    const pending = f.carry();
    let consumed = 0;
    f.deps.readFrozenRepairPendingCarry = async () => {
      if (consumed > 0) throw new Error("fixture authority unavailable after rejected CAS");
      return pending;
    };
    f.deps.consumeFrozenRepairCarry = async () => {
      expect(existsSync(f.lockDir)).toBe(true);
      consumed += 1;
      return false;
    };
    const observed = await f.prepare({ noPush: true }).then(result => {
      if (result.lock.acquired) result.lock.release();
      return "ready";
    }, () => "refused");
    expect(observed).toBe("refused");
    expect(consumed).toBe(1);
    expect(existsSync(f.lockDir)).toBe(false);
    expect(pending).toEqual(f.carry());
  }, 180_000);

  it("a crash after selection publication rejoins the committed proposal before any suite effect", async () => {
    const f = await lineage();
    const durable = join(f.root, "publication-authority.json");
    writeFileSync(durable, JSON.stringify({ pending: f.carry(), committed: null, selection: null, consumed: 0 }));
    let consumed = 0;
    let suites = 0;
    let published: string | null = null;
    f.deps.runId = "independent-publication-rejoin";
    f.deps.qualificationAttemptId = "independent-publication-rejoin";
    f.deps.readFrozenRepairPendingCarry = async () => JSON.parse(readFileSync(durable, "utf8")).pending;
    f.deps.consumeFrozenRepairCarry = async () => {
      throw new Error("durable selection and carry must commit atomically");
    };
    Object.assign(f.deps, durablePreparedSelectionHooks(f, durable, () => { consumed += 1; }));
    const prepared = await f.prepare({ noPush: true });
    expect(consumed).toBe(1);
    const real = realCheckpointDeps(f.cfg, f.exec, f.deps.runId, undefined, undefined, undefined,
      prepared.prewarmedDependencyGeneration);
    let crashed = false;
    try {
      await runGreenCheckpoint(f.cfg, { ...f.deps, prepareSource: real.prepareSource,
        setupTree: real.setupTree, runGreen: async () => { suites += 1; throw new Error("suite must not start"); },
        recordInFlightCandidate: async info => { published = info.candidate; throw new Error("crash after selection publication"); },
      }, { noPush: true, preparedSelection: Reflect.get(prepared, "preparedSelection") } as PreparedOpts);
    } catch (error) {
      expect(String(error)).toContain("crash after selection publication");
      crashed = true;
    } finally {
      if (prepared.lock.acquired) prepared.lock.release();
    }
    expect(crashed).toBe(true);
    expect(suites).toBe(0);
    expect(published).toBe(f.tip);
    expect(existsSync(f.lockDir)).toBe(false);
    const restartedDeps = { ...f.deps, ...durablePreparedSelectionHooks(f, durable) };
    const rejoined = await f.prepare({ noPush: true }, f.exec, restartedDeps);
    expect(rejoined.candidate).toBe(published);
    expect(rejoined.prewarmedDependencyGeneration.inputFingerprint).toBe(f.tipGeneration.inputFingerprint);
    expect(consumed).toBe(1);
    const state: FixtureSelectionAuthority = JSON.parse(readFileSync(durable, "utf8"));
    expect(state.pending).toBeNull();
    expect(state.consumed).toBe(1);
    expect(state.selection?.candidate).toBe(published);
  }, 180_000);
});
