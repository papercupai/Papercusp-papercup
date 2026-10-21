/**
 * green-checkpoint REAL-path wiring (hive-run-evaluation gap #10).
 *
 * The sibling green-checkpoint.test.ts covers the ORCHESTRATION (advance-only-
 * when-green, FF-only) with STUB deps. This covers the REAL deps
 * (realCheckpointDeps) the stub replaces — the heavy ops are shelled through an
 * injected `exec` seam (default = the spawn-backed runCmd), so the WIRING is
 * asserted WITHOUT running the suite, the SPA build, or a git push:
 *   - runGreen passes the stripped checkpoint env (GREEN_CHECKPOINT + AFFECTED_BASE)
 *     to the green command, in the checkpoint tree;
 *   - P-005: the SPA build is PART of green — a green suite + a FAILED build is
 *     NOT green, and the build break folds into the failure signature;
 *   - a red suite short-circuits (no build attempt);
 *   - setupTree invokes setup-release-checkout.sh with the right flags;
 *   - push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past
 *     the main pre-push hook).
 * The actual FF-of-main (advance → advanceReady) is the orchestration test's
 * real-git temp-repo path; here we never touch a real branch.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  onTestFinished,
  vi,
} from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as targetedTaskReuse from "../../../../scripts/lib/targeted-task-reuse.mjs";
import * as testPassReuse from "../../../../scripts/lib/test-pass-reuse.mjs";
import {
  checkNpmScript,
  buildTerminalFailureCheckpointResult,
  createFatalCheckpointFinalizer,
  createFatalProcessHandler,
  emitTerminalCheckpointResult,
  extractFailingTests,
  GREEN_CHECKPOINT_RESULT_MARKER,
  hasNpmScript,
  acquireCheckpointRunLock,
  beginCheckpointPreflight,
  checkpointRunLockDir,
  checkpointDependencyInputFingerprint,
  CHECKPOINT_DEPENDENCY_RETAIN_LABEL,
  ensureCheckpointDependencyGeneration,
  realCheckpointDeps,
  runCmd,
  runGreenCheckpoint,
  selectPersistedCheckpointDependencyGeneration,
  liveDependencyGenerationToken,
  retireInFlightCandidateAfterResult,
  startMaterializationHeartbeat,
  writeCheckpointRunPhase,
  resolveWorkspaceFileTestInvocation,
  resolveWorkspaceTestInvocation,
  isStandaloneNodeTestFile,
  armRescueRerunCapture,
  CONCURRENT_CONFIRM_TIMEOUT_MS,
  ISOLATION_RUN_TIMEOUT_MS,
  RESCUE_TEST_TIMEOUT_MS,
  WORKSPACE_RERUN_TIMEOUT_MS,
  DEPENDENCY_GENERATION_IDLE_TIMEOUT_MS,
  DEPENDENCY_GENERATION_HARD_TIMEOUT_MS,
  GREEN_CHECKPOINT_POST_SUITE_HEAP_MB,
  GREEN_CHECKPOINT_RESERVED_MAX_FORKS,
  GATE_ESCALATION_SOURCE,
  DETECTOR_ESCALATION_SOURCE,
  ESCALATION_CLASS_META_KEY,
  RELEASE_NOT_GREEN_ESCALATION_CLASS,
  isReleaseNotGreenEscalation,
  type CheckpointExec,
  type CheckpointDeps,
} from "./green-checkpoint";
import { releaseConfig, type ReleaseConfig } from "./release-config";
import {
  EXECUTED_MAP_NO_PERSIST_ENV,
  EXECUTED_MAP_OUT_ENV,
  EXECUTED_MAP_RECORD_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
} from "../../../../scripts/lib/executed-source-map.mjs";
import { TEST_REUSE_SKIP_LIST_ENV } from "../../../../scripts/lib/test-pass-reuse.mjs";
import {
  selectStaleEscalations,
  SELF_RECONCILING_META_KEY,
  type StaleEscalationInput,
} from "@papercusp/operator-core/lib/attention/reconcile-escalations";

// EI-18661485259809120: push() also fires a workflow_dispatch of test.yml (since the
// pushed commit's `[skip ci]` message means the plain `git push` above never actually
// triggers GitHub's push-event listener). Mock the two dynamic-import seams
// dispatchCiWorkflow uses so this is asserted without a real GitHub API call.
// Declared WITH its argument: the real call site passes one (see the
// `toHaveBeenCalledWith({ ... })` assertions below), and a zero-arg `vi.fn`
// types `mock.calls` as the empty tuple `[]`, so reading `call[0]` to inspect
// the dispatched payload is a TS2493 error against a call that genuinely
// carries an argument at runtime.
const mockCreateWorkflowDispatch = vi.fn(
  async (_args?: unknown) => ({}) as unknown,
);
const mockGetOctokit = vi.fn(async () => ({
  rest: { actions: { createWorkflowDispatch: mockCreateWorkflowDispatch } },
}));
const mockGitOriginUrl = vi.fn(
  async (_dir: string) => "https://github.com/Papercusp/papercup.git",
);

vi.mock("@papercusp/operator-core/lib/cupboard/resolve-repo-coords", () => ({
  gitOriginUrl: (dir: string) => mockGitOriginUrl(dir),
  parseGithubRemote: (url: string) => {
    const m = /github\.com[:/]([^/]+)\/([^/.]+)/.exec(url);
    return m ? { owner: m[1], repo: m[2] } : null;
  },
}));
vi.mock("@papercusp/operator-core/lib/identity/octokit-client", () => ({
  getOctokit: () => mockGetOctokit(),
}));

// WI-10006393: these push fixtures use unregistered synthetic checkouts. Keep the real
// promotion routing and factory, but provide their registry input without opening live PG.
vi.mock("@papercusp/operator-core/lib/harness/git-sync/promotion-push-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@papercusp/operator-core/lib/harness/git-sync/promotion-push-target")>();
  return {
    ...actual,
    createDefaultPublishPromotionDeps: async (log: (line: string) => void) => ({
      ...await actual.createDefaultPublishPromotionDeps(log),
      loadProjects: async () => [],
    }),
  };
});

// WI-36238: `escalate` dynamic-imports these two seams. Mocking them lets the
// REAL dep run without a database, so the coupling test at the bottom of this
// file asserts against the record the gate actually emits.
const openEscalationCalls: {
  identity: Record<string, unknown>;
  input: Record<string, unknown>;
}[] = [];
// WI-39686: the open-row set the mocked `listEscalations` returns, and the
// resolve calls the sweep makes. Both DEFAULT to today's behaviour (no open
// rows, resolves unobserved) so every pre-existing test in this file is
// unaffected; the sweep-scoping tests below populate them per-case.
let openEscalationRows: Record<string, unknown>[] = [];
const resolveEscalationCalls: Record<string, unknown>[] = [];
vi.mock(
  "@papercusp/operator-core/lib/agent-tools/coordination/escalations",
  () => ({
    openEscalation: async (
      identity: Record<string, unknown>,
      input: Record<string, unknown>,
    ) => {
      openEscalationCalls.push({ identity, input });
    },
    listEscalations: async () => openEscalationRows,
    resolveEscalation: async (input: Record<string, unknown>) => {
      resolveEscalationCalls.push(input);
    },
    resolveEscalationsBatch: async () => ({ resolved: 0 }),
  }),
);
// notifyAttentionOnce too: register-system-actions → connected-apps/alert-sweep imports it
// statically, so a factory that omits it fails the whole file at collection.
vi.mock("@papercusp/operator-core/lib/attention-notify", () => ({
  notifyAttention: async () => {},
  notifyAttentionOnce: async () => {},
}));

// EI-20339710858167842: this file asserts the checkpoint's OWN concurrency profile. An outer
// affected-tests scheduler legitimately constrains this Vitest process with VITEST_MAX_FORKS=1;
// letting that ambient allocation leak into buildGreenCheckpointEnv makes the co-execution
// contract tests fail only when this file shares a scheduler lane, then pass on the serial retry.
// Clear the runner allocation for this fixture and restore it after the file so the assertions
// measure committed gate defaults regardless of how the containing test process was scheduled.
const inheritedVitestMaxForks = process.env.VITEST_MAX_FORKS;
const inheritedVitestMaxThreads = process.env.VITEST_MAX_THREADS;
beforeAll(() => {
  delete process.env.VITEST_MAX_FORKS;
  delete process.env.VITEST_MAX_THREADS;
});
afterAll(() => {
  if (inheritedVitestMaxForks === undefined)
    delete process.env.VITEST_MAX_FORKS;
  else process.env.VITEST_MAX_FORKS = inheritedVitestMaxForks;
  if (inheritedVitestMaxThreads === undefined)
    delete process.env.VITEST_MAX_THREADS;
  else process.env.VITEST_MAX_THREADS = inheritedVitestMaxThreads;
});

interface ExecResp {
  code: number;
  stdout?: string;
  stderr?: string;
}

const FIXTURE_DEPENDENCY_GENERATION_ID = `v1-${"d".repeat(64)}`;
const FIXTURE_DEPENDENCY_GENERATION_TOKEN = "fixture-generation-token";

/** A fake exec returning programmed results in call order, recording every call. */
function makeExec(responses: ExecResp[]) {
  const calls: Array<{
    cmd: string;
    args: string[];
    opts?: Parameters<CheckpointExec>[2];
  }> = [];
  let i = 0;
  const exec: CheckpointExec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const isDependencyGenerationSelector =
      args.some((arg) => arg.endsWith("dependency-generation.sh")) &&
      args.includes("--integration");
    const isSetupRelease =
      cmd === "bash" &&
      args.some((arg) => arg.endsWith("setup-release-checkout.sh"));
    const isSourceOnlySetup = isSetupRelease && args.includes("--source-only");
    // Exact-generation selection is now a setup precondition, not part of the
    // downstream command sequence each older fixture is programming. Give it a
    // stable successful identity by default so those fixtures keep describing
    // their own seam; source-only preparation gets the same treatment because
    // setupTree now establishes exact source before looking up its input key.
    const programmed =
      isDependencyGenerationSelector || isSourceOnlySetup
        ? undefined
        : responses[i++];
    const r = isDependencyGenerationSelector
      ? {
          code: 0,
          stdout: `DEPENDENCY_GENERATION_RESULT schema=1 identity=${FIXTURE_DEPENDENCY_GENERATION_ID} source=fixture input=fixture scope=full reused=true token=${FIXTURE_DEPENDENCY_GENERATION_TOKEN} path=/fixture/${FIXTURE_DEPENDENCY_GENERATION_ID}`,
        }
      : isSourceOnlySetup
        ? {
            code: 0,
            stdout:
              "[setup-release] SETUP_RELEASE_SOURCE_ONLY ref=fixture sha=fixture status=ready\n",
          }
        : (programmed ??
          (isSetupRelease
            ? {
                code: 0,
                stdout: `[setup-release] DEPENDENCY_GENERATION_PIN identity=${FIXTURE_DEPENDENCY_GENERATION_ID}`,
              }
            : { code: 0 }));
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

// Redirect the per-run checkpoint suite-log dir to a throwaway temp dir so this
// real-deps test (which exercises runGreen's writeFileSync log-persist) NEVER
// pollutes the real ~/.papercusp/checkpoint-logs/ — fixture logs landing there
// masquerade as real checkpoint failures + mislead freeze diagnosis (2026-06-20).
const tmpLogDir = mkdtempSync(join(tmpdir(), "green-cp-log-"));
afterAll(() => rmSync(tmpLogDir, { recursive: true, force: true }));

// EI-8744: runGreen probes the checkpoint tree for a root package.json (the
// nothing-to-gate short-circuit) with a REAL existsSync — a bare fake path like
// cpTree now green-short-circuits before the injected exec is ever consulted,
// which is the opposite of what these wiring tests assert. Give them a real
// tree with a package.json so the full pipeline runs.
const cpTree = mkdtempSync(join(tmpdir(), "green-cp-tree-"));
writeFileSync(
  join(cpTree, "package.json"),
  JSON.stringify({ name: "cp-fixture" }),
);

// EI-20234934941780220: the desktop package is a git submodule, not a root npm workspace. Keep
// a minimal standalone fixture here so rescue tests assert the cwd/argv contract without running
// the real desktop suite or depending on the checkout's current submodule contents.
const standaloneTree = mkdtempSync(join(tmpdir(), "green-cp-standalone-tree-"));
mkdirSync(join(standaloneTree, "papercusp-desktop"), { recursive: true });
writeFileSync(
  join(standaloneTree, "papercusp-desktop", "package.json"),
  JSON.stringify({
    name: "@papercusp/desktop",
    scripts: { test: "vitest run" },
  }),
);

// WI-7255 — DO NOT materialise the `failingTests` paths (lib/foo.test.ts,
// lib/llm-testing/__tests__/runner-aggregate.test.ts, ...) inside cpTree. Their ABSENCE is
// load-bearing, and this comment exists because it was already done once and had to be
// reverted.
//
// The two cases below asserting `failingTests` CONTAINS the failing file are the recurrence
// guard for WI-7239: `validateFailingTestPaths` once DROPPED any FILE-shaped entry that did
// not resolve under `treeDir`, which was unsound — vitest reports test files
// WORKSPACE-relative while treeDir is the repo ROOT, so the join never resolves for a genuine
// failure and every real entry was stripped (emptying the input to applyTestQuarantine, so
// `allFailuresQuarantined` could never fire). It is advisory now: report, drop nothing.
//
// A cpTree fixture at the tree-root-relative path makes exists(join(treeDir, entry)) TRUE,
// which SILENTLY DISARMS that guard — re-introduce the drop and these cases stay green,
// because the fixture satisfies the very check whose unsoundness they exist to catch. That is
// exactly what happened on 2026-08-03 (WI-7244 -> WI-7255): the assertions were failing
// because they were CORRECT, and were "fixed" by feeding the broken impl what it wanted.
//
// If these go red again, fix the resolution logic — never the fixtures.
afterAll(() => rmSync(cpTree, { recursive: true, force: true }));
afterAll(() => rmSync(standaloneTree, { recursive: true, force: true }));

const typecheckTree = mkdtempSync(join(tmpdir(), "green-cp-typecheck-tree-"));
mkdirSync(join(typecheckTree, "scripts"), { recursive: true });
writeFileSync(
  join(typecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-typecheck-fixture",
    scripts: {
      "lint:tsc": "node scripts/lint-tsc.mjs",
      "lint:tsc:operator-vite": "node scripts/lint-tsc-operator-vite.mjs",
    },
  }),
);
writeFileSync(
  join(typecheckTree, "scripts", "lint-tsc.mjs"),
  "export const TSC_COMMAND = 'npx tsc -p packages/operator-core/tsconfig.json --noEmit';\n",
);
writeFileSync(
  join(typecheckTree, "scripts", "lint-tsc-operator-vite.mjs"),
  "export const TSC_COMMAND = 'npx tsc -p apps/operator-vite/tsconfig.json --noEmit';\n",
);
afterAll(() => rmSync(typecheckTree, { recursive: true, force: true }));

// WI-6841: a candidate tree that provides `lint:tsc:papercusp-libs` but not `lint:tsc` —
// isolates the libs/papercusp typecheck leg's wiring (position in the sequence, env, failure
// signature) from the operator-core typecheck leg's, the same way typecheckTree isolates that
// one from cpTree's no-optional-legs baseline. The eight libs/papercusp gates were executed by
// NOTHING before this leg existed; these tests are what stop it silently un-gating again.
const libsTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-libs-typecheck-tree-"),
);
writeFileSync(
  join(libsTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-libs-typecheck-fixture",
    scripts: {
      "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
    },
  }),
);
afterAll(() => rmSync(libsTypecheckTree, { recursive: true, force: true }));

// WI-7155 / EI-19376779013716004: a candidate tree that provides `lint:tsc:workspaces` but no
// other typecheck script — isolates the superproject fan-out leg's wiring from its two siblings,
// exactly as libsTypecheckTree isolates the libs/papercusp one. apps/*, packages/* and
// libs/generic/* were typechecked by NOTHING before this leg; these tests are what stop that
// silently returning.
const workspacesTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-workspaces-typecheck-tree-"),
);
writeFileSync(
  join(workspacesTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-workspaces-typecheck-fixture",
    scripts: { "lint:tsc:workspaces": "node scripts/lint-tsc-workspaces.mjs" },
  }),
);
afterAll(() =>
  rmSync(workspacesTypecheckTree, { recursive: true, force: true }),
);

// EI-19391297380137349: apps/operator has its own baseline-ratcheted project, outside the
// operator-core typecheck. Isolate its optional post-suite leg from every sibling gate.
const operatorTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-operator-typecheck-tree-"),
);
writeFileSync(
  join(operatorTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-operator-typecheck-fixture",
    scripts: { "lint:tsc:operator": "node scripts/lint-tsc-operator.mjs" },
  }),
);
afterAll(() => rmSync(operatorTypecheckTree, { recursive: true, force: true }));

// WI-38284: root `scripts/*.ts` is its own no-emit typecheck project. Keep a candidate
// fixture that opts into only that script so these tests exercise the real optional-leg
// discovery and failure path without coupling them to the other typecheck fixtures.
const scriptsTypecheckTree = mkdtempSync(
  join(tmpdir(), "green-cp-scripts-typecheck-tree-"),
);
writeFileSync(
  join(scriptsTypecheckTree, "package.json"),
  JSON.stringify({
    name: "cp-scripts-typecheck-fixture",
    scripts: { "lint:tsc:scripts": "node scripts/lint-tsc-scripts.mjs" },
  }),
);
afterAll(() => rmSync(scriptsTypecheckTree, { recursive: true, force: true }));

// EI-485: a candidate tree that provides `lint:migrations` but not `lint:tsc` — isolates
// the migrations-lint leg's wiring (position in the sequence, env, failure signature)
// from the typecheck leg's, the same way typecheckTree isolates typecheck from cpTree's
// no-optional-legs baseline.
const migrationsLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-migrations-lint-tree-"),
);
writeFileSync(
  join(migrationsLintTree, "package.json"),
  JSON.stringify({
    name: "cp-migrations-lint-fixture",
    scripts: { "lint:migrations": "node scripts/lint-migrations.mjs" },
  }),
);
afterAll(() => rmSync(migrationsLintTree, { recursive: true, force: true }));

// EI-18218408212070282: a candidate tree that provides `lint:design-primitives` but not
// `lint:tsc`/`lint:migrations` — isolates the design-primitives leg's wiring (position in
// the sequence, env, failure signature) the same way the trees above isolate their own legs.
const designPrimitivesLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-design-primitives-lint-tree-"),
);
writeFileSync(
  join(designPrimitivesLintTree, "package.json"),
  JSON.stringify({
    name: "cp-design-primitives-lint-fixture",
    scripts: {
      "lint:design-primitives":
        "node scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts",
    },
  }),
);
afterAll(() =>
  rmSync(designPrimitivesLintTree, { recursive: true, force: true }),
);

// EI-18147177863084708: a candidate tree that provides all 3 identity-leak lints
// (check-no-owner-name-tags.mjs / check-no-box-identity.mjs / check-no-identity-literals.mjs)
// but not `lint:tsc`/`lint:migrations`/`lint:design-primitives` — isolates the identity-leak
// leg's wiring (position in the sequence, all-3-run-unconditionally, combined failure
// signature) the same way the trees above isolate their own legs.
const identityLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-identity-lint-tree-"),
);
writeFileSync(
  join(identityLintTree, "package.json"),
  JSON.stringify({
    name: "cp-identity-lint-fixture",
    scripts: {
      "lint:no-owner-name-tags": "node scripts/check-no-owner-name-tags.mjs",
      "lint:no-box-identity": "node scripts/check-no-box-identity.mjs",
      "lint:no-identity-literals":
        "node scripts/check-no-identity-literals.mjs",
    },
  }),
);
afterAll(() => rmSync(identityLintTree, { recursive: true, force: true }));

// WI-38185: a candidate tree providing TWO independent cheap legs (design-primitives and
// no-control-bytes) so a red in the FIRST can be shown not to hide a red in the SECOND.
const twoCheapLintTree = mkdtempSync(
  join(tmpdir(), "green-cp-two-cheap-lint-tree-"),
);
writeFileSync(
  join(twoCheapLintTree, "package.json"),
  JSON.stringify({
    name: "cp-two-cheap-lint-fixture",
    scripts: {
      "lint:design-primitives": "node scripts/check-design-primitives.mjs",
      "lint:no-control-bytes": "node scripts/check-no-control-bytes.mjs",
    },
  }),
);
afterAll(() => rmSync(twoCheapLintTree, { recursive: true, force: true }));

// WI-6056: a candidate tree whose package.json EXISTS but is corrupt/truncated — the
// freshly-materialised checkpoint tree can genuinely land in this state (a partial copy /
// interrupted write), and it must NOT read the same as "this hive opts out of every leg".
const corruptPkgJsonTree = mkdtempSync(
  join(tmpdir(), "green-cp-corrupt-pkgjson-tree-"),
);
writeFileSync(
  join(corruptPkgJsonTree, "package.json"),
  '{ "name": "truncated-mid-wri',
);
afterAll(() => rmSync(corruptPkgJsonTree, { recursive: true, force: true }));

const cfg: ReleaseConfig = releaseConfig({
  integrationRoot: "/int",
  releaseRoot: "/int",
  checkpointRoot: cpTree,
  releaseRef: "ready",
  integrationBranch: "main",
  checkpointLogDir: tmpLogDir,
  // EI-20203883939710354 — DELIBERATELY FAKE, and deliberately set rather than defaulted.
  // Left unset this resolves to the real `@papercusp/operator-vite`, and the SPA-build
  // narration this suite drives then lands in the shared run log naming the real SPA
  // workspace — indistinguishable, to a grep, from a genuine "holding the gate" verdict
  // about it. Setting it also makes the build assertions below prove the build honours
  // cfg.spaBuildWorkspace instead of a hardcoded name, which is the stronger property.
  spaBuildWorkspace: "@example/fixture-spa",
});

