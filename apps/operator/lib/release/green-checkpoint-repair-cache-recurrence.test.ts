import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFrozenCandidateRepairQueue,
  markFrozenRepairFixerDispatched,
  markFrozenRepairFixerFinished,
  parseFrozenCandidateRepairQueue,
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
import {
  buildGreenCheckpointEnv,
  runPostSuiteLegs,
  type CheckpointExec,
} from "./green-checkpoint";

type FixtureTask = {
  key: string;
  script: string;
  workspace: string;
  initialStatus: number;
  finalStatus: number;
  absorptionRan: boolean;
};

const CANDIDATE = "1".repeat(40);
const REPAIRED = "2".repeat(40);
const BASE = "0".repeat(40);
const INITIAL_RUN = "initial-proof-run";
const VERIFIER_RUN = "repair-verifier-run";
const RUNTIME_IDENTITY = {
  name: "node", version: "25.9.0", executable: "/fixture/node",
  binarySha256: "a".repeat(64), platform: "linux", arch: "x64",
  nativeDependencyGeneration: "b".repeat(64), lockfileSha256: "c".repeat(64),
  configurationSha256: "d".repeat(64),
};
const fixtureIdentity = (input: Parameters<typeof buildPassingTaskVerdictIdentity>[0]): PassingTaskVerdictIdentity => {
  const identity = buildPassingTaskVerdictIdentity(input);
  if (!identity) throw new Error("positive cache fixture requires a complete runtime and task identity");
  return identity;
};

// Real launch surfaces share only this execution substrate. A manual checkpoint receives the
// user-manager environment plus fresh systemd metadata; a scheduled/repair checkpoint inherits
// the bg-host's service environment. The latter includes service identity, credentials, and
// operator config that must not enter the green suite or its complete child-environment cache
// identity. Values are deliberately synthetic — only the key/value shape is under test.
const CANONICAL_LAUNCH_ENV = {
  PATH: "/usr/local/bin:/usr/bin",
  HOME: join(tmpdir(), "gate-home"),
  USER: "gate",
  LOGNAME: "gate",
  SHELL: "/bin/bash",
  LANG: "C.UTF-8",
  XDG_RUNTIME_DIR: "/run/user/1000",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  PAPERCUSP_TEST_RUNS_DB_URL: "postgres://fixture-test-ledger",
};

const INITIAL_LAUNCH_ENV = {
  ...CANONICAL_LAUNCH_ENV,
  INVOCATION_ID: "manual-checkpoint-a",
  JOURNAL_STREAM: "8:100",
  SYSTEMD_EXEC_PID: "100",
  MANAGERPID: "1000",
  MEMORY_PRESSURE_WATCH: "/sys/fs/cgroup/manual/memory.pressure",
};

const VERIFIER_LAUNCH_ENV = {
  ...CANONICAL_LAUNCH_ENV,
  INVOCATION_ID: "repair-checkpoint-b",
  JOURNAL_STREAM: "8:200",
  SYSTEMD_EXEC_PID: "200",
  MANAGERPID: "1000",
  MEMORY_PRESSURE_WATCH: "/sys/fs/cgroup/bg-host/memory.pressure",
  AGENT_CMD: "psu",
  DATABASE_URL: "postgres://operator-service-only",
  DBOS__APPVERSION: "repair-launch",
  DBOS__VMID: "bg-host-b",
  LATITUDE_API_KEY: "service-secret",
  PAPERCUSP_AGENT_DEBUG: "1",
};

const commandFor = (task: FixtureTask, root: string) => ({
  cmd: "npm",
  argv: ["run", task.script, "--workspace", task.workspace],
  cwd: root,
  scriptText: `vitest run ${task.workspace}`,
});

const gateConfig = {
  retryFailed: true,
  scheduler: { workers: 2, memoryMb: 4096 },
};