describe("realCheckpointDeps.runGateAtRef — proof-backed empty Vitest invocation", () => {
  it("forwards guarded empty-run arguments from reuse to the actual workspace invocation", async () => {
    const tree = fileURLToPath(new URL("../../../../", import.meta.url));
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" });
    expect(head.status).toBe(0);
    const sha = head.stdout.trim();
    const finish = vi.fn(() => []);
    const arm = vi.spyOn(targetedTaskReuse, "armTargetedTaskReuse").mockResolvedValue({
      env: { GREEN_CHECKPOINT: "1", PC_TEST_REUSE_SKIP_LIST: "/fixture/verified-passes.json" },
      args: ["--passWithNoTests"], lines: [], reused: 2, recording: true, finish,
    });
    const { exec, calls } = makeExec([{ code: 0 }]);
    const deps = realCheckpointDeps({ ...cfg, checkpointRoot: tree }, exec);
    deps.setupTree = async () => {};
    try {
      const result = await deps.runGateAtRef!(sha, ["@papercusp/operator-vite :: test"]);
      expect(result.pass).toBe(true);
      expect(arm).toHaveBeenCalledWith(expect.objectContaining({
        expectedSha: sha,
        script: "test",
        restoreDirtyCheckpoint: true,
      }));
      const call = calls.find(c => c.args.includes("test"));
      expect(call?.args.slice(-2)).toEqual(["--", "--passWithNoTests"]);
      expect(call?.opts?.env?.PC_TEST_REUSE_SKIP_LIST).toBe("/fixture/verified-passes.json");
      expect(finish).toHaveBeenCalledOnce();
    } finally { arm.mockRestore(); }
  });

  it("records an arming exception as a hard reuse fail-open before running the task", async () => {
    const tree = fileURLToPath(new URL("../../../../", import.meta.url));
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tree, encoding: "utf8" });
    expect(head.status).toBe(0);
    const sha = head.stdout.trim();
    const arm = vi.spyOn(targetedTaskReuse, "armTargetedTaskReuse").mockRejectedValue(new Error("fixture arming failure"));
    const record = vi.spyOn(testPassReuse, "recordGateReuseDecision").mockResolvedValue(true);
    const { exec, calls } = makeExec([{ code: 0 }]);
    const deps = realCheckpointDeps({ ...cfg, checkpointRoot: tree }, exec);
    deps.setupTree = async () => {};
    try {
      const result = await deps.runGateAtRef!(sha, ["@papercusp/operator-vite :: test"]);
      expect(result.pass).toBe(true);
      expect(record).toHaveBeenCalledWith("@papercusp/operator-vite::test", {
        offReason: "arming-threw(fixture_arming_failure)",
      }, expect.objectContaining({ runContext: "green-checkpoint" }));
      const call = calls.find(c => c.args.includes("test"));
      expect(call?.args.slice(0, 2)).toEqual(["run", "test"]);
      expect(call?.args).not.toContain("--passWithNoTests");
      expect(call?.opts?.env?.PC_TEST_REUSE_SKIP_LIST).toBeUndefined();
    } finally {
      arm.mockRestore();
      record.mockRestore();
    }
  });
});
describe("WI-6554700010010213: real post-verdict deadline recorder", () => {
  const GH = "@papercusp/operator-core/lib/release/gate-health-merge";
  const PE = "@papercusp/operator-core/lib/harness/git-sync/pipeline-events";
  const ENV_KEYS = ["PAPERCUSP_GATE_VERDICT_WORKSPACE", "PAPERCUSP_GATE_VERDICT_HARNESS"] as const;
  const info = { label: "frozen-repair leg routing", deadlineMs: 60_000, elapsedMs: 60_004 };

  async function runRecorder(env: Record<string, string>) {
    const merge = vi.fn(async () => {});
    const append = vi.fn(async () => {});
    vi.doMock(GH, () => ({ mergeGateHealth: merge }));
    vi.doMock(PE, async (orig) => ({ ...(await orig<Record<string, unknown>>()), appendPipelineEvent: append }));
    const saved = ENV_KEYS.map((k) => process.env[k]);
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try {
      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).recordPostVerdictStepDeadline!(info);
    } finally {
      ENV_KEYS.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
      vi.doUnmock(GH);
      vi.doUnmock(PE);
    }
    return { merge, append };
  }

  it("writes the gate_health marker AND the dedicated-kind event for the env-scoped gate", async () => {
    const target = { workspaceId: "ws-fixture", installSlug: "hive-fixture" };
    const { merge, append } = await runRecorder({
      PAPERCUSP_GATE_VERDICT_WORKSPACE: target.workspaceId,
      PAPERCUSP_GATE_VERDICT_HARNESS: target.installSlug,
    });
    expect(merge).toHaveBeenCalledOnce();
    expect(merge).toHaveBeenCalledWith(target, {
      lastPostVerdictDeadline: expect.objectContaining({ ...info, at: expect.any(String) }),
    });
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      ...target,
      kind: "green_checkpoint_post_verdict",
      status: "deadline-exceeded",
      detail: expect.objectContaining(info),
    }));
  });

  it("records nothing for a non-recording run with no gate target", async () => {
    const { merge, append } = await runRecorder({});
    expect(merge).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});

const [GREEN_CMD0, ...GREEN_ARGS] = cfg.greenCmd.split(" ");

describe("WI-41720 / D-073: dependency-selection fatal path reaches the real CLI terminal controller", () => {
  it("fails on a missing prewarmed selector and awaits exact-candidate marker, event, and cleanup before exit", async () => {
    const candidate = "8104d3804ac4d134cead82a10c89c54d5efa53b7";
    const runId = "scheduled-05a2a744";
    const observed: string[] = [];
    let capturedFailure: unknown;

    const exec: CheckpointExec = async (cmd, args, opts) => {
      expect(args).toContainEqual(
        expect.stringMatching(
          /apps\/operator\/bin\/release\/dependency-generation\.sh$/,
        ),
      );
      opts?.onOutput?.(
        "stdout",
        "[dependency-generation] FATAL: no prewarmed dependency generation for input fingerprint fixture\n",
      );
      throw new Error(
        `${cmd} ${args.join(" ")} exited 1: ` +
          "[dependency-generation] FATAL: no prewarmed dependency generation for input fingerprint fixture",
      );
    };

    try {
      await realCheckpointDeps(cfg, exec, runId).setupTree(candidate, {
        preparedSource: true,
      });
    } catch (error) {
      capturedFailure = error;
    }
    expect(capturedFailure).toBeInstanceOf(Error);
    expect(String(capturedFailure)).toContain(
      "no prewarmed dependency generation",
    );

    let terminalOwner: "none" | "crash" = "none";
    const finalizeFatalError = createFatalCheckpointFinalizer({
      claimTerminal: (owner) => {
        if (terminalOwner !== "none") return false;
        terminalOwner = owner;
        observed.push(`claim:${owner}`);
        return true;
      },
      cancelWatchdog: () => observed.push("watchdog:cancel"),
      logFailure: (error) => observed.push(`log:${String(error)}`),
      emitCrashResult: async (error) => {
        const result = buildTerminalFailureCheckpointResult({
          candidate,
          error,
          runId,
        });
        await emitTerminalCheckpointResult(result, {
          writeHuman: () => {
            observed.push("human");
          },
          writeMarker: (line) => {
            observed.push(`marker:${line}`);
          },
          emitInconclusive: async (terminal) => {
            observed.push(`event:${terminal.candidate}:${terminal.green}`);
          },
          // Use the production retirement policy, not a look-alike cleanup callback. This is
          // what guards skipped-locked from clearing another run's marker while requiring every
          // true terminal result (including this crash) to retire its exact in-flight candidate.
          retire: async (terminal) => {
            await retireInFlightCandidateAfterResult(terminal, async () => {
              observed.push(`cleanup:${terminal.candidate}`);
            });
          },
        });
      },
      releaseLock: () => observed.push("lock:release"),
    });
    const exits: number[] = [];
    const handler = createFatalProcessHandler(finalizeFatalError, (code) => {
      observed.push(`exit:${code}`);
      exits.push(code);
    });

    handler(capturedFailure);
    await vi.waitFor(() => expect(exits).toEqual([1]));

    const marker = observed.find((entry) => entry.startsWith("marker:"));
    expect(marker).toContain(GREEN_CHECKPOINT_RESULT_MARKER);
    const terminal = JSON.parse(marker!.slice(marker!.indexOf("{")));
    expect(terminal).toMatchObject({
      candidate,
      green: null,
      // EI-21465187777146773: a CAUGHT crash publishes the same no-verdict status an unreported
      // one gets from checkpointFallbackStatus — it counts in consecutiveNoVerdict (WEDGED),
      // not in consecutiveReds. See green-checkpoint-crash-result.test.ts for the seam.
      reason: "error",
      crashed: true,
      runId,
    });
    expect(observed).toEqual(
      expect.arrayContaining([
        `event:${candidate}:null`,
        `cleanup:${candidate}`,
        "lock:release",
        "exit:1",
      ]),
    );
    expect(observed.indexOf(`cleanup:${candidate}`)).toBeLessThan(
      observed.indexOf("lock:release"),
    );
    expect(observed.indexOf("lock:release")).toBeLessThan(
      observed.indexOf("exit:1"),
    );
  });
});

describe("EI-21175363643337524: real disk-headroom admission", () => {
  const gcResult = (bytesUnlinked = 0, errors = 0) => ({
    dryRun: false,
    scanComplete: true,
    dirs: [
      {
        dir: "/tmp/fleet-logs",
        scanned: 4,
        removedByAge: bytesUnlinked > 0 ? 1 : 0,
        removedByCeiling: 0,
        bytesUnlinked,
        allocatedBytesUnlinked: bytesUnlinked,
        wouldUnlinkBytes: 0,
        bytesRemaining: 100,
        skippedOpen: 0,
        skippedRaced: 0,
        // Retention protection unread: green-checkpoint's headroom admission never consults it.
        cap: null,
        errors: Array.from({ length: errors }, (_, i) => ({
          path: `/tmp/fleet-logs/error-${i}.log`,
          error: "unlink failed",
        })),
      },
    ],
  });

  it("admits warning-only byte headroom on a large filesystem and preserves every snapshot", async () => {
    const gib = 1024 ** 3;
    const snapshots = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 200 * gib,
        freePct: 0.2,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
      {
        path: "/mnt/data",
        totalBytes: 1_000 * gib,
        freeBytes: 80 * gib,
        freePct: 0.08,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
    ];
    let sampleCount = 0;
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-warning-floor-run",
      undefined,
      undefined,
      async () => {
        sampleCount++;
        return snapshots;
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("/tmp 200.0 GiB free");
    expect(result?.summary).toContain("/mnt/data 80.0 GiB free");
    expect(sampleCount).toBe(1);
    // WI-10007424: the only subprocess is the dependency-copy headroom probe.
    expect(calls.map((c) => c.args.at(-1))).toEqual(["--check-headroom"]);
  });

  it("runs bounded GC once, re-samples once, and rejects a persistent critical breach", async () => {
    const gib = 1024 ** 3;
    const snapshots = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 1 * gib,
        freePct: 0.001,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
      {
        path: "/mnt/data",
        totalBytes: 1_000 * gib,
        freeBytes: 200 * gib,
        freePct: 0.2,
        totalInodes: 1_000_000,
        freeInodes: 10_000,
        freeInodesPct: 0.01,
      },
    ];
    let sampleCount = 0;
    let gcCount = 0;
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-critical-floor-run",
      undefined,
      undefined,
      async () => {
        sampleCount++;
        return snapshots;
      },
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(0, 1);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(false);
    // EI-23424266636870803: these assertions used to pin the message that WEDGED the
    // fleet gate unreadably — "…breaches the standing critical write headroom floor …
    // floor is 2.0 GiB and 2.00% bytes". That trailing clause quoted the raw policy
    // scalars, which are NOT the floor the breach test applies (the capped per-filesystem
    // reserve is), so on the real box it printed a 2.0 GiB "floor" beside 40.2 GiB free.
    // The assertion was real and the behaviour it pinned was wrong: a test can hold a
    // defect in place. Pin the APPLIED reserve and the ABSOLUTE deficit instead — here a
    // 1000 GiB filesystem reserves 2% = 20.0 GiB (under the 64 GiB cap) against 1.0 GiB
    // free, so the responder needs 19.0 GiB, not the 2.0 GiB the old line implied.
    expect(result?.summary).toContain(
      "/tmp low-bytes: the filesystem backing it has 1.0 GiB free of 1000.0 GiB, " +
        "under the 20.0 GiB write-headroom reserve — reclaim >= 19.0 GiB anywhere on that filesystem",
    );
    expect(result?.summary).toContain(
      "/mnt/data low-inodes: 1.00% inodes free, under the 5.00% floor",
    );
    // The clause that stops the destructive misreading: /tmp is a mount point on a shared
    // device, not a directory whose contents are the shortage.
    expect(result?.summary).toContain("free space belongs to the FILESYSTEM");
    expect(result?.summary).toContain("bounded disk GC: fleet logs scanned 4 file(s)");
    expect(result?.summary).toContain("with 1 error(s)");
    // The self-contradicting floor clause must not come back: it is the one line that
    // made the wedge message read as evidence against its own verdict.
    expect(result?.summary).not.toContain("floor is 2.0 GiB");
    expect(sampleCount).toBe(2);
    expect(gcCount).toBe(1);
    // WI-10007424: the dependency-copy probe runs beside each of the two samples.
    expect(calls.map((c) => c.args.at(-1))).toEqual([
      "--check-headroom",
      "--check-headroom",
    ]);
  });

  it("continues when one bounded GC pass restores measured headroom", async () => {
    const gib = 1024 ** 3;
    const low = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 1 * gib,
        freePct: 0.001,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
    ];
    const recovered = [{ ...low[0], freeBytes: 30 * gib, freePct: 0.03 }];
    const samples = [low, recovered];
    let gcCount = 0;
    const { exec } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-recovered-run",
      undefined,
      undefined,
      async () => samples.shift() ?? recovered,
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(29 * gib);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("automatic headroom recovery succeeded");
    expect(result?.summary).toContain("unlinked 29.00 GiB");
    expect(result?.summary).toContain("after cleanup: /tmp 30.0 GiB free");
    expect(gcCount).toBe(1);
    expect(samples).toHaveLength(0);
  });

  it("invokes Snapd's manager-owned cache action and records an ensure-cadence no-op", async () => {
    const gib = 1024 ** 3;
    const snapshots = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 1 * gib,
        freePct: 0.001,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
    ];
    let snapGcCount = 0;
    const { exec } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-snap-noop-run",
      undefined,
      undefined,
      async () => snapshots,
      undefined,
      undefined,
      async () => gcResult(0),
      async () => null,
      async () => {
        snapGcCount++;
        return {
          path: "/var/lib/snapd/cache",
          maxBytes: 1 * gib,
          beforeBytes: 9 * gib,
          afterBytes: 9 * gib,
          reclaimedBytes: 0,
          status: "cleanup-noop",
          note: "Snapd accepted ensure-state-soon but cache size did not change; cadence coalesced the request",
        };
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain("Snapd downloads-cache cleanup-noop");
    expect(result?.summary).toContain("cadence coalesced the request");
    expect(snapGcCount).toBe(1);
  });

  it("never runs cleanup when statfs is unreadable, and fails closed without deleting on an unknown target", async () => {
    let gcCount = 0;
    const { exec } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-unmeasured-run",
      undefined,
      undefined,
      async () => [],
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(1024);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain(
      "without running cleanup on an unmeasured target",
    );
    expect(gcCount).toBe(0);
  });

  it("contains a GC failure, re-samples once, and reports the persistent breach", async () => {
    const gib = 1024 ** 3;
    const snapshots = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 1 * gib,
        freePct: 0.001,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
    ];
    let sampleCount = 0;
    const { exec } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-gc-error-run",
      undefined,
      undefined,
      async () => {
        sampleCount++;
        return snapshots;
      },
      undefined,
      undefined,
      async () => {
        throw new Error("gc unavailable");
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain(
      "bounded disk GC: fleet-log cleanup failed safely (gc unavailable)",
    );
    expect(sampleCount).toBe(2);
  });

  it("reuses bounded producer-aware Cargo reclaim when that restores the critical filesystem", async () => {
    const gib = 1024 ** 3;
    const low = [
      {
        path: "/tmp",
        totalBytes: 1_000 * gib,
        freeBytes: 1 * gib,
        freePct: 0.001,
        totalInodes: 1_000_000,
        freeInodes: 500_000,
        freeInodesPct: 0.5,
      },
    ];
    const recovered = [{ ...low[0], freeBytes: 30 * gib, freePct: 0.03 }];
    const samples = [low, recovered];
    let fleetGcCount = 0;
    let cargoGcCount = 0;
    const { exec } = makeExec([]);
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "disk-headroom-cargo-recovered-run",
      undefined,
      undefined,
      async () => samples.shift() ?? recovered,
      undefined,
      undefined,
      async () => {
        fleetGcCount++;
        return gcResult(0);
      },
      async () => {
        cargoGcCount++;
        return {
          scanned: 1,
          reclaimed: 1,
          bytesReclaimed: 29 * gib,
          skipped: [],
        };
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("automatic headroom recovery succeeded");
    expect(result?.summary).toContain(
      "Cargo scanned 1 artifact(s), reclaimed 1, freed 29.00 GiB",
    );
    expect(fleetGcCount).toBe(1);
    expect(cargoGcCount).toBe(1);
    expect(samples).toHaveLength(0);
  });
});

describe("WI-10007424: dependency-copy headroom joins disk admission", () => {
  const gib = 1024 ** 3;
  // 45 GiB free on a 1000 GiB filesystem clears the alarm's critical-write reserve
  // (2% = 20 GiB), so in every case below the critical floor alone would admit the run.
  const roomy = [
    {
      path: "/tmp",
      totalBytes: 1_000 * gib,
      freeBytes: 45 * gib,
      freePct: 0.045,
      totalInodes: 1_000_000,
      freeInodes: 500_000,
      freeInodesPct: 0.5,
    },
  ];
  const insufficient =
    "[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=0 avail=48318382080 " +
    "reserve=38413868236 reserve_scope=protected-fs margin=10737418240 required=49151286476 " +
    "size=unknown path=/fixture/.dependency-generation-headroom-check";
  const sufficient =
    "[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_OK need=0 avail=59055800320 " +
    "reserve=38413868236 reserve_scope=protected-fs margin=10737418240 required=49151286476 " +
    "size=unknown path=/fixture/.dependency-generation-headroom-check";
  // Scripts the probe's exit codes in order. The script logs to stderr, so that is
  // where the verdict line is placed; every other subprocess succeeds silently.
  const probeExec = (codes: number[]) => {
    const probes: string[][] = [];
    const exec: CheckpointExec = async (cmd, args) => {
      if (!args.includes("--check-headroom"))
        return { code: 0, stdout: "", stderr: "" };
      probes.push([cmd, ...args]);
      const code = codes.shift() ?? 0;
      const stderr =
        code === 77
          ? insufficient
          : code === 0
            ? sufficient
            : "[dependency-generation] --check-headroom cannot be combined with another mode";
      return { code, stdout: "", stderr };
    };
    return { exec, probes };
  };
  const gcResult = (bytesUnlinked = 0) => ({
    dryRun: false,
    scanComplete: true,
    dirs: [
      {
        dir: "/tmp/fleet-logs",
        scanned: 1,
        removedByAge: bytesUnlinked > 0 ? 1 : 0,
        removedByCeiling: 0,
        bytesUnlinked,
        allocatedBytesUnlinked: bytesUnlinked,
        wouldUnlinkBytes: 0,
        bytesRemaining: 0,
        skippedOpen: 0,
        skippedRaced: 0,
        // Retention protection unread: green-checkpoint's headroom admission never consults it.
        cap: null,
        errors: [],
      },
    ],
  });

  it("refuses a run the critical floor admits when the dependency copy cannot start, after one bounded GC", async () => {
    const { exec, probes } = probeExec([77, 77]);
    let gcCount = 0;
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "dependency-copy-headroom-refused-run",
      undefined,
      undefined,
      async () => roomy,
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(0);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain(
      "dependency copy cannot start: DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT",
    );
    expect(result?.summary).toContain("required=49151286476");
    // The log prefix is the script's, not part of the reason a responder reads.
    expect(result?.summary).not.toContain("[dependency-generation]");
    // The critical floor did NOT trip, so its breach text must not be invented.
    expect(result?.summary).not.toContain("free space belongs to the FILESYSTEM");
    expect(result?.summary).toContain("bounded disk GC: fleet logs scanned 1 file(s)");
    expect(gcCount).toBe(1);
    expect(probes).toHaveLength(2);
    expect(probes[0]).toEqual([
      "bash",
      expect.stringMatching(
        /apps\/operator\/bin\/release\/dependency-generation\.sh$/,
      ),
      "--integration",
      cfg.integrationRoot,
      "--check-headroom",
    ]);
  });

  it("admits when the bounded GC restores dependency-copy headroom", async () => {
    const { exec, probes } = probeExec([77, 0]);
    let gcCount = 0;
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "dependency-copy-headroom-recovered-run",
      undefined,
      undefined,
      async () => roomy,
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(11 * gib);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("automatic headroom recovery succeeded");
    expect(result?.summary).toContain("DEPENDENCY_GENERATION_HEADROOM_OK");
    expect(gcCount).toBe(1);
    expect(probes).toHaveLength(2);
  });

  it("admits without cleanup when both floors pass", async () => {
    const { exec, probes } = probeExec([0]);
    let gcCount = 0;
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "dependency-copy-headroom-ok-run",
      undefined,
      undefined,
      async () => roomy,
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(0);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("/tmp 45.0 GiB free");
    expect(result?.summary).toContain("DEPENDENCY_GENERATION_HEADROOM_OK");
    expect(gcCount).toBe(0);
    expect(probes).toHaveLength(1);
  });

  it("treats a probe failure other than exit 77 as unmeasured and leaves the critical floor as the only check", async () => {
    const { exec, probes } = probeExec([2]);
    let gcCount = 0;
    const deps = realCheckpointDeps(
      cfg,
      exec,
      "dependency-copy-headroom-probe-broken-run",
      undefined,
      undefined,
      async () => roomy,
      undefined,
      undefined,
      async () => {
        gcCount++;
        return gcResult(0);
      },
    );

    const result = await deps.checkDiskHeadroom?.();

    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain(
      "dependency-copy headroom probe exited 2; the critical-write floor is the only admission check",
    );
    expect(gcCount).toBe(0);
    expect(probes).toHaveLength(1);
  });
});

describe("realCheckpointDeps.runChangedFileTypecheckPreflight — WI-38422", () => {
  const preflightCfg: ReleaseConfig = { ...cfg, checkpointRoot: typecheckTree };

  it("excludes proved candidate deletions without hiding unexpected missing files", async () => {
    const repo = mkdtempSync(join(tmpdir(), "preflight-deletion-proof-"));
    onTestFinished(() => rmSync(repo, { recursive: true, force: true }));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    const deleted = "packages/operator-core/lib/deleted.ts";
    const missing = "packages/operator-core/lib/missing.ts";
    mkdirSync(join(repo, "packages/operator-core/lib"), { recursive: true });
    writeFileSync(join(repo, deleted), "export {};");
    writeFileSync(join(repo, missing), "export const value = 1;");
    git("add", ".");
    git("commit", "--no-verify", "-qm", "before");
    const from = git("rev-parse", "HEAD");
    git("rm", deleted);
    writeFileSync(join(repo, missing), "export const value = 2;");
    git("add", ".");
    git("commit", "--no-verify", "-qm", "after");
    const to = git("rev-parse", "HEAD");
    // Neither file exists in typecheckTree: only the committed deletion may
    // disappear from the response file. The strict CLI must still see the other.
    const selections: string[][] = [];
    const exec: CheckpointExec = async (_cmd, args) => {
      const response = args.find((arg) => arg.startsWith("--files-from="));
      if (!response) return { code: 0, stdout: "", stderr: "" };
      selections.push(JSON.parse(readFileSync(response.slice("--files-from=".length), "utf8")));
      return { code: 1, stdout: "explicit file selection contains missing paths", stderr: "" };
    };
    const deps = realCheckpointDeps({ ...preflightCfg, integrationRoot: repo }, exec);
    const result = await deps.runChangedFileTypecheckPreflight?.([deleted, missing], { from, to });
    expect(selections).toEqual([[missing]]);
    expect(result).toMatchObject({ status: "failed", checkedFiles: [missing] });

    selections.length = 0;
    const deletionOnly = await deps.runChangedFileTypecheckPreflight?.([deleted], { from, to });
    expect(deletionOnly?.status).toBe("skipped");
    expect(selections).toEqual([]);

    // Unavailable revision evidence cannot silently bless missing files.
    await deps.runChangedFileTypecheckPreflight?.([deleted, missing], { from, to: "missing-ref" });
    expect(selections).toEqual([[deleted, missing]]);
  });

  it("runs the existing lint:tsc gate with the exact committed diff, release env, and sequential-leg heap", async () => {
    const { exec, calls } = makeExec([
      {
        code: 0,
        stdout:
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean\n",
      },
    ]);
    const deps = realCheckpointDeps(preflightCfg, exec, "preflight-run-id");

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "docs/note.md",
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toMatchObject({ status: "passed", failingSignatures: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cmd: "npm",
      opts: {
        cwd: typecheckTree,
        allowNonZero: true,
        heavy: true,
      },
    });
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[0].opts?.env?.PC_HEAVY_RELEASE_GATE).toBe("1");
    expect(calls[0].opts?.env?.NODE_OPTIONS).toContain(
      `--max-old-space-size=${GREEN_CHECKPOINT_POST_SUITE_HEAP_MB}`,
    );
    expect(calls[0].args.slice(0, 3)).toEqual(["run", "lint:tsc", "--"]);
    const responseArg = calls[0].args[3];
    expect(responseArg).toMatch(/^--files-from=/);
    expect(responseArg.startsWith(`--files-from=${tmpdir()}/`)).toBe(true);
    expect(responseArg).toContain("green-checkpoint-typecheck-files-");
  });

  it("routes mixed-owner changes to each discovered gate once, leaving non-typecheck paths out", async () => {
    const calls: Array<{
      cmd: string;
      args: string[];
      opts?: Parameters<CheckpointExec>[2];
    }> = [];
    const responseFiles: string[][] = [];
    const exec: CheckpointExec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const responseArg = args.find((arg) => arg.startsWith("--files-from="));
      expect(responseArg).toBeDefined();
      responseFiles.push(
        JSON.parse(
          readFileSync(responseArg!.slice("--files-from=".length), "utf8"),
        ) as string[],
      );
      return {
        code: 0,
        stdout:
          responseFiles.length === 1
            ? "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean\n"
            : "LINT_TSC_RESULT label=operator-vite scope=files exit=0 status=clean\n",
        stderr: "",
      };
    };
    const deps = realCheckpointDeps(preflightCfg, exec, "mixed-preflight-run");

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
      "apps/operator-vite/src/components/adv/LearningTab.tsx",
      "packages/operator-core/lib/a.ts",
      "docs/note.md",
    ]);

    expect(result).toMatchObject({
      status: "passed",
      failingSignatures: [],
      checkedFiles: [
        "packages/operator-core/lib/a.ts",
        "apps/operator-vite/src/components/adv/LearningTab.tsx",
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.args.slice(0, 2))).toEqual([
      ["run", "lint:tsc"],
      ["run", "lint:tsc:operator-vite"],
    ]);
    expect(responseFiles).toEqual([
      ["packages/operator-core/lib/a.ts"],
      ["apps/operator-vite/src/components/adv/LearningTab.tsx"],
    ]);
  });

  it("keeps a large changed-file set out of argv while preserving the exact response-file set", async () => {
    const files = Array.from(
      { length: 50_000 },
      (_, index) => `packages/operator-core/lib/generated-${index}.ts`,
    );
    let responseArg: string | undefined;
    let responseFiles: string[] | undefined;
    const exec: CheckpointExec = async (_cmd, args) => {
      responseArg = args.find((arg) => arg.startsWith("--files-from="));
      expect(responseArg).toBeDefined();
      responseFiles = JSON.parse(
        readFileSync(responseArg!.slice("--files-from=".length), "utf8"),
      ) as string[];
      return {
        code: 0,
        stdout:
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean\n",
        stderr: "",
      };
    };
    const deps = realCheckpointDeps(preflightCfg, exec, "large-preflight-run");

    const result = await deps.runChangedFileTypecheckPreflight?.(files);

    expect(result).toMatchObject({ status: "passed", failingSignatures: [] });
    expect(responseArg).toBeDefined();
    expect(responseArg!.length).toBeLessThan(256);
    expect(responseFiles).toEqual(files);
  });

  it("maps a completed non-zero scoped lint verdict to the stable lint:tsc failure signature", async () => {
    const { exec } = makeExec([
      {
        code: 1,
        stdout:
          "packages/operator-core/lib/a.ts(1,14): error TS2322: Type string is not assignable to number\n" +
          "LINT_TSC_RESULT label=operator-core scope=files exit=1 status=regressed\n",
      },
    ]);
    const deps = realCheckpointDeps(preflightCfg, exec);

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toMatchObject({
      status: "failed",
      failingSignatures: ["lint:tsc"],
    });
    expect(result?.summary).toContain("TS2322");
    expect(result?.summary).toContain("status=regressed");
  });

  it("measures whole-program typechecks and downstream blocking lints after a scoped red", async () => {
    const inventoryTree = mkdtempSync(
      join(tmpdir(), "green-cp-early-failure-inventory-"),
    );
    mkdirSync(join(inventoryTree, "scripts"), { recursive: true });
    const typecheckScripts = [
      "lint:tsc",
      "lint:tsc:papercusp-libs",
      "lint:tsc:workspaces",
      "lint:tsc:operator",
      "lint:tsc:orchestrator",
      "lint:tsc:scripts",
    ];
    const downstreamLints = [
      "lint:guard-reachability",
      "lint:mock-cast-escape",
    ];
    const typecheckProjects: Record<string, string> = {
      "lint:tsc": "packages/operator-core/tsconfig.json",
      "lint:tsc:papercusp-libs": "libs/papercusp/tsconfig.json",
      "lint:tsc:workspaces": "apps/operator-public/tsconfig.json",
      "lint:tsc:operator": "apps/operator/tsconfig.json",
      "lint:tsc:orchestrator": "libs/papercusp/packages/orchestrator/tsconfig.json",
      "lint:tsc:scripts": "scripts/tsconfig.json",
    };
    writeFileSync(
      join(inventoryTree, "package.json"),
      JSON.stringify({
        name: "cp-early-failure-inventory-fixture",
        scripts: Object.fromEntries([
          ...Object.keys(typecheckProjects).map((script) => [
            script,
            "node scripts/" + script.replaceAll(":", "-") + ".mjs",
          ]),
          ...downstreamLints.map((script) => [script, "node scripts/fixture.mjs"]),
        ]),
      }),
    );
    for (const [script, project] of Object.entries(typecheckProjects)) {
      writeFileSync(
        join(inventoryTree, "scripts", script.replaceAll(":", "-") + ".mjs"),
        "export const TSC_COMMAND = 'npx tsc -p " + project + " --noEmit';\n",
      );
    }
    onTestFinished(() => rmSync(inventoryTree, { recursive: true, force: true }));

    const calls: string[] = [];
    const failingScripts = new Set([...typecheckScripts, ...downstreamLints]);
    const exec: CheckpointExec = async (cmd, args) => {
      if (cmd !== "npm" || args[0] !== "run") {
        return { code: 0, stdout: "", stderr: "" };
      }
      const script = args[1]!;
      const scoped = args.some((arg) => arg.startsWith("--files-from="));
      calls.push(scoped ? script + ":files" : script);
      const failed = scoped || failingScripts.has(script);
      return {
        code: failed ? 1 : 0,
        stdout: failed ? script + " failed\n" : "",
        stderr: "",
      };
    };
    const deps = realCheckpointDeps(
      { ...preflightCfg, checkpointRoot: inventoryTree },
      exec,
    );

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result?.status).toBe("failed");
    expect(result?.failingSignatures).toEqual(
      expect.arrayContaining([...typecheckScripts, ...downstreamLints]),
    );
    expect(result?.failureInventory).toMatchObject({
      ran: true,
      failingSignatures: expect.arrayContaining([
        ...typecheckScripts,
        ...downstreamLints,
      ]),
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        "lint:tsc:files",
        ...typecheckScripts,
        ...downstreamLints,
      ]),
    );
    expect(result?.failureInventory?.records).toEqual(
      expect.arrayContaining([
        ...typecheckScripts.map((id) =>
          expect.objectContaining({ id, status: "failed" }),
        ),
        ...downstreamLints.map((id) =>
          expect.objectContaining({ id, status: "failed" }),
        ),
      ]),
    );
  });

  it("skips the SPA build when the scoped failure is the only blocker", async () => {
    const { exec } = makeExec([
      {
        code: 1,
        stdout:
          "packages/operator-core/lib/a.ts(1,14): error TS2322\n" +
          "LINT_TSC_RESULT label=operator-core scope=files exit=1 status=regressed\n",
      },
    ]);
    const deps = realCheckpointDeps(preflightCfg, exec);

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result?.failureInventory).toMatchObject({ ran: true });
    expect(result?.failureInventory?.failingSignatures).toEqual([]);
    expect(
      result?.failureInventory?.records.find((record) => record.id === "spa-build"),
    ).toMatchObject({
      status: "skipped",
      skipReason: "early changed-file typecheck failure already blocks promotion",
    });
  });

  it("reports a subject hive without lint:tsc as skipped and shells nothing", async () => {
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(cfg, exec);

    const result = await deps.runChangedFileTypecheckPreflight?.([
      "packages/operator-core/lib/a.ts",
    ]);

    expect(result).toEqual({
      status: "skipped",
      summary:
        "no changed file has a resolvable owning lint:tsc gate — full gate retained",
    });
    expect(calls).toEqual([]);
  });
});