describe("P-009: frozen-repair passing-task reuse recurs end to end", () => {
  it("skips only unchanged clean first-pass tasks and reruns every unsafe class", () => {
    const root = mkdtempSync(join(tmpdir(), "repair-cache-chain-"));
    const cachePath = join(root, ".cache", "passing.json");
    const files = [
      "package-lock.json",
      "scripts/affected-tests.mjs",
      "packages/clean/src/index.ts",
      "packages/failing/src/index.ts",
      "packages/retried/src/index.ts",
      "packages/core/src/index.ts",
      "packages/dependent/src/index.ts",
      "packages/external/src/index.ts",
      "packages/other/src/index.ts",
    ];
    try {
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), `${file}:initial\n`);
      }
      const workspaces = new Map([
        ["@fixture/clean", { dir: "packages/clean", deps: [] }],
        ["@fixture/failing", { dir: "packages/failing", deps: [] }],
        ["@fixture/retried", { dir: "packages/retried", deps: [] }],
        ["@fixture/core", { dir: "packages/core", deps: [] }],
        [
          "@fixture/dependent",
          { dir: "packages/dependent", deps: ["@fixture/core"] },
        ],
        ["@fixture/external", { dir: "packages/external", deps: [] }],
        ["@fixture/other", { dir: "packages/other", deps: [] }],
      ]);
      const tasks: FixtureTask[] = [
        {
          key: "@fixture/clean :: test",
          script: "test",
          workspace: "@fixture/clean",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/failing :: test",
          script: "test",
          workspace: "@fixture/failing",
          initialStatus: 1,
          finalStatus: 1,
          absorptionRan: false,
        },
        {
          key: "@fixture/retried :: test",
          script: "test",
          workspace: "@fixture/retried",
          initialStatus: 1,
          finalStatus: 0,
          absorptionRan: true,
        },
        {
          key: "@fixture/dependent :: test",
          script: "test",
          workspace: "@fixture/dependent",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/external :: test:integration",
          script: "test:integration",
          workspace: "@fixture/external",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
        {
          key: "@fixture/clean :: lint:repo-wide",
          script: "lint:repo-wide",
          workspace: "@fixture/clean",
          initialStatus: 0,
          finalStatus: 0,
          absorptionRan: false,
        },
      ];
      const repoWideTaskKeys = new Set([tasks[5]!.key]);
      const trackedScan = { files, unscannedPresent: [] as string[] };
      const initialEnv = buildGreenCheckpointEnv(
        BASE,
        INITIAL_LAUNCH_ENV,
        INITIAL_RUN,
      );
      const initialIdentityEnv =
        passingTaskVerdictIdentityEnvironment(initialEnv).environment;
      const identityFor = (
        task: FixtureTask,
        environment: Record<string, unknown>,
      ): PassingTaskVerdictIdentity | null => {
        const provenance = passingTaskVerdictDependencyProvenance({
          root,
          taskKey: task.key,
          script: task.script,
          workspaceName: task.workspace,
          workspaces,
          trackedScan,
          repoWideTaskKeys,
        });
        if (!provenance.ok) return null;
        return fixtureIdentity({
          taskKey: task.key,
          command: commandFor(task, root),
          environment,
          gateConfig,
          dependencyHash: provenance.hash,
          runtimeIdentity: RUNTIME_IDENTITY,
        });
      };

      const initialEntries: Record<
        string,
        ReturnType<typeof passingTaskVerdictEntry>
      > = {};
      for (const task of tasks) {
        const identity = identityFor(task, initialIdentityEnv);
        if (
          shouldStorePassingTaskVerdict({
            enabled: true,
            cacheStatus: "miss",
            initialStatus: task.initialStatus,
            finalStatus: task.finalStatus,
            absorptionRan: task.absorptionRan,
            identity,
          })
        ) {
          initialEntries[task.key] = passingTaskVerdictEntry(
            identity!,
            "initial-pass",
          );
        }
      }
      const initialCache = mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        INITIAL_RUN,
        initialEntries,
        "initial-pass",
      );
      writePassingTaskVerdictCacheAtomic(cachePath, initialCache, "initial");

      expect(Object.keys(initialCache.groups[INITIAL_RUN]!.entries).sort()).toEqual(
        [tasks[0]!.key, tasks[3]!.key, tasks[5]!.key].sort(),
      );

      // The repair touches a transitive dependency and an otherwise unrelated path.
      // The clean workspace remains byte-identical; the whole-tree guard does not.
      writeFileSync(
        join(root, "packages/core/src/index.ts"),
        "core:repaired\n",
      );
      writeFileSync(
        join(root, "packages/other/src/index.ts"),
        "other:repaired\n",
      );

      const queue = createFrozenCandidateRepairQueue({
        candidate: CANDIDATE,
        base: BASE,
        affectedTestProofGroup: INITIAL_RUN,
        nowMs: 100,
      });
      const verifierEnv = buildGreenCheckpointEnv(
        BASE,
        VERIFIER_LAUNCH_ENV,
        VERIFIER_RUN,
        "shared",
        queue.affectedTestProofGroup,
      );
      const verifierIdentityEnv =
        passingTaskVerdictIdentityEnvironment(verifierEnv).environment;
      const persisted = readPassingTaskVerdictCache(cachePath);
      const decisions = new Map(
        tasks.map((task) => {
          const identity = identityFor(task, verifierIdentityEnv);
          return [
            task.key,
            decidePassingTaskVerdict({
              enabled: true,
              cacheRead: persisted,
              entry: passingTaskVerdictCacheEntry(
                persisted.cache,
                INITIAL_RUN,
                task.key,
              ),
              identity,
            }),
          ];
        }),
      );

      expect(decisions.get(tasks[0]!.key)).toEqual({
        hit: true,
        reason: "identity-match",
      });
      expect(decisions.get(tasks[1]!.key)).toEqual({
        hit: false,
        reason: "no-prior-verdict",
      });
      expect(decisions.get(tasks[2]!.key)).toEqual({
        hit: false,
        reason: "no-prior-verdict",
      });
      expect(decisions.get(tasks[3]!.key)).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });
      expect(decisions.get(tasks[4]!.key)).toEqual({
        hit: false,
        reason: "provenance-incomplete",
      });
      expect(decisions.get(tasks[5]!.key)).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });
      expect(
        [...decisions.values()]
          .filter((decision) => !decision.hit)
          .map((_decision, index) => index),
      ).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // P-010: a SHARED GATE INPUT (scripts/, libs/test-config/) is part of every ordinary task's
  // dependency closure, not just of the repo-wide guards. So changing the test RUNNER itself
  // must invalidate reuse for a workspace that is byte-identical.
  //
  // Measured live during the P-010 controlled repair (2026-08-24): git-sync committed
  // scripts/affected-tests.mjs between an initial run and its repair verification, and all 20
  // tasks correctly missed with dependency-closure-changed. Nothing guarded that: the sibling
  // P-009 case above keeps scripts/affected-tests.mjs in its fixture file set but only ever
  // mutates a transitive workspace dep and an unrelated workspace, so a narrowing of the
  // closure filter in passingTaskVerdictDependencyProvenance would let a CHANGED RUNNER replay
  // stale passing verdicts — silently, because reuse is fail-closed and logs no error.
  //
  // The two controls are load-bearing and must not be deleted: the calibration case proves the
  // identity can still HIT (otherwise every miss assertion below passes for the wrong reason),
  // and the out-of-closure case proves a miss means "this file is in the closure" rather than
  // "any mutation anywhere invalidates".
  it("invalidates an unchanged workspace's reuse when a shared gate input changes", () => {
    const root = mkdtempSync(join(tmpdir(), "repair-cache-shared-input-"));
    try {
      const files = [
        "package-lock.json",
        "scripts/affected-tests.mjs",
        "libs/test-config/src/vitest-config.ts",
        "packages/clean/src/index.ts",
        "packages/other/src/index.ts",
      ];
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), `${file}:initial\n`);
      }
      const workspaces = new Map([
        ["@fixture/clean", { dir: "packages/clean", deps: [] }],
        ["@fixture/other", { dir: "packages/other", deps: [] }],
      ]);
      const task: FixtureTask = {
        key: "@fixture/clean :: test",
        script: "test",
        workspace: "@fixture/clean",
        initialStatus: 0,
        finalStatus: 0,
        absorptionRan: false,
      };
      const trackedScan = { files, unscannedPresent: [] as string[] };
      // Deliberately EMPTY: this is an ordinary task, so any invalidation below comes from the
      // shared-gate-input rule and never from the whole-tree repo-wide binding.
      const repoWideTaskKeys = new Set<string>();

      const identityNow = (): PassingTaskVerdictIdentity | null => {
        const provenance = passingTaskVerdictDependencyProvenance({
          root,
          taskKey: task.key,
          script: task.script,
          workspaceName: task.workspace,
          workspaces,
          trackedScan,
          repoWideTaskKeys,
        });
        if (!provenance.ok) return null;
        return fixtureIdentity({
          taskKey: task.key,
          command: commandFor(task, root),
          environment: passingTaskVerdictIdentityEnvironment(
            buildGreenCheckpointEnv(BASE, INITIAL_LAUNCH_ENV, INITIAL_RUN),
          ).environment,
          gateConfig,
          dependencyHash: provenance.hash,
          runtimeIdentity: RUNTIME_IDENTITY,
        });
      };

      const initialIdentity = identityNow();
      expect(initialIdentity).not.toBeNull();
      const cache = mergePassingTaskVerdictUpdates(
        emptyPassingTaskVerdictCache(),
        INITIAL_RUN,
        { [task.key]: passingTaskVerdictEntry(initialIdentity!, "initial-pass") },
        "initial-pass",
      );
      const decideNow = () =>
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: { reason: "cache-ready" },
          entry: passingTaskVerdictCacheEntry(cache, INITIAL_RUN, task.key),
          identity: identityNow(),
        });

      // CONTROL (calibration): nothing changed, so reuse MUST hit. Without this, the two
      // miss assertions below would also pass if the identity were simply always-different.
      expect(decideNow()).toEqual({ hit: true, reason: "identity-match" });

      // NEGATIVE CONTROL: a workspace OUTSIDE this task's closure changes. The closure is
      // scoped, so this must still hit — proving the misses below are caused by the specific
      // file, not by mutation-in-general.
      writeFileSync(join(root, "packages/other/src/index.ts"), "other:changed\n");
      expect(decideNow()).toEqual({ hit: true, reason: "identity-match" });

      // The runner itself changes: an ordinary task with a byte-identical workspace must miss.
      writeFileSync(join(root, "scripts/affected-tests.mjs"), "runner:changed\n");
      expect(decideNow()).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });

      // The other documented shared gate input must bind the same way. Restore the runner
      // first so this asserts libs/test-config on its own rather than riding the prior miss.
      writeFileSync(
        join(root, "scripts/affected-tests.mjs"),
        "scripts/affected-tests.mjs:initial\n",
      );
      expect(decideNow()).toEqual({ hit: true, reason: "identity-match" });
      writeFileSync(
        join(root, "libs/test-config/src/vitest-config.ts"),
        "test-config:changed\n",
      );
      expect(decideNow()).toEqual({
        hit: false,
        reason: "dependency-closure-changed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps complete child-environment identity fail-closed for admitted test inputs", () => {
    const initialEnvironment = passingTaskVerdictIdentityEnvironment(
      buildGreenCheckpointEnv(BASE, INITIAL_LAUNCH_ENV, INITIAL_RUN),
    ).environment;
    const verifierEnvironment = passingTaskVerdictIdentityEnvironment(
      buildGreenCheckpointEnv(
        BASE,
        VERIFIER_LAUNCH_ENV,
        VERIFIER_RUN,
        "shared",
        INITIAL_RUN,
      ),
    ).environment;
    expect(verifierEnvironment).toEqual(initialEnvironment);

    const initialIdentity = fixtureIdentity({
      taskKey: "@fixture/app :: test",
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: initialEnvironment,
      gateConfig,
      dependencyHash: "closure",
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    const changedPathIdentity = fixtureIdentity({
      taskKey: initialIdentity.taskKey,
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: passingTaskVerdictIdentityEnvironment(
        buildGreenCheckpointEnv(
          BASE,
          { ...VERIFIER_LAUNCH_ENV, PATH: "/different/bin" },
          VERIFIER_RUN,
          "shared",
          INITIAL_RUN,
        ),
      ).environment,
      gateConfig,
      dependencyHash: "closure",
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: "cache-ready" },
        entry: passingTaskVerdictEntry(initialIdentity),
        identity: changedPathIdentity,
      }),
    ).toEqual({ hit: false, reason: "environment-changed" });
  });

  it("misses on every identity component and on corrupt or legacy cache state", () => {
    const dir = mkdtempSync(join(tmpdir(), "repair-cache-identity-"));
    const path = join(dir, "cache.json");
    try {
      const baseline = fixtureIdentity({
        taskKey: "@fixture/app :: test",
        command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
        environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
        gateConfig,
        dependencyHash: "closure-a",
        runtimeIdentity: RUNTIME_IDENTITY,
      });
      const entry = passingTaskVerdictEntry(baseline);
      const variants: Array<[string, PassingTaskVerdictIdentity]> = [
        [
          "command-changed",
          fixtureIdentity({
            ...baseline,
            command: {
              cmd: "npm",
              argv: ["run", "test:changed"],
              cwd: "/checkpoint",
            },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-a",
            runtimeIdentity: RUNTIME_IDENTITY,
          }),
        ],
        [
          "environment-changed",
          fixtureIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: {
              CI: "1",
              FEATURE: "changed",
              PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN,
            },
            gateConfig,
            dependencyHash: "closure-a",
            runtimeIdentity: RUNTIME_IDENTITY,
          }),
        ],
        [
          "gate-config-changed",
          fixtureIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig: { ...gateConfig, retryFailed: false },
            dependencyHash: "closure-a",
            runtimeIdentity: RUNTIME_IDENTITY,
          }),
        ],
        [
          "implementation-version-changed",
          fixtureIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-a",
            runtimeIdentity: RUNTIME_IDENTITY,
            implementationVersion: "tooling-v-next",
          }),
        ],
        [
          "dependency-closure-changed",
          fixtureIdentity({
            taskKey: baseline.taskKey,
            command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
            environment: { CI: "1", PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
            gateConfig,
            dependencyHash: "closure-b",
            runtimeIdentity: RUNTIME_IDENTITY,
          }),
        ],
      ];
      for (const [reason, identity] of variants) {
        expect(
          decidePassingTaskVerdict({
            enabled: true,
            cacheRead: { reason: "cache-ready" },
            entry,
            identity,
          }),
        ).toEqual({ hit: false, reason });
      }

      writeFileSync(path, "{corrupt");
      const corrupt = readPassingTaskVerdictCache(path);
      expect(
        decidePassingTaskVerdict({
          enabled: true,
          cacheRead: corrupt,
          entry: passingTaskVerdictCacheEntry(
            corrupt.cache,
            INITIAL_RUN,
            baseline.taskKey,
          ),
          identity: baseline,
        }),
      ).toEqual({ hit: false, reason: "cache-corrupt" });
      writeFileSync(path, JSON.stringify({ version: 0, entries: {} }));
      expect(readPassingTaskVerdictCache(path).reason).toBe(
        "cache-version-mismatch",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps candidate and verifier identity exact while foreign or legacy runs miss", () => {
    let queue = createFrozenCandidateRepairQueue({
      candidate: CANDIDATE,
      base: BASE,
      affectedTestProofGroup: INITIAL_RUN,
      nowMs: 100,
    });
    queue = markFrozenRepairFixerDispatched(queue, {
      spawnId: "fixer-1",
      nowMs: 101,
    });
    queue = markFrozenRepairFixerFinished(queue, {
      spawnId: "fixer-1",
      repairHead: REPAIRED,
      nowMs: 102,
    });
    expect(queue).toMatchObject({
      candidate: CANDIDATE,
      repairHead: REPAIRED,
      affectedTestProofGroup: INITIAL_RUN,
    });

    const verifierEnv = buildGreenCheckpointEnv(
      BASE,
      {},
      VERIFIER_RUN,
      "shared",
      queue.affectedTestProofGroup,
    );
    expect(verifierEnv.PAPERCUSP_TEST_RUN_GROUP).toBe(VERIFIER_RUN);
    expect(verifierEnv.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBe(INITIAL_RUN);

    const initialIdentity = fixtureIdentity({
      taskKey: "@fixture/app :: test",
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: { PAPERCUSP_TEST_RUN_GROUP: INITIAL_RUN },
      gateConfig,
      dependencyHash: "closure",
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    const foreignIdentity = fixtureIdentity({
      taskKey: initialIdentity.taskKey,
      command: { cmd: "npm", argv: ["run", "test"], cwd: "/checkpoint" },
      environment: { PAPERCUSP_TEST_RUN_GROUP: "foreign-pipeline-run" },
      gateConfig,
      dependencyHash: "closure",
      runtimeIdentity: RUNTIME_IDENTITY,
    });
    expect(
      decidePassingTaskVerdict({
        enabled: true,
        cacheRead: { reason: "cache-ready" },
        entry: passingTaskVerdictEntry(initialIdentity),
        identity: foreignIdentity,
      }),
    ).toEqual({ hit: false, reason: "environment-changed" });

    const legacy = parseFrozenCandidateRepairQueue({
      ...queue,
      schemaVersion: 1,
      affectedTestProofGroup: undefined,
    });
    expect(legacy?.affectedTestProofGroup).toBeNull();
    const legacyVerifierEnv = buildGreenCheckpointEnv(
      BASE,
      {},
      VERIFIER_RUN,
      "shared",
      legacy?.affectedTestProofGroup,
    );
    expect(legacyVerifierEnv.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBeUndefined();
  });

  it("runs typecheck, migration, live-plane, and build assurance after suite reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "repair-post-suite-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "repair-post-suite-fixture",
          scripts: {
            "lint:tsc": "node lint-tsc.mjs",
            "lint:migrations": "node lint-migrations.mjs",
            "lint:migration-forward-compat": "node migration-forward.mjs",
            "lint:plane-producers": "node plane-producers.mjs",
          },
        }),
      );
      const calls: string[] = [];
      const exec: CheckpointExec = async (cmd, args) => {
        const runIndex = args.indexOf("run");
        calls.push(
          cmd === "npm" && runIndex >= 0
            ? args[runIndex + 1]!
            : `${cmd}:${args[0] ?? ""}`,
        );
        return {
          code: cmd === "git" ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      };
      const result = await runPostSuiteLegs(
        root,
        buildGreenCheckpointEnv(BASE, {}, VERIFIER_RUN),
        exec,
        "@papercusp/operator-vite",
        {
          identity: {
            runId: VERIFIER_RUN,
            candidate: REPAIRED,
            headAtStart: REPAIRED,
          },
        },
      );

      expect(result.ok).toBe(true);
      expect(calls).toEqual(
        expect.arrayContaining([
          "lint:tsc",
          "lint:migrations",
          "lint:migration-forward-compat",
          "lint:plane-producers",
          "build",
        ]),
      );
      expect(
        result.records.find((record) => record.id === "lint:tsc"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "lint:migrations"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "lint:plane-integrity"),
      ).toMatchObject({ status: "passed" });
      expect(
        result.records.find((record) => record.id === "spa-build"),
      ).toMatchObject({ status: "passed" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