describe("P-007/D-004: the real deps no longer wire a frozen-repair staging join", () => {
  it("exposes no reconcileFrozenRepairIntoStaging hook, and leaves the integration branch alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "green-cp-repair-bridge-"));
    const remote = join(root, "origin.git");
    const repo = join(root, "work");
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
      if (result.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
      }
      return result.stdout.trim();
    };
    const priorWorkspace = process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
    const priorHarness = process.env.PAPERCUSP_GATE_VERDICT_HARNESS;

    try {
      git(root, "init", "--bare", "-q", remote);
      git(repo, "init", "-q", "-b", "staging");
      git(repo, "config", "user.email", "fixture@example.invalid");
      git(repo, "config", "user.name", "fixture");
      writeFileSync(join(repo, "a"), "1");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "ready");
      const ready = git(repo, "rev-parse", "HEAD");

      git(repo, "switch", "-qc", "repair");
      writeFileSync(join(repo, "b"), "broken");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "frozen");
      const frozen = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "b"), "fixed");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "verified repair");
      const repairHead = git(repo, "rev-parse", "HEAD");

      git(repo, "switch", "-q", "staging");
      writeFileSync(join(repo, "b"), "fixed");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "patch-equivalent staging repair");
      writeFileSync(join(repo, "c"), "later staging work");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "later staging work");
      const stagingTip = git(repo, "rev-parse", "HEAD");
      const stagingTree = git(repo, "rev-parse", `${stagingTip}^{tree}`);
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-qu", "origin", "staging");

      process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = "fixture-workspace";
      process.env.PAPERCUSP_GATE_VERDICT_HARNESS = "fixture-harness";
      const deps = realCheckpointDeps({
        ...cfg,
        integrationRoot: repo,
        releaseRoot: repo,
        checkpointRoot: repo,
        integrationBranch: "staging",
      });
      // EI-21007486441633274 / WI-40081 wired a real `reconcileFrozenRepairIntoStaging` here,
      // because D-001 held that a green isolated repair head could not advance the release ref:
      // it published an additive staging join and the gate re-ran the COMPLETE suite at the
      // joined sha. D-004 (owner-ratified 2026-09-03) promotes the lineage commit itself, so the
      // hook is gone — and with it the second full suite and the re-import of everything that
      // landed since the freeze. The fixture is kept: it proves the deps are real deps built on
      // a real repo, so `toBeUndefined` here is a measurement and not a vacuous pass.
      expect(
        // `as unknown as` is required, not cosmetic: CheckpointDeps and
        // Record<string, unknown> do not sufficiently overlap for a direct
        // assertion (TS2352). Probing for a key the type no longer declares is
        // exactly the point of this assertion, so widen through `unknown`.
        (deps as unknown as Record<string, unknown>)
          .reconcileFrozenRepairIntoStaging,
      ).toBeUndefined();
      // POSITIVE CONTROL: these same deps DO carry the hooks the gate still uses, so an empty
      // or mis-built `deps` object cannot make the assertion above pass by accident.
      expect(typeof deps.runGreen).toBe("function");
      expect(typeof deps.advance).toBe("function");

      // Nothing was joined, pushed, or moved: the integration branch is exactly where the
      // fixture left it, locally and on its remote.
      expect(git(repo, "rev-parse", "staging")).toBe(stagingTip);
      expect(git(repo, "rev-parse", `${stagingTip}^{tree}`)).toBe(stagingTree);
      expect(git(repo, "ls-remote", "origin", "refs/heads/staging")).toBe(
        `${stagingTip}\trefs/heads/staging`,
      );
      // The lineage the join used to consume still exists and is untouched by these deps.
      expect(repairHead).toMatch(/^[0-9a-f]{40}$/);
      git(repo, "merge-base", "--is-ancestor", frozen, repairHead);
      git(repo, "merge-base", "--is-ancestor", ready, frozen);
    } finally {
      if (priorWorkspace === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE;
      else process.env.PAPERCUSP_GATE_VERDICT_WORKSPACE = priorWorkspace;
      if (priorHarness === undefined)
        delete process.env.PAPERCUSP_GATE_VERDICT_HARNESS;
      else process.env.PAPERCUSP_GATE_VERDICT_HARNESS = priorHarness;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("realCheckpointDeps.runGreen — real-path wiring (gap #10)", () => {
  it("archives the actual candidate suite command and child completion clock", async () => {
    const sha = 'a'.repeat(40);
    const output = 'TEST_PASS_REUSE applied=false reason=disabled';
      const { exec, calls } = makeExec([{ code: 1, stdout: output }]);
    let clock = 100;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const measuredExec: typeof exec = async (...args) => {
        const result = await exec(...args);
        clock = 200;
        return result;
      };
      const result = await realCheckpointDeps(cfg, measuredExec, 'suite-clock-run').runGreen(
        cpTree, null, { candidate: sha });
      expect(result.testPassReuse?.suite).toEqual({ command: cfg.greenCmd,
        runGroupId: 'suite-clock-run', startedAtMs: 100, completedAtMs: 200 });
      expect(calls[0].opts?.env?.PC_TEST_REUSE_DISPOSABLE_CHECKPOINT_ROOT).toBe(cfg.checkpointRoot);
      expect(calls[0].opts?.env?.PC_TEST_REUSE_INTEGRATION_ROOT).toBe(cfg.integrationRoot);
      expect(calls[0].opts?.env?.PC_TEST_REUSE_RELEASE_ROOT).toBe(cfg.releaseRoot);
    } finally { now.mockRestore(); }
  });

  it("does not grant dirty-checkpoint restoration to a different candidate tree", async () => {
    const { exec, calls } = makeExec([]);
    await realCheckpointDeps(cfg, exec).runGreen(typecheckTree, "base-sha", {
      candidate: "b".repeat(40),
    });

    expect(calls[0].opts?.env?.PC_TEST_REUSE_DISPOSABLE_CHECKPOINT_ROOT).toBeUndefined();
    expect(calls[0].opts?.env?.PC_TEST_REUSE_INTEGRATION_ROOT).toBeUndefined();
    expect(calls[0].opts?.env?.PC_TEST_REUSE_RELEASE_ROOT).toBeUndefined();
  });

  it("detects the optional lint:tsc script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc")).toBe(false);
    expect(hasNpmScript(typecheckTree, "lint:tsc")).toBe(true);
  });

  it("wires an explicitly reserved ReleaseConfig into the real suite process environment", async () => {
    const reservedCfg: ReleaseConfig = {
      ...cfg,
      greenCheckpointCapacityMode: "reserved",
    };
    // suite green → marker grep has no match → SPA build green.
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(reservedCfg, exec).runGreen(
      cpTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls[0].opts?.env?.VITEST_MAX_FORKS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
    expect(calls[0].opts?.env?.VITEST_MAX_THREADS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
  });

  it("classifies a post-suite ENOSPC red before publishing failing-file evidence", async () => {
    const lowSpaceOutput =
      ">>> @example/fixture-pkg :: npm run test\n" +
      "Error: ENOSPC: no space left on device, open '/tmp/pcv/worker.json'\n" +
      "Error: ENOSPC: no space left on device, write '/tmp/pcv/reporter.json'\n";
    const healthy = {
      path: "/tmp",
      totalBytes: 7.3 * 1024 ** 4,
      freeBytes: 1_000 * 1024 ** 3,
      freePct: 0.2,
      totalInodes: 1_000_000,
      freeInodes: 500_000,
      freeInodesPct: 0.5,
    };
    const exhausted = {
      ...healthy,
      freeBytes: 0,
      freePct: 0,
    };
    let samples = 0;
    const { exec, calls } = makeExec([{ code: 1, stdout: lowSpaceOutput }]);
    const r = await realCheckpointDeps(
      cfg,
      exec,
      "disk-infra-run",
      undefined,
      undefined,
      async () => [samples++ === 0 ? healthy : exhausted],
    ).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(r.infraFault).toMatchObject({
      kind: "disk-space-exhausted",
      paths: ["/tmp"],
    });
    expect(r.infraFault?.note).toMatch(/must NOT be triaged/);
    expect(samples).toBe(2);
    // A red suite defers post-suite legs; disk attribution happens before any rescue path.
    expect(calls).toHaveLength(1);
  });

  it("threads candidate and frozen-repair attribution into the suite without replacing the verifier run id", async () => {
    // suite green → marker grep has no match → SPA build green.
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(
      cfg,
      exec,
      "repair-verifier-run",
    ).runGreen(cpTree, "base-sha", {
      candidate: "c".repeat(40),
      affectedTestProofGroup: "initial-proof-run",
    });

    expect(r.green).toBe(true);
    expect(calls[0].opts?.env?.PAPERCUSP_TEST_RUN_GROUP).toBe(
      "repair-verifier-run",
    );
    expect(calls[0].opts?.env?.PAPERCUSP_TEST_RUN_COMMIT).toBe("c".repeat(40));
    expect(calls[0].opts?.env?.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBe(
      "initial-proof-run",
    );
  });

  it("runs the Papercusp lint:tsc leg before the SPA build when the candidate provides it", async () => {
    // suite green → typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      typecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc"]);
    expect(calls[1].opts?.cwd).toBe(typecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("EI-203121: threads real-path run, tree, setup, dependency, and result identity into the verdict", async () => {
    const { exec } = makeExec([
      { code: 0 },
      { code: 0, stdout: "typecheck passed" },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec, "run-identity-42").runGreen(
      typecheckTree,
      "base-sha",
      {
        candidate: "c".repeat(40),
        headAtStart: "h".repeat(40),
        setup: {
          identity: "setup-release-checkout:candidate",
          output: "setup copied dependencies",
        },
      },
    );

    expect(r.green).toBe(true);
    expect(r.postSuiteLegs?.length).toBeGreaterThan(0);
    const typecheck = r.postSuiteLegs?.find((leg) => leg.id === "lint:tsc");
    expect(typecheck?.executionIdentity).toMatchObject({
      runId: "run-identity-42",
      candidate: "c".repeat(40),
      treeDir: typecheckTree,
      cwd: typecheckTree,
      headAtStart: "h".repeat(40),
      setup: {
        identity: "setup-release-checkout:candidate",
        output: "setup copied dependencies",
      },
      result: {
        status: "passed",
        exit: "completed",
        exitCode: 0,
        output: "typecheck passed\n",
      },
    });
    expect(
      typecheck?.executionIdentity?.dependencies.nodeModules,
    ).toMatchObject({
      hash: null,
      inode: null,
      source: "missing",
    });
  });

  it("holds the candidate when lint:tsc reports a type regression and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(typecheckTree, null);

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc");
    expect(r.summary).toContain("TYPECHECK FAILED");
    expect(calls).toHaveLength(2);
  });

  it("EI-19995300915348764: publishes GATE_HELD_BY before returning a real red", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([
      { code: 0 },
      { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(typecheckTree, null);

    expect(r.green).toBe(false);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const body = readFileSync(join(tmpLogDir, writtenLog), "utf8");
    // This line is written by realCheckpointDeps.runGreen itself, before the orchestration
    // layer can append its richer verdict block or be interrupted by a watchdog.
    const heldByLine = body
      .split("\n")
      .find((line) => line.startsWith("GATE_HELD_BY count="));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain("count=1");
    expect(heldByLine).toContain('entries=["lint:tsc"]');
  });

  it("EI-20689175600678908: strips control bytes before persisting the checkpoint log", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([
      {
        code: 0,
        stdout: "suite output before\0after\u0007\n",
      },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(true);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const bytes = readFileSync(join(tmpLogDir, writtenLog));
    expect(bytes.includes(0)).toBe(false);
    expect(bytes.includes(7)).toBe(false);
    expect(bytes.toString("utf8")).toContain("suite output beforeafter");
  });

  it("EI-20336874238055183: GATE_HELD_BY uses the final authoritative break set, not stale retry rows", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const staleRowsThenAuthoritativeEmptyFiles = [
      ">>> @example/fixture-pkg :: npm run test",
      " FAIL  lib/stale-first.test.ts > stale retry output",
      " ❯ lib/stale-second.test.ts (1 test | 1 failed) 10ms",
      "",
      "1 non-quarantined task(s) failed:",
      "  - @papercusp/web :: test:el-suite",
      "",
      "0 failing test file(s) — the per-FILE break set (the failed=1 above counts TASKS, not files):",
      "1 failed task(s) could NOT be attributed to files — their failures are REAL but unnamed here; do not read the list above as complete:",
      "  - @papercusp/web :: test:el-suite (no-file-rows)",
      'AFFECTED_TESTS_FAILING_FILES run=fixture-20336874238055183 coverage=unattributed files=[] unattributed=[{"task":"@papercusp/web :: test:el-suite","reason":"no-file-rows"}] transformCulprits=[]',
    ].join("\n");
    const { exec } = makeExec([
      { code: 1, stdout: staleRowsThenAuthoritativeEmptyFiles },
    ]);

    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(r.failingTests).toEqual([
      "@papercusp/web",
      "@papercusp/web :: test:el-suite",
    ]);
    expect(r.failingTests).not.toContain("lib/stale-first.test.ts");
    expect(r.failingTests).not.toContain("lib/stale-second.test.ts");

    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    const writtenLog = written[0];
    if (!writtenLog)
      throw new Error("expected one newly-written checkpoint log");
    const body = readFileSync(join(tmpLogDir, writtenLog), "utf8");
    const heldByLine = body
      .split("\n")
      .find((line) => line.startsWith("GATE_HELD_BY count="));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain(
      'entries=["@papercusp/web","@papercusp/web :: test:el-suite"]',
    );
    expect(heldByLine).not.toContain("stale-first.test.ts");
    expect(heldByLine).not.toContain("stale-second.test.ts");
  });

  // WI-6841: `lint:tsc` resolves to packages/operator-core alone, so the EIGHT typecheck
  // gates libs/papercusp packages had earned (libs/db, file-claim, blueprint-distribution,
  // harness, harness/docs-viewer, locks, gitnexus-bridge at a strict zero + orchestrator on a
  // per-file baseline) ran under NO automation — they existed, passed by hand, and gated
  // nothing. Mirrors the lint:tsc wiring tests above; these are the teeth.
  it("detects the optional lint:tsc:papercusp-libs script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:papercusp-libs")).toBe(false);
    expect(hasNpmScript(libsTypecheckTree, "lint:tsc:papercusp-libs")).toBe(
      true,
    );
  });

  it("runs the libs/papercusp typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → libs typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      libsTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
    expect(calls[1].opts?.cwd).toBe(libsTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when a libs/papercusp package regresses and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ libs/papercusp/packages/locks\nsrc/claim.ts(12,3): error TS2322: Type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      libsTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:papercusp-libs");
    expect(r.summary).toContain("LIBS/PAPERCUSP TYPECHECK FAILED");
    // The package that regressed must be NAMED in the held verdict — a gate that says only
    // "typecheck failed" across 8 packages costs the reader the diagnosis.
    expect(r.summary).toContain("libs/papercusp/packages/locks");
    // Short-circuits: no marker grep, no SPA build.
    expect(calls).toHaveLength(2);
  });

  it("runs the libs/papercusp typecheck leg AFTER operator-core lint:tsc when a candidate provides both", async () => {
    // Both legs present: the order is asserted, not incidental — operator-core imports
    // libs/papercusp, so its red is the more diagnostic one to surface first.
    const bothTree = mkdtempSync(
      join(tmpdir(), "green-cp-both-typecheck-tree-"),
    );
    writeFileSync(
      join(bothTree, "package.json"),
      JSON.stringify({
        name: "cp-both-typecheck-fixture",
        scripts: {
          "lint:tsc": "node scripts/lint-tsc.mjs",
          "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
        },
      }),
    );
    try {
      const { exec, calls } = makeExec([
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(bothTree, null);

      expect(r.green).toBe(true);
      expect(calls[1].args).toEqual(["run", "lint:tsc"]);
      expect(calls[2].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
    } finally {
      rmSync(bothTree, { recursive: true, force: true });
    }
  });

  // WI-7155 / EI-19376779013716004: the same phantom-gate shape a THIRD time, generalized.
  // `lint:tsc` covers operator-core and the leg above covers the libs/papercusp submodule,
  // which left the SUPERPROJECT roots (apps/*, packages/*, libs/generic/*) typechecked by
  // NOTHING — `test:affected` is type-blind by design, so a regression there sat committed
  // indefinitely. Unlike its two siblings this leg DISCOVERS its packages, so the next one to
  // land is gated without anyone remembering. These are its teeth.
  it("detects the optional lint:tsc:workspaces script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:workspaces")).toBe(false);
    expect(hasNpmScript(workspacesTypecheckTree, "lint:tsc:workspaces")).toBe(
      true,
    );
  });

  it("runs the workspaces typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → workspaces typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      workspacesTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:workspaces"]);
    expect(calls[1].opts?.cwd).toBe(workspacesTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when a workspace package regresses and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ libs/generic/search-core\nsrc/rank.ts(9,1): error TS2345: Argument type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      workspacesTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:workspaces");
    expect(r.summary).toContain("WORKSPACE TYPECHECK FAILED");
    // The package that regressed must be NAMED in the held verdict — a gate that says only
    // "typecheck failed" across 8 packages costs the reader the diagnosis.
    expect(r.summary).toContain("libs/generic/search-core");
    // Short-circuits: no marker grep, no SPA build.
    expect(calls).toHaveLength(2);
  });

  it("runs the three typecheck legs in order: operator-core, then libs/papercusp, then workspaces", async () => {
    // Order is asserted, not incidental. operator-core imports libs/papercusp, so its red is
    // the more diagnostic one to surface first; the workspaces fan-out is the widest and
    // cheapest-to-diagnose, so it goes last of the three.
    const allTree = mkdtempSync(join(tmpdir(), "green-cp-all-typecheck-tree-"));
    writeFileSync(
      join(allTree, "package.json"),
      JSON.stringify({
        name: "cp-all-typecheck-fixture",
        scripts: {
          "lint:tsc": "node scripts/lint-tsc.mjs",
          "lint:tsc:papercusp-libs": "node scripts/lint-tsc-papercusp-libs.mjs",
          "lint:tsc:workspaces": "node scripts/lint-tsc-workspaces.mjs",
        },
      }),
    );
    try {
      const { exec, calls } = makeExec([
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(allTree, null);

      expect(r.green).toBe(true);
      expect(calls[1].args).toEqual(["run", "lint:tsc"]);
      expect(calls[2].args).toEqual(["run", "lint:tsc:papercusp-libs"]);
      expect(calls[3].args).toEqual(["run", "lint:tsc:workspaces"]);
    } finally {
      rmSync(allTree, { recursive: true, force: true });
    }
  });

  // EI-19391297380137349: apps/operator's canonical baseline gate existed but the release
  // checkpoint never invoked it. These assertions keep discovery, execution, and the stable
  // failure signature wired through the real dependency path.
  it("detects the optional lint:tsc:operator script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:operator")).toBe(false);
    expect(hasNpmScript(operatorTypecheckTree, "lint:tsc:operator")).toBe(true);
  });

  it("runs the operator typecheck leg before the SPA build when the candidate provides it", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      operatorTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:operator"]);
    expect(calls[1].opts?.cwd).toBe(operatorTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when apps/operator typecheck reports a regression", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout: "apps/operator/lib/host.ts(7,3): error TS2322: Type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      operatorTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:operator");
    expect(r.summary).toContain("OPERATOR TYPECHECK FAILED");
    expect(r.summary).toContain("apps/operator/lib/host.ts");
    expect(calls.some((c) => c.args.includes("build"))).toBe(false);
  });

  // WI-38284: root scripts are load-bearing TypeScript CLIs, but they sit outside every
  // package project. The dedicated leg must be discovered and run by the REAL checkpoint
  // dependency path, not merely exported in the post-suite helper.
  it("detects the optional lint:tsc:scripts script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:tsc:scripts")).toBe(false);
    expect(hasNpmScript(scriptsTypecheckTree, "lint:tsc:scripts")).toBe(true);
  });

  it("runs the root scripts typecheck leg before the SPA build when the candidate provides it", async () => {
    // suite green → scripts typecheck green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      scriptsTypecheckTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:tsc:scripts"]);
    expect(calls[1].opts?.cwd).toBe(scriptsTypecheckTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when root scripts typecheck reports a regression and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout: "scripts/leak-ratchet.ts(42,7): error TS2322: Type mismatch",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      scriptsTypecheckTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:tsc:scripts");
    expect(r.summary).toContain("SCRIPTS TYPECHECK FAILED");
    expect(r.summary).toContain("scripts/leak-ratchet.ts");
    // The scripts leg is a soft failure, so later cheap legs may run; the expensive SPA
    // build must still not be reached on a red post-suite leg.
    expect(calls.some((c) => c.args.includes("build"))).toBe(false);
  });

  // EI-485: lint:migrations' PG-backed unreserved-number check was never wired into any
  // automated gate (its 3 pure-fs checks got wired into the vitest suite itself,
  // lint-migrations.test.ts, EI-6843, so they already rode test:affected — only the
  // PG-backed leg was still manual-only). Mirrors the lint:tsc wiring tests above.
  it("detects the optional lint:migrations script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:migrations")).toBe(false);
    expect(hasNpmScript(migrationsLintTree, "lint:migrations")).toBe(true);
  });

  it("runs lint:migrations after a green suite, before the SPA build, when the candidate provides it", async () => {
    // suite green → lint:migrations green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      migrationsLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:migrations"]);
    expect(calls[1].opts?.cwd).toBe(migrationsLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when lint:migrations reports a violation and skips the SPA build", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "✗ migration number(s) ≥494 on disk without a reservation row (use db:next-migration): 620",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      migrationsLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:migrations");
    expect(r.summary).toContain("MIGRATION LINT FAILED");
    expect(calls).toHaveLength(2); // build NOT attempted — held before the SPA build leg
  });

  // EI-18218408212070282: design-primitives.test.ts et al. are GLOBAL source-scanning
  // lints — `test:affected` only runs them when @papercusp/web happens to be in the
  // candidate diff's affected set, so a real violation elsewhere in the tree could
  // silently ride an unrelated candidate's diff into the green pin. This leg must run
  // UNCONDITIONALLY (never gated by the affected set) so "green" reflects the whole tree.
  it("detects the optional identity-leak lint scripts without requiring them from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:no-owner-name-tags")).toBe(false);
    expect(hasNpmScript(cpTree, "lint:no-box-identity")).toBe(false);
    expect(hasNpmScript(cpTree, "lint:no-identity-literals")).toBe(false);
    expect(hasNpmScript(identityLintTree, "lint:no-owner-name-tags")).toBe(
      true,
    );
    expect(hasNpmScript(identityLintTree, "lint:no-box-identity")).toBe(true);
    expect(hasNpmScript(identityLintTree, "lint:no-identity-literals")).toBe(
      true,
    );
  });

  it("runs all 3 identity-leak lints after a green suite, before the SPA build, when the candidate provides them", async () => {
    // suite green → all 3 identity lints green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      identityLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls[1].args).toEqual(["run", "lint:no-owner-name-tags"]);
    expect(calls[2].args).toEqual(["run", "lint:no-box-identity"]);
    expect(calls[3].args).toEqual(["run", "lint:no-identity-literals"]);
    expect(calls[1].opts?.cwd).toBe(identityLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[4].cmd).toBe("git"); // conflict-marker grep
    expect(calls[5].args).toContain("build");
  });

  it("EI-18147177863084708: reports EVERY failing identity-leak lint together (not just the first) and holds before the SPA build", async () => {
    // owner-name-tags FAILS, box-identity FAILS, identity-literals passes — unlike
    // release-local.sh's `&&`-chain, all 3 must run and every failure must be visible
    // in one verdict instead of whack-a-mole across builds.
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "FOUND: [owner:Jane 2026-07-20] in packages/operator-core/lib/foo.ts",
      },
      { code: 1, stdout: "FOUND: /home/jdoe/ in some.service" },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      identityLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:identity-leak");
    expect(r.summary).toContain("OWNER-NAME TAG LINT FAILED");
    expect(r.summary).toContain("BOX-IDENTITY PATH LINT FAILED");
    expect(calls).toHaveLength(4); // all 3 lints ran (unconditional) — build NOT attempted
  });

  // WI-6056: hasNpmScript's bare `catch { return false }` used to conflate "this hive
  // legitimately has no such script" with "package.json could not be read/parsed" — a
  // corrupt/partial candidate tree (a real, reachable state: it is freshly materialised
  // on every checkpoint run) would silently skip every optional leg and still report
  // green. checkNpmScript's 'unreadable' result must instead fail the leg loudly.
  // WI-38185: the leg chain used to halt on the FIRST failing lint, so one ~55min gate run
  // could report at most ONE cheap red while every later leg recorded "not run" — measured
  // 2026-08-12 with FOUR cheap legs red at once, which would have needed >=4 sequential
  // cycles just to discover. The cheap legs must now all run and all report, exactly as the
  // identity-leak leg already does for its own three sub-lints.
  it("WI-38185: a failing cheap lint does NOT hide the next one — both run, both are named, build still skipped", async () => {
    // suite green → design-primitives FAILS → no-control-bytes FAILS (must still run).
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout: "design-primitives violation in apps/operator/app/foo.tsx",
      },
      {
        code: 1,
        stdout: "control byte U+0007 in packages/operator-core/lib/bar.ts",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      twoCheapLintTree,
      "base-sha",
    );

    expect(r.green).toBe(false);
    // BOTH legs ran — the second is the one that used to be skipped as "not run".
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "run test:related",
      "run lint:design-primitives",
      "run lint:no-control-bytes",
    ]);
    // BOTH are named in the one verdict, so the fleet can fix them in parallel.
    expect(r.failingTests).toContain("lint:design-primitives");
    expect(r.failingTests).toContain("lint:no-control-bytes");
    expect(r.summary).toContain("design-primitives violation");
    expect(r.summary).toContain("control byte");
    // …but the EXPENSIVE leg is still short-circuited: 3 calls, no SPA build.
    expect(calls).toHaveLength(3);
    expect(calls.some((c) => c.args.includes("@example/fixture-spa"))).toBe(
      false,
    );
  });

  it("WI-6056: distinguishes a corrupt/unreadable package.json from a legitimate script-absent hive", () => {
    expect(checkNpmScript(corruptPkgJsonTree, "lint:tsc")).toBe("unreadable");
    expect(checkNpmScript(cpTree, "lint:tsc")).toBe("absent"); // valid package.json, just no such script
    expect(hasNpmScript(corruptPkgJsonTree, "lint:tsc")).toBe(false); // boolean wrapper still collapses to false
  });

  it("WI-6056: a corrupt/unreadable package.json fails the gate loudly instead of silently skipping every leg", async () => {
    // suite green → the very first post-suite leg (typecheck) finds package.json
    // unreadable and must halt the whole chain as a FAILURE, never a silent skip that
    // lets an untypechecked, unlinted, unbuilt candidate ride through as green.
    const { exec, calls } = makeExec([{ code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      corruptPkgJsonTree,
      "base-sha",
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("package.json-unreadable");
    expect(r.summary).toContain("PACKAGE.JSON UNREADABLE");
    expect(calls).toHaveLength(1); // only the suite ran — every post-suite leg short-circuited, none silently skipped as green
  });

  it("detects the optional lint:design-primitives script without requiring it from subject hives", () => {
    expect(hasNpmScript(cpTree, "lint:design-primitives")).toBe(false);
    expect(
      hasNpmScript(designPrimitivesLintTree, "lint:design-primitives"),
    ).toBe(true);
  });

  it("runs lint:design-primitives after a green suite, before the SPA build, when the candidate provides it", async () => {
    // suite green → lint:design-primitives green → marker grep clean → SPA build green.
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0 },
      { code: 1 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      designPrimitivesLintTree,
      "base-sha",
    );

    expect(r.green).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1].cmd).toBe("npm");
    expect(calls[1].args).toEqual(["run", "lint:design-primitives"]);
    expect(calls[1].opts?.cwd).toBe(designPrimitivesLintTree);
    expect(calls[1].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[1].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    expect(calls[2].cmd).toBe("git");
    expect(calls[3].args).toContain("build");
  });

  it("holds the candidate when lint:design-primitives reports a violation and skips the SPA build — even though the diff never touched @papercusp/web", async () => {
    const { exec, calls } = makeExec([
      { code: 0 },
      {
        code: 1,
        stdout:
          "FAIL app/_lints/design-primitives.test.ts > blocks direct sky brand primitives",
      },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(
      designPrimitivesLintTree,
      null,
    );

    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lint:design-primitives");
    expect(r.summary).toContain("DESIGN PRIMITIVES LINT FAILED");
    expect(calls).toHaveLength(2); // build NOT attempted — held before the SPA build leg
  });

  it("green suite + clean tree + green build → green, with the stripped checkpoint env on the green command", async () => {
    // suite green → EI-1836 conflict-marker grep (code 1 = clean) → SPA build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    // (1) the green command ran in the checkpoint tree with the gate env wired.
    expect(calls[0].cmd).toBe(GREEN_CMD0);
    expect(calls[0].args).toEqual(GREEN_ARGS);
    expect(calls[0].opts?.cwd).toBe(cpTree);
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBe("base-sha");
    // (2) EI-1836: the conflict-marker grep ran second, in the same tree, before the build.
    expect(calls).toHaveLength(3);
    expect(calls[1].cmd).toBe("git");
    expect(calls[1].args).toContain("grep");
    expect(calls[1].opts?.cwd).toBe(cpTree);
    // (3) the SPA build ran third, in the same tree (P-005 — build is part of green).
    expect(calls[2].cmd).toBe("npm");
    // the BUILD COMMAND follows cfg.spaBuildWorkspace (a per-hive subject builds its own
    // SPA). Note the deliberate asymmetry with `r.failingTests` below, which stays the
    // hardcoded `@papercusp/operator-vite` sentinel: that one is the release-fixer's DEDUP
    // key (checkpointFailureSignature), not a workspace reference, so it is NOT cfg-driven.
    expect(calls[2].args).toContain("@example/fixture-spa");
    expect(calls[2].args).toContain("build");
    expect(calls[2].opts?.cwd).toBe(cpTree);
  });

  it("P-004: starts repair-round post-suite legs before the affected suite finishes", async () => {
    const events: string[] = [];
    let finishSuite!: (result: ExecResp) => void;
    const suiteResult = new Promise<ExecResp>((resolve) => {
      finishSuite = resolve;
    });
    const exec: CheckpointExec = async (cmd, args) => {
      const isSuite =
        cmd === GREEN_CMD0 &&
        args.length === GREEN_ARGS.length &&
        args.every((arg, index) => arg === GREEN_ARGS[index]);
      if (isSuite) {
        events.push("suite:start");
        const result = await suiteResult;
        events.push("suite:end");
        return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
      if (cmd === "git") {
        events.push("legs:git:start");
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd === "npm" && args.includes("build")) {
        events.push("legs:build:start");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };

    const running = realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha", {
      candidate: "c".repeat(40),
      repairVerification: true,
      affectedTestProofGroup: "repair-proof-group",
    });

    await vi.waitFor(() => expect(events).toContain("legs:git:start"));
    expect(events).toContain("suite:start");
    expect(events).not.toContain("suite:end");
    finishSuite({ code: 0 });
    const result = await running;

    expect(result.green).toBe(true);
    expect(events.indexOf("legs:git:start")).toBeLessThan(
      events.indexOf("suite:end"),
    );
    expect(events.filter((event) => event === "legs:git:start")).toHaveLength(1);
    expect(events.filter((event) => event === "legs:build:start")).toHaveLength(1);
  });

  it("P-004: preserves the suite-first barrier for an initial candidate run", async () => {
    const events: string[] = [];
    let finishSuite!: (result: ExecResp) => void;
    const suiteResult = new Promise<ExecResp>((resolve) => {
      finishSuite = resolve;
    });
    const exec: CheckpointExec = async (cmd, args) => {
      const isSuite =
        cmd === GREEN_CMD0 &&
        args.length === GREEN_ARGS.length &&
        args.every((arg, index) => arg === GREEN_ARGS[index]);
      if (isSuite) {
        events.push("suite:start");
        const result = await suiteResult;
        events.push("suite:end");
        return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
      if (cmd === "git") {
        events.push("legs:git:start");
        return { code: 1, stdout: "", stderr: "" };
      }
      if (cmd === "npm" && args.includes("build")) {
        events.push("legs:build:start");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };

    const running = realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha", {
      candidate: "c".repeat(40),
      repairVerification: false,
    });

    await vi.waitFor(() => expect(events).toContain("suite:start"));
    expect(events).toEqual(["suite:start"]);
    finishSuite({ code: 0 });
    const result = await running;

    expect(result.green).toBe(true);
    expect(events.indexOf("suite:end")).toBeLessThan(
      events.indexOf("legs:git:start"),
    );
  });

  it("P-005: green suite but FAILED SPA build → NOT green, build break in the failure signature", async () => {
    // suite green → marker grep clean (code 1) → SPA build fails (code 1).
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 1 },
      { code: 1, stdout: "vite: bundle failed" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false); // the key wiring: a passing suite does NOT make a broken build green
    expect(calls).toHaveLength(3); // marker grep + build WAS attempted (suite was green, tree clean)
    expect(calls[2].cmd).toBe("npm"); // the build ran (grep was clean)
    expect(r.failingTests).toContain("@papercusp/operator-vite"); // dedup signature folds the build break in
    expect(r.summary).toContain("vite: bundle failed");
  });

  it("EI-1836: green suite but COMMITTED conflict markers → NOT green, build SKIPPED, marker NAMED in the signature", async () => {
    // suite green → marker grep FINDS one (code 0 + named stdout) → the cryptic SPA
    // build is SKIPPED, the marker folds into the @papercusp/operator-vite signature.
    const markerHit = `app/globals.css:26492:${"<".repeat(7)} Updated upstream`;
    const { exec, calls } = makeExec([
      { code: 0 },
      { code: 0, stdout: markerHit },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(2); // suite + grep only — the build was NOT attempted
    expect(calls[1].cmd).toBe("git");
    expect(calls[1].args).toContain("grep");
    expect(r.failingTests).toContain("@papercusp/operator-vite"); // held + dedup like a build break
    expect(r.summary).toContain("globals.css"); // the root is NAMED, not a cryptic CssSyntaxError
  });

  it("red suite short-circuits — no SPA build attempted, suite failures in the signature", async () => {
    const { exec, calls } = makeExec([
      { code: 1, stdout: "FAIL lib/foo.test.ts\n" },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

    expect(r.green).toBe(false);
    expect(calls).toHaveLength(1); // build NOT attempted on a red suite
    expect(r.failingTests).toContain("lib/foo.test.ts");
  });

  it("no AFFECTED_BASE when base is null (full affected run)", async () => {
    // suite green → marker grep clean (code 1) → build (code 0).
    const { exec, calls } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(calls[0].opts?.env?.AFFECTED_BASE).toBeUndefined();
    expect(calls[0].opts?.env?.GREEN_CHECKPOINT).toBe("1");
  });

  // load-flake-isolation-2026-06-23: the real-path wiring of the isolation re-run —
  // a red suite whose failing FILES (parsed from the affected-runner output) re-run
  // GREEN at single concurrency is a load-flake, so runGreen reports green + the suspects.
  // EI-20203883939710354 — the workspace name here is DELIBERATELY FAKE; do not "fix" it
  // back to a real one. This suite drives real `runGreen`, so production narrates real log
  // lines and vitest captures them verbatim into the shared run log. WI-7274 tagged those
  // lines `[green-checkpoint:TEST-FIXTURE]`, which tells them apart ONCE YOU READ THE TAG —
  // but a triaging agent's first move is `grep <my-workspace> <log>`, and a fixture naming a
  // REAL workspace answers that grep with a perfect description of a failure that never
  // happened. Measured: an agent nearly reported one as the root cause of a fleet-blocking
  // gate red. A fake workspace makes the collision impossible instead of relying on a reader
  // parsing a marker correctly under time pressure. Every fake workspace in this file uses
  // the `@example/` scope, never `@papercusp/` — see the guard in
  // green-checkpoint-log-marker-fixtures.test.ts, which enforces exactly that.
  // The assertions echoing this name are testing a ROUND TRIP (the workspace parsed out of
  // this output is the one re-run), so they hold identically for any name.
  const RED_OUTPUT =
    ">>> @example/fixture-pkg :: npm run test\n" +
    " FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates\n" +
    " ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms\n" +
    "2 non-quarantined task(s) failed.";

  it("P-004: reuses concurrent repair legs after flake absorption instead of running them twice", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: CheckpointExec = async (cmd, args) => {
      calls.push({ cmd, args });
      const isSuite =
        cmd === GREEN_CMD0 &&
        args.length === GREEN_ARGS.length &&
        args.every((arg, index) => arg === GREEN_ARGS[index]);
      if (isSuite) return { code: 1, stdout: RED_OUTPUT, stderr: "" };
      if (cmd === "git") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "npm" && args.includes("build")) {
        return {
          code: 0,
          stdout:
            ">>> @example/fixture-post-suite :: npm run test\n" +
            " FAIL lib/post-suite-noise.test.ts > diagnostic-only\n",
          stderr: "",
        };
      }
      if (cmd === "npm" && args.includes("test")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };

    const result = await realCheckpointDeps(cfg, exec).runGreen(
      cpTree,
      "base-sha",
      {
        candidate: "c".repeat(40),
        repairVerification: true,
        affectedTestProofGroup: "repair-proof-group",
      },
    );

    expect(result.green).toBe(true);
    expect(calls.filter((call) => call.cmd === "git")).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.cmd === "npm" && call.args.includes("build"),
      ),
    ).toHaveLength(1);
    expect(
      calls.findIndex((call) => call.cmd === "git"),
    ).toBeLessThan(
      calls.findIndex(
        (call) => call.cmd === "npm" && call.args.includes("test"),
      ),
    );
    const suiteRetries = calls.filter(
      (call) => call.cmd === "npm" && call.args.includes("test"),
    );
    expect(suiteRetries).toHaveLength(3);
    expect(
      suiteRetries.every(
        (call) => !call.args.includes("lib/post-suite-noise.test.ts"),
      ),
    ).toBe(true);
  });

  it("load-flake: red suite, both failing files PASS in isolation → green + flakeSuspects, single-fork env", async () => {
    // call 0: green command (red suite). call 1: isolation re-run of file #1 (pass).
    // call 2: isolation re-run of file #2 (pass). No build runs (it only runs on a
    // suite that was green from the start: r.code === 0).
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true); // absorbed: both files passed in isolation
    expect(r.flakeSuspects).toEqual([
      "@example/fixture-pkg::lib/llm-testing/__tests__/runner-aggregate.test.ts",
      "@example/fixture-pkg::lib/scout/scheduler-workspace-scope.test.ts",
    ]);
    // WI-6053: the suite + 2 isolation re-runs + the post-suite legs the absorption now
    // pays for (cpTree declares no lint scripts, so that is the conflict-marker grep and
    // the SPA build). This assertion previously read `toHaveLength(3)` with the comment
    // "no SPA build (the suite started red)" — it was encoding the defect: an absorbed
    // candidate reached `main` having never been built or typechecked.
    // WI-6956 adds call 3: the CONFIRMING co-execution re-run that now gates absorption.
    expect(calls).toHaveLength(6);
    expect(calls[4].cmd).toBe("git"); // conflict-marker grep
    expect(calls[5].args).toContain("build"); // the SPA build DID run post-absorption
    // WI-6956: the confirming re-run puts BOTH originally-failing files in ONE npm
    // invocation and — the whole point — does NOT pass --no-file-parallelism or pin the
    // fork/thread caps, so a shared-state concurrency defect reproduces here.
    expect(calls[3].cmd).toBe("npm");
    expect(calls[3].args.slice(0, 4)).toEqual([
      "run",
      "test",
      "--workspace",
      "@example/fixture-pkg",
    ]);
    expect(calls[3].args).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
    expect(calls[3].args).toContain(
      "lib/scout/scheduler-workspace-scope.test.ts",
    );
    expect(calls[3].args).not.toContain("--no-file-parallelism");
    // It inherits the GATE's own concurrency profile rather than the isolation run's
    // forced single fork — that is precisely what makes it a co-execution experiment.
    expect(calls[3].opts?.env?.VITEST_MAX_FORKS).not.toBe("1");
    expect(calls[3].opts?.env?.VITEST_MAX_THREADS).not.toBe("1");
    expect(calls[3].opts?.env?.VITEST_MAX_FORKS).toBe(
      calls[0].opts?.env?.VITEST_MAX_FORKS,
    );
    expect(calls[3].opts?.cwd).toBe(cpTree);
    expect(calls[3].opts?.env?.GREEN_CHECKPOINT).toBe("1");
    // the isolation re-runs are `npm run test --workspace <ws> -- --no-file-parallelism <file>`
    // at SINGLE concurrency, in the checkpoint tree, with the stripped gate env.
    for (const c of calls.slice(1, 3)) {
      expect(c.cmd).toBe("npm");
      expect(c.args.slice(0, 4)).toEqual([
        "run",
        "test",
        "--workspace",
        "@example/fixture-pkg",
      ]);
      expect(c.args).toContain("--no-file-parallelism");
      expect(c.opts?.cwd).toBe(cpTree);
      expect(c.opts?.env?.VITEST_MAX_FORKS).toBe("1");
      expect(c.opts?.env?.VITEST_MAX_THREADS).toBe("1");
      expect(c.opts?.env?.GREEN_CHECKPOINT).toBe("1");
    }
    expect(calls[1].args).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
    expect(calls[2].args).toContain(
      "lib/scout/scheduler-workspace-scope.test.ts",
    );
  });

  // WI-6956 real-path recurrence guard: the concurrency-dependent class. Every file
  // passes ALONE (which is that class's DEFINING property, not evidence of flakiness),
  // but reproduces the moment they are re-run TOGETHER. Before the confirming pass this
  // exact shape absorbed to green and fast-forwarded `main` onto a broken tree.
  it("concurrency defect: files pass in isolation but REPRODUCE co-executed → stays NOT green", async () => {
    // call 0: red suite. calls 1-2: both files pass ALONE. call 3: the confirming
    // co-execution re-run FAILS — the failure reproduces when they run together.
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 0 },
      { code: 1, stdout: RED_OUTPUT },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(false); // NOT absorbed — this is a real defect, not box-weather
    expect(r.flakeSuspects ?? []).toEqual([]);
    // no post-suite leg runs: absorption never happened, so the suite is still what failed
    expect(calls).toHaveLength(4);
  });

  it("real break: red suite where ONE file still fails in isolation → stays NOT green", async () => {
    // call 0: red suite. call 1: file #1 re-run PASSES. call 2: file #2 re-run FAILS —
    // and because a DETERMINISTIC break re-fails on EVERY attempt, call 3 is file #2's
    // ISOLATION_RETRY_MAX(=1) retry, which must ALSO fail (isolation-retry-resilience /
    // EI-15849). Without scripting the retry result the exhausted-queue default ({code:0})
    // would let file #2's retry "pass", masking the real break as an absorbed load-flake.
    // EI-18104902318285612: that retry is gated behind a REAL ISOLATION_RETRY_DELAY_MS
    // (5s) setTimeout unless a sleep seam is injected — inject a no-op so this stays a
    // fast, hermetic unit test with zero host-load timing correlation.
    const { exec } = makeExec([
      { code: 1, stdout: RED_OUTPUT },
      { code: 0 },
      { code: 1 },
      { code: 1 },
    ]);
    const r = await realCheckpointDeps(cfg, exec, undefined, {
      sleep: async () => {},
    }).runGreen(cpTree, null);

    expect(r.green).toBe(false); // a real deterministic break is NEVER hidden
    expect(r.flakeSuspects).toBeUndefined();
    // the suite signature still names the failing files (from the FAIL row) for the
    // release-fixer dedup — extractFailingTests reads `FAIL <file>` + `>>> <ws> FAILED`.
    expect(r.failingTests).toContain(
      "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    );
  });

  it("fail-safe: an isolation re-run that THROWS leaves the gate red (no false green)", async () => {
    // A red suite with one parseable failing file; the isolation exec throws — on every
    // attempt, so this also drives the ISOLATION_RETRY_MAX(=1) retry path (EI-18104902318285612):
    // inject a no-op sleep so the retry's real ISOLATION_RETRY_DELAY_MS wait never fires.
    let i = 0;
    const throwingExec: CheckpointExec = async (cmd, _args, _opts) => {
      i++;
      if (i === 1)
        return {
          code: 1,
          stdout:
            ">>> @example/fixture-x :: npm run test\n FAIL  lib/a.test.ts > c",
          stderr: "",
        };
      throw new Error("vitest spawn ENOMEM"); // the isolation re-run itself errors
    };
    const r = await realCheckpointDeps(cfg, throwingExec, undefined, {
      sleep: async () => {},
    }).runGreen(cpTree, null);
    expect(r.green).toBe(false);
    expect(r.flakeSuspects).toBeUndefined();
  });

  // WI-806: a vitest WORKER-POOL crash (a fork OOM under fleet load) emits NO per-file
  // FAIL lines, so the per-file isolation absorber finds nothing. The workspace re-run at
  // reduced concurrency decides load-crash flake vs real break.
  const CRASH_OUTPUT =
    ">>> @example/fixture-pkg :: npm run test\n" +
    "Error: [vitest-pool]: Worker forks emitted error.\n" +
    "Caused by: Error: Worker exited unexpectedly\n" +
    "npm error workspace @example/fixture-pkg@0.1.0\n" +
    "npm error command sh -c vitest run --passWithNoTests\n" +
    "1 non-quarantined task(s) failed.";

  it("worker-crash: pool crash, zero per-file FAILs, workspace re-run PASSES → green + flakeSuspect, single-fork env", async () => {
    // call 0: green command crashes the pool (no FAIL files). call 1: workspace re-run passes.
    const { exec, calls } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 0 },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true); // absorbed: the crashed workspace passed on the re-run
    expect(r.flakeSuspects).toEqual([
      "@example/fixture-pkg (worker-pool crash)",
    ]);
    // WI-6053: the suite + 1 workspace re-run + the post-suite legs the absorption now pays
    // for (marker grep + SPA build). Previously `toHaveLength(2)` — the worker-crash
    // absorber had the identical hole, so a pool-crash candidate was also fast-forwarded
    // with its build and typecheck never run.
    expect(calls).toHaveLength(4);
    expect(calls[2].cmd).toBe("git"); // conflict-marker grep
    expect(calls[3].args).toContain("build"); // the SPA build DID run post-absorption
    const rerun = calls[1];
    expect(rerun.cmd).toBe("npm");
    // EI-19332206710686203 added the explicit per-test deadline (and the `--` separator this
    // argv previously had no need for) — see the RESCUE_TEST_TIMEOUT_MS guards below.
    expect(rerun.args).toEqual([
      "run",
      "test",
      "--workspace",
      "@example/fixture-pkg",
      "--",
      `--testTimeout=${RESCUE_TEST_TIMEOUT_MS}`,
    ]);
    expect(rerun.opts?.cwd).toBe(cpTree);
    expect(rerun.opts?.env?.VITEST_MAX_FORKS).toBe("1"); // reduced concurrency
    expect(rerun.opts?.env?.VITEST_MAX_THREADS).toBe("1");
    expect(rerun.opts?.env?.GREEN_CHECKPOINT).toBe("1");
  });

  it("worker-crash: re-run STILL crashes the pool → stays NOT green (never blanket-green a crash)", async () => {
    const { exec } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 1, stdout: CRASH_OUTPUT },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(r.green).toBe(false);
    expect(r.flakeSuspects).toBeUndefined();
  });

  it("worker-crash: re-run reveals a REAL failure → stays NOT green", async () => {
    const realFail =
      ">>> @example/fixture-pkg :: npm run test\n FAIL  lib/x.test.ts > c\nAssertionError";
    const { exec } = makeExec([
      { code: 1, stdout: CRASH_OUTPUT },
      { code: 1, stdout: realFail },
    ]);
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);
    expect(r.green).toBe(false);
  });

  // ── WI-10000085 ────────────────────────────────────────────────────────────
  // The RUNNER (scripts/affected-tests.mjs, HARDEN-GATE) can absorb a flake itself: it
  // re-runs the failed file in a fresh process and, when that passes, exits 0 with
  // `AFFECTED_TESTS_RESULT status=passed`. The suite then COMPLETED, so the gate's own
  // absorber never runs and `suiteAbsorbed` stays false — yet the raw output still carries
  // the first-pass `FAIL <file>` rows and the `>>> <ws> FAILED — fresh-process re-run` bullet,
  // and the runner's canonical AFFECTED_TESTS_FAILING_FILES line is emitted only on a FAILED
  // exit. Measured 2026-09-06 (runs f3a2f1f2 and 3ce52b07 on the frozen 50ed2739 lineage): a
  // `status=passed tasks=67 failed=0` suite with su-render-baseline.test.ts absorbed, a red
  // lint leg — and GATE_HELD_BY listed the absorbed file and @papercusp/operator-core beside
  // the leg. The signature must be scored against the LEGS alone, exactly as WI-6053 below
  // already does for a gate-absorbed suite.
  describe("WI-10000085: a RUNNER-absorbed green suite contributes nothing to a leg-red signature", () => {
    // Modelled on the real runner output of run 3ce52b07 (stdout, then the stderr bullets):
    // first-pass failure rows, the terminal PASSED verdict, then the absorption narration.
    const RUNNER_ABSORBED_OUTPUT =
      ">>> @example/fixture-pkg :: npm run test\n" +
      " FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates\n" +
      " ❯ lib/llm-testing/__tests__/runner-aggregate.test.ts (8 tests | 1 failed) 204ms\n" +
      "AFFECTED_TESTS_RESULT status=passed tasks=1 failed=0 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0\n" +
      ">>> @example/fixture-pkg FAILED — fresh-process re-run of 1 of 1 failed file(s) (HARDEN-GATE flake absorption): lib/llm-testing/__tests__/runner-aggregate.test.ts\n" +
      ">>> @example/fixture-pkg failed files passed in a fresh process — counted as a FLAKE, not a failure.\n";

    it("CALIBRATION: the fixture IS the hazardous shape — scraped alone, it names the absorbed file and its workspace", () => {
      // If this ever stops holding, the test below passes vacuously and guards nothing.
      const scraped = extractFailingTests(RUNNER_ABSORBED_OUTPUT);
      expect(scraped).toContain(
        "lib/llm-testing/__tests__/runner-aggregate.test.ts",
      );
      expect(scraped).toContain("@example/fixture-pkg");
    });

    it("runner-absorbed green suite (exit 0) → FAILING typecheck → RED attributed to the LEG only; the absorbed file and its workspace stay out of failingTests and failingFiles", async () => {
      // call 0: the suite exits 0 (the runner absorbed the flake itself). call 1: the
      // typecheck leg FAILS. No gate-side isolation re-run happens — the suite completed.
      const { exec, calls } = makeExec([
        { code: 0, stdout: RUNNER_ABSORBED_OUTPUT },
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        null,
      );

      expect(r.green).toBe(false);
      expect(r.failingTests).toEqual(["lint:tsc"]);
      expect(r.failingTests).not.toContain(
        "lib/llm-testing/__tests__/runner-aggregate.test.ts",
      );
      expect(r.failingTests).not.toContain("@example/fixture-pkg");
      // The stale-candidate re-triage reads failingFiles: an absorbed file here would be
      // re-run at tip, found passing (absorption already proved that), and the leg red
      // declared STALE — a second false-green path for a real typecheck failure.
      expect(r.failingFiles ?? []).toEqual([]);
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toEqual(["run", "lint:tsc"]);
    });

    it("CONTROL: the same runner-absorbed green suite with all legs PASSING is simply green", async () => {
      // call 0: suite exit 0. call 1: lint:tsc green. call 2: conflict-marker grep clean
      // (code 1). call 3: SPA build green.
      const { exec, calls } = makeExec([
        { code: 0, stdout: RUNNER_ABSORBED_OUTPUT },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        "base-sha",
      );
      expect(r.green).toBe(true);
      expect(r.failingTests ?? []).toEqual([]);
      expect(calls).toHaveLength(4);
    });
  });

  // ── WI-6053 ────────────────────────────────────────────────────────────────
  // Every post-suite leg (typecheck, the 3 identity lints, lint:migrations,
  // lint:design-primitives, the SPA build) used to be gated on `r.code === 0` while its
  // `*Ok` flag DEFAULTED TO `true`. So on a red suite they all skipped and stayed
  // "passed", and flake-absorption then set `green = true` without re-running or
  // re-checking any of them: an absorbed-green candidate was fast-forwarded to `main`
  // with five legs merely ASSUMED. That is how afdbda332b's operator-core type errors
  // reached `main` (2026-07-26). An absorbed-green candidate must clear the SAME bar as
  // a natively-green one — "never ran" must never render as "passed".
  describe("WI-6053: an absorbed-green candidate must still clear every post-suite leg", () => {
    it("red suite → absorbed → FAILING typecheck still comes out RED (the leg runs after absorption)", async () => {
      // call 0: suite red. calls 1-2: both files pass in isolation. call 3 (WI-6956):
      // the confirming co-execution re-run PASSES too → genuine weather → absorbed.
      // call 4: the typecheck leg — which previously never ran at all — FAILS.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        "base-sha",
      );

      expect(r.green).toBe(false); // the whole point: absorption is not a bypass
      expect(r.failingTests).toContain("lint:tsc");
      expect(r.summary).toContain("TYPECHECK FAILED");
      // the leg genuinely EXECUTED post-absorption (not merely assumed), in the
      // candidate tree, with the stripped gate env.
      expect(calls).toHaveLength(5);
      expect(calls[4].cmd).toBe("npm");
      expect(calls[4].args).toEqual(["run", "lint:tsc"]);
      expect(calls[4].opts?.cwd).toBe(typecheckTree);
      expect(calls[4].opts?.env?.GREEN_CHECKPOINT).toBe("1");
      // ...and the SPA build is still skipped behind the failing leg.
    });

    it("the post-absorption red is attributed to the LEG, not to the absorbed flake files (else the tip re-triage clears it as STALE)", async () => {
      // Compounding hazard: runGreen's `failingFiles` drives the stale-candidate
      // re-triage (green-checkpoint.ts :2043) — it re-runs those files at tip and, if
      // they pass, declares the red STALE and re-fires green. The absorbed files pass
      // BY DEFINITION (that is what absorption proved), so leaking them here would hand
      // the typecheck red a second false-green path straight to `main`.
      const { exec } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 }, // WI-6956: confirming co-execution re-run passes → absorbed
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        null,
      );

      expect(r.green).toBe(false);
      expect(r.failingFiles ?? []).toEqual([]); // no test file is failing — the LEG is
      expect(r.failingTests).toEqual(["lint:tsc"]);
      expect(r.failingTests).not.toContain(
        "lib/llm-testing/__tests__/runner-aggregate.test.ts",
      );
    });

    it("red suite → absorbed → all legs PASS → green, with the legs actually run and the flake suspects preserved", async () => {
      // Guards the opposite failure: the fix must not turn every absorbed candidate red,
      // and must not disable flake absorption (it exists for real 8-fork load flakes).
      // call 0: red suite. 1-2: isolation passes. 3 (WI-6956): confirming co-execution
      // re-run passes → absorbed. 4: lint:tsc green. 5: conflict-marker grep clean
      // (code 1). 6: SPA build green.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 1 },
        { code: 0 },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        "base-sha",
      );

      expect(r.green).toBe(true);
      expect(r.flakeSuspects).toEqual([
        "@example/fixture-pkg::lib/llm-testing/__tests__/runner-aggregate.test.ts",
        "@example/fixture-pkg::lib/scout/scheduler-workspace-scope.test.ts",
      ]);
      expect(calls).toHaveLength(7);
      expect(calls[4].args).toEqual(["run", "lint:tsc"]);
      expect(calls[5].cmd).toBe("git"); // marker grep
      expect(calls[6].args).toContain("build"); // the SPA build DID run
    });

    it("red suite → absorbed → FAILING SPA build still comes out RED", async () => {
      // The build is the leg the original comment explicitly assumed safe ("the build
      // only runs on a green suite, so buildOk is still true here") — which is exactly
      // why an absorbed candidate shipped with it never having been built.
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 },
        { code: 0 },
        { code: 0 }, // WI-6956: confirming co-execution re-run passes → absorbed
        { code: 1 }, // marker grep clean
        { code: 1, stdout: "vite: bundle failed" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, null);

      expect(r.green).toBe(false);
      expect(r.failingTests).toContain("@papercusp/operator-vite");
      expect(r.summary).toContain("vite: bundle failed");
      expect(calls).toHaveLength(6);
    });

    it("worker-crash absorption takes the same path: crash absorbed → FAILING typecheck still RED", async () => {
      // The second absorber (green-checkpoint.ts :2783) had an identical hole.
      const { exec, calls } = makeExec([
        { code: 1, stdout: CRASH_OUTPUT },
        { code: 0 }, // workspace re-run passes → absorbed
        { code: 1, stdout: "operator-core/lib/broken.ts: TS2322" },
      ]);
      const r = await realCheckpointDeps(cfg, exec).runGreen(
        typecheckTree,
        null,
      );

      expect(r.green).toBe(false);
      expect(r.failingTests).toContain("lint:tsc");
      expect(calls).toHaveLength(3);
      expect(calls[2].args).toEqual(["run", "lint:tsc"]);
    });

    it("a NON-absorbed red suite still short-circuits — no leg is run on a genuinely red suite", async () => {
      // The legs are the price of claiming green; a red that stays red must not pay it
      // (a full typecheck + 3 lints + an SPA build on every red tick is real gate time).
      const { exec, calls } = makeExec([
        { code: 1, stdout: RED_OUTPUT },
        { code: 0 }, // file #1 passes
        { code: 1 }, // file #2 still fails → NOT absorbed
        { code: 1 }, // ...and its ISOLATION_RETRY_MAX retry fails too
      ]);
      const r = await realCheckpointDeps(cfg, exec, undefined, {
        sleep: async () => {},
      }).runGreen(typecheckTree, null);

      expect(r.green).toBe(false);
      expect(r.failingTests).not.toContain("lint:tsc"); // never ran ⇒ never reported as failed
      expect(calls).toHaveLength(4); // suite + 2 isolation runs + 1 retry — no legs
    });
  });
});

describe("realCheckpointDeps.setupTree / push — real-path wiring (gap #10)", () => {
  const generationId = FIXTURE_DEPENDENCY_GENERATION_ID;

  it("P-004: consumes an exact persisted ready marker after only the cheap candidate-input probe", async () => {
    const candidate = "a".repeat(40);
    const inputFingerprint = "b".repeat(64);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const exec: CheckpointExec = async (cmd, args) => {
      calls.push({ cmd, args });
      expect(args).toContain("--fingerprint-ref");
      expect(args).not.toContain("--ensure-ref");
      return {
        code: 0,
        stdout:
          `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} ` +
          `input=${inputFingerprint}\n`,
        stderr: "",
      };
    };
    const log = vi.fn();
    const selected = await selectPersistedCheckpointDependencyGeneration(
      cfg,
      candidate,
      exec,
      {
        target: { workspaceId: "ws-1", installSlug: "papercusp" },
        waitMs: 1,
        log,
        env: {},
        generationPresent: () => true,
        liveToken: () => FIXTURE_DEPENDENCY_GENERATION_TOKEN,
        awaitState: async () => ({
          schema: 1,
          status: "ready",
          key: `${candidate}:${inputFingerprint}`,
          candidate,
          inputFingerprint,
          attemptId: "attempt-ready",
          queuedAtMs: 1,
          startedAtMs: 2,
          updatedAtMs: 3,
          completedAtMs: 3,
          producerPid: 4,
          childPid: 5,
          identity: generationId,
          token: FIXTURE_DEPENDENCY_GENERATION_TOKEN,
          reused: true,
        }),
      },
    );

    expect(calls).toHaveLength(1);
    expect(selected).toEqual({
      candidate,
      identity: generationId,
      token: FIXTURE_DEPENDENCY_GENERATION_TOKEN,
      inputFingerprint,
      reused: true,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("dependency-prebuild READY"),
    );
  });

  describe("WI-10004797: a persisted marker is only usable inside the generation store setup will lease from", () => {
    const candidate = "f".repeat(40);
    const inputFingerprint = "1".repeat(64);
    const exec: CheckpointExec = async () => ({
      code: 0,
      stdout:
        `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} ` +
        `input=${inputFingerprint}\n`,
      stderr: "",
    });
    const readyState = (generationRoot?: string) => ({
      schema: 1 as const,
      status: "ready" as const,
      key: `${candidate}:${inputFingerprint}`,
      candidate,
      inputFingerprint,
      attemptId: "attempt-root",
      queuedAtMs: 1,
      startedAtMs: 2,
      updatedAtMs: 3,
      completedAtMs: 3,
      producerPid: 4,
      childPid: 5,
      identity: generationId,
      token: FIXTURE_DEPENDENCY_GENERATION_TOKEN,
      reused: true,
      ...(generationRoot ? { generationRoot } : {}),
    });
    const select = (
      state: ReturnType<typeof readyState>,
      env: NodeJS.ProcessEnv,
      present: (root: string, identity: string) => boolean,
      log: (message: string) => void = () => {},
      liveToken: (root: string, identity: string, expected: string) => string | null = () =>
        FIXTURE_DEPENDENCY_GENERATION_TOKEN,
    ) =>
      selectPersistedCheckpointDependencyGeneration(cfg, candidate, exec, {
        target: { workspaceId: "ws-1", installSlug: "papercusp" },
        waitMs: 1,
        log,
        env,
        generationPresent: present,
        liveToken,
        awaitState: async () => state,
      });

    it("WI-10004826: a legacy marker whose identity was REPUBLISHED in the effective store (stale token) is a miss, not an exit-74 handoff", async () => {
      const log = vi.fn();
      const liveToken = vi.fn(() => "66304:2684359471:1790851625:147|66304:2684359477:1790851625:708");
      const selected = await select(
        readyState(),
        { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: "/mnt/data/gens" },
        () => true,
        log,
        liveToken,
      );
      expect(selected).toBeNull();
      expect(liveToken).toHaveBeenCalledWith("/mnt/data/gens", generationId, FIXTURE_DEPENDENCY_GENERATION_TOKEN);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("token is stale"));
    });

    it("WI-10004826: an unreadable live token is a miss", async () => {
      const selected = await select(readyState(), { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: "/mnt/data/gens" }, () => true, () => {}, () => null);
      expect(selected).toBeNull();
    });

    it("WI-10004826: liveDependencyGenerationToken matches the shell's `stat -c %d:%i:%Y:%s` token and the v2 publication_token field", () => {
      const root = mkdtempSync(join(tmpdir(), "dep-gen-token-"));
      try {
        const id = `v1-${"a".repeat(64)}`;
        const generation = join(root, id);
        mkdirSync(generation);
        expect(liveDependencyGenerationToken(root, id, "legacy")).toMatch(/^\d+:\d+:\d+:\d+\|missing$/);
        const marker = join(generation, ".papercusp-dependency-generation");
        writeFileSync(marker, `identity=${id}\npublication_token=v2:abc123\n`);
        const shell = spawnSync(
          "bash",
          ["-c", 'printf "%s|%s" "$(stat -c %d:%i:%Y:%s "$1")" "$(stat -c %d:%i:%Y:%s "$2")"', "_", generation, marker],
          { encoding: "utf8" },
        ).stdout;
        expect(liveDependencyGenerationToken(root, id, "legacy")).toBe(shell);
        expect(liveDependencyGenerationToken(root, id, "v2:old")).toBe("v2:abc123");
        expect(liveDependencyGenerationToken(root, `v1-${"b".repeat(64)}`, "legacy")).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("a marker published into the OLD root is a miss after PAPERCUSP_DEPENDENCY_GENERATION_ROOT moves (no exit-74 handoff)", async () => {
      const log = vi.fn();
      const present = vi.fn(() => true);
      const selected = await select(
        readyState("/old/store/dependency-generations"),
        { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: "/mnt/data/papercusp-dependency-generations" },
        present,
        log,
      );
      expect(selected).toBeNull();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          "effective generation_root=/mnt/data/papercusp-dependency-generations",
        ),
      );
    });

    it("a legacy marker with no recorded root is a miss when its identity is absent from the effective store", async () => {
      const present = vi.fn(() => false);
      const selected = await select(
        readyState(),
        { PAPERCUSP_DEPENDENCY_GENERATION_ROOT: "/mnt/data/gens" },
        present,
      );
      expect(selected).toBeNull();
      expect(present).toHaveBeenCalledWith("/mnt/data/gens", generationId);
    });

    it("a marker whose recorded root equals the effective (default) root and is present is consumed", async () => {
      const effective = join(cfg.integrationRoot, ".papercusp/dependency-generations");
      const present = vi.fn(() => true);
      const selected = await select(readyState(effective), {}, present);
      expect(selected).toMatchObject({ identity: generationId, reused: true });
      expect(present).toHaveBeenCalledWith(effective, generationId);
    });
  });

  it("P-004: a mismatched persisted marker is never accepted as the candidate's dependency proof", async () => {
    const candidate = "c".repeat(40);
    const otherCandidate = "d".repeat(40);
    const inputFingerprint = "e".repeat(64);
    const exec: CheckpointExec = async () => ({
      code: 0,
      stdout:
        `DEPENDENCY_INPUT_FINGERPRINT schema=1 candidate=${candidate} ` +
        `input=${inputFingerprint}\n`,
      stderr: "",
    });

    const selected = await selectPersistedCheckpointDependencyGeneration(
      cfg,
      candidate,
      exec,
      {
        target: { workspaceId: "ws-1", installSlug: "papercusp" },
        log: () => {},
        awaitState: async () => ({
          schema: 1,
          status: "ready",
          key: `${otherCandidate}:${inputFingerprint}`,
          candidate: otherCandidate,
          inputFingerprint,
          attemptId: "attempt-other",
          queuedAtMs: 1,
          startedAtMs: 2,
          updatedAtMs: 3,
          completedAtMs: 3,
          producerPid: 4,
          childPid: 5,
          identity: generationId,
          token: FIXTURE_DEPENDENCY_GENERATION_TOKEN,
          reused: true,
        }),
      },
    );

    expect(selected).toBeNull();
  });

  it("D-081: the pre-lock exact-candidate producer transports its selector/token into setup without an in-lock reselect", async () => {
    const candidate = "a".repeat(40);
    const inputFingerprint = "b".repeat(64);
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let checkpointLockAcquired = false;
    const exec: CheckpointExec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes("--ensure-ref")) {
        expect(checkpointLockAcquired).toBe(false);
        return {
          code: 0,
          stdout:
            `DEPENDENCY_GENERATION_RESULT schema=1 identity=${generationId} ` +
            `source=fixture input=${inputFingerprint} scope=full reused=false ` +
            `token=${FIXTURE_DEPENDENCY_GENERATION_TOKEN} path=/fixture/${generationId}`,
          stderr: "",
        };
      }
      expect(checkpointLockAcquired).toBe(true);
      expect(args).not.toContain("--select-inputs-from");
      return {
        code: 0,
        stdout: `[setup-release] DEPENDENCY_GENERATION_PIN identity=${generationId}`,
        stderr: "",
      };
    };

    const prewarmed = await ensureCheckpointDependencyGeneration(
      cfg,
      candidate,
      exec,
    );
    checkpointLockAcquired = true;
    const setup = await realCheckpointDeps(
      cfg,
      exec,
      undefined,
      undefined,
      undefined,
      undefined,
      prewarmed,
    ).setupTree(candidate, { preparedSource: true });

    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(
      expect.arrayContaining(["--ensure-ref", candidate]),
    );
    // WI-6554700010008481: the prewarm pins the candidate's generation so newer
    // staging prebuilds cannot evict it before the run selects it.
    const retainAt = calls[0].args.indexOf("--retain-as");
    expect(retainAt).toBeGreaterThan(-1);
    expect(calls[0].args[retainAt + 1]).toBe(CHECKPOINT_DEPENDENCY_RETAIN_LABEL);
    expect(calls[1].args).toEqual(
      expect.arrayContaining([
        "--node-modules-generation-id",
        generationId,
        "--node-modules-generation-token",
        FIXTURE_DEPENDENCY_GENERATION_TOKEN,
      ]),
    );
    expect(setup).toMatchObject({
      identity: `setup-release-checkout:${candidate}:deps=${generationId}`,
    });
  });

  it("D-033: a REUSED generation materializes on a shared slot — no --exclusive-all-slots; a fresh publish keeps the exclusive barrier", async () => {
    // WI-42329: unconditional --exclusive-all-slots serialized 21 pots' hourly gates
    // behind one host-wide lock (3 acquired / 16 starved-after-900s over 40 runs) and
    // froze `main` for 6 days. Reuse of an already-published immutable generation is a
    // hardlink copy into this run's private root — parallel-safe, so it must NOT demand
    // the whole-box barrier. A fresh publish keeps it (conservative path).
    const candidate = "c".repeat(40);
    const inputFingerprint = "d".repeat(64);
    const makeDepsExec = (reused: boolean) => {
      const calls: Array<{
        cmd: string;
        args: string[];
        opts?: Parameters<CheckpointExec>[2];
      }> = [];
      const exec: CheckpointExec = async (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        if (args.includes("--ensure-ref")) {
          return {
            code: 0,
            stdout:
              `DEPENDENCY_GENERATION_RESULT schema=1 identity=${generationId} ` +
              `source=fixture input=${inputFingerprint} scope=full reused=${reused} ` +
              `token=${FIXTURE_DEPENDENCY_GENERATION_TOKEN} path=/fixture/${generationId}`,
            stderr: "",
          };
        }
        return {
          code: 0,
          stdout: `[setup-release] DEPENDENCY_GENERATION_PIN identity=${generationId}`,
          stderr: "",
        };
      };
      return { exec, calls };
    };

    // reused=true → shared-slot materialization.
    const shared = makeDepsExec(true);
    const sharedPrewarmed = await ensureCheckpointDependencyGeneration(
      cfg,
      candidate,
      shared.exec,
    );
    expect(sharedPrewarmed.reused).toBe(true);
    await realCheckpointDeps(
      cfg,
      shared.exec,
      undefined,
      undefined,
      undefined,
      undefined,
      sharedPrewarmed,
    ).setupTree(candidate, { preparedSource: true });
    const sharedSetup = shared.calls[1];
    expect(sharedSetup.args).not.toContain("--exclusive-all-slots");
    expect(sharedSetup.args).toEqual(
      expect.arrayContaining(["--node-modules-generation-id", generationId]),
    );
    expect(sharedSetup.opts?.env?.PC_HEAVY_COALESCE).toBe("0");

    // reused=false → the exclusive barrier is preserved.
    const exclusive = makeDepsExec(false);
    const exclusivePrewarmed = await ensureCheckpointDependencyGeneration(
      cfg,
      candidate,
      exclusive.exec,
    );
    expect(exclusivePrewarmed.reused).toBe(false);
    await realCheckpointDeps(
      cfg,
      exclusive.exec,
      undefined,
      undefined,
      undefined,
      undefined,
      exclusivePrewarmed,
    ).setupTree(candidate, { preparedSource: true });
    const exclusiveSetup = exclusive.calls[1];
    expect(exclusiveSetup.args).toContain("--exclusive-all-slots");
    expect(exclusiveSetup.opts?.env?.PC_HEAVY_COALESCE).toBe("0");
  });

  it("WI-10004108: an absent configured integration branch is a typed not-applicable preflight", async () => {
    const root = mkdtempSync(join(tmpdir(), "green-cp-missing-integration-ref-"));
    const integration = join(root, "integration");
    mkdirSync(integration, { recursive: true });
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", integration, ...args], {
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
      return result.stdout.trim();
    };

    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      writeFileSync(join(integration, "README.md"), "valid repository without staging\n");
      git("add", "README.md");
      git("commit", "-qm", "initial commit");
      const cfg = releaseConfig({
        integrationRoot: integration,
        releaseRoot: join(root, "release"),
        checkpointRoot: join(root, "checkpoint"),
        checkpointLogDir: join(root, "logs"),
        integrationBranch: "staging",
        releaseRef: "main",
      });

      const result = await beginCheckpointPreflight(cfg, "staging", runCmd);
      expect(result.kind).toBe("not-applicable");
      if (result.kind !== "not-applicable") {
        throw new Error("expected missing configured branch to be not-applicable");
      }
      expect(result.integrationRef).toBe("staging");
      expect(result.summary).toMatch(/not applicable/i);
      expect(existsSync(checkpointRunLockDir(join(root, "logs"), integration))).toBe(false);

      const invalidRoot = join(root, "not-a-git-repository");
      mkdirSync(invalidRoot);
      const invalidCfg = releaseConfig({
        integrationRoot: invalidRoot,
        releaseRoot: join(root, "invalid-release"),
        checkpointRoot: join(root, "invalid-checkpoint"),
        checkpointLogDir: join(root, "invalid-logs"),
        integrationBranch: "staging",
        releaseRef: "main",
      });
      await expect(
        beginCheckpointPreflight(invalidCfg, "staging", runCmd),
      ).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("D-081 joined guard: unseen exact inputs traverse the real prelock publisher and materializer to a normal candidate-bound verdict", async () => {
    // This test deliberately drives the REAL dependency-generation prewarm (that is the
    // whole point of the "unseen exact inputs" path). green-checkpoint.ts routes every
    // line of that subprocess's output — stdout included — to console.error ON PURPOSE:
    // the orchestrator's stdout is reserved for machine-parsed markers, so narration is
    // kept off it. The suite's fail-on-console would otherwise fail this test on that
    // expected progress narration (37 stderr + 1 stdout lines in a measured run), which
    // is exactly what it did. Swallow it for this test only; every assertion below still
    // validates behavior. Restored via onTestFinished because this repo configures no
    // restoreMocks, so a bare spy would leak into sibling tests.
    //
    // NARROWED, NOT DISABLED: only the prewarm narration is swallowed. Anything else is
    // forwarded to the captured console.error — which is fail-on-console's own wrapper,
    // since it installs before this spy — so a genuine unexpected error still fails the
    // test. A blanket mockImplementation(() => {}) would have silently hidden one.
    const forwardConsoleError = console.error.bind(console);
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const first = typeof args[0] === "string" ? args[0] : "";
        if (/ dependency-prewarm (stdout|stderr): /.test(first)) return;
        forwardConsoleError(...args);
      });
    onTestFinished(() => consoleErrorSpy.mockRestore());
    const root = mkdtempSync(join(tmpdir(), "green-cp-d081-joined-"));
    const integration = join(root, "integration");
    const checkpoint = join(root, "checkpoint");
    const logDir = join(root, "logs");
    // This test exercises the REAL exclusive materializer, but it must not join the
    // host-wide production queue: an unrelated release writer can legitimately hold
    // that lock longer than this test's 120s correctness deadline. A private pc-heavy
    // domain preserves the real writer/slot protocol while making the fixture
    // deterministic and preventing ambient fleet work from deciding its verdict.
    const pcHeavyDir = join(root, "pc-heavy");
    mkdirSync(join(integration, "node_modules", "fixture-dep"), {
      recursive: true,
    });
    writeFileSync(
      join(integration, "node_modules", "fixture-dep", "index.js"),
      "module.exports = 'joined';\n",
    );
    writeFileSync(
      join(integration, "node_modules", "fixture-dep", "package.json"),
      JSON.stringify({ name: "fixture-dep", version: "1.0.0" }),
    );
    writeFileSync(
      join(integration, "package.json"),
      JSON.stringify({ name: "d081-joined-fixture", private: true }),
    );
    writeFileSync(
      join(integration, "package-lock.json"),
      '{"name":"d081-joined-fixture","lockfileVersion":3,"packages":{}}\n',
    );
    const git = (...args: string[]): string => {
      const result = spawnSync("git", args, {
        cwd: integration,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
        );
      }
      return result.stdout.trim();
    };

    let lock: ReturnType<typeof acquireCheckpointRunLock> | undefined;
    const priorAfterCopyHook =
      process.env.DEPENDENCY_GENERATION_AFTER_COPY_HOOK;
    const priorPcHeavyDir = process.env.PC_HEAVY_DIR;
    try {
      process.env.PC_HEAVY_DIR = pcHeavyDir;
      git("init", "-q", "-b", "staging");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "fixture");
      git("add", "package.json", "package-lock.json");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      git("branch", "main", base);
      writeFileSync(
        join(integration, "package-lock.json"),
        '{"name":"d081-joined-fixture","lockfileVersion":3,"packages":{"node_modules/fixture-dep":{"version":"1.0.0"}}}\n',
      );
      writeFileSync(
        join(integration, "node_modules", "fixture-dep", "index.js"),
        "module.exports = 'joined-v2';\n",
      );
      git("add", "package-lock.json");
      git("commit", "-qm", "candidate with unseen dependency inputs");
      const candidate = git("rev-parse", "HEAD");
      const joinedCfg = releaseConfig({
        integrationRoot: integration,
        releaseRoot: integration,
        checkpointRoot: checkpoint,
        checkpointLogDir: logDir,
        integrationBranch: "staging",
        releaseRef: "main",
      });
      const lockDir = checkpointRunLockDir(logDir, integration);
      expect(existsSync(lockDir)).toBe(false);
      // Check the real publisher's lock/tree contract before its expensive copy.
      // A directory with only index.js is not an installed package: the audit
      // requires package.json at the locked version.
      const { auditTree } = await import("../../bin/release/dependency-lock-tree-audit.mjs");
      const assertInstalledFixture = () => expect(auditTree({
        treeRoot: integration, lockRoot: integration, lockfiles: ["package-lock.json"],
      }).defects).toEqual([]);
      assertInstalledFixture();

      // NEGATIVE: a live tree whose lockfiles drifted past the exact commit may
      // publish its OWN key, but it cannot conjure the candidate's selector and
      // must fail before the checkpoint serializer exists.
      writeFileSync(
        join(integration, "package-lock.json"),
        '{"name":"d081-joined-fixture","lockfileVersion":3,"packages":{"node_modules/live-drift":{}}}\n',
      );
      await expect(
        beginCheckpointPreflight(joinedCfg, candidate, runCmd),
      ).rejects.toThrow(/no prewarmed dependency generation/i);
      expect(existsSync(lockDir)).toBe(false);
      writeFileSync(
        join(integration, "package-lock.json"),
        '{"name":"d081-joined-fixture","lockfileVersion":3,"packages":{"node_modules/fixture-dep":{"version":"1.0.0"}}}\n',
      );
      writeFileSync(
        join(integration, "node_modules", "fixture-dep", "index.js"),
        "module.exports = 'joined-v3';\n",
      );
      assertInstalledFixture();

      // NEGATIVE / ordering control: the publisher's real after-copy hook runs
      // while the selector is still unseen. If acquireCheckpointRunLock moves
      // above publication, this hook makes the test fail inside the publisher.
      const prelockTrace = join(root, "publisher-ran-before-lock");
      process.env.DEPENDENCY_GENERATION_AFTER_COPY_HOOK = `test ! -e ${JSON.stringify(lockDir)} && printf prelock > ${JSON.stringify(prelockTrace)}`;

      // The actual install-mutex wrapper + dependency-generation.sh run here.
      // With no selector on disk, this must publish/index the exact committed
      // fingerprint before the checkpoint serializer exists.
      const preflight = await beginCheckpointPreflight(
        joinedCfg,
        candidate,
        runCmd,
      );
      if (preflight.kind !== "ready") {
        throw new Error("expected an available candidate to complete checkpoint preflight");
      }
      const prewarmed = preflight.prewarmedDependencyGeneration;
      lock = preflight.lock;
      expect(lock.acquired).toBe(true);
      expect(readFileSync(prelockTrace, "utf8")).toBe("prelock");
      expect(prewarmed.candidate).toBe(candidate);
      expect(prewarmed.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const real = realCheckpointDeps(
        joinedCfg,
        runCmd,
        "d081-joined-run",
        undefined,
        undefined,
        undefined,
        prewarmed,
      );
      const deps: CheckpointDeps = {
        prepareSource: real.prepareSource,
        setupTree: real.setupTree,
        runGreen: async (treeDir) => {
          expect(
            readFileSync(
              join(treeDir, "node_modules", "fixture-dep", "index.js"),
              "utf8",
            ),
          ).toBe("module.exports = 'joined-v3';\n");
          return {
            green: true,
            summary: "joined production-path fixture passed",
            failingTests: [],
          };
        },
        advance: real.advance,
        push: async () => {},
        broadcast: async () => {},
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async () => {},
        log: () => {},
      };
      const verdict = await runGreenCheckpoint(joinedCfg, deps, {
        candidate,
        candidateSource: "tip",
        noPush: true,
      });

      expect(verdict).toMatchObject({
        advanced: true,
        candidate,
        from: base,
        green: true,
        reason: "advanced",
        candidateSource: "tip",
      });
      // D-033 / WI-42329: the whole-box exclusive barrier is demanded ONLY when the
      // transported selection had to publish fresh (reused=false). The --ensure-ref flow
      // re-opens the selector by exact candidate key after publishing, so it reports
      // reused=true even for a first publish — the publish happened pre-lock (D-081),
      // and setupTree's materialization is then a parallel-safe private-root copy.
      expect(
        existsSync(join(pcHeavyDir, "exclusive-materialization.lock")),
      ).toBe(!prewarmed.reused);
      expect(
        readFileSync(
          join(checkpoint, "node_modules", ".papercusp-dependency-generation"),
          "utf8",
        ),
      ).toContain(`identity=${prewarmed.identity}`);

      // NEGATIVE: transport does not authorize token drift. Mutating the
      // immutable marker changes its stat token; the real consumer must refuse
      // before it can materialize a replacement under the stale prelock token.
      const generationMarker = join(
        integration,
        ".papercusp",
        "dependency-generations",
        prewarmed.identity,
        ".papercusp-dependency-generation",
      );
      // The publisher makes the immutable marker 0444. This negative control
      // intentionally corrupts it, so restore owner-write permission first;
      // otherwise the fixture tests filesystem permissions rather than token
      // drift and fails before the consumer assertion runs.
      chmodSync(generationMarker, 0o644);
      writeFileSync(
        generationMarker,
        `${readFileSync(generationMarker, "utf8")}tampered=1\n`,
      );
      await expect(
        real.setupTree(candidate, { preparedSource: true }),
      ).rejects.toThrow(
        /invalid publication token|replaced (?:before its selection lease could be acquired|after validation)/i,
      );
    } finally {
      if (priorAfterCopyHook === undefined)
        delete process.env.DEPENDENCY_GENERATION_AFTER_COPY_HOOK;
      else
        process.env.DEPENDENCY_GENERATION_AFTER_COPY_HOOK = priorAfterCopyHook;
      if (priorPcHeavyDir === undefined) delete process.env.PC_HEAVY_DIR;
      else process.env.PC_HEAVY_DIR = priorPcHeavyDir;
      if (lock?.acquired) lock.release();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  function expectMutexGuardedGenerationSelector(call: {
    cmd: string;
    args: string[];
  }) {
    expect(call.cmd).toBe(process.execPath);
    expect(call.args).toEqual([
      expect.stringMatching(/scripts\/npm-install-safe\.mjs$/),
      "--repo-root",
      "/int",
      "--exec-under-lock",
      "--",
      "bash",
      expect.stringMatching(
        /apps\/operator\/bin\/release\/dependency-generation\.sh$/,
      ),
      "--integration",
      "/int",
      "--select-inputs-from",
      cpTree,
      "--lease-owner-pid",
      expect.stringMatching(/^\d+$/),
    ]);
  }

  it("P-007/P-008: prepares object-sourced exact checkout and probes related tests in that candidate tree", async () => {
    const { exec, calls } = makeExec([
      {
        code: 0,
        stdout: [
          "RELATED_SELECTION ws=@papercusp/web selected=2 total=40 mode=related reason=ok",
          "RELATED_MATERIALIZATION_SELECTION status=selected relatedSelections=1 affected=1 closure=2",
          "RELATED_AFFECTED_WORKSPACE_DIR\tapps/operator",
          "RELATED_DEPENDENCY_WORKSPACE_DIR\tapps/operator",
          "RELATED_DEPENDENCY_WORKSPACE_DIR\tpackages/operator-core",
        ].join("\n"),
      },
    ]);
    const deps = realCheckpointDeps(cfg, exec);

    await deps.prepareSource?.("cand123");
    const selection = await deps.selectMaterializationClosure?.({
      candidate: "cand123",
      base: "ready123",
    });

    expect(calls[0]).toMatchObject({
      cmd: "bash",
      args: [
        expect.stringMatching(
          /apps\/operator\/bin\/release\/setup-release-checkout\.sh$/,
        ),
        "--ref",
        "cand123",
        "--integration",
        "/int",
        "--release",
        cpTree,
        "--source-integrity",
        "object-sourced",
        "--source-only",
      ],
    });
    expect(calls[1]).toMatchObject({
      cmd: process.execPath,
      args: [
        join(cpTree, "scripts/affected-tests.mjs"),
        "--base",
        "ready123",
        "--related",
        "--print-affected",
      ],
    });
    expect(calls[1].opts).toMatchObject({
      cwd: cpTree,
      allowNonZero: true,
      killProcessGroupOnTimeout: true,
    });
    expect(selection).toEqual({
      affectedWorkspaceDirs: ["apps/operator"],
      workspaceDirs: ["apps/operator", "packages/operator-core"],
      relatedSelections: 1,
      summary:
        "RELATED_MATERIALIZATION_SELECTION status=selected relatedSelections=1 affected=1 closure=2",
    });
  });

  it("P-007: selected setup binds workspace closure into generation and reuses prepared source", async () => {
    const { exec, calls } = makeExec([
      {
        code: 0,
        stdout: `copied checkpoint dependencies\n[setup-release] DEPENDENCY_GENERATION_PIN identity=${generationId}`,
      },
    ]);

    await realCheckpointDeps(cfg, exec).setupTree("cand123", {
      preparedSource: true,
      workspaceDirs: ["apps/operator", "packages/operator-core"],
    });

    expect(calls[0].cmd).toBe(process.execPath);
    expect(calls[0].args).toEqual([
      expect.stringMatching(/scripts\/npm-install-safe\.mjs$/),
      "--repo-root",
      "/int",
      "--exec-under-lock",
      "--",
      "bash",
      expect.stringMatching(
        /apps\/operator\/bin\/release\/dependency-generation\.sh$/,
      ),
      "--integration",
      "/int",
      "--select-inputs-from",
      cpTree,
      "--lease-owner-pid",
      expect.stringMatching(/^\d+$/),
    ]);
    expect(calls[1].args).toEqual(
      expect.arrayContaining([
        "--prepare-existing",
        "--node-modules-generation-id",
        generationId,
        "--node-modules-generation-token",
        FIXTURE_DEPENDENCY_GENERATION_TOKEN,
        "--node-modules-workspace-dir",
        "apps/operator",
        "--node-modules-workspace-dir",
        "packages/operator-core",
      ]),
    );
  });

  it("setupTree publishes an identity before the capacity wait and transports that exact pin into setup", async () => {
    const { exec, calls } = makeExec([
      {
        code: 0,
        stdout: `copied checkpoint dependencies\n[setup-release] DEPENDENCY_GENERATION_PIN identity=${generationId}`,
      },
    ]);
    const setup = await realCheckpointDeps(cfg, exec).setupTree("cand123", {
      preparedSource: true,
    });
    expectMutexGuardedGenerationSelector(calls[0]);
    expect(calls[0].opts?.timeoutMs).toBeTypeOf("number");
    expect(calls[0].opts).toMatchObject({
      timeoutMs: DEPENDENCY_GENERATION_IDLE_TIMEOUT_MS,
      timeoutResetsOnProgress: true,
      hardTimeoutMs: DEPENDENCY_GENERATION_HARD_TIMEOUT_MS,
      killProcessGroupOnTimeout: true,
    });
    expect(calls[0].opts?.onOutput).toBeTypeOf("function");
    expect(calls[0].opts?.killProcessGroupOnTimeout).toBe(true);
    expect(calls[1].cmd).toBe("bash");
    expect(calls[1].args[0].endsWith("scripts/pc-heavy.sh")).toBe(true);
    expect(calls[1].args).toEqual(
      // `force` (not `auto`): the checkpoint tree must always re-copy node_modules — the
      // `auto` heuristic is blind to nested-dep drift and spuriously red the gate (EI-2699).
      // D-033: no `--exclusive-all-slots` pinned here — the default selector fixture reports
      // reused=true, so the shared-slot path applies; the conditional contract itself is
      // pinned by the dedicated D-033 test above.
      expect.arrayContaining([
        "--",
        "bash",
        expect.stringMatching(
          /apps\/operator\/bin\/release\/setup-release-checkout\.sh$/,
        ),
        "--ref",
        "cand123",
        "--integration",
        "/int",
        "--release",
        cpTree,
        "--node-modules",
        "force",
        "--node-modules-copy",
        "copy",
        "--node-modules-generation",
        "required",
        "--node-modules-generation-id",
        generationId,
        "--node-modules-generation-token",
        FIXTURE_DEPENDENCY_GENERATION_TOKEN,
      ]),
    );
    expect(calls[1].opts?.onOutput).toBeTypeOf("function");
    expect(calls[1].opts?.timeoutMs).toBeTypeOf("number");
    expect(calls[1].opts?.killProcessGroupOnTimeout).toBe(true);
    expect(calls[1].opts?.env?.PC_HEAVY_RELEASE_GATE).toBe("1");
    expect(setup).toEqual({
      identity: `setup-release-checkout:cand123:deps=${generationId}`,
      output: `copied checkpoint dependencies\n[setup-release] DEPENDENCY_GENERATION_PIN identity=${generationId}`,
    });
  });

  it("P-006: setupTree fails closed when setup omits the pinned generation identity", async () => {
    const { exec } = makeExec([
      { code: 0, stdout: "setup finished without a generation marker" },
    ]);

    await expect(
      realCheckpointDeps(cfg, exec).setupTree("cand-without-generation", {
        preparedSource: true,
      }),
    ).rejects.toThrow(
      "completed without a pinned dependency-generation identity",
    );
  });

  it("P-006: setupTree fails closed if setup pins a different generation than the preselected identity", async () => {
    const differentGeneration = `v1-${"e".repeat(64)}`;
    const { exec } = makeExec([
      {
        code: 0,
        stdout: `[setup-release] DEPENDENCY_GENERATION_PIN identity=${differentGeneration}`,
      },
    ]);

    await expect(
      realCheckpointDeps(cfg, exec).setupTree("cand-moved-generation", {
        preparedSource: true,
      }),
    ).rejects.toThrow(`expected selected identity ${generationId}`);
  });

  it("push rides the PAPERCUSP_MAIN_PUSH_OK guard (the one writer allowed past the main pre-push hook)", async () => {
    const { exec, calls } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push(
      "ready",
      "base123",
      "candidate123",
    );
    // The candidate's gitlinks are listed first so a gen-heal pin can be published.
    expect(calls[0].args).toEqual(["-C", "/int", "ls-tree", "-r", "-z", "candidate123"]);
    expect(calls[1].cmd).toBe("git");
    expect(calls[1].args).toEqual([
      "-C",
      "/int",
      "push",
      "origin",
      "candidate123:refs/heads/ready",
    ]);
    expect(calls[1].opts?.env?.PAPERCUSP_MAIN_PUSH_OK).toBe("1");
  });

  it("push publishes a gate-pin tag for a gen-heal gitlink BEFORE main, and holds promotion when it cannot", async () => {
    const heal = "e".repeat(40);
    const listing = { code: 0, stdout: `100644 blob ${"1".repeat(40)}\ttop.txt\x00160000 commit ${heal}\tlibs/sub\x00` };
    const published = makeExec([listing, { code: 0 }, { code: 0 }, { code: 0, stdout: "" }]);
    await realCheckpointDeps(cfg, published.exec).push("ready", "base123", "candidate123");
    expect(published.calls.map((c) => c.args.slice(2))).toEqual([
      ["ls-tree", "-r", "-z", "candidate123"],
      ["rev-parse", "--verify", "--quiet", `refs/papercusp/gen-heal/${heal}`],
      ["push", "origin", `${heal}:refs/tags/gate-pin/${heal}`],
      ["ls-tree", "-r", "-z", heal],
      ["push", "origin", "candidate123:refs/heads/ready"],
    ]);
    expect(published.calls[2]!.args[1]).toBe("/int/libs/sub");

    const refused = makeExec([listing, { code: 0 }, { code: 1, stderr: "remote rejected" }]);
    await expect(realCheckpointDeps(cfg, refused.exec).push("ready", "base123", "candidate123")).rejects.toThrow(
      /gate-pin publication for libs\/sub/,
    );
    expect(refused.calls.some((c) => c.args.includes("candidate123:refs/heads/ready"))).toBe(false);
  });

  it("push also workflow_dispatches test.yml (EI-18661485259809120: [skip ci] on every commit means the git push above never actually triggers it)", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push("ready");
    expect(mockCreateWorkflowDispatch).toHaveBeenCalledWith({
      owner: "Papercusp",
      repo: "papercup",
      workflow_id: "test.yml",
      ref: "ready",
    });
  });

  it("push never throws when the CI dispatch fails (best-effort — a GitHub API hiccup must not fail the checkpoint)", async () => {
    mockGetOctokit.mockRejectedValueOnce(new Error("network down"));
    const { exec, calls } = makeExec([{ code: 0 }]);
    await expect(
      realCheckpointDeps(cfg, exec).push("ready"),
    ).resolves.toBeUndefined();
    // the git push itself still happened
    expect(calls[0].cmd).toBe("git");
  });

  it("local-only push skips remote publication and CI dispatch when no origin resolves", async () => {
    mockGitOriginUrl.mockResolvedValueOnce(null as unknown as string);
    mockCreateWorkflowDispatch.mockClear();
    const { exec, calls } = makeExec([]);
    await realCheckpointDeps(cfg, exec).push("ready");
    expect(calls).toEqual([]);
    expect(mockCreateWorkflowDispatch).not.toHaveBeenCalled();
  });

  // WI-7013: the dispatched workflow_dispatch run must carry the pre-FF sha as its
  // `base` input, or test.yml's AFFECTED_BASE falls back to origin/main — which on a
  // workflow_dispatch run checked out AT main IS HEAD, an always-empty diff that
  // reports `tasks=0 status=passed` having verified nothing.
  it("push threads a given baseSha through to the workflow_dispatch inputs.base", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec).push("ready", "deadbeef00112233");
    expect(mockCreateWorkflowDispatch).toHaveBeenCalledWith({
      owner: "Papercusp",
      repo: "papercup",
      workflow_id: "test.yml",
      ref: "ready",
      inputs: { base: "deadbeef00112233" },
    });
  });

  // AdvanceResult.from is `null` on a freshly-created ready branch (the first-ever
  // advance) — the dispatch must degrade to the pre-WI-7013 shape (no `inputs` key
  // at all) rather than sending a literal "null"/"undefined" base.
  it("push omits inputs.base entirely when baseSha is null or omitted", async () => {
    mockCreateWorkflowDispatch.mockClear();
    const { exec: exec1 } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec1).push("ready", null);
    const { exec: exec2 } = makeExec([{ code: 0 }]);
    await realCheckpointDeps(cfg, exec2).push("ready");
    for (const call of mockCreateWorkflowDispatch.mock.calls) {
      expect(call[0]).not.toHaveProperty("inputs");
    }
  });
});

describe("materialization phase heartbeat — EI-21357012876642589", () => {
  it("refreshes a silent phase marker, stops at the hard bound, and can be stopped early", () => {
    vi.useFakeTimers();
    const lockDirs: string[] = [];
    try {
      const lockDir = mkdtempSync(
        join(tmpdir(), "green-checkpoint-heartbeat-"),
      );
      lockDirs.push(lockDir);
      writeCheckpointRunPhase(lockDir, "materializing");
      const initial = readFileSync(join(lockDir, "phase.json"), "utf8");

      const stop = startMaterializationHeartbeat(lockDir, {
        intervalMs: 100,
        maxDurationMs: 250,
      });
      vi.advanceTimersByTime(99);
      expect(readFileSync(join(lockDir, "phase.json"), "utf8")).toBe(initial);
      vi.advanceTimersByTime(1);
      const firstRefresh = readFileSync(join(lockDir, "phase.json"), "utf8");
      expect(firstRefresh).not.toBe(initial);
      vi.advanceTimersByTime(100);
      const secondRefresh = readFileSync(join(lockDir, "phase.json"), "utf8");
      expect(secondRefresh).not.toBe(firstRefresh);

      // The deadline tick only stops the heartbeat; it must not write a refresh at
      // or after the hard maximum, even though the recursive timer is still pending.
      vi.advanceTimersByTime(50);
      expect(readFileSync(join(lockDir, "phase.json"), "utf8")).toBe(
        secondRefresh,
      );
      vi.advanceTimersByTime(1_000);
      expect(readFileSync(join(lockDir, "phase.json"), "utf8")).toBe(
        secondRefresh,
      );

      // Normal setup completion stops the timer before its maximum as well.
      const earlyStopDir = mkdtempSync(
        join(tmpdir(), "green-checkpoint-heartbeat-stop-"),
      );
      lockDirs.push(earlyStopDir);
      writeCheckpointRunPhase(earlyStopDir, "materializing");
      const stopEarly = startMaterializationHeartbeat(earlyStopDir, {
        intervalMs: 100,
        maxDurationMs: 1_000,
      });
      vi.advanceTimersByTime(100);
      const beforeStop = readFileSync(join(earlyStopDir, "phase.json"), "utf8");
      stopEarly();
      vi.advanceTimersByTime(1_000);
      expect(readFileSync(join(earlyStopDir, "phase.json"), "utf8")).toBe(
        beforeStop,
      );
      stop();
    } finally {
      vi.useRealTimers();
      for (const lockDir of lockDirs)
        rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

/**
 * WI-6068 recurrence guard. The suite log used to be named `<ts>-base-<sha>.log`, where
 * `base` is `main` — CONSTANT between fast-forwards. So consecutive runs judging DIFFERENT
 * candidates produced near-identical names, and a STALE red read exactly like a fresh
 * verdict (2026-07-26: `ls -t | head -1` surfaced a red for a superseded candidate while
 * the real run was still in flight and logging to /tmp; the candidate was only recovered
 * by archaeology on failing TEST NAMES). These assert the candidate is recoverable from
 * the artifact itself — and that resolving it can never break the gate.
 */
describe("WI-6068: the checkpoint log identifies the CANDIDATE it judged", () => {
  /**
   * A real git repo, because the candidate sha is read from the tree's HEAD.
   * `marker` must differ between fixtures: git derives the sha from tree content +
   * commit timestamp, so two identical trees committed inside the same second would
   * collide on ONE sha — and the "distinguishable names" test below would pass
   * vacuously while asserting the exact opposite of what it claims.
   */
  function makeGitTree(marker = "fixture"): { dir: string; sha: string } {
    const dir = mkdtempSync(join(tmpdir(), "green-cp-git-tree-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "cp-git-fixture" }),
    );
    writeFileSync(join(dir, "marker.txt"), marker);
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
    git("init", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "fixture");
    git("add", "-A");
    git("commit", "-qm", "fixture");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    return { dir, sha };
  }

  it("writes the candidate sha into BOTH the log filename and the log body", async () => {
    const { dir, sha } = makeGitTree();
    try {
      expect(sha).toMatch(/^[0-9a-f]{40}$/); // fixture sanity: HEAD really resolved
      const before = new Set(readdirSync(tmpLogDir));
      const { exec } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);

      await realCheckpointDeps(cfg, exec).runGreen(dir, "base-sha");

      const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
      expect(written).toHaveLength(1);
      // The filename alone must answer "what was judged" — that is the whole point.
      expect(written[0]).toContain(`-cand-${sha.slice(0, 12)}`);
      // ...and the body repeats it, so a tailed/copied log stays self-identifying.
      expect(readFileSync(join(tmpLogDir, written[0]), "utf8")).toContain(
        `candidate=${sha}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two runs on DIFFERENT candidates produce distinguishable log names (the actual failure)", async () => {
    const a = makeGitTree("candidate-a");
    const b = makeGitTree("candidate-b");
    try {
      expect(a.sha).not.toBe(b.sha); // fixture sanity: genuinely different candidates
      const before = new Set(readdirSync(tmpLogDir));
      // Same `base` for both — exactly the real-world case the old name could not separate.
      await realCheckpointDeps(
        cfg,
        makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]).exec,
      ).runGreen(a.dir, "same-base");
      await realCheckpointDeps(
        cfg,
        makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]).exec,
      ).runGreen(b.dir, "same-base");

      const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
      expect(written).toHaveLength(2);
      const candidatePart = (f: string) => /-cand-([0-9a-f]+)\./.exec(f)?.[1];
      expect(new Set(written.map(candidatePart)).size).toBe(2);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it("FAILS OPEN on a non-git candidate tree — still logs, never throws (a naming nicety must not gate a verdict)", async () => {
    const before = new Set(readdirSync(tmpLogDir));
    const { exec } = makeExec([{ code: 0 }, { code: 1 }, { code: 0 }]);

    // cpTree is a bare temp dir with a package.json and no git repo at all.
    const r = await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    expect(r.green).toBe(true);
    const written = readdirSync(tmpLogDir).filter((f) => !before.has(f));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("-cand-");
    expect(readFileSync(join(tmpLogDir, written[0]), "utf8")).toContain(
      "candidate=unresolved",
    );
  });
});

// ── EI-19332206710686203 ──────────────────────────────────────────────────────
// Every RESCUE re-run must pass vitest an explicit, generous per-test deadline.
//
// The defect these guard: vitest's default testTimeout is 5s and nothing in this repo's
// config chain raises it, so each re-run below inherited 5s. That is self-defeating — a
// rescue re-run exists to decide "box, or code?", and at loadavg 130+ the dominant flake
// shape is a test that is merely SLOW. On a 5s deadline the re-run re-observes the very
// symptom it was launched to discriminate, and votes to keep the red. Measured 2026-08-02:
// github-identity-drift.test.ts timed out at 11,725ms with ZERO real offenders and
// red-pinned the fleet's gate.
//
// These are argv-level guards on purpose: the flag IS the entire fix, it is invisible to
// any behavioural assertion (an injected exec never runs vitest), and dropping it would
// silently restore the 5s default with every other test in this file still green.
describe("EI-19332206710686203: rescue re-runs carry an explicit per-test timeout", () => {
  const TIMEOUT_FLAG = `--testTimeout=${RESCUE_TEST_TIMEOUT_MS}`;

  // Generous vs the 5s default, yet well inside every outer wall-clock cap — so raising it
  // can delay a red (the subprocess cap still fires on a real hang), never invent a green.
  it("the deadline is generous vs vitest 5s, yet stays inside every outer subprocess cap", () => {
    expect(RESCUE_TEST_TIMEOUT_MS).toBeGreaterThan(5_000);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(ISOLATION_RUN_TIMEOUT_MS);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(CONCURRENT_CONFIRM_TIMEOUT_MS);
    expect(RESCUE_TEST_TIMEOUT_MS).toBeLessThan(WORKSPACE_RERUN_TIMEOUT_MS);
  });

  const RED_TWO_FILES =
    ">>> @example/fixture-pkg :: npm run test\n" +
    " FAIL  lib/a.test.ts > alpha\n" +
    " FAIL  lib/b.test.ts > beta\n" +
    "2 non-quarantined task(s) failed.";

  it("the per-file isolation re-run passes it — and still AFTER the `--` npm separator", async () => {
    // calls: 0 red suite, 1+2 the two isolation re-runs, 3 the confirming co-execution run.
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_TWO_FILES },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    for (const c of calls.slice(1, 3)) {
      expect(c.cmd).toBe("npm");
      expect(c.args).toContain(TIMEOUT_FLAG);
      // npm forwards only what FOLLOWS `--` to the script; a flag placed before it is
      // swallowed by npm and never reaches vitest — a failure mode with no runtime symptom.
      expect(c.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
        c.args.indexOf("--"),
      );
      // ...and it must not have displaced the single-concurrency isolation contract.
      expect(c.args).toContain("--no-file-parallelism");
      expect(c.opts?.env?.VITEST_MAX_FORKS).toBe("1");
    }
  });

  // The counterintuitive one. Absorption requires BOTH every file to pass alone AND this
  // confirming run to come back clean — so leaving THIS on the 5s default would have kept
  // the isolation fix inert: under the same load a slow test re-times-out here and is
  // scored `reproduced`. The room does not blunt the experiment, because what this run
  // measures is whether the failure is CORRECTNESS-dependent on co-execution (which still
  // fails at 60s); being merely slower when co-executed is what contention IS, not a defect.
  it("the confirming co-execution re-run passes it too — otherwise the isolation fix is inert", async () => {
    const { exec, calls } = makeExec([
      { code: 1, stdout: RED_TWO_FILES },
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    const confirming = calls[3];
    expect(confirming.cmd).toBe("npm");
    expect(confirming.args).toContain(TIMEOUT_FLAG);
    expect(confirming.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      confirming.args.indexOf("--"),
    );
    // ...without becoming an isolation run: co-execution is the variable it exists to test.
    expect(confirming.args).not.toContain("--no-file-parallelism");
    expect(confirming.opts?.env?.VITEST_MAX_FORKS).not.toBe("1");
    // both originally-failing files still run TOGETHER in the one invocation
    expect(confirming.args).toContain("lib/a.test.ts");
    expect(confirming.args).toContain("lib/b.test.ts");
  });

  it("the worker-pool-crash workspace re-run passes it", async () => {
    const crash =
      ">>> @example/fixture-pkg :: npm run test\n" +
      "Error: [vitest-pool]: Worker forks emitted error.\n" +
      "Caused by: Error: Worker exited unexpectedly\n" +
      "1 non-quarantined task(s) failed.";
    const { exec, calls } = makeExec([{ code: 1, stdout: crash }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");

    const rerun = calls[1];
    expect(rerun.cmd).toBe("npm");
    expect(rerun.args).toContain(TIMEOUT_FLAG);
    expect(rerun.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      rerun.args.indexOf("--"),
    );
    expect(rerun.opts?.env?.VITEST_MAX_FORKS).toBe("1"); // still the reduced-concurrency re-run
  });

  it("the stale-candidate tip re-run passes it", async () => {
    // runTestsAtRef is the "is this red already fixed at tip?" rescue: a false pass:false
    // there reports a genuinely-fixed tip as still broken and keeps `main` frozen.
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(cfg, exec);
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@example/fixture-pkg", file: "lib/a.test.ts" },
    ]);

    const testRun = calls.find(
      (c) => c.cmd === "npm" && c.args.includes("test"),
    );
    expect(testRun).toBeDefined();
    expect(testRun!.args).toContain(TIMEOUT_FLAG);
    expect(testRun!.args.indexOf(TIMEOUT_FLAG)).toBeGreaterThan(
      testRun!.args.indexOf("--"),
    );
    expect(testRun!.args).toContain("lib/a.test.ts");
  });

  it("routes standalone package rescue runs through the package directory", async () => {
    const standaloneCfg = releaseConfig({
      integrationRoot: "/int",
      releaseRoot: "/int",
      checkpointRoot: standaloneTree,
      releaseRef: "ready",
      integrationBranch: "main",
      checkpointLogDir: tmpLogDir,
    });
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(standaloneCfg, exec);
    const file = "test/test-registry-coverage.test.js";

    await deps.isolationRun?.({ workspace: "@papercusp/desktop", file });
    await deps.concurrentRun?.({
      workspace: "@papercusp/desktop",
      files: [file],
    });
    await deps.workspaceRerun?.({ workspace: "@papercusp/desktop" });
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/desktop", file },
    ]);

    const testRuns = calls.filter(
      (c) => c.cmd === "npm" && c.args[0] === "run" && c.args[1] === "test",
    );
    expect(testRuns).toHaveLength(4);
    for (const run of testRuns) {
      expect(run.opts?.cwd).toBe(join(standaloneTree, "papercusp-desktop"));
      expect(run.args).not.toContain("--workspace");
      expect(run.args.slice(0, 3)).toEqual(["run", "test", "--"]);
    }
    expect(testRuns.at(-1)?.args).toContain(file);
  });

  it("routes Bash self-test rescues through Bash, never the package Vitest command", async () => {
    const standaloneCfg = releaseConfig({
      integrationRoot: "/int",
      releaseRoot: "/int",
      checkpointRoot: standaloneTree,
      releaseRef: "ready",
      integrationBranch: "main",
      checkpointLogDir: tmpLogDir,
    });
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(standaloneCfg, exec);
    const file = "bin/lib/release-artifacts.selftest.sh";

    expect(
      resolveWorkspaceFileTestInvocation(
        standaloneTree,
        "@papercusp/desktop",
        file,
        ["--no-file-parallelism", "--testTimeout=60000"],
      ),
    ).toEqual({
      cmd: "bash",
      args: [file],
      cwd: join(standaloneTree, "papercusp-desktop"),
    });

    await deps.isolationRun?.({ workspace: "@papercusp/desktop", file });
    await deps.concurrentRun?.({
      workspace: "@papercusp/desktop",
      files: [file],
    });
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/desktop", file },
    ]);

    const bashRuns = calls.filter(
      (call) => call.cmd === "bash" && call.args.includes(file),
    );
    expect(bashRuns).toHaveLength(3);
    for (const run of bashRuns) {
      expect(run.args).toEqual([file]);
      expect(run.opts?.cwd).toBe(join(standaloneTree, "papercusp-desktop"));
    }
    expect(
      calls.some((call) => call.cmd === "npm" && call.args.includes(file)),
    ).toBe(false);
  });

  // WI-10003242: the desktop package's `npm run test` is a composite whose trailing args select
  // nothing, so a named node:test file routed through it ran the whole ~5.5-min suite under the
  // 5-min isolation bound and a frozen repair signature naming it could never be discharged.
  it("routes a standalone node:test file through node --test, never the package script", async () => {
    const standaloneCfg = releaseConfig({
      integrationRoot: "/int",
      releaseRoot: "/int",
      checkpointRoot: standaloneTree,
      releaseRef: "ready",
      integrationBranch: "main",
      checkpointLogDir: tmpLogDir,
    });
    const file = "test/provenance-sidecar-record.test.js";
    const vitestFile = "test/vitest-owned.test.js";
    mkdirSync(join(standaloneTree, "papercusp-desktop", "test"), { recursive: true });
    writeFileSync(
      join(standaloneTree, "papercusp-desktop", file),
      "const test = require('node:test');\ntest('x', () => {});\n",
    );
    writeFileSync(
      join(standaloneTree, "papercusp-desktop", vitestFile),
      "import { it } from 'vitest';\nit('x', () => {});\n",
    );
    const { exec, calls } = makeExec([]);
    const deps = realCheckpointDeps(standaloneCfg, exec);

    expect(isStandaloneNodeTestFile(standaloneTree, "@papercusp/desktop", file)).toBe(true);
    expect(isStandaloneNodeTestFile(standaloneTree, "@papercusp/desktop", vitestFile)).toBe(false);
    // A workspace test run from the repo root is never a standalone node:test file.
    expect(isStandaloneNodeTestFile(standaloneTree, "@papercusp/web", file)).toBe(false);
    expect(
      resolveWorkspaceFileTestInvocation(
        standaloneTree,
        "@papercusp/desktop",
        file,
        ["--no-file-parallelism", "--testTimeout=60000"],
      ),
    ).toEqual({
      cmd: "node",
      args: ["--test", file],
      cwd: join(standaloneTree, "papercusp-desktop"),
    });

    await deps.isolationRun?.({ workspace: "@papercusp/desktop", file });
    await deps.concurrentRun?.({
      workspace: "@papercusp/desktop",
      files: [file, vitestFile],
    });
    await deps.runTestsAtRef?.("deadbeef", [
      { workspace: "@papercusp/desktop", file },
      { workspace: "@papercusp/desktop", file: vitestFile },
    ]);

    const nodeRuns = calls.filter(
      (call) => call.cmd === "node" && call.args.includes(file),
    );
    expect(nodeRuns).toHaveLength(3);
    for (const run of nodeRuns) {
      expect(run.args).toEqual(["--test", file]);
      expect(run.opts?.cwd).toBe(join(standaloneTree, "papercusp-desktop"));
    }
    expect(
      calls.some((call) => call.cmd === "npm" && call.args.includes(file)),
    ).toBe(false);
    // The vitest-owned sibling still rides the package script in both multi-file paths.
    expect(
      calls.filter((call) => call.cmd === "npm" && call.args.includes(vitestFile)),
    ).toHaveLength(2);
  });
});

// ── EI-24542010215430349: rescue reruns run under the capture the suite ran under ──
//
// The suite arms the executed-source-map reporter + per-file input capture on unit and integration vitest
// task. A rescue rerun that ran UNARMED changed a second variable besides concurrency: a red the
// capture itself caused passed unarmed and was absorbed as a load flake. Each rescue now arms the
// same capture NO-PERSIST (nothing it sees becomes a reusable pass proof) and never inherits the
// suite's result file, rows file or pass-reuse skip list.
describe("EI-24542010215430349: rescue reruns arm executed-source capture, no-persist", () => {
  // This file itself runs inside the gate's suite, whose process env carries the suite's own
  // arming (result file, skip list, workspace name, possibly the record toggle). Pin every key
  // the helper reads or writes, so the assertions never depend on the outer run.
  const PINNED = [
    EXECUTED_MAP_RECORD_ENV,
    EXECUTED_MAP_WORKSPACE_ENV,
    EXECUTED_MAP_NO_PERSIST_ENV,
    EXECUTED_MAP_RESULT_ENV,
    EXECUTED_MAP_OUT_ENV,
    TEST_REUSE_SKIP_LIST_ENV,
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of PINNED) saved[k] = process.env[k];
    for (const k of PINNED) delete process.env[k];
    // What a leaked outer suite env looks like: the rescue must strip all of it.
    process.env[EXECUTED_MAP_WORKSPACE_ENV] = "@outer/suite-ws";
    process.env[EXECUTED_MAP_RESULT_ENV] = "/tmp/outer-suite-result.jsonl";
    process.env[EXECUTED_MAP_OUT_ENV] = "/tmp/outer-suite-rows.json";
    process.env[TEST_REUSE_SKIP_LIST_ENV] = "/tmp/outer-suite-skip-list.json";
  });
  afterEach(() => {
    for (const k of PINNED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const armedAs = (env: NodeJS.ProcessEnv | undefined, workspace: string) => {
    expect(env?.[EXECUTED_MAP_WORKSPACE_ENV]).toBe(workspace);
    expect(env?.[EXECUTED_MAP_NO_PERSIST_ENV]).toBe("1");
    for (const k of [EXECUTED_MAP_RESULT_ENV, EXECUTED_MAP_OUT_ENV, TEST_REUSE_SKIP_LIST_ENV]) {
      expect(env?.[k], k).toBeUndefined();
    }
  };
  const unarmed = (env: NodeJS.ProcessEnv | undefined) => {
    for (const k of [
      EXECUTED_MAP_WORKSPACE_ENV,
      EXECUTED_MAP_NO_PERSIST_ENV,
      EXECUTED_MAP_RESULT_ENV,
      EXECUTED_MAP_OUT_ENV,
      TEST_REUSE_SKIP_LIST_ENV,
    ]) {
      expect(env?.[k], k).toBeUndefined();
    }
  };

  it("helper: a unit file is armed no-persist and stripped of every suite-only channel", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    expect(armRescueRerunCapture(env, { workspace: "@x/w", files: ["lib/a.test.ts"] })).toBe(true);
    armedAs(env, "@x/w");
  });

  it("helper: integration files retain the suite's capture with no persistence", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    expect(
      armRescueRerunCapture(env, { workspace: "@x/w", files: ["lib/a.test.ts", "lib/b.integration.test.ts"] }),
    ).toBe(true);
    armedAs(env, "@x/w");
  });

  it("helper: recording switched off stays unarmed, exactly as the suite would", () => {
    for (const off of ["0", "false", "off", "no"]) {
      const env: NodeJS.ProcessEnv = { ...process.env, [EXECUTED_MAP_RECORD_ENV]: off };
      for (const files of [["lib/a.test.ts"], ["lib/a.integration.test.ts"]]) {
        const childEnv = { ...env };
        expect(armRescueRerunCapture(childEnv, { workspace: "@x/w", files })).toBe(false);
        unarmed(childEnv);
      }
    }
  });

  const RED_TWO_FILES =
    ">>> @example/fixture-pkg :: npm run test\n" +
    " FAIL  lib/a.test.ts > alpha\n" +
    " FAIL  lib/b.test.ts > beta\n" +
    "2 non-quarantined task(s) failed.";

  it("wired: both isolation re-runs AND the confirming co-execution run spawn armed no-persist", async () => {
    // calls: 0 red suite, 1+2 the two isolation re-runs, 3 the confirming co-execution run.
    const { exec, calls } = makeExec([{ code: 1, stdout: RED_TWO_FILES }, { code: 0 }, { code: 0 }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");
    const rescues = calls.slice(1, 4);
    expect(rescues.map((c) => c.args.includes("lib/a.test.ts") || c.args.includes("lib/b.test.ts"))).toEqual([true, true, true]);
    for (const c of rescues) armedAs(c.opts?.env, "@example/fixture-pkg");
  });

  it("wired: the worker-pool-crash workspace re-run spawns armed no-persist", async () => {
    const crash =
      ">>> @example/fixture-pkg :: npm run test\n" +
      "Error: [vitest-pool]: Worker forks emitted error.\n" +
      "Caused by: Error: Worker exited unexpectedly\n" +
      "1 non-quarantined task(s) failed.";
    const { exec, calls } = makeExec([{ code: 1, stdout: crash }, { code: 0 }]);
    await realCheckpointDeps(cfg, exec).runGreen(cpTree, "base-sha");
    armedAs(calls[1].opts?.env, "@example/fixture-pkg");
  });

  it("wired: an isolation re-run of an integration file spawns armed no-persist", async () => {
    const { exec, calls } = makeExec([]);
    await realCheckpointDeps(cfg, exec).isolationRun?.({
      workspace: "@example/fixture-pkg",
      file: "lib/a.integration.test.ts",
    });
    const run = calls.find((c) => c.args.includes("lib/a.integration.test.ts"));
    expect(run).toBeDefined();
    armedAs(run!.opts?.env, "@example/fixture-pkg");
  });
});

// ── WI-36238: the `release-not-green` row must SURVIVE the attention TTL sweep ──
//
// COUPLING test, not a unit test: it drives the REAL `escalate` dep and feeds
// the record it emits to the REAL selector. The two halves live in different
// packages, so a unit test on either side alone would stay green if the marker
// were renamed, dropped from the meta bag, or no longer honoured.
//
// WHY IT MATTERS: `escalate` is transition-only — it returns early while one of
// its rows is open — and `clearEscalation` resolves that row itself when the
// gate recovers. So a sweep that GC's the row does not tidy a duplicate, it
// RE-ARMS a human-facing alarm on a still-red gate. Measured before the fix: an
// idle-2d GC at 2026-08-06T08:20:03.146Z was followed 46s later by a fresh
// escalation for the same still-red gate on a newer candidate.
describe("realCheckpointDeps.escalate — release-not-green survives the idle-TTL sweep (WI-36238)", () => {
  const TTL_MS = 2 * 24 * 60 * 60 * 1000;

  /** Mirrors buildOpenEscalationRecord (escalations.ts:170-190) — in particular
   *  `Object.assign(env, input.meta)`, which FLATTENS the meta bag onto the
   *  stored record, which is how the sweep sees the marker at all. */
  function openRecordFor(call: {
    identity: Record<string, unknown>;
    input: Record<string, unknown>;
  }): StaleEscalationInput {
    return {
      ts: "2026-08-06T08:20:48.996Z",
      msg_id: "esc-green-checkpoint-1",
      from: String(call.identity.ownerId),
      to: ["human"],
      kind: "escalation",
      severity: call.input.severity,
      summary: call.input.summary,
      resolved: null,
      ...((call.input.meta as Record<string, unknown> | undefined) ?? {}),
    } as unknown as StaleEscalationInput;
  }

  it("emits a row the idle-TTL sweep will NOT garbage-collect", async () => {
    openEscalationCalls.length = 0;
    const { exec } = makeExec([]);
    await realCheckpointDeps(cfg, exec).escalate?.(
      "green-checkpoint held: 65e99488 not green",
      "the gate is red",
    );
    expect(openEscalationCalls).toHaveLength(1);

    const emitted = openRecordFor(openEscalationCalls[0]!);
    // Age it well past the sweep's TTL and run the REAL selector.
    const nowMs = Date.parse(emitted.ts) + 30 * 24 * 60 * 60 * 1000;
    expect(selectStaleEscalations([emitted], { nowMs, ttlMs: TTL_MS })).toEqual(
      [],
    );

    // CALIBRATION: the same row WITHOUT the marker IS swept — proving the
    // assertion above turns on the marker, not on some other property of the
    // row (its sender, its lack of options, its age). Without this, a selector
    // that never selected this row for an unrelated reason would look like a
    // passing exemption.
    const { [SELF_RECONCILING_META_KEY]: _marker, ...unmarked } =
      emitted as unknown as Record<string, unknown>;
    expect(
      selectStaleEscalations([unmarked as unknown as StaleEscalationInput], {
        nowMs,
        ttlMs: TTL_MS,
      }),
    ).toHaveLength(1);
  });
});

// WI-39686: the green-recovery sweep matched on escalation SOURCE alone, while
// `clearEscalation`'s interface doc promised only the `release-not-green` row.
//
// ⚠ READ THIS BEFORE "FIXING" A FAILURE HERE: the defect these tests guard is
// LATENT, not live. At the time of writing this file has exactly two
// `openEscalation` call sites — the release-not-green row and the detector alert
// — and the detector already carries its own DISTINCT source, so the old
// source-only sweep resolved precisely the one row it should. Nothing was
// misbehaving in production. What these tests protect is the NEXT author who
// opens a row under the gate's own source: under the old sweep it would be
// silently self-resolved on the advance path, in its own run. That is exactly
// what D-008 nearly did to the detector alert, and the near-miss is why the
// class marker exists. So a failure here is not "an alarm is being cleared
// wrongly today" — it is "the trap has been re-armed".
describe("clearEscalation — sweeps the release-not-green CLASS, not the whole source (WI-39686)", () => {
  function row(extra: Record<string, unknown>): Record<string, unknown> {
    return { msg_id: "esc-1", status: "open", ...extra };
  }

  describe("isReleaseNotGreenEscalation", () => {
    it("matches the class the sweep owns", () => {
      expect(
        isReleaseNotGreenEscalation(
          row({
            source: GATE_ESCALATION_SOURCE,
            [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
          }),
        ),
      ).toBe(true);
    });

    // The backward-compatibility arm, and it is load-bearing rather than lenient:
    // rows opened BEFORE the class marker existed carry the source only, and one
    // may be open on a genuinely red gate at deploy time. If the predicate
    // demanded the marker, that row could never be resolved again — an immortal
    // human-facing alarm. Deleting this case to "tighten" the predicate would
    // reintroduce precisely that.
    it("still matches a legacy row that predates the class marker", () => {
      expect(
        isReleaseNotGreenEscalation(row({ source: GATE_ESCALATION_SOURCE })),
      ).toBe(true);
    });

    it("does NOT match another class opened under the gate's own source", () => {
      expect(
        isReleaseNotGreenEscalation(
          row({
            source: GATE_ESCALATION_SOURCE,
            [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
          }),
        ),
      ).toBe(false);
    });

    it("does not match the detector alert, or a foreign row", () => {
      expect(
        isReleaseNotGreenEscalation(
          row({ source: DETECTOR_ESCALATION_SOURCE }),
        ),
      ).toBe(false);
      expect(
        isReleaseNotGreenEscalation(row({ source: "some-other-tool" })),
      ).toBe(false);
      expect(isReleaseNotGreenEscalation(null)).toBe(false);
      expect(isReleaseNotGreenEscalation(undefined)).toBe(false);
    });
  });

  // COUPLING half — a predicate unit test alone would stay green if the sweep
  // stopped calling it and went back to a bare source comparison. This drives
  // the REAL `clearEscalation` dep against a mixed set of open rows.
  describe("the real clearEscalation dep", () => {
    it("resolves the release-not-green row and LEAVES a sibling gate-sourced row open", async () => {
      resolveEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-release-not-green",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
        }),
        row({
          msg_id: "esc-legacy-unmarked",
          source: GATE_ESCALATION_SOURCE,
        }),
        row({
          msg_id: "esc-future-gate-alert",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
        }),
        row({ msg_id: "esc-detector", source: DETECTOR_ESCALATION_SOURCE }),
        row({ msg_id: "esc-foreign", source: "some-other-tool" }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).clearEscalation?.();

      const resolved = resolveEscalationCalls.map((c) => c.msg_id).sort();
      // Behaviour-PRESERVING for everything that exists today: the real row and
      // the legacy unmarked row are still resolved on recovery.
      expect(resolved).toEqual([
        "esc-legacy-unmarked",
        "esc-release-not-green",
      ]);
      // ...and the rows the old source-only sweep would have wrongly swept are
      // untouched. `esc-future-gate-alert` is the whole point of the change.
      expect(resolved).not.toContain("esc-future-gate-alert");
      expect(resolved).not.toContain("esc-detector");
      expect(resolved).not.toContain("esc-foreign");
    });

    // CALIBRATION, mirroring the WI-36238 test above: prove the assertion turns
    // on the class scoping rather than on some unrelated property of the fixture
    // (a missing field, the resolve mock never being called at all). The OLD
    // predicate is inlined here as the control — against the same rows it sweeps
    // three of them, so the test above genuinely discriminates.
    it("CALIBRATION: the old source-only predicate would have swept the sibling rows", () => {
      const oldPredicate = (e: Record<string, unknown>) =>
        e.source === "green-checkpoint";
      const rows = [
        row({
          msg_id: "esc-release-not-green",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
        }),
        row({ msg_id: "esc-legacy-unmarked", source: GATE_ESCALATION_SOURCE }),
        row({
          msg_id: "esc-future-gate-alert",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
        }),
      ];
      expect(rows.filter(oldPredicate)).toHaveLength(3);
      expect(rows.filter(isReleaseNotGreenEscalation)).toHaveLength(2);
    });
  });

  // The dedup guard in `escalate` had the SAME over-broad match, in the direction
  // that loses a page: any gate-sourced row being open suppressed the red
  // escalation from opening at all.
  describe("the escalate dedup guard", () => {
    it("still opens the red escalation when only a DIFFERENT gate-sourced class is open", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-future-gate-alert",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: "some-future-gate-alert",
        }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(1);
      expect(
        (openEscalationCalls[0]!.input.meta as Record<string, unknown>)[
          ESCALATION_CLASS_META_KEY
        ],
      ).toBe(RELEASE_NOT_GREEN_ESCALATION_CLASS);
    });

    it("still suppresses a duplicate while its OWN row is open (transition-only preserved)", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({
          msg_id: "esc-release-not-green",
          source: GATE_ESCALATION_SOURCE,
          [ESCALATION_CLASS_META_KEY]: RELEASE_NOT_GREEN_ESCALATION_CLASS,
        }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(0);
    });

    it("still suppresses a duplicate while a LEGACY unmarked row is open", async () => {
      openEscalationCalls.length = 0;
      openEscalationRows = [
        row({ msg_id: "esc-legacy-unmarked", source: GATE_ESCALATION_SOURCE }),
      ];

      const { exec } = makeExec([]);
      await realCheckpointDeps(cfg, exec).escalate?.(
        "green-checkpoint held: 65e99488 not green",
        "the gate is red",
      );
      expect(openEscalationCalls).toHaveLength(0);
    });
  });

  afterAll(() => {
    openEscalationRows = [];
  });
});

// plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 #D-066 (WI-6554700010019508): the
// WIRING inside runGreen. The pure rules live in fork-base-inherited-tests.test.ts; this proves
// the placement — a red suite defers the post-suite legs, so an inherited red must still PAY
// for them (exactly like an absorbed one), and only a fork run reaches the pass at all.
describe("#D-066: a fork pot's red suite that also fails at its upstream base", () => {
  const FORK_RED =
    ">>> @example/fixture-pkg :: npm run test\n" +
    " FAIL  lib/upstream-red-a.test.ts > a\n" +
    " FAIL  lib/upstream-red-b.test.ts > b\n" +
    "AFFECTED_TESTS_RESULT status=failed tasks=1 failed=1 quarantinedFailed=0 timedOutTasks=0 undeterminedTasks=0\n" +
    "1 non-quarantined task(s) failed.";
  const BASE = "f".repeat(40);
  const CAND = "e".repeat(40);
  const ENV_KEYS = ["PAPERCUSP_GATE_UPSTREAM_INSTALL", "PAPERCUSP_GATE_UPSTREAM_REF"] as const;
  const saved = ENV_KEYS.map((k) => process.env[k]);
  const setFork = (on: boolean) => {
    if (on) {
      process.env.PAPERCUSP_GATE_UPSTREAM_INSTALL = "papercusp";
      process.env.PAPERCUSP_GATE_UPSTREAM_REF = "refs/remotes/origin/staging";
    } else {
      for (const k of ENV_KEYS) delete process.env[k];
    }
  };
  afterAll(() => {
    ENV_KEYS.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
  });

  function forkExec(passAtBase: string[]) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let atBase = false;
    const exec: CheckpointExec = async (cmd, args) => {
      calls.push({ cmd, args });
      const isSuite =
        cmd === GREEN_CMD0 &&
        args.length === GREEN_ARGS.length &&
        args.every((arg, index) => arg === GREEN_ARGS[index]);
      if (isSuite) return { code: 1, stdout: FORK_RED, stderr: "" };
      if (cmd === "git" && args[0] === "-C") {
        const sub = args[2];
        if (sub === "rev-parse") return { code: 0, stdout: `${CAND}\n`, stderr: "" };
        if (sub === "diff") {
          return { code: 0, stdout: ":100644 100644 aaa bbb M\0lib/fork-change.ts\0", stderr: "" };
        }
        if (sub === "checkout") atBase = args[3] === BASE;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "npm" && args.includes("build")) return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git") return { code: 1, stdout: "", stderr: "" };
      // One file re-run alone: by the load-flake absorber at the candidate, or by #D-066 at base.
      const file = args.find((a) => a.endsWith(".test.ts"));
      if (atBase && file && passAtBase.includes(file)) return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: ` FAIL  ${file} > x\n`, stderr: "" };
    };
    return { exec, calls };
  }
  const run = (exec: CheckpointExec) =>
    realCheckpointDeps(cfg, exec, undefined, { retryMax: 0, sleep: async () => {} }).runGreen(
      cpTree,
      BASE,
      { candidate: CAND } as Parameters<CheckpointDeps["runGreen"]>[2],
    );
  const index = (calls: Array<{ cmd: string; args: string[] }>, pred: (c: { cmd: string; args: string[] }) => boolean) =>
    calls.findIndex(pred);
  const lastIndex = (calls: Array<{ cmd: string; args: string[] }>, pred: (c: { cmd: string; args: string[] }) => boolean) =>
    calls.map(pred).lastIndexOf(true);

  it("every failure also fails at base → the legs run AFTER the candidate is restored, and green is not clean", async () => {
    setFork(true);
    const { exec, calls } = forkExec([]);
    const r = await run(exec);
    expect(r.green).toBe(true);
    expect(r.cleanGreen).toBe(false);
    expect(r.failingTests).toEqual([]);
    expect(r.summary).toContain("Inherited test failures");
    expect(r.summary).toContain("lib/upstream-red-a.test.ts");
    const overlay = index(calls, (c) => c.cmd === "git" && c.args[2] === "checkout" && c.args[3] === BASE);
    const restore = index(calls, (c) => c.cmd === "git" && c.args[2] === "checkout" && c.args[3] === CAND);
    const build = index(calls, (c) => c.cmd === "npm" && c.args.includes("build"));
    expect(overlay).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(overlay);
    // The legs a red suite deferred are PAID for, on the restored candidate tree.
    expect(build).toBeGreaterThan(restore);
  });

  it("a file that passes at base is the fork's own failure → red, legs still deferred", async () => {
    setFork(true);
    const { exec, calls } = forkExec(["lib/upstream-red-b.test.ts"]);
    const r = await run(exec);
    expect(r.green).toBe(false);
    expect(r.failingTests).toContain("lib/upstream-red-b.test.ts");
    expect(index(calls, (c) => c.cmd === "npm" && c.args.includes("build"))).toBe(-1);
    // Restored even though the verdict stays red.
    expect(lastIndex(calls, (c) => c.cmd === "git" && c.args[2] === "checkout" && c.args[3] === CAND)).toBeGreaterThan(
      lastIndex(calls, (c) => c.cmd === "git" && c.args[2] === "checkout" && c.args[3] === BASE),
    );
  });

  it("CONTROL: a non-fork pot never reaches the pass — no overlay, red as measured", async () => {
    setFork(false);
    const { exec, calls } = forkExec([]);
    const r = await run(exec);
    expect(r.green).toBe(false);
    expect(index(calls, (c) => c.cmd === "git" && c.args[2] === "checkout")).toBe(-1);
  });
});
