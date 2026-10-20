/**
 * Green-checkpoint orchestration — the advance-only-when-green + FF-only rules
 * are what keep `ready` a trustworthy deployable pin. Real temp repo for the ref
 * logic; stub deps for the (heavy) suite run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linuxProcStateFromStat } from "@papercusp/operator-core/lib/process-identity";
import { buildCheckpointSystemdArgv } from "@papercusp/operator-core/lib/release-checkpoint-launch";
import { frozenLineageRef } from "@papercusp/operator-core/lib/release/repair-head-admission";
import { captureGateSuiteVerdictReplay } from "@papercusp/operator-core/lib/release/gate-hygiene-split";
import {
  runGreenCheckpoint,
  failingRepairLegsForRouting,
  archivePureProofCapture,
  recordDerivedFreezeDispositionWithDeadline,
  runPostVerdictStepWithDeadline,
  POST_VERDICT_DEADLINE_RECORD_BOUND_MS,
  type PostVerdictStepDeadline,
  emitInconclusiveCheckpointVerdict,
  checkpointVerdictSiblingKeys,
  checkpointCandidateProvenance,
  checkpointCandidateSourceFromCli,
  checkpointEvidenceFor,
  normalizeCheckpointMaterializationSelection,
  parseCheckpointMaterializationSelection,
  parseTargetedReVerdictSelection,
  runCmd,
  quietCutSecFromEnv,
  extractFailingTests,
  frozenRepairCapacityHoldSummary,
  authoritativeAffectedFailureSignature,
  extractFailingTestNames,
  extractFailingCasesByFile,
  describeFailingCases,
  validateFailingTestPaths,
  ISOLATION_MAX_NAMED_CASES,
  stripAnsi,
  classifyRedAgainstTip,
  describeRealRedAtTip,
  splitTipFailuresPerFile,
  TIP_SPLIT_MAX_FILES,
  nonTestGateIdsFrom,
  rescueGateIdsFrom,
  fileRescueCovers,
  inferFailingFilesFromEntries,
  parseFailingTaskId,
  isRerunnableGateEntry,
  resolveGateRuns,
  describeSkippedRetriage,
  NON_TEST_GATE_SCRIPTS,
  autoRefireCapFromEnv,
  normaliseFailingKey,
  refireOverlap,
  mergeFailingKeys,
  refireAbsoluteCeiling,
  refireDeadlineExceeded,
  refireRunBudgetMsFromEnv,
  refireBudgetInputs,
  nextRefireOpts,
  MAX_ADMISSION_REFIRE_ATTEMPTS,
  DEFAULT_REFIRE_RUN_BUDGET_MS,
  evaluateDeployStaleness,
  buildGreenCheckpointEnv,
  greenCheckpointCapacityEvidence,
  sanitizeForkNodeOptions,
  GREEN_CHECKPOINT_FORK_HEAP_MB,
  GREEN_CHECKPOINT_POST_SUITE_HEAP_MB,
  GREEN_CHECKPOINT_LOW_MEMORY_LINT_HEAP_MB,
  GREEN_CHECKPOINT_LOW_MEMORY_LINT_BUDGET_MB,
  GREEN_CHECKPOINT_LOW_MEMORY_LINT_MAX_CONCURRENCY,
  runPostSuiteLegs,
  VACUOUS_NEGATIVE_BASELINE_FILE,
  VACUOUS_NEGATIVE_PRE_RATCHET_SKIP_REASON,
  summarizeTargetedPostSuiteLegs,
  checkpointFailureSignature,
  historicalFlakeAnnotations,
  summarizeSuiteOutput,
  parseTestQuarantine,
  applyTestQuarantine,
  isQuarantinedTestFile,
  parseFailingFilesByWorkspace,
  decideFlakeAbsorption,
  decideConcurrencyConfirmation,
  attemptFlakeAbsorption,
  ISOLATION_MAX_FILES,
  ISOLATION_RETRY_MAX,
  ISOLATION_LOAD_STARVATION_MIN_MS,
  ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE,
  isDeterministicFailureShape,
  outputHasTimingSignature,
  outputHasAssertionSignature,
  outputHasDeterministicFailureSignature,
  acquireCheckpointRunLock,
  checkpointRunLockSkipSummary,
  activateCheckpointQualificationRunner,
  checkpointQualificationRunnerRefreshInput,
  scheduledAttemptPinnedCandidate,
  scheduledAttemptPrewarmTarget,
  startCheckpointQualificationProgress,
  checkpointRunIdFromScheduledEnv,
  createCheckpointTerminalEventBuffer,
  emitTerminalCheckpointResult,
  type CheckpointResult,
  checkpointRunLockDir,
  buildTerminationCheckpointResult,
  createTerminationSignalHandler,
  createNormalCheckpointFinalizer,
  armSelfWatchdog,
  checkpointSweepTargets,
  sweepCheckpointSurvivors,
  isWorkerPoolCrash,
  parseCrashedWorkspaces,
  attemptWorkerCrashAbsorption,
  WORKER_CRASH_MAX_WORKSPACES,
  GREEN_CHECKPOINT_MAX_FORKS,
  GREEN_CHECKPOINT_RESERVED_MAX_FORKS,
  SELF_WATCHDOG_MS,
  SELF_WATCHDOG_SIGNED_SHARD_DEADLINE_MS,
  terminalVerdictRecordOptions,
  MANUAL_SELF_WATCHDOG_ENV,
  MIN_MANUAL_SELF_WATCHDOG_MS,
  SUITE_KILL_BUDGET_MIRROR_MS,
  ISOLATION_PHASE_RESERVE_MS,
  isolationPhaseDeadlineMs,
  writeFailingFilesMarker,
  readFailingFilesMarker,
  emergencyRedFailingTests,
  selfWatchdogConfigFromEnv,
  selfWatchdogMsFromEnv,
  formatSelfWatchdogDuration,
  isNothingToGate,
  realCheckpointDeps,
  foldPromotedLineageIntoStaging,
  SETUP_TREE_TIMEOUT_MS,
  SETUP_TREE_HARD_TIMEOUT_MS,
  formatGatePromotionTrailer,
  formatGateHeldByNote,
  formatGateFailureShapeNote,
  recordOrchestratorLine,
  resetOrchestratorLog,
  renderOrchestratorTranscript,
  pipelineName,
  pipelineRef,
  pipelineTag,
  formatGateLineageLine,
  computeGateLineage,
  retireInFlightCandidateAfterResult,
  liveIncumbentAfterAttachConflict,
  ownUnitReservationRunnerIdAfterAttachConflict,
  adoptOwnUnitRunnerReservationAfterAttachConflict,
  ownCgroupUnits,
  runnerUnitIsOwn,
  checkpointQualificationAttachmentRefusalSummary,
  attachRaceSkipSummary,
  matchFailingFilesToChanged,
  unmatchedFailingFiles,
  failingFilesUncommitted,
  detectSplitSourceTestPairs,
  sourceTestSiblingPaths,
  QUIET_CUT_SPLIT_PAIR_DIAGNOSTIC_MAX_CHANGED_FILES,
  type GateLineage,
  type CheckpointDeps,
  type CheckpointExec,
  type FailingFile,
  type IsolationResult,
  type WorkspaceRerunResult,
  // WI-37605: re-exported from green-checkpoint.ts (:961). Used so the persisted-log header
  // assertion resolves the tag instead of hardcoding the production literal.
  orchestratorStdoutTag,
  selectFixerCapacityRows,
  resolveReleaseFixerProvider,
  decideGatePreconditionRetry,
  gatePreconditionRetryDelayMsFromEnv,
  DEFAULT_GATE_PRECONDITION_RETRY_DELAY_MS,
  DEFAULT_REFIRE_RUN_BUDGET_MS,
} from "./green-checkpoint";
import type {
  FrozenRepairBoundedLifeRecord,
  FrozenRepairBoundedLifeState,
} from "@papercusp/operator-core/lib/release/frozen-repair-bounded-life";
import type {
  FrozenRepairCarryRecord,
  FrozenRepairPendingCarry,
} from "@papercusp/operator-core/lib/release/frozen-repair-carry";
import { git, revParse, advanceReady } from "./git-ops";
import {
  gateOperatorPgEnv,
  releaseConfig,
  type GreenCheckpointCapacityMode,
} from "./release-config";
import { formatFailingFilesLine } from "../../../../scripts/lib/vitest-summary.mjs";
import {
  applyPrettierRangeWrites,
  buildPrettierStdinArgs,
  characterRangeForLines,
  REPO_ROOT,
} from "../../../../scripts/check-format.mjs";
import {
  FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
  FROZEN_REPAIR_CONVERGENCE_HOLD_MS,
  frozenRepairHeadAwaitsVerification,
  selectFrozenRepairAdmissionPaths,
  settleFrozenRepairRetestRequest,
  type FrozenCandidateRepairQueue,
} from "@papercusp/operator-core/lib/release/frozen-candidate-repair-queue";
import type { TickFreezeObservation } from "@papercusp/operator-core/lib/release/freeze-disposition";

const testRequire = createRequire(import.meta.url);

it("WI-10003241: a stalled optional freeze disposition cannot retain the checkpoint tree", async () => {
  vi.useFakeTimers();
  try {
    const logs: string[] = [];
    const running = recordDerivedFreezeDispositionWithDeadline(
      () => new Promise(() => {}),
      (line) => logs.push(line),
      30,
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(await running).toBe(false);
    expect(logs).toEqual([
      "derived freeze-disposition write started (deadline 30ms)",
      "derived freeze-disposition write deadline-exceeded in 30ms",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("WI-6554700010009547: a stalled post-verdict step names itself on entry and resolves at its deadline", async () => {
  vi.useFakeTimers();
  try {
    const logs: string[] = [];
    const running = runPostVerdictStepWithDeadline(
      "frozen-repair leg routing",
      () => new Promise(() => {}),
      (line) => logs.push(line),
      40,
    );
    // The entry line is written BEFORE the step is awaited: a run killed mid-stall still
    // names the step it was stuck in.
    expect(logs).toEqual(["frozen-repair leg routing started (deadline 40ms)"]);
    await vi.advanceTimersByTimeAsync(40);
    expect(await running).toBe(false);
    expect(logs).toEqual([
      "frozen-repair leg routing started (deadline 40ms)",
      "frozen-repair leg routing deadline-exceeded in 40ms",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

it("WI-6554700010010213: a post-verdict deadline overrun is recorded once, not only logged", async () => {
  vi.useFakeTimers();
  try {
    const recorded: PostVerdictStepDeadline[] = [];
    const running = runPostVerdictStepWithDeadline(
      "frozen-repair leg routing",
      () => new Promise(() => {}),
      () => {},
      40,
      async (info) => {
        recorded.push(info);
      },
    );
    await vi.advanceTimersByTimeAsync(40);
    expect(await running).toBe(false);
    expect(recorded).toEqual([
      { label: "frozen-repair leg routing", deadlineMs: 40, elapsedMs: 40 },
    ]);

    // A step that completes in time records nothing.
    const quiet: PostVerdictStepDeadline[] = [];
    expect(
      await runPostVerdictStepWithDeadline(
        "derived freeze-disposition write",
        async () => {},
        () => {},
        40,
        async (info) => {
          quiet.push(info);
        },
      ),
    ).toBe(true);
    expect(quiet).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("WI-6554700010010213: a hung deadline recorder cannot re-hang the post-verdict step", async () => {
  vi.useFakeTimers();
  try {
    const logs: string[] = [];
    let settled = false;
    const running = recordDerivedFreezeDispositionWithDeadline(
      () => new Promise(() => {}),
      (line) => logs.push(line),
      30,
      () => new Promise(() => {}),
    ).then((completed) => {
      settled = true;
      return completed;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(POST_VERDICT_DEADLINE_RECORD_BOUND_MS);
    expect(await running).toBe(false);
    expect(logs).toEqual([
      "derived freeze-disposition write started (deadline 30ms)",
      "derived freeze-disposition write deadline-exceeded in 30ms",
      `derived freeze-disposition write deadline record did not finish within ${POST_VERDICT_DEADLINE_RECORD_BOUND_MS}ms; abandoned`,
    ]);
  } finally {
    vi.useRealTimers();
  }
});

let repo: string;
async function commit(
  file: string,
  content: string,
  msg: string,
): Promise<string> {
  const full = join(repo, file);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "--no-verify", "-q", "-m", msg]);
  return revParse(repo, "HEAD");
}

describe('P-014 replay before gate mutation', () => {
  it('captures an exhausted frozen queue verdict that returns before any canonical suite', async () => {
    const frozen = await commit('candidate.txt', 'candidate', 'candidate');
    const { createFrozenCandidateRepairQueue } = await import('@papercusp/operator-core/lib/release/frozen-candidate-repair-queue');
    const queue = { ...createFrozenCandidateRepairQueue({ candidate: frozen, base: null,
      failingTests: ['product.test.ts'], nowMs: Date.now() }), phase: 'blocked' as const,
      blockedReason: 'attempts-exhausted' as const, attempts: 3 };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async () => {};
    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(result.reason).toBe('repair-in-progress');
    expect(result.suiteVerdictReplay).toMatchObject({ suiteMeasured: false,
      decisions: expect.arrayContaining([expect.objectContaining({ kind: 'frozen-queue' })]) });
    expect(calls).not.toContain('runGreen');
  });

  it('a downstream hold mismatch stops before setup and promotion even when the suite still agrees', async () => {
    const snapshot = prior();
    snapshot.decisions!.push({ kind: 'post-gate-action', args: ['block'], expected: false });
    const { deps, calls } = stubDeps(true); deps.readLastSuiteVerdictReplay = async () => snapshot;
    const result = await runGreenCheckpoint(cfg(), deps);
    expect(result.suiteReplayCanary).toMatchObject({ status: 'mismatch', detail: expect.stringContaining('post-gate-action') });
    expect(calls).toEqual([]);
  });

  it('retains a performance hold observation in the measured verdict snapshot', async () => {
    await commit('candidate.txt', 'candidate', 'candidate');
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async () => ({ action: 'block', summary: 'recorded perf block' });
    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(result.reason).toBe('perf-held');
    expect(result.suiteVerdictReplay?.decisions).toContainEqual({ kind: 'post-gate-action', args: ['block'], expected: true });
    expect(calls).not.toContain('advance');
  });
  const prior = () => captureGateSuiteVerdictReplay({ candidate: 'a'.repeat(40), runId: 'prior', measuredAtMs: 1 }, {
    green: false, infraFault: false, failures: ['product.test.ts'], rootScripts: {}, failingCasesByFile: null,
  });

  it('a changed historical verdict reaches neither setup, suite, nor promotion', async () => {
    const snapshot = prior(); snapshot.expected.disposition = 'green';
    const { deps, calls } = stubDeps(true);
    deps.readLastSuiteVerdictReplay = async () => snapshot;
    const result = await runGreenCheckpoint(cfg(), deps, { candidateHint: 'b'.repeat(40) });
    expect(result).toMatchObject({ advanced: false, green: null, reason: 'infra-inconclusive',
      candidate: 'b'.repeat(40), suiteReplayCanary: { status: 'mismatch' } });
    expect(result.failingTests).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('unavailable replay history stays inconclusive without blaming product tests', async () => {
    const { deps, calls } = stubDeps(true);
    deps.readLastSuiteVerdictReplay = async () => { throw new Error('history unavailable'); };
    const result = await runGreenCheckpoint(cfg(), deps);
    expect(result).toMatchObject({ advanced: false, green: null, suiteReplayCanary: { status: 'unreadable' } });
    expect(calls).toEqual([]);
  });

  it('keeps pinned provenance and the owning fire identity on an early replay rejection', async () => {
    const snapshot = prior(); snapshot.expected.disposition = 'green';
    const { deps, calls } = stubDeps(true);
    deps.readLastSuiteVerdictReplay = async () => snapshot;
    deps.gateFireId = 'replay-fixture-fire';
    const result = await runGreenCheckpoint(cfg(), deps, { candidate: 'b'.repeat(40), candidateSource: 'pinned' });
    expect(result).toMatchObject({ candidateSource: 'pinned', gateFireId: 'replay-fixture-fire',
      advanced: false, green: null, suiteReplayCanary: { status: 'mismatch' } });
    expect(calls).toEqual([]);
  });

  it('a matched replay permits the ordinary gate and captures its new observations', async () => {
    await commit('candidate.txt', 'candidate', 'candidate');
    const { deps, calls } = stubDeps(true);
    deps.readLastSuiteVerdictReplay = async () => prior();
    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(calls).toContain('runGreen');
    expect(result.suiteReplayCanary?.status).toBe('passed');
    expect(result.suiteVerdictReplay).toMatchObject({ version: 1, candidate: result.candidate,
      input: { green: true, failures: [] }, expected: { disposition: 'green' } });
  });

  it('legacy history bootstraps from a real measurement rather than a canned verdict', async () => {
    await commit('candidate.txt', 'candidate', 'candidate');
    const { deps } = stubDeps(true); deps.readLastSuiteVerdictReplay = async () => null;
    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(result.suiteReplayCanary?.status).toBe('bootstrap');
    expect(result.suiteVerdictReplay?.expected.disposition).toBe('green');
  });
});

function stubDeps(
  green: boolean,
  failingTests?: string[],
  flakeSuspects?: string[],
): { deps: CheckpointDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: CheckpointDeps = {
    setupTree: async (ref) => {
      calls.push(`setup:${ref.slice(0, 7)}`);
    },
    runGreen: async () => {
      calls.push("runGreen");
      return {
        green,
        summary: green ? "all pass" : "3 failed",
        failingTests,
        flakeSuspects,
      };
    },
    advance: (candidate) => {
      calls.push("advance");
      return advanceReady(repo, candidate, "ready");
    },
    push: async () => {
      calls.push("push");
    },
    broadcast: async () => {
      calls.push("broadcast");
    },
    escalate: async () => {
      calls.push("escalate");
    },
    clearEscalation: async () => {
      calls.push("clearEscalation");
    },
    emitEvent: async ({ key }) => {
      // EI-10800 regression guard: hop a microtask before recording. If a call site does NOT
      // await the emit (the original fire-and-forget `void import(...)` bug), this push lands
      // AFTER runGreenCheckpoint has already resolved — so the `calls`-contains assertion below
      // fails, catching exactly the "green advance never woke its awaiter" regression.
      await Promise.resolve();
      calls.push(`emit:${key}`);
    },
    log: () => {},
  };
  return { deps, calls };
}

/** P-003: the one repair-signature kind that legitimately enters the full canonical gate.
 * Orchestration tests below use it when their subject starts at `runGreen`; a workspace-less
 * test-file fixture would now (correctly) hold as unavailable before reaching that subject. */
function postSuiteSignature(measuredHead: string) {
  return [
    {
      kind: "post-suite-leg" as const,
      id: "@papercusp/operator-vite",
      recipe: "npm --workspace @papercusp/operator-vite run build",
      admittedRound: 1,
      measuredHead,
    },
  ];
}

describe("EI-210512: green-checkpoint disk-headroom preflight", () => {
  it("refuses before setupTree or runGreen when /tmp cannot absorb the suite", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    deps.checkDiskHeadroom = async () => ({
      ok: false,
      summary: "/tmp 5.7 GiB free; low-bytes breaches the gate floor",
    });

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      from: ready,
      green: null,
      reason: "disk-headroom",
    });
    expect(result.summary).toContain("5.7 GiB free");
    expect(calls).not.toContain("runGreen");
    expect(calls.some((call) => call.startsWith("setup:"))).toBe(false);
    expect(calls).not.toContain("advance");
  });

  it("continues normally when the same preflight reports safe headroom", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    deps.checkDiskHeadroom = async () => ({
      ok: true,
      summary: "/tmp 356.0 GiB free",
    });

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({ green: true, reason: "advanced" });
    expect(calls.some((call) => call.startsWith("setup:"))).toBe(true);
    expect(calls).toContain("runGreen");
  });
});

// green-main-cycle-time-2026-10-08 P-022: a typed setup-precondition refusal (no verdict) is
// retried ONCE in-process after a short delay instead of idling until the next hourly tick.
// Measured 2026-10-12: four consecutive fires refused on headroom, each mid-setup (exit 77
// thrown from setupTree after the preflight passed), and each waited an hour for the next tick.
describe("P-022: one bounded short-delay retry after a typed precondition refusal", () => {
  const MIN = 60_000;
  const exit77 = () =>
    new Error(
      "bash /repo/apps/operator/bin/release/dependency-generation.sh exited 77: " +
        "[dependency-generation] DEPENDENCY_GENERATION_HEADROOM_INSUFFICIENT need=0 avail=1 required=2",
    );
  const exit76 = () =>
    new Error(
      "bash /repo/apps/operator/bin/release/dependency-generation.sh exited 76: " +
        "[dependency-generation] DEPENDENCY_GENERATION_LOCK_TIMEOUT waited=600s",
    );
  /** Wires the retry seams onto stub deps and records every seam call in `calls`. */
  const withRetrySeams = (deps: CheckpointDeps, calls: string[], delayMs = 5 * MIN) => {
    const slept: number[] = [];
    const logs: string[] = [];
    deps.preconditionRetryDelayMs = delayMs;
    deps.preconditionRetrySleep = async (ms) => {
      slept.push(ms);
      calls.push(`sleep:${ms}`);
    };
    deps.reclaimDependencyHeadroom = async () => {
      calls.push("reclaim");
      return "dependency retention complete: 3/3 store(s) pruned; free 49.93 → 61.20 GiB";
    };
    const log = deps.log;
    deps.log = (line) => {
      logs.push(line);
      log(line);
    };
    return { slept, logs };
  };
  const seed = async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    return { ready, candidate };
  };

  it("a preflight headroom refusal returns before any setup work, then reclaims, waits and retries exactly once", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    const { slept } = withRetrySeams(deps, calls);
    let probes = 0;
    deps.checkDiskHeadroom = async () => {
      probes += 1;
      calls.push(`headroom:${probes}`);
      return probes === 1
        ? { ok: false, blocker: "disk-headroom", summary: "dependency copy cannot start: HEADROOM_INSUFFICIENT" }
        : { ok: true, summary: "dependency-copy headroom ok" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });

    expect(result).toMatchObject({ green: true, reason: "advanced" });
    expect(result.preconditionRetry).toMatchObject({
      blocker: "disk-headroom",
      delayMs: 5 * MIN,
      firstSummary: "dependency copy cannot start: HEADROOM_INSUFFICIENT",
    });
    expect(result.preconditionRetry?.cleanup).toContain("3/3 store(s) pruned");
    expect(probes).toBe(2);
    // Refusal BEFORE setup: nothing materializes until the retried pass's own preflight passes.
    const firstSetup = calls.findIndex((c) => c.startsWith("setup:"));
    expect(firstSetup).toBeGreaterThan(calls.indexOf("headroom:2"));
    expect(calls.indexOf("reclaim")).toBeLessThan(calls.indexOf("headroom:2"));
    expect(calls.filter((c) => c === "reclaim")).toHaveLength(1);
    // The wait is chunked so liveness is reported at least every minute; it sums to the delay.
    expect(slept.every((ms) => ms <= MIN)).toBe(true);
    expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * MIN);
    expect(slept.reduce((a, b) => a + b, 0)).toBeGreaterThan(4 * MIN);
  });

  it("a second refusal in the same run is final: no further retry, the refusal is reported", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    const { logs } = withRetrySeams(deps, calls);
    let probes = 0;
    deps.checkDiskHeadroom = async () => {
      probes += 1;
      return { ok: false, summary: `still short (${probes})` };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });

    expect(result).toMatchObject({ green: null, reason: "disk-headroom", summary: "still short (2)" });
    expect(result.preconditionRetry).toMatchObject({ blocker: "disk-headroom", firstSummary: "still short (1)" });
    expect(probes).toBe(2);
    expect(calls.filter((c) => c === "reclaim")).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("setup:"))).toBe(false);
    expect(calls).not.toContain("runGreen");
    expect(logs.some((l) => l.includes("GATE_PRECONDITION_RETRY skipped blocker=disk-headroom reason=bound-exhausted"))).toBe(true);
  });

  it("setup's own exit 77 thrown mid-materialization is retried once, with retention reclaim", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    withRetrySeams(deps, calls);
    const setup = deps.setupTree;
    let setups = 0;
    deps.setupTree = async (ref, options) => {
      setups += 1;
      if (setups === 1) throw exit77();
      return setup(ref, options);
    };

    const result = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });

    expect(result).toMatchObject({ green: true, reason: "advanced" });
    expect(result.preconditionRetry?.blocker).toBe("disk-headroom");
    expect(result.preconditionRetry?.firstSummary).toContain("exit 77");
    expect(setups).toBe(2);
    expect(calls.filter((c) => c === "reclaim")).toHaveLength(1);
  });

  it("setup's exit 76 (copy lock) is retried once WITHOUT disk reclaim; a second one propagates to the crash handler", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    withRetrySeams(deps, calls);
    let setups = 0;
    deps.setupTree = async () => {
      setups += 1;
      throw exit76();
    };

    await expect(runGreenCheckpoint(cfg(), deps, { candidate, noPush: true })).rejects.toThrow(/exited 76/);
    expect(setups).toBe(2);
    expect(calls).not.toContain("reclaim");
    expect(calls.some((c) => c.startsWith("sleep:"))).toBe(true);
  });

  it("a wedged copy lock at preflight is classified like setup's exit 76 and retried without reclaim", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    withRetrySeams(deps, calls);
    let probes = 0;
    deps.checkDiskHeadroom = async () => {
      probes += 1;
      return { ok: false, blocker: "copy-lock", summary: "DEPENDENCY_GENERATION_LOCK_BUSY state=wedged" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });

    expect(result).toMatchObject({ green: null, reason: "infra-inconclusive", preconditionBlocker: "copy-lock" });
    expect(result.preconditionRetry?.cleanup).toBe("not run (copy-lock refusal)");
    expect(probes).toBe(2);
    expect(calls).not.toContain("reclaim");
  });

  it("does not retry when the delay plus a full pass would overrun the run budget", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    const { logs } = withRetrySeams(deps, calls);
    deps.checkDiskHeadroom = async () => ({ ok: false, summary: "short" });

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
      runStartedAtMs: Date.now() - 60 * MIN,
    });

    expect(result).toMatchObject({ green: null, reason: "disk-headroom" });
    expect(result.preconditionRetry).toBeUndefined();
    expect(calls).not.toContain("reclaim");
    expect(logs.some((l) => l.includes("reason=deadline"))).toBe(true);
  });

  it("a caller that supplies no retry delay keeps the historical single-pass refusal", async () => {
    const { candidate } = await seed();
    const { deps, calls } = stubDeps(true);
    let probes = 0;
    deps.checkDiskHeadroom = async () => {
      probes += 1;
      return { ok: false, summary: "short" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { candidate, noPush: true });

    expect(result).toMatchObject({ green: null, reason: "disk-headroom", preconditionBlocker: "disk-headroom" });
    expect(result.preconditionRetry).toBeUndefined();
    expect(probes).toBe(1);
    expect(calls.some((c) => c.startsWith("setup:"))).toBe(false);
  });

  it("decideGatePreconditionRetry bounds: verdict, blocker, attempt count and run budget", () => {
    const base = { retriesSoFar: 0, elapsedMs: 0, delayMs: 5 * MIN, budgetMs: DEFAULT_REFIRE_RUN_BUDGET_MS };
    expect(decideGatePreconditionRetry({ ...base, result: { green: null, preconditionBlocker: "disk-headroom" } }))
      .toEqual({ retry: true, blocker: "disk-headroom" });
    expect(decideGatePreconditionRetry({ ...base, result: { green: null } }))
      .toEqual({ retry: false, reason: "no-blocker" });
    // A rendered verdict is never retried, whatever it is stamped with.
    expect(decideGatePreconditionRetry({ ...base, result: { green: false, preconditionBlocker: "copy-lock" } }))
      .toEqual({ retry: false, reason: "no-blocker" });
    expect(decideGatePreconditionRetry({ ...base, retriesSoFar: 1, result: { green: null, preconditionBlocker: "copy-lock" } }))
      .toEqual({ retry: false, reason: "bound-exhausted" });
    // 110 min budget: 45 min elapsed + 5 min delay + 60 min full pass fits exactly; 46 does not.
    expect(decideGatePreconditionRetry({ ...base, elapsedMs: 45 * MIN, result: { green: null, preconditionBlocker: "disk-headroom" } }).retry)
      .toBe(true);
    expect(decideGatePreconditionRetry({ ...base, elapsedMs: 46 * MIN, result: { green: null, preconditionBlocker: "disk-headroom" } }))
      .toEqual({ retry: false, reason: "deadline" });
  });

  it("the retry delay defaults to 5 minutes and accepts only a finite non-negative override", () => {
    expect(DEFAULT_GATE_PRECONDITION_RETRY_DELAY_MS).toBe(5 * MIN);
    expect(gatePreconditionRetryDelayMsFromEnv({})).toBe(5 * MIN);
    expect(gatePreconditionRetryDelayMsFromEnv({ PAPERCUSP_GATE_PRECONDITION_RETRY_DELAY_MS: "90000" })).toBe(90_000);
    expect(gatePreconditionRetryDelayMsFromEnv({ PAPERCUSP_GATE_PRECONDITION_RETRY_DELAY_MS: "0" })).toBe(0);
    expect(gatePreconditionRetryDelayMsFromEnv({ PAPERCUSP_GATE_PRECONDITION_RETRY_DELAY_MS: "-1" })).toBe(5 * MIN);
    expect(gatePreconditionRetryDelayMsFromEnv({ PAPERCUSP_GATE_PRECONDITION_RETRY_DELAY_MS: "soon" })).toBe(5 * MIN);
  });
});

describe("EI-21228180621817003: safe scoped format writes", () => {
  it("does not publish Prettier's invalid `};)` range result", () => {
    const source = [
      'describe("suite", () => {',
      '  it("first", async () => {',
      "    // changed",
      "    const value = await foo();",
      "  });",
      "",
      '  it("second", () => {',
      "    // changed",
      "    const other = 2;",
      "  });",
      "});",
      "",
    ].join("\n");
    const ranges = [
      { startLine: 3, endLine: 4 },
      { startLine: 8, endLine: 9 },
    ];
    const prettierCli = testRequire.resolve("prettier/bin/prettier.cjs", {
      paths: [REPO_ROOT],
    });
    const formatRange = (
      current: string,
      range: { start: number; end: number },
    ) => {
      const result = spawnSync(
        process.execPath,
        buildPrettierStdinArgs(prettierCli, "fixture.ts", range),
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          input: current,
        },
      );
      if (result.error || result.status !== 0) {
        throw result.error ?? new Error(result.stderr || "Prettier failed");
      }
      return result.stdout;
    };

    const unsafe = formatRange(
      source,
      characterRangeForLines(source, ranges[0]),
    );
    expect(unsafe).toContain("};)");

    const formatted = applyPrettierRangeWrites(
      source,
      ranges,
      formatRange,
      "fixture.ts",
    );
    expect(formatted).toBe(source);
    expect(formatted).not.toContain("};)");
  });
});

/**
 * WI-479091 — longest-green-prefix salvage must be REACHABLE, not merely present.
 *
 * D-067 promises that a real red reaches longest-proven-green-prefix salvage so `main`
 * can advance without weakening coverage. It did not. `deferNewRepairDispatch`
 * (green-checkpoint.ts:9127-9128) gates the ONLY salvage site (:9902) on
 * `repairQueueCreatedThisPass && !opts.candidate`, and that flag is assigned true only
 * inside queue-CREATION branches (:8345, :9125). So once a repair queue EXISTS, the red
 * path returns terminal at :9209 — under a summary that literally reads "Moving-tip
 * refire and backward prefix salvage were suppressed." — and salvage never runs.
 *
 * Measured consequence when this guard was written: `main` frozen 7d19h at the
 * 2026-08-20 green pin, 6,969 commits behind staging, red streak 50 -> 57, and salvage
 * had advanced `main` ZERO times. Salvage is default-ON
 * (`partialGreenGateEnabledFromEnv`, :6505-6513), so the fault was never configuration.
 *
 * WHY THIS ASSERTS REACHABILITY AND NOT EXISTENCE: an existence-only assertion — "the
 * salvage helper is defined", "the partial-green code is present" — passes today against
 * completely inert code. That is precisely how this survived a 15/15, 48-citation
 * completion audit and a plan decision (D-108) asserting it was already fixed. The probe
 * below is the log the salvage DECISION POINT emits, so it can only pass if control flow
 * actually arrives there.
 *
 * The first test is a CALIBRATION CONTROL, not a duplicate: it exercises the one path
 * that DID reach salvage (a red with no pre-existing queue). If it ever fails, the
 * harness can no longer observe salvage at all and the second test's failure means
 * nothing. Keep both — a guard whose instrument is unverified is not a guard.
 */
describe("WI-479091: longest-green-prefix salvage reachability", () => {
  /** The salvage decision point announces itself on every arm — attempt AND each skip. */
  const reachedSalvageDecision = (logs: readonly string[]): boolean =>
    logs.some((line) => line.includes("partial-green-gate"));

  it("CALIBRATION: a red with no pre-existing queue reaches the salvage decision point", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    await commit("b", "2", "candidate");
    const logs: string[] = [];
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.log = (line: string) => {
      logs.push(line);
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(
      reachedSalvageDecision(logs),
      `instrument check failed: no "partial-green-gate" line on the path that is SUPPOSED to salvage. ` +
        `The probe below cannot be trusted until this passes. Logs seen: ${JSON.stringify(logs)}`,
    ).toBe(true);
  });

  it("a red against a PRE-EXISTING repair queue still reaches the salvage decision point", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    // phase "ready-to-test" yields decision.kind === "test-candidate" (:7993-7995), which
    // sets initialCandidateVerification and routes the red into the :9100 branch — the
    // pre-existing-queue arm that leaves repairQueueCreatedThisPass false.
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const logs: string[] = [];
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.log = (line: string) => {
      logs.push(line);
    };
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    // All three must be wired or the :9087 repair branch is skipped entirely and this
    // test would pass for the wrong reason.
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "fixer",
      runId: "run",
    });

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(
      reachedSalvageDecision(logs),
      `salvage was never reached on a red against an existing queue — the run returned ` +
        `terminal upstream of :9902, so main can never advance while a queue is open. ` +
        `Logs seen: ${JSON.stringify(logs)}`,
    ).toBe(true);
  });

  it("WI-10001752: a ready-to-test row whose candidate IS the release pin verifies its repairHead instead of short-circuiting up-to-date", async () => {
    // The deadlock this guards. `markFrozenRepairAdmitted` deliberately keeps a `ready-to-test`
    // row at `ready-to-test` after an admission, so the gate re-decides `test-candidate` and
    // judges `queue.candidate`. When that candidate IS `cfg.releaseRef`, the `candidate ===
    // lastReady` check returns `up-to-date` BEFORE any suite — every tick, forever. `attempts`
    // stays 0, the admitted repairHead is never judged, and main can never advance.
    const pin = await commit("a", "1", "pin");
    await git(repo, ["branch", "ready", pin]);
    // The admitted fix, stacked on the frozen lineage exactly as `op:'admit'` leaves it.
    const repaired = await commit("b", "2", "admitted fix");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: pin, // === lastReady: this is the whole defect
      base: pin,
      repairHead: repaired,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      // The real deadlocked row's shape (papercusp 2026-09-17): no recorded failure signature,
      // so the repair round resolves to `full-run-required` and the FULL gate judges the head.
      failingTests: [],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line: string) => {
      logs.push(line);
    };
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // The discriminator: did the gate actually SPEND a suite on the admitted head? A run that
    // returns without one is the livelock, however healthy its verdict fields read.
    expect(
      calls.filter((c) => c === "runGreen").length,
      `no suite ran: the frozen row re-decided test-candidate on a candidate that equals ` +
        `${"ready"}, so the up-to-date short-circuit returned first. ` +
        `calls=${JSON.stringify(calls)} reason=${result.reason} logs=${JSON.stringify(logs)}`,
    ).toBeGreaterThan(0);
    expect(result.reason).not.toBe("up-to-date");
    // The unreachable phase must actually be discharged in the durable row, or the next tick
    // livelocks again exactly as before.
    expect(
      queue?.phase,
      `the row is still ready-to-test, so the livelock survives this run. ` +
        `reason=${result.reason} candidate=${result.candidate?.slice(0, 8)} ` +
        `pin=${pin.slice(0, 8)} repaired=${repaired.slice(0, 8)} ` +
        `logs=${JSON.stringify(logs)}`,
    ).not.toBe("ready-to-test");
  });

  it("WI-10001752 control: a ready-to-test row whose candidate is NOT the pin still tests the candidate", async () => {
    // Calibration for the probe above: the ordinary ready-to-test path must be untouched, or
    // the guard would be indistinguishable from "always verify the repairHead".
    const pin = await commit("a", "1", "pin");
    await git(repo, ["branch", "ready", pin]);
    const frozen = await commit("b", "2", "frozen candidate");
    const repaired = await commit("c", "3", "admitted fix");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: frozen, // !== lastReady — the normal case
      base: pin,
      repairHead: repaired,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const { deps } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.candidate).toBe(frozen);
  });

  it("WI-2141375: a peer's mid-suite converge is NOT clobbered by the red-transition write", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    const convergedHead = await commit("c", "3", "peer converged this in");
    // The pre-suite snapshot: repairHead === candidate, exactly as read before the (in this
    // test, instant) suite starts.
    const staleQueue: FrozenCandidateRepairQueue = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    let reads = 0;
    let queue: FrozenCandidateRepairQueue | null = staleQueue;
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.readFrozenRepairQueue = async () => {
      reads += 1;
      // First read: the pre-suite snapshot (repairHead === candidate). Simulate a peer's
      // `release:repair-queue{op:'converge'}` landing on the PERSISTED row, mid-suite,
      // before the second (red-transition) read.
      if (reads === 1) return staleQueue;
      return { ...staleQueue, repairHead: convergedHead, updatedAtMs: now };
    };
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "fixer",
      runId: "run",
    });

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(queue).toMatchObject({
      phase: "awaiting-fixer",
      candidate: frozen,
      // The whole point: the converged repairHead survives the red transition instead of
      // being reset back to the stale pre-suite candidate.
      repairHead: convergedHead,
    });
  });

  it("WI-2141375: falls back to the pre-suite snapshot when the re-read can't be trusted", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    const staleQueue: FrozenCandidateRepairQueue = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    let queue: FrozenCandidateRepairQueue | null = staleQueue;
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    // The re-read comes back null (a genuine read fault, or the queue was concurrently
    // retired) — the write must fall back to the in-memory snapshot, never crash or drop
    // the red transition entirely.
    let reads = 0;
    deps.readFrozenRepairQueue = async () => {
      reads += 1;
      return reads === 1 ? staleQueue : null;
    };
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "fixer",
      runId: "run",
    });

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(queue).toMatchObject({
      phase: "awaiting-fixer",
      candidate: frozen,
      repairHead: frozen,
    });
  });

  it("P-013: the terminal handler routes the failing legs of the queue the tick ended holding", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-test",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "fixer",
      runId: "run",
    });
    const route = vi.fn(async (_input: unknown) => undefined);
    deps.routeFrozenRepairLegsToAgents = route;

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(route).toHaveBeenCalled();
    expect(route.mock.calls.at(-1)?.[0]).toMatchObject({
      pipeline: expect.any(String),
      queue: {
        candidate: frozen,
        repairHead: frozen,
        failingTests: ["lib/broken.test.ts"],
      },
    });
  });

  it("P-013: a same-head passing repair-tick leg is not routed as a claimable repair", () => {
    const contradicted = "@papercusp/papercusp-docs :: test";
    const head = "a".repeat(40);
    const failingTests = [contradicted];
    const routed = failingRepairLegsForRouting(
      { repairHead: head, failingTests },
      {
        head,
        atMs: 1_000,
        ok: true,
        failingSignatures: [],
        legs: [{ id: contradicted, status: "pass", durationMs: 1 }],
      },
    );

    expect(failingTests).toEqual([contradicted]);
    expect(routed).toEqual([]);
  });

  it("P-013: only same-head contradicted entries are removed from mixed repair routing", () => {
    const contradicted = "@papercusp/papercusp-docs :: test";
    const realRed = "packages/operator-core/lib/release/foo.test.ts";
    const head = "b".repeat(40);

    expect(
      failingRepairLegsForRouting(
        { repairHead: head, failingTests: [contradicted, realRed] },
        {
          head,
          atMs: 2_000,
          ok: false,
          failingSignatures: [],
          legs: [{ id: contradicted, status: "pass", durationMs: 1 }],
        },
      ),
    ).toEqual([realRed]);
  });

  it("P-013: a same-head passing hold-tick leg is omitted from routing but retained in the queue", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const contradicted = "@papercusp/papercusp-docs :: test";
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "live-fixer",
      failingTests: [contradicted],
      signature: [],
    };
    const { deps } = stubDeps(false, [contradicted]);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => true;
    const tick = vi.fn(async () => ({
      head: frozen,
      atMs: now,
      ok: true,
      failingSignatures: [],
      legs: [{ id: contradicted, status: "pass" as const, durationMs: 1 }],
    }));
    deps.runRepairTickLegs = tick;
    const route = vi.fn(async (_input: unknown) => undefined);
    deps.routeFrozenRepairLegsToAgents = route;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.reason).toBe("repair-in-progress");
    expect(tick).toHaveBeenCalled();
    expect(route).toHaveBeenCalled();
    expect(route.mock.calls.at(-1)?.[0]).toMatchObject({
      queue: {
        candidate: frozen,
        repairHead: frozen,
        failingTests: [],
      },
    });
    expect(queue?.failingTests).toEqual([contradicted]);
  });

  it("P-013: a green tick routes queue:null so every open leg item resolves", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const route = vi.fn(async (_input: unknown) => undefined);
    deps.routeFrozenRepairLegsToAgents = route;

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result.green).toBe(true);
    expect(route).toHaveBeenCalled();
    expect(route.mock.calls.at(-1)?.[0]).toMatchObject({ queue: null });
  });

  it("WI-6554700010009547: leg routing runs through the bounded, entry-logged post-verdict step", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.routeFrozenRepairLegsToAgents = async () => {
      throw new Error("condition bridge down");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    // A routing failure stays non-fatal, and the step is attributable from the run log.
    expect(result.green).toBe(true);
    expect(logs).toContain(
      "frozen-repair leg routing started (deadline 60000ms)",
    );
    expect(logs).toContain(
      "frozen-repair leg routing failed: condition bridge down",
    );
  });

  it("WI-6554700010009615: the return funnel enters the post-verdict phase before its post-verdict steps", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const order: string[] = [];
    deps.enterPostVerdictPhase = () => {
      order.push("enter");
    };
    deps.recordDerivedFreezeDisposition = async () => {
      order.push("disposition");
    };
    deps.routeFrozenRepairLegsToAgents = async () => {
      order.push("route");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result.green).toBe(true);
    expect(order).toEqual(["enter", "disposition", "route"]);
  });

  it("WI-6554700010009615: a throwing post-verdict hook is logged and never fails the tick", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.enterPostVerdictPhase = () => {
      throw new Error("watchdog gone");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result.green).toBe(true);
    expect(logs).toContain("warn: post-verdict watchdog tighten failed: watchdog gone");
  });
});

describe("WI-39944: serialized frozen-candidate repair orchestration", () => {
  it("P-025: a newer-schema queue fails closed before setup/suite and reaches the disposition backstop", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const setupTree = vi.fn(async () => undefined);
    const runGreen = vi.fn(async () => ({
      green: true,
      summary: "must not run",
    }));
    let observation: TickFreezeObservation | null = null;
    deps.setupTree = setupTree;
    deps.runGreen = runGreen;
    deps.readFrozenRepairQueueState = async () => ({
      status: "unreadable",
      reason: "schema-newer-than-reader",
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
    });
    deps.recordDerivedFreezeDisposition = async (value) => {
      observation = value;
    };
    // P-013: an unreadable queue is NOT "no queue" — routing it as null would resolve
    // every open leg item on a read fault, so the terminal handler must skip routing.
    const routeLegs = vi.fn(async (_input: unknown) => undefined);
    deps.routeFrozenRepairLegsToAgents = routeLegs;

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });
    expect(routeLegs).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      advanced: false,
      green: null,
      reason: "infra-inconclusive",
      repairQueueRead: {
        status: "unreadable",
        reason: "schema-newer-than-reader",
        schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION + 1,
      },
    });
    expect(result.summary).toContain(
      "refusing to conclude that no candidate is frozen",
    );
    expect(setupTree).not.toHaveBeenCalled();
    expect(runGreen).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      repairQueue: null,
      repairQueueRead: { status: "unreadable" },
    });
  });

  it("classifies a thrown legacy frozen-queue read as transient inconclusive", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    const setupTree = vi.fn(async () => undefined);
    const runGreen = vi.fn(async () => ({ green: true, summary: "must not run" }));
    deps.setupTree = setupTree;
    deps.runGreen = runGreen;
    deps.readFrozenRepairQueue = async () => {
      throw new Error("chunkStoreVectorColumns is not defined");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      green: null,
      reason: "infra-inconclusive",
    });
    expect(result.summary).toContain(
      "frozen repair queue read failed — refusing to cut a moving candidate",
    );
    expect(setupTree).not.toHaveBeenCalled();
    expect(runGreen).not.toHaveBeenCalled();
  });

  it("persists the immutable candidate before setup or its first suite", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    let queue: FrozenCandidateRepairQueue | null = null;
    const trace: string[] = [];
    const persisted: Array<FrozenCandidateRepairQueue | null> = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      trace.push(`write:${next?.phase ?? "clear"}`);
      persisted.push(next);
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("a green initial candidate must not dispatch a fixer");
    };
    deps.setupTree = async (ref) => {
      trace.push("setup");
      calls.push(`setup:${ref.slice(0, 7)}`);
    };
    deps.runGreen = async () => {
      trace.push("suite");
      calls.push("runGreen");
      return { green: true, summary: "all pass" };
    };
    deps.qualificationAttemptId = "qualification-attempt-1";

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: true,
      candidate,
      green: true,
      reason: "advanced",
    });
    expect(trace).toEqual([
      "write:ready-to-test",
      "setup",
      "suite",
      "write:clear",
    ]);
    expect(persisted[0]).toMatchObject({
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: "ready-to-test",
      candidate,
      qualificationAttemptId: "qualification-attempt-1",
      repairHead: candidate,
      base: ready,
      attempts: 0,
    });
    expect(queue).toBeNull();
  });

  it("P-024: a first red freezes at once — the queue row written this pass pins re-triage to the lineage head, so the moving tip is never re-run or refired on (deferred dispatch still settles)", async () => {
    // Formerly WI-39944 "defers automatic first-red fixer dispatch until stale-tip re-triage":
    // the deferral is kept (no fixer is dispatched before the re-triage window), but the window
    // itself no longer judges the integration tip. frozen-candidate-stays-frozen-through-all-fixes
    // D-003/D-011/D-014: a persisted row is a freeze from the moment it is written — peers already
    // see it and admit onto it — so a tip re-run + refire here was the fourth un-freezing path
    // (WI-2144110). A stale first red is repaired by ADMITTING the staging fix by path (the
    // already-fixed note names it), never by re-cutting at tip.
    vi.stubEnv("PAPERCUSP_QUIET_CUT", "0");
    vi.stubEnv("PAPERCUSP_GATE_AUTO_REFIRE_CAP", "0");
    try {
      const ready = await commit("a", "1", "ready");
      await git(repo, ["branch", "ready", ready]);
      const candidate = await commit("b", "2", "automatic candidate");
      const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
      let movingTip: string | null = null;
      let queue: FrozenCandidateRepairQueue | null = null;
      const writes: Array<FrozenCandidateRepairQueue | null> = [];
      let dispatched = false;
      deps.runGreen = async () => {
        calls.push("runGreen");
        // The automatic candidate is cut before this commit lands, so a newer tip EXISTS for the
        // old stale-candidate check — the point is that the frozen row keeps the gate off it.
        movingTip = await commit("c", "3", "tip landed during suite");
        return {
          green: false,
          summary: "1 failed",
          failingTests: ["@papercusp/web"],
          failingFiles: [
            { file: "lib/broken.test.ts", workspace: "@papercusp/web" },
          ],
        };
      };
      deps.resolveTip = async () => movingTip;
      deps.runTestsAtRef = async (ref) => {
        calls.push("runTestsAtRef");
        throw new Error(
          `re-triage re-ran the failing files at ${ref} while a queue row was frozen at ${candidate} — the tip must never be judged (P-024)`,
        );
      };
      deps.readFrozenRepairQueue = async () => queue;
      deps.writeFrozenRepairQueue = async (next) => {
        writes.push(next);
        queue = next;
      };
      deps.dispatchFrozenRepairFixer = async () => {
        dispatched = true;
        throw new Error(
          "automatic first-red path must not dispatch a fixer before the re-triage window",
        );
      };

      const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(result).toMatchObject({
        advanced: false,
        candidate,
        green: false,
        reason: "not-green",
        retriage: {
          // The lineage head of a fresh row IS the candidate, so there is nothing to re-run at:
          // the verdict records that the tip was never looked at, never a stale-candidate rescue.
          classification: "unknown",
          autoRefire: false,
          tip: candidate,
        },
      });
      expect(writes.map((entry) => entry?.phase ?? "clear")).toEqual([
        "ready-to-test",
        "awaiting-fixer",
      ]);
      expect(calls).not.toContain("runTestsAtRef");
      expect(dispatched).toBe(false);
      expect(queue).toMatchObject({
        phase: "awaiting-fixer",
        candidate,
        repairHead: candidate,
        attempts: 0,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("freezes the first red candidate and does not run or dispatch again while its fixer is live", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "moving staging tip");
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    let queue: FrozenCandidateRepairQueue | null = null;
    const dispatchedHeads: string[] = [];
    const dispatchedEvidence: unknown[] = [];
    let tipRetests = 0;
    deps.runGreen = async () => {
      calls.push("runGreen");
      return {
        green: false,
        summary: "1 failed",
        failingTests: ["@papercusp/web"],
        failingFiles: [
          { file: "lib/broken.test.ts", workspace: "@papercusp/web" },
        ],
        logPath: "/tmp/checkpoint-exact-run.log",
        isolationNote:
          "isolation: 1 file STILL FAILED at the candidate — real break, gate stays red",
      };
    };
    deps.resolveTip = async () => movingTip;
    deps.runTestsAtRef = async () => {
      tipRetests += 1;
      return { pass: true, summary: "pass at tip" };
    };
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async (next, evidence) => {
      dispatchedHeads.push(next.repairHead);
      dispatchedEvidence.push(evidence);
      return { spawnId: "fixer-1", runId: "run-1" };
    };
    deps.frozenRepairFixerAlive = async () => true;
    deps.runId = "initial-proof-run";

    const first = await runGreenCheckpoint(cfg(), deps, {
      candidate: frozen,
      noPush: true,
    });

    expect(first).toMatchObject({
      green: false,
      reason: "not-green",
      candidate: frozen,
      repairQueue: {
        candidate: frozen,
        repairHead: frozen,
        affectedTestProofGroup: "initial-proof-run",
        phase: "awaiting-fixer",
        attempts: 1,
        fixerSpawnId: "fixer-1",
      },
    });
    expect(first.checkpointEvidence).toMatchObject({
      logPath: "/tmp/checkpoint-exact-run.log",
      runId: "initial-proof-run",
      integrationRoot: cfg().integrationRoot,
    });
    expect(dispatchedEvidence).toEqual([first.checkpointEvidence]);
    // EI-208045: the queue returns before moving-tip re-triage. Even though this fixture
    // deliberately carries the old candidate-framed "real break" isolation note and a
    // newer tip whose test would pass, the emitted result can never combine that note with
    // `retriage.classification = stale-candidate` as one contradictory verdict.
    expect(first.retriage).toBeUndefined();
    expect(first.isolationNote).toMatch(/real break/i);
    expect(tipRetests).toBe(0);
    expect(
      first.retriage?.classification === "stale-candidate" &&
        /real break/i.test(first.isolationNote ?? ""),
    ).toBe(false);
    expect(dispatchedHeads).toEqual([frozen]);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);

    const second = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(second).toMatchObject({
      green: null,
      reason: "repair-in-progress",
      candidate: frozen,
      frozenCandidate: frozen,
      repairHead: frozen,
      verdictProvenance: {
        frozenCandidateVerdict: "full-gate-red",
        repairHeadVerdict: "same-as-frozen-full-gate-red",
      },
      repairQueue: {
        candidate: frozen,
        repairHead: frozen,
        attempts: 1,
        fixerSpawnId: "fixer-1",
      },
    });
    expect(movingTip).not.toBe(frozen);
    expect(dispatchedHeads).toEqual([frozen]);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);

    // EI-22767271786772554: a canonical red at a DISTINCT repair head is durable in
    // convergenceRounds even after the queue moves back to awaiting-fixer. The public
    // result must project that judgment instead of inferring "not-judged" from phase.
    const priorQueue = await deps.readFrozenRepairQueue!();
    expect(priorQueue).not.toBeNull();
    queue = {
      ...priorQueue!,
      repairHead: movingTip,
      convergenceRounds: [
        ...(priorQueue?.convergenceRounds ?? []),
        {
          round: 2,
          head: movingTip,
          failingCount: 1,
          atMs: Date.now(),
        },
      ],
    };
    const third = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(third).toMatchObject({
      green: null,
      reason: "repair-in-progress",
      candidate: frozen,
      frozenCandidate: frozen,
      repairHead: movingTip,
      verdictProvenance: {
        frozenCandidateVerdict: "full-gate-red",
        repairHeadVerdict: "full-gate-red",
      },
    });
    expect(dispatchedHeads).toEqual([frozen]);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
  });

  it("reaps a dead fixer before a stale dispatch reservation and then recovers within budget", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "dead-fixer",
      dispatchReservation: {
        token: "stale-launcher",
        claimedAtMs: now - 100,
        expiresAtMs: now + 60_000,
      },
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const writes: FrozenCandidateRepairQueue[] = [];
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      if (next) writes.push(next);
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "replacement-fixer",
      runId: "replacement-run",
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(writes[0]).toMatchObject({
      fixerSpawnId: null,
      attempts: 1,
      repairHead: frozen,
    });
    expect(writes[0]?.dispatchReservation).toBeUndefined();
    expect(result).toMatchObject({
      green: null,
      reason: "repair-in-progress",
      repairQueue: {
        fixerSpawnId: "replacement-fixer",
        attempts: 2,
        repairHead: frozen,
      },
    });
    expect(calls).not.toContain("runGreen");
  });

  // P-027 (D-014): the run reads the queue once, then a suite runs for up to an hour. An
  // admission that lands in that window used to be overwritten by the run-end write-back of
  // the run-start snapshot (measured 2026-09-05 17:41Z). With the CAS transition wired, the
  // verdict is applied to the FRESH row and only for the head the run judged.
  function p027Queue(
    frozen: string,
    ready: string,
  ): FrozenCandidateRepairQueue {
    const now = Date.now();
    return {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(frozen),
      convergenceRounds: [],
    };
  }
  function wireP027Transition(
    deps: CheckpointDeps,
    cell: { queue: FrozenCandidateRepairQueue | null },
  ): { writes: FrozenCandidateRepairQueue[]; transitions: string[] } {
    const writes: FrozenCandidateRepairQueue[] = [];
    const transitions: string[] = [];
    deps.readFrozenRepairQueue = async () => cell.queue;
    deps.writeFrozenRepairQueue = async (next) => {
      if (next) writes.push(next);
      cell.queue = next;
    };
    deps.transitionFrozenRepairQueue = async (transition) => {
      if (!cell.queue) return { status: "absent", queue: null };
      const next = transition(cell.queue);
      if (next === cell.queue) {
        transitions.push("unchanged");
        return { status: "unchanged", queue: cell.queue };
      }
      transitions.push("written");
      writes.push(next);
      cell.queue = next;
      return { status: "written", queue: next };
    };
    return { writes, transitions };
  }

  it("P-027 (D-014): an admission that lands while the suite runs is preserved — the run's red for the superseded head is never written over it", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const cell = {
      queue: p027Queue(frozen, ready) as FrozenCandidateRepairQueue | null,
    };
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    const { writes, transitions } = wireP027Transition(deps, cell);
    let admitted = null as string | null;
    const runGreen = deps.runGreen;
    deps.runGreen = async (...args) => {
      // While the suite runs, a peer lands a fix through the one door: the PERSISTED row
      // advances to the admission commit and carries its ledger row. The gate's snapshot
      // still says `frozen`.
      admitted = await commit("b", "fixed on staging", "admitted onto lineage");
      const atMs = Date.now();
      cell.queue = cell.queue && {
        ...cell.queue,
        repairHead: admitted,
        phase: "ready-to-verify",
        updatedAtMs: atMs,
        admissions: [
          {
            atMs,
            actor: "su-peer",
            source: { ref: "staging", sha: admitted },
            fromRepairHead: frozen,
            toRepairHead: admitted,
            paths: ["b"],
            unchanged: [],
            blobs: {},
          },
        ],
      };
      return runGreen(...args);
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(calls).toContain(`setup:${frozen.slice(0, 7)}`);
    expect(result.candidate).toBe(frozen);
    // The admission SURVIVED: the row still carries the peer's head and its ledger entry and
    // stays ready-to-verify (the newer head is unjudged). The write-back that used to clobber
    // it never happened: no write ever moved repairHead back to `frozen` or the phase to
    // awaiting-fixer.
    expect(cell.queue?.repairHead).toBe(admitted);
    expect(cell.queue?.admissions).toHaveLength(1);
    expect(cell.queue?.phase).toBe("ready-to-verify");
    expect(
      writes.some(
        (w) => w.repairHead === frozen || w.phase === "awaiting-fixer",
      ),
    ).toBe(false);
    // WI-10000741 (D-014 "records its legs"): the suite's red is RECORDED at the head it
    // measured — a round at `frozen`, never one at the admitted head, so the admitted head
    // still reads as awaiting verification — instead of being discarded with the run.
    expect(cell.queue?.convergenceRounds?.map((r) => r.head)).toEqual([frozen]);
    expect(cell.queue?.failingTests).toEqual([
      "lib/broken.test.ts",
      "@papercusp/operator-vite",
    ]);
    expect(
      cell.queue?.signature?.every((entry) => entry.measuredHead === frozen),
    ).toBe(true);
    expect(cell.queue && frozenRepairHeadAwaitsVerification(cell.queue)).toBe(
      true,
    );
    expect(transitions).toContain("written");
    // The admission→resume-start lifecycle stamp is legitimately a no-op for
    // this legacy queue fixture (it predates lastAdmittedAtMs). The verdict
    // transition itself must still be the final persisted transition.
    expect(transitions.at(-1)).toBe("written");
    const superseded = logs.find((l) =>
      l.startsWith("FROZEN_REPAIR_VERDICT_SUPERSEDED"),
    );
    expect(superseded).toBeDefined();
    expect(superseded).toContain(`recorded as round 1`);
    expect(superseded).not.toContain("not recorded");
    // P-010: the superseded arm measured a head the row no longer carries — no receipt.
    expect(cell.queue?.selectiveCoverage).toBeUndefined();
  });

  it("P-027 CONTROL: with no mid-run admission the same run records its red at exactly the head it judged", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const cell = {
      queue: p027Queue(frozen, ready) as FrozenCandidateRepairQueue | null,
    };
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    const { transitions } = wireP027Transition(deps, cell);

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(calls).toContain(`setup:${frozen.slice(0, 7)}`);
    expect(result.candidate).toBe(frozen);
    expect(cell.queue?.repairHead).toBe(frozen);
    expect(cell.queue?.phase).toBe("awaiting-fixer");
    expect(cell.queue?.convergenceRounds?.map((r) => r.head)).toEqual([frozen]);
    expect(transitions).toContain("written");
    expect(transitions.at(-1)).toBe("written");
    expect(
      logs.some((l) => l.startsWith("FROZEN_REPAIR_VERDICT_SUPERSEDED")),
    ).toBe(false);
  });

  describe("P-010: a full-gate red at the repair head leaves a coverage receipt", () => {
    async function admittedRepairFixture() {
      const ready = await commit("a", "1", "ready");
      await git(repo, ["branch", "ready", ready]);
      const frozen = await commit("b", "broken", "frozen candidate");
      const repaired = await commit("b", "still broken", "first admitted repair");
      const atMs = Date.now();
      const queue: FrozenCandidateRepairQueue = {
        ...p027Queue(frozen, ready),
        repairHead: repaired,
        admissions: [
          {
            atMs,
            actor: "su-fixer",
            source: { ref: "staging", sha: repaired },
            fromRepairHead: frozen,
            toRepairHead: repaired,
            paths: ["b"],
            unchanged: [],
            blobs: { b: await git(repo, ["rev-parse", `${repaired}:b`]) },
          },
        ],
      };
      const cell = { queue: queue as FrozenCandidateRepairQueue | null };
      const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
      wireP027Transition(deps, cell);
      return { frozen, repaired, cell, deps, calls, atMs };
    }

    it("records the receipt at the judged head, so the next admission verifies only its own paths", async () => {
      const { frozen, repaired, cell, deps, calls, atMs } = await admittedRepairFixture();

      await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
      expect(cell.queue?.phase).toBe("awaiting-fixer");
      expect(cell.queue?.convergenceRounds?.map((r) => r.head)).toEqual([repaired]);
      expect(cell.queue?.selectiveCoverage).toEqual({
        schemaVersion: 1,
        candidate: frozen,
        head: repaired,
      });

      // Round N+1: one more admission lands on top. The receipt joins the admission
      // suffix, so REPAIR_RADIUS is the delta, not every path since the candidate.
      const next = await commit("c", "fix", "second admitted repair");
      const judged = cell.queue!;
      const advanced: FrozenCandidateRepairQueue = {
        ...judged,
        phase: "ready-to-verify",
        repairHead: next,
        admissions: [
          ...(judged.admissions ?? []),
          {
            atMs: atMs + 1,
            actor: "su-fixer",
            source: { ref: "staging", sha: next },
            fromRepairHead: repaired,
            toRepairHead: next,
            paths: ["c"],
            unchanged: [],
            blobs: { c: await git(repo, ["rev-parse", `${next}:c`]) },
          },
        ],
      };
      expect(selectFrozenRepairAdmissionPaths(advanced)).toMatchObject({
        mode: "delta",
        paths: ["c"],
        coverageComplete: true,
      });
      // CONTROL: the same lineage without the receipt is the cumulative fallback this fixes.
      expect(
        selectFrozenRepairAdmissionPaths({ ...advanced, selectiveCoverage: undefined }),
      ).toMatchObject({ mode: "cumulative", reason: "no-complete-coverage", paths: ["b", "c"] });
    });

    it("records NO receipt when an early typecheck preflight failed, because no suite ran", async () => {
      const { repaired, cell, deps, calls } = await admittedRepairFixture();
      deps.changedFilesForRange = async () => ["packages/operator-core/lib/thing.ts"];
      deps.runChangedFileTypecheckPreflight = async () => ({
        status: "failed" as const,
        summary: "thing.ts(1,1): error TS2322: Type 'string' is not assignable.",
        failingSignatures: ["lint:tsc"],
      });

      await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(calls.filter((call) => call === "runGreen")).toHaveLength(0);
      expect(cell.queue?.convergenceRounds?.map((r) => r.head)).toEqual([repaired]);
      expect(cell.queue?.selectiveCoverage).toBeUndefined();
    });
  });

  it("P-001 self-refires in-process when an admission supersedes the running pass, then consumes the marker only after judging the new head", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const admitted = await commit("b", "fixed", "admitted repair");
    const cell = {
      queue: p027Queue(frozen, ready) as FrozenCandidateRepairQueue | null,
    };
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    wireP027Transition(deps, cell);
    let runCount = 0;
    const runGreen = deps.runGreen;
    deps.runGreen = async (...args) => {
      runCount += 1;
      if (runCount === 1 && cell.queue) {
        const requestedAtMs = Date.now();
        cell.queue = {
          ...cell.queue,
          phase: "ready-to-verify",
          repairHead: admitted,
          updatedAtMs: requestedAtMs,
          retestRequested: {
            candidate: frozen,
            repairHead: admitted,
            requestedAtMs,
          },
        };
      }
      return runGreen(...args);
    };
    deps.consumeFrozenRepairRetestRequest = async ({ judgedRepairHead, settleJudgedHead }) => {
      if (!cell.queue) return { kind: "absent", queue: null, request: null };
      if (cell.queue.retestRequested?.repairHead === judgedRepairHead && !settleJudgedHead) {
        return { kind: "none", queue: cell.queue, request: null };
      }
      const decision = settleFrozenRepairRetestRequest(cell.queue, judgedRepairHead);
      cell.queue = decision.queue;
      return decision;
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(runCount).toBe(2);
    expect(calls).toContain(`setup:${frozen.slice(0, 7)}`);
    expect(calls).toContain(`setup:${admitted.slice(0, 7)}`);
    expect(result.candidate).toBe(admitted);
    expect(cell.queue?.retestRequested).toBeUndefined();
  });

  it.each(["red", "superseded", "unavailable"] as const)("EI-23071029479486567: selective %s verification consumes only the measured repair head while preserving the frozen public identity", async (outcome) => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const admitted = await commit("b", "still broken", "admitted repair");
    const newer = await commit("b", "another repair", "newer admission");
    const requestedAtMs = Date.now();
    const cell = {
      queue: {
        ...p027Queue(frozen, ready),
        repairHead: admitted,
        failingTests: ["lint:tsc"],
        signature: [{
          id: "lint:tsc", kind: "lint-leg", recipe: "npm run lint:tsc",
          admittedRound: 1, measuredHead: frozen,
        }],
        retestRequested: { candidate: frozen, repairHead: admitted, requestedAtMs },
      } as FrozenCandidateRepairQueue | null,
    };
    const { deps, calls } = stubDeps(false);
    wireP027Transition(deps, cell);
    const measured: string[] = [];
    deps.runGateAtRef = async (head) => {
      measured.push(head);
      if (outcome === "unavailable") throw new Error("verification unavailable");
      if (outcome === "superseded" && measured.length === 1 && cell.queue) {
        cell.queue = {
          ...cell.queue, repairHead: newer,
          retestRequested: { candidate: frozen, repairHead: newer, requestedAtMs },
        };
      }
      return { pass: false, summary: "lint:tsc FAIL at the requested head" };
    };
    const consumed: Array<{ judgedRepairHead: string; settleJudgedHead: boolean }> = [];
    deps.consumeFrozenRepairRetestRequest = async (input) => {
      consumed.push(input);
      if (!cell.queue) return { kind: "absent", queue: null, request: null };
      if (cell.queue.retestRequested?.repairHead === input.judgedRepairHead && !input.settleJudgedHead) {
        return { kind: "none", queue: cell.queue, request: null };
      }
      const decision = settleFrozenRepairRetestRequest(cell.queue, input.judgedRepairHead);
      cell.queue = decision.queue;
      return decision;
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(measured).toEqual(outcome === "superseded" ? [admitted, newer] : [admitted]);
    expect(calls).not.toContain("runGreen");
    expect(result).toMatchObject({
      candidate: frozen, frozenCandidate: frozen, green: null,
      repairHead: outcome === "superseded" ? newer : admitted,
    });
    if (outcome === "unavailable") {
      expect(cell.queue?.retestRequested?.repairHead).toBe(admitted);
      expect(consumed.every((input) => !input.settleJudgedHead)).toBe(true);
    } else {
      expect(consumed).toEqual(measured.map((judgedRepairHead) => ({ judgedRepairHead, settleJudgedHead: true })));
      expect(cell.queue?.retestRequested).toBeUndefined();
      expect(cell.queue?.convergenceRounds?.map((round) => round.head)).toEqual(measured);
    }
  });

  it.each([
    {
      reason: "shared gate-run wall budget",
      opts: { runStartedAtMs: 1_000 },
      expectedLog: "the shared gate-run wall budget cannot fit another pass",
    },
    {
      reason: "admission-refire bound",
      opts: { admissionRefires: MAX_ADMISSION_REFIRE_ATTEMPTS },
      expectedLog: `the admission self-refire bound ${MAX_ADMISSION_REFIRE_ATTEMPTS} is exhausted`,
    },
  ])(
    "P-001 keeps the durable marker and reports deferred retry after the $reason",
    async ({ opts, expectedLog }) => {
      const ready = await commit("a", "1", "ready");
      await git(repo, ["branch", "ready", ready]);
      const frozen = await commit("b", "broken", "frozen candidate");
      const admitted = await commit("b", "fixed", "admitted repair");
      const cell = {
        queue: p027Queue(frozen, ready) as FrozenCandidateRepairQueue | null,
      };
      const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
      const logs: string[] = [];
      deps.log = (message) => logs.push(message);
      wireP027Transition(deps, cell);
      const runGreen = deps.runGreen;
      deps.runGreen = async (...args) => {
        if (cell.queue) {
          const requestedAtMs = Date.now();
          cell.queue = {
            ...cell.queue,
            phase: "ready-to-verify",
            repairHead: admitted,
            updatedAtMs: requestedAtMs,
            retestRequested: { candidate: frozen, repairHead: admitted, requestedAtMs },
          };
        }
        return runGreen(...args);
      };
      deps.consumeFrozenRepairRetestRequest = async ({ judgedRepairHead, settleJudgedHead }) => {
        if (!cell.queue) return { kind: "absent", queue: null, request: null };
        if (cell.queue.retestRequested?.repairHead === judgedRepairHead && !settleJudgedHead) {
          return { kind: "none", queue: cell.queue, request: null };
        }
        const decision = settleFrozenRepairRetestRequest(cell.queue, judgedRepairHead);
        cell.queue = decision.queue;
        return decision;
      };

      const result = await runGreenCheckpoint(cfg(), deps, {
        noPush: true,
        ...opts,
      });

      expect(result.candidate).toBe(frozen);
      expect(cell.queue?.retestRequested).toMatchObject({ repairHead: admitted });
      expect(logs.some((message) => message.includes(expectedLog))).toBe(true);
      expect(logs.join("\n")).toContain(
        "The durable marker remains pending for a future checkpoint run; no immediate retry was scheduled.",
      );
      expect(logs.join("\n")).not.toContain("due-now routine");
    },
  );

  it("WI-212675: a dead fixer that changed nothing at an ADMITTED, never-verified head moves the queue to ready-to-verify and runs the suite there instead of re-dispatching", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    // A peer's fix reached the judged lineage via `release:repair-queue { op:'admit' }`
    // (P-001): repairHead moved forward, phase did not. The fixer dispatched at this head
    // finds nothing to change.
    const converged = await commit(
      "b",
      "fixed on staging",
      "peer fix admitted",
    );
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: converged,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "no-op-fixer",
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(converged),
      convergenceRounds: [
        { round: 1, head: frozen, failingCount: 1, atMs: now - 1_000 },
      ],
    };
    const writes: FrozenCandidateRepairQueue[] = [];
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      if (next) writes.push(next);
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.dispatchFrozenRepairFixer = async () => {
      calls.push("dispatch");
      return {
        spawnId: "post-verification-fixer",
        runId: "post-verification-run",
      };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // The recover write is a COMPLETION at the admitted head, not a death.
    expect(writes[0]).toMatchObject({
      phase: "ready-to-verify",
      repairHead: converged,
      fixerSpawnId: "no-op-fixer",
      attempts: 1,
    });
    expect(
      logs.some((l) =>
        l.startsWith("FROZEN_REPAIR_ADMITTED_HEAD_READY_TO_VERIFY"),
      ),
    ).toBe(true);
    // The suite ran at the converged head in the same tick, and any replacement fixer was
    // launched only AFTER that verification went red — never ahead of it (the pre-fix
    // behaviour was dispatch-with-no-suite).
    expect(calls).toContain("runGreen");
    expect(calls).toContain(`setup:${converged.slice(0, 7)}`);
    const dispatchAt = calls.indexOf("dispatch");
    expect(dispatchAt === -1 || dispatchAt > calls.indexOf("runGreen")).toBe(
      true,
    );
    expect(result.candidate).toBe(converged);
    // The red at the converged head appended its round, so the NEXT no-op fixer at this head
    // takes the dead path (see the control below) rather than re-entering the suite.
    expect(queue?.convergenceRounds?.map((r) => r.head)).toEqual([
      frozen,
      converged,
    ]);
    expect(queue?.repairHead).toBe(converged);
  });

  it("WI-212675 CONTROL: a dead fixer that changed nothing at a head ALREADY verified red stays on the dead path and re-dispatches", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const converged = await commit(
      "b",
      "still broken",
      "peer change converged",
    );
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: converged,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "no-op-fixer",
      failingTests: ["lib/broken.test.ts"],
      signature: [],
      // The converged head was ALREADY verified red (round 2). A no-op fixer here is a failed
      // attempt, and reading it as "verify" would spend a full suite every tick.
      convergenceRounds: [
        { round: 1, head: frozen, failingCount: 1, atMs: now - 1_000 },
        { round: 2, head: converged, failingCount: 1, atMs: now - 800 },
      ],
    };
    const writes: FrozenCandidateRepairQueue[] = [];
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      if (next) writes.push(next);
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.dispatchFrozenRepairFixer = async () => ({
      spawnId: "replacement-fixer",
      runId: "replacement-run",
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(writes[0]).toMatchObject({
      phase: "awaiting-fixer",
      fixerSpawnId: null,
      attempts: 1,
      repairHead: converged,
    });
    expect(result).toMatchObject({
      green: null,
      reason: "repair-in-progress",
      repairQueue: {
        fixerSpawnId: "replacement-fixer",
        attempts: 2,
        repairHead: converged,
      },
    });
    expect(calls).not.toContain("runGreen");
  });

  it("holds an active dispatch reservation without spending another suite or launching a fixer", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      dispatchReservation: {
        token: "checkpoint-a",
        claimedAtMs: now - 100,
        expiresAtMs: now + 60_000,
      },
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    let dispatchCount = 0;
    deps.readFrozenRepairQueue = async () => queue;
    deps.frozenRepairFixerAlive = async () => {
      throw new Error(
        "liveness must not be queried for an active dispatch reservation",
      );
    };
    deps.dispatchFrozenRepairFixer = async () => {
      dispatchCount += 1;
      return { spawnId: "unexpected", runId: null };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: false,
      green: null,
      reason: "repair-in-progress",
      candidate: frozen,
      repairQueue: {
        dispatchReservation: {
          token: "checkpoint-a",
          expiresAtMs: now + 60_000,
        },
      },
    });
    expect(dispatchCount).toBe(0);
    expect(calls).not.toContain("runGreen");
  });

  it("emits and cleans up a terminal red when frozen-repair reservation is blocked", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    const events: Record<
      string,
      { payload: unknown; cancelSiblingKeysFor?: string[] }
    > = {};
    const writeExpectations: Array<{ expectedUpdatedAtMs: number | null }> = [];
    deps.runId = "reservation-blocked-run";
    deps.readFrozenRepairQueue = async () => null;
    deps.writeFrozenRepairQueue = async (_queue, options) => {
      writeExpectations.push(options);
    };
    deps.reserveFrozenRepairFixer = async () => null;
    deps.finalizeFrozenRepairFixer = async () => null;
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("fixer must not launch without the reservation");
    };
    deps.emitEvent = async ({ key, payload, cancelSiblingKeysFor }) => {
      await Promise.resolve();
      calls.push(`emit:${key}`);
      events[key] = { payload, cancelSiblingKeysFor };
    };
    deps.clearInFlightCandidate = async () => {
      calls.push("clearInFlightCandidate");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate: frozen,
      noPush: true,
    });

    expect(writeExpectations[0]).toEqual({ expectedUpdatedAtMs: null });
    const pipeline = pipelineName(repo);
    expect(result).toMatchObject({
      advanced: false,
      green: false,
      reason: "not-green",
      candidate: frozen,
    });
    expect(
      (events["green-checkpoint:red"].payload as { sha: string }).sha,
    ).toBe(frozen);
    expect(
      events[`green-checkpoint:red:${pipeline}`].cancelSiblingKeysFor,
    ).toEqual([
      "release:green",
      `release:green:${pipeline}`,
      "green-checkpoint:inconclusive",
      `green-checkpoint:inconclusive:${pipeline}`,
    ]);
    expect(calls).toEqual([
      `setup:${frozen.slice(0, 7)}`,
      "runGreen",
      "emit:green-checkpoint:red",
      `emit:green-checkpoint:red:${pipeline}`,
      "clearInFlightCandidate",
    ]);
  });

  it("CAS-reserves the first-red queue so concurrent checkpoints launch exactly one fixer", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "moving staging tip");
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    let queue: FrozenCandidateRepairQueue | null = null;
    let reads = 0;
    let releaseInitialReads!: () => void;
    const initialReads = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let reservationCalls = 0;
    let reservationHeld = false;
    let releaseFirstReservation!: () => void;
    const firstReservation = new Promise<void>((resolve) => {
      releaseFirstReservation = resolve;
    });
    let dispatchCount = 0;
    const reservationOptions: Array<{ allowCreateIfAbsent?: boolean }> = [];

    deps.runGreen = async () => {
      calls.push("runGreen");
      return {
        green: false,
        summary: "1 failed",
        failingTests: ["@papercusp/web"],
        failingFiles: [
          { file: "lib/broken.test.ts", workspace: "@papercusp/web" },
        ],
        isolationNote:
          "isolation: 1 file STILL FAILED at the candidate — real break, gate stays red",
      };
    };
    deps.resolveTip = async () => movingTip;
    deps.runTestsAtRef = async () => ({ pass: true, summary: "pass at tip" });
    deps.readFrozenRepairQueue = async () => {
      reads += 1;
      if (reads <= 2) {
        if (reads === 2) releaseInitialReads();
        await initialReads;
        return null;
      }
      return queue;
    };
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.reserveFrozenRepairFixer = async (next, options) => {
      reservationCalls += 1;
      reservationOptions.push(options ?? {});
      if (reservationHeld) {
        if (reservationCalls === 2) releaseFirstReservation();
        return null;
      }
      reservationHeld = true;
      const reserved: FrozenCandidateRepairQueue = {
        ...next,
        dispatchReservation: {
          token: "winner-token",
          claimedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
        },
      };
      queue = reserved;
      await firstReservation;
      return reserved;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      dispatchCount += 1;
      return { spawnId: "fixer-1", runId: "run-1" };
    };
    deps.finalizeFrozenRepairFixer = async (reserved, fired) => {
      const { dispatchReservation: _reservation, ...withoutReservation } =
        reserved;
      const finalized: FrozenCandidateRepairQueue = fired?.spawnId
        ? {
            ...withoutReservation,
            attempts: reserved.attempts + 1,
            updatedAtMs: Date.now(),
            fixerSpawnId: fired.spawnId,
          }
        : { ...withoutReservation, updatedAtMs: Date.now() };
      queue = finalized;
      reservationHeld = false;
      return finalized;
    };

    const [first, second] = await Promise.all([
      runGreenCheckpoint(cfg(), deps, { candidate: frozen, noPush: true }),
      runGreenCheckpoint(cfg(), deps, { candidate: frozen, noPush: true }),
    ]);

    expect(first).toMatchObject({ green: false, reason: "not-green" });
    expect(second).toMatchObject({ green: false, reason: "not-green" });
    expect(reservationCalls).toBe(2);
    expect(reservationOptions).toEqual([
      { allowCreateIfAbsent: true },
      { allowCreateIfAbsent: true },
    ]);
    expect(dispatchCount).toBe(1);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(2);
    expect(queue).toMatchObject({
      phase: "awaiting-fixer",
      candidate: frozen,
      repairHead: frozen,
      attempts: 1,
      fixerSpawnId: "fixer-1",
    });
    expect((await deps.readFrozenRepairQueue!())?.dispatchReservation).toBeUndefined();
  });

  it("renews the frozen-repair reservation throughout a slow dispatch", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue = {
      schemaVersion: FROZEN_CANDIDATE_REPAIR_QUEUE_SCHEMA_VERSION,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      affectedTestProofGroup: null,
      attempts: 0,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
    };
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    let renewals = 0;
    let markRenewedTwice!: () => void;
    const renewedTwice = new Promise<void>((resolve) => {
      markRenewedTwice = resolve;
    });
    deps.readFrozenRepairQueue = async () => queue;
    deps.reserveFrozenRepairFixer = async (next) => {
      queue = {
        ...next,
        dispatchReservation: {
          token: "slow-owner",
          claimedAtMs: Date.now(),
          expiresAtMs: Date.now() + 15,
        },
      };
      return queue;
    };
    deps.renewFrozenRepairFixerReservation = async (current) => {
      renewals += 1;
      if (renewals >= 2) markRenewedTwice();
      queue = {
        ...current,
        dispatchReservation: {
          ...current.dispatchReservation!,
          expiresAtMs: Date.now() + 15,
        },
      };
      return queue;
    };
    deps.frozenRepairReservationHeartbeatMs = 5;
    // P-003 / D-010: there is no worktree to prepare any more, so the dispatch itself is
    // the only slow step the reservation heartbeat has to outlast. It stays open until
    // the heartbeat has renewed twice rather than for a fixed 30ms, which a loaded host
    // could end after a single 5ms tick; the 2s cap keeps a dead heartbeat failing.
    deps.dispatchFrozenRepairFixer = async () => {
      let cap: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        renewedTwice,
        new Promise((resolve) => {
          cap = setTimeout(resolve, 2_000);
        }),
      ]);
      clearTimeout(cap);
      return { spawnId: "fixer-slow", runId: "run-slow" };
    };
    deps.finalizeFrozenRepairFixer = async (current, fired) => {
      const { dispatchReservation: _reservation, ...withoutReservation } =
        current;
      queue = {
        ...withoutReservation,
        attempts: current.attempts + 1,
        updatedAtMs: Date.now(),
        fixerSpawnId: fired?.spawnId ?? null,
      };
      return queue;
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: false,
      green: null,
      reason: "repair-in-progress",
      repairQueue: {
        fixerSpawnId: "fixer-slow",
        attempts: 1,
      },
    });
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(calls).not.toContain("runGreen");

    const renewalsAfterSettlement = renewals;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(renewals).toBe(renewalsAfterSettlement);
  });

  it("P-003/P-005/P-007: a post-suite-leg repair starts and runs the FULL gate at the repair head", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const repaired = await commit("b", "3", "forward repair");
    // P-007/D-004: see above — the repair head must be reachable from the candidate's admission
    // ledger ref, which is what `release:repair-queue { op:'admit' }` advances in production.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);
    // The repair is NOT on staging: staging fixed nothing and moved on. Pre-P-005 this exact
    // shape was re-queued as `repair-staging-mismatch` for an "alignment fixer" — the lineage
    // was required to be observable on staging before it could be judged. It no longer is.
    await git(repo, ["reset", "--hard", ready]);
    const stagingTip = await commit("c", "4", "later staging work");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      lastAdmittedAtMs: now - 750,
      fixerSpawnId: "fixer-1",
      // P-003 reserves the full-gate route for a typed post-suite leg. A widened related
      // selector is handled by bounded affected workspace tasks instead (focused suite).
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(repaired),
    };
    let verificationExecution: Parameters<CheckpointDeps["runGreen"]>[2];
    const { deps, calls } = stubDeps(true);
    deps.runId = "verifier-run";
    deps.runGreen = async (_tree, _base, execution) => {
      calls.push("runGreen");
      expect(queue?.lastResumeRunStartedAtMs).toBeTypeOf("number");
      expect(queue!.lastResumeRunStartedAtMs!).toBeGreaterThanOrEqual(
        queue!.lastAdmittedAtMs!,
      );
      verificationExecution = execution;
      return { green: true, summary: "all pass", failingTests: [] };
    };
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.resolveTip = async () => stagingTip;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(result.candidate).not.toBe(stagingTip);
    expect(calls).toContain(`setup:${repaired.slice(0, 7)}`);
    expect(calls).not.toContain(`setup:${stagingTip.slice(0, 7)}`);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(verificationExecution).toMatchObject({
      candidate: repaired,
      affectedTestProofGroup: "initial-proof-run",
      frozenCandidateOpenedAtMs: now - 1_000,
    });
    expect(await revParse(repo, "ready")).toBe(repaired);
    expect(queue).toBeNull();
  });

  it("P-005: every signature entry is re-run AT the repair head — never the tip — and a selective green proceeds to the full gate at that same head", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "isolated repair");
    // P-007/D-004: a repairHead can only differ from the candidate because
    // `admitPathsOntoRepairHead` produced it, and that CAS-advances the admission ledger ref.
    // Promotion now requires that ref, so the fixture models the one door the head came through.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    // Staging fixed the same thing independently and moved on. Pre-P-005 the queue's signature
    // was re-run at THIS tip and, on a pass, the queue was retired and the gate re-cut at the
    // tip — the treadmill. Now the tip is never even resolved on this path.
    await git(repo, ["reset", "--hard", ready]);
    await commit("b", "fixed independently", "canonical independent fix");
    const stagingTip = await commit("c", "3", "later staging work");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: [
        "@papercusp/web",
        "lib/broken.test.ts",
        "lint:identity-leak",
      ],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const retestedRefs: string[] = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    // FALSIFIER: the pre-P-005 path resolved the tip here (and its `.catch(() => null)` turned a
    // throw into a `repair-staging-mismatch` re-queue), so this recorder is red on that code.
    deps.resolveTip = async () => {
      calls.push("resolveTip");
      throw new Error("the frozen lineage never resolves the tip");
    };
    deps.runTestsAtRef = async (ref, files) => {
      retestedRefs.push(ref);
      expect(files).toEqual([
        { workspace: "@papercusp/web", file: "lib/broken.test.ts" },
      ]);
      return { pass: true, summary: "file passes at the repair head" };
    };
    deps.runGateAtRef = async (ref, gateIds) => {
      retestedRefs.push(ref);
      expect(gateIds).toEqual(["lint:identity-leak"]);
      return { pass: true, summary: "gate passes at the repair head" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(result.candidate).not.toBe(stagingTip);
    expect(retestedRefs).toEqual([repaired, repaired]);
    expect(calls.slice(0, calls.indexOf("runGreen"))).not.toContain(
      "resolveTip",
    );
    expect(calls).toContain(`setup:${repaired.slice(0, 7)}`);
    expect(calls).not.toContain(`setup:${stagingTip.slice(0, 7)}`);
    expect(queue).toBeNull();
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(await revParse(repo, "ready")).toBe(repaired);
  });

  it("P-005: an explicit transported candidate never displaces a ready-to-verify repair head — the full gate judges the repair head, not the quiet-cut target and not the tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "isolated repair");
    // P-007/D-004: a repairHead can only differ from the candidate because
    // `admitPathsOntoRepairHead` produced it, and that CAS-advances the admission ledger ref.
    // Promotion now requires that ref, so the fixture models the one door the head came through.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    await git(repo, ["reset", "--hard", ready]);
    const transportedQuietCut = await commit(
      "b",
      "fixed independently",
      "canonical quiet-cut target",
    );
    const youngStagingTip = await commit(
      "c",
      "young",
      "newer tip after launch target was selected",
    );
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      // Real full-gate task labels that the narrow file/gate runners cannot re-run: the full
      // gate is the only complete proof — and it runs at the REPAIR HEAD. Pre-P-005 this shape
      // retired the queue and judged the transported quiet-cut target instead.
      failingTests: [
        "@papercusp/desktop",
        "papercusp-desktop :: cargo test",
        "bin/lib/b3-revocation-kcut.selftest.sh",
      ],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.resolveTip = async () => youngStagingTip;

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate: transportedQuietCut,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(result.candidate).not.toBe(transportedQuietCut);
    expect(result.candidate).not.toBe(youngStagingTip);
    expect(calls).toContain(`setup:${repaired.slice(0, 7)}`);
    expect(calls).not.toContain(`setup:${transportedQuietCut.slice(0, 7)}`);
    expect(queue).toBeNull();
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(await revParse(repo, "ready")).toBe(repaired);
  });

  it("P-005 (was WI-2143595): a mixed signature the runners cannot narrow runs the full gate at the repair head — not the moving tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    // The repair head happens to be a STAGING commit here (the pre-D-004 convergence shape) —
    // and staging kept moving underneath it. Under P-005 that ancestry is irrelevant: the
    // repair head is judged at its own sha whether or not staging can see it.
    const converged = await commit(
      "b",
      "fixed on staging",
      "peer fix converged",
    );
    // P-007/D-004: promotion is now fail-closed on the admission ledger ref — a repairHead may
    // differ from the candidate ONLY because `admitPathsOntoRepairHead` produced it, and that
    // CAS-advances this ref. This fixture predates that requirement: it modelled the pre-D-004
    // convergence shape, which P-003 has since deleted, so nothing can reach this state by
    // convergence any more. Model the one door a repair head can legitimately come through.
    // The test's SUBJECT is unchanged — a mixed signature the narrow runners cannot re-run is
    // judged by the full gate AT THE REPAIR HEAD, never at the moving tip.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      converged,
    ]);
    const stagingTip = await commit("c", "3", "later staging work");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: converged,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      // A MIXED red: one file plus one entry the narrow file/gate runners cannot re-run, so
      // nothing selective is measured and the full gate at the repair head decides (the
      // 2026-09-03T18:23Z shape: 13 files + a cargo and a seed-check entry).
      failingTests: ["lib/broken.test.ts", "papercusp-desktop :: cargo test"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.resolveTip = async () => stagingTip;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // Pre-WI-2143595 this was `stagingTip`: the queue was retired and a FRESH candidate cut at
    // the tip, re-admitting every commit between the repair head and the tip (the D-007
    // treadmill). The repair head is what the freeze was protecting; judge it.
    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: converged,
      from: ready,
    });
    expect(result.candidate).not.toBe(stagingTip);
    expect(calls).toContain(`setup:${converged.slice(0, 7)}`);
    expect(calls).not.toContain(`setup:${stagingTip.slice(0, 7)}`);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(queue).toBeNull();
    expect(await revParse(repo, "ready")).toBe(converged);
    expect(logs.some((l) => l.includes("the full gate at repair head"))).toBe(
      true,
    );
  });

  it("P-005 (inverts the WI-2143595 control): an ISOLATED repair head — not on staging — is judged at ITS OWN sha and never yields to the tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "isolated repair");
    // P-007/D-004: a repairHead can only differ from the candidate because
    // `admitPathsOntoRepairHead` produced it, and that CAS-advances the admission ledger ref.
    // Promotion now requires that ref, so the fixture models the one door the head came through.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    // The repair lives only on the frozen lineage; canonical staging fixed the same thing
    // independently and moved on. `repaired` descends from the frozen candidate but is NOT an
    // ancestor of the tip. Pre-P-005 that made it yield to the tip ("main may only fast-forward
    // to a staging commit"); under D-004 the frozen lineage IS what main promotes.
    await git(repo, ["reset", "--hard", ready]);
    await commit("b", "fixed independently", "canonical independent fix");
    const stagingTip = await commit("c", "3", "later staging work");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["lib/broken.test.ts", "papercusp-desktop :: cargo test"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.resolveTip = async () => stagingTip;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(result.candidate).not.toBe(stagingTip);
    expect(calls).toContain(`setup:${repaired.slice(0, 7)}`);
    expect(calls).not.toContain(`setup:${stagingTip.slice(0, 7)}`);
    expect(queue).toBeNull();
    expect(await revParse(repo, "ready")).toBe(repaired);
  });

  it("P-005: a gate-only signature is re-run AT the repair head; a moving tip is never consulted, and an explicit transported candidate never displaces the repair head", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "isolated repair");
    // P-007/D-004: a repairHead can only differ from the candidate because
    // `admitPathsOntoRepairHead` produced it, and that CAS-advances the admission ledger ref.
    // Promotion now requires that ref, so the fixture models the one door the head came through.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    await git(repo, ["reset", "--hard", ready]);
    const transportedQuietCut = await commit(
      "b",
      "fixed independently",
      "canonical quiet-cut target",
    );
    const proofTipBefore = await commit(
      "c",
      "proof-before",
      "staging tip before selective proof",
    );
    const proofTipAfter = await commit(
      "d",
      "proof-after",
      "staging tip after selective proof",
    );
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["lint:tsc"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const resolvedTips = [proofTipBefore, proofTipAfter];
    const gateRefs: string[] = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    // A moving tip. Pre-P-005 the selective proof ran at `proofTipBefore` and the move to
    // `proofTipAfter` was a `tip-moved` arm; now neither is ever resolved on this path.
    deps.resolveTip = async () => {
      calls.push("resolveTip");
      return resolvedTips.shift() ?? proofTipAfter;
    };
    deps.runGateAtRef = async (ref, gateIds) => {
      gateRefs.push(ref);
      expect(gateIds).toEqual(["lint:tsc"]);
      return { pass: true, summary: "gate passes at the repair head" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate: transportedQuietCut,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(gateRefs).toEqual([repaired]);
    expect(calls.slice(0, calls.indexOf("runGreen"))).not.toContain(
      "resolveTip",
    );
    expect(queue).toBeNull();
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(await revParse(repo, "ready")).toBe(repaired);
    expect(result.candidate).not.toBe(transportedQuietCut);
    expect(result.candidate).not.toBe(proofTipBefore);
    expect(result.candidate).not.toBe(proofTipAfter);
  });

  it("P-005: a signature that still reproduces AT the repair head re-queues the fresh failing set for the next fixer without spending a suite", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "isolated repair");
    // P-007/D-004: a repairHead can only differ from the candidate because
    // `admitPathsOntoRepairHead` produced it, and that CAS-advances the admission ledger ref.
    // Promotion now requires that ref, so the fixture models the one door the head came through.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    await git(repo, ["reset", "--hard", ready]);
    const stagingTip = await commit("b", "different", "canonical staging tip");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["@papercusp/web", "lib/broken.test.ts"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const retestedRefs: string[] = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.resolveTip = async () => stagingTip;
    deps.runTestsAtRef = async (ref) => {
      retestedRefs.push(ref);
      return { pass: false, summary: "file failure still reproduces" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: false,
      green: null,
      reason: "repair-in-progress",
      candidate: frozen,
      frozenCandidate: frozen,
      repairHead: repaired,
      verdictProvenance: { repairHeadVerdict: "full-gate-red" },
      repairQueue: {
        phase: "awaiting-fixer",
        repairHead: repaired,
        fixerSpawnId: null,
      },
    });
    expect(result.summary).toContain("still red at its own sha");
    expect(retestedRefs).toEqual([repaired]);
    expect(queue).toMatchObject({
      phase: "awaiting-fixer",
      repairHead: repaired,
    });
    // The FRESH signature, not the retired staging-mismatch sentinel.
    expect(queue?.failingTests).toEqual(
      expect.arrayContaining(["lib/broken.test.ts", "@papercusp/web"]),
    );
    expect(queue?.failingTests).not.toContain("repair-staging-mismatch");
    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain(`setup:${stagingTip.slice(0, 7)}`);
    expect(await revParse(repo, "ready")).toBe(ready);
  });

  it("P-007/D-004: promotes the frozen repair head itself, in ONE full gate, without joining the moving tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "verified repair");
    // The admission ledger ref is what makes `repaired` a LINEAGE commit rather than merely a
    // descendant of the candidate. `admitPathsOntoRepairHead` CAS-advances it in production.
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);

    // Staging moved on independently and does NOT contain the repair head. Under D-001 that was
    // fatal: the repair was "verification-only", so it was joined into this moving tip and the
    // whole gate re-run there — a second full suite, on a sha carrying every commit landed since
    // the freeze. D-004 promotes the lineage commit instead; staging absorbs it afterwards (P-008).
    await git(repo, ["reset", "--hard", ready]);
    const stagingTip = await commit("c", "3", "later staging work");

    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(repaired),
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    const pushedCandidates: string[] = [];
    const advancedCandidates: string[] = [];
    deps.push = async (_ref, _base, candidateSha) => {
      pushedCandidates.push(candidateSha!);
    };
    deps.advance = async (candidateSha) => {
      advancedCandidates.push(candidateSha);
      return advanceReady(repo, candidateSha, "ready");
    };
    const promoted = await runGreenCheckpoint(cfg(), deps);

    // ONE full gate, at the repair head, and the release ref moves to that exact sha.
    expect(promoted).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      from: ready,
    });
    expect(await revParse(repo, "ready")).toBe(repaired);
    expect(pushedCandidates).toEqual([repaired]);
    expect(advancedCandidates).toEqual([repaired]);
    expect(queue).toBeNull();

    // The decisive assertions. Under D-001 both of these read the other way: the gate spent a
    // SECOND runGreen at a joined sha, and set up a checkout for it.
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("setup:"))).toEqual([
      `setup:${repaired.slice(0, 7)}`,
    ]);

    // The moving integration tip was never adopted, never joined, and never moved by the gate.
    expect(await revParse(repo, "main")).toBe(stagingTip);
    expect(advancedCandidates).not.toContain(stagingTip);
  });

  it("P-007/D-004: a repair head absent from the admission ledger ref is REFUSED, and the queue is kept", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    // Descends from the frozen candidate, but no admission ever authored it: there is no
    // `refs/papercusp/frozen/<candidate>` ref pointing at it. Descent is not membership.
    const impostor = await commit(
      "b",
      "fixed",
      "not admitted through the one door",
    );
    await git(repo, ["reset", "--hard", ready]);
    const stagingTip = await commit("c", "3", "later staging work");

    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: impostor,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(impostor),
    };
    const { deps } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    const advancedCandidates: string[] = [];
    deps.push = async () => {};
    deps.advance = async (candidateSha) => {
      advancedCandidates.push(candidateSha);
      return advanceReady(repo, candidateSha, "ready");
    };

    const held = await runGreenCheckpoint(cfg(), deps);

    // The ref does not exist at all, which is a DEFINITE negative — no admission ever opened a
    // lineage for this candidate — not an unmeasured one.
    expect(held.summary).toContain("repair-head-absent-from-lineage-ref");
    expect(held.summary).not.toContain("lineage-unreadable");
    expect(held).toMatchObject({
      advanced: false,
      green: null,
      reason: "repair-in-progress",
      from: ready,
    });
    // The judged sha is on the FROZEN side of the fixture, never the moving staging tip. The
    // frozen side holds exactly two shas — the candidate and the impostor head it refused to
    // promote — so naming both is exact, not a hedge, and it asserts strictly more than a bare
    // `not.toBe(stagingTip)` while committing to nothing the fixture does not already fix.
    expect([frozen, impostor]).toContain(held.candidate);
    // Fail-closed: nothing advanced, and the tip was NOT selected as a consolation candidate.
    expect(advancedCandidates).toEqual([]);
    expect(await revParse(repo, "ready")).toBe(ready);
    expect(await revParse(repo, "main")).toBe(stagingTip);
    expect(queue).toMatchObject({ repairHead: impostor });
  });

  it("retries forward from a red repair head without adopting the moving staging tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const repaired = await commit("b", "3", "first forward repair");
    await commit("c", "4", "newer unrelated staging tip");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 1,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      failingTests: ["@papercusp/operator-vite"],
      signature: postSuiteSignature(repaired),
    };
    const dispatchedHeads: string[] = [];
    const { deps, calls } = stubDeps(false, ["lib/still-broken.test.ts"]);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.dispatchFrozenRepairFixer = async (next) => {
      dispatchedHeads.push(next.repairHead);
      return { spawnId: "fixer-2", runId: "run-2" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      green: false,
      reason: "not-green",
      candidate: repaired,
      repairQueue: {
        phase: "awaiting-fixer",
        candidate: frozen,
        repairHead: repaired,
        attempts: 2,
        fixerSpawnId: "fixer-2",
        // The red test sweep deferred post-suite, so the prior post-suite blocker remains
        // unmeasured and must survive beside the fresh test failure.
        failingTests: ["lib/still-broken.test.ts", "@papercusp/operator-vite"],
      },
    });
    expect(queue).toMatchObject(result.repairQueue!);
    expect(dispatchedHeads).toEqual([repaired]);
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(await revParse(repo, "ready")).toBe(ready);
  });

  it("persists automation exhaustion as blocked and never selects a newer staging tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "newer staging tip");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 3,
      openedAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
      fixerSpawnId: "dead-fixer",
      failingTests: ["lib/still-broken.test.ts"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const writes: Array<FrozenCandidateRepairQueue | null> = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      writes.push(next);
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("an exhausted queue must not dispatch another fixer");
    };

    const first = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(first).toMatchObject({
      advanced: false,
      candidate: frozen,
      from: ready,
      green: null,
      reason: "repair-in-progress",
      repairQueue: {
        phase: "blocked",
        blockedReason: "attempts-exhausted",
        candidate: frozen,
        repairHead: frozen,
        attempts: 3,
      },
    });
    expect(first.summary).toContain("refusing to select a newer staging tip");
    expect(movingTip).not.toBe(frozen);
    expect(queue).toMatchObject({
      phase: "blocked",
      blockedReason: "attempts-exhausted",
      candidate: frozen,
      repairHead: frozen,
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      phase: "awaiting-fixer",
      fixerSpawnId: null,
      attempts: 3,
    });
    expect(writes[1]).toMatchObject({
      phase: "blocked",
      blockedReason: "attempts-exhausted",
    });
    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain("advance");
    expect(calls.some((call) => call.startsWith("setup:"))).toBe(false);

    const resumed = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(resumed).toMatchObject({
      candidate: frozen,
      green: null,
      reason: "repair-in-progress",
      repairQueue: {
        phase: "blocked",
        blockedReason: "attempts-exhausted",
      },
    });
    expect(writes).toHaveLength(2);
    expect(calls).not.toContain("runGreen");
  });

  /** P-008 (WI-1961441): the shared exhausted-pin fixture for the escape-hatch tests below. */
  const exhaustedPinFixture = async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "newer staging tip");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 3,
      openedAtMs: now - 60_000,
      updatedAtMs: now - 30_000,
      fixerSpawnId: "dead-fixer",
      failingTests: ["lib/still-broken.test.ts"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const writes: Array<FrozenCandidateRepairQueue | null> = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      writes.push(next);
      calls.push(next === null ? "write:null" : `write:${next.phase}`);
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    return {
      ready,
      frozen,
      movingTip,
      deps,
      calls,
      writes,
      queue: () => queue,
    };
  };

  it("D-005: an exhausted pin HOLDS — blocked row kept, no worktree abandonment, no suite, the moving tip is never read", async () => {
    // The P-048/P-008 recut hatch used to fire here: record an escape, write:null, clean the
    // worktree, and re-enter the gate at `movingTip`. Every one of those is now a regression.
    const { frozen, movingTip, deps, calls, writes } =
      await exhaustedPinFixture();
    const dispositions: Parameters<
      NonNullable<
        Parameters<typeof runGreenCheckpoint>[1]["recordFreezeDisposition"]
      >
    >[0][] = [];
    deps.recordFreezeDisposition = async (d) => {
      dispositions.push(d);
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: false,
      candidate: frozen,
      reason: "repair-in-progress",
      repairQueue: {
        phase: "blocked",
        blockedReason: "attempts-exhausted",
        candidate: frozen,
        repairHead: frozen,
      },
    });
    expect(result.candidate).not.toBe(movingTip);
    expect(writes[writes.length - 1]).toMatchObject({ phase: "blocked" });
    expect(calls).not.toContain("write:null");
    expect(calls).not.toContain("runGreen");
    expect(calls.filter((c) => c === "escalate")).toHaveLength(1);
    // The way OUT is named on the summary and recorded as queryable state: an admission
    // onto the frozen lineage, never a re-cut.
    expect(result.summary).toContain("op: 'admit'");
    expect(result.summary).not.toMatch(/re-?cut/i);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      enabled: true,
      state: "held",
      candidate: frozen,
    });
  });

  it("D-005: the hold auto-escalates exactly once, on the open→blocked transition — a resumed tick re-reads the blocked row silently", async () => {
    const { frozen, deps, calls } = await exhaustedPinFixture();

    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const escalationsAfterFirst = calls.filter((c) => c === "escalate").length;
    expect(escalationsAfterFirst).toBe(1);

    const resumed = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(calls.filter((c) => c === "escalate").length).toBe(
      escalationsAfterFirst,
    );
    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain("write:null");
    expect(resumed).toMatchObject({
      advanced: false,
      candidate: frozen,
      repairQueue: { phase: "blocked", candidate: frozen },
    });
  });
});

// EI-1762: pin the checkpoint log dir INSIDE the per-test temp repo (auto-cleaned by
// afterEach) so the suite never writes fixture logs into the REAL ~/.papercusp/checkpoint-logs/
// — those fixtures ('FAIL lib/foo.test.ts', 'SPA BUILD FAILED') masquerade as real
// checkpoint failures and mislead anyone diagnosing a deploy freeze.
const cfg = () =>
  releaseConfig({
    integrationRoot: repo,
    releaseRoot: repo,
    checkpointRoot: repo,
    releaseRef: "ready",
    integrationBranch: "main",
    checkpointLogDir: join(repo, ".checkpoint-logs"),
  });

beforeEach(async () => {
  // File-scoped console.warn spy: runGreenCheckpoint's execution emits deliberate,
  // env-dependent warns (best-effort probes that differ between a dev tree and the
  // gate's CHECKPOINT tree), and under the full forks-pool run the fail-on-console
  // tracker repeatedly attributed one to a ROVING test in this file — green locally
  // (82/82) but red on the gate ONLY (2026-07-05: 'docs-audit #2' one verdict, 'F2
  // perf BLOCK' the next; two ~50-min verdicts burned on the same phantom). Every
  // assertion in this suite goes through the injected `deps` stubs — nothing asserts
  // via console — so spying warn loses no coverage. console.error stays guarded.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  repo = mkdtempSync(join(tmpdir(), "green-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@e.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe("P-008: promoted frozen lineage is absorbed into staging history", () => {
  it("holds the git-sync lock, creates an ours merge, preserves staging's tree, and reports admitted-path differences", async () => {
    const base = await commit("shared.txt", "base", "base");
    await git(repo, ["branch", "repair", base]);
    await git(repo, ["checkout", "-q", "repair"]);
    const repairHead = await commit(
      "lib/admitted.ts",
      "promoted fix",
      "admitted frozen-lineage fix",
    );

    await git(repo, ["checkout", "-q", "main"]);
    await commit(
      "lib/admitted.ts",
      "newer staging edit",
      "independent staging edit",
    );
    const stagingBefore = await revParse(repo, "main");
    const treeBefore = await git(repo, [
      "rev-parse",
      "--verify",
      `${stagingBefore}^{tree}`,
    ]);
    const lockEvents: string[] = [];

    const result = await foldPromotedLineageIntoStaging(
      {
        integrationRoot: repo,
        integrationBranch: "main",
        repairHead,
        admittedPaths: ["lib/admitted.ts", "lib/admitted.ts"],
        workspaceId: "test-workspace",
        installSlug: "test-harness",
      },
      {
        withGitSyncLock: async (run) => {
          lockEvents.push("acquired:git-sync:test-harness");
          try {
            return await run();
          } finally {
            lockEvents.push("released:git-sync:test-harness");
          }
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "merged",
      stagingBefore,
      repairHead,
      differences: [{ path: "lib/admitted.ts" }],
    });
    expect(lockEvents).toEqual([
      "acquired:git-sync:test-harness",
      "released:git-sync:test-harness",
    ]);
    if (!result.ok) throw new Error(result.summary);
    expect(
      (
        await git(repo, ["show", "-s", "--format=%P", result.stagingAfter])
      ).split(" "),
    ).toEqual([stagingBefore, repairHead]);
    expect(
      await git(repo, [
        "rev-parse",
        "--verify",
        `${result.stagingAfter}^{tree}`,
      ]),
    ).toBe(treeBefore);
    expect(
      await git(repo, ["show", `${result.stagingAfter}:lib/admitted.ts`]),
    ).toBe("newer staging edit");
    expect(result.differences[0].promotedBlob).not.toBe(
      result.differences[0].stagingBlob,
    );

    // Idempotence is the crash-recovery contract: a retry sees ancestry already present and
    // creates no second merge commit.
    const retry = await foldPromotedLineageIntoStaging(
      {
        integrationRoot: repo,
        integrationBranch: "main",
        repairHead,
        admittedPaths: ["lib/admitted.ts"],
        workspaceId: "test-workspace",
        installSlug: "test-harness",
      },
      { withGitSyncLock: async (run) => run() },
    );
    expect(retry).toMatchObject({
      ok: true,
      status: "already-descendant",
      stagingBefore: result.stagingAfter,
      stagingAfter: result.stagingAfter,
    });
    expect(await revParse(repo, "main")).toBe(result.stagingAfter);
  });

  it("absorbs while a peer holds the shared index lock, without touching the index or working tree (WI-10003922)", async () => {
    const base = await commit("shared.txt", "base", "base");
    await git(repo, ["branch", "repair", base]);
    await git(repo, ["checkout", "-q", "repair"]);
    const repairHead = await commit("fix.ts", "repair", "repair");
    await git(repo, ["checkout", "-q", "main"]);
    const stagingBefore = await commit("staging.ts", "tip", "staging tip");
    writeFileSync(join(repo, "peer-unstaged.ts"), "uncommitted peer work");
    // Porcelain `git merge` needs this lock (save_state runs `git stash create`, which writes
    // the main index). On the shared tree any agent's git command can hold it, which made the
    // bridge fail with "fatal: stash failed" while it held git-sync.
    const indexLock = join(repo, ".git", "index.lock");
    writeFileSync(indexLock, "held-by-peer");

    const result = await foldPromotedLineageIntoStaging(
      {
        integrationRoot: repo,
        integrationBranch: "main",
        repairHead,
        admittedPaths: ["fix.ts"],
        workspaceId: "test-workspace",
        installSlug: "test-harness",
      },
      { withGitSyncLock: async (run) => run() },
    );

    expect(result).toMatchObject({ ok: true, status: "merged", stagingBefore });
    if (!result.ok) throw new Error(result.summary);
    expect(
      (
        await git(repo, ["show", "-s", "--format=%P", result.stagingAfter])
      ).split(" "),
    ).toEqual([stagingBefore, repairHead]);
    expect(await revParse(repo, "main")).toBe(result.stagingAfter);
    expect(await git(repo, ["show", "-s", "--format=%s", result.stagingAfter])).toBe(
      `green-checkpoint: absorb promoted frozen lineage ${repairHead.slice(0, 12)}`,
    );
    expect(readFileSync(join(repo, "peer-unstaged.ts"), "utf8")).toBe(
      "uncommitted peer work",
    );
    expect(readFileSync(indexLock, "utf8")).toBe("held-by-peer");
  });

  it("fails closed instead of leaking a staged peer change into the ancestry commit", async () => {
    const base = await commit("shared.txt", "base", "base");
    await git(repo, ["branch", "repair", base]);
    await git(repo, ["checkout", "-q", "repair"]);
    const repairHead = await commit("fix.ts", "repair", "repair");
    await git(repo, ["checkout", "-q", "main"]);
    const stagingBefore = await commit("staging.ts", "tip", "staging tip");
    writeFileSync(join(repo, "peer.ts"), "uncommitted peer work");
    await git(repo, ["add", "peer.ts"]);

    const result = await foldPromotedLineageIntoStaging(
      {
        integrationRoot: repo,
        integrationBranch: "main",
        repairHead,
        admittedPaths: ["fix.ts"],
        workspaceId: "test-workspace",
        installSlug: "test-harness",
      },
      { withGitSyncLock: async (run) => run() },
    );

    expect(result).toMatchObject({ ok: false, status: "index-dirty" });
    expect(await revParse(repo, "main")).toBe(stagingBefore);
  });
});

describe("P-008: queue clearing is serialized after staging absorption", () => {
  it("keeps ready-to-promote on lock contention, then retries only the bridge without another suite", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const repaired = await commit("b", "fixed", "admitted repair");
    await git(repo, [
      "update-ref",
      `refs/papercusp/frozen/${frozen}`,
      repaired,
    ]);
    await git(repo, ["reset", "--hard", ready]);
    const stagingTip = await commit("c", "later", "moving staging tip");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: repaired,
      affectedTestProofGroup: "initial-proof-run",
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: "fixer-1",
      // This cannot be selectively re-run, so one full canonical gate at repairHead is the
      // promotion proof. The test's subject starts immediately after that proof.
      failingTests: ["papercusp-desktop :: cargo test"],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.frozenRepairFixerAlive = async () => false;
    let absorptionAttempts = 0;
    deps.absorbPromotedLineageIntoStaging = async (current) => {
      calls.push("absorb-staging");
      absorptionAttempts += 1;
      // The bridge is downstream of the green-pin fast-forward, never a pre-promotion merge.
      expect(await revParse(repo, "ready")).toBe(repaired);
      if (absorptionAttempts === 1) {
        return {
          ok: false,
          status: "lock-busy",
          repairHead: current.repairHead,
          differences: [],
          summary: "git-sync:test is busy",
        };
      }
      return {
        ok: true,
        status: "already-descendant",
        stagingBefore: stagingTip,
        stagingAfter: stagingTip,
        repairHead: current.repairHead,
        differences: [],
        summary: "staging ancestry already absorbed",
      };
    };

    const promoted = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(promoted).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
      candidate: repaired,
      repairQueue: { phase: "ready-to-promote", repairHead: repaired },
    });
    expect(promoted.summary).toContain("ready-to-promote queue remains");
    expect(queue).toMatchObject({
      phase: "ready-to-promote",
      repairHead: repaired,
    });
    expect(calls.indexOf("advance")).toBeLessThan(
      calls.indexOf("absorb-staging"),
    );
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);

    const recovered = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(recovered).toMatchObject({
      advanced: false,
      green: null,
      reason: "up-to-date",
      candidate: repaired,
    });
    expect(recovered.summary).toContain("post-promotion staging bridge");
    expect(queue).toBeNull();
    expect(absorptionAttempts).toBe(2);
    // No second selective proof, full suite, or advance: ready-to-promote + main==repairHead
    // is the durable crash marker for retrying exactly the missing bridge.
    expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
    expect(calls.filter((call) => call === "advance")).toHaveLength(1);
  });
});

describe("in-flight candidate publication", () => {
  it("awaits marker publication before checkpoint tree setup begins", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    const order: string[] = [];
    deps.recordInFlightCandidate = async () => {
      await Promise.resolve();
      order.push("published");
    };
    deps.setupTree = async () => {
      order.push("setup");
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(order.slice(0, 2)).toEqual(["published", "setup"]);
  });
});

describe("in-flight candidate retirement ownership", () => {
  it("does not let a skipped-locked process clear the live holder's marker", async () => {
    const clear = vi.fn(async () => {});

    await expect(
      retireInFlightCandidateAfterResult({ reason: "skipped-locked" }, clear),
    ).resolves.toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });

  it.each(["advanced", "not-green", "infra-inconclusive"] as const)(
    "retires the marker for the lock-owning %s terminal path",
    async (reason) => {
      const clear = vi.fn(async () => {});

      await expect(
        retireInFlightCandidateAfterResult({ reason }, clear),
      ).resolves.toBe(true);
      expect(clear).toHaveBeenCalledTimes(1);
    },
  );
});

describe("qualification attach race (WI-6554700010009570)", () => {
  const incumbentRunner = {
    id: "gate-fire-scheduled",
    candidate: "0a16d4a6fa0000000000000000000000000000aa",
    reservedAtMs: 1,
    evidenceRefs: [],
    pid: 3842170,
    pidIdentity: "start:123",
    unit: "papercup-green-checkpoint-scheduled",
  };
  const conflict = (runner: typeof incumbentRunner | null, runId: string | null = "4bbfb5d7-run") => ({
    status: "conflict",
    transaction: { runId, candidate: "0a16d4a6fa0000000000000000000000000000aa", currentPhysicalRunner: runner },
  });
  const self = { pid: 4000001, runId: "8d95fde3-run" };

  it("reports a candidate refusal with matching own-unit ids without claiming launcher skew (P-033)", () => {
    const runner = { ...incumbentRunner, id: 'same-fire', unit: 'own.scope' };
    const summary = checkpointQualificationAttachmentRefusalSummary({
      ...conflict(runner), refusalReason: 'candidate-mismatch',
      transaction: { ...conflict(runner).transaction, attemptId: 'attempt-1' },
    }, { attemptId: 'attempt-1', gateFireId: 'same-fire', candidate: 'different-candidate', runId: self.runId }, ['own.scope']);
    expect(summary).toContain('refusalReason=candidate-mismatch');
    expect(summary).toContain('reservation id and transported gateFireId agree (same-fire)');
    expect(summary).toContain('candidate=different-candidate');
    expect(summary).not.toContain('version skew');
    expect(summary).not.toContain('disagree');
  });

  it("claims own-unit launcher skew only for different physical ids (P-033)", () => {
    const runner = { ...incumbentRunner, id: 'reserved-fire', unit: 'own.scope' };
    const summary = checkpointQualificationAttachmentRefusalSummary({
      ...conflict(runner), refusalReason: 'runner-held',
      transaction: { ...conflict(runner).transaction, attemptId: 'attempt-1' },
    }, { attemptId: 'attempt-1', gateFireId: 'attached-fire', candidate: 'candidate-1', runId: self.runId }, ['own.scope']);
    expect(summary).toContain('reservation id and the transported gateFireId attached-fire disagree');
    expect(summary).toContain('version skew');
    expect(summary).toContain('refusalReason=runner-held');
    expect(checkpointQualificationAttachmentRefusalSummary({ status: 'missing-identity' }, {
      candidate: null, runId: self.runId,
    }, [])).toBe('checkpoint qualification runner attachment refused: missing-identity; refusalReason=unknown');
  });

  it("names a LIVE different runner so the losing fire stands down instead of crashing", async () => {
    const probe = vi.fn(async () => "live" as const);
    const incumbent = await liveIncumbentAfterAttachConflict(conflict(incumbentRunner), self, probe);
    expect(incumbent).toEqual({
      runner: incumbentRunner,
      runId: "4bbfb5d7-run",
      candidate: "0a16d4a6fa0000000000000000000000000000aa",
    });
    expect(probe).toHaveBeenCalledWith(incumbentRunner);
    const summary = attachRaceSkipSummary(incumbent!);
    expect(summary).toContain("runId 4bbfb5d7");
    expect(summary).toContain("pid 3842170");
    expect(summary).toContain("on 0a16d4a6fa00");
  });

  it.each(["dead", "unknown"] as const)("keeps the crash path when the incumbent is %s", async (liveness) => {
    await expect(
      liveIncumbentAfterAttachConflict(conflict(incumbentRunner), self, async () => liveness),
    ).resolves.toBeNull();
  });

  it("keeps the crash path when the liveness probe throws", async () => {
    await expect(
      liveIncumbentAfterAttachConflict(conflict(incumbentRunner), self, async () => {
        throw new Error("systemctl unavailable");
      }),
    ).resolves.toBeNull();
  });

  it("never treats this process, its own runId, a missing runner or a non-conflict refusal as an incumbent", async () => {
    const live = vi.fn(async () => "live" as const);
    await expect(
      liveIncumbentAfterAttachConflict(conflict({ ...incumbentRunner, pid: self.pid }), self, live),
    ).resolves.toBeNull();
    await expect(
      liveIncumbentAfterAttachConflict(conflict(incumbentRunner, self.runId), self, live),
    ).resolves.toBeNull();
    await expect(liveIncumbentAfterAttachConflict(conflict(null), self, live)).resolves.toBeNull();
    await expect(
      liveIncumbentAfterAttachConflict({ ...conflict(incumbentRunner), status: "terminal" }, self, live),
    ).resolves.toBeNull();
    await expect(liveIncumbentAfterAttachConflict({ status: "missing-identity" }, self, live)).resolves.toBeNull();
    expect(live).not.toHaveBeenCalled();
  });

  it("never treats a reservation recorded under THIS process's own unit as a live incumbent (WI-6554700010009727)", async () => {
    // Measured 2026-10-13 03:51Z: a manual reservation with pid and runId null, whose unit was the CLI's
    // own unit; the probe said `live` because it was probing the caller, and the run stood down on itself.
    const ownManual = {
      ...incumbentRunner,
      id: "manual:e4939c92:1791863496390",
      pid: null,
      pidIdentity: null,
      unit: "papercup-green-checkpoint-manual-1fxzuva.service",
    };
    const live = vi.fn(async () => "live" as const);
    const units = ["user@1000.service", "papercup-green-checkpoint-manual-1fxzuva.service"];
    await expect(
      liveIncumbentAfterAttachConflict(conflict(ownManual as never, null), { ...self, units }, live),
    ).resolves.toBeNull();
    expect(live).not.toHaveBeenCalled();
    // A DIFFERENT unit stays a real incumbent even when this process knows its own units.
    await expect(
      liveIncumbentAfterAttachConflict(conflict(incumbentRunner), { ...self, units }, live),
    ).resolves.not.toBeNull();
  });

  it("adopts only its own legacy runner id after a runner-held attach conflict", async () => {
    const ownManual = {
      ...incumbentRunner,
      id: "manual:attempt-1:123",
      pid: null,
      pidIdentity: null,
      unit: "papercup-green-checkpoint-manual-1fxzuva.service",
    };
    const selfUnits = ["user@1000.service", ownManual.unit];
    const activation = {
      ...conflict(ownManual as never, null),
      refusalReason: "runner-held",
      transaction: { ...conflict(ownManual as never, null).transaction, attemptId: "attempt-1" },
    } as never;
    const input = {
      target: { workspaceId: "workspace", installSlug: "papercusp" },
      attemptId: "attempt-1",
      gateFireId: "attached-fire",
      runId: "run-1",
      candidate: ownManual.candidate,
      pid: 456,
    } as never;

    expect(ownUnitReservationRunnerIdAfterAttachConflict(activation, input.gateFireId, selfUnits)).toBe(ownManual.id);

    const attached = { status: "updated" } as never;
    const retry = vi.fn(async () => attached) as never;
    const result = await adoptOwnUnitRunnerReservationAfterAttachConflict(activation, input, selfUnits, retry);
    expect(retry).toHaveBeenCalledWith({ ...input, gateFireId: ownManual.id });
    expect(result).toMatchObject({ activation: attached, runnerId: ownManual.id, adopted: true });

    const foreign = { ...ownManual, unit: "another-checkpoint.service" };
    const foreignActivation = {
      ...conflict(foreign as never, null),
      refusalReason: "runner-held",
      transaction: { ...conflict(foreign as never, null).transaction, attemptId: "attempt-1" },
    } as never;
    expect(ownUnitReservationRunnerIdAfterAttachConflict(foreignActivation, input.gateFireId, selfUnits)).toBeNull();
    await expect(
      adoptOwnUnitRunnerReservationAfterAttachConflict(foreignActivation, input, selfUnits, retry),
    ).resolves.toMatchObject({ activation: foreignActivation, runnerId: input.gateFireId, adopted: false });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps the adopted physical runner id for the post-preflight reservation refresh", () => {
    const input = {
      target: { workspaceId: "workspace", installSlug: "papercusp" },
      attemptId: "attempt-1",
      gateFireId: "fire-1",
      runId: "run-1",
      candidate: "candidate-sha",
      pid: 456,
    };

    expect(checkpointQualificationRunnerRefreshInput(input, "manual:attempt-1:123")).toEqual({
      ...input,
      gateFireId: "manual:attempt-1:123",
    });
    expect(checkpointQualificationRunnerRefreshInput(input, undefined)).toEqual(input);
  });

  it("reads this process's systemd units from a cgroup v2 path and fails open to [] when unreadable", () => {
    expect(
      ownCgroupUnits(
        () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/papercup-green-checkpoint-manual-1fxzuva.service\n",
      ),
    ).toEqual(["user@1000.service", "papercup-green-checkpoint-manual-1fxzuva.service"]);
    expect(
      ownCgroupUnits(() => "0::/user.slice/user-1000.slice/user@1000.service/papercusp-checkpoint-e4939c92.scope/sub\n"),
    ).toEqual(["user@1000.service", "papercusp-checkpoint-e4939c92.scope"]);
    expect(
      ownCgroupUnits(() => {
        throw new Error("ENOENT");
      }),
    ).toEqual([]);
    expect(runnerUnitIsOwn({ unit: "a.service" }, ["a.service"])).toBe(true);
    expect(runnerUnitIsOwn({ unit: "a.service" }, ["b.service"])).toBe(false);
    expect(runnerUnitIsOwn({ unit: null }, ["a.service"])).toBe(false);
    expect(runnerUnitIsOwn({ unit: "a.service" }, undefined)).toBe(false);
  });

  it("stands down on the lock-loser terminal, which never retires the holder's in-flight marker", async () => {
    const clear = vi.fn(async () => {});
    await expect(retireInFlightCandidateAfterResult({ reason: "skipped-locked" }, clear)).resolves.toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("acquireCheckpointRunLock", () => {
  it('uses the scheduled wrapper runId for its child and preserves legacy sentinel behavior', () => {
    const shared = 'ae4f7c6c-56c6-4bb6-8d38-633a23f94a4f';
    expect(checkpointRunIdFromScheduledEnv(shared, () => 'new')).toBe(shared);
    expect(checkpointRunIdFromScheduledEnv('1', () => 'new')).toBe('new');
    expect(checkpointRunIdFromScheduledEnv(undefined, () => 'new')).toBe('new');
    expect(checkpointRunIdFromScheduledEnv('untrusted', () => 'new')).toBe('new');
  });
  it("records one exact-candidate terminal result before releasing buffered green/red wakes", async () => {
    const order: string[] = [];
    const emitted: string[] = [];
    const buffer = createCheckpointTerminalEventBuffer(async (event) => {
      order.push('wake');
      emitted.push(event.key);
    }, (message) => order.push(`warn:${message}`));
    const red = { key: 'green-checkpoint:red:papercusp', summary: 'red', payload: { sha: 'candidate-1', runId: 'run-1' } };
    await buffer.emit(red);
    await buffer.emit(red); // replay of the same exact key/candidate/run is one wake
    await buffer.emit({ key: 'green-checkpoint:red:papercusp', summary: 'other', payload: { sha: 'candidate-2', runId: 'run-1' } });
    expect(emitted).toEqual([]);
    const result = { candidate: 'candidate-1', runId: 'run-1', green: false, reason: 'not-green' } as CheckpointResult;
    await emitTerminalCheckpointResult(result, {
      record: async () => { order.push('record'); return true; },
      writeHuman: () => order.push('human'),
      writeMarker: () => order.push('marker'),
      emitTerminalEvents: buffer.flush,
      emitInconclusive: async () => { order.push('inconclusive'); },
      retire: async () => { order.push('retire'); },
    });
    expect(emitted).toEqual(['green-checkpoint:red:papercusp']);
    expect(order.slice(0, 4)).toEqual(['record', 'human', 'marker', 'wake']);
    expect(order.some((entry) => entry.includes('identity does not match'))).toBe(true);
    await buffer.emit(red);
    await buffer.flush(result, false);
    expect(emitted).toHaveLength(1);
  });
  it("reports qualification runner phases against the reserved attempt and stops before terminal output", async () => {
    const record = vi.fn(async (..._args: unknown[]) => ({ status: 'updated' as const, transaction: {} as never }));
    const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
    const progress = startCheckpointQualificationProgress({
      target, attemptId: 'attempt-1', gateFireId: 'fire-1', runId: 'run-1', pid: process.pid,
    }, record, 60_000);
    progress.note('phase:suite');
    progress.note('phase:isolating');
    progress.note('phase:delivering');
    await progress.stop();
    expect(record.mock.calls.map(([, input]) => (input as { phase: string }).phase)).toEqual(['suite', 'isolating', 'delivering']);
    expect(record).toHaveBeenCalledWith(target, expect.objectContaining({
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      pidIdentity: expect.stringMatching(/:\d+$/),
    }));
    progress.note('phase:suite');
    expect(record).toHaveBeenCalledTimes(3);
  });
  it("logs bounded, redacted details for scheduled qualification progress failures", async () => {
    const unsafeError = `database unavailable\npassword=unit-test-secret ${"x".repeat(400)}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
      const refused = vi.fn(async (..._args: unknown[]) => ({
        status: 'unreadable' as const,
        error: unsafeError,
      }));
      const refusedProgress = startCheckpointQualificationProgress({
        target, attemptId: 'attempt-1', gateFireId: 'fire-1', runId: 'run-1', pid: process.pid,
      }, refused, 60_000);
      refusedProgress.note('phase:suite');
      await refusedProgress.stop();

      const rejected = vi.fn(async (..._args: unknown[]) => { throw new Error(unsafeError); });
      const rejectedProgress = startCheckpointQualificationProgress({
        target, attemptId: 'attempt-2', gateFireId: 'fire-2', runId: 'run-2', pid: process.pid,
      }, rejected, 60_000);
      rejectedProgress.note('phase:suite');
      await rejectedProgress.stop();

      expect(warn).toHaveBeenCalledTimes(2);
      const lines = warn.mock.calls.map(([message]) => String(message));
      expect(lines[0]).toContain('scheduled runner progress refused: unreadable');
      expect(lines[1]).toContain('scheduled runner progress failed');
      for (const line of lines) {
        expect(line).toContain('database unavailable');
        expect(line).not.toContain('unit-test-secret');
        expect(line).not.toMatch(/[\r\n]/);
        expect(line.length).toBeLessThan(400);
      }
    } finally {
      warn.mockRestore();
    }
  });
  it("keeps qualification progress fresh while dependency preflight is pending", async () => {
    vi.useFakeTimers();
    try {
      const record = vi.fn(async (..._args: unknown[]) => ({ status: 'updated' as const, transaction: {} as never }));
      const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
      const progress = startCheckpointQualificationProgress({
        target, attemptId: 'manual-attempt-1', gateFireId: 'manual-fire-1', runId: 'run-1', pid: process.pid,
      }, record, 10);
      let preflightFinished = false;
      const preflight = new Promise<void>((resolve) => {
        setTimeout(() => { preflightFinished = true; resolve(); }, 35);
      });

      await vi.advanceTimersByTimeAsync(35);
      await preflight;
      await progress.stop();

      expect(preflightFinished).toBe(true);
      expect(record).toHaveBeenCalled();
      expect(record.mock.calls.some(([, input]) => (input as { phase: string }).phase === 'materializing')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("attaches manual or scheduled CLI processes to the exact qualification reservation", async () => {
    const reserve = vi.fn(async () => ({ status: 'updated' as const, transaction: {} as never }));
    const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
    const input = {
      target, attemptId: 'attempt-1', gateFireId: 'fire-1',
      runId: 'run-1', candidate: 'candidate-1', pid: process.pid,
    };
    const result = await activateCheckpointQualificationRunner(input, reserve);
    expect(result.status).toBe('updated');
    expect(reserve).toHaveBeenCalledWith(target, expect.objectContaining({
      attemptId: 'attempt-1', runnerId: 'fire-1', runId: 'run-1',
      candidate: 'candidate-1', pid: process.pid, pidIdentity: expect.stringMatching(/:\d+$/),
      started: true, evidenceRefs: ['checkpoint-run:run-1'],
    }));
    expect((await activateCheckpointQualificationRunner({ ...input, gateFireId: undefined }, reserve)).status)
      .toBe('missing-identity');
    expect((await activateCheckpointQualificationRunner({ ...input, attemptId: undefined }, reserve)).status)
      .toBe('not-qualifying');
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it("a scheduled fire that joined a pinned attempt judges that attempt's candidate, not tip (WI-10002602)", async () => {
    // Without this the child resolved staging tip, activation refused the candidate mismatch
    // with `conflict`, and every later fire re-joined the same wedged attempt.
    const target = { workspaceId: 'ws-1', installSlug: 'papercusp' };
    const present = (attemptId: string, candidate: string | null) => vi.fn(async () => ({
      status: 'present' as const,
      transaction: { attemptId, candidate } as never,
    }));
    const base = { scheduled: true, candidateArg: undefined, target, attemptId: 'attempt-1' };
    expect(await scheduledAttemptPinnedCandidate(base, present('attempt-1', 'repair-head-sha'))).toBe('repair-head-sha');
    // A fresh attempt has no candidate yet: resolve as before.
    expect(await scheduledAttemptPinnedCandidate(base, present('attempt-1', null))).toBeNull();
    // A different attempt, a manual run, an explicit --candidate, or a missing row never pins.
    expect(await scheduledAttemptPinnedCandidate(base, present('attempt-2', 'other-sha'))).toBeNull();
    const unread = present('attempt-1', 'repair-head-sha');
    expect(await scheduledAttemptPinnedCandidate({ ...base, scheduled: false }, unread)).toBeNull();
    expect(await scheduledAttemptPinnedCandidate({ ...base, candidateArg: 'explicit-sha' }, unread)).toBeNull();
    expect(unread).not.toHaveBeenCalled();
    expect(await scheduledAttemptPinnedCandidate(base, vi.fn(async () => ({ status: 'none' as const })))).toBeNull();
    expect(await scheduledAttemptPinnedCandidate(base, vi.fn(async () => { throw new Error('pg down'); }))).toBeNull();
  });
  it("a joined scheduled attempt prewarms the runnable frozen repair candidate", async () => {
    const assess = vi.fn(async () => ({
      proceed: true as const,
      reason: 'clear' as const,
      candidate: 'repair-head-sha',
      candidateSource: 'frozen-repair-queue' as const,
      repairQueue: null,
      frozenLineageIdentity: null,
      queueDecision: 'verify-repair' as const,
      nextAttempt: null,
      fixerSpawnId: null,
      fixerAlive: null,
    }));

    const selected = await scheduledAttemptPrewarmTarget('frozen-candidate-sha', {
      assess,
      root: '/checkpoint',
    });

    expect(assess).toHaveBeenCalledWith('frozen-candidate-sha', '/checkpoint');
    expect(selected).toEqual({
      candidate: 'repair-head-sha',
      candidateSource: 'frozen-repair-queue',
    });
  });
  it("blocks a second live checkpoint process from mutating the same checkpoint tree", () => {
    const lockDir = join(
      repo,
      ".checkpoint-logs",
      ".green-checkpoint-run.lock",
    );
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: (pid) => pid === 123,
    });
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: (pid) => pid === 123,
    });
    expect(first.acquired).toBe(true);
    expect(second).toMatchObject({ acquired: false, owner: { pid: 123 } });
    first.release();
    const third = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(third.acquired).toBe(true);
    third.release();
  });

  it("clears a stale checkpoint lock whose owner pid is no longer alive", () => {
    const lockDir = join(
      repo,
      ".checkpoint-logs",
      ".green-checkpoint-run.lock",
    );
    const stale = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
    });
    expect(stale.acquired).toBe(true);
    const next = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => false,
    });
    expect(next.acquired).toBe(true);
    stale.release();
    next.release();
  });

  it("reclaims a recycled PID only when its boot/start identity changed", () => {
    // The green-checkpoint-stale-lock-2026-06-26 freeze: a crashed/hung run left a lock
    // whose recorded pid got recycled to an unrelated LIVE process, so the dead-pid check
    // never reclaimed it and `main` froze for 21h. An over-age lock must reclaim regardless.
    const lockDir = join(
      repo,
      ".checkpoint-logs",
      ".green-checkpoint-run.lock",
    );
    const t0 = Date.parse("2026-06-26T00:00:00Z");
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
      getPidIdentity: () => "boot-a:start-1",
      now: () => t0,
    });
    expect(first.acquired).toBe(true);
    // The same numeric PID now names a different process, so the former owner is dead.
    const next = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => true,
      getPidIdentity: (pid) => pid === 123 ? "boot-a:start-2" : "boot-a:start-3",
      staleAfterMs: 45 * 60_000,
      now: () => t0 + 46 * 60_000,
    });
    expect(next.acquired).toBe(true);
    next.release();
  });

  it("keeps an old but live owner serialized and exposes its exceeded deadline", () => {
    const lockDir = join(repo, ".checkpoint-logs", ".green-checkpoint-run.lock");
    const t0 = Date.parse("2026-06-26T00:00:00Z");
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123, isPidAlive: () => true, getPidIdentity: () => "boot-a:start-1", now: () => t0,
    });
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456, isPidAlive: () => true,
      getPidIdentity: (pid) => pid === 123 ? "boot-a:start-1" : "boot-a:start-2",
      staleAfterMs: 45 * 60_000, now: () => t0 + 191 * 60_000,
    });
    expect(second).toMatchObject({
      acquired: false,
      owner: { pid: 123, pidIdentity: "boot-a:start-1", detail: expect.stringContaining("deadline") },
    });
    first.release();
  });

  it("fails closed when a live PID has no measurable process identity", () => {
    const lockDir = join(repo, ".checkpoint-logs", ".green-checkpoint-run.lock");
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123, isPidAlive: () => true, getPidIdentity: () => null,
    });
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456, isPidAlive: () => true, getPidIdentity: () => null,
    });
    expect(second).toMatchObject({ acquired: false, owner: { detail: expect.stringContaining("unknown") } });
    expect(checkpointRunLockSkipSummary(second)).toContain("live PID identity unknown; reclaim requires proof");
    first.release();
  });

  it("does NOT reclaim a fresh lock with a live pid (genuine concurrent run still blocks)", () => {
    const lockDir = join(
      repo,
      ".checkpoint-logs",
      ".green-checkpoint-run.lock",
    );
    const t0 = Date.parse("2026-06-26T00:00:00Z");
    const first = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
      now: () => t0,
    });
    expect(first.acquired).toBe(true);
    // 10 min later (within the run window) a live owner → the second acquire is BLOCKED.
    const second = acquireCheckpointRunLock(lockDir, {
      pid: 456,
      isPidAlive: () => true,
      staleAfterMs: 45 * 60_000,
      now: () => t0 + 10 * 60_000,
    });
    expect(second).toMatchObject({ acquired: false, owner: { pid: 123 } });
    first.release();
  });

  it("publishes the initial phase before the live lock owner becomes visible", () => {
    const lockDir = join(repo, ".checkpoint-logs", ".green-checkpoint-run.lock");
    const ownerPath = join(lockDir, "owner.json");
    let phaseBeforeOwner: unknown;
    let ownerWasAbsent = false;
    const lock = acquireCheckpointRunLock(lockDir, {
      pid: 123,
      isPidAlive: () => true,
      getPidIdentity: () => {
        phaseBeforeOwner = JSON.parse(readFileSync(join(lockDir, "phase.json"), "utf8"));
        ownerWasAbsent = !existsSync(ownerPath);
        return "boot-a:start-1";
      },
    });

    try {
      expect(lock.acquired).toBe(true);
      expect(phaseBeforeOwner).toMatchObject({ phase: "materializing" });
      expect(ownerWasAbsent).toBe(true);
      expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({ pid: 123 });
    } finally {
      lock.release();
    }
  });

  describe("checkpointRunLockDir (per-root lock — cross-lineage starvation fix, 2026-07-02)", () => {
    it("the same root always maps to the same lock dir (cron-vs-manual still single-flights)", () => {
      const a = checkpointRunLockDir(
        "/home/x/.papercusp/checkpoint-logs",
        "/home/x/ws/papercusp",
      );
      const b = checkpointRunLockDir(
        "/home/x/.papercusp/checkpoint-logs",
        "/home/x/ws/papercusp",
      );
      expect(a).toBe(b);
      expect(a.startsWith("/home/x/.papercusp/checkpoint-logs/")).toBe(true);
      expect(a).toMatch(/\.green-checkpoint-run-[0-9a-z]+\.lock$/);
    });

    it("different roots sharing one log dir get DIFFERENT locks (the papercup-root lineage cannot starve the papercusp gate)", () => {
      const logDir = "/home/x/.papercusp/checkpoint-logs";
      const cusp = checkpointRunLockDir(logDir, "/home/x/ws/papercusp");
      const cup = checkpointRunLockDir(logDir, "/home/x/ws/papercup");
      expect(cusp).not.toBe(cup);
      // Neither collides with the legacy unsuffixed name old-lineage code still writes.
      expect(cusp).not.toBe(join(logDir, ".green-checkpoint-run.lock"));
      expect(cup).not.toBe(join(logDir, ".green-checkpoint-run.lock"));
    });

    it("two roots contend only on their own lock end-to-end (acquire under root A never blocks root B)", () => {
      const logDir = join(repo, ".checkpoint-logs");
      const lockA = acquireCheckpointRunLock(
        checkpointRunLockDir(logDir, "/ws/rootA"),
        { pid: 123, isPidAlive: () => true },
      );
      const lockB = acquireCheckpointRunLock(
        checkpointRunLockDir(logDir, "/ws/rootB"),
        { pid: 456, isPidAlive: () => true },
      );
      expect(lockA.acquired).toBe(true);
      expect(lockB.acquired).toBe(true); // pre-fix this was the hourly 'skipped-locked'
      lockA.release();
      lockB.release();
    });
  });
});

describe("createTerminationSignalHandler (EI-10680: replaceStale relaunched into skipped-locked against the run it just stopped)", () => {
  it('releases (via releaseAndExit) on SIGTERM, so an external "stop this run" deterministically frees the lock', () => {
    const releaseAndExit = vi.fn();
    const log = vi.fn();
    const handler = createTerminationSignalHandler(releaseAndExit, log);
    handler("SIGTERM");
    expect(releaseAndExit).toHaveBeenCalledTimes(1);
    expect(releaseAndExit).toHaveBeenCalledWith(143);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("SIGTERM");
  });

  it("releases on SIGINT too (the same handler is installed for both)", () => {
    const releaseAndExit = vi.fn();
    const handler = createTerminationSignalHandler(releaseAndExit, () => {});
    handler("SIGINT");
    expect(releaseAndExit).toHaveBeenCalledWith(143);
  });

  it("defaults to console.error when no log fn is injected (does not throw)", () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const releaseAndExit = vi.fn();
      const handler = createTerminationSignalHandler(releaseAndExit);
      expect(() => handler("SIGTERM")).not.toThrow();
      expect(releaseAndExit).toHaveBeenCalledWith(143);
      expect(consoleErr).toHaveBeenCalledTimes(1);
    } finally {
      consoleErr.mockRestore();
    }
  });

  it("builds a truthful cancelled result with an explicit unknown sender", () => {
    expect(
      buildTerminationCheckpointResult({
        candidate: "candidate-sha",
        from: "ready-sha",
        signal: "SIGTERM",
        runId: "run-1",
      }),
    ).toMatchObject({
      advanced: false,
      candidate: "candidate-sha",
      from: "ready-sha",
      green: null,
      reason: "cancelled",
      runId: "run-1",
      termination: {
        mechanism: "managed-signal",
        signal: "SIGTERM",
        sender: null,
      },
    });
  });

  it("awaits the durable finalizer before release and suppresses a duplicate signal", async () => {
    const order: string[] = [];
    let finishFinalizer: (() => void) | undefined;
    const finalizerGate = new Promise<void>((resolve) => {
      finishFinalizer = resolve;
    });
    const releaseAndExit = vi.fn(() => {
      order.push("release");
    });
    const finalize = vi.fn(async (signal: NodeJS.Signals) => {
      order.push(`finalize:${signal}:start`);
      await finalizerGate;
      order.push(`finalize:${signal}:done`);
    });
    const handler = createTerminationSignalHandler(
      releaseAndExit,
      (message) => order.push(`log:${message}`),
      finalize,
    );

    const first = handler("SIGTERM");
    const duplicate = handler("SIGINT");
    expect(order[0]).toContain("log:received SIGTERM");
    expect(order[1]).toBe("finalize:SIGTERM:start");
    expect(releaseAndExit).not.toHaveBeenCalled();
    expect(duplicate).toBeUndefined();

    finishFinalizer?.();
    await first;

    expect(order).toEqual([
      expect.stringContaining("log:received SIGTERM"),
      "finalize:SIGTERM:start",
      "finalize:SIGTERM:done",
      "release",
    ]);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(releaseAndExit).toHaveBeenCalledTimes(1);
    expect(releaseAndExit).toHaveBeenCalledWith(143);
  });

  it("does not release when normal completion already claimed the terminal race", async () => {
    const releaseAndExit = vi.fn();
    const handler = createTerminationSignalHandler(
      releaseAndExit,
      () => {},
      async () => false,
    );

    await handler("SIGTERM");

    expect(releaseAndExit).not.toHaveBeenCalled();
  });
});

describe("armSelfWatchdog (WI-1319 root fix (c) — orphaned OS process past DBOS cancellation)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the self-watchdog at the 3h long-run floor", () => {
    expect(SELF_WATCHDOG_MS).toBeGreaterThanOrEqual(3 * 60 * 60_000);
  });

  it("uses the validated manual watchdog transport while scheduled runs retain the 3h default", () => {
    expect(selfWatchdogMsFromEnv({})).toBe(SELF_WATCHDOG_MS);
    expect(
      selfWatchdogMsFromEnv({
        [MANUAL_SELF_WATCHDOG_ENV]: String(MIN_MANUAL_SELF_WATCHDOG_MS),
      }),
    ).toBe(MIN_MANUAL_SELF_WATCHDOG_MS);

    for (const invalid of [
      "0",
      "NaN",
      String(MIN_MANUAL_SELF_WATCHDOG_MS - 1),
      String(SELF_WATCHDOG_MS + 1),
      `${MIN_MANUAL_SELF_WATCHDOG_MS}.5`,
    ]) {
      expect(
        selfWatchdogMsFromEnv({ [MANUAL_SELF_WATCHDOG_ENV]: invalid }),
      ).toBe(SELF_WATCHDOG_MS);
    }
  });

  it("classifies a validated manual deadline separately from the scheduled parent-death backstop", () => {
    expect(selfWatchdogConfigFromEnv({})).toEqual({
      ms: SELF_WATCHDOG_MS,
      trigger: "scheduled-parent-backstop",
    });
    expect(
      selfWatchdogConfigFromEnv({
        [MANUAL_SELF_WATCHDOG_ENV]: String(MIN_MANUAL_SELF_WATCHDOG_MS),
      }),
    ).toEqual({
      ms: MIN_MANUAL_SELF_WATCHDOG_MS,
      trigger: "manual-run-deadline",
    });
  });

  it("renders the resolved watchdog duration without hiding the manual kill grace", () => {
    // Pinned as a LITERAL on purpose: what is being checked is that the trailing 15s
    // survives rendering, which a minutes-only formatter would silently drop — a derived
    // expectation would format its own input and assert nothing. The cost is that this
    // line is coupled to GREEN_CHECKPOINT_SUITE_TIMEOUT_MS and must be retuned with it
    // (120m15s → 115m15s when the budget moved 120m → 115m, WI-39841).
    expect(formatSelfWatchdogDuration(MIN_MANUAL_SELF_WATCHDOG_MS)).toBe(
      "115m15s",
    );
    expect(formatSelfWatchdogDuration(SELF_WATCHDOG_MS)).toBe("180m");
  });

  it("does nothing before the deadline", () => {
    const release = vi.fn();
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    vi.advanceTimersByTime(999);
    expect(release).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("resets the idle budget on progress without extending the absolute hard ceiling", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const onFire = vi.fn();
    const watchdog = armSelfWatchdog(
      { release },
      {
        ms: 1000,
        hardCeilingMs: 2500,
        kill,
        pid: 999,
        log: () => {},
        onFire,
      },
    );

    vi.advanceTimersByTime(900);
    watchdog.progress();
    vi.advanceTimersByTime(900);
    watchdog.progress();
    vi.advanceTimersByTime(699);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith("absolute-hard-ceiling", expect.objectContaining({
      idleBudgetMs: 1000, hardCeilingMs: 2500, tightenedBecause: null,
    }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
  });

  it("WI-6554700010009615: tighten pulls the absolute ceiling in, and progress cannot push past it", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const onFire = vi.fn();
    const logs: string[] = [];
    const watchdog = armSelfWatchdog(
      { release },
      {
        ms: 10_000,
        hardCeilingMs: 10_000,
        kill,
        pid: 999,
        log: (m) => logs.push(m),
        onFire,
      },
    );

    vi.advanceTimersByTime(1000);
    expect(
      watchdog.tighten({ hardCeilingMs: 2000, reason: "post-verdict return funnel" }),
    ).toBe(true);
    expect(logs.some((l) => l.startsWith("self-watchdog tightened (post-verdict return funnel)"))).toBe(true);

    // Real progress resets the idle budget but re-arms against the TIGHTENED ceiling.
    vi.advanceTimersByTime(1500);
    watchdog.progress();
    vi.advanceTimersByTime(499);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledWith("absolute-hard-ceiling", expect.objectContaining({
      idleBudgetMs: 10_000, hardCeilingMs: 3000, tightenedBecause: 'post-verdict return funnel',
    }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
    // The fire line names the tightening, so a post-verdict kill is not misread as a 3h overrun.
    expect(logs.some((l) => l.includes("(tightened: post-verdict return funnel)"))).toBe(true);
  });

  it("WI-6554700010009615: tighten never extends a deadline and is inert once cancelled", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const onFire = vi.fn();
    const watchdog = armSelfWatchdog(
      { release },
      { ms: 5000, hardCeilingMs: 5000, kill, pid: 999, log: () => {}, onFire },
    );

    vi.advanceTimersByTime(1000);
    expect(watchdog.tighten({ hardCeilingMs: 60_000, reason: "looser" })).toBe(false);
    vi.advanceTimersByTime(3999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);

    const cancelled = armSelfWatchdog(
      { release },
      { ms: 5000, hardCeilingMs: 5000, kill, pid: 999, log: () => {}, onFire },
    );
    cancelled.cancel();
    expect(cancelled.tighten({ hardCeilingMs: 10, reason: "after cancel" })).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("releases the lock and SIGKILLs its own process GROUP (negative pid) once the deadline elapses", () => {
    const release = vi.fn();
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    vi.advanceTimersByTime(1000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
  });

  it("WI-38688: kills the ACTUAL inherited process group when a manual unit wrapper is the group leader", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const log = vi.fn();
    const snapshotProcessGroup = vi.fn(() => " 777 1 777 Ss bash");
    const resolveProcessGroupId = vi.fn(() => 777);
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        kill,
        pid: 999,
        log,
        snapshotProcessGroup,
        resolveProcessGroupId,
      },
    );
    vi.advanceTimersByTime(1000);
    expect(resolveProcessGroupId).toHaveBeenCalledWith(999);
    expect(snapshotProcessGroup).toHaveBeenCalledWith(777);
    expect(kill).toHaveBeenCalledWith(-777, "SIGKILL");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("(pid 999, pgid 777)"),
    );
  });

  it("EI-20444707119723892: a manual deadline never invents a lost parent while killing the inherited group", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const log = vi.fn();
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        trigger: "manual-run-deadline",
        kill,
        pid: 999,
        log,
        resolveProcessGroupId: () => 777,
      },
    );
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("manual checkpoint deadline elapsed"),
    );
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining("presumed-dead parent"),
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-777, "SIGKILL");
  });

  it("runs a SYNC onFire hook before the process-group kill so the watchdog can emit a loud verdict", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const onFire = vi.fn();
    armSelfWatchdog(
      { release },
      { ms: 1000, kill, pid: 999, log: () => {}, onFire },
    );
    vi.advanceTimersByTime(1000);
    expect(release).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
    expect(onFire.mock.invocationCallOrder[0]).toBeLessThan(
      kill.mock.invocationCallOrder[0],
    );
  });

  /** WI-4528 (EI-10800 class). The REAL onFire is async — it awaits emitAwaitedEvent for the
   *  `green-checkpoint:red[:<pipeline>]` verdict that agents park on via checkpoint:await. The old
   *  test above (sync vi.fn + invocationCallOrder) only proved onFire was *invoked* before the kill,
   *  which is TRUE of the broken code too: it fire-and-forgot the emit and then SIGKILLed its own
   *  process group on the very next sync line, so the emit never got an event-loop turn and the wake
   *  was lost with certainty. The contract that actually matters is COMPLETION-before-kill. */
  it("WI-4528: AWAITS an async onFire to COMPLETION before the process-group kill (a fire-and-forget verdict emit is a lost wake)", async () => {
    const order: string[] = [];
    const release = vi.fn();
    const kill = vi.fn((p: number, sig: NodeJS.Signals) =>
      order.push(`kill:${p}:${sig}`),
    );
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        kill,
        pid: 999,
        log: () => {},
        onFireGraceMs: 5000,
        onFire: async () => {
          order.push("emit:start");
          // a real emitAwaitedEvent is several awaited DB round-trips — the broken code killed
          // the process group long before anything like this could land.
          await Promise.resolve();
          await Promise.resolve();
          order.push("emit:done");
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(["emit:start", "emit:done", "kill:-999:SIGKILL"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  /** WI-6554700010009547: run 85de8fa0's onFire entered signed shard publication (30s deadline)
   *  and was SIGKILLed at the old 8s grace, losing the marker, events and notify. The PRODUCTION
   *  default grace must outlast a step that slow, and the watchdog record must skip shards. */
  it("WI-6554700010009547: the default onFire grace outlasts a 30s step, and the watchdog verdict record skips signed shards", async () => {
    const order: string[] = [];
    const kill = vi.fn((p: number, sig: NodeJS.Signals) =>
      order.push(`kill:${p}:${sig}`),
    );
    armSelfWatchdog(
      { release: vi.fn() },
      {
        ms: 1000,
        kill,
        pid: 999,
        log: () => {},
        // No onFireGraceMs: the production default is what is under test.
        onFire: async () => {
          order.push("emit:start");
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          order.push("emit:done");
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1000 + 30_000);
    expect(order).toEqual(["emit:start", "emit:done", "kill:-999:SIGKILL"]);
    expect(SELF_WATCHDOG_SIGNED_SHARD_DEADLINE_MS).toBe(0);
    expect(terminalVerdictRecordOptions("self-watchdog")).toEqual({
      signedShardDeadlineMs: 0,
    });
    expect(terminalVerdictRecordOptions("normal")).toEqual({});
  });

  it("WI-4528: a WEDGED onFire can never block the guaranteed kill — the grace bounds it", async () => {
    const order: string[] = [];
    const release = vi.fn();
    const kill = vi.fn((p: number, sig: NodeJS.Signals) =>
      order.push(`kill:${p}:${sig}`),
    );
    const log = vi.fn();
    armSelfWatchdog(
      { release },
      {
        ms: 1000,
        kill,
        pid: 999,
        log,
        onFireGraceMs: 5000,
        onFire: () => new Promise<void>(() => order.push("emit:start")), // never settles
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(order).toEqual(["emit:start"]); // still hanging — no kill yet
    await vi.advanceTimersByTimeAsync(5000); // grace elapses
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("did not settle within 5000ms"),
    );
  });

  it("logs a process-group snapshot before killing a wedged checkpoint run (WI-2957)", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const log = vi.fn();
    const snapshotProcessGroup = vi.fn(
      () => " 999 1 999 Sl 58:00 0.0 1.2 vitest run",
    );
    armSelfWatchdog(
      { release },
      { ms: 1000, kill, pid: 999, log, snapshotProcessGroup },
    );
    vi.advanceTimersByTime(1000);
    expect(snapshotProcessGroup).toHaveBeenCalledWith(999);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("self-watchdog process-group snapshot"),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("vitest run"));
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
  });

  it("snapshot failure is diagnostic-only and still kills the process group", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const snapshotProcessGroup = vi.fn(() => {
      throw new Error("ps failed");
    });
    armSelfWatchdog(
      { release },
      { ms: 1000, kill, pid: 999, log: () => {}, snapshotProcessGroup },
    );
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
  });

  it("cancel() prevents the watchdog from ever firing (the normal-exit path)", () => {
    const release = vi.fn();
    const kill = vi.fn();
    const watchdog = armSelfWatchdog(
      { release },
      { ms: 1000, kill, pid: 999, log: () => {} },
    );
    watchdog.cancel();
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it("a kill failure (group already gone) does not throw", () => {
    const release = vi.fn();
    const kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a lock-release failure does not stop the kill from firing", () => {
    const release = vi.fn(() => {
      throw new Error("lock already gone");
    });
    const kill = vi.fn();
    armSelfWatchdog({ release }, { ms: 1000, kill, pid: 999, log: () => {} });
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(kill).toHaveBeenCalledWith(-999, "SIGKILL");
  });
});

describe("WI-39607: a normally-exiting run sweeps its own survivors", () => {
  // The shape MEASURED on this box 2026-08-17. The two orphans that motivated this had
  // already been REPARENTED (ppid 4035 = `systemd --user`) because their direct parent
  // died first — while still carrying the original pgid. Every row below preserves that.
  const CHECKPOINT = 213050; // the run: group leader on the scheduled path
  const SYSTEMD = 4035;
  const measuredTable = [
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: SYSTEMD, ppid: 1, pgid: SYSTEMD },
    { pid: CHECKPOINT, ppid: SYSTEMD, pgid: CHECKPOINT },
    // A live child still attached to the run.
    { pid: 213099, ppid: CHECKPOINT, pgid: CHECKPOINT },
    // THE ACTUAL LEAK: reparented away from us, but still in our group.
    { pid: 253520, ppid: SYSTEMD, pgid: CHECKPOINT },
    // An unrelated peer agent's process — different group, not our descendant.
    { pid: 900001, ppid: SYSTEMD, pgid: 900001 },
  ];

  it("reaps a survivor that reparented away but kept our pgid", () => {
    const targets = checkpointSweepTargets(
      measuredTable,
      CHECKPOINT,
      CHECKPOINT,
    );
    expect(targets).toContain(253520);
    expect(targets).toContain(213099);
  });

  it("CONTROL: a descendant-only walk would MISS that survivor — which is why we key on the group", () => {
    // Deliberately-wrong implementation kept in the test file as a control (never a
    // mutation of the real source). If this ever starts finding 253520, the control has
    // stopped being wrong and the assertion above proves nothing.
    const descendantsOnly = (
      table: typeof measuredTable,
      root: number,
    ): number[] => {
      const out: number[] = [];
      const stack = [root];
      while (stack.length > 0) {
        const p = stack.pop()!;
        for (const r of table) {
          if (r.ppid === p && !out.includes(r.pid) && r.pid !== root) {
            out.push(r.pid);
            stack.push(r.pid);
          }
        }
      }
      return out;
    };
    expect(descendantsOnly(measuredTable, CHECKPOINT)).not.toContain(253520);
    // ...and the real implementation does find it. Calibration: without this the control
    // would also "pass" if checkpointSweepTargets returned nothing at all.
    expect(
      checkpointSweepTargets(measuredTable, CHECKPOINT, CHECKPOINT),
    ).toContain(253520);
  });

  it("never signals itself, its ancestors, or an unrelated group", () => {
    const targets = checkpointSweepTargets(
      measuredTable,
      CHECKPOINT,
      CHECKPOINT,
    );
    expect(targets).not.toContain(CHECKPOINT); // self — process.exit() still has to run
    expect(targets).not.toContain(SYSTEMD); // ancestor
    expect(targets).not.toContain(1);
    expect(targets).not.toContain(900001); // a peer agent's process
  });

  it("spares the `bash -c` wrapper that leads the group on the MANUAL path", () => {
    // Manual runs live in a transient unit whose wrapper is the group leader and owns our
    // stdout; killing it before process.exit() discards the exit code AND the
    // __GREEN_CHECKPOINT_RESULT__ marker (the WI-38688 / EI-20513710295890636 hazard).
    const WRAPPER = 2858004;
    const NODE = 2858438;
    const manualTable = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: WRAPPER, ppid: 1, pgid: WRAPPER },
      { pid: NODE, ppid: WRAPPER, pgid: WRAPPER },
      { pid: 2858500, ppid: NODE, pgid: WRAPPER }, // a worker
    ];
    const targets = checkpointSweepTargets(manualTable, NODE, WRAPPER);
    expect(targets).not.toContain(WRAPPER);
    expect(targets).not.toContain(NODE);
    expect(targets).toEqual([2858500]);
  });

  it("also reaps a DETACHED child, which left our group and so is invisible to a group-only sweep", () => {
    // runCmd detaches whenever killProcessGroupOnTimeout is set, deliberately removing
    // those children from the self-watchdog's `kill(-pgid)` net. The descendant leg covers them.
    const detachedTable = [
      { pid: CHECKPOINT, ppid: SYSTEMD, pgid: CHECKPOINT },
      { pid: 700001, ppid: CHECKPOINT, pgid: 700001 }, // detached: its own group
    ];
    expect(
      checkpointSweepTargets(detachedTable, CHECKPOINT, CHECKPOINT),
    ).toContain(700001);
  });

  it("an UNREADABLE process table sweeps nothing rather than reporting a clean run", () => {
    const kill = vi.fn();
    expect(
      sweepCheckpointSurvivors({
        pid: CHECKPOINT,
        readProcTable: () => null,
        resolveProcessGroupId: () => CHECKPOINT,
        kill,
        log: () => {},
      }),
    ).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("a kill that throws never fails the exit path, and the rest still get swept", () => {
    const kill = vi.fn((pid: number) => {
      if (pid === 213099) throw new Error("ESRCH — already gone");
    });
    const killed = sweepCheckpointSurvivors({
      pid: CHECKPOINT,
      readProcTable: () => measuredTable,
      resolveProcessGroupId: () => CHECKPOINT,
      kill,
      log: () => {},
    });
    expect(killed).toContain(253520);
    expect(killed).not.toContain(213099);
    expect(kill).toHaveBeenCalledWith(253520, "SIGKILL");
  });
});

describe("EI-257879: checkpoint cleanup preserves its launcher output transport", () => {
  it.each([0, 23])("drains the verdict and preserves producer exit %i while reaping workers", (exitCode) => {
    const root = mkdtempSync(join(tmpdir(), "checkpoint-output-sweep-"));
    try {
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
      const log = join(root, "run.log");
      const evidence = join(root, "sweep.json");
      // Run the real selector in an isolated process group, without a suite or systemd.
      // The fixture occupies tsx's launcher slot and leaves one live worker to reap.
      writeFileSync(join(root, "node_modules/.bin/tsx"), `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const checkpointSweepTargets = ${checkpointSweepTargets.toString()};
const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
worker.once('spawn', () => {
  const table = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).stdout.trim().split('\\n').map(line => {
    const [pid, ppid, pgid] = line.trim().split(/\\s+/).map(Number);
    return { pid, ppid, pgid };
  });
  const pgid = table.find(row => row.pid === process.pid).pgid;
  const targets = checkpointSweepTargets(table, process.pid, pgid);
  process.stdout.write('\\x1b[32m__GREEN_CHECKPOINT_RESULT__ fixture-verdict\\x1b[0m\\n', () => {
    for (const pid of targets) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ worker: worker.pid, targets }));
    process.exit(${exitCode});
  });
});
`, { mode: 0o755 });
      const inner = buildCheckpointSystemdArgv(root, log, process.env.PATH ?? "/usr/bin:/bin").at(-1)!;
      const result = spawnSync("bash", ["-c", inner], {
        cwd: root, detached: true, encoding: "utf8", timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(existsSync(evidence), result.stderr + readFileSync(log, "utf8")).toBe(true);
      const swept = JSON.parse(readFileSync(evidence, "utf8"));
      expect(swept.targets).toContain(swept.worker);
      expect(result.status).toBe(exitCode);
      expect(readFileSync(log, "utf8")).toBe("__GREEN_CHECKPOINT_RESULT__ fixture-verdict\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("EI-213458 candidate-source normalization", () => {
  it("fails closed when canonical and legacy provenance conflict", () => {
    expect(
      checkpointCandidateProvenance({
        candidateSource: "tip",
        diagnostic: "candidate-pinned",
      }),
    ).toEqual({
      candidateSource: "pinned",
      diagnostic: "candidate-pinned",
    });
  });

  it("keeps an unscoped raw --candidate diagnostic-only while accepting legacy authenticated launchers", () => {
    expect(checkpointCandidateSourceFromCli("a".repeat(40), undefined)).toBe(
      "pinned",
    );
    expect(
      checkpointCandidateSourceFromCli("a".repeat(40), undefined, true),
    ).toBe("tip");
    expect(checkpointCandidateSourceFromCli("a".repeat(40), "tip")).toBe("tip");
    expect(
      checkpointCandidateSourceFromCli("a".repeat(40), "pinned", true),
    ).toBe("pinned");
    expect(checkpointCandidateSourceFromCli(undefined, undefined)).toBe("tip");
    expect(() =>
      checkpointCandidateSourceFromCli("a".repeat(40), "unknown"),
    ).toThrow("expected pinned|tip");
  });
});

describe("EI-218328 exact checkpoint-run evidence", () => {
  it("builds the producer payload from the run's log, run id, and integration root only", () => {
    const evidence = checkpointEvidenceFor("/srv/oddsmith", {
      logPath: "/var/lib/papercusp/checkpoint-logs/oddsmith-run.log",
      runId: "run-oddsmith-1",
    });

    expect(evidence).toEqual({
      integrationRoot: "/srv/oddsmith",
      logPath: "/var/lib/papercusp/checkpoint-logs/oddsmith-run.log",
      runId: "run-oddsmith-1",
    });
    expect(Object.keys(evidence).sort()).toEqual([
      "integrationRoot",
      "logPath",
      "runId",
    ]);
  });

  it("omits unavailable optional values instead of inventing a run identity", () => {
    expect(checkpointEvidenceFor("/srv/oddsmith", {})).toEqual({
      integrationRoot: "/srv/oddsmith",
    });
  });
});

describe("P-007 pre-materialization related-test selection", () => {
  it("accepts only internally consistent positive related-selection evidence", () => {
    const summary =
      "RELATED_MATERIALIZATION_SELECTION status=selected relatedSelections=1 affected=2 closure=3";
    const parsed = parseCheckpointMaterializationSelection(
      [
        "RELATED_SELECTION ws=@papercusp/web selected=2 total=40 mode=related reason=ok",
        summary,
        "RELATED_AFFECTED_WORKSPACE_DIR\tpackages/operator-core",
        "RELATED_AFFECTED_WORKSPACE_DIR\tapps/operator",
        "RELATED_DEPENDENCY_WORKSPACE_DIR\tpackages/z",
        "RELATED_DEPENDENCY_WORKSPACE_DIR\tapps/operator",
        "RELATED_DEPENDENCY_WORKSPACE_DIR\tpackages/operator-core",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      affectedWorkspaceDirs: ["apps/operator", "packages/operator-core"],
      workspaceDirs: ["apps/operator", "packages/operator-core", "packages/z"],
      relatedSelections: 1,
      summary,
    });

    expect(
      parseCheckpointMaterializationSelection(
        [
          "RELATED_SELECTION ws=@papercusp/web selected=2 total=40 mode=full reason=over-threshold",
          summary,
          "RELATED_AFFECTED_WORKSPACE_DIR\tapps/operator",
          "RELATED_DEPENDENCY_WORKSPACE_DIR\tapps/operator",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(
      normalizeCheckpointMaterializationSelection({
        affectedWorkspaceDirs: ["../outside"],
        workspaceDirs: ["../outside"],
        relatedSelections: 1,
        summary,
      }),
    ).toBeNull();
  });

  it("WI-871878: parses only complete, exact file-level targeted re-verdict evidence", () => {
    const summary =
      "RELATED_AFFECTED_FILES status=selected workspaces=1 files=1";
    const exact = [
      "RELATED_SELECTION ws=@papercusp/web selected=1 total=40 mode=related reason=ok",
      "RELATED_MATERIALIZATION_SELECTION status=selected relatedSelections=1 affected=1 closure=1",
      "RELATED_AFFECTED_WORKSPACE_DIR\tapps/operator",
      "RELATED_DEPENDENCY_WORKSPACE_DIR\tapps/operator",
      "AFFECTED_WS\t@papercusp/web",
      summary,
      "RELATED_AFFECTED_FILE\t@papercusp/web\tlib/fossil.test.ts",
    ];

    expect(parseTargetedReVerdictSelection(exact.join("\n"))).toEqual({
      affectedWorkspaces: ["@papercusp/web"],
      affectedFiles: [
        { workspace: "@papercusp/web", file: "lib/fossil.test.ts" },
      ],
      summary,
    });

    expect(
      parseTargetedReVerdictSelection(
        exact
          .filter((line) => !line.startsWith("RELATED_AFFECTED_FILE\t"))
          .join("\n"),
      ),
    ).toBeNull();
    expect(
      parseTargetedReVerdictSelection(
        [...exact, "AFFECTED_GUARD\tlint:identity-leak"].join("\n"),
      ),
    ).toBeNull();
    expect(
      parseTargetedReVerdictSelection(
        exact.join("\n").replace("lib/fossil.test.ts", "../fossil.test.ts"),
      ),
    ).toBeNull();
  });

  it("prepares exact source and selects its dependency closure before materialization", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    deps.reportProgress = (phase) => calls.push(phase ?? "progress");
    deps.prepareSource = async (ref) => {
      calls.push(`prepare:${ref.slice(0, 7)}`);
    };
    const migrationInputs: Array<{ candidate: string; sqlDir: string }> = [];
    deps.ensureMigrationsCurrent = async (input) => {
      migrationInputs.push(input);
      calls.push(`migrate:${input.candidate.slice(0, 7)}`);
      return { applied: 0, failed: [] };
    };
    deps.selectMaterializationClosure = async (input) => {
      calls.push(
        `select:${input.base.slice(0, 7)}:${input.candidate.slice(0, 7)}`,
      );
      return {
        affectedWorkspaceDirs: ["apps/operator"],
        workspaceDirs: ["apps/operator", "packages/operator-core"],
        relatedSelections: 1,
        summary: "positive candidate-exact selection",
      };
    };
    deps.setupTree = async (ref, options) => {
      calls.push(
        `setup:${ref.slice(0, 7)}:${String(options?.preparedSource)}:${options?.workspaceDirs?.join(",")}`,
      );
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({ green: true, reason: "advanced" });
    expect(calls).toContain("phase:preselecting");
    expect(calls).toContain(`prepare:${candidate.slice(0, 7)}`);
    expect(calls).toContain(
      `select:${ready.slice(0, 7)}:${candidate.slice(0, 7)}`,
    );
    expect(calls).toContain(
      `setup:${candidate.slice(0, 7)}:true:apps/operator,packages/operator-core`,
    );
    expect(migrationInputs).toEqual([
      {
        candidate,
        sqlDir: join(repo, "libs", "papercusp", "libs", "db", "sql"),
      },
      {
        candidate,
        sqlDir: join(repo, "libs", "papercusp", "libs", "db", "sql"),
      },
    ]);
    expect(calls.indexOf("phase:preselecting")).toBeLessThan(
      calls.indexOf("phase:materializing"),
    );
    expect(calls.indexOf(`prepare:${candidate.slice(0, 7)}`)).toBeLessThan(
      calls.indexOf("phase:materializing"),
    );
    expect(calls.indexOf(`migrate:${candidate.slice(0, 7)}`)).toBeLessThan(
      calls.indexOf("phase:materializing"),
    );
    expect(
      calls.lastIndexOf(`migrate:${candidate.slice(0, 7)}`),
    ).toBeGreaterThan(calls.findIndex((call) => call.startsWith("setup:")));
    expect(calls.lastIndexOf(`migrate:${candidate.slice(0, 7)}`)).toBeLessThan(
      calls.indexOf("runGreen"),
    );
  });

  it("fails closed on a candidate migration before dependency materialization", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps, calls } = stubDeps(true);
    deps.prepareSource = async (ref) => {
      calls.push(`prepare:${ref.slice(0, 7)}`);
    };
    deps.ensureMigrationsCurrent = async (input) => {
      calls.push(`migrate:${input.candidate.slice(0, 7)}`);
      return {
        applied: 0,
        failed: [
          {
            file: "900-candidate-only.sql",
            error: "relation x does not exist",
          },
        ],
      };
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      green: null,
      reason: "migrations-pending",
    });
    expect(result.summary).toContain("pre-materialization");
    expect(calls).toEqual([
      `prepare:${candidate.slice(0, 7)}`,
      `migrate:${candidate.slice(0, 7)}`,
    ]);
    expect(calls).not.toContain("phase:materializing");
    expect(calls.some((call) => call.startsWith("setup:"))).toBe(false);
    expect(calls).not.toContain("runGreen");
  });

  it("reuses prepared source but fails wide when the selector has no positive evidence", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    const { deps } = stubDeps(true);
    let setupOptions: unknown;
    deps.prepareSource = async () => {};
    deps.selectMaterializationClosure = async () => null;
    deps.setupTree = async (_ref, options) => {
      setupOptions = options;
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({ green: true, reason: "advanced" });
    expect(setupOptions).toEqual({ preparedSource: true });
  });
});

describe("runGreenCheckpoint", () => {
  it("records gate-run integration-root evidence through the orchestrator logger", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps } = stubDeps(true);
    deps.log = (line) => logs.push(line);

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const evidence = logs.filter((line) => line.includes("integration root:"));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain(`integration root: ${repo}`);
    expect(evidence[0]).toContain("emitter=gate-run");
  });

  it("reports materialization before setup, then suite before execution", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    const progress = vi.fn((phase: string) => calls.push(phase));
    deps.reportProgress = progress;

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(progress).toHaveBeenCalledWith("phase:materializing");
    expect(progress).toHaveBeenCalledWith("phase:suite");
    expect(calls.indexOf("phase:materializing")).toBeLessThan(
      calls.findIndex((call) => call.startsWith("setup:")),
    );
    expect(calls.findIndex((call) => call.startsWith("setup:"))).toBeLessThan(
      calls.indexOf("phase:suite"),
    );
    expect(calls.indexOf("phase:suite")).toBeLessThan(
      calls.indexOf("runGreen"),
    );
  });

  it("publishes the materializing marker before pre-materialization source preparation", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const config = cfg();
    const lockDir = checkpointRunLockDir(
      config.checkpointLogDir,
      config.integrationRoot,
    );
    mkdirSync(lockDir, { recursive: true });
    const { deps } = stubDeps(true);
    deps.prepareSource = async () => {
      expect(JSON.parse(readFileSync(join(lockDir, "phase.json"), "utf8"))).toMatchObject({
        phase: "materializing",
      });
    };

    await runGreenCheckpoint(config, deps, { noPush: true });
  });

  /**
   * EI-20709645463022690 — the DATABASE half of the same evidence, pinned BEHAVIOURALLY here
   * rather than by a source regex, because the property that matters is "the line reaches the
   * persisted transcript", not "the call appears in the file".
   *
   * Why this test and not the CLI one: the gate subprocess inherits the spawning operator's env,
   * so a pot's suite can dial the papercusp operator's database and report every one of the pot's
   * tables as missing — a well-formed "schema drift — 39 table(s) missing" verdict about a
   * database that was never the subject (observed on sidestage, candidate d6fee86). The CLI
   * entrypoint's console line is NOT captured by scheduler/routine invocations (WI-38250), and
   * those are precisely the unattended runs that red-pin a pot, so the orchestrator logger is the
   * only emission that actually helps a responder.
   */
  it("records gate-run DATABASE evidence through the orchestrator logger, credentials stripped", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps } = stubDeps(true);
    deps.log = (line) => logs.push(line);

    // databaseEvidence() prefers HARNESS_ADMIN_DATABASE_URL / HARNESS_DATABASE_URL over
    // DATABASE_URL (release-config.ts), and every agent shell on the dev box carries
    // HARNESS_ADMIN_DATABASE_URL — so clear the higher-precedence keys too, or this test
    // asserts on the ambient operator DSN instead of the value it set.
    const keys = ["HARNESS_ADMIN_DATABASE_URL", "HARNESS_DATABASE_URL", "DATABASE_URL"] as const;
    const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    delete process.env.HARNESS_ADMIN_DATABASE_URL;
    delete process.env.HARNESS_DATABASE_URL;
    // the measured real-world value: a transient gym-loop DB carrying 0 of the pot's tables
    process.env.DATABASE_URL =
      "postgres://test:secretpw@localhost:32787/papercusp_gym_loop_ab12cd";
    try {
      await runGreenCheckpoint(cfg(), deps, { noPush: true });
    } finally {
      for (const k of keys) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }

    const evidence = logs.filter((line) => line.includes("database:"));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toContain("localhost:32787/papercusp_gym_loop_ab12cd");
    expect(evidence[0]).toContain("emitter=gate-run");
    // a run log is not a place to put a password
    expect(evidence[0]).not.toContain("secretpw");
  });

  it.each([
    {
      green: true,
      reason: "up-to-date" as const,
      failingTests: undefined,
      provenance: { candidateSource: "pinned" as const },
    },
    {
      green: false,
      reason: "not-green" as const,
      failingTests: ["lib/broken.test.ts"],
      provenance: { candidateSource: "pinned" as const },
    },
    {
      green: true,
      reason: "up-to-date" as const,
      failingTests: undefined,
      provenance: { diagnostic: "candidate-pinned" as const },
    },
    {
      green: true,
      reason: "up-to-date" as const,
      failingTests: undefined,
      provenance: {
        candidateSource: "tip" as const,
        diagnostic: "candidate-pinned" as const,
      },
    },
  ])(
    "EI-213458: a $reason pinned diagnostic retains the suite result but performs no live-gate side effect",
    async ({ green, reason, failingTests, provenance }) => {
      const ready = await commit("a", "1", "ready");
      await git(repo, ["branch", "ready", ready]);
      const candidate = await commit("a", "2", "candidate");
      const { deps, calls } = stubDeps(green, failingTests);
      deps.routineId = "rt_papercusp_green_checkpoint";
      deps.routineFireWorkflowId = "routine-fire-workflow-42";
      const markers: Array<
        Parameters<NonNullable<CheckpointDeps["recordInFlightCandidate"]>>[0]
      > = [];
      const readFrozenRepairQueue = vi.fn(async () => null);
      const reportAbandonedInFlightCandidate = vi.fn(async () => "lost run");
      const recordPendingVerdict = vi.fn(async () => true);
      const flakeLookup = vi.fn(async () => ({}));
      deps.recordInFlightCandidate = async (info) => {
        markers.push(info);
      };
      deps.readFrozenRepairQueue = readFrozenRepairQueue;
      deps.reportAbandonedInFlightCandidate = reportAbandonedInFlightCandidate;
      deps.recordPendingVerdict = recordPendingVerdict;
      deps.flakeLookup = flakeLookup;

      const result = await runGreenCheckpoint(cfg(), deps, {
        candidate,
        ...provenance,
      });

      expect(result).toMatchObject({
        advanced: false,
        candidate,
        from: ready,
        green,
        reason,
        candidateSource: "pinned",
        diagnostic: "candidate-pinned",
      });
      expect(result.summary).toContain("Candidate-pinned diagnostic");
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        candidate,
        candidateSource: "pinned",
        routineId: "rt_papercusp_green_checkpoint",
        routineFireWorkflowId: "routine-fire-workflow-42",
      });
      expect(await revParse(repo, "ready")).toBe(ready);
      expect(readFrozenRepairQueue).not.toHaveBeenCalled();
      expect(reportAbandonedInFlightCandidate).not.toHaveBeenCalled();
      expect(recordPendingVerdict).not.toHaveBeenCalled();
      expect(flakeLookup).not.toHaveBeenCalled();
      expect(calls).toEqual([`setup:${candidate.slice(0, 7)}`, "runGreen"]);
    },
  );

  it("advances ready when the candidate is green", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(await revParse(repo, "ready")).toBe(c2);
    // P-002: a green advance clears any open release-not-green escalation.
    // EI-10800: the `release:green` verdict emit is AWAITED (both keys land in `calls` before
    // runGreenCheckpoint resolves — the stub hops a microtask, so a fire-and-forget emit would
    // record AFTER return and break this exact-order assertion).
    expect(calls).toEqual([
      "setup:" + c2.slice(0, 7),
      "runGreen",
      "advance",
      "broadcast",
      "clearEscalation",
      "emit:release:green",
      `emit:release:green:${pipelineName(repo)}`,
    ]);
  });

  // WI-7013: green-checkpoint's push() carries the pre-FF `ready` sha as its second
  // arg so the dispatched test.yml run can diff against what this promotion actually
  // changed instead of comparing the pushed tip to itself (green by vacuity —
  // AFFECTED_BASE defaulting to origin/main, which on a workflow_dispatch run
  // checked out at main IS the same commit as HEAD). The tested candidate is the third
  // arg so origin moves BEFORE the local green pin.
  it("WI-7013: push receives the pre-FF base and exact tested candidate", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps } = stubDeps(true);
    const pushCalls: Array<{
      ref: string;
      baseSha?: string | null;
      candidateSha?: string;
    }> = [];
    deps.push = async (ref, baseSha, candidateSha) => {
      pushCalls.push({ ref, baseSha, candidateSha });
    };
    const r = await runGreenCheckpoint(cfg(), deps, {}); // noPush NOT set — push actually runs
    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(pushCalls).toEqual([
      { ref: "ready", baseSha: c1, candidateSha: c2 },
    ]);
  });

  // The dual: on the VERY FIRST advance (no prior `ready` branch), AdvanceResult.from
  // is `null` — push must be called with that `null` verbatim (never a stale/guessed
  // sha), so dispatchCiWorkflow correctly omits the `base` input and test.yml falls
  // back to its unchanged origin/main default.
  it("WI-7013: push is called with baseSha=null when `ready` is created fresh (no prior tip to diff from)", async () => {
    const c1 = await commit("a", "1", "c1"); // candidate; no `ready` branch exists yet
    const { deps } = stubDeps(true);
    const pushCalls: Array<{
      ref: string;
      baseSha?: string | null;
      candidateSha?: string;
    }> = [];
    deps.push = async (ref, baseSha, candidateSha) => {
      pushCalls.push({ ref, baseSha, candidateSha });
    };
    const r = await runGreenCheckpoint(cfg(), deps, {});
    expect(r).toMatchObject({
      advanced: true,
      candidate: c1,
      green: true,
      reason: "advanced",
    });
    expect(pushCalls).toEqual([
      { ref: "ready", baseSha: null, candidateSha: c1 },
    ]);
  });

  it("a rejected origin push aborts before local advance and surfaces the held promotion", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    const broadcasts: Array<{ summary: string; body?: string }> = [];
    const escalations: Array<{ summary: string; body: string }> = [];
    deps.push = async () => {
      calls.push("push");
      throw new Error("remote: You must verify your email address");
    };
    deps.log = (line) => logs.push(line);
    deps.broadcast = async (summary, body) => {
      broadcasts.push({ summary, body });
    };
    deps.escalate = async (summary, body) => {
      escalations.push({ summary, body });
    };

    await expect(runGreenCheckpoint(cfg(), deps, {})).rejects.toThrow(
      "You must verify your email address",
    );

    expect(await revParse(repo, "ready")).toBe(c1);
    expect(calls).toEqual([`setup:${c2.slice(0, 7)}`, "runGreen", "push"]);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      summary: expect.stringContaining("push FAILED"),
      body: expect.stringContaining("local ready remains at"),
    });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      summary: expect.stringContaining("push failed"),
      body: expect.stringContaining("was NOT published to origin/ready"),
    });
    expect(logs).toContainEqual(
      expect.stringContaining("ERROR: green-checkpoint push failed"),
    );
  });

  it("EI-13992: an absent ensureMigrationsCurrent (existing stub) never blocks the run — unaffected call order", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    expect(deps.ensureMigrationsCurrent).toBeUndefined();
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).not.toContain("ensureMigrationsCurrent");
  });

  it("EI-13992: the post-materialization migration backstop remains when source-only preparation is unavailable", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => {
      calls.push("ensureMigrationsCurrent");
      return { applied: 2, failed: [] };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    const setupIdx = calls.indexOf("setup:" + c2.slice(0, 7));
    const migrateIdx = calls.indexOf("ensureMigrationsCurrent");
    const runGreenIdx = calls.indexOf("runGreen");
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(migrateIdx).toBeGreaterThan(setupIdx);
    expect(runGreenIdx).toBeGreaterThan(migrateIdx);
  });

  it("EI-18757975681519069: a preflight that leaves migrations PENDING aborts the run as inconclusive — it never judges against a schema known to be behind", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true); // stub would otherwise report GREEN
    deps.ensureMigrationsCurrent = async () => {
      calls.push("ensureMigrationsCurrent");
      return {
        applied: 0,
        failed: [
          {
            file: "680-carry-note-declared-deps.sql",
            error: "canceling statement due to lock timeout",
          },
        ],
      };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: false,
      candidate: c2,
      green: null,
      reason: "migrations-pending",
    });
    // The load-bearing assertion: the suite is never RUN, so no verdict about the
    // code can be manufactured from a stale schema, and `main` is never advanced
    // on one either. Judging here is what produced the false red + the phantom
    // "ambient host load" diagnosis this fix exists to prevent.
    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain("advance");
  });

  it("EI-18757975681519069: the abort names the offending migration + its error, so the reason is diagnosable from the log alone", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    deps.ensureMigrationsCurrent = async () => ({
      applied: 0,
      failed: [
        {
          file: "680-carry-note-declared-deps.sql",
          error: "canceling statement due to lock timeout",
        },
      ],
    });
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const line = logs.find((l) => l.includes("migration preflight")) ?? "";
    expect(line).toContain("680-carry-note-declared-deps.sql");
    expect(line).toContain("canceling statement due to lock timeout");
    expect(line).toContain("INCONCLUSIVE");
  });

  it("EI-18757975681519069: a preflight reporting applied>0 with NO failures judges normally — the abort is scoped to a known-behind schema", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => ({ applied: 3, failed: [] });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(calls).toContain("runGreen");
  });

  /**
   * WI-7069 — the selection→suite gap is MEASURED and REPORTED.
   *
   * The 2026-08-02 12:53Z verdict judged a commit committed 10h51m earlier. Selection was
   * provably CORRECT (the quiet-cut could only have returned that sha for a cutoff inside a
   * 2-minute window), so the age accumulated AFTER selection — during setupTree/preflights —
   * and nothing recorded that interval. With no selected-at stamp, "the candidate was old" and
   * "selection chose badly" are indistinguishable, which is what turned a diagnosis into hours
   * of git archaeology and produced four contradictory conclusions across the fleet.
   *
   * These pin the INSTRUMENT, not a kill bound: the run must still judge in both cases.
   */
  it("WI-7069: reports the selection→suite gap before judging, and stays QUIET on a healthy run", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps, calls } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const line = logs.find((l) => l.includes("candidate-age:")) ?? "";
    expect(line).toContain("judging it now");
    // A fast run must NOT carry the warning — a detector that fires on the healthy case is
    // worse than none (this file's own EI-10609 lesson).
    expect(line).not.toContain("⚠");
    expect(line).not.toContain("STALE tree");
    // Purely diagnostic: the run still judges.
    expect(calls).toContain("runGreen");
  });

  it("EI-22728869583688089: treats a non-positive commit timestamp as unavailable instead of a fossil", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const candidate = await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.commitUnixTime = async () => 0;
    const priorLog = deps.log;
    deps.log = (line: string) => {
      logs.push(line);
      priorLog?.(line);
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      green: false,
      reason: "not-green",
    });
    expect(calls).toContain("runGreen");
    expect(logs.some((line) => line.includes("candidate committed"))).toBe(
      false,
    );
  });

  it("⭐ WI-7069: a long stretch between selection and the suite WARNS that the verdict describes a stale tree — and still judges", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps, calls } = stubDeps(true);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    // Reproduce the real failure shape: the candidate is selected, then a step BETWEEN
    // selection and the suite blocks for a long time. Advancing a Date.now offset from inside
    // setupTree exercises the ACTUAL code path (real awaits, real git) rather than stubbing
    // the measurement the test exists to verify.
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const priorSetup = deps.setupTree;
      deps.setupTree = async (ref: string) => {
        offsetMs = 45 * 60_000; // 45m, past the 20m budget
        return priorSetup?.(ref);
      };
      await runGreenCheckpoint(cfg(), deps, { noPush: true });
    } finally {
      nowSpy.mockRestore();
    }
    const line = logs.find((l) => l.includes("candidate-age:")) ?? "";
    expect(line).toContain("⚠");
    expect(line).toContain("45m ago");
    expect(line).toContain("STALE tree");
    // It must point at the RIGHT culprit — the whole purpose is that the next reader stops
    // suspecting candidate selection, which is where the 2026-08-02 investigation went wrong.
    expect(line).toContain("not a bad candidate choice");
    expect(line).toContain("WI-7069");
    // P-005 (gate-latency-selection-and-retry-policy-2026-09-06): the culprit is MEASURED. The
    // 45m was injected inside setupTree, so the stamps must attribute the stretch to that phase
    // — a warning that names the wrong step is the failure this instrumentation ends.
    expect(line).toContain("dominant phase: setup-tree");
    expect(line).toMatch(/phases: setup-tree 45m/);
    // Diagnostic ONLY — never blocks, re-cuts, or changes the advance/hold decision.
    expect(calls).toContain("runGreen");
  });

  it("EI-21436432400491183: refuses to publish a fossil red after a 121m setup gap", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logs: string[] = [];
    const { deps, calls } = stubDeps(false, ["lib/fossil.test.ts"]);
    const priorLog = deps.log;
    deps.log = (s: string) => {
      logs.push(s);
      priorLog?.(s);
    };
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const priorSetup = deps.setupTree;
      deps.setupTree = async (ref: string) => {
        offsetMs = 121 * 60_000;
        return priorSetup?.(ref);
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({
        advanced: false,
        green: null,
        reason: "candidate-fossil",
      });
      expect(r.summary).toContain("withheld a red verdict");
      expect(r.summary).toContain("already 2h old");
      expect(calls).not.toContain("advance");
      expect(calls).not.toContain("broadcast");
      expect(calls).not.toContain("escalate");
      expect(calls).toContain("runGreen");
      expect(logs.some((line) => line.includes("candidate-fossil"))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("WI-871878: upgrades a fossil red only after exact affected files and post-suite gates pass at one stable tip", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "broken", "fossil candidate");
    const tip = await commit("b", "fixed", "current tip fix");
    const logs: string[] = [];
    const { deps, calls } = stubDeps(false, ["lib/fossil.test.ts"]);
    deps.runGreen = async () => {
      calls.push("runGreen");
      return {
        green: false,
        summary: "1 failed",
        failingTests: ["lib/fossil.test.ts"],
        failingFiles: [
          { workspace: "@papercusp/web", file: "lib/fossil.test.ts" },
        ],
      };
    };
    deps.log = (line) => logs.push(line);
    deps.resolveTip = async () => tip;
    deps.changedFilesForRange = async (from, to) => {
      expect([from, to]).toEqual([candidate, tip]);
      return ["b"];
    };
    deps.affectedTestsForRange = async (from, to) => {
      expect([from, to]).toEqual([candidate, tip]);
      return {
        affectedWorkspaces: ["@papercusp/web"],
        affectedFiles: [
          { workspace: "@papercusp/web", file: "lib/affected.test.ts" },
        ],
        summary: "exact file radius",
      };
    };
    deps.runTestsAtRef = async (ref, files) => {
      calls.push(`targeted:${ref.slice(0, 7)}`);
      expect(ref).toBe(tip);
      expect(files).toEqual([
        { workspace: "@papercusp/web", file: "lib/fossil.test.ts" },
        { workspace: "@papercusp/web", file: "lib/affected.test.ts" },
      ]);
      return { pass: true, summary: "targeted files passed" };
    };
    deps.runPostSuiteAtRef = async (ref) => {
      calls.push(`post-suite:${ref.slice(0, 7)}`);
      expect(ref).toBe(tip);
      return { pass: true, summary: "post-suite gates passed" };
    };
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const priorSetup = deps.setupTree;
      deps.setupTree = async (ref, options) => {
        offsetMs = 121 * 60_000;
        return priorSetup(ref, options);
      };
      const result = await runGreenCheckpoint(cfg(), deps, {
        candidate,
        noPush: true,
      });
      expect(result).toMatchObject({
        advanced: true,
        candidate: tip,
        green: true,
        reason: "advanced",
      });
      expect(result.summary).toContain("post-suite gates passed");
      expect(await revParse(repo, "ready")).toBe(tip);
      expect(calls).toContain(`targeted:${tip.slice(0, 7)}`);
      expect(calls).toContain(`post-suite:${tip.slice(0, 7)}`);
      expect(
        logs.some((line) =>
          line.includes("candidate-fossil rescued by targeted re-verdict"),
        ),
      ).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("WI-871878: preserves the fossil hold when the exact affected-file radius is unavailable", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "broken", "fossil candidate");
    const tip = await commit("b", "fixed", "current tip fix");
    const { deps, calls } = stubDeps(false, ["lib/fossil.test.ts"]);
    deps.runGreen = async () => {
      calls.push("runGreen");
      return {
        green: false,
        summary: "1 failed",
        failingTests: ["lib/fossil.test.ts"],
        failingFiles: [
          { workspace: "@papercusp/web", file: "lib/fossil.test.ts" },
        ],
      };
    };
    deps.resolveTip = async () => tip;
    deps.changedFilesForRange = async () => ["b"];
    deps.affectedTestsForRange = async () => null;
    deps.runTestsAtRef = async () => {
      calls.push("targeted");
      return { pass: true, summary: "must not run" };
    };
    deps.runPostSuiteAtRef = async () => {
      calls.push("post-suite");
      return { pass: true, summary: "must not run" };
    };
    const realNow = Date.now.bind(Date);
    let offsetMs = 0;
    const nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offsetMs);
    try {
      const priorSetup = deps.setupTree;
      deps.setupTree = async (ref, options) => {
        offsetMs = 121 * 60_000;
        return priorSetup(ref, options);
      };
      const result = await runGreenCheckpoint(cfg(), deps, {
        candidate,
        noPush: true,
      });
      expect(result).toMatchObject({
        advanced: false,
        candidate,
        green: null,
        reason: "candidate-fossil",
      });
      expect(calls).not.toContain("targeted");
      expect(calls).not.toContain("post-suite");
      expect(await revParse(repo, "ready")).toBe(ready);
    } finally {
      nowSpy.mockRestore();
    }
  });

  /**
   * WI-7069 — `killProcessGroupOnTimeout` must reach a GRANDCHILD process, not just the
   * direct child. setupTree's own shell scripts fork further children (git/cp/npm); a plain
   * `child.kill('SIGKILL')` on timeout reaches only the direct `bash` process and ORPHANS
   * whatever it forked, which is the exact half-written-checkout risk this option closes.
   * These two tests are each other's teeth: same repro shape, opposite expected outcome,
   * driven only by the flag under test.
   */
  function grandchildStillRunning(
    pid: number,
    platform: string = process.platform,
    probe: () => void = () => { process.kill(pid, 0); },
    readStat: () => string = () => readFileSync(`/proc/${pid}/stat`, "utf8"),
  ): boolean {
    try {
      probe();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
    if (platform !== "linux") return true;
    try {
      // kill(pid, 0) also succeeds for an unreaped zombie. It proves that the
      // PID exists, not that the grandchild can still execute after SIGKILL.
      const state = linuxProcStateFromStat(readStat());
      if (state === null) throw new Error("Grandchild process state is unknown");
      return state !== "Z" && state !== "X";
    } catch (error) {
      // The task can exit between the kill(pid, 0) probe and the /proc read. Linux
      // reports that as ENOENT on open, or as ESRCH on read() when the stat file was
      // opened while the task was still being torn down. Both mean "gone".
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") return false;
      throw error;
    }
  }

  it("WI-7069: the grandchild detector distinguishes running, zombie, gone, and unknown", () => {
    const probe = vi.fn();
    for (const state of ["R", "S", "D", "T"]) {
      expect(grandchildStillRunning(123, "linux", probe, () => `123 (child (name)) ${state} 1`)).toBe(true);
    }
    for (const state of ["Z", "X"]) {
      expect(grandchildStillRunning(123, "linux", probe, () => `123 (child (name)) ${state} 1`)).toBe(false);
    }
    expect(probe).toHaveBeenCalledTimes(6);
    expect(grandchildStillRunning(123, "linux", () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    })).toBe(false);
    expect(grandchildStillRunning(123, "linux", probe, () => {
      throw Object.assign(new Error("reaped after probe"), { code: "ENOENT" });
    })).toBe(false);
    expect(grandchildStillRunning(123, "linux", probe, () => {
      throw Object.assign(new Error("ESRCH: no such process, read"), { code: "ESRCH" });
    })).toBe(false);
    expect(() => grandchildStillRunning(123, "linux", probe, () => "malformed")).toThrow("state is unknown");
    expect(() => grandchildStillRunning(123, "linux", probe, () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    })).toThrow("denied");
    expect(() => grandchildStillRunning(123, "linux", () => {
      throw Object.assign(new Error("probe denied"), { code: "EPERM" });
    })).toThrow("probe denied");
    const nonLinuxRead = vi.fn(() => { throw new Error("must not read proc"); });
    expect(grandchildStillRunning(123, "darwin", probe, nonLinuxRead)).toBe(true);
    expect(nonLinuxRead).not.toHaveBeenCalled();
  });

  it("WI-7069: killProcessGroupOnTimeout reaches a GRANDCHILD process, not just the direct child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-checkpoint-grandchild-"));
    const pidfile = join(dir, "pid");
    try {
      await expect(
        runCmd("bash", ["-c", `sleep 20 & echo $! > ${pidfile}; sleep 20`], {
          timeoutMs: 500,
          killProcessGroupOnTimeout: true,
        }),
      ).rejects.toThrow(/timed out/);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      // The backgrounded grandchild must be dead too — the group-kill reached it.
      // SIGKILL delivery is not instant under a loaded or throttled cgroup, so poll
      // for death within a bound far below the orphan's 20s sleep: a group-kill
      // that missed the grandchild still fails, a slow exit no longer does.
      const deadline = Date.now() + 5_000;
      while (grandchildStillRunning(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(grandchildStillRunning(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WI-7069: WITHOUT killProcessGroupOnTimeout, a timeout kill orphans the grandchild — documents the bug this option closes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-checkpoint-grandchild-"));
    const pidfile = join(dir, "pid");
    let pid: number | undefined;
    try {
      await expect(
        runCmd("bash", ["-c", `sleep 20 & echo $! > ${pidfile}; sleep 20`], {
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out/);
      await new Promise((r) => setTimeout(r, 200));
      pid = Number(readFileSync(pidfile, "utf8").trim());
      // Without the flag, only the direct `bash` child is killed — the backgrounded
      // grandchild survives as an orphan. This is the bug `killProcessGroupOnTimeout` fixes.
      expect(grandchildStillRunning(pid)).toBe(true);
    } finally {
      // Clean up the orphan so it doesn't linger on the shared box.
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WI-38533: relays only bounded affected-task progress while retaining complete output", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => {
      lines.push(String(line));
    });
    try {
      const result = await runCmd(
        "bash",
        [
          "-c",
          "printf 'ordinary child output\\n'; printf 'AFFECTED_TASK_PROGRESS state=running task=demo elapsedSec=60 capturedBytes=42\\n' >&2",
        ],
        { relayAffectedProgress: true },
      );
      expect(result.stdout).toContain("ordinary child output");
      expect(result.stderr).toContain("AFFECTED_TASK_PROGRESS state=running");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        "AFFECTED_TASK_PROGRESS state=running task=demo",
      );
      expect(lines.join("\n")).not.toContain("ordinary child output");
    } finally {
      log.mockRestore();
    }
  });

  it("WI-41117: relays setup-style stdout/stderr chunks while retaining the complete result", async () => {
    const relayed: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
    const result = await runCmd(
      "bash",
      [
        "-c",
        "printf '[setup-release] root snapshot complete\\n'; printf '[setup-release] copying package-local dependencies\\n' >&2",
      ],
      {
        onOutput: (stream, text) => relayed.push({ stream, text }),
      },
    );

    expect(result.stdout).toContain("root snapshot complete");
    expect(result.stderr).toContain("copying package-local dependencies");
    expect(relayed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stream: "stdout",
          text: expect.stringContaining("root snapshot complete"),
        }),
        expect.objectContaining({
          stream: "stderr",
          text: expect.stringContaining("copying package-local dependencies"),
        }),
      ]),
    );
  });

  it("WI-41117: a timeout error retains the latest interleaved child-output tail", async () => {
    const error = await runCmd(
      "bash",
      [
        "-c",
        "printf '[setup-release] root snapshot complete\\n'; printf '[setup-release] copying nested dependency tree\\n' >&2; sleep 20",
      ],
      {
        timeoutMs: 500,
        killProcessGroupOnTimeout: true,
      },
    ).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain("timed out after 500ms");
    expect(message).toContain("--- last captured child output ---");
    expect(message).toContain(
      "[stdout] [setup-release] root snapshot complete",
    );
    expect(message).toContain(
      "[stderr] [setup-release] copying nested dependency tree",
    );
  });

  it("EI-214116: child output resets the idle timeout while the hard ceiling stays independent", async () => {
    // The test owns the clock. Real sleep gaps against a real idle timeout failed whenever one
    // gap overran under gate IO pressure (candidates 9f0a0776, ac843c61), at any margin. The
    // child now waits for a go-file per stage, and each delivered chunk spends 80% of the idle
    // window on the fake clock, so completing proves every chunk re-armed the idle timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "clearImmediate"] });
    const dir = mkdtempSync(join(tmpdir(), "green-checkpoint-idle-reset-"));
    try {
      const stages = ["copy", "after", "verify", "done"];
      let released = 0;
      const completed = await runCmd(
        "bash",
        [
          "-c",
          `printf 'stage=before\\n'; for s in ${stages.join(" ")}; do while [ ! -e ${dir}/$s ]; do sleep 0.02; done; printf "stage=$s\\n"; done`,
        ],
        {
          timeoutMs: 1_000,
          timeoutResetsOnProgress: true,
          hardTimeoutMs: 20_000,
          killProcessGroupOnTimeout: true,
          // A microtask runs after capture has re-armed the idle timer for this chunk.
          onOutput: () =>
            queueMicrotask(() => {
              vi.advanceTimersByTime(800);
              if (released < stages.length) writeFileSync(join(dir, stages[released++]), "");
            }),
        },
      );
      expect(completed.stdout).toContain("stage=done");

      // Every chunk spends 400ms: output must not re-arm the 1200ms hard ceiling, or this
      // endless child would never be stopped.
      const hardTimeout = await runCmd(
        "bash",
        ["-c", "while true; do printf 'still-alive\\n'; sleep 0.1; done"],
        {
          timeoutMs: 2_000,
          timeoutResetsOnProgress: true,
          hardTimeoutMs: 1_200,
          killProcessGroupOnTimeout: true,
          onOutput: () => queueMicrotask(() => vi.advanceTimersByTime(400)),
        },
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(hardTimeout).toBeInstanceOf(Error);
      expect(String(hardTimeout)).toContain("exceeded hard timeout after 1200ms");
      expect(String(hardTimeout)).toContain("still-alive");
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("EI-214116: output the child wrote during an event-loop stall cancels the idle expiry", async () => {
    // After a stall Node runs expired timers BEFORE the poll phase that reads output the child
    // already wrote, so an idle timer that rejects on expiry kills a child that progressed
    // (candidate ac843c61, 2026-10-01: only stage=before was captured). Stall the loop from a
    // check-phase callback until the child has written its next chunk AND the idle window has
    // passed, so the ordering is forced rather than raced.
    const dir = mkdtempSync(join(tmpdir(), "green-checkpoint-idle-stall-"));
    const go = join(dir, "go");
    const wrote = join(dir, "wrote");
    let stalled = false;
    try {
      const completed = await runCmd(
        "bash",
        [
          "-c",
          `printf 'ready\\n'; while [ ! -e ${go} ]; do sleep 0.02; done; printf 'progress\\n'; touch ${wrote}`,
        ],
        {
          timeoutMs: 2_000,
          timeoutResetsOnProgress: true,
          hardTimeoutMs: 20_000,
          killProcessGroupOnTimeout: true,
          onOutput: (_stream, text) => {
            if (stalled || !text.includes("ready")) return;
            stalled = true;
            setImmediate(() => {
              const started = Date.now();
              writeFileSync(go, "");
              while (!existsSync(wrote) || Date.now() - started < 2_500) {
                if (Date.now() - started > 15_000) break;
              }
            });
          },
        },
      );
      expect(completed.stdout).toContain("progress");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports child output progress while retaining stdout and stderr", async () => {
    const onProgress = vi.fn();
    const result = await runCmd(
      "bash",
      ["-c", "printf 'ordinary child output\\n'; printf 'child error\\n' >&2"],
      { onProgress },
    );

    expect(result.stdout).toContain("ordinary child output");
    expect(result.stderr).toContain("child error");
    expect(onProgress).toHaveBeenCalled();
  });

  it("EI-21012046480619768: preserves a signaled child's close signal", async () => {
    const result = await runCmd(
      process.execPath,
      ["-e", "process.kill(process.pid, 'SIGTERM')"],
      { allowNonZero: true },
    );

    // Node reports code=null for a signal; runCmd's compatibility code remains 0, but the
    // signal must survive so callers cannot mistake a terminated child for a clean exit.
    expect(result.code).toBe(0);
    expect(result.signal).toBe("SIGTERM");
  });

  it("EI-13992: a THROWING ensureMigrationsCurrent is swallowed — the gate still runs + judges normally (never blocks on the preflight)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.ensureMigrationsCurrent = async () => {
      throw new Error("dev PG unreachable");
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(calls).toContain("runGreen");
    expect(calls).toContain("advance");
  });

  it("EI-18666996942859193: an absent checkTreeDrift (existing stub) never blocks the run — unaffected call order", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    expect(deps.checkTreeDrift).toBeUndefined();
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).not.toContain("checkTreeDrift");
  });

  it("EI-18666996942859193: checkTreeDrift runs AFTER setupTree and BEFORE runGreen when provided", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.checkTreeDrift = async () => {
      calls.push("checkTreeDrift");
      return { ok: true, missing: [], extraneous: [], skipped: false };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, green: true });
    const setupIdx = calls.indexOf("setup:" + c2.slice(0, 7));
    const driftIdx = calls.indexOf("checkTreeDrift");
    const runGreenIdx = calls.indexOf("runGreen");
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(driftIdx).toBeGreaterThan(setupIdx);
    expect(runGreenIdx).toBeGreaterThan(driftIdx);
  });

  it("EI-18666996942859193: drift-reported MISSING packages are named in their own log line — diagnostic only, never blocks the advance", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    const lines: string[] = [];
    deps.log = (s) => lines.push(s);
    deps.checkTreeDrift = async () => ({
      ok: false,
      missing: ["ollama", "groq-sdk"],
      extraneous: [],
      skipped: false,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    // Diagnostic-only: the run still judges + advances normally on a green suite.
    expect(r).toMatchObject({ advanced: true, green: true });
    expect(calls).toContain("runGreen");
    const driftLine = lines.find(
      (l) => l.includes("tree-drift preflight") && l.includes("MISSING"),
    );
    expect(driftLine).toBeDefined();
    expect(driftLine).toContain("ollama");
    expect(driftLine).toContain("groq-sdk");
  });

  it("EI-18666996942859193: a THROWING checkTreeDrift is swallowed — the gate still runs + judges normally (never blocks on the preflight)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.checkTreeDrift = async () => {
      throw new Error("lockfile unreadable");
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(calls).toContain("runGreen");
    expect(calls).toContain("advance");
  });

  it("WI-38422: a passing changed-file typecheck receives the complete mixed-workspace diff before the full gate", async () => {
    const c1 = await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 1;\n",
      "c1",
    );
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 2;\n",
      "c2",
    );
    const { deps, calls } = stubDeps(true);
    deps.changedFilesForRange = async (from, to) => {
      expect({ from, to }).toEqual({ from: c1, to: c2 });
      calls.push("changedFilesForRange");
      return ["docs/note.md", "packages/operator-core/lib/a.ts"];
    };
    deps.runChangedFileTypecheckPreflight = async (files, range) => {
      calls.push("runChangedFileTypecheckPreflight");
      expect(range).toEqual({ from: c1, to: c2 });
      expect(files).toEqual([
        "docs/note.md",
        "packages/operator-core/lib/a.ts",
      ]);
      return { status: "passed", summary: "LINT_TSC_RESULT status=clean" };
    };

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      advanced: true,
      candidate: c2,
      green: true,
      reason: "advanced",
    });
    expect(calls.indexOf("changedFilesForRange")).toBeGreaterThan(
      calls.indexOf(`setup:${c2.slice(0, 7)}`),
    );
    expect(calls.indexOf("runChangedFileTypecheckPreflight")).toBeGreaterThan(
      calls.indexOf("changedFilesForRange"),
    );
    // A scoped pass is only an early signal. The full suite — whose real path includes the
    // unscoped post-suite lint:tsc — must still supply the promotion verdict.
    expect(calls.indexOf("runGreen")).toBeGreaterThan(
      calls.indexOf("runChangedFileTypecheckPreflight"),
    );
  });

  it.each([true, false])("P-035: repair preflight uses the frozen delta and preserves the full gate verdict (green=%s)", async (fullGateGreen) => {
    const pin = await commit("packages/operator-core/lib/backlog.ts", "export const backlog = 1;\n", "pin");
    await git(repo, ["branch", "ready", pin]);
    const frozen = await commit("packages/operator-core/lib/backlog.ts", "export const backlog = 2;\n", "frozen backlog");
    const repaired = await commit("packages/operator-core/lib/repair.ts", "export const repair = 1;\n", "repair delta");
    // Model the ref published by a real admission; a synthetic repair commit
    // without it must correctly fail the frozen-lineage promotion guard.
    await git(repo, ["update-ref", frozenLineageRef(frozen), repaired]);
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: pin,
      repairHead: repaired,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: [],
      signature: [],
    };
    const { deps, calls } = stubDeps(fullGateGreen, fullGateGreen ? [] : ["lint:tsc"]);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => { queue = next; };
    const ranges: Array<{ from: string; to: string }> = [];
    deps.changedFilesForRange = async (from, to) => {
      ranges.push({ from, to });
      return from === frozen
        ? ["packages/operator-core/lib/repair.ts"]
        : ["packages/operator-core/lib/backlog.ts", "packages/operator-core/lib/repair.ts"];
    };
    const checked: string[][] = [];
    deps.runChangedFileTypecheckPreflight = async (files, range) => {
      checked.push(files);
      expect(range).toEqual({ from: frozen, to: repaired });
      return { status: "passed", summary: "repair delta passes" };
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(ranges).toContainEqual({ from: frozen, to: repaired });
    expect(checked).toEqual([["packages/operator-core/lib/repair.ts"]]);
    // A regression inherited from the frozen candidate still blocks promotion even
    // when the narrower provisional check passes. The full gate remains the authority.
    expect(calls).toContain("runGreen");
    expect(result.advanced, JSON.stringify(result)).toBe(fullGateGreen);
    expect(result.green, JSON.stringify(result)).toBe(fullGateGreen);
    expect(calls.includes("advance")).toBe(fullGateGreen);
  });

  // P-016 (green-main-ratchet-convergence-2026-10-17#D-004) changed this contract for ROUND 1:
  // a run that is not verifying a repair head keeps the early red AND runs the affected sweep,
  // so the queue's first count measures the tests. Repair-head rounds keep the WI-38422 early
  // stop — pinned by the repair-head test below.
  it("WI-38422 / P-016: on round 1 a failed changed-file typecheck keeps the not-green verdict AND runs the affected sweep", async () => {
    const c1 = await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 1;\n",
      "c1",
    );
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit(
      "packages/operator-core/lib/a.ts",
      'export const a: number = "bad";\n',
      "c2",
    );
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.changedFilesForRange = async () => ["packages/operator-core/lib/a.ts"];
    deps.runChangedFileTypecheckPreflight = async () => ({
      status: "failed",
      summary: "packages/operator-core/lib/a.ts(1,14): error TS2322",
      failingSignatures: ["lint:tsc"],
      failureInventory: {
        ran: true,
        output: "POST_SUITE_RESULT status=failed\n",
        failingSignatures: ["lint:tsc:scripts", "lint:guard-reachability"],
        records: [
          { id: "lint:tsc:scripts", status: "failed", durationMs: 5 },
          { id: "lint:guard-reachability", status: "failed", durationMs: 7 },
          {
            id: "spa-build",
            status: "skipped",
            skipReason: "early changed-file typecheck failure already blocks promotion",
            durationMs: 0,
          },
        ],
      },
    });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      advanced: false,
      candidate: c2,
      from: c1,
      green: false,
      reason: "not-green",
      // The early red survives the merge with a passing sweep.
      failingTests: expect.arrayContaining([
        "lint:tsc",
        "lint:tsc:scripts",
        "lint:guard-reachability",
      ]),
    });
    expect(r.summary).toContain(
      "Early changed-file typecheck failed before the affected-test sweep",
    );
    expect(r.summary).toContain("Early non-test gate inventory");
    expect(r.summary).toContain("Affected-test sweep (P-016");
    expect(calls).toContain("runGreen");
    expect(calls).not.toContain("advance");
    expect(
      logs.some((line) =>
        line.includes("P-016: running the affected-test sweep anyway"),
      ),
    ).toBe(true);
  });

  // The production shape: the stable-candidate queue is persisted BEFORE the early preflight
  // on a candidate's first run. The first P-016 wiring keyed on "a queue is open" and so never
  // ran the round-1 sweep in production — only in tests that stubbed no queue writer.
  it("P-016: a queue persisted before the preflight does not turn round 1 into a later round", async () => {
    const c1 = await commit("packages/operator-core/lib/a.ts", "export const a = 1;\n", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("packages/operator-core/lib/a.ts", 'export const a: number = "bad";\n', "c2");
    const { deps, calls } = stubDeps(true);
    let queue: FrozenCandidateRepairQueue | null = null;
    const writes: Array<FrozenCandidateRepairQueue | null> = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      writes.push(next);
      queue = next;
    };
    deps.changedFilesForRange = async () => ["packages/operator-core/lib/a.ts"];
    deps.runChangedFileTypecheckPreflight = async () => ({
      status: "failed",
      summary: "packages/operator-core/lib/a.ts(1,14): error TS2322",
      failingSignatures: ["lint:tsc"],
    });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // The queue really was written before the suite (the precondition of this regression)...
    expect(writes.length).toBeGreaterThan(0);
    // ...and round 1 still measured the suite.
    expect(calls).toContain("runGreen");
    expect(calls).not.toContain("advance");
    expect(r.green, JSON.stringify(r)).toBe(false);
  });

  it("WI-38422 / P-016: on a repair-head round a failed changed-file typecheck still rejects before the affected sweep", async () => {
    const pin = await commit("packages/operator-core/lib/backlog.ts", "export const backlog = 1;\n", "pin");
    await git(repo, ["branch", "ready", pin]);
    const frozen = await commit("packages/operator-core/lib/backlog.ts", "export const backlog = 2;\n", "frozen backlog");
    const repaired = await commit("packages/operator-core/lib/repair.ts", 'export const repair: number = "bad";\n', "repair delta");
    await git(repo, ["update-ref", frozenLineageRef(frozen), repaired]);
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: pin,
      repairHead: repaired,
      attempts: 1,
      openedAtMs: now - 1_000,
      updatedAtMs: now - 500,
      fixerSpawnId: null,
      failingTests: [],
      signature: [],
    };
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => { queue = next; };
    deps.changedFilesForRange = async () => ["packages/operator-core/lib/repair.ts"];
    deps.runChangedFileTypecheckPreflight = async () => ({
      status: "failed",
      summary: "packages/operator-core/lib/repair.ts(1,14): error TS2322",
      failingSignatures: ["lint:tsc"],
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain("advance");
    expect(result.green, JSON.stringify(result)).toBe(false);
    expect(result.advanced).toBe(false);
    expect(logs.some((line) => line.includes("P-016: running the affected-test sweep"))).toBe(false);
  });

  it("WI-38422: an unavailable changed-file diff falls back to the unchanged full gate", async () => {
    const c1 = await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 1;\n",
      "c1",
    );
    await git(repo, ["branch", "ready", c1]);
    await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 2;\n",
      "c2",
    );
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.changedFilesForRange = async () => null;
    deps.runChangedFileTypecheckPreflight = async () => {
      calls.push("runChangedFileTypecheckPreflight");
      return { status: "failed", summary: "must not run" };
    };

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(calls).not.toContain("runChangedFileTypecheckPreflight");
    expect(calls).toContain("runGreen");
    expect(
      logs.some(
        (line) =>
          line.includes("changed-file resolution unavailable") &&
          line.includes("full gate retained"),
      ),
    ).toBe(true);
  });

  it("WI-38422: a diff with no owning typecheck gate skips the scoped gate instead of manufacturing an out-of-scope red", async () => {
    const c1 = await commit("docs/note.md", "note 1\n", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("docs/note.md", "note 2\n", "c2");
    const { deps, calls } = stubDeps(true);
    deps.changedFilesForRange = async () => ["docs/note.md"];
    deps.runChangedFileTypecheckPreflight = async () => {
      calls.push("runChangedFileTypecheckPreflight");
      return {
        status: "skipped",
        summary:
          "no changed file has a resolvable owning lint:tsc gate — full gate retained",
      };
    };

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(calls).toContain("runChangedFileTypecheckPreflight");
    expect(calls).toContain("runGreen");
  });

  it("WI-38422: a throwing scoped preflight is unmeasured and falls back to the full gate", async () => {
    const c1 = await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 1;\n",
      "c1",
    );
    await git(repo, ["branch", "ready", c1]);
    await commit(
      "packages/operator-core/lib/a.ts",
      "export const a = 2;\n",
      "c2",
    );
    const { deps, calls } = stubDeps(true);
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    deps.changedFilesForRange = async () => ["packages/operator-core/lib/a.ts"];
    deps.runChangedFileTypecheckPreflight = async () => {
      throw new Error("preflight runner unavailable");
    };

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(calls).toContain("runGreen");
    expect(
      logs.some(
        (line) =>
          line.includes("preflight runner unavailable") &&
          line.includes("unchanged full gate"),
      ),
    ).toBe(true);
  });

  it("EI-10800: AWAITS the release:green verdict emit on a green advance (global + pipeline-scoped)", async () => {
    // The bug: the green full-advance emit was a fire-and-forget `void import(...).then(emit)`
    // followed by an immediate return, so the short-lived checkpoint process tore down before
    // the emit ran — `release:green:<pipeline>` fired via `event` 0 times / 87 timeouts in its
    // whole history, while the longer-lived red path fired normally. This asserts the fix: the
    // emit flows through the injectable deps.emitEvent seam AND is awaited before return.
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    // Recorded by the time the promise resolves ⇒ it was awaited, not fire-and-forget.
    expect(calls).toContain("emit:release:green"); // global key (back-compat)
    expect(calls).toContain(`emit:release:green:${pipelineName(repo)}`); // pipeline-scoped (EI-7646)
  });

  it("EI-21533914348699873: emits inconclusive verdicts with global and pipeline-scoped green/red sibling keys", async () => {
    const emit = vi.fn(async () => ({ ok: true }));
    const result = {
      advanced: false,
      candidate: "a".repeat(40),
      from: "b".repeat(40),
      green: null,
      reason: "migrations-pending",
      summary: "schema is behind",
      runId: "run-inconclusive-1",
    } as const;
    const pipeline = "papercusp";
    const siblings = checkpointVerdictSiblingKeys(pipeline);

    await emitInconclusiveCheckpointVerdict(result, pipeline, emit);

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        key: "green-checkpoint:inconclusive",
        cancelSiblingKeysFor: siblings,
      }),
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        key: "green-checkpoint:inconclusive:papercusp",
        cancelSiblingKeysFor: siblings,
      }),
    );
    expect(siblings).toEqual([
      "release:green",
      "release:green:papercusp",
      "green-checkpoint:red",
      "green-checkpoint:red:papercusp",
      // EI-20689157831228179: the held outcome joined the sibling set — an
      // inconclusive verdict retires a stale pending "held" wait too.
      "green-checkpoint:held",
      "green-checkpoint:held:papercusp",
    ]);
  });

  it("WI-4957: green-path verdict (result + event payloads) carries this run's runId", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const payloads: Record<string, { runId?: string | null }> = {};
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({ green: true, summary: "all pass" }),
      advance: (candidate) => advanceReady(repo, candidate, "ready"),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async ({ key, payload }) => {
        payloads[key] = payload as { runId?: string | null };
      },
      log: () => {},
      runId: "run-green-1",
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.runId).toBe("run-green-1");
    expect(payloads["release:green"]?.runId).toBe("run-green-1");
    expect(payloads[`release:green:${pipelineName(repo)}`]?.runId).toBe(
      "run-green-1",
    );
  });

  it("WI-4957: red-path verdict (result + event payloads) carries runId, the FULL failingTests array, and logPath", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const payloads: Record<
      string,
      {
        runId?: string | null;
        failingTests?: string[];
        logPath?: string | null;
      }
    > = {};
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({
        green: false,
        summary: "3 failed",
        failingTests: ["a.test.ts", "b.test.ts", "c.test.ts"],
        logPath: "/tmp/fake-checkpoint-run.log",
      }),
      advance: (candidate) => advanceReady(repo, candidate, "ready"),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async ({ key, payload }) => {
        payloads[key] = payload as {
          runId?: string | null;
          failingTests?: string[];
          logPath?: string | null;
        };
      },
      log: () => {},
      runId: "run-red-1",
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.runId).toBe("run-red-1");
    expect(r.logPath).toBe("/tmp/fake-checkpoint-run.log");
    const p = payloads["green-checkpoint:red"];
    expect(p?.runId).toBe("run-red-1");
    expect(p?.logPath).toBe("/tmp/fake-checkpoint-run.log");
    expect(p?.failingTests).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  });

  it("EI-19370028836452003: a not-green verdict is APPENDED to the candidate log, so the file named for a candidate carries that candidate's OWN verdict", async () => {
    // The regression: runGreen WRITES the per-candidate log before the not-green
    // verdict block runs, so `...-cand-<X>.log` never contained X's own lineage /
    // already-fixed-since notes — they landed in the NEXT pass's log, or nowhere.
    // Measured 2026-08-02 on three consecutive real verdict logs: two had no lineage
    // line at all and the third's named the PREVIOUS candidate. A triaging agent reads
    // that absence as "no staleness note, so this is a real red" — the exact false
    // negative the lineage line exists to prevent.
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logDir = mkdtempSync(join(tmpdir(), "gc-verdict-log-"));
    const logPath = join(logDir, "stamp-base-deadbeef-cand-cafebabe.log");
    // Stand in for what runGreen already wrote: a header plus the suite body.
    writeFileSync(
      logPath,
      "[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n",
    );
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      runGreen: async () => ({
        green: false,
        summary: "1 failed",
        failingTests: ["a.test.ts"],
        logPath,
      }),
      advance: (candidate) => advanceReady(repo, candidate, "ready"),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, "utf8");
    rmSync(logDir, { recursive: true, force: true });
    // APPENDED, not rewritten — the suite body a triager greps must survive.
    expect(body).toContain("SUITE BODY MARKER");
    // ...and the verdict for THIS candidate is now in THIS file.
    expect(body).toContain(
      `[green-checkpoint verdict for candidate ${r.candidate.slice(0, 8)}]`,
    );
    expect(body).toContain(`candidate ${r.candidate.slice(0, 8)} is NOT green`);
  });

  // WI-9613: a red whose ONLY cause is a post-suite LEG must name that leg in its own log.
  //
  // Reproduces candidate dca4c291 (real verdict 2026-08-03T17:27:30Z, part of the 6-red
  // streak that held main at 5b898b7b for ~4h): the suite PASSED
  // (`AFFECTED_TESTS_RESULT status=passed tasks=58 failed=0`), there was no
  // AFFECTED_TESTS_FAILING_FILES line at all, and no `FAILED (npm run ...)` line — so both
  // lines the repo's triage guidance names came back empty on a genuine red. The true cause
  // (`lint:no-control-bytes`) occurred twice in 12,562 lines, both inside the leg's own
  // output block, and never in a line that says "this is what held the gate".
  //
  // FALSIFIABILITY (self-contained, no tree mutation — see CLAUDE.md "Proving a guard is
  // falsifiable"): the pre-written body below is fixed and contains NO leg name, and
  // `failingTests` here carries a leg signature and NO test file. So the leg name can appear
  // in the final body ONLY via the verdict block's canonical line. If that emission is
  // removed, this assertion cannot pass by accident.
  it("WI-9613: a lint-leg-only red names the leg in the verdict log (GATE_HELD_BY)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logDir = mkdtempSync(join(tmpdir(), "gc-heldby-log-"));
    const logPath = join(logDir, "stamp-base-deadbeef-cand-cafebabe.log");
    // Stands in for what runGreen already wrote. Deliberately contains NEITHER the leg
    // name NOR any AFFECTED_TESTS_FAILING_FILES / "FAILED (npm run" line — i.e. exactly
    // the dca4c291 shape a triager could not resolve.
    writeFileSync(
      logPath,
      "[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n",
    );
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      // The leg signature with NO failing test file — runGreen folds legs.failingSignatures
      // into failingTests (~L5715), so this is the real shape of a lint-only red.
      runGreen: async () => ({
        green: false,
        summary: "lint leg failed",
        failingTests: ["lint:no-control-bytes"],
        logPath,
      }),
      advance: (candidate) => advanceReady(repo, candidate, "ready"),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, "utf8");
    rmSync(logDir, { recursive: true, force: true });
    expect(r.green).toBe(false);
    // The suite body a triager greps still survives (append, not rewrite).
    expect(body).toContain("SUITE BODY MARKER");
    // ⭐ The decisive one: the log now states its OWN red cause, greppably.
    expect(body).toContain("GATE_HELD_BY");
    expect(body).toContain("lint:no-control-bytes");
    // The canonical line must be the thing that carries it — not incidental prose.
    const heldByLine = body.split("\n").find((l) => l.includes("GATE_HELD_BY"));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain("lint:no-control-bytes");
    expect(heldByLine).toContain("count=1");
    // Guards the `AFFECTED_TESTS_RESULT failed=N` misread class: the label must say what
    // the entries ARE, so the count is never read as a failing-FILE count.
    expect(body).toMatch(/LEG signatures AND failing TEST files/);
    // Sibling of the unattributed case below: when there ARE entries the line must say so,
    // so `attribution=` can never be read as decorative.
    expect(heldByLine).toContain("attribution=attributed");
  });

  it("EI-19988460746986622: a red with NO attributable failing entries still emits GATE_HELD_BY, as count=0 attribution=unattributed — never silence", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logDir = mkdtempSync(join(tmpdir(), "gc-heldby-unattributed-"));
    const logPath = join(logDir, "stamp-base-deadbeef-cand-cafebabe.log");
    writeFileSync(
      logPath,
      "[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n",
    );
    const deps: CheckpointDeps = {
      setupTree: async () => {},
      // The shape this guards: a genuine red whose entries could NOT be attributed. Reached
      // via the SUITE route (r.code !== 0) when extractFailingTests parses nothing out of the
      // output — recorded as having really happened at green-checkpoint.ts ~L1048. Before the
      // fix this emitted NO GateHeldBy line at all, which reads as "nothing held it".
      runGreen: async () => ({
        green: false,
        summary: "suite failed but nothing could be attributed",
        failingTests: [],
        logPath,
      }),
      advance: (candidate) => advanceReady(repo, candidate, "ready"),
      push: async () => {},
      broadcast: async () => {},
      escalate: async () => {},
      clearEscalation: async () => {},
      emitEvent: async () => {},
      log: () => {},
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const body = readFileSync(logPath, "utf8");
    rmSync(logDir, { recursive: true, force: true });
    expect(r.green).toBe(false);
    expect(body).toContain("SUITE BODY MARKER");
    // ⭐ The decisive one: the line EXISTS on a red that named nothing. Its whole failure
    // mode was silence, so asserting presence is the point of the test.
    expect(body).toContain("GATE_HELD_BY");
    const heldByLine = body.split("\n").find((l) => l.includes("GATE_HELD_BY"));
    expect(heldByLine).toBeDefined();
    expect(heldByLine).toContain("count=0");
    expect(heldByLine).toContain("entries=[]");
    // The status must be explicit, so count=0 is never read as "the gate held on nothing".
    expect(heldByLine).toContain("attribution=unattributed");
    expect(heldByLine).not.toContain("attribution=attributed");
    // And the reader must be told what count=0 does NOT mean.
    expect(body).toMatch(/NOT "nothing held it"/);
  });

  // WI-7482: the re-triage verdict must reach the persisted log on the NON-refiring paths.
  //
  // Same write-before-compute shape as the lineage regression above, one field over — and it
  // survived that fix. The re-triage's only output was `deps.log`, which runGreen snapshots via
  // renderOrchestratorTranscript() BEFORE the verdict block runs, and the append above composes
  // lineage/already-fixed/historical-flake only. So "the gate re-ran this red at tip and it
  // genuinely reproduced" and "the gate never looked" were byte-identical in the durable record.
  // gate_health couldn't disambiguate them either (retriageDetail is stale-candidate-ONLY), so
  // there was no channel left: three separate agents reconstructed this from raw logs on
  // 2026-08-02/03 and two got it wrong (EI-19388705187359206 blamed the parser and was retracted;
  // EI-19389700122825304).
  //
  // Both non-refiring classifications are covered, because they are the two readings that were
  // conflated and they demand OPPOSITE responses: `unknown` ⇒ the gate could not check, so check
  // it yourself; `real-red` ⇒ the gate DID check at tip and it still fails, so go fix it.
  for (const scenario of [
    {
      name: "unknown (no tip runner wired — the gate could not check)",
      extraDeps: {} as Partial<CheckpointDeps>,
      failingFiles: undefined as
        | { workspace: string; file: string }[]
        | undefined,
      expectClassification: "unknown",
    },
    {
      name: "real-red (the gate DID re-run at tip and the failures reproduced)",
      extraDeps: {
        resolveTip: async () => "facefeed00000000000000000000000000000000",
        runTestsAtRef: async () => ({ pass: false, summary: "ws: FAIL" }),
      } as Partial<CheckpointDeps>,
      failingFiles: [
        { workspace: "@papercusp/operator-core", file: "a.test.ts" },
      ],
      expectClassification: "real-red",
    },
  ]) {
    it(`WI-7482: the persisted verdict log carries the re-triage verdict — ${scenario.name}`, async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const logDir = mkdtempSync(join(tmpdir(), "gc-retriage-log-"));
      const logPath = join(logDir, "stamp-base-deadbeef-cand-cafebabe.log");
      writeFileSync(
        logPath,
        "[green-checkpoint] candidate=... green=false\nSUITE BODY MARKER\n",
      );
      const deps: CheckpointDeps = {
        setupTree: async () => {},
        runGreen: async () => ({
          green: false,
          summary: "1 failed",
          failingTests: ["a.test.ts"],
          ...(scenario.failingFiles
            ? { failingFiles: scenario.failingFiles }
            : {}),
          logPath,
        }),
        advance: (candidate) => advanceReady(repo, candidate, "ready"),
        push: async () => {},
        broadcast: async () => {},
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async () => {},
        log: () => {},
        ...scenario.extraDeps,
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      const body = readFileSync(logPath, "utf8");
      rmSync(logDir, { recursive: true, force: true });
      // Appended, never rewritten — the suite tail a triager greps must survive both appends.
      expect(body).toContain("SUITE BODY MARKER");
      expect(body).toContain(
        `[green-checkpoint verdict for candidate ${r.candidate.slice(0, 8)}]`,
      );
      // The regression guard proper: the classification is IN the file, and machine-greppable.
      expect(body).toContain(
        `[green-checkpoint re-triage for candidate ${r.candidate.slice(0, 8)}]`,
      );
      expect(body).toContain(`classification=${scenario.expectClassification}`);
      // A reader must be able to tell a held gate from one that simply had no rescue budget.
      expect(body).toContain("autoRefire=false");
    });
  }

  it("holds ready when the candidate is NOT green", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(false);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: false,
      green: false,
      reason: "not-green",
    });
    expect(await revParse(repo, "ready")).toBe(c1); // unchanged
    expect(calls).not.toContain("advance");
    // P-002: a held gate opens a durable human-facing escalation.
    expect(calls).toContain("escalate");
  });

  it("EI-6542: flags a failing test file that already changed since the candidate was cut", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2"); // the (stale-by-the-time-the-suite-finishes) candidate
    await commit(
      "src/failing.test.ts",
      "fixed",
      "c3 — fixes the failing test, landed after the candidate was cut",
    );
    const { deps } = stubDeps(false, ["src/failing.test.ts"]);
    const messages: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      messages.push(body ?? "");
    };
    const r = await runGreenCheckpoint(cfg(), deps, {
      candidate: c2,
      noPush: true,
    });
    expect(r.reason).toBe("not-green");
    // EI-19381970048172232 re-worded this note. It previously read "already
    // changed since candidate", which reads as THE FAILING SET; it is in fact a
    // SUBSET of it, filtered by commit recency. The qualifier is the fix, so it
    // is asserted here rather than only the file name.
    expect(
      messages.some(
        (m) =>
          m.includes("MODIFIED SINCE candidate") &&
          m.includes("src/failing.test.ts"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) => m.includes("a SUBSET") && m.includes("NOT the failing set"),
      ),
    ).toBe(true);
  });

  it("EI-6542: no already-fixed-since note when the failing file was NOT touched after the candidate", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    await commit(
      "other-file.ts",
      "unrelated",
      "c3 — unrelated change, does not touch the failing file",
    );
    const { deps } = stubDeps(false, ["src/failing.test.ts"]);
    const messages: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      messages.push(body ?? "");
    };
    const r = await runGreenCheckpoint(cfg(), deps, {
      candidate: c2,
      noPush: true,
    });
    expect(r.reason).toBe("not-green");
    // Tracks the EI-19381970048172232 re-word. This is a NEGATIVE assertion, so
    // it passed VACUOUSLY against the stale literal once the wording changed —
    // green while guarding nothing. The positive control below keeps it honest:
    // a verdict WAS produced, so the absence below is a real absence and not an
    // empty message list.
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("MODIFIED SINCE candidate"))).toBe(
      false,
    );
  });

  // EI-18685041726970077 — owner-flagged highest-leverage fix: every not-green verdict
  // carries an inline one-line LINEAGE (candidate sha, commits behind tip, whether the
  // failing files were touched in that range) so a stale-candidate red is distinguishable
  // from a real break without manual git archaeology.
  describe("EI-18685041726970077: gate verdict lineage", () => {
    it("formatGateLineageLine: candidate IS the tip — nothing newer to blame", () => {
      const lineage: GateLineage = {
        candidate: "a".repeat(40),
        tip: "a".repeat(40),
        commitsBehind: 0,
        failingFilesChangedInRange: [],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("📍 lineage:");
      expect(line).toContain("IS the current tip");
      expect(line).toContain("real red");
    });

    // EI-19390159514676981 / EI-19394456914198611. A real-red presumption needs the
    // range to be EMPTY, not merely to exclude the failing test files. This fixture
    // previously asserted the confident wording with the range UNMEASURED, which is
    // precisely the defect: for any test that polices OTHER files (prompt-weight
    // budget, NUL/source-integrity lints, claim-door census, tools-md-sync) the fix
    // lands in the policed SOURCE and the test file is never touched — so an empty
    // `failingFilesChangedInRange` is the expected shape of an ALREADY-FIXED red.
    // Measured 2026-08-03 on candidate 060ea000: the line claimed "presumptively a
    // real red" while all 11 failing files were already green at HEAD.
    it("formatGateLineageLine: only the range being EMPTY licenses a real-red presumption", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 3,
        rangeFilesChanged: 0, // the range genuinely changed nothing
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("4 commit(s) behind tip");
      expect(line).toContain("nothing at all changed in that range");
      expect(line).toContain("a real red");
    });

    it("formatGateLineageLine: range changed OTHER files — UNDETERMINED, not a real red", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 3,
        rangeFilesChanged: 12, // the fix may well be in one of these
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("skew UNDETERMINED");
      expect(line).toContain("12 other file(s) did");
      expect(line).toContain("re-run each failing file at tip");
      // The false-confidence phrasing must be GONE, not merely softened.
      expect(line).not.toContain("presumptively a real red");
    });

    // EI-19393306381214544: `extractFailingTests` also emits bare workspace NAMES
    // (`@papercusp/web`), which can never match a changed FILE. With no path-shaped
    // entry there was nothing to intersect, so the empty result compared NOTHING.
    it("formatGateLineageLine: no path-shaped failing entry — the empty match is vacuous", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 0,
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("no failing entry was path-shaped");
      expect(line).toContain("skew UNDETERMINED");
      expect(line).not.toContain("presumptively a real red");
    });

    // A legacy/unmeasured record must degrade to UNDETERMINED, never be upgraded to
    // confidence — absence of a measurement is not evidence that the range was empty.
    it("formatGateLineageLine: an UNMEASURED range never reads as a real red", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 2,
        // rangeFilesChanged deliberately absent
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("skew UNDETERMINED");
      expect(line).not.toContain("presumptively a real red");
    });

    it("formatGateLineageLine: commits behind, failing files touched in range — presumptively stale", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 7,
        failingFilesChangedInRange: ["src/a.test.ts", "src/b.test.ts"],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("7 commit(s) behind tip");
      expect(line).toContain(
        "2 of the failing file(s) were MODIFIED in that range",
      );
      expect(line).toContain("presumptively STALE");
      expect(line).toContain("src/a.test.ts");
      expect(line).toContain("src/b.test.ts");
    });

    it("EI-20215068298600724: a mixed match keeps unmatched failing files UNDETERMINED", () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: ["packages/operator-core/lib/a.test.ts"],
        failingFilesUnchangedInRange: ["lib/b.test.ts", "lib/c.test.ts"],
        failingPathsConsidered: 3,
        rangeFilesChanged: 12,
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("presumptively STALE");
      expect(line).toContain("2 other failing file(s) were NOT MODIFIED");
      expect(line).toContain("their skew is UNDETERMINED");
      expect(line).toContain("lib/b.test.ts");
      expect(line).toContain("lib/c.test.ts");
      expect(line).not.toContain("a real red");
    });

    // EI-19365565179927273. "presumptively a real red" is a claim about the WHOLE range,
    // so it may only be made when the whole range was readable. A moved-but-undiffable
    // submodule makes part of it unknown — and an agent acting on a false "real red" goes
    // and "fixes" already-correct files (6 embedder tests, on the 18:02:15Z verdict).
    it('formatGateLineageLine: an unexpandable submodule downgrades "real red" to UNDETERMINED', () => {
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        submodulesUnexpanded: ["libs/generic/memory"],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("skew UNDETERMINED");
      expect(line).toContain("libs/generic/memory");
      // The false-confidence phrasing must be GONE, not merely accompanied by a caveat.
      expect(line).not.toContain("presumptively a real red");
    });

    it("formatGateLineageLine: an empty submodulesUnexpanded does not by itself downgrade the verdict", () => {
      // The submodule leg is only ONE of the ways confidence is withheld; with it empty
      // the verdict falls through to the range check, which here IS empty — so this
      // still reads as a real red, on the range evidence rather than by default.
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        submodulesUnexpanded: [],
        failingPathsConsidered: 2,
        rangeFilesChanged: 0,
      };
      expect(formatGateLineageLine(lineage)).toContain("a real red");
    });

    it("formatGateLineageLine: a matched file still wins, but an unreadable submodule is disclosed", () => {
      // STALE is the actionable verdict and must not be suppressed — but the reader is
      // still told part of the range was unreadable, so "only one file matched" is not
      // mistaken for a complete accounting.
      const lineage: GateLineage = {
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: ["src/a.test.ts"],
        submodulesUnexpanded: ["libs/test-config"],
      };
      const line = formatGateLineageLine(lineage);
      expect(line).toContain("presumptively STALE");
      expect(line).toContain("also unreadable: libs/test-config");
    });

    it("computeGateLineage: counts commits behind tip and names failing files touched in range", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2 — the candidate");
      await commit("src/failing.test.ts", "fixed", "c3");
      await commit("other.ts", "x", "c4");
      const tip = await commit("other.ts", "y", "c5");
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "src/failing.test.ts",
      ]);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      expect(lineage!.commitsBehind).toBe(3); // c3, c4, c5
      expect(lineage!.failingFilesChangedInRange).toEqual([
        "src/failing.test.ts",
      ]);
    });

    // EI-19324432490048782 / EI-19324146335802876. The test ABOVE passes a failing file at
    // the repo ROOT (`src/failing.test.ts`) — the one position where vitest's
    // workspace-relative vocabulary and git's repo-relative vocabulary coincide. Every real
    // failing file lives INSIDE a workspace, where they cannot coincide, so the old
    // exact-equality intersection was empty on every real gate run while this suite stayed
    // green. These cases pin the real shape.
    it("computeGateLineage: matches a workspace-relative failing file against a repo-relative change (the shape that was empty by construction)", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2 — the candidate");
      await commit(
        "packages/operator-core/lib/sync-resolver/sync-read-audit.test.ts",
        "fixed",
        "c3",
      );
      const tip = await commit("other.ts", "y", "c4");
      // Exactly what the gate passes: vitest's workspace-relative path, plus the bare
      // workspace NAMES extractFailingTests also emits (never paths, must not match).
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "@papercusp/operator-core",
        "lib/sync-resolver/sync-read-audit.test.ts",
      ]);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      // The REPO-relative path is what the reader can act on.
      expect(lineage!.failingFilesChangedInRange).toEqual([
        "packages/operator-core/lib/sync-resolver/sync-read-audit.test.ts",
      ]);
    });

    it("computeGateLineage: records failing files whose fixes may have landed in their subjects", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2 — the candidate");
      await commit(
        "src/a.test.ts",
        "fixed",
        "c3 — changes one failing test file",
      );
      await commit(
        "src/subject.ts",
        "fixed",
        "c4 — changes a subject, not the other failing test file",
      );
      const tip = await commit("other.ts", "y", "c5");
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "src/a.test.ts",
        "src/b.test.ts",
      ]);
      expect(lineage).not.toBeNull();
      expect(lineage!.tip).toBe(tip);
      expect(lineage!.failingFilesChangedInRange).toEqual(["src/a.test.ts"]);
      expect(lineage!.failingFilesUnchangedInRange).toEqual(["src/b.test.ts"]);
      expect(formatGateLineageLine(lineage!)).toContain("src/b.test.ts");
    });

    it("matchFailingFilesToChanged: skips workspace names, needs a path boundary, dedupes", () => {
      // A workspace name is not a file, even though it contains a slash.
      expect(
        matchFailingFilesToChanged(["@papercusp/web"], ["apps/web"]),
      ).toEqual([]);
      // Suffix must land on a path boundary — `audit.test.ts` must not match `read-audit.test.ts`.
      expect(
        matchFailingFilesToChanged(
          ["audit.test.ts"],
          ["packages/x/lib/read-audit.test.ts"],
        ),
      ).toEqual([]);
      // Unchanged failing file ⇒ no match (the presumptively-real-red signal must survive).
      expect(
        matchFailingFilesToChanged(
          ["lib/a.test.ts"],
          ["packages/x/lib/b.test.ts"],
        ),
      ).toEqual([]);
      // Two failing entries resolving to one changed file are reported once.
      expect(
        matchFailingFilesToChanged(
          ["lib/a.test.ts", "packages/x/lib/a.test.ts"],
          ["packages/x/lib/a.test.ts"],
        ),
      ).toEqual(["packages/x/lib/a.test.ts"]);
    });

    it("unmatchedFailingFiles: returns only path-shaped failures absent from the range", () => {
      expect(
        unmatchedFailingFiles(
          ["@papercusp/operator-core", "lib/a.test.ts", "lib/b.test.ts"],
          [
            "packages/operator-core/lib/a.test.ts",
            "packages/other/lib/subject.ts",
          ],
        ),
      ).toEqual(["lib/b.test.ts"]);
    });

    it("computeGateLineage: candidate IS the tip", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2");
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "src/failing.test.ts",
      ]);
      expect(lineage).toEqual({
        candidate,
        tip: candidate,
        commitsBehind: 0,
        failingFilesChangedInRange: [],
      });
    });

    /* ── EI-20063423357086565: the fix is ON DISK but not committed ─────────────────
     * Every discriminator above compares COMMITS, so none of them can see a fix that
     * exists only in the working tree. The blindness is worst exactly where this record
     * is most confident: `commitsBehind === 0` returns "nothing newer to blame, this is
     * a real red". Measured incident — git-sync stalled ~31min while a complete fix sat
     * in the tree, the gate re-judged the same tip twice more, `main` froze ~1h behind
     * staging, and every red read as "my fix didn't work" instead of "my fix was never
     * committed".
     */

    /** Write a file WITHOUT committing it — the incident's actual shape. */
    function writeUncommitted(file: string, content: string): void {
      const full = join(repo, file);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }

    it("formatGateLineageLine: candidate IS the tip but a failing file is dirty — the real-red presumption is WITHHELD", () => {
      const base: GateLineage = {
        candidate: "a".repeat(40),
        tip: "a".repeat(40),
        commitsBehind: 0,
        failingFilesChangedInRange: [],
      };
      // CONTROL: the SAME record without a dirty file still produces the confident wording.
      // Without this pair, the assertion below would also pass against a formatter that
      // had simply stopped saying "real red" for every input.
      expect(formatGateLineageLine(base)).toContain("this is a real red");

      const line = formatGateLineageLine({
        ...base,
        failingFilesDirtyUncommitted: ["packages/operator-core/lib/a.test.ts"],
      });
      expect(line).not.toContain("this is a real red");
      expect(line).toContain("NOT a confirmed real red");
      expect(line).toContain("ALREADY-ON-DISK, NOT COMMITTED");
      expect(line).toContain("packages/operator-core/lib/a.test.ts");
      // The actionable half — a diagnosis with no next step is what cost the hour.
      expect(line).toContain("dev:pipeline_position");
    });

    it("formatGateLineageLine: the dirty note also lands on the commits-behind verdict, and lands LAST", () => {
      const line = formatGateLineageLine({
        candidate: "c".repeat(40),
        tip: "t".repeat(40),
        commitsBehind: 4,
        failingFilesChangedInRange: [],
        failingPathsConsidered: 2,
        rangeFilesChanged: 0, // the range genuinely changed nothing ⇒ "a real red"
        failingFilesDirtyUncommitted: ["packages/x/lib/b.test.ts"],
      });
      // The commit-based discriminator still speaks for itself...
      expect(line).toContain("nothing at all changed in that range");
      // ...but it must not be the last word, because it was computed over commits only.
      expect(line).toContain("ALREADY-ON-DISK, NOT COMMITTED");
      expect(line.indexOf("ALREADY-ON-DISK")).toBeGreaterThan(
        line.indexOf("nothing at all changed"),
      );
    });

    it("computeGateLineage: names a failing file whose fix is written but NOT committed (the incident, end to end)", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit(
        "packages/operator-core/lib/sync-read-audit.test.ts",
        "broken",
        "c2 — the candidate",
      );

      // CONTROL: committed and clean ⇒ nothing reported, confident wording intact. This is
      // what proves the positive below is caused by the DIRTY WRITE and not merely by the
      // file being named as failing.
      const clean = await computeGateLineage(repo, "main", candidate, [
        "lib/sync-read-audit.test.ts",
      ]);
      expect(clean!.failingFilesDirtyUncommitted).toBeUndefined();
      expect(formatGateLineageLine(clean!)).toContain("this is a real red");

      // Now the fix is written to disk and git-sync has not swept it yet.
      writeUncommitted(
        "packages/operator-core/lib/sync-read-audit.test.ts",
        "fixed",
      );
      const dirty = await computeGateLineage(repo, "main", candidate, [
        "lib/sync-read-audit.test.ts",
      ]);
      // Every commit-based check still agrees this is the tip — that is the whole point.
      expect(dirty!.commitsBehind).toBe(0);
      // Reported REPO-relative, matched from vitest's WORKSPACE-relative entry
      // (the vocabulary skew that made the sibling signal empty-by-construction).
      expect(dirty!.failingFilesDirtyUncommitted).toEqual([
        "packages/operator-core/lib/sync-read-audit.test.ts",
      ]);
      expect(formatGateLineageLine(dirty!)).not.toContain("this is a real red");
    });

    it("computeGateLineage: an UNTRACKED new file counts as dirty (a diff against a commit cannot see it at all)", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2 — the candidate");
      // A brand-new test file the candidate provably cannot contain.
      writeUncommitted(
        "packages/operator-core/lib/brand-new.test.ts",
        'it("x", () => {})',
      );
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "lib/brand-new.test.ts",
      ]);
      expect(lineage!.failingFilesDirtyUncommitted).toEqual([
        "packages/operator-core/lib/brand-new.test.ts",
      ]);
    });

    it("computeGateLineage: a dirty file that is NOT among the failing tests is never reported", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2 — the candidate");
      // On the shared tree dozens of unrelated files are dirty at any instant. The signal
      // is only worth anything if it stays scoped to the FAILING files.
      writeUncommitted("packages/operator-core/lib/unrelated.ts", "noise");
      const lineage = await computeGateLineage(repo, "main", candidate, [
        "lib/the-failing.test.ts",
      ]);
      expect(lineage!.failingFilesDirtyUncommitted).toBeUndefined();
    });

    it('failingFilesUncommitted: all-workspace-name failures are VACUOUS, not a measured "nothing dirty"', async () => {
      await commit("a", "1", "c1");
      writeUncommitted("packages/operator-core/lib/x.test.ts", "dirty");
      // Nothing path-shaped ⇒ nothing could be intersected (EI-19393306381214544's shape,
      // one field over). The empty answer must not be read as evidence of a clean tree.
      expect(
        await failingFilesUncommitted(repo, ["@papercusp/operator-core"]),
      ).toEqual([]);
      // CONTROL: the very same dirty file IS found once a path-shaped entry exists —
      // so the empty result above came from the vacuity guard, not from a broken reader.
      expect(await failingFilesUncommitted(repo, ["lib/x.test.ts"])).toEqual([
        "packages/operator-core/lib/x.test.ts",
      ]);
    });

    it("runGreenCheckpoint: not-green verdict carries the lineage line in the broadcast body + the structured result", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit(
        "a",
        "2",
        "c2 — the (stale-by-verdict-time) candidate",
      );
      await commit(
        "src/failing.test.ts",
        "fixed",
        "c3 — fixes it, landed after the candidate was cut",
      );
      const { deps } = stubDeps(false, ["src/failing.test.ts"]);
      const messages: string[] = [];
      deps.broadcast = async (_s: string, body?: string) => {
        messages.push(body ?? "");
      };
      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate,
        noPush: true,
      });
      expect(r.reason).toBe("not-green");
      expect(r.lineage).toMatchObject({
        candidate,
        commitsBehind: 1,
        failingFilesChangedInRange: ["src/failing.test.ts"],
      });
      expect(
        messages.some(
          (m) =>
            m.includes("📍 lineage:") &&
            m.includes("1 commit(s) behind tip") &&
            m.includes("presumptively STALE"),
        ),
      ).toBe(true);
    });
  });

  // EI-10615 — the stale-red rescue must run BEFORE the partial-green prefix salvage.
  //
  // The bug these pin: the two ran in the OPPOSITE order, which made the rescue dead code
  // on a fast-moving fleet. The gate went red, entered the prefix salvage's CONFIRM run (a
  // SECOND full suite, tens of minutes), and was superseded/killed before execution ever
  // reached the re-triage. Seven consecutive gate runs ended their log on the partial-green
  // "confirming longest clean prefix …" line with nothing after it; every one of those reds
  // PASSED at tip (the last was disproved in 559ms). `main` sat 143 commits behind for ~9h
  // with nothing actually broken, so nothing the fleet fixed that day ever reached :3070.
  //
  // These assert ORDER + SKIP, not just the pure classifier — a pure-classifier test passes
  // happily while the caller never invokes it, which is exactly what happened.
  describe("EI-10615: stale-red re-triage precedes the partial-green prefix salvage", () => {
    /** Wires BOTH paths as eligible, so ordering is the only thing under test. */
    function bothPathsWired(opts: { passesAtTip: boolean }) {
      const calls: string[] = [];
      const { deps } = stubDeps(false, ["@papercusp/web"]);
      let greenRuns = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        greenRuns += 1;
        return {
          green: false,
          summary: "1 failed",
          failingTests: ["@papercusp/web"],
          failingFiles: [
            { file: "src/failing.test.ts", workspace: "@papercusp/web" },
          ],
        };
      };
      // The re-triage is gated on a tip NEWER than the candidate — without resolveTip it
      // never runs at all (tip=null), which is precisely how it stayed silently dead.
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runTestsAtRef = async () => {
        calls.push("runTestsAtRef");
        return {
          pass: opts.passesAtTip,
          summary: opts.passesAtTip ? "pass at tip" : "still red at tip",
        };
      };
      // The prefix salvage's inputs — present and eligible. If it is ever ATTEMPTED,
      // commitsInRange is the first thing it calls, so it cannot run without leaving a mark.
      deps.commitsInRange = async () => {
        calls.push("commitsInRange");
        return [];
      };
      deps.affectedWorkspacesForRange = async () => {
        calls.push("affectedWorkspacesForRange");
        return ["@papercusp/web"];
      };
      return { deps, calls, greenRuns: () => greenRuns };
    }

    it("a STALE red with the refire cap spent still does not salvage from its phantom signature", async () => {
      // Cap 0 ⇒ no refire, so the run walks PAST the re-triage — the exact path where the
      // old code would hand a phantom failure signature to the prefix salvage and spend a
      // second full suite under-advancing `main` around a failure that does not exist.
      vi.stubEnv("PAPERCUSP_GATE_AUTO_REFIRE_CAP", "0");
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2"); // the candidate the quiet-cut judges
      await commit(
        "src/failing.test.ts",
        "fixed",
        "c3 — the fix, landed after the cut",
      );
      const { deps, calls } = bothPathsWired({ passesAtTip: true });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain("runTestsAtRef"); // the rescue ran (cheap)...
      expect(calls).not.toContain("commitsInRange"); // ...and the salvage was never ATTEMPTED
      vi.unstubAllEnvs();
    });

    it('a tip re-run that fails to EXECUTE is unknown — never a false "REPRODUCE at tip"', async () => {
      // A tree-setup/exec failure is ABSENCE of evidence, not evidence the failures
      // reproduce. realCheckpointDeps.runTestsAtRef used to swallow a setupTree throw
      // and return {pass:false}, which classifyRedAgainstTip reads as tipRetest.ran ⇒
      // "failures REPRODUCE at tip <sha> — genuine red, holding the gate" — a confident
      // claim about a tip that was never run. It must reach the 'unknown' branch instead:
      // same held gate, honest reason. (WI-5110.)
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit(
        "src/failing.test.ts",
        "fixed",
        "c3 — the fix, landed after the cut",
      );
      const { deps } = bothPathsWired({ passesAtTip: true });
      deps.runTestsAtRef = async () => {
        throw new Error("tip tree setup failed");
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(r.retriage).toMatchObject({
        classification: "unknown",
        autoRefire: false,
      });
      expect(r.retriage?.detail ?? "").not.toMatch(/REPRODUCE/i);
      expect(r.advanced).toBe(false); // still holds the gate — only the REASON changes
    });

    it("downgrades a tip re-run when HEAD advances before classification, instead of auto-refiring stale evidence", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      const c3 = await commit(
        "src/failing.test.ts",
        "fixed",
        "c3 — the tested tip",
      );
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
      let landedDuringRetriage: string | undefined;
      deps.runTestsAtRef = async () => {
        // Simulate git-sync landing a newer commit after the re-triage's initial tip snapshot.
        landedDuringRetriage = await commit(
          "src/another-fix.ts",
          "landed during re-triage",
          "c4",
        );
        return { pass: true, summary: "pass at tested tip" };
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(landedDuringRetriage).toBeDefined();
      expect(r).toMatchObject({
        advanced: false,
        green: false,
        reason: "not-green",
        retriage: {
          classification: "unknown",
          autoRefire: false,
          tip: c3,
        },
      });
      expect(r.retriage?.detail).toContain(
        `tip ${c3.slice(0, 8)} was cut at re-triage start`,
      );
      expect(r.retriage?.detail).toContain(
        `integration HEAD is now ${landedDuringRetriage!.slice(0, 8)}`,
      );
      expect(r.retriage?.detail).toContain("staleness is UNKNOWN");
      expect(r.retriage?.detail).toContain("will not auto-refire");
      expect(calls.filter((call) => call === "runGreen")).toHaveLength(1);
      expect(calls).not.toContain("advance");
    });

    it("a STALE red REFIRES on the tip and can advance — the rescue that seven gate runs never reached", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      const c3 = await commit("src/failing.test.ts", "fixed", "c3 — the fix");
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
      // The candidate is red; the TIP is green (the peer fix landed after the cut).
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed",
              failingTests: ["@papercusp/web"],
              failingFiles: [
                { file: "src/failing.test.ts", workspace: "@papercusp/web" },
              ],
            }
          : { green: true, summary: "all pass" };
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(calls).toContain("runTestsAtRef");
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3); // advanced to the TIP, not held on the stale red
    });

    // EI-19326481022404981: a caller may have armed `checkpoint:await { candidateSha: c2 }`
    // right after c2 was committed — before learning the gate's quiet-cut would immediately
    // re-triage it away onto a newer tip. Without cancelling that stale registration, the
    // caller's sha-bound wait has no way to learn THIS run moved on: its eventual verdict
    // fires keyed to c3 (never matching a `startsWith: c2` payload filter), so the caller
    // sleeps to its own multi-hour timeout, indistinguishable the whole time from "still
    // judging". This pins the fix — green-checkpoint.ts calling deps.cancelStaleAwaits /
    // deps.recordInFlightRetriage right before the recursive re-fire onto the new candidate.
    it("a STALE red that REFIRES cancels any checkpoint:await bound to the ABANDONED candidate, and records the transition", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2"); // the candidate about to be ABANDONED
      const c3 = await commit("src/failing.test.ts", "fixed", "c3 — the fix"); // the newer tip
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed",
              failingTests: ["@papercusp/web"],
              failingFiles: [
                { file: "src/failing.test.ts", workspace: "@papercusp/web" },
              ],
            }
          : { green: true, summary: "all pass" };
      };
      const cancelledFor: string[] = [];
      const retriageMarkers: Array<{
        fromCandidate: string;
        refiringCandidate: string;
      }> = [];
      deps.cancelStaleAwaits = async (fromCandidate) => {
        calls.push("cancelStaleAwaits");
        cancelledFor.push(fromCandidate);
      };
      deps.recordInFlightRetriage = async (info) => {
        calls.push("recordInFlightRetriage");
        retriageMarkers.push({
          fromCandidate: info.fromCandidate,
          refiringCandidate: info.refiringCandidate,
        });
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // The abandoned candidate (c2) — NEVER the new tip (c3), which has a real verdict coming
      // and must not be cancelled.
      expect(cancelledFor).toEqual([c2]);
      expect(retriageMarkers).toEqual([
        { fromCandidate: c2, refiringCandidate: c3 },
      ]);
      // Both the marker write and the cancellation happen on the FIRST (failing) pass, before
      // the recursive re-run's own runGreen call — never left dangling after the recursion.
      const secondRunGreen = calls.lastIndexOf("runGreen");
      expect(calls.indexOf("recordInFlightRetriage")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("recordInFlightRetriage")).toBeLessThan(
        secondRunGreen,
      );
      expect(calls.indexOf("cancelStaleAwaits")).toBeLessThan(secondRunGreen);
    });

    // WI-37490: a run that auto-refires and then dies mid-refire (process kill, deploy
    // restart, host reboot) used to record NOTHING — recordOwnVerdict only fires on the
    // FINAL resolution of the (possibly-recursive) runGreenCheckpoint call, so the first
    // pass's already-computed verdict was silently discarded. Pins the fix: the superseded
    // pass's own verdict is recorded via deps.recordVerdict BEFORE the recursive re-fire.
    it("a STALE red that REFIRES records the SUPERSEDED pass verdict before recursing (WI-37490)", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2"); // the candidate about to be ABANDONED
      const c3 = await commit("src/failing.test.ts", "fixed", "c3 — the fix"); // the newer tip
      const { deps, calls } = bothPathsWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed",
              failingTests: ["@papercusp/web"],
              failingFiles: [
                { file: "src/failing.test.ts", workspace: "@papercusp/web" },
              ],
            }
          : { green: true, summary: "all pass" };
      };
      const recorded: Array<{ green: boolean | null; candidate: string }> = [];
      deps.recordVerdict = async (r) => {
        calls.push("recordVerdict");
        recorded.push({ green: r.green, candidate: r.candidate });
        return true;
      };

      let finalized = false;
      const finalize = createNormalCheckpointFinalizer({
        claimTerminal: () => {
          if (finalized) return false;
          finalized = true;
          return true;
        },
        emitResult: async () => { calls.push("finalResult"); },
        captureProofs: async () => { calls.push("captureProofs"); },
        releaseAndExit: () => { calls.push("releaseAndExit"); },
      });
      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });
      await finalize(r);
      await finalize(r); // A repeated normal callback cannot re-capture or release twice.

      // The overall run still resolves green, advanced to the tip — recording the
      // superseded pass must not change the final outcome.
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // Exactly ONE recorded verdict: the superseded first pass, NOT-green, still pinned
      // to the ABANDONED candidate c2 (never c3 — the final resolution's own recorder,
      // recordOwnVerdict, is a separate call path this test does not stub).
      expect(recorded).toEqual([{ green: false, candidate: c2 }]);
      // Recorded on the FIRST (failing) pass, strictly before the recursive re-run's own
      // runGreen call — a superseded-pass record left dangling after the recursion would
      // mean it ran too late to survive a death during the refire itself.
      const secondRunGreen = calls.lastIndexOf("runGreen");
      expect(calls.indexOf("recordVerdict")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("recordVerdict")).toBeLessThan(secondRunGreen);
      // Exercise the CLI's production finalizer on the real recursive result, after both runs.
      expect(run).toBe(2);
      expect(calls.indexOf("finalResult")).toBeGreaterThan(secondRunGreen);
      expect(calls.indexOf("captureProofs")).toBeGreaterThan(calls.indexOf("finalResult"));
      expect(calls.indexOf("releaseAndExit")).toBeGreaterThan(calls.indexOf("captureProofs"));
      for (const event of ["finalResult", "captureProofs", "releaseAndExit"]) {
        expect(calls.filter((call) => call === event)).toHaveLength(1);
      }
    });

    it("the cheap tip re-triage runs BEFORE any prefix-salvage work", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("src/failing.test.ts", "fixed", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: true });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      const triaged = calls.indexOf("runTestsAtRef");
      const salvaged = calls.indexOf("commitsInRange");
      expect(triaged).toBeGreaterThanOrEqual(0);
      // -1 (never) is the correct outcome here; the point is it must NEVER precede triage.
      if (salvaged >= 0) expect(triaged).toBeLessThan(salvaged);
    });

    it("a REAL red (reproduces at tip) still gets the prefix salvage — P-016 is not regressed", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: false });

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain("runTestsAtRef"); // triaged first...
      expect(calls).toContain("commitsInRange"); // ...then genuinely salvaged
      expect(calls.indexOf("runTestsAtRef")).toBeLessThan(
        calls.indexOf("commitsInRange"),
      );
    });

    // WI-39450: the salvage is a SECOND full affected suite, and it consulted no deadline —
    // so on a real red it routinely started with minutes left of the 120m
    // GREEN_CHECKPOINT_SUITE_TIMEOUT_MS budget and was SIGTERM'd mid-confirm. On this
    // (non-refire) path the verdict is persisted only when runGreenCheckpoint RESOLVES, via
    // the CLI's recordOwnVerdict `.then()` — so the kill discarded a fully-computed verdict
    // and the routine wrote status:'error'/candidate:null/failingTests:[] instead. Measured
    // 2026-08-17: 10 of 13 recent checkpoint logs ended on the salvage's "confirming longest
    // clean prefix" line, and gate_health came back observedCandidate=null.
    it("WI-39450: a REAL red past the run budget SKIPS the salvage and still returns its verdict", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: false });

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
        // Already past the deadline when the salvage is reached.
        salvageDeadlineMs: Date.now() - 1,
      });

      // Triage still runs (it is cheap and precedes the deadline check)...
      expect(calls).toContain("runTestsAtRef");
      // ...but the expensive salvage never STARTS — commitsInRange is its first call, so it
      // cannot run without leaving a mark.
      expect(calls).not.toContain("commitsInRange");

      // The whole point: the verdict still lands, intact, naming the candidate and the
      // failing tests. This is what the SIGTERM used to destroy.
      expect(r.green).toBe(false);
      expect(r.candidate).toBe(c2);
      expect(r.failingTests).toContain("@papercusp/web");
    });

    // CONTROL for the test above: the deadline must be the ONLY thing suppressing the
    // salvage. Same fixture, same real red, deadline far in the future ⇒ it must still
    // salvage. Without this, a bug that disabled the salvage outright would pass the
    // skip-test and look like a fix.
    it("WI-39450 control: the same REAL red WITH budget remaining still salvages", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: false });

      await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
        salvageDeadlineMs: Date.now() + 60 * 60_000,
      });

      expect(calls).toContain("commitsInRange");
    });

    it("EI-21434759422783893: one-time setup age does not price a cheap salvage confirm out of budget", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: false });
      const now = Date.now();

      await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
        // The process spent 55m in one-time setup, while its in-memory candidate suite is
        // cheap. The old whole-run estimate rejected salvage despite 10m of real headroom.
        runStartedAtMs: now - 55 * 60_000,
        salvageDeadlineMs: now + 10 * 60_000,
      });

      expect(calls).toContain("commitsInRange");
    });

    // WI-41655: the estimate above is a MEASUREMENT only when the suite actually ran. The
    // early changed-file typecheck preflight short-circuits `deps.runGreen`, so the measured
    // interval collapses to ~0ms (clamped to 1ms) — which makes `salvageOutOfTime` false in
    // every practical case AND seeds `initialConfirmEstimateMs` with the same ~0ms, so the
    // first full confirm suite starts unbudgeted. That is the SIGTERM-mid-confirm verdict
    // loss WI-39450 added the gate for. Same fixture as the test above, inverted: with no
    // suite to reason from, a run that has already burned its budget must still DECLINE.
    async function earlyPreflightRedFixture() {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = bothPathsWired({ passesAtTip: false });
      deps.changedFilesForRange = async () => [
        "packages/operator-core/lib/thing.ts",
      ];
      deps.runChangedFileTypecheckPreflight = async () => {
        calls.push("runChangedFileTypecheckPreflight");
        return {
          status: "failed" as const,
          summary:
            "thing.ts(1,1): error TS2322: Type 'string' is not assignable.",
          failingSignatures: ["lint:tsc"],
        };
      };
      return { c2, deps, calls };
    }

    // P-016 (green-main-ratchet-convergence-2026-10-17#D-004): this fixture is round 1, which
    // now MEASURES the suite after an early-preflight red, so the confirm estimate seeds from
    // that measured suite rather than the whole run. The skipped-suite whole-run fallback now
    // applies only on repair-head rounds and is pinned directly on
    // `confirmSuiteEstimateSeedMs` in green-checkpoint-round-one.test.ts.
    it("WI-41655 / P-016: round 1 measures the suite after an early-preflight red, so the estimate is that suite, not the 55m of setup", async () => {
      const { c2, deps, calls } = await earlyPreflightRedFixture();
      const now = Date.now();

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
        // 55m of one-time setup already spent, 10m of budget left: a whole-run seed would
        // decline the salvage; the measured round-1 suite (near-zero here) admits it.
        runStartedAtMs: now - 55 * 60_000,
        salvageDeadlineMs: now + 10 * 60_000,
      });

      expect(calls).toContain("runChangedFileTypecheckPreflight");
      expect(calls).toContain("runGreen");
      expect(calls).toContain("commitsInRange");
      expect(r.green).toBe(false);
      expect(r.candidate).toBe(c2);
    });

    // CONTROL for the test above: the deadline must be the ONLY thing suppressing the
    // salvage. Without this, a fallback that simply disabled salvage on the early-preflight
    // path would pass the skip-test and look like a fix.
    it("WI-41655 control: the same early-preflight red WITH budget remaining still salvages", async () => {
      const { c2, deps, calls } = await earlyPreflightRedFixture();
      const now = Date.now();

      await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
        // Same 55m of setup, but 60m of budget — the fallback estimate now fits.
        runStartedAtMs: now - 55 * 60_000,
        salvageDeadlineMs: now + 60 * 60_000,
      });

      expect(calls).toContain("runChangedFileTypecheckPreflight");
      expect(calls).toContain("commitsInRange");
    });
  });

  // EI-18759362119598634: a LINT/TYPECHECK red never populates `failingFiles` (that list
  // is test-FILE-only), so it used to fall straight past the whole re-triage above with
  // nothing to re-run — a lint fixed 90s after the quiet-cut still held the gate red
  // forever. These pin the sibling rescue: `runGateAtRef` re-verifies the named gate
  // script(s) directly, the same stale-vs-real classification + auto-refire the
  // file-based rescue already gets.
  describe("EI-18759362119598634: gate-only (lint/typecheck) stale-red re-triage", () => {
    function gatePathWired(opts: { passesAtTip: boolean }) {
      const calls: string[] = [];
      const { deps } = stubDeps(false, ["lint:identity-leak"]); // no failingFiles ⇒ gate-only red
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runGateAtRef = async (_ref, gateIds) => {
        calls.push("runGateAtRef");
        return {
          pass: opts.passesAtTip,
          summary: opts.passesAtTip
            ? `${gateIds.join(",")}: pass at tip`
            : `${gateIds.join(",")}: FAIL at tip`,
        };
      };
      deps.commitsInRange = async () => {
        calls.push("commitsInRange");
        return [];
      };
      deps.affectedWorkspacesForRange = async () => {
        calls.push("affectedWorkspacesForRange");
        return ["@papercusp/web"];
      };
      return { deps, calls };
    }

    it("a STALE gate red (the lint fix already landed at tip) REFIRES and can advance", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2"); // the candidate the quiet-cut judges — still has the leak
      const c3 = await commit("b", "2", "c3 — fixes the identity-leak lint"); // tip: already fixed
      const { deps, calls } = gatePathWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed",
              failingTests: ["lint:identity-leak"],
            } // no failingFiles
          : { green: true, summary: "all pass" };
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(calls).toContain("runGateAtRef");
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3); // advanced to the TIP, not held on the stale lint red
    });

    // WI-37490: the gate-only (lint/typecheck) sibling of the file-based rescue's own
    // superseded-pass recording, above. Same defect, same fix, independent call site
    // (green-checkpoint.ts's second `deps.recordVerdict?.(buildNotGreenResult(...))` before
    // its own recursive re-fire) — this pins THAT site so it can't silently regress alone.
    it("a STALE gate red that REFIRES records the SUPERSEDED pass verdict before recursing (WI-37490)", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2"); // the candidate about to be ABANDONED
      const c3 = await commit("b", "2", "c3 — fixes the identity-leak lint"); // the newer tip
      const { deps, calls } = gatePathWired({ passesAtTip: true });
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed",
              failingTests: ["lint:identity-leak"],
            } // no failingFiles ⇒ gate-only red
          : { green: true, summary: "all pass" };
      };
      const recorded: Array<{ green: boolean | null; candidate: string }> = [];
      deps.recordVerdict = async (r) => {
        calls.push("recordVerdict");
        recorded.push({ green: r.green, candidate: r.candidate });
        return true;
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
      // Exactly one recorded verdict: the superseded first pass, not-green, pinned to the
      // abandoned candidate c2 — never c3, which belongs to the final resolution's own
      // (separately-tested) recordOwnVerdict path.
      expect(recorded).toEqual([{ green: false, candidate: c2 }]);
      const secondRunGreen = calls.lastIndexOf("runGreen");
      expect(calls.indexOf("recordVerdict")).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("recordVerdict")).toBeLessThan(secondRunGreen);
    });

    it("a REAL gate red (still fails at tip) holds the gate and still gets the prefix salvage", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const { deps, calls } = gatePathWired({ passesAtTip: false });

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(calls).toContain("runGateAtRef"); // triaged...
      expect(r.retriage).toMatchObject({
        classification: "real-red",
        autoRefire: false,
      });
      expect(r.advanced).toBe(false);
      expect(calls).toContain("commitsInRange"); // ...then genuinely salvaged, same as a real test red
    });

    // EI-19992136440423793 path (a). ⚠ THIS TEST'S EXPECTATION WAS DELIBERATELY INVERTED, and
    // that is the point of the change — it is not a weakened guard. It used to assert
    // `expect(calls).not.toContain('runGateAtRef')` on the rationale that firing both "would
    // double-rescue the same red". That premise is false: the two arms cover DIFFERENT HALVES of
    // the failing set — `runTestsAtRef` re-runs the located test FILES, `runGateAtRef` re-runs the
    // registered lint/typecheck legs, and neither one measures the other's half. So on a mixed red
    // the old behaviour did not avoid a double-rescue, it threw the lint half away UNMEASURED:
    // `gateIds = failingFiles.length === 0 ? nonTestGateIdsFrom(failingTests) : []` forced the
    // empty set the moment any test file was present. The cost was a whole extra ~55min suite —
    // the file half passes at tip, the gate refires on partial evidence, and only THEN does anyone
    // discover the lint leg is still red.
    it("a mixed red (a failing test file ALONGSIDE a gate id) re-verifies BOTH halves in one pass", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3"); // tip strictly newer than the judged candidate
      const calls: string[] = [];
      const gateIdsSeen: string[][] = [];
      const { deps } = stubDeps(false, [
        "@papercusp/web",
        "lint:identity-leak",
      ]);
      deps.runGreen = async () => ({
        green: false,
        summary: "1 failed + 1 lint",
        failingTests: ["@papercusp/web", "lint:identity-leak"],
        failingFiles: [
          { file: "src/failing.test.ts", workspace: "@papercusp/web" },
        ],
      });
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runTestsAtRef = async () => {
        calls.push("runTestsAtRef");
        return { pass: false, summary: "still red at tip" };
      };
      deps.runGateAtRef = async (_ref, ids) => {
        calls.push("runGateAtRef");
        gateIdsSeen.push(ids);
        return { pass: true, summary: "pass at tip" };
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(calls).toContain("runTestsAtRef");
      expect(calls).toContain("runGateAtRef");
      // The gate half re-runs ONLY the lint leg — never `@papercusp/web`, which is the workspace
      // the file rescue already covers. Routing that to the gate runner would try to `npm run
      // @papercusp/web` and is exactly what the subtraction exists to prevent.
      expect(gateIdsSeen).toEqual([["lint:identity-leak"]]);
      // The composed verdict is the AND of both halves: the test file still fails at tip, so the
      // red is real and nothing refires, even though the lint half passed. A rescue that refired
      // here would be declaring the whole red stale off one half of the evidence.
      expect(r.retriage).toMatchObject({
        classification: "real-red",
        autoRefire: false,
      });
      expect(r.advanced).toBe(false);
    });

    it("a mixed red whose BOTH halves pass at tip is stale and refires once, covering both", async () => {
      // The complement of the case above, and the one that actually recovers gate minutes: with
      // the two arms composed this is settled in a single cheap pass instead of refiring on the
      // file half alone and re-discovering the lint half a full suite later.
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      const c3 = await commit(
        "b",
        "2",
        "c3 — fixes both the test and the lint",
      );
      const calls: string[] = [];
      const { deps } = stubDeps(false, [
        "@papercusp/web",
        "lint:identity-leak",
      ]);
      let run = 0;
      deps.runGreen = async () => {
        calls.push("runGreen");
        run += 1;
        return run === 1
          ? {
              green: false,
              summary: "1 failed + 1 lint",
              failingTests: ["@papercusp/web", "lint:identity-leak"],
              failingFiles: [
                { file: "src/failing.test.ts", workspace: "@papercusp/web" },
              ],
            }
          : { green: true, summary: "all pass" };
      };
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runTestsAtRef = async () => {
        calls.push("runTestsAtRef");
        return { pass: true, summary: "files pass at tip" };
      };
      deps.runGateAtRef = async () => {
        calls.push("runGateAtRef");
        return { pass: true, summary: "lint passes at tip" };
      };

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      // BOTH halves were measured before the refire — the whole point of composing them.
      expect(calls).toContain("runTestsAtRef");
      expect(calls).toContain("runGateAtRef");
      expect(calls.indexOf("runGateAtRef")).toBeLessThan(
        calls.lastIndexOf("runGreen"),
      );
      expect(r.green).toBe(true);
      expect(r.advanced).toBe(true);
      expect(r.candidate).toBe(c3);
    });

    it("a mixed red with an UNRESCUABLE entry beside the gate id still vetoes the gate half", async () => {
      // The safety property the subtraction must NOT erode. `@papercusp/operator-vite` (a build
      // break) is deliberately absent from NON_TEST_GATE_SCRIPTS and is not covered by the file
      // rescue either, so nothing can measure it at tip — which means a "stale" verdict reached
      // from the other two halves would rest on evidence nobody collected. The residual therefore
      // fails nonTestGateIdsFrom's all-or-nothing check and the file rescue runs alone, exactly as
      // it did before path (a).
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3");
      const calls: string[] = [];
      const { deps } = stubDeps(false, [
        "@papercusp/web",
        "lint:identity-leak",
        "@papercusp/operator-vite",
      ]);
      deps.runGreen = async () => ({
        green: false,
        summary: "1 failed + 1 lint + 1 build",
        failingTests: [
          "@papercusp/web",
          "lint:identity-leak",
          "@papercusp/operator-vite",
        ],
        failingFiles: [
          { file: "src/failing.test.ts", workspace: "@papercusp/web" },
        ],
      });
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runTestsAtRef = async () => {
        calls.push("runTestsAtRef");
        return { pass: true, summary: "files pass at tip" };
      };
      deps.runGateAtRef = async () => {
        calls.push("runGateAtRef");
        return { pass: true, summary: "pass at tip" };
      };

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).toContain("runTestsAtRef");
      expect(calls).not.toContain("runGateAtRef");
    });

    it("absent runGateAtRef (existing stub) never rescues a gate-only red — today's plain-red behaviour preserved", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3"); // tip strictly newer — the rescue WOULD be eligible
      const { deps } = stubDeps(false, ["lint:identity-leak"]);
      deps.resolveTip = async () => revParse(repo, "HEAD");
      expect(deps.runGateAtRef).toBeUndefined();

      const r = await runGreenCheckpoint(cfg(), deps, {
        candidate: c2,
        noPush: true,
      });

      expect(r.advanced).toBe(false);
      // WI-7290: this test's subject is "no RESCUE happens", and that is unchanged — no refire,
      // gate stays red. It used to assert that via `retriage === undefined`, which was a proxy
      // for the rescue not running, not the property itself. The record is no longer silent
      // about an unmeasured red (silence read identically to "measured, genuinely red"), so
      // assert the real intent — no rescue — plus the reason that replaced the silence.
      expect(r.retriage?.classification).toBe("unknown");
      expect(r.retriage?.autoRefire ?? false).toBe(false);
      expect(r.retriage?.detail).toContain("no tip gate-runner is wired");
      expect(r.retriage?.detail).toContain("lint:identity-leak");
    });

    it("an unmapped/unknown signature (not in NON_TEST_GATE_SCRIPTS) is never guessed at — no gate rescue attempted", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      await commit("unrelated.ts", "x", "c3"); // tip strictly newer — the rescue WOULD be eligible
      const calls: string[] = [];
      // '@papercusp/operator-vite' (a build break) is deliberately NOT in NON_TEST_GATE_SCRIPTS.
      const { deps } = stubDeps(false, ["@papercusp/operator-vite"]);
      deps.resolveTip = async () => revParse(repo, "HEAD");
      deps.runGateAtRef = async () => {
        calls.push("runGateAtRef");
        return { pass: true, summary: "pass at tip" };
      };

      await runGreenCheckpoint(cfg(), deps, { candidate: c2, noPush: true });

      expect(calls).not.toContain("runGateAtRef");
    });
  });

  describe("nonTestGateIdsFrom (EI-18759362119598634, pure)", () => {
    it("returns the ids when every failingTests entry is a known non-test gate signature", () => {
      expect(nonTestGateIdsFrom(["lint:identity-leak"])).toEqual([
        "lint:identity-leak",
      ]);
      expect(
        nonTestGateIdsFrom(["lint:tsc", "lint:design-primitives"]),
      ).toEqual(["lint:tsc", "lint:design-primitives"]);
    });

    it("returns [] for an empty/undefined list — nothing to do", () => {
      expect(nonTestGateIdsFrom(undefined)).toEqual([]);
      expect(nonTestGateIdsFrom([])).toEqual([]);
    });

    it("returns [] when ANY entry is not a known gate id (a test file/workspace, or an unmapped signature)", () => {
      expect(nonTestGateIdsFrom(["@papercusp/web"])).toEqual([]);
      expect(
        nonTestGateIdsFrom(["lint:identity-leak", "@papercusp/web"]),
      ).toEqual([]);
      expect(nonTestGateIdsFrom(["@papercusp/operator-vite"])).toEqual([]);
      expect(nonTestGateIdsFrom(["package.json-unreadable"])).toEqual([]);
    });
  });

  /**
   * EI-20092765275570648. A red held by a workspace-scoped LINT task could never be
   * measured for staleness, so it could never auto-refire, so it froze `main` until a
   * human noticed — while an otherwise-identical red held by a TEST file self-healed.
   *
   * The break was a lossy signature: the affected runner names the failing task exactly
   * (`<ws> :: <script>`), but extractFailingTests could only match the retry marker
   * `>>> <ws> FAILED`, so all that survived was a bare WORKSPACE name — neither a
   * {workspace,file} pair nor a NON_TEST_GATE_SCRIPTS key, hence `classification=unknown
   * autoRefire=false` and an unmeasured red.
   *
   * Fixtures below are verbatim from the 2026-08-10 incident log
   * (…-base-9263da0694d2-cand-c758381fc674.log L12595/L12727-12728).
   */
  describe("EI-20092765275570648: a workspace-scoped lint red is re-runnable at tip (pure)", () => {
    const INCIDENT_TASK =
      "@papercusp/operator-core :: lint:no-ungated-mug-kettle";
    // Verbatim shape, in the REAL order the runner emits it. The leading PLANNED-task
    // list is load-bearing in this fixture, not scenery: affected-tests.mjs prints the
    // run's schedule (L1210) with the SAME `  - <ws> :: <script>` bullet the failure list
    // uses (L1602). A first cut of this fix matched that bullet log-wide and swept in all
    // 16 planned tasks — which, being mostly `test` scripts, would have defeated the
    // every()-check and left the rescue dead while every hand-built fixture stayed green.
    // Any fixture without a planned-task list cannot catch that, so it stays here.
    const INCIDENT_OUTPUT = [
      "tasks:",
      "  - @papercupai/operator-docs :: test",
      "  - @papercusp/web :: test",
      "  - @papercusp/web :: lint:el-tools",
      "  - @papercusp/operator-core :: test",
      "  - @papercusp/operator-core :: lint:no-retired",
      "  - @papercusp/operator-core :: lint:no-ungated-mug-kettle",
      "",
      ">>> @papercusp/operator-core :: npm run lint:no-ungated-mug-kettle",
      ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)",
      "",
      "1 non-quarantined task(s) failed:",
      "  - @papercusp/operator-core :: lint:no-ungated-mug-kettle",
      "",
      "0 failing test file(s) — the per-FILE break set (the failed=1 above counts TASKS, not files):",
      "1 failed task(s) could NOT be attributed to files — their failures are REAL but unnamed here:",
      "  - @papercusp/operator-core :: lint:no-ungated-mug-kettle (no-file-rows)",
    ].join("\n");

    it("extracts the runner-named TASK id, not just the bare workspace from the retry marker", () => {
      const failing = extractFailingTests(INCIDENT_OUTPUT);
      expect(failing).toContain(INCIDENT_TASK);
      // The bare workspace is deliberately RETAINED: tryLongestGreenPrefix localizes a red
      // by matching workspace names against this signature, so removing it as "subsumed"
      // would trade one rescue for another.
      expect(failing).toContain("@papercusp/operator-core");
      // The `(no-file-rows)` prose sibling must not double-count as a second task.
      expect(
        failing.filter((f) => f.includes("lint:no-ungated-mug-kettle")),
      ).toEqual([INCIDENT_TASK]);
    });

    it("captures ONLY the failed task — never the run's PLANNED task list, which shares the bullet shape", () => {
      const failing = extractFailingTests(INCIDENT_OUTPUT);
      const tasks = failing.filter((f) => f.includes(" :: "));
      // Exactly one task id: the one that actually failed. The 5 other scheduled tasks in
      // the fixture (incl. `@papercusp/web :: lint:el-tools`, itself a lint task that WOULD
      // have looked rescue-eligible) must not appear.
      expect(tasks).toEqual([INCIDENT_TASK]);
      expect(failing).not.toContain("@papercusp/web :: lint:el-tools");
      expect(failing).not.toContain("@papercusp/operator-core :: test");
    });

    it("THE REGRESSION: the incident signature now yields a rescue instead of an unmeasured red", () => {
      // Exactly what the gate held on. Before the fix this returned [] — no gate ids, no
      // tip re-run, `main` frozen.
      expect(nonTestGateIdsFrom(extractFailingTests(INCIDENT_OUTPUT))).toEqual([
        INCIDENT_TASK,
      ]);
    });

    it("documents the bug this closes: the signature the gate ACTUALLY had rescues nothing", () => {
      // This is verbatim what the 2026-08-10 gate held on — the bare workspace scraped from
      // the retry marker, with the runner's own task id dropped on the floor. It is still
      // un-rescuable today (correctly: a workspace name names no script to run), which is
      // exactly why capturing the task id is the load-bearing half of the fix and not a
      // cosmetic signature improvement.
      expect(nonTestGateIdsFrom(["@papercusp/operator-core"])).toEqual([]);
    });

    it("drops the workspace entry the task id subsumes, so the every()-check is not defeated by it", () => {
      expect(
        nonTestGateIdsFrom(["@papercusp/operator-core", INCIDENT_TASK]),
      ).toEqual([INCIDENT_TASK]);
      // An UNRELATED workspace is not subsumed and still declines the rescue.
      expect(nonTestGateIdsFrom(["@papercusp/web", INCIDENT_TASK])).toEqual([]);
    });

    it("mixes with registry gate ids", () => {
      expect(nonTestGateIdsFrom(["lint:tsc", INCIDENT_TASK])).toEqual([
        "lint:tsc",
        INCIDENT_TASK,
      ]);
    });

    it("admits lint and deterministic gen:*:check tasks — other tasks are never guessed at", () => {
      expect(isRerunnableGateEntry(INCIDENT_TASK)).toBe(true);
      expect(isRerunnableGateEntry("lint:tsc")).toBe(true);
      // A `test` task belongs to the FILE-based rescue (runTestsAtRef), not this one.
      expect(isRerunnableGateEntry("@papercusp/web :: test")).toBe(true);
      expect(
        isRerunnableGateEntry("@papercusp/web :: test:lane-stateful"),
      ).toBe(true);
      const GEN_CHECK_TASK =
        "@papercusp/operator-core :: gen:tool-catalog:check";
      expect(isRerunnableGateEntry(GEN_CHECK_TASK)).toBe(true);
      expect(nonTestGateIdsFrom([GEN_CHECK_TASK])).toEqual([GEN_CHECK_TASK]);
      // Only generated consistency checks are deterministic enough for this rescue; a
      // generation/write task must remain an unmeasured red rather than being guessed at.
      expect(
        isRerunnableGateEntry("@papercusp/operator-core :: gen:tool-catalog"),
      ).toBe(false);
      expect(
        isRerunnableGateEntry(
          "@papercusp/operator-core :: gen:tool-catalog:write",
        ),
      ).toBe(false);
      expect(isRerunnableGateEntry("@papercusp/web :: build")).toBe(false);
      expect(isRerunnableGateEntry("@papercusp/web")).toBe(false);
      expect(nonTestGateIdsFrom(["@papercusp/web :: test"])).toEqual([
        "@papercusp/web :: test",
      ]);
    });

    it("parses the task id shape, and rejects anything that is not one", () => {
      expect(parseFailingTaskId(INCIDENT_TASK)).toEqual({
        workspace: "@papercusp/operator-core",
        script: "lint:no-ungated-mug-kettle",
      });
      expect(parseFailingTaskId("lint:tsc")).toBeNull();
      expect(parseFailingTaskId("@papercusp/web")).toBeNull();
      expect(parseFailingTaskId("src/a.test.ts")).toBeNull();
    });

    it("resolves to a WORKSPACE-scoped npm invocation (a root-only run would not re-verify it)", () => {
      expect(resolveGateRuns([INCIDENT_TASK])).toEqual([
        {
          script: "lint:no-ungated-mug-kettle",
          workspace: "@papercusp/operator-core",
        },
      ]);
      // A registry id keeps running at the repo ROOT, exactly as before.
      expect(resolveGateRuns(["lint:tsc"])).toEqual([
        { script: "lint:tsc", workspace: null },
      ]);
      // A registry id fanning out to several scripts is unchanged.
      expect(resolveGateRuns(["lint:identity-leak"])).toEqual(
        NON_TEST_GATE_SCRIPTS["lint:identity-leak"].map((script) => ({
          script,
          workspace: null,
        })),
      );
    });

    it("against the REAL 1.5MB incident log (when still on disk), extracts the 1 failure and none of the 16 planned tasks", () => {
      // A hand-built fixture cannot prove this — the first cut of the fix passed every
      // fixture and still swept in 16 planned tasks from the genuine article. Skipped
      // rather than failed when the log has aged out, so this never becomes a flake.
      const log = join(
        process.env.HOME ?? "",
        ".papercusp/checkpoint-logs",
        "2026-08-10T18-34-37-011Z-base-9263da0694d2-cand-c758381fc674.log",
      );
      let raw: string;
      try {
        raw = readFileSync(log, "utf8");
      } catch {
        return; // log rotated away — the fixture tests above still cover the shape
      }
      const failing = extractFailingTests(raw);
      expect(failing.filter((f) => f.includes(" :: "))).toEqual([
        INCIDENT_TASK,
      ]);
      expect(nonTestGateIdsFrom(failing)).toEqual([INCIDENT_TASK]);
    });

    it("de-duplicates entries that resolve to the same invocation", () => {
      expect(resolveGateRuns([INCIDENT_TASK, INCIDENT_TASK])).toHaveLength(1);
      expect(resolveGateRuns(["lint:tsc", "lint:tsc"])).toEqual([
        { script: "lint:tsc", workspace: null },
      ]);
      // Same script name in two different workspaces is NOT a duplicate.
      expect(
        resolveGateRuns(["@papercusp/a :: lint:x", "@papercusp/b :: lint:x"]),
      ).toHaveLength(2);
    });
  });

  /**
   * WI-7290. The filed hypothesis was that the `📍 lineage` staleness check should TRIGGER a
   * refire. Tracing the control flow REFUTED it: the refire is already gated on strictly
   * stronger evidence — an actual re-run of the failing files at tip (`classifyRedAgainstTip`)
   * — and lineage only reports that a file was MODIFIED in the range, which is not a fix.
   * Triggering on the proxy would fire a ~55min suite in exactly the cases where the direct
   * measurement just said the break reproduces.
   *
   * The real defect the trace exposed: when the tip re-run does not run AT ALL, the record was
   * silent, so "never measured" was indistinguishable from "measured, genuinely red". These
   * assert the reason is always stated and always specific enough to act on.
   */
  describe("WI-7290: describeSkippedRetriage — an unmeasured red says so, in its own words (pure)", () => {
    const base = {
      candidate: "a".repeat(40),
      tip: "b".repeat(40),
      failingFiles: [] as { workspace: string; file: string }[],
      gateIds: [] as string[],
      failingTests: [] as string[],
      hasTestRunner: true,
      hasGateRunner: true,
    };

    it("names an unresolvable tip — nothing newer existed to re-test against", () => {
      const s = describeSkippedRetriage({ ...base, tip: null });
      expect(s).toContain("could not be resolved");
      expect(s).toContain("never checked for staleness");
    });

    it("names the candidate-IS-tip case as red-by-construction, not as an unmeasured gap", () => {
      const s = describeSkippedRetriage({ ...base, tip: base.candidate });
      expect(s).toContain("IS the tip");
      expect(s).toContain("nothing newer");
    });

    it("distinguishes an UNWIRED test runner from a genuinely un-runnable failure set", () => {
      const s = describeSkippedRetriage({
        ...base,
        failingFiles: [
          { workspace: "@papercusp/operator-core", file: "lib/a.test.ts" },
        ],
        hasTestRunner: false,
      });
      expect(s).toContain("no tip test-runner is wired");
      expect(s).toContain("NOT measured");
    });

    it("names the unwired GATE runner separately (the lint/typecheck sibling path)", () => {
      const s = describeSkippedRetriage({
        ...base,
        gateIds: ["lint:tsc"],
        hasGateRunner: false,
      });
      expect(s).toContain("no tip gate-runner is wired");
      expect(s).toContain("lint:tsc");
    });

    it("⭐ the residual case — failures existed but none was re-runnable — NAMES them and refuses to imply the red is real", () => {
      // This is the shape that produced WI-7290 itself: a cargo task and a workspace-level
      // failure, neither of which resolves to a {workspace,file} pair nor to a known gate id.
      const s = describeSkippedRetriage({
        ...base,
        failingTests: ["@papercusp/operator-core", "@papercusp/desktop"],
      });
      expect(s).toContain("@papercusp/desktop");
      expect(s).toContain(
        "no failing entry resolved to a {workspace,file} pair",
      );
      expect(s).toContain("may or may not still reproduce");
      // The load-bearing negative: it must never assert the red is current.
      expect(s).not.toMatch(/real red|genuinely broken|reproduces at tip/i);
    });

    it("is TOTAL — every skip path yields a non-empty sentence, never an empty string", () => {
      const variants = [
        { ...base, tip: null },
        { ...base, tip: base.candidate },
        {
          ...base,
          failingFiles: [{ workspace: "w", file: "f.test.ts" }],
          hasTestRunner: false,
        },
        { ...base, gateIds: ["lint:tsc"], hasGateRunner: false },
        { ...base },
        { ...base, failingTests: ["x"] },
      ];
      for (const v of variants) {
        const s = describeSkippedRetriage(v);
        expect(s.length).toBeGreaterThan(20);
        expect(s).toContain("SKIPPED");
      }
    });
  });

  describe("agent-state-plane standing probes are GATED (P-020)", () => {
    /* The predecessor plane shipped 8 defects past a green unit gate. This plan built four
     * probes for that class and every one was an ORPHANED npm script — a repo-wide grep
     * found zero references outside comments. These tests exist so that cannot recur
     * silently: the wiring itself is now asserted, including its own vacuous pass. */

    it("lint:plane-integrity is a recognised gate signature, so a plane red auto-refires like any other lint red", () => {
      expect(nonTestGateIdsFrom(["lint:plane-integrity"])).toEqual([
        "lint:plane-integrity",
      ]);
      expect(nonTestGateIdsFrom(["lint:tsc", "lint:plane-integrity"])).toEqual([
        "lint:tsc",
        "lint:plane-integrity",
      ]);
    });

    it("lint:vacuous-negatives is a recognised gate signature (WI-10004205), so it cannot veto a sibling's rescue", () => {
      expect(
        nonTestGateIdsFrom(["lint:tsc", "lint:vacuous-negatives"]),
      ).toEqual(["lint:tsc", "lint:vacuous-negatives"]);
    });
  });

  /* EI-19992136440423793 path (a), pure half. `rescueGateIdsFrom` subtracts what the FILE rescue
   * already re-runs and then applies nonTestGateIdsFrom's unchanged all-or-nothing rule to the
   * residual. Two things these pin, and they pull in opposite directions on purpose:
   *   - the MIXED red now yields its registered gate ids instead of `[]` (the defect);
   *   - an entry nothing can re-run at tip still vetoes (the safety property that made the
   *     all-or-nothing rule right in the first place).
   * A change that only satisfies the first is the half-fix this item's path (b) already showed is
   * not enough: there are TWO all-or-nothing gates, and relaxing one alone moves the veto rather
   * than removing it. */
  describe("rescueGateIdsFrom + fileRescueCovers (EI-19992136440423793 path (a), pure)", () => {
    const WEB_FILE = {
      file: "src/failing.test.ts",
      workspace: "@papercusp/web",
    };

    it("THE DEFECT: a mixed red yields its registered gate ids, where the old ternary yielded []", () => {
      // Old behaviour, preserved here as a control so the difference is visible rather than
      // asserted from memory: fed the whole mixed set, the all-or-nothing rule returns [].
      expect(
        nonTestGateIdsFrom(["@papercusp/web", "lint:identity-leak"]),
      ).toEqual([]);
      // New behaviour: the workspace is covered by the file rescue, so only the lint leg remains.
      expect(
        rescueGateIdsFrom(["@papercusp/web", "lint:identity-leak"], [WEB_FILE]),
      ).toEqual(["lint:identity-leak"]);
    });

    it("with NO failing files it is exactly nonTestGateIdsFrom — the gate-only path is unchanged", () => {
      // By construction (nothing is subtracted when failingFiles is empty), so this is a
      // characterisation of the identity rather than a sample of it.
      for (const failing of [
        ["lint:identity-leak"],
        ["lint:tsc", "lint:design-primitives"],
        ["@papercusp/web"],
        ["@papercusp/operator-vite"],
        ["lint:identity-leak", "@papercusp/web"],
        [],
      ]) {
        expect(rescueGateIdsFrom(failing, [])).toEqual(
          nonTestGateIdsFrom(failing),
        );
        expect(rescueGateIdsFrom(failing)).toEqual(nonTestGateIdsFrom(failing));
      }
      expect(rescueGateIdsFrom(undefined)).toEqual([]);
    });

    it("THE SAFETY PROPERTY: an entry neither file-covered nor re-runnable still vetoes the whole gate half", () => {
      // '@papercusp/operator-vite' is a build break — deliberately absent from the registry and
      // not a test file, so nothing measures it at tip. A rescue that ran anyway would call the
      // red stale on evidence it never collected.
      expect(
        rescueGateIdsFrom(
          ["@papercusp/web", "lint:identity-leak", "@papercusp/operator-vite"],
          [WEB_FILE],
        ),
      ).toEqual([]);
    });

    it("covers the three shapes the extractor emits for one test failure, and nothing else", () => {
      expect(fileRescueCovers("src/failing.test.ts", [WEB_FILE])).toBe(true); // the located file
      expect(fileRescueCovers("@papercusp/web", [WEB_FILE])).toBe(true); // its workspace
      expect(fileRescueCovers("@papercusp/web :: test", [WEB_FILE])).toBe(true); // its test task id
      // A LINT task in the same workspace is the GATE half's own work — covering it here would
      // subtract it from the very set it belongs to, silently dropping the rescue for it.
      expect(
        fileRescueCovers("@papercusp/web :: lint:identity-leak", [WEB_FILE]),
      ).toBe(false);
      // A different workspace, a registry id, and a build break are all uncovered.
      expect(fileRescueCovers("@papercusp/operator-core", [WEB_FILE])).toBe(
        false,
      );
      expect(fileRescueCovers("lint:tsc", [WEB_FILE])).toBe(false);
      expect(fileRescueCovers("@papercusp/operator-vite", [WEB_FILE])).toBe(
        false,
      );
      // Nothing is covered when there are no failing files — the subtraction is a no-op there.
      expect(fileRescueCovers("@papercusp/web", [])).toBe(false);
    });

    it("a workspace-scoped LINT task survives the subtraction and is still rescued beside a failing file", () => {
      // The EI-20092765275570648 shape: `<ws> :: lint:<name>` is self-describing and re-runnable
      // without a registry entry. It must not be mistaken for the file half's work just because
      // its workspace also has a failing test file.
      expect(
        rescueGateIdsFrom(
          ["@papercusp/web", "@papercusp/web :: lint:no-ungated-mug-kettle"],
          [WEB_FILE],
        ),
      ).toEqual(["@papercusp/web :: lint:no-ungated-mug-kettle"]);
    });
  });

  describe("inferFailingFilesFromEntries (EI-20336880192345624)", () => {
    it("pairs bare lib test/spec paths with the one accompanying workspace", () => {
      expect(
        inferFailingFilesFromEntries([
          "@papercusp/operator-core",
          "lib/backend-bin-resolve.test.ts",
          "lib/shared-pot-loop/fleet-monitors.spec.tsx",
        ]),
      ).toEqual([
        {
          workspace: "@papercusp/operator-core",
          file: "lib/backend-bin-resolve.test.ts",
        },
        {
          workspace: "@papercusp/operator-core",
          file: "lib/shared-pot-loop/fleet-monitors.spec.tsx",
        },
      ]);
    });

    it("rejects an ambiguous workspace signature instead of guessing", () => {
      expect(
        inferFailingFilesFromEntries([
          "@papercusp/operator-core",
          "@papercusp/web",
          "lib/backend-bin-resolve.test.ts",
        ]),
      ).toEqual([]);
    });

    it("does not treat non-file entries or the build sentinel as a test pair", () => {
      expect(
        inferFailingFilesFromEntries([
          "@papercusp/operator-vite",
          "lib/backend-bin-resolve.ts",
        ]),
      ).toEqual([]);
      expect(
        inferFailingFilesFromEntries([
          "@papercusp/operator-vite",
          "lib/backend-bin-resolve.test.ts",
        ]),
      ).toEqual([]);
      expect(
        inferFailingFilesFromEntries([
          "@papercusp/operator-core",
          "packages/operator-core/lib/backend-bin-resolve.test.ts",
        ]),
      ).toEqual([]);
    });

    it("preserves already parsed pairs unchanged", () => {
      const existing: FailingFile[] = [
        {
          workspace: "@papercusp/operator-core",
          file: "lib/already-parsed.test.ts",
        },
      ];
      expect(
        inferFailingFilesFromEntries(
          ["@papercusp/web", "lib/unlocated.test.ts"],
          existing,
        ),
      ).toEqual(existing);
    });
  });

  /* The rest of the P-020 group above: what the gated signatures RESOLVE to, and the two ways that
   * resolution can go quiet instead of redding the gate. Split out from the sibling describe only
   * so the pure path-(a) cases sit between them — the subject is unchanged. */
  describe("agent-state-plane gated scripts — registry contents and the vacuous-pass guard (P-020)", () => {
    it("maps to exactly the five plane probes — 4 lints plus the Phase 3 guard mutation tests", () => {
      expect(NON_TEST_GATE_SCRIPTS["lint:plane-integrity"]).toEqual([
        "lint:plane-producers",
        "lint:declared-consumed",
        "lint:no-bespoke-state-read",
        "lint:plane-ratchet",
        "lint:plane-guards",
      ]);
    });

    /* ⛔ THE FLEET-SAFETY ASSERTION. check-cell-live-matrix.ts's own header says "THIS MUST
     * NOT BE ADDED TO THE CI LINT JOB": it drives reads against RUNNING operators on :3170
     * and :3070, which the isolated checkpoint tree does not have. Adding it would fail every
     * read and red-pin `main` for the entire fleet. It is the natural fifth member of this
     * group, so the mistake is an easy one — pin it shut. */
    it("NEVER gates lint:cell-matrix — it needs running operators the checkpoint tree does not have", () => {
      for (const [signature, scripts] of Object.entries(
        NON_TEST_GATE_SCRIPTS,
      )) {
        expect(
          scripts,
          `${signature} must not gate the live cell matrix`,
        ).not.toContain("lint:cell-matrix");
      }
    });

    /* THE VACUOUS PASS this wiring can have: the leg resolves each script with checkNpmScript
     * and SKIPS an 'absent' one (the documented subject-hive opt-out). So if a script is
     * renamed or dropped, the leg keeps reporting green while silently checking nothing —
     * which is precisely the "goes quiet instead of redding the gate" failure P-020 exists to
     * stop, reintroduced one level up. Assert every gated script really exists at the root. */
    it("every gated script exists in the root package.json — a rename must break HERE, not go quiet", async () => {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      // Resolve from THIS file (apps/operator/lib/release/…), not process.cwd() — the router
      // runs each file from its owning workspace, but a root-level invocation must not make
      // this assertion silently read the wrong package.json.
      const repoRoot = join(
        fileURLToPath(new URL(".", import.meta.url)),
        "..",
        "..",
        "..",
        "..",
      );
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, "package.json"), "utf8"),
      ) as {
        scripts?: Record<string, string>;
      };
      const declared = pkg.scripts ?? {};
      for (const script of NON_TEST_GATE_SCRIPTS["lint:plane-integrity"]) {
        expect(
          declared[script],
          `root package.json must declare "${script}"`,
        ).toBeTruthy();
      }
    });
  });

  describe("historicalFlakeAnnotations (WI-2997, pure)", () => {
    it("renders a line per failing file that has historical stats, flagging known suspects", () => {
      const note = historicalFlakeAnnotations(
        {
          "src/a.test.ts": {
            fails: 12,
            passes: 3,
            bothStatusShas: 4,
            isSuspect: true,
          },
          "src/b.test.ts": {
            fails: 1,
            passes: 0,
            bothStatusShas: 0,
            isSuspect: false,
          },
        },
        ["src/a.test.ts", "src/b.test.ts"],
      );
      expect(note).toContain("7d historical flake stats");
      expect(note).toContain(
        "src/a.test.ts: 12 fail(s) / 3 pass(es) over 7d — ⚠️ known flake-suspect",
      );
      expect(note).toContain("src/b.test.ts: 1 fail(s) / 0 pass(es) over 7d");
      expect(note.split("src/b.test.ts")[1]).not.toContain(
        "known flake-suspect",
      );
    });

    it("omits files with no historical record — never invents a zero-stat line", () => {
      const note = historicalFlakeAnnotations(
        {
          "src/a.test.ts": {
            fails: 5,
            passes: 2,
            bothStatusShas: 2,
            isSuspect: true,
          },
        },
        ["src/a.test.ts", "src/never-seen-before.test.ts"],
      );
      expect(note).toContain("src/a.test.ts");
      expect(note).not.toContain("never-seen-before");
    });

    it("returns empty string when nothing in `files` has a historical record", () => {
      expect(historicalFlakeAnnotations({}, ["src/a.test.ts"])).toBe("");
    });
  });

  it("WI-2997: threads the historical-flake annotation into the not-green broadcast + escalate", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false, ["src/flaky.test.ts"]);
    deps.flakeLookup = async (files) => {
      expect(files).toEqual(["src/flaky.test.ts"]);
      return {
        "src/flaky.test.ts": {
          fails: 8,
          passes: 2,
          bothStatusShas: 3,
          isSuspect: true,
        },
      };
    };
    const broadcasts: string[] = [];
    const escalations: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      broadcasts.push(body ?? "");
    };
    deps.escalate = async (_s: string, body: string) => {
      escalations.push(body);
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    expect(
      broadcasts.some(
        (m) =>
          m.includes("7d historical flake stats") &&
          m.includes("src/flaky.test.ts"),
      ),
    ).toBe(true);
    expect(
      escalations.some(
        (m) =>
          m.includes("7d historical flake stats") &&
          m.includes("src/flaky.test.ts"),
      ),
    ).toBe(true);
  });

  it("WI-2997: no flakeLookup wired (existing stubs) → no annotation, no throw", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false, ["src/flaky.test.ts"]); // stubDeps never sets flakeLookup
    const broadcasts: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      broadcasts.push(body ?? "");
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    expect(broadcasts.some((m) => m.includes("historical flake"))).toBe(false);
  });

  it("WI-2997: a throwing flakeLookup is swallowed — the red path still completes, no annotation", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false, ["src/flaky.test.ts"]);
    deps.flakeLookup = async () => {
      throw new Error("pg unreachable");
    };
    const broadcasts: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      broadcasts.push(body ?? "");
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    expect(broadcasts.some((m) => m.includes("historical flake"))).toBe(false);
  });

  it("docs-audit #2: re-broadcasts a rising-urgency alert when the gate has been held >2h", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => {
      messages.push(s);
    };
    deps.heldGateMs = async () => 4 * 60 * 60 * 1000; // held 4h (the 2026-06-23 incident)
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    // The standard red broadcast PLUS a louder URGENT alert naming the held duration.
    expect(
      messages.some((m) => m.includes("URGENT") && m.includes("held 4h")),
    ).toBe(true);
  });

  it("EI-22752586902645795: re-broadcasts the held-gate alert when frozen repair verification is unavailable", async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "broken", "frozen candidate");
    const now = Date.now();
    let queue: FrozenCandidateRepairQueue | null = {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: frozen,
      base: ready,
      repairHead: frozen,
      attempts: 1,
      openedAtMs: now - 4 * 60 * 60 * 1000,
      updatedAtMs: now - 1_000,
      fixerSpawnId: null,
      failingTests: ["lint:identity-leak"],
      signature: [],
    };
    const { deps, calls } = stubDeps(false);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    const targetedRuns: string[] = [];
    deps.runGateAtRef = async (_ref, gateIds) => {
      targetedRuns.push(...gateIds);
      throw new Error("dependency-prewarm-missing (exit 74)");
    };
    deps.heldGateMs = async () => 4 * 60 * 60 * 1000;
    const broadcasts: Array<{ summary: string; body?: string }> = [];
    deps.broadcast = async (summary, body) => {
      broadcasts.push({ summary, body });
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(targetedRuns).toEqual(["lint:identity-leak"]);
    expect(result).toMatchObject({
      green: null,
      reason: "repair-in-progress",
      repairQueue: { phase: "ready-to-verify", candidate: frozen },
    });
    expect(calls).not.toContain("runGreen");
    expect(
      broadcasts.some(
        ({ summary }) => summary.includes("URGENT") && summary.includes("held 4h"),
      ),
    ).toBe(true);
    expect(
      broadcasts.find(({ summary }) => summary.includes("URGENT"))?.body,
    ).toContain("dependency-prewarm-missing");
  });

  it("docs-audit #2: no louder alert within the first 2h (fresh hold ⇒ heldGateMs null/small)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false);
    const messages: string[] = [];
    deps.broadcast = async (s: string) => {
      messages.push(s);
    };
    deps.heldGateMs = async () => null; // first red — escalation just opened, no age yet
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(messages.some((m) => /HELD|URGENT|CRITICAL/.test(m))).toBe(false);
  });

  it("is a no-op when ready already at integration HEAD", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const { deps, calls } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("up-to-date");
    expect(calls).toEqual([]); // didn't even build the tree
  });

  it("refuses a non-fast-forward candidate", async () => {
    const c1 = await commit("a", "1", "c1");
    const cFeat = await commit("a", "feat", "feat");
    await git(repo, ["branch", "ready", cFeat]); // ready ahead on a feature line
    await git(repo, ["reset", "--hard", c1]);
    const cDiv = await commit("b", "div", "div"); // main diverged
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, {
      candidate: cDiv,
      noPush: true,
    });
    expect(r.reason).toBe("not-fast-forward");
    expect(await revParse(repo, "ready")).toBe(cFeat); // unchanged
  });

  it("P-012: threads the failure signature (failingTests) into the not-green result", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(false, [
      "@papercusp/operator-core",
      "lib/fleet/operator-spawn.test.ts",
    ]);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    // the signature flows out so the release-fixer can dedup by FAILURE, not candidate sha
    expect(r.failingTests).toEqual([
      "@papercusp/operator-core",
      "lib/fleet/operator-spawn.test.ts",
    ]);
  });

  // load-flake-isolation-2026-06-23: when runGreen reports green=true with flakeSuspects
  // (the suite went red under load but every file passed in isolation), the gate ADVANCES
  // and surfaces the absorbed files in the green broadcast — the whole fleet's gate isn't
  // held by box-weather, but the flake is on record (drives the P-009 quarantine nudge).
  it("load-flake: a flake-absorbed green advances and surfaces flakeSuspects", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const suspects = [
      "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
    ];
    const { deps, calls } = stubDeps(true, undefined, suspects);
    const bodies: string[] = [];
    deps.broadcast = async (_s: string, body?: string) => {
      calls.push("broadcast");
      if (body) bodies.push(body);
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(r.flakeSuspects).toEqual(suspects);
    expect(await revParse(repo, "ready")).toBe(c2); // advanced despite the initial (absorbed) red
    expect(calls).toContain("advance");
    // the green broadcast names the absorbed flake so the advance is auditable
    expect(
      bodies.some(
        (b) =>
          b.includes("Load-flake absorbed") &&
          b.includes("runner-aggregate.test.ts"),
      ),
    ).toBe(true);
  });

  // P-013 (gate-file-level-test-reuse-2026-09-27): the suite round's per-file reuse record
  // must survive from runGreen onto the verdict the recorder stores, green or red.
  describe("testPassReuse rides the verdict from runGreen [P-013]", () => {
    const reuse = {
      judgedSha: "c58655490ce1a3be734de61df08aa7f8159122d4",
      recordedAtMs: 1_790_530_000_000,
      invocations: 1,
      candidates: 10,
      reused: 7,
      minSavedTestMs: 30_000,
      unmeasured: 0,
      alarms: [],
      offReasons: [],
      recorder: null,
      headline: "per-file reuse: 7 of 10 candidate file(s) reused",
    };

    it("carries it onto an ADVANCE verdict", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps, calls } = stubDeps(true);
      deps.runGreen = async () => {
        calls.push("runGreen");
        return { green: true, summary: "all pass", testPassReuse: reuse };
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({ advanced: true, green: true });
      expect(r.testPassReuse).toEqual(reuse);
      // The round's phase breakdown is built once, against the whole pass: the candidate suite
      // is stamped, the parts add up to the total, and the internal carrier never leaks out.
      expect(r.roundPhases?.phases.map((p) => p.phase)).toContain("candidate-suite");
      expect(r.roundPhases?.phases.reduce((sum, p) => sum + p.ms, 0)).toBe(r.roundPhases?.totalMs);
      expect("roundPhaseStamps" in r).toBe(false);
    });

    it("carries it onto a RED verdict", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps, calls } = stubDeps(false, ["lib/x.test.ts"]);
      deps.runGreen = async () => {
        calls.push("runGreen");
        return {
          green: false,
          summary: "1 failing",
          failingTests: ["lib/x.test.ts"],
          testPassReuse: reuse,
        };
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r.green).toBe(false);
      expect(r.testPassReuse).toEqual(reuse);
      expect(r.roundPhases?.phases.map((p) => p.phase)).toContain("candidate-suite");
      expect("roundPhaseStamps" in r).toBe(false);
    });

    // A held green ran the suite too. Without the record here gate_health would keep the
    // PREVIOUS round's numbers and present them as this round's.
    it("carries it onto a HELD green verdict", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps, calls } = stubDeps(true);
      deps.runGreen = async () => {
        calls.push("runGreen");
        return { green: true, summary: "all pass", testPassReuse: reuse };
      };
      deps.perfGate = async () => ({ action: "block", summary: "perf BLOCK" });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({ green: true, advanced: false, reason: "perf-held" });
      expect(r.testPassReuse).toEqual(reuse);
      expect(r.roundPhases?.phases.map((p) => p.phase)).toContain("candidate-suite");
      expect("roundPhaseStamps" in r).toBe(false);
    });

    it("leaves it ABSENT when the round reported nothing — never a zero", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps } = stubDeps(true);
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r.green).toBe(true);
      expect("testPassReuse" in r).toBe(false);
    });
  });

  // EI-18685042025868279: a green verdict could not distinguish a clean pass from a
  // retry-absorbed one — `failingTests: []` rendered identically either way, so a live
  // flake (or a live intermittent bug) was invisible to anything reading the verdict.
  describe("cleanGreen — a retry-absorbed green is never reported as an unqualified pass [EI-18685042025868279]", () => {
    const retried = [
      {
        name: "@papercusp/operator-core::lib/flaky.test.ts",
        attempts: 3,
        outcome: "passed-on-rerun" as const,
        via: "load-flake-isolation" as const,
      },
    ];

    it("carries cleanGreen:false + retriedTests onto the ADVANCE verdict, and qualifies the headline", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("a", "2", "c2");
      const { deps, calls } = stubDeps(true);
      deps.runGreen = async () => {
        calls.push("runGreen");
        return {
          green: true,
          summary: "all pass",
          retriedTests: retried,
          cleanGreen: false,
        };
      };
      const heads: string[] = [];
      const bodies: string[] = [];
      deps.broadcast = async (s: string, body?: string) => {
        calls.push("broadcast");
        heads.push(s);
        if (body) bodies.push(body);
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({
        advanced: true,
        green: true,
        reason: "advanced",
        cleanGreen: false,
      });
      expect(r.retriedTests).toEqual(retried);
      expect(await revParse(repo, "ready")).toBe(c2);
      // THE POINT: the HEADLINE is what most readers act on, so the qualification cannot
      // live only in the body.
      expect(
        heads.some(
          (h) =>
            h.includes("passed on retry") && h.includes("NOT a clean green"),
        ),
      ).toBe(true);
      expect(
        bodies.some(
          (b) =>
            b.includes("NOT a clean green") &&
            b.includes("flaky.test.ts") &&
            b.includes("3 attempts"),
        ),
      ).toBe(true);
    });

    it("a genuinely clean green reports cleanGreen:true and adds NO retry qualification", async () => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps, calls } = stubDeps(true);
      deps.runGreen = async () => {
        calls.push("runGreen");
        return { green: true, summary: "all pass", cleanGreen: true };
      };
      const heads: string[] = [];
      deps.broadcast = async (s: string) => {
        calls.push("broadcast");
        heads.push(s);
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({
        advanced: true,
        green: true,
        cleanGreen: true,
      });
      expect(r.retriedTests).toBeUndefined();
      expect(heads.some((h) => h.includes("passed on retry"))).toBe(false);
    });

    it("a dep that does NOT report cleanGreen leaves it ABSENT — unknown is not coerced to false", async () => {
      // Every pre-existing stub and older dep is in this state. Coercing absent→false
      // would flip the meaning of every consumer at once and manufacture a "not clean"
      // claim from no evidence at all.
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      await commit("a", "2", "c2");
      const { deps } = stubDeps(true);
      const heads: string[] = [];
      deps.broadcast = async (s: string) => {
        heads.push(s);
      };
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({ advanced: true, green: true });
      expect(r.cleanGreen).toBeUndefined();
      expect(heads.some((h) => h.includes("passed on retry"))).toBe(false);
    });
  });

  // F2 (round-4 P-031): the perf-regression gate runs post-runGreen / pre-advance.
  it("F2: a perf BLOCK holds the green pin even when the candidate is green", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async (candidate) => {
      calls.push("perfGate");
      return {
        action: "block",
        summary: `perf BLOCK ${candidate.slice(0, 7)}`,
      };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: false,
      green: true,
      reason: "perf-held",
    });
    expect(await revParse(repo, "ready")).toBe(c1); // pin NOT advanced
    expect(calls).toContain("perfGate");
    expect(calls).not.toContain("advance"); // blocked before advance
    expect(calls).toContain("escalate"); // a perf block opens a durable escalation
  });

  it("F2: a perf WARN surfaces (broadcast) but still advances — default-warn", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.perfGate = async () => ({
      action: "warn",
      summary: "perf WARN — hot but advancing",
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(await revParse(repo, "ready")).toBe(c2); // advanced despite the warn
    expect(calls).toContain("advance");
  });

  it("F2: a perf PASS (and the no-gate default) advances normally — back-compat", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps } = stubDeps(true);
    deps.perfGate = async () => ({ action: "pass", summary: "perf ok" });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: "advanced" });
    expect(await revParse(repo, "ready")).toBe(c2);
  });

  // P-011 (desktop-performance-suite): the desktop-perf gate runs post-runGreen /
  // pre-advance, same call-site shape as perf/delta-gate.
  it("P-011: a desktop-perf BLOCK holds the green pin even when the candidate is green", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.desktopPerfGate = async (candidate) => {
      calls.push("desktopPerfGate");
      return {
        action: "block",
        summary: `desktop-perf BLOCK ${candidate.slice(0, 7)}`,
      };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: false,
      green: true,
      reason: "desktop-perf-held",
    });
    expect(await revParse(repo, "ready")).toBe(c1); // pin NOT advanced
    expect(calls).toContain("desktopPerfGate");
    expect(calls).not.toContain("advance");
    expect(calls).toContain("escalate");
  });

  it("P-011: a desktop-perf WARN surfaces (broadcast) but still advances — default-warn", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps } = stubDeps(true);
    deps.desktopPerfGate = async () => ({
      action: "warn",
      summary: "desktop-perf WARN — regressed but advancing",
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(await revParse(repo, "ready")).toBe(c2); // advanced despite the warn
  });

  // EI-11118 (cupboard-public-release P-009 durable fix): the Cupboard prod-hygiene
  // gate runs post-runGreen / pre-advance, same call-site shape as perf/delta-gate.
  it("EI-11118: a cupboard-hygiene BLOCK holds the green pin even when the candidate is green", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.cupboardHygieneGate = async (candidate) => {
      calls.push("cupboardHygieneGate");
      return {
        action: "block",
        summary: `cupboard-hygiene BLOCK ${candidate.slice(0, 7)}`,
      };
    };
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: false,
      green: true,
      reason: "cupboard-hygiene-held",
    });
    expect(await revParse(repo, "ready")).toBe(c1); // pin NOT advanced
    expect(calls).toContain("cupboardHygieneGate");
    expect(calls).not.toContain("advance"); // blocked before advance
    expect(calls).toContain("escalate"); // a cupboard-hygiene block opens a durable escalation
  });

  it("EI-11118: a cupboard-hygiene WARN surfaces (broadcast) but still advances — default-warn", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, calls } = stubDeps(true);
    deps.cupboardHygieneGate = async () => ({
      action: "warn",
      summary: "cupboard-hygiene WARN — junk found but advancing",
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      green: true,
      reason: "advanced",
    });
    expect(await revParse(repo, "ready")).toBe(c2); // advanced despite the warn
    expect(calls).toContain("advance");
  });

  it("EI-11118: a cupboard-hygiene PASS (and the no-gate default) advances normally — back-compat", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps } = stubDeps(true);
    deps.cupboardHygieneGate = async () => ({
      action: "pass",
      summary: "cupboard clean",
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, reason: "advanced" });
    expect(await revParse(repo, "ready")).toBe(c2);
  });
});

describe("extractFailingTests (P-012 failure signature)", () => {
  it("pulls vitest FAIL files and affected-runner workspace markers, sorted + unique", () => {
    const out = [
      "some passing noise",
      " FAIL  lib/fleet/operator-spawn.test.ts > mints NO session id",
      ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)",
      " FAIL  lib/fleet/operator-spawn.test.ts > another case", // dup file
      "1 non-quarantined task(s) failed.",
    ].join("\n");
    expect(extractFailingTests(out)).toEqual([
      "@papercusp/operator-core",
      "lib/fleet/operator-spawn.test.ts",
    ]);
  });

  it("returns [] when nothing failed", () => {
    expect(
      extractFailingTests("All affected tests passed.\nTests 1200 passed"),
    ).toEqual([]);
  });

  // Regression: the 2026-07-10 red carried `failingTests: []` because vitest colourizes
  // ` FAIL ` — the SGR prefix defeated the `^\s*FAIL` anchor. Fixture is the real byte
  // shape from /tmp checkpoint logs: `\x1b[41m FAIL \x1b[0m\x1b[31m file > case\x1b[0m`.
  it("sees FAIL lines through ANSI colour codes", () => {
    const out =
      "\x1b[41m\x1b[1m FAIL \x1b[0m\x1b[31m src/left-sidebar/MugTab.test.tsx > MugTab > renders Pause\x1b[0m";
    expect(extractFailingTests(out)).toEqual([
      "src/left-sidebar/MugTab.test.tsx",
    ]);
  });

  // vitest prints only the first few FAIL lines but one `❯ file (N tests | M failed)`
  // rollup per failing FILE — the rollup is what makes a 17-failure run fully nameable,
  // and naming it is what lets the stale-candidate re-triage re-run it at tip.
  it("pulls every failing file from the per-file rollup lines", () => {
    const out = [
      " ❯ src/components/left-sidebar/MugTab.test.tsx (9 tests | 8 failed) 4435ms",
      "     × renders Pause (topmost), directive, eligible hives + plans 188ms",
      " ❯ src/components/left-sidebar/MugTab.tree.test.tsx (9 tests | 9 failed) 8646ms",
      " ❯ src/components/left-sidebar/Healthy.test.tsx (4 tests) 12ms", // passing ⇒ ignored
    ].join("\n");
    expect(extractFailingTests(out)).toEqual([
      "src/components/left-sidebar/MugTab.test.tsx",
      "src/components/left-sidebar/MugTab.tree.test.tsx",
    ]);
  });

  it("uses the final canonical break set instead of stale initial-attempt FAIL rows", () => {
    const out = [
      " FAIL  lib/already-green.test.ts > failed before fresh-process absorption",
      'AFFECTED_TESTS_FAILING_FILES run=123-abcd coverage=unattributed fileCount=0 unattributedCount=1 truncated=false transformCulpritCount=0 files=[] unattributed=[{"task":"@papercusp/operator-core :: test:lane-stateful","reason":"batch-timeout"}] transformCulprits=[]',
    ].join("\n");
    expect(authoritativeAffectedFailureSignature(out)).toEqual([
      "@papercusp/operator-core",
      "@papercusp/operator-core :: test:lane-stateful",
    ]);
    expect(extractFailingTests(out)).toEqual([
      "@papercusp/operator-core",
      "@papercusp/operator-core :: test:lane-stateful",
    ]);
    expect(extractFailingTests(out)).not.toContain("lib/already-green.test.ts");
  });

  it("treats a valid empty canonical break set as authoritative, not as a legacy-parser miss", () => {
    const out = [
      " FAIL  lib/stale-initial-attempt.test.ts > later absorbed",
      "AFFECTED_TESTS_FAILING_FILES run=123-abcd coverage=none fileCount=0 unattributedCount=0 truncated=false transformCulpritCount=0 files=[] unattributed=[] transformCulprits=[]",
    ].join("\n");
    expect(authoritativeAffectedFailureSignature(out)).toEqual([]);
    expect(extractFailingTests(out)).toEqual([]);
  });
});

// EI-19340004308033958 recurrence guard: a `failingTests` entry can be a MANGLED
// suffix of a real path (e.g. `lib/y.test.ts`) that resolves to nothing in the
// judged candidate — worse than an absent field, because it looks authoritative.
describe("validateFailingTestPaths (EI-19340004308033958)", () => {
  it("drops a file-shaped entry that does not exist in the tree", () => {
    const exists = (p: string) => p.endsWith("real.test.ts");
    const result = validateFailingTestPaths(
      ["lib/real.test.ts", "lib/y.test.ts"],
      "/tree",
      exists,
    );
    expect(result.kept).toEqual(["lib/real.test.ts"]);
    expect(result.dropped).toEqual(["lib/y.test.ts"]);
  });

  it("passes through non-file entries (workspace names, gate ids) untouched, never validated", () => {
    const exists = vi.fn(() => false); // would drop everything if wrongly consulted
    const result = validateFailingTestPaths(
      ["@papercusp/operator-vite", "lint:tsc"],
      "/tree",
      exists,
    );
    expect(result.kept).toEqual(["@papercusp/operator-vite", "lint:tsc"]);
    expect(result.dropped).toEqual([]);
    expect(exists).not.toHaveBeenCalled();
  });

  it("keeps every entry when all resolve", () => {
    const result = validateFailingTestPaths(
      ["lib/a.test.ts", "lib/b.spec.tsx"],
      "/tree",
      () => true,
    );
    expect(result.kept).toEqual(["lib/a.test.ts", "lib/b.spec.tsx"]);
    expect(result.dropped).toEqual([]);
  });

  it("checks existence against treeDir-joined paths, not the bare entry", () => {
    let seen: string | null = null;
    validateFailingTestPaths(["lib/x.test.ts"], "/candidate-tree", (p) => {
      seen = p;
      return true;
    });
    expect(seen).toBe(join("/candidate-tree", "lib/x.test.ts"));
  });

  it("real filesystem end-to-end: a real temp file is kept, a mangled sibling is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-validate-"));
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "real.test.ts"), "// ok");
      const result = validateFailingTestPaths(
        ["lib/real.test.ts", "lib/y.test.ts"],
        dir,
      );
      expect(result.kept).toEqual(["lib/real.test.ts"]);
      expect(result.dropped).toEqual(["lib/y.test.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("extractFailingTestNames (human-facing case names)", () => {
  it("extracts case names from × lines and FAIL … > case lines, ignoring durations", () => {
    const out = [
      "\x1b[31m     × toggling a hive writes eligibleHives + the home hive 1047ms\x1b[0m",
      " FAIL  src/x.test.tsx > MugTab > summarizes current work flow",
    ].join("\n");
    expect(extractFailingTestNames(out)).toEqual([
      "MugTab > summarizes current work flow",
      "toggling a hive writes eligibleHives + the home hive",
    ]);
  });

  it("stays empty on a green run", () => {
    expect(extractFailingTestNames("Tests 1200 passed")).toEqual([]);
  });
});

describe("extractFailingCasesByFile / describeFailingCases (EI-18673560248447615)", () => {
  // The REAL shape from the 2026-07-26T02-26-57Z full-suite log, whose failing case
  // name was reachable only by opening that separate ~5000-line file.
  const realWorldOut = [
    "\x1b[31m ❯\x1b[39m app/_lints/design-primitives.test.ts \x1b[2m(\x1b[22m\x1b[2m28 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m1 failed\x1b[39m\x1b[2m)\x1b[22m\x1b[33m 1996\x1b[2mms\x1b[22m\x1b[39m",
    "     \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m blocks new native <select> controls in app UI \x1b[33m 513\x1b[2mms\x1b[22m\x1b[39m",
    "\x1b[31m     \x1b[31m×\x1b[31m keeps audited active surfaces free of direct cyan literals\x1b[39m\x1b[32m 173\x1b[2mms\x1b[22m\x1b[39m",
  ].join("\n");

  it("attributes the failing case to the file it failed in", () => {
    const byFile = extractFailingCasesByFile(realWorldOut);
    expect(byFile.get("app/_lints/design-primitives.test.ts")).toEqual([
      "keeps audited active surfaces free of direct cyan literals",
    ]);
  });

  it('does NOT let a nested describe row (no "(N tests | M failed)" suffix) re-key the file', () => {
    const out = [
      " ❯ lib/a.test.ts (5 tests | 2 failed) 100ms",
      "   ❯ someDescribe > nested group",
      "     × first broken case 10ms",
      "     × second broken case 12ms",
      " ❯ lib/b.test.ts (3 tests | 1 failed) 40ms",
      "     × b case 5ms",
    ].join("\n");
    const byFile = extractFailingCasesByFile(out);
    expect(byFile.get("lib/a.test.ts")).toEqual([
      "first broken case",
      "second broken case",
    ]);
    expect(byFile.get("lib/b.test.ts")).toEqual(["b case"]);
  });

  it("ignores case rows that appear before any file header", () => {
    expect(extractFailingCasesByFile("     × orphan case 3ms").size).toBe(0);
  });

  it("renders nothing when no cases were parsed, so the caller line still reads correctly", () => {
    expect(describeFailingCases(undefined)).toBe("");
    expect(describeFailingCases([])).toBe("");
  });

  it("quotes the case names and caps a pathological suite with a +N more", () => {
    const many = Array.from(
      { length: ISOLATION_MAX_NAMED_CASES + 4 },
      (_, i) => `case ${i}`,
    );
    const rendered = describeFailingCases(many);
    expect(rendered).toContain('"case 0"');
    expect(rendered).toContain(`(+4 more)`);
    expect(rendered.match(/"/g)!.length).toBe(ISOLATION_MAX_NAMED_CASES * 2);
  });
});

describe("classifyRedAgainstTip (stale-candidate re-triage)", () => {
  const base = {
    candidate: "aaaaaaaa1111",
    tip: "bbbbbbbb2222",
    failingTests: ["a.test.ts"],
    refireAttempts: 0,
    maxRefires: 2,
  };

  it("calls a red REAL when the failures reproduce at tip", () => {
    const v = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: false },
    });
    expect(v).toMatchObject({ classification: "real-red", autoRefire: false });
  });

  // EI-19324146335802876: the tip re-run is a GROUP run collapsed to one boolean, so a real-red
  // verdict cannot distinguish "all still fail" from "one still fails". The detail must not
  // claim the stronger reading — four agents re-triaged five files on 2026-08-02 when four of
  // them were already green at tip.
  it("a real-red detail states the group re-run is ALL-OR-NOTHING, not that every file still fails", () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ["a.test.ts", "b.test.ts", "c.test.ts"],
      tipRetest: { ran: true, pass: false },
    });
    expect(v.classification).toBe("real-red");
    expect(v.detail).toMatch(/did not ALL pass|not "they all still fail"/i);
    expect(v.detail).toContain("INDIVIDUALLY");
    expect(v.detail).toContain("3"); // the count is named so the reader knows the group size
  });

  // WI-7217 — the follow-up the EI-19324146335802876 fix left open. Better WORDING still made
  // every reader do the per-file re-run themselves (4 agents on candidate 1a9e8a1f, 1 more on
  // ab4babba). With a split available the verdict must ANSWER instead of assigning homework.
  it("a real-red detail NAMES which files still fail and which are already green, when the split ran", () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ["a.test.ts", "b.test.ts", "c.test.ts"],
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [
          { workspace: "@p/core", file: "a.test.ts", pass: true },
          { workspace: "@p/core", file: "b.test.ts", pass: false },
          { workspace: "@p/core", file: "c.test.ts", pass: true },
        ],
      },
    });
    expect(v.classification).toBe("real-red");
    expect(v.detail).toContain("STILL FAILING");
    expect(v.detail).toContain("b.test.ts");
    expect(v.detail).toMatch(/ALREADY GREEN AT TIP/);
    expect(v.detail).toContain("a.test.ts");
    expect(v.detail).toContain("c.test.ts");
    // The whole point: it must NOT tell the reader to go do the re-run it already did.
    expect(v.detail).not.toContain("INDIVIDUALLY");
  });

  // The safety invariant. `perFile` refines the PROSE only — if it could move the verdict, a
  // split that ran individually (and so cannot see cross-file pollution) would refire the gate
  // onto a genuinely broken tip.
  it("perFile never changes the classification — only the detail", () => {
    const withSplit = classifyRedAgainstTip({
      ...base,
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [{ workspace: "@p/core", file: "a.test.ts", pass: true }],
      },
    });
    const without = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: false },
    });
    expect(withSplit.classification).toBe(without.classification);
    expect(withSplit.autoRefire).toBe(false);
    expect(withSplit.detail).not.toBe(without.detail); // ...but it DID say something different
  });

  // Group failed, every file passes alone ⇒ the breakage is the INTERACTION. Saying "0 files
  // still fail" without naming that reads as "nothing is broken" and sends the next reader to
  // re-run them individually, reproducing nothing and looking like a flaky gate.
  it("calls out ORDER-DEPENDENCE when the group failed but every file passes alone", () => {
    const v = classifyRedAgainstTip({
      ...base,
      failingTests: ["a.test.ts", "b.test.ts"],
      tipRetest: {
        ran: true,
        pass: false,
        perFile: [
          { workspace: "@p/core", file: "a.test.ts", pass: true },
          { workspace: "@p/core", file: "b.test.ts", pass: true },
        ],
      },
    });
    expect(v.classification).toBe("real-red"); // still holds the gate
    expect(v.detail).toMatch(/ORDER-DEPENDENT|cross-file pollution/i);
    expect(v.detail).toMatch(/bisect/i);
    expect(v.detail).not.toContain("STILL FAILING");
  });

  it("describeRealRedAtTip falls back to the honest hedge with no split", () => {
    const observedAtMs = Date.parse("2026-08-02T22:11:19.000Z");
    const detail = describeRealRedAtTip(
      "bbbbbbbb2222",
      ["a.test.ts"],
      undefined,
      observedAtMs,
    );
    expect(detail).toContain("AS OF 2026-08-02T22:11:19.000Z");
    expect(detail).toContain("re-verify against current tip before acting");
    expect(detail).toContain("INDIVIDUALLY");
    expect(describeRealRedAtTip("bbbbbbbb2222", ["a.test.ts"], [])).toContain(
      "INDIVIDUALLY",
    );
  });

  it("emits the same tip observation time as machine-readable provenance", () => {
    const tipObservedAtMs = Date.parse("2026-08-02T22:11:19.000Z");
    const v = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: false },
      tipObservedAtMs,
    });
    expect(v.tipObservedAtMs).toBe(tipObservedAtMs);
    expect(v.detail).toContain(new Date(tipObservedAtMs).toISOString());
  });

  describe("splitTipFailuresPerFile (diagnostic per-file split — WI-7217)", () => {
    const files = [
      { workspace: "@p/core", file: "a.test.ts" },
      { workspace: "@p/core", file: "b.test.ts" },
    ];

    it("reports each file's solo verdict when every run is decidable", async () => {
      const out = await splitTipFailuresPerFile(
        files,
        async (_ws, f) => f === "a.test.ts",
      );
      expect(out).toEqual([
        { workspace: "@p/core", file: "a.test.ts", pass: true },
        { workspace: "@p/core", file: "b.test.ts", pass: false },
      ]);
    });

    // ALL-OR-NOTHING. A partial split reads as the whole answer — this is the same class of bug
    // the split exists to fix, just one level up.
    it("ABANDONS the split (undefined, never partial) when any single run is INDETERMINATE", async () => {
      const out = await splitTipFailuresPerFile(files, async (_ws, f) =>
        f === "a.test.ts" ? true : null,
      );
      expect(out).toBeUndefined();
    });

    it("abandons rather than naming a file that could not be run — the crashed run is not a failure", async () => {
      // Guards the specific wrong-direction failure: reporting an indeterminate run as pass:false
      // would list a HEALTHY file under "STILL FAILING (fix these)".
      const out = await splitTipFailuresPerFile(files, async () => null);
      expect(out).toBeUndefined();
      expect(out).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ pass: false })]),
      );
    });

    it("skips the split entirely above the file cap", async () => {
      const many = Array.from({ length: TIP_SPLIT_MAX_FILES + 1 }, (_, i) => ({
        workspace: "@p/core",
        file: `f${i}.test.ts`,
      }));
      const ran: string[] = [];
      const out = await splitTipFailuresPerFile(many, async (_ws, f) => {
        ran.push(f);
        return true;
      });
      expect(out).toBeUndefined();
      expect(ran).toEqual([]); // and costs nothing — not even one run
    });

    it("abandons when the wall-clock budget lapses mid-split", async () => {
      let t = 0;
      const out = await splitTipFailuresPerFile(files, async () => true, {
        now: () => (t += 1000),
        budgetMs: 1500, // deadline set at 1000+1500=2500; the 2nd file's check reads 3000
      });
      expect(out).toBeUndefined();
    });

    it("returns undefined for an empty file list", async () => {
      expect(
        await splitTipFailuresPerFile([], async () => true),
      ).toBeUndefined();
    });
  });

  it("calls a red STALE and auto-refires when the failing files pass at tip", () => {
    const v = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: true },
    });
    expect(v).toMatchObject({
      classification: "stale-candidate",
      autoRefire: true,
    });
    // EI-19343532231631821 changed what this refire COSTS, not whether it happens. With no
    // `priorFailing` there is no rescued set to have failed, so the refire is UNCHARGED and the
    // detail must not claim "attempt 1/2" — the charged budget is untouched. (This assertion
    // previously read `toContain('attempt 1/2')`, which asserted the old always-charge accounting.)
    expect(v.chargeRefire).toBe(false);
    expect(v.detail).toContain("UNCHARGED");
    expect(v.detail).toContain("0/2");
  });

  it("stops auto-refiring at the cap (a refire storm is worse than a held gate)", () => {
    const v = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: true },
      refireAttempts: 2,
    });
    expect(v).toMatchObject({
      classification: "stale-candidate",
      autoRefire: false,
    });
    expect(v.detail).toContain("refire cap reached");
  });

  it("never refires when the cap is 0 (opt-out)", () => {
    const v = classifyRedAgainstTip({
      ...base,
      tipRetest: { ran: true, pass: true },
      maxRefires: 0,
    });
    expect(v.autoRefire).toBe(false);
  });

  it("treats the red as real when the candidate IS the tip", () => {
    const v = classifyRedAgainstTip({
      ...base,
      tip: base.candidate,
      tipRetest: { ran: true, pass: true },
    });
    expect(v).toMatchObject({ classification: "real-red", autoRefire: false });
  });

  it("is UNKNOWN (never auto-refires) when failures cannot be named or re-run", () => {
    expect(
      classifyRedAgainstTip({ ...base, failingTests: [], tipRetest: null }),
    ).toMatchObject({
      classification: "unknown",
      autoRefire: false,
    });
    expect(
      classifyRedAgainstTip({
        ...base,
        tipRetest: { ran: false, pass: false },
      }),
    ).toMatchObject({
      classification: "unknown",
      autoRefire: false,
    });
  });
});

describe("autoRefireCapFromEnv", () => {
  it("defaults to 2, honours an explicit value, and treats 0 as disabled", () => {
    expect(autoRefireCapFromEnv({})).toBe(2);
    expect(autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: "5" })).toBe(
      5,
    );
    expect(autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: "0" })).toBe(
      0,
    );
    expect(
      autoRefireCapFromEnv({ PAPERCUSP_GATE_AUTO_REFIRE_CAP: "nonsense" }),
    ).toBe(2);
  });
});

/**
 * EI-19343532231631821 — the refire budget is charged for a FAILED rescue, not for a refire.
 *
 * The bug these guard: on the papercusp gate run of 2026-08-02 the auto-refire spent its whole
 * 2-attempt budget on tree churn. Each ~30-min-later cut rescued the previous red successfully and
 * imported a COMPLETELY DISJOINT new one, so the run ended red having never once failed to rescue
 * anything — then restarted ~55min later against an even later tip. Self-perpetuating.
 */
describe("refire charge accounting (EI-19343532231631821)", () => {
  const base = {
    candidate: "aaaaaaaa1111",
    tip: "bbbbbbbb2222",
    failingTests: ["a.test.ts"],
    tipRetest: { ran: true, pass: true } as const,
    refireAttempts: 0,
    maxRefires: 2,
  };

  describe("normaliseFailingKey / refireOverlap — the FAIL-OPEN hazard", () => {
    // THE dangerous direction, and the reason normalisation is a function rather than an inline
    // compare. The rescued set survives as bare workspace-relative strings (the marker persists
    // `failingFiles.map(f => f.file)`) while the current pass carries `{workspace, file}` objects.
    // Compare those two shapes naively and NOTHING ever matches ⇒ nothing is ever charged ⇒ the
    // charged budget silently ceases to exist and the gate can refire until it is killed.
    it("matches a marker-shaped string against a FailingFile for the SAME file", () => {
      const rescued = [
        "lib/harness/hygiene.test.ts",
        "src/components/adv/TasksRosterPanel.test.tsx",
      ];
      const current: FailingFile[] = [
        {
          workspace: "@papercusp/operator-core",
          file: "lib/harness/hygiene.test.ts",
        },
        {
          workspace: "operator",
          file: "src/components/adv/SomethingElse.test.tsx",
        },
      ];
      // The naive compare this guards against — object vs string — finds nothing:
      expect(
        current.filter((f) => rescued.includes(f as unknown as string)),
      ).toEqual([]);
      // The normalised compare finds the real overlap:
      expect(refireOverlap(rescued, current)).toEqual([
        "lib/harness/hygiene.test.ts",
      ]);
    });

    it("normalises ./ and duplicate separators so cosmetic path drift cannot fake a disjoint set", () => {
      expect(normaliseFailingKey("./lib//foo.test.ts")).toBe("lib/foo.test.ts");
      expect(
        normaliseFailingKey({ workspace: "ws", file: "  lib/foo.test.ts  " }),
      ).toBe("lib/foo.test.ts");
      expect(
        refireOverlap(
          ["lib/foo.test.ts"],
          [{ workspace: "ws", file: "./lib/foo.test.ts" }],
        ),
      ).toEqual(["lib/foo.test.ts"]);
    });

    it("drops the workspace deliberately — a same-named file in another workspace over-charges (fails CLOSED)", () => {
      // The cost of a key the marker can also produce. Over-charging degrades to today's
      // always-charge behaviour; under-charging would remove the loop guard entirely.
      const overlap = refireOverlap(
        [{ workspace: "pkg-a", file: "lib/index.test.ts" }],
        [{ workspace: "pkg-b", file: "lib/index.test.ts" }],
      );
      expect(overlap).toEqual(["lib/index.test.ts"]);
    });

    it("non-test gate ids compare intact and never collide with a path", () => {
      expect(refireOverlap(["lint:tsc"], ["lint:tsc"])).toEqual(["lint:tsc"]);
      expect(refireOverlap(["lint:tsc"], ["lint:migrations"])).toEqual([]);
    });

    it("an empty set on either side overlaps with nothing (the first refire of a run)", () => {
      expect(
        refireOverlap([], [{ workspace: "ws", file: "a.test.ts" }]),
      ).toEqual([]);
      expect(refireOverlap(undefined, undefined)).toEqual([]);
    });
  });

  describe("the charge decision", () => {
    it("does NOT charge a refire whose failures are DISJOINT from the rescued set", () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: [
          "lib/hyperbee/boot.test.ts",
          "src/TasksRosterPanel.test.tsx",
        ],
        currentFailing: [
          {
            workspace: "operator",
            file: "lib/release/release-actions.test.ts",
          },
          {
            workspace: "@papercusp/operator-core",
            file: "lib/harness/hygiene.test.ts",
          },
        ],
        totalRefires: 1,
      });
      expect(v).toMatchObject({
        classification: "stale-candidate",
        autoRefire: true,
        chargeRefire: false,
      });
      expect(v.detail).toContain("UNCHARGED");
      expect(v.detail).toMatch(/rescue SUCCEEDED/i);
    });

    it("DOES charge when the same breakage survives the re-cut (the loop guard that must survive)", () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ["lib/harness/hygiene.test.ts"],
        currentFailing: [
          {
            workspace: "@papercusp/operator-core",
            file: "lib/harness/hygiene.test.ts",
          },
        ],
      });
      expect(v).toMatchObject({ autoRefire: true, chargeRefire: true });
      expect(v.detail).toContain("CHARGED attempt 1/2");
      expect(v.detail).toContain("lib/harness/hygiene.test.ts");
    });

    it("charges on PARTIAL overlap — one surviving file is a failed rescue", () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ["a.test.ts", "b.test.ts"],
        currentFailing: [
          { workspace: "ws", file: "b.test.ts" },
          { workspace: "ws", file: "c.test.ts" },
        ],
      });
      expect(v.chargeRefire).toBe(true);
    });

    it("charges an OSCILLATION — {A}→{B}→{A} is no progress, and only the accumulated union sees it", () => {
      // Against the PREVIOUS pass alone ({B}) the returning {A} looks disjoint and would run free.
      const priorUnion = mergeFailingKeys(
        ["a.test.ts"],
        [{ workspace: "ws", file: "b.test.ts" }],
      );
      expect(priorUnion).toEqual(["a.test.ts", "b.test.ts"]);
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: priorUnion,
        currentFailing: [{ workspace: "ws", file: "a.test.ts" }],
      });
      expect(v.chargeRefire).toBe(true);
    });

    it("the run's FIRST refire is never charged — no rescue has been attempted, so none can have failed", () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: [],
        currentFailing: [{ workspace: "ws", file: "a.test.ts" }],
      });
      expect(v).toMatchObject({ autoRefire: true, chargeRefire: false });
    });
  });

  describe("the two required safety bounds", () => {
    it("stops at the ABSOLUTE ceiling even when nothing was ever charged", () => {
      // The failure mode uncharged refires create: a tree where SOMETHING is always freshly red
      // produces an unbroken chain of successful rescues and would otherwise refire forever.
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ["old.test.ts"],
        currentFailing: [{ workspace: "ws", file: "new.test.ts" }],
        totalRefires: 6,
        absoluteCeiling: 6,
      });
      expect(v).toMatchObject({
        autoRefire: false,
        refireBlockedBy: "absolute-ceiling",
      });
      // The operator action differs from a charged-budget stop — say so, don't send them to the files.
      expect(v.detail).toMatch(/never simultaneously green/i);
      expect(v.detail).toContain("NOT to debug the files");
    });

    it("stops at the DEADLINE rather than being killed mid-suite with no verdict at all", () => {
      const v = classifyRedAgainstTip({
        ...base,
        priorFailing: ["old.test.ts"],
        currentFailing: [{ workspace: "ws", file: "new.test.ts" }],
        deadlineExceeded: true,
      });
      expect(v).toMatchObject({
        autoRefire: false,
        refireBlockedBy: "deadline",
      });
      expect(v.detail).toMatch(/no verdict recorded/i);
    });

    it('the charged budget still stops a genuinely-broken tip, regardless of this pass"s charge', () => {
      const v = classifyRedAgainstTip({
        ...base,
        refireAttempts: 2,
        priorFailing: ["old.test.ts"],
        currentFailing: [{ workspace: "ws", file: "brand-new.test.ts" }],
      });
      expect(v).toMatchObject({
        autoRefire: false,
        refireBlockedBy: "charged-budget",
      });
      expect(v.detail).toContain("refire cap reached");
    });

    it("reports cap-disabled distinctly from a spent budget", () => {
      const v = classifyRedAgainstTip({ ...base, maxRefires: 0 });
      expect(v).toMatchObject({
        autoRefire: false,
        refireBlockedBy: "cap-disabled",
      });
    });

    it("refireAbsoluteCeiling is a multiple of the charged cap, and 0 when refire is disabled", () => {
      expect(refireAbsoluteCeiling(2)).toBe(6);
      expect(refireAbsoluteCeiling(0)).toBe(0);
      expect(refireAbsoluteCeiling(Number.NaN)).toBe(0);
    });

    it("refireDeadlineExceeded predicts the NEXT pass from the last one, and never blocks unmeasured", () => {
      const budgetMs = 110 * 60_000;
      expect(
        refireDeadlineExceeded({
          elapsedMs: 60 * 60_000,
          lastPassMs: 20 * 60_000,
          budgetMs,
        }),
      ).toBe(false);
      expect(
        refireDeadlineExceeded({
          elapsedMs: 60 * 60_000,
          lastPassMs: 55 * 60_000,
          budgetMs,
        }),
      ).toBe(true);
      // Unmeasured ⇒ fail OPEN on time alone; refireAbsoluteCeiling is what still bounds the run.
      expect(
        refireDeadlineExceeded({
          elapsedMs: Number.NaN,
          lastPassMs: 1,
          budgetMs,
        }),
      ).toBe(false);
    });

    it("the run budget stays strictly under the suite timeout that would kill a mid-flight refire", () => {
      expect(refireRunBudgetMsFromEnv({})).toBe(DEFAULT_REFIRE_RUN_BUDGET_MS);
      expect(
        refireRunBudgetMsFromEnv({
          PAPERCUSP_GATE_REFIRE_RUN_BUDGET_MS: "900000",
        }),
      ).toBe(900_000);
      expect(
        refireRunBudgetMsFromEnv({
          PAPERCUSP_GATE_REFIRE_RUN_BUDGET_MS: "nonsense",
        }),
      ).toBe(DEFAULT_REFIRE_RUN_BUDGET_MS);
    });
  });

  describe("nextRefireOpts — the recursion state", () => {
    it("advances the charged counter ONLY on a charged refire, while totalRefires always climbs", () => {
      const uncharged = nextRefireOpts(
        { refireAttempts: 0, totalRefires: 0, priorFailing: ["a.test.ts"] },
        { chargeRefire: false },
        [{ workspace: "ws", file: "b.test.ts" }],
        1_000,
      );
      expect(uncharged).toMatchObject({
        refireAttempts: 0,
        totalRefires: 1,
        runStartedAtMs: 1_000,
      });
      expect(uncharged.priorFailing).toEqual(["a.test.ts", "b.test.ts"]);

      const charged = nextRefireOpts(
        { refireAttempts: 0, totalRefires: 1, priorFailing: ["a.test.ts"] },
        { chargeRefire: true },
        [{ workspace: "ws", file: "a.test.ts" }],
        1_000,
      );
      expect(charged).toMatchObject({ refireAttempts: 1, totalRefires: 2 });
    });

    it("replays the 2026-08-02 run: three passes that would have exhausted the budget now spend NONE", () => {
      // pass 1 {hyperbee, TasksRoster, SessionsRoster} → refire 1 {release-actions, hygiene} → refire 2.
      // Under the old unconditional increment this reached refireAttempts=2 and the final red STUCK.
      let opts: Parameters<typeof nextRefireOpts>[0] = {};
      const pass1 = [
        { workspace: "ws", file: "lib/hyperbee/boot.test.ts" },
        { workspace: "operator", file: "src/TasksRosterPanel.test.tsx" },
        { workspace: "operator", file: "src/SessionsRosterView.test.tsx" },
      ];
      const pass2 = [
        { workspace: "operator", file: "lib/release/release-actions.test.ts" },
        { workspace: "core", file: "lib/harness/hygiene.test.ts" },
      ];
      for (const failing of [pass1, pass2]) {
        const v = classifyRedAgainstTip({
          ...base,
          refireAttempts: opts.refireAttempts ?? 0,
          ...refireBudgetInputs(opts, failing, 0, 0, () => 0),
        });
        expect(v.autoRefire).toBe(true);
        expect(v.chargeRefire).toBe(false); // every rescue SUCCEEDED — nothing to charge
        opts = nextRefireOpts(opts, v, failing, 0);
      }
      expect(opts.refireAttempts).toBe(0); // the whole charged budget is still available
      expect(opts.totalRefires).toBe(2);
    });
  });
});

describe("summarizeSuiteOutput leads with the failure, not the tail", () => {
  // The 2026-07-10 verdict's `summary` was 2000 chars of a testing-library DOM dump:
  // the TAIL of a red run is whatever the last assertion happened to print, which is
  // uncorrelated with what broke. Lead with the digest; keep the tail underneath.
  it("surfaces FAIL/rollup lines even when a huge DOM dump trails them", () => {
    const domDump = Array.from(
      { length: 400 },
      (_, i) => `        <div class="pc-qh__dot" data-i="${i}" />`,
    ).join("\n");
    const out = [
      "\x1b[41m FAIL \x1b[0m src/left-sidebar/MugTab.test.tsx > MugTab > renders Pause",
      " ❯ src/left-sidebar/MugTab.test.tsx (9 tests | 8 failed) 4435ms",
      "     × renders Pause 188ms",
      "TestingLibraryElementError: Unable to find an element with the text: Eligible pot",
      domDump,
      " Test Files  2 failed | 40 passed (42)",
    ].join("\n");

    const summary = summarizeSuiteOutput(out);
    expect(summary).toContain("MugTab.test.tsx");
    expect(summary).toContain("8 failed");
    expect(summary).toContain("× renders Pause");
    expect(summary).toContain("Test Files  2 failed");
    expect(summary).not.toContain("\x1b["); // ANSI stripped
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it("falls back to the tail when there are no failure markers (e.g. a build break)", () => {
    const out = [
      "npm error boilerplate",
      "noise",
      "ELIFECYCLE: vite build failed",
    ].join("\n");
    const summary = summarizeSuiteOutput(out);
    expect(summary).toContain("ELIFECYCLE");
    expect(summary).not.toContain("npm error");
  });
});

describe("stripAnsi", () => {
  it("removes SGR codes and leaves the text", () => {
    expect(stripAnsi("\x1b[41m\x1b[1m FAIL \x1b[0m\x1b[31m x\x1b[0m")).toBe(
      " FAIL  x",
    );
  });
});

describe("evaluateDeployStaleness (silent-drought alarm)", () => {
  const th = { maxPinAgeMs: 6 * 3_600_000, maxCommitsBehind: 20 };

  it("stays quiet when only ONE threshold is crossed", () => {
    expect(
      evaluateDeployStaleness(
        { pinAgeMs: 12 * 3_600_000, commitsBehind: 3 },
        th,
      ).alarm,
    ).toBe(false);
    expect(
      evaluateDeployStaleness(
        { pinAgeMs: 1 * 3_600_000, commitsBehind: 300 },
        th,
      ).alarm,
    ).toBe(false);
  });

  it("fires with the blocking red attached when both cross", () => {
    const v = evaluateDeployStaleness(
      {
        pinAgeMs: 8 * 3_600_000,
        commitsBehind: 40,
        blockingFailures: ["src/x.test.tsx"],
      },
      th,
    );
    expect(v).toMatchObject({ alarm: true, urgency: "warn" });
    expect(v.message).toContain("8.0h old");
    expect(v.message).toContain("40 commits behind");
    expect(v.message).toContain("src/x.test.tsx");
  });

  it("escalates to urgent past double the age threshold, and says so when nothing is red", () => {
    const v = evaluateDeployStaleness(
      { pinAgeMs: 18 * 3_600_000, commitsBehind: 40 },
      th,
    );
    expect(v).toMatchObject({ alarm: true, urgency: "urgent" });
    expect(v.message).toContain("may be wedged rather than red");
  });
});

// HE-02 gap #10 (hive-run-evaluation-2026-06-13, D-017): the realCheckpointDeps
// "real path" — the inline env-strip + output processing in runGreen — twice held
// `main` red for hours via leaked host env (2026-06-06/07). The orchestration is
// already tested above with stub deps; these cover the pure pieces of the heavy
// path that don't need a real suite-run.
describe("buildGreenCheckpointEnv (the gate measures COMMITTED defaults)", () => {
  it("prevents optional Git index writes in repair tasks and preserves an explicit caller policy", () => {
    expect(buildGreenCheckpointEnv(null, {}).GIT_OPTIONAL_LOCKS).toBe("0");
    expect(buildGreenCheckpointEnv(null, { GIT_OPTIONAL_LOCKS: "" }).GIT_OPTIONAL_LOCKS).toBe("0");
    expect(buildGreenCheckpointEnv(null, { GIT_OPTIONAL_LOCKS: "1" }).GIT_OPTIONAL_LOCKS).toBe("1");
  });

  it("admits only canonical execution substrate and explicit gate-owned values", () => {
    const src = {
      PATH: "/usr/bin",
      HOME: "/home/t",
      USER: "gate-user",
      LANG: "C.UTF-8",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      PAPERCUSP_FLAG_DEMO: "1", // the 2026-06-06 leaked-flag class
      PAPERCUSP_OPERATOR_URL: "http://host", // the 2026-06-07 non-flag class
      SPAWN_SU_BEARER: "tok", // operator credential, never a test input
      AGENT_MODELS: '{"worker":"opus"}', // the 2026-06-09 invoke.test class
      HARNESS_SLUG: "papercusp", // WI-6583: a non-PAPERCUSP_-prefixed attribution fallback
      INVOCATION_ID: "systemd-run-a",
      JOURNAL_STREAM: "8:123",
      SYSTEMD_EXEC_PID: "123",
      DBOS__VMID: "bg-host-a",
      DATABASE_URL: "postgres://operator-only",
    };
    const env = buildGreenCheckpointEnv("base123", src);
    expect(env.PAPERCUSP_FLAG_DEMO).toBeUndefined();
    expect(env.PAPERCUSP_OPERATOR_URL).toBeUndefined();
    expect(env.AGENT_MODELS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/t");
    expect(env.USER).toBe("gate-user");
    expect(env.LANG).toBe("C.UTF-8");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    expect(env.SPAWN_SU_BEARER).toBeUndefined();
    expect(env.INVOCATION_ID).toBeUndefined();
    expect(env.JOURNAL_STREAM).toBeUndefined();
    expect(env.SYSTEMD_EXEC_PID).toBeUndefined();
    expect(env.DBOS__VMID).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    // pure — never mutates the caller's env object
    expect(src.PAPERCUSP_FLAG_DEMO).toBe("1");
    expect(src.INVOCATION_ID).toBe("systemd-run-a");
  });

  // WI-6554700010008606: bash sources ~/.bashrc for a non-interactive `-c` shell whose
  // stdin is a socket (Node's spawnSync pipes are socketpairs) when its shell level is
  // below 2. With no SHLVL in the suite env, every test `bash -c` in the gate ran the
  // HOST's rc, which re-exported NODE_OPTIONS over the test's own value: the desktop leg
  // went red in the gate (2 of 2 runs) and passed in every interactive shell.
  it("pins SHLVL so a test's `bash -c` never sources the host ~/.bashrc", () => {
    const home = mkdtempSync(join(tmpdir(), "gate-shlvl-home-"));
    try {
      writeFileSync(join(home, ".bashrc"), "export NODE_OPTIONS=HIJACKED_BY_BASHRC\n");
      const override = "--require=/test/override.cjs";
      const probe = (env: Record<string, string | undefined>) =>
        spawnSync("bash", ["-c", 'printf %s "$NODE_OPTIONS"'], {
          encoding: "utf8",
          env: { ...env, HOME: home, NODE_OPTIONS: override },
        }).stdout;
      const env = buildGreenCheckpointEnv("base123", {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/home/t",
        SHLVL: "7", // a launcher's value is identity, never inherited
      });
      expect(env.SHLVL).toBe("1");
      expect(probe(env)).toBe(override);
      // Control: the identical spawn without the pin. Where bash is built with
      // SSH_SOURCE_BASHRC (Debian/Ubuntu, this box) it sources the rc and the override is
      // lost — the pin above is what prevents that. Elsewhere bash never reads the rc here.
      const { SHLVL: _unpinned, ...unpinned } = env;
      expect(["HIJACKED_BY_BASHRC", override]).toContain(probe(unpinned));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // WI-6583: HARNESS_SLUG is a non-`PAPERCUSP_`-prefixed test-run-attribution
  // fallback the vitest/playwright reporters now read (admin-test-runs-reporter.ts's
  // resolveTestRunHarnessSlug). If the gate's own host process ever inherited a stray
  // HARNESS_SLUG, leaving it unstripped would silently undo the deliberate
  // "gate rows stay unattributed" design documented on buildGreenCheckpointEnv itself.
  it("strips a host-inherited HARNESS_SLUG so gate rows stay unattributed (WI-6583)", () => {
    const env = buildGreenCheckpointEnv("base123", {
      HARNESS_SLUG: "some-other-harness",
    });
    expect(env.HARNESS_SLUG).toBeUndefined();
  });

  // EI-19307211919650123: the gate's test rows must be distinguishable from an
  // agent's local run. These stamps are PAPERCUSP_-prefixed, so they only work if
  // they are applied AFTER the strip loop — which is the whole point of the first
  // assertion below (a host value must be overridden, not merely absent).
  // A deliberately PARTIAL host env — the builder only ever reads keys, and a fixture
  // that had to spell out the whole environment would obscure what each case is about.
  // The cast is needed because this project's tsconfig pulls in Next's generated
  // `.next/types`, whose ProcessEnv augmentation makes NODE_ENV required; the older
  // inline-literal call sites in this file predate that and still carry the error.
  const partialEnv = (e: Record<string, string>): NodeJS.ProcessEnv =>
    e as NodeJS.ProcessEnv;

  it("stamps PAPERCUSP_TEST_RUN_SOURCE=ci AFTER the strip, overriding any host value", () => {
    const env = buildGreenCheckpointEnv(
      "b",
      partialEnv({ PAPERCUSP_TEST_RUN_SOURCE: "local" }),
    );
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe("ci");
  });

  it("arms coverage attribution in gate children, overriding any host value", () => {
    // P-006 (design-to-code-coverage-seam-2026-09-02). The gate's children are the largest
    // body of test execution on this box; without this they contribute no surface→test
    // evidence at all. Behavioural, not a source grep: the env builder is the chokepoint every
    // gate-spawned process passes through, so asserting the built env is asserting the thing
    // that actually reaches a fork.
    //
    // Overriding a host value matters here for the same reason it does for RUN_SOURCE: a host
    // that had explicitly DISARMED attribution must not be able to silence the gate's own runs.
    const env = buildGreenCheckpointEnv(
      "b",
      partialEnv({ PAPERCUSP_TEST_ATTRIBUTION: "0" }),
    );
    expect(env.PAPERCUSP_TEST_ATTRIBUTION).toBe("1");
    // And from a host that never mentioned it at all.
    expect(
      buildGreenCheckpointEnv("b", partialEnv({})).PAPERCUSP_TEST_ATTRIBUTION,
    ).toBe("1");
  });

  it("disables Python bytecode writes in gate children, overriding any host value", () => {
    const env = buildGreenCheckpointEnv(
      "b",
      partialEnv({ PYTHONDONTWRITEBYTECODE: "0" }),
    );
    expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
  });

  it("groups the run with PAPERCUSP_TEST_RUN_GROUP only when a runId is given", () => {
    const withId = buildGreenCheckpointEnv("b", partialEnv({}), "run-abc");
    expect(withId.PAPERCUSP_TEST_RUN_GROUP).toBe("run-abc");
    // A host-leaked group must not survive when this run has no id of its own —
    // otherwise a gate run would inherit some agent's run-group and mis-attribute.
    const noId = buildGreenCheckpointEnv(
      "b",
      partialEnv({ PAPERCUSP_TEST_RUN_GROUP: "leaked" }),
    );
    expect(noId.PAPERCUSP_TEST_RUN_GROUP).toBeUndefined();
    expect(noId.PAPERCUSP_TEST_RUN_SOURCE).toBe("ci");
  });

  it("keeps a repair proof group separate from this verifier process's run identity", () => {
    const env = buildGreenCheckpointEnv(
      "b",
      partialEnv({ AFFECTED_TASK_VERDICT_PROOF_GROUP: "leaked" }),
      "verifier-run",
      "shared",
      "initial-proof-run",
    );
    expect(env.PAPERCUSP_TEST_RUN_GROUP).toBe("verifier-run");
    expect(env.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBe("initial-proof-run");

    const noProof = buildGreenCheckpointEnv(
      "b",
      partialEnv({ AFFECTED_TASK_VERDICT_PROOF_GROUP: "leaked" }),
      "verifier-run",
    );
    expect(noProof.AFFECTED_TASK_VERDICT_PROOF_GROUP).toBeUndefined();
  });

  it("WI-10005212: carries the frozen review clock into the candidate-suite env (affected guard legs)", () => {
    const openedAtMs = Date.parse("2026-10-01T10:39:52.720Z");
    const frozen = buildGreenCheckpointEnv(
      "b",
      partialEnv({}),
      "run",
      "shared",
      null,
      "cand",
      openedAtMs,
    );
    expect(frozen.PAPERCUSP_FROZEN_CANDIDATE_OPENED_AT_MS).toBe(
      String(openedAtMs),
    );
    // A non-frozen run must not inherit a host-leaked clock.
    const notFrozen = buildGreenCheckpointEnv(
      "b",
      partialEnv({ PAPERCUSP_FROZEN_CANDIDATE_OPENED_AT_MS: "1" }),
      "run",
    );
    expect(notFrozen.PAPERCUSP_FROZEN_CANDIDATE_OPENED_AT_MS).toBeUndefined();
    expect(() =>
      buildGreenCheckpointEnv("b", partialEnv({}), "run", "shared", null, "c", -5),
    ).toThrow(/openedAtMs/);
  });

  it("sets GREEN_CHECKPOINT=1 and AFFECTED_BASE only when a base is given", () => {
    const withBase = buildGreenCheckpointEnv("abc", {});
    expect(withBase.GREEN_CHECKPOINT).toBe("1");
    expect(withBase.AFFECTED_BASE).toBe("abc");
    const noBase = buildGreenCheckpointEnv(null, {});
    expect(noBase.GREEN_CHECKPOINT).toBe("1");
    expect(noBase.AFFECTED_BASE).toBeUndefined();
  });

  it("defaults the vitest cap + retry but never clobbers a pre-set value", () => {
    const defaulted = buildGreenCheckpointEnv("b", {});
    // WI-806: the fork cap was lowered 8→4 (GREEN_CHECKPOINT_MAX_FORKS) so the forks
    // can't collectively OOM-kill a worker under fleet load (the worker-pool crash);
    // 2026-06-25 lowered again 4→2 after 4 STILL OOM-/timeout-flaked the gate red for
    // 1h+ on the chronically-swapping box (forced a manual force-deploy).
    expect(defaulted.VITEST_MAX_FORKS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS));
    expect(defaulted.VITEST_MAX_THREADS).toBe(
      String(GREEN_CHECKPOINT_MAX_FORKS),
    );
    expect(GREEN_CHECKPOINT_MAX_FORKS).toBe(2);
    expect(defaulted.AFFECTED_RETRY_FAILED).toBe("1");
    // 2026-06-22: heavy `await import()` unit tests take 74-97s under the gate's
    // 8-fork transform contention; the gate raises the unit timeout to 180s (dev
    // keeps the 60s libs/test-config default) — see buildGreenCheckpointEnv.
    expect(defaulted.VITEST_UNIT_TIMEOUT_MS).toBe("180000");
    const preset = buildGreenCheckpointEnv("b", {
      VITEST_MAX_FORKS: "6",
      AFFECTED_RETRY_FAILED: "0",
    });
    expect(preset.VITEST_MAX_FORKS).toBe("6"); // honored (distinct from the default to prove precedence)
    expect(preset.VITEST_MAX_THREADS).toBe(String(GREEN_CHECKPOINT_MAX_FORKS)); // still defaulted
    expect(preset.AFFECTED_RETRY_FAILED).toBe("0"); // '0' is a value, not absent — honored
  });

  it("uses the bounded reserved profile only when explicitly selected and preserves per-variable overrides", () => {
    const reserved = buildGreenCheckpointEnv(
      "b",
      partialEnv({}),
      undefined,
      "reserved",
    );
    expect(reserved.VITEST_MAX_FORKS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
    expect(reserved.VITEST_MAX_THREADS).toBe(
      String(GREEN_CHECKPOINT_RESERVED_MAX_FORKS),
    );
    expect(GREEN_CHECKPOINT_RESERVED_MAX_FORKS).toBe(8);

    const overridden = buildGreenCheckpointEnv(
      "b",
      partialEnv({ VITEST_MAX_FORKS: "6", VITEST_MAX_THREADS: "7" }),
      undefined,
      "reserved",
    );
    expect(overridden.VITEST_MAX_FORKS).toBe("6");
    expect(overridden.VITEST_MAX_THREADS).toBe("7");
  });

  it("renders the effective mode, fork/thread limits, and sanitized heap as stable evidence", () => {
    const env = buildGreenCheckpointEnv(
      "b",
      partialEnv({}),
      undefined,
      "reserved",
    );
    expect(greenCheckpointCapacityEvidence("reserved", env)).toBe(
      `GREEN_CHECKPOINT_CAPACITY mode=reserved maxForks=8 maxThreads=8 ` +
        `forkHeapMb=${GREEN_CHECKPOINT_FORK_HEAP_MB} profileMaxForks=8`,
    );
  });

  it("strips the host 128 GiB --max-old-space-size from NODE_OPTIONS, pins a sane per-fork heap", () => {
    // The exact bg-host/staging env that held `main` red ~16h: a 128 GiB heap +
    // --expose-gc inherited straight into the 8 vitest forks.
    const env = buildGreenCheckpointEnv("b", {
      NODE_OPTIONS: "--max-old-space-size=131072 --expose-gc",
    });
    expect(env.NODE_OPTIONS).toBe(
      `--expose-gc --max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`,
    );
    expect(env.NODE_OPTIONS).not.toContain("131072");
  });
});

describe("sanitizeForkNodeOptions (the gate must not inherit the host 128 GiB heap)", () => {
  const HEAP = `--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`;

  it("replaces an inherited =value heap flag, preserving other tokens", () => {
    expect(
      sanitizeForkNodeOptions("--max-old-space-size=131072 --expose-gc"),
    ).toBe(`--expose-gc ${HEAP}`);
  });

  it("drops the space-separated `--flag value` form (both tokens)", () => {
    expect(
      sanitizeForkNodeOptions(
        "--max-old-space-size 131072 --enable-source-maps",
      ),
    ).toBe(`--enable-source-maps ${HEAP}`);
  });

  it("handles the underscore spelling too", () => {
    expect(sanitizeForkNodeOptions("--max_old_space_size=99999")).toBe(HEAP);
  });

  it("pins the heap deterministically even with empty/undefined input", () => {
    expect(sanitizeForkNodeOptions(undefined)).toBe(HEAP);
    expect(sanitizeForkNodeOptions("")).toBe(HEAP);
  });

  it("honors a caller-chosen cap", () => {
    expect(sanitizeForkNodeOptions("--max-old-space-size=131072", 8192)).toBe(
      "--max-old-space-size=8192",
    );
  });
});

describe("checkpointFailureSignature (P-012 dedup, SPA-build folded in)", () => {
  it("is empty on a green run even if the output contains FAIL-looking text", () => {
    expect(
      checkpointFailureSignature(" FAIL  lib/x.test.ts > c", true, true),
    ).toEqual([]);
  });

  it("is the suite signature (no vite sentinel) when the suite failed but the build is ok", () => {
    expect(
      checkpointFailureSignature(" FAIL  lib/x.test.ts > c", false, true),
    ).toEqual(["lib/x.test.ts"]);
  });

  it("appends @papercusp/operator-vite when the build (not the suite) is what failed", () => {
    // suite passed (no FAIL markers) but build broke → only the build sentinel
    expect(
      checkpointFailureSignature(
        "\n=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror",
        false,
        false,
      ),
    ).toEqual(["@papercusp/operator-vite"]);
  });

  it("does not duplicate the build sentinel when it is already in the extracted set", () => {
    const sig = checkpointFailureSignature(
      ">>> @papercusp/operator-vite FAILED — retry",
      false,
      false,
    );
    expect(sig).toEqual(["@papercusp/operator-vite"]);
  });
});

describe("GATE_FAILURE_SHAPE (EI-19971472409393390)", () => {
  it("formats the measured aggregate as a stable machine-greppable line", () => {
    const shape = {
      count: 6,
      deterministic: 6,
      timeout: 0,
      unclassified: 0,
      maxLoadavgPerCore: 0.4,
    };
    expect(formatGateFailureShapeNote(shape)).toBe(
      "GATE_FAILURE_SHAPE count=6 deterministic=6 timeout=0 maxLoadavgPerCore=0.40 unclassified=0",
    );
    expect(
      formatGateHeldByNote(["lib/cell-access-parity.test.ts"], {
        postSuiteMeasured: false,
        failureShape: shape,
      }),
    ).toContain(
      'GATE_HELD_BY count=1 attribution=attributed truncated=false postSuite=not-measured entries=["lib/cell-access-parity.test.ts"]\nGATE_FAILURE_SHAPE count=6 deterministic=6 timeout=0 maxLoadavgPerCore=0.40 unclassified=0',
    );
  });
});

describe("summarizeSuiteOutput (de-noised held-gate tail)", () => {
  it("drops npm error boilerplate, keeps FAIL + assertion signal", () => {
    const out = [
      "npm error code 1",
      " FAIL  lib/x.test.ts > case",
      "npm error A complete log of this run can be found in:",
      "AssertionError: expected 1 to be 2",
    ].join("\n");
    const s = summarizeSuiteOutput(out);
    expect(s).not.toMatch(/npm error/);
    expect(s).toContain("FAIL  lib/x.test.ts");
    expect(s).toContain("AssertionError: expected 1 to be 2");
  });

  it("keeps only the last 2000 chars", () => {
    expect(summarizeSuiteOutput("x".repeat(3000))).toHaveLength(2000);
  });
});

// EI-8744: a codeless pot (extends coding, only README + .papercusp state, NO package.json)
// can't run the npm green command — `npm run test:affected` dies with `Missing script` (rc=1)
// BEFORE any test, so the gate went hard-RED with an EMPTY failing-test signature and the
// hourly release-fixer churned on a red with nothing to fix. Nothing to gate ⇒ GREEN.
describe("isNothingToGate (EI-8744: codeless pot ⇒ nothing to gate ⇒ green)", () => {
  it("is true for an npm greenCmd when the tree has no package.json", () => {
    expect(isNothingToGate("npm run test:affected", false)).toBe(true);
    expect(isNothingToGate("npm test", false)).toBe(true);
  });

  it("is false when the tree HAS a package.json (the real pipeline — a strict no-op)", () => {
    expect(isNothingToGate("npm run test:affected", true)).toBe(false);
  });

  it("is false for a non-npm greenCmd even with no package.json (it could gate real code)", () => {
    expect(isNothingToGate("cargo test", false)).toBe(false);
    // must NOT prefix-match a command that merely starts with the letters "npm"
    expect(isNothingToGate("npmfoo run x", false)).toBe(false);
  });
});

describe("realCheckpointDeps.runGreen — nothing-to-gate short-circuit (EI-8744)", () => {
  let tree: string;
  let logDir: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "gc-codeless-"));
    logDir = mkdtempSync(join(tmpdir(), "gc-logs-"));
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("reports GREEN with an empty signature and NEVER spawns npm for a repo with no package.json", async () => {
    let execCalls = 0;
    // A fake exec that would fail exactly as the real `npm run test:affected` does on a
    // codeless repo — proving the short-circuit returns green WITHOUT ever invoking it.
    const exec: CheckpointExec = async () => {
      execCalls++;
      return {
        code: 1,
        stdout: "",
        stderr: 'npm error Missing script: "test:affected"',
      };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "",
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, "base");
    expect(r.green).toBe(true);
    expect(r.failingTests).toEqual([]);
    expect(execCalls).toBe(0); // the npm green command is never even spawned
  });

  it("still runs the suite (no short-circuit) when the repo HAS a package.json", async () => {
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
    let ran = "";
    const exec: CheckpointExec = async (cmd, args) => {
      ran = `${cmd} ${args.join(" ")}`;
      return { code: 0, stdout: "No affected workspaces.", stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "",
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, "base");
    expect(r.green).toBe(true);
    expect(ran).toBe("npm run test:affected"); // the suite really ran — no false short-circuit
  });

  it("forwards command-boundary and child-output progress through the real dependency seam", async () => {
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
    const progress = vi.fn();
    const exec: CheckpointExec = async (cmd, args, opts) => {
      opts?.onProgress?.();
      if (cmd === "git" && args[0] === "grep")
        return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "No affected workspaces.", stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "",
    });

    await realCheckpointDeps(
      cfg,
      exec,
      "run-progress",
      undefined,
      progress,
    ).runGreen(tree, "base");

    expect(progress).toHaveBeenCalledWith("command:start:npm");
    expect(progress).toHaveBeenCalledWith("command:output:npm");
    expect(progress).toHaveBeenCalledWith("command:complete:npm");
  });

  it("EI-21012046480619768: a signaled suite child stays red and records signal attribution", async () => {
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
    const calls: string[] = [];
    const exec: CheckpointExec = async (cmd, args) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "npm" && args[0] === "run" && args[1] === "test:affected") {
        // A real child close event has code=null plus the terminating signal. Keep code=0
        // here to prove runGreen relies on signal preservation, not on a non-zero exit code.
        return {
          code: 0,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "",
    });

    const result = await realCheckpointDeps(cfg, exec, "signal-run").runGreen(
      tree,
      "base",
    );

    expect(result.green).toBe(false);
    expect(result.postSuiteMeasured).toBe(false);
    expect(result.summary).toContain(
      "CHECKPOINT CHILD TERMINATED BY SIGNAL (SIGTERM)",
    );
    expect(result.logPath).toBeDefined();
    const body = readFileSync(result.logPath!, "utf8");
    expect(body).toContain("CHECKPOINT CHILD TERMINATED BY SIGNAL (SIGTERM)");
    expect(body).toMatch(
      /GATE_HELD_BY count=0 attribution=unattributed truncated=false postSuite=not-measured/,
    );
    // The signaled suite must not be followed by post-suite legs or a flake-rescue rerun.
    expect(calls).toEqual(["npm run test:affected"]);
  });
});

describe("realCheckpointDeps.setupTree — progress-aware materialization timeout", () => {
  it("EI-21533144726892345: gives writer wait + copy a renewable idle budget under an independent hard ceiling", async () => {
    const generation = "v1-test-generation";
    const token = "1:2:3:4";
    let setupOpts: Parameters<CheckpointExec>[2];
    const exec: CheckpointExec = async (cmd, args, opts) => {
      if (cmd === process.execPath) {
        return {
          code: 0,
          stdout: `DEPENDENCY_GENERATION_RESULT schema=1 identity=${generation} token=${token}\n`,
          stderr: "",
        };
      }
      if (cmd === "bash" && args.includes("--exclusive-all-slots")) {
        setupOpts = opts;
        opts?.onOutput?.(
          "stderr",
          "[pc-heavy] exclusive materialization writer acquired\n",
        );
        return {
          code: 0,
          stdout: `DEPENDENCY_GENERATION_PIN identity=${generation}\n`,
          stderr: "",
        };
      }
      throw new Error(`unexpected setup command: ${cmd} ${args.join(" ")}`);
    };

    await realCheckpointDeps(cfg(), exec).setupTree("a".repeat(40), {
      preparedSource: true,
    });

    expect(setupOpts?.timeoutMs).toBe(SETUP_TREE_TIMEOUT_MS);
    expect(setupOpts?.timeoutResetsOnProgress).toBe(true);
    expect(setupOpts?.hardTimeoutMs).toBe(SETUP_TREE_HARD_TIMEOUT_MS);
    expect(setupOpts?.killProcessGroupOnTimeout).toBe(true);
    expect(setupOpts?.onOutput).toBeTypeOf("function");
  });
});

describe("realCheckpointDeps.runGateAtRef — test-task rescue watchdog (EI-204898)", () => {
  it("bounds test:* rescues with the batch watchdog and process-group kill, but leaves lint rescues unchanged", async () => {
    let testOpts: Parameters<CheckpointExec>[2];
    let lintOpts: Parameters<CheckpointExec>[2];
    const exec: CheckpointExec = async (cmd, args, opts) => {
      if (cmd === "npm" && args.includes("test:lane-stateful")) testOpts = opts;
      if (cmd === "npm" && args.includes("lint:tsc")) lintOpts = opts;
      return { code: 0, stdout: "", stderr: "" };
    };
    const deps = realCheckpointDeps(cfg(), exec);
    // The production setupTree materializes a release checkout; this seam test only needs
    // the real invocation wiring, so keep the checkout in the test repo and skip setup.
    deps.setupTree = async () => {};

    const result = await deps.runGateAtRef!("tip-sha", [
      "@papercusp/operator-core :: test:lane-stateful",
      "lint:tsc",
    ]);

    expect(result.pass).toBe(true);
    expect(testOpts?.timeoutMs).toBeTypeOf("number");
    expect(testOpts?.timeoutMs).toBeGreaterThan(0);
    expect(testOpts?.killProcessGroupOnTimeout).toBe(true);
    expect(lintOpts?.timeoutMs).toBeUndefined();
    expect(lintOpts?.killProcessGroupOnTimeout).toBeUndefined();
  });
});

describe("realCheckpointDeps.runGreen — checkpoint-log retention (WI-224710)", () => {
  let tree: string;
  let logDir: string;

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "gc-log-retention-tree-"));
    logDir = mkdtempSync(join(tmpdir(), "gc-log-retention-logs-"));
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("prunes persisted checkpoint logs older than 14 days while preserving fresh logs", async () => {
    const nestedLogDir = join(logDir, "managed-hive");
    mkdirSync(nestedLogDir);
    const staleLog = join(nestedLogDir, "stale-checkpoint.log");
    const freshLog = join(nestedLogDir, "fresh-checkpoint.log");
    writeFileSync(staleLog, "stale");
    writeFileSync(freshLog, "fresh");
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    utimesSync(staleLog, fifteenDaysAgo, fifteenDaysAgo);

    const exec: CheckpointExec = async (cmd, args) => {
      if (cmd === "git" && args[0] === "grep") {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "Test Files  1 passed (1)\n", stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "",
    });

    const result = await realCheckpointDeps(cfg, exec).runGreen(tree, "base");

    expect(result.green).toBe(true);
    const retained = readdirSync(nestedLogDir);
    expect(retained).not.toContain("stale-checkpoint.log");
    expect(retained).toContain("fresh-checkpoint.log");
    expect(
      readdirSync(logDir).filter((name) => name.endsWith(".log")),
    ).toHaveLength(1);
  });

  it("retains actual pure-capture receipts for the gate ledger's 90-day evidence window", async () => {
    const nestedLogDir = join(logDir, "managed-hive");
    mkdirSync(nestedLogDir);
    const receipt = (runId: string) => ({
      version: 1 as const, runId, gateFireId: `fire-${runId}`, pid: 123,
      processStartedAtMs: 1, judgedSha: "a".repeat(40), resolvedAtMs: 70,
      terminalEmissionCompletedAtMs: 90, verdictRecordedAtMs: 80,
      promotion: { candidate: "a".repeat(12), recordedAtMs: 60,
        promoted: false, reason: "not-green" },
      capture: null, archivedAtMs: 210,
    });
    const captures = [15, 89, 91].map((ageDays) => {
      const file = archivePureProofCapture(nestedLogDir, receipt(`age-${ageDays}`), () => {});
      expect(file).not.toBeNull();
      const bytes = readFileSync(file!, "utf8");
      const old = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      utimesSync(file!, old, old);
      return { file: file!, bytes, ageDays };
    });
    const diagnostic = join(nestedLogDir, "pure-proof-capture-age-15.log");
    const unrelated = join(nestedLogDir, "unrelated.json");
    for (const file of [diagnostic, unrelated]) {
      writeFileSync(file, "old diagnostic");
      const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      utimesSync(file, old, old);
    }
    const exec: CheckpointExec = async (cmd, args) => {
      if (cmd === "git" && args[0] === "grep") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "Test Files  1 passed (1)\n", stderr: "" };
    };
    const config = releaseConfig({ checkpointRoot: tree, checkpointLogDir: logDir,
      greenCmd: "npm run test:affected", spaBuildWorkspace: "" });

    expect((await realCheckpointDeps(config, exec).runGreen(tree, "base")).green).toBe(true);

    for (const { file, bytes, ageDays } of captures) {
      if (ageDays < 90) expect(readFileSync(file, "utf8")).toBe(bytes);
      else expect(existsSync(file)).toBe(false);
    }
    expect(existsSync(diagnostic)).toBe(false);
    expect(existsSync(unrelated)).toBe(false);
  });
});

// EI-18694489428714850: PAPERCUSP_RETAIN_DIST_CHUNKS had ZERO callers for weeks even though
// the retention mechanism (WI-1484) was fully built — nothing ever set the env var that turns
// it on for a one-shot build, so every gate-triggered SPA rebuild kept emptying dist/ and
// 404ing any open desktop webview's lazy chunks. The bug wasn't a missing FEATURE, it was a
// missing WIRE — exactly the kind of regression a green suite can't catch unless something
// asserts the wire is actually connected. This test IS that assertion: it locks in that the
// checkpoint's SPA build call always passes PAPERCUSP_RETAIN_DIST_CHUNKS=1, so a future
// refactor of this call site (or of buildGreenCheckpointEnv) that silently drops it fails
// loudly here instead of quietly reintroducing the exact same class of bug.
describe("realCheckpointDeps.runGreen — SPA build retains dist chunks (EI-18694489428714850)", () => {
  let tree: string;
  let logDir: string;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "gc-spa-retain-"));
    logDir = mkdtempSync(join(tmpdir(), "gc-logs-"));
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("passes PAPERCUSP_RETAIN_DIST_CHUNKS=1 to the operator-vite build — the whole point of WI-1484", async () => {
    // No lint:tsc/lint:migrations/identity/design-primitives scripts on this fake tree, so
    // those legs are structurally skipped (hasNpmScript false) and stay at their default-ok
    // — isolating this test to exactly the leg under test: the SPA build call.
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
    let buildEnv: NodeJS.ProcessEnv | undefined;
    let buildCalled = false;
    const exec: CheckpointExec = async (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "grep") {
        // exit 1 = git grep's "no match" — i.e. no committed conflict markers.
        return { code: 1, stdout: "", stderr: "" };
      }
      if (
        cmd === "npm" &&
        args.includes("--workspace") &&
        args.includes("@papercusp/operator-vite") &&
        args.includes("build")
      ) {
        buildCalled = true;
        buildEnv = opts?.env;
        return { code: 0, stdout: "", stderr: "" };
      }
      // the greenCmd itself (`npm run test:affected`) — green, nothing failing.
      return { code: 0, stdout: "", stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      // spaBuildWorkspace deliberately NOT overridden — defaults to
      // '@papercusp/operator-vite', so this test exercises the real SPA-build leg.
    });
    const r = await realCheckpointDeps(cfg, exec).runGreen(tree, "base");
    expect(r.green).toBe(true);
    expect(buildCalled).toBe(true); // the build leg actually ran — didn't skip/short-circuit
    expect(buildEnv?.PAPERCUSP_RETAIN_DIST_CHUNKS).toBe("1");
  });
});

// EI-19346606967082413: the persisted verdict log used to record ONLY the suite's stdout.
// Every ORCHESTRATOR decision — `checkpointing candidate <sha>`, the quiet-cut pick, and each
// in-process `auto-refiring` — went to stdout alone. A MANUAL run redirects that to /tmp; a
// SCHEDULER-fired run redirects it NOWHERE. So a cron run left no artifact whatsoever of which
// candidate(s) it judged, which is why "which sha is this run judging" repeatedly produced
// contradictory answers from agents reading the same files, and why the `inFlightRetriage`
// routines marker had to be invented to recover state this log should have carried.
//
// The first fix attempt is the reason this test exists. It shipped the ring buffer, the
// once-per-run reset seam and the tee — and stopped one hunk short of CALLING
// renderOrchestratorTranscript() at the write site. It compiled, it typechecked, every test
// stayed green, and it was a complete no-op: the buffer filled on every run and was thrown
// away. That is the same class as EI-18694489428714850 above — not a missing FEATURE, a
// missing WIRE — and no test of the helper in isolation can ever catch it, because the helper
// was perfect. So this asserts the WIRE, end to end: a line recorded on the buffer has to come
// out the other end INSIDE THE FILE.
describe("realCheckpointDeps.runGreen — the orchestrator transcript reaches the persisted log (EI-19346606967082413)", () => {
  let tree: string;
  let logDir: string;
  let suiteEnv: NodeJS.ProcessEnv | undefined;
  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), "gc-transcript-"));
    logDir = mkdtempSync(join(tmpdir(), "gc-logs-"));
    suiteEnv = undefined;
    // The buffer is module-global, so a neighbouring test's lines would otherwise leak in
    // and make this pass for the wrong reason.
    resetOrchestratorLog();
  });
  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    resetOrchestratorLog();
  });

  const runAndReadLog = async (
    suiteStdout: string,
    capacityMode: GreenCheckpointCapacityMode = "shared",
  ): Promise<string> => {
    const { readdirSync, readFileSync } = await import("node:fs");
    writeFileSync(
      join(tree, "package.json"),
      JSON.stringify({ name: "x", scripts: { "test:affected": "true" } }),
    );
    const exec: CheckpointExec = async (cmd, args, opts) => {
      // git grep's "no match" exit code — no committed conflict markers on this fake tree.
      if (cmd === "git" && args[0] === "grep")
        return { code: 1, stdout: "", stderr: "" };
      if (cmd === "npm" && args[0] === "run" && args[1] === "test:affected") {
        suiteEnv = opts?.env ? { ...opts.env } : undefined;
      }
      return { code: 0, stdout: suiteStdout, stderr: "" };
    };
    const cfg = releaseConfig({
      checkpointRoot: tree,
      checkpointLogDir: logDir,
      greenCmd: "npm run test:affected",
      spaBuildWorkspace: "", // isolate to the suite leg — no SPA build on a fake tree
      greenCheckpointCapacityMode: capacityMode,
    });
    // The parent Vitest runner sets its OWN worker limits. They are legitimate explicit
    // overrides in production, but leaking them into this fixture would make an assertion
    // about the selected profile report the parent's concurrency instead (16 on the affected
    // run that exposed this). Scrub only around the real dependency call, then restore exactly.
    const inheritedForks = process.env.VITEST_MAX_FORKS;
    const inheritedThreads = process.env.VITEST_MAX_THREADS;
    delete process.env.VITEST_MAX_FORKS;
    delete process.env.VITEST_MAX_THREADS;
    try {
      await realCheckpointDeps(cfg, exec).runGreen(tree, "base");
    } finally {
      if (inheritedForks === undefined) delete process.env.VITEST_MAX_FORKS;
      else process.env.VITEST_MAX_FORKS = inheritedForks;
      if (inheritedThreads === undefined) delete process.env.VITEST_MAX_THREADS;
      else process.env.VITEST_MAX_THREADS = inheritedThreads;
    }
    const written = readdirSync(logDir).filter((f) => f.endsWith(".log"));
    expect(written).toHaveLength(1); // exactly one log per run, as the write site promises
    return readFileSync(join(logDir, written[0]!), "utf8");
  };

  it("⭐ carries a recorded orchestrator line into the written file, inside the transcript fence", async () => {
    // Verbatim shape of the line green-checkpoint.ts:2745 emits — the single most-wanted
    // fact about any run, and the one a cron run used to lose entirely.
    recordOrchestratorLine("checkpointing candidate abc12345 (base none)");
    const body = await runAndReadLog("Test Files  3 passed (3)\n");

    expect(body).toContain("checkpointing candidate abc12345");
    // ...and it must be FENCED, not loose in the suite output: the fence is what makes it
    // greppable and keeps it from reading as something the suite itself printed.
    const fenceStart = body.indexOf("--- orchestrator transcript");
    expect(fenceStart).toBeGreaterThanOrEqual(0);
    const fenceEnd = body.indexOf("--- end orchestrator transcript");
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    expect(body.indexOf("checkpointing candidate abc12345")).toBeGreaterThan(
      fenceStart,
    );
    expect(body.indexOf("checkpointing candidate abc12345")).toBeLessThan(
      fenceEnd,
    );
  });

  it("persists the effective reserved-capacity settings in the operator transcript", async () => {
    const body = await runAndReadLog("Test Files  3 passed (3)\n", "reserved");
    // This is the end-to-end WIRING assertion: the transcript must persist the exact
    // effective settings handed to the suite. Capture that invocation environment rather
    // than reconstructing it from process.env after the async run — test runners may
    // restore or mutate their worker env between those two moments. The pure
    // buildGreenCheckpointEnv/greenCheckpointCapacityEvidence tests above separately pin
    // the default `8` profile and explicit-override precedence.
    expect(suiteEnv).toBeDefined();
    expect(body).toContain(
      greenCheckpointCapacityEvidence("reserved", suiteEnv!),
    );
  });

  it("does not displace the suite output the log already existed to preserve", async () => {
    // The negative control. A "fix" that wrote the transcript OVER the suite stdout would
    // satisfy the assertion above while destroying the log's original purpose.
    recordOrchestratorLine(
      "quiet-cut: tip deadbeef is 63s old (<240s quiet window)",
    );
    const body = await runAndReadLog(
      "Test Files  571 passed (573)\n      Tests  42576 passed\n",
    );

    expect(body).toContain("Test Files  571 passed (573)");
    expect(body).toContain("Tests  42576 passed");
    // header first, then the transcript, then the suite output it precedes.
    // WI-37605: the header now emits the RESOLVED tag, so this must not hardcode the production
    // literal — under vitest the same write path legitimately produces the FIXTURE tag, which is
    // the whole point (a log written by a test announces itself in its own first line instead of
    // opening byte-identically to a genuine verdict log). Resolving it here keeps the assertion
    // about ORDERING, which is what this test exists to pin.
    expect(body.indexOf(`${orchestratorStdoutTag()} candidate=`)).toBe(0);
    expect(body.indexOf("--- orchestrator transcript")).toBeLessThan(
      body.indexOf("Test Files  571 passed"),
    );
  });

  it("⭐ the header FORWARDS to the promotion trailer (EI-20014356905761236)", async () => {
    // The seam between the two halves of that fix, which are otherwise tested apart: the
    // header is written HERE, by the suite dep, and cannot know the promotion outcome — the
    // decision is taken later, by runGreenCheckpoint. So this line's only job is to forward
    // the reader. Stop forwarding and `green=true` goes straight back to being read as
    // "this became the pin", which is the whole incident.
    const body = await runAndReadLog("Test Files  3 passed (3)\n");
    const header = body.split("\n")[0]!;

    expect(header).toContain("green=");
    expect(header).toContain("promoted=see-GATE_PROMOTION");
    // ...and it must tell the reader HOW to read the trailer, or a run killed before its
    // decision reads as a missing field rather than a real third state. WI-39450 / WI-39671
    // moved that third state out of ABSENCE (which could not also carry the suite verdict)
    // and onto an explicit `decision-pending` trailer, so the forward has to name two things:
    // take the LAST trailer, and what the pending one means.
    expect(header).toContain("tail -1");
    expect(header).toContain("decision-pending");
  });

  it("adds no fence at all when the run recorded nothing (an empty header is worse than none)", () => {
    // Kept as a direct call rather than a runGreen round-trip: runGreen legitimately logs
    // its own lines before the write, so "empty transcript" is not reachable through it.
    expect(renderOrchestratorTranscript([])).toBe("");
  });
});

// load-flake-isolation-2026-06-23: the SAFE load-flake absorber. The 2026-06-23 incident:
// runner-aggregate.test.ts + scheduler-workspace-scope.test.ts (both @papercusp/operator-core)
// failed the gate under the 8-fork checkpoint load but PASS in isolation, and the
// AFFECTED_RETRY_FAILED=1 workspace retry didn't absorb them — holding the whole fleet's
// gate for 4h. These cover the pure parse + decision + orchestration without real vitest.

// A realistic affected-runner output for the actual incident: two files fail under
// @papercusp/operator-core's section (the `>>>` header), shown via both a `FAIL` suite row
// and a `❯ … failed` summary row, the two formats parseFailingFilesByWorkspace handles.
const INCIDENT_OUTPUT = [
  "Affected workspaces (2): @papercusp/operator-core, @papercusp/agent-mcp",
  "",
  ">>> @papercusp/operator-core :: npm run test",
  " FAIL  lib/llm-testing/__tests__/runner-aggregate.test.ts > aggregates runs",
  " ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms",
  "   Test timed out in 20000ms",
  ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)",
  "",
  ">>> @papercusp/agent-mcp :: npm run test",
  " Tests  340 passed (340)",
  "",
  "2 non-quarantined task(s) failed.",
].join("\n");

describe("parseFailingFilesByWorkspace (load-flake isolation)", () => {
  it("groups failing FILES under the workspace section they ran in (both FAIL + ❯ formats)", () => {
    expect(parseFailingFilesByWorkspace(INCIDENT_OUTPUT)).toEqual([
      {
        workspace: "@papercusp/operator-core",
        file: "lib/llm-testing/__tests__/runner-aggregate.test.ts",
      },
      {
        workspace: "@papercusp/operator-core",
        file: "lib/scout/scheduler-workspace-scope.test.ts",
      },
    ]);
  });

  it("does NOT return bare workspace markers (only real .test/.spec files)", () => {
    const files = parseFailingFilesByWorkspace(INCIDENT_OUTPUT).map(
      (f) => f.file,
    );
    expect(files.every((f) => /\.(test|spec)\./.test(f))).toBe(true);
    expect(files).not.toContain("@papercusp/operator-core");
  });

  it("skips a FAIL line with no preceding workspace header (no cwd to run it in)", () => {
    const out = " FAIL  lib/orphan.test.ts > case\nno header above";
    expect(parseFailingFilesByWorkspace(out)).toEqual([]);
  });

  it("dedupes a file that appears in multiple rows of the same workspace", () => {
    const out = [
      ">>> @papercusp/x :: npm run test",
      " FAIL  lib/a.test.ts > one",
      " ❯ lib/a.test.ts (3 tests | 2 failed) 5ms",
    ].join("\n");
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: "@papercusp/x", file: "lib/a.test.ts" },
    ]);
  });

  it("returns [] on empty / non-vitest output (build break)", () => {
    expect(parseFailingFilesByWorkspace("")).toEqual([]);
    expect(
      parseFailingFilesByWorkspace(
        "=== SPA BUILD FAILED (@papercusp/operator-vite) ===\nerror TS2304",
      ),
    ).toEqual([]);
  });

  it("uses the affected runner break-set for node --test output that has no Vitest rows", () => {
    const file = "test/build-desktop-sidecar-lock.test.js";
    const out = [
      ">>> @papercusp/desktop :: npm run test",
      "ℹ fail 1",
      `test at ${file}:11:1`,
      "✖ every cargo build closes the sidecar flock fd before sccache can daemonize (3.4ms)",
      formatFailingFilesLine({
        runToken: "3655179-735cdb19",
        entries: [{ workspace: "@papercusp/desktop", file }],
      }),
      "AFFECTED_TESTS_RESULT status=failed tasks=1 failed=1",
    ].join("\n");
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: "@papercusp/desktop", file },
    ]);
  });

  // 2026-07-17 phantom-workspace incident: the gate captures each task's stdout/stderr and
  // block-flushes them, so vitest's "Failed Tests" epilogue (` FAIL file > case` rows) can
  // land AFTER later workspaces' headers. The bare FAIL row then re-attributed operator-core's
  // quarantined hyperbee failure to @papercupai/gitnexus-bridge — a phantom un-quarantined
  // entry that kept an all-failures-quarantined run red AND emptied the re-triage's file list.
  it("does NOT re-attribute a rollup-named file via a displaced FAIL epilogue row under a later header", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      " ❯ lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts (2 tests | 1 failed) 22943ms",
      "",
      ">>> @papercupai/gitnexus-bridge :: npm run test",
      " Tests  12 passed (12)",
      " FAIL  lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts > Shared Hive federation > federates a presence announce",
      ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED, flake absorption)",
    ].join("\n");
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      {
        workspace: "@papercusp/operator-core",
        file: "lib/sync/hyperbee/__tests__/hive-two-peer-federation.test.ts",
      },
    ]);
  });

  // WI-7501 — the same displacement, one rung deeper, and the guard above could not reach it.
  //
  // That guard suppresses a displaced bare FAIL row only for a file some ROLLUP already named.
  // A file that fails at COLLECTION emits `❯ …arm.test.ts (0 test)` — zero tests collected, no
  // `failed` token — and `vitestSummaryFailRow` requires that token, so NO rollup names it. Its
  // only rows are bare FAIL rows, and every one of them lands in the epilogue after the last
  // normal section, so it was attributed to whichever workspace happened to run last.
  //
  // Measured live on cand a94547c8 (2026-08-03): two operator-core files came back as
  // `@papercusp/eval-battery` files. That is not a cosmetic mislabel — the pair is the cwd for
  // the re-run, so isolation AND the tip rescue both re-ran them in a workspace that does not
  // contain them, matching zero files and exiting 1 every time. `runTestsAtRef` therefore
  // returned pass:false ⇒ `real-red` ⇒ autoRefire:false, making the red structurally
  // unrescuable however thoroughly the tree was fixed. It fires precisely on import/transform
  // breaks — the class a peer's in-flight commit causes, i.e. the reds MOST likely already
  // fixed at tip and most in need of the rescue.
  //
  // Fixed by recognising the absorption marker as a section header (it names the workspace
  // explicitly) and treating that attribution as authoritative over positional placement.
  it("WI-7501: attributes a COLLECTION-error file (0 tests, no rollup) to its OWN workspace, not the last one to run", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      // Zero tests collected ⇒ no `failed` token ⇒ no rollup row for this file, ever.
      " ❯ lib/agent-tools/loop/arm.test.ts (0 test)",
      ">>> @papercusp/eval-battery :: npm run test",
      " Tests  4 passed (4)",
      // Displaced epilogue: operator-core's row, flushed under a foreign header.
      " FAIL  lib/agent-tools/loop/arm.test.ts [ lib/agent-tools/loop/arm.test.ts ]",
      // The absorption re-run names the owning workspace — the authoritative attribution.
      ">>> @papercusp/operator-core FAILED — fresh-process re-run of 1 failed file(s) (HARDEN-GATE flake absorption): lib/agent-tools/loop/arm.test.ts",
      " FAIL  lib/agent-tools/loop/arm.test.ts [ lib/agent-tools/loop/arm.test.ts ]",
    ].join("\n");
    // Exactly ONE pair, under operator-core. A second eval-battery pair would be the live bug:
    // unrunnable by construction, and enough on its own to pin the gate red forever.
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      {
        workspace: "@papercusp/operator-core",
        file: "lib/agent-tools/loop/arm.test.ts",
      },
    ]);
  });

  // The `>>> …` chatter the affected-runner emits between sections must never be mistaken for a
  // header now that a second header shape is recognised — otherwise a cargo section would
  // capture every subsequent file under a bogus workspace named "Running".
  it("WI-7501: does not treat non-package `>>>` chatter as a section header", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      ">>> Running cargo tests (P-009: papercusp-desktop/src-tauri Rust suite)...",
      " FAIL  lib/a.test.ts > case",
    ].join("\n");
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: "@papercusp/operator-core", file: "lib/a.test.ts" },
    ]);
  });

  it("still attributes a FAIL-only file (transform/setup error — no rollup row exists for it)", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      " ❯ lib/a.test.ts (3 tests | 1 failed) 10ms",
      ">>> @papercusp/web :: npm run test",
      " FAIL  app/broken-transform.test.ts > setup",
    ].join("\n");
    expect(parseFailingFilesByWorkspace(out)).toEqual([
      { workspace: "@papercusp/operator-core", file: "lib/a.test.ts" },
      { workspace: "@papercusp/web", file: "app/broken-transform.test.ts" },
    ]);
  });
});

describe("test quarantine filtering (v1 gate scope)", () => {
  const quarantine = parseTestQuarantine(
    [
      "# workspace and file-level forms",
      "@papercusp/operator-core::lib/sync/hyperbee/**",
      "@papercusp/operator-core::lib/shared-pot-loop/**",
      "@papercusp/operator-core::lib/*federation*.test.ts",
      "@papercusp/pubsub-substrate",
    ].join("\n"),
  );

  it("matches workspace-scoped glob quarantine entries", () => {
    expect(
      isQuarantinedTestFile(
        {
          workspace: "@papercusp/operator-core",
          file: "lib/sync/hyperbee/__tests__/two-peer.test.ts",
        },
        quarantine,
      ),
    ).toBe(true);
    expect(
      isQuarantinedTestFile(
        {
          workspace: "@papercusp/operator-core",
          file: "lib/work-items-view.integration.test.ts",
        },
        quarantine,
      ),
    ).toBe(false);
    expect(
      isQuarantinedTestFile(
        {
          workspace: "@papercusp/operator-core",
          file: "lib/hive-federation.test.ts",
        },
        quarantine,
      ),
    ).toBe(true);
    expect(
      isQuarantinedTestFile(
        {
          workspace: "@papercusp/pubsub-substrate",
          file: "src/core/core.test.ts",
        },
        quarantine,
      ),
    ).toBe(true);
  });

  it("turns an all-quarantined p2p/federation failure into a non-gating verdict", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      " FAIL  lib/sync/hyperbee/__tests__/two-peer.test.ts > joins",
      ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)",
      "1 non-quarantined task(s) failed.",
    ].join("\n");
    const q = applyTestQuarantine(out, extractFailingTests(out), quarantine);
    expect(q.allFailuresQuarantined).toBe(true);
    expect(q.failingTests).toEqual([]);
    expect(q.quarantined).toEqual([
      "@papercusp/operator-core::lib/sync/hyperbee/__tests__/two-peer.test.ts",
    ]);
  });

  it("keeps unrelated failures gating while removing quarantined file signatures", () => {
    const out = [
      ">>> @papercusp/operator-core :: npm run test",
      " FAIL  lib/sync/hyperbee/__tests__/two-peer.test.ts > joins",
      " FAIL  lib/work-items-view.integration.test.ts > renders",
      ">>> @papercusp/operator-core FAILED — retrying once (AFFECTED_RETRY_FAILED)",
      "1 non-quarantined task(s) failed.",
    ].join("\n");
    const q = applyTestQuarantine(out, extractFailingTests(out), quarantine);
    expect(q.allFailuresQuarantined).toBe(false);
    expect(q.failingTests).toEqual([
      "@papercusp/operator-core",
      "lib/work-items-view.integration.test.ts",
    ]);
  });
});

describe("decideFlakeAbsorption (pure flake-vs-real decision — NEVER hides a real bug)", () => {
  const ff = (workspace: string, file: string): FailingFile => ({
    workspace,
    file,
  });
  const ir = (
    workspace: string,
    file: string,
    passed: boolean,
    errored = false,
  ): IsolationResult => ({
    workspace,
    file,
    passed,
    errored,
  });

  it("all-flakes: every originally-failing file PASSES in isolation", () => {
    const originalFailing = [
      ff("@p/core", "a.test.ts"),
      ff("@p/core", "b.test.ts"),
    ];
    const isolationResults = [
      ir("@p/core", "a.test.ts", true),
      ir("@p/core", "b.test.ts", true),
    ];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe("all-flakes");
    expect(d.flakeAbsorbed).toEqual([
      "@p/core::a.test.ts",
      "@p/core::b.test.ts",
    ]);
    expect(d.stillFailing).toEqual([]);
  });

  it("real-break: ONE file still fails in isolation ⇒ gate stays red (no hiding)", () => {
    const originalFailing = [
      ff("@p/core", "a.test.ts"),
      ff("@p/core", "b.test.ts"),
    ];
    const isolationResults = [
      ir("@p/core", "a.test.ts", true),
      ir("@p/core", "b.test.ts", false),
    ];
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe("real-break");
    expect(d.stillFailing).toEqual(["@p/core::b.test.ts"]);
  });

  it("real-break: an ERRORED isolation re-run counts as still-failing (fail-safe)", () => {
    const originalFailing = [ff("@p/core", "a.test.ts")];
    const isolationResults = [ir("@p/core", "a.test.ts", false, true)];
    expect(
      decideFlakeAbsorption({ originalFailing, isolationResults }).verdict,
    ).toBe("real-break");
  });

  it("real-break: a MISSING isolation result counts as still-failing (never assume a flake)", () => {
    const originalFailing = [
      ff("@p/core", "a.test.ts"),
      ff("@p/core", "b.test.ts"),
    ];
    const isolationResults = [ir("@p/core", "a.test.ts", true)]; // no result for b
    const d = decideFlakeAbsorption({ originalFailing, isolationResults });
    expect(d.verdict).toBe("real-break");
    expect(d.stillFailing).toEqual(["@p/core::b.test.ts"]);
  });

  it("inconclusive: no originally-failing files (caller keeps the original red verdict)", () => {
    expect(
      decideFlakeAbsorption({ originalFailing: [], isolationResults: [] })
        .verdict,
    ).toBe("inconclusive");
  });
});

// EI-20669541349219660: the gate had a positive feedback loop between how RED it is and
// whether it can produce a verdict at all — first isolation attempts were unbounded (only
// retries had a budget), so a wide-but-<=ISOLATION_MAX_FILES red made the serial isolation
// phase outlast the run's 120m kill budget; the verdict landed as status:'error' with NO
// failing-test list and the next run re-derived the same N failures from scratch, forever.
describe("EI-20669541349219660: isolation phase budget — a wide red yields a verdict instead of outliving the run", () => {
  const files = {
    first: "lib/llm-testing/__tests__/runner-aggregate.test.ts",
    second: "lib/scout/scheduler-workspace-scope.test.ts",
  };

  it("stops STARTING isolation attempts once the phase deadline passes — the red lands, naming the unconfirmed file", async () => {
    let t = 0;
    const ran: string[] = [];
    const isolationRun = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => {
      ran.push(file);
      t += 100; // each attempt advances the fake clock past the deadline below
      return {
        workspace,
        file,
        passed: false,
        durationMs: 100,
        failingCases: ["some-case"],
      };
    };
    const concurrentCalls: string[] = [];
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      isolationRun,
      undefined,
      {
        now: () => t,
        sleep: async () => {},
        phaseDeadlineMs: 50, // passes during the FIRST attempt
        concurrentRun: async ({ workspace }) => {
          concurrentCalls.push(workspace);
          return { workspace, passed: true };
        },
      },
    );
    expect(out.absorbedToGreen).toBe(false);
    // exactly one first attempt ran; the deadline then blocked file 2 AND file 1's retry
    expect(ran).toEqual([files.first]);
    expect(out.note).toContain("PHASE BUDGET EXHAUSTED");
    expect(out.note).toContain(
      `UNCONFIRMED: @papercusp/operator-core::${files.second}`,
    );
    expect(out.note).toContain(
      `CONFIRMED still-failing: @papercusp/operator-core::${files.first}`,
    );
    expect(concurrentCalls).toEqual([]);
    // the re-run accounting still reports what actually ran
    expect(out.retriedTests).toEqual([
      {
        name: `@papercusp/operator-core::${files.first}`,
        attempts: 2,
        outcome: "still-failing",
        via: "load-flake-isolation",
      },
    ]);
  });

  it("deadline already past ⇒ re-runs NOTHING and still returns a real, named red note", async () => {
    const ran: string[] = [];
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      async ({ workspace, file }) => {
        ran.push(file);
        return { workspace, file, passed: true };
      },
      undefined,
      {
        now: () => 100,
        phaseDeadlineMs: 100,
        concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
      },
    );
    expect(ran).toEqual([]);
    expect(out.absorbedToGreen).toBe(false);
    expect(out.note).toContain(`@papercusp/operator-core::${files.first}`);
    expect(out.note).toContain(`@papercusp/operator-core::${files.second}`);
    expect(out.retriedTests).toEqual([]);
  });

  it("CONTROL: a deadline that never binds preserves the absorb path end-to-end (falsifies an inverted comparison)", async () => {
    let t = 0;
    const concurrentCalls: string[] = [];
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      async ({ workspace, file }) => {
        t += 10; // both isolation attempts fit (t reaches 20, always under 1000)
        return { workspace, file, passed: true };
      },
      undefined,
      {
        now: () => t,
        phaseDeadlineMs: 1_000,
        concurrentRun: async ({ workspace }) => {
          concurrentCalls.push(workspace);
          return { workspace, passed: true };
        },
      },
    );
    expect(out.absorbedToGreen).toBe(true);
    expect(concurrentCalls).toEqual(["@papercusp/operator-core"]);
  });

  it("confirm-phase cutoff: isolation finishes exactly AT the deadline ⇒ concurrentRun never starts, absorption declines", async () => {
    let t = 0;
    const concurrentCalls: string[] = [];
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      async ({ workspace, file }) => {
        t += 10;
        return { workspace, file, passed: true };
      },
      undefined,
      {
        now: () => t,
        phaseDeadlineMs: 20, // file1 starts at t=0, file2 at t=10; confirm check sees t=20 >= 20
        concurrentRun: async ({ workspace }) => {
          concurrentCalls.push(workspace);
          return { workspace, passed: true };
        },
      },
    );
    expect(concurrentCalls).toEqual([]);
    expect(out.absorbedToGreen).toBe(false);
    expect(out.note).toContain("UNDETERMINED");
  });
});

describe("isolationPhaseDeadlineMs (EI-20669541349219660)", () => {
  const nowMs = 10_000_000;
  const uptimeMs = 60_000;
  const processStartMs = nowMs - uptimeMs;

  it("manual run: the transported watchdog deadline minus the reserve, anchored at process start", () => {
    const env = {
      [MANUAL_SELF_WATCHDOG_ENV]: String(MIN_MANUAL_SELF_WATCHDOG_MS),
    };
    expect(isolationPhaseDeadlineMs(env, nowMs, uptimeMs)).toBe(
      processStartMs + MIN_MANUAL_SELF_WATCHDOG_MS - ISOLATION_PHASE_RESERVE_MS,
    );
  });

  it("scheduled run: the PARENT's suite-budget mirror, never the 180m parent-death backstop", () => {
    const deadline = isolationPhaseDeadlineMs({}, nowMs, uptimeMs);
    expect(deadline).toBe(
      processStartMs + SUITE_KILL_BUDGET_MIRROR_MS - ISOLATION_PHASE_RESERVE_MS,
    );
    // the self-watchdog (180m) fires only parent-dead; planning against it would let the
    // parent's 120m group-kill land mid-isolation — the exact no-verdict loop this fixes
    expect(deadline).toBeLessThan(
      processStartMs + SELF_WATCHDOG_MS - ISOLATION_PHASE_RESERVE_MS,
    );
  });
});

describe("failing-files marker + emergency-red enrichment (EI-20669541349219660)", () => {
  it("round-trips through the lock dir and is keyed by runId — a stale marker from an earlier run is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-failing-marker-"));
    writeFailingFilesMarker(dir, {
      runId: "run-1",
      files: ["@papercusp/x::lib/a.test.ts", "@papercusp/x::lib/b.test.ts"],
    });
    const marker = readFailingFilesMarker(dir);
    const carried = emergencyRedFailingTests(marker, "run-1");
    expect(carried.failingTests).toEqual([
      "@papercusp/x::lib/a.test.ts",
      "@papercusp/x::lib/b.test.ts",
    ]);
    expect(carried.note).toContain("lib/a.test.ts");
    // wrong runId ⇒ the marker belongs to a PREVIOUS run in the same lock dir
    expect(emergencyRedFailingTests(marker, "run-2")).toEqual({
      failingTests: [],
      note: null,
    });
  });

  it("an absorbed marker reports NO failing tests (they were proven flaky) but says the suite went red first", () => {
    const dir = mkdtempSync(join(tmpdir(), "gc-failing-marker-"));
    writeFailingFilesMarker(dir, {
      runId: "run-1",
      files: ["@papercusp/x::lib/a.test.ts"],
      absorbed: true,
    });
    const carried = emergencyRedFailingTests(
      readFailingFilesMarker(dir),
      "run-1",
    );
    expect(carried.failingTests).toEqual([]);
    expect(carried.note).toContain("ABSORBED");
  });

  it("missing or garbled marker degrades to the pre-marker empty list, never a crash", () => {
    expect(
      readFailingFilesMarker(join(tmpdir(), "gc-no-such-dir-xyz")),
    ).toBeNull();
    expect(emergencyRedFailingTests(null, "run-1")).toEqual({
      failingTests: [],
      note: null,
    });
    const dir = mkdtempSync(join(tmpdir(), "gc-failing-marker-"));
    writeFileSync(join(dir, "failing-files.json"), "not json {{{");
    expect(readFailingFilesMarker(dir)).toBeNull();
  });
});

describe("attemptFlakeAbsorption (orchestration — injected isolation runner)", () => {
  it("absorbs the 2026-06-23 incident: both files pass in isolation ⇒ green", async () => {
    const ran: string[] = [];
    const isolationRun = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => {
      ran.push(`${workspace}::${file}`);
      return { workspace, file, passed: true }; // both pass at single concurrency
    };
    // WI-6956: absorption now also requires the CONFIRMING co-execution pass. The
    // 2026-06-23 incident was genuine box-weather, so the files pass together too.
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      isolationRun,
      undefined,
      {
        concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
      },
    );
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual([
      "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
      "@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts",
    ]);
    // it actually re-ran each originally-failing file
    expect(ran).toHaveLength(2);
  });

  // EI-18685042025868279: a green verdict reported failingTests:[] whether every test
  // passed first time or whether failures were absorbed by re-runs — the two rendered
  // identically, so a retry-absorbed green (a live flake, or a live intermittent bug) was
  // indistinguishable from a clean pass. These guard the accounting that makes them
  // distinguishable.
  describe("retriedTests — a green must not hide that it needed re-runs [EI-18685042025868279]", () => {
    it("reports each re-run file with a MEASURED attempt count and its outcome", async () => {
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: true,
      });
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        {
          concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
        },
      );
      expect(out.absorbedToGreen).toBe(true);
      expect(out.retriedTests).toEqual([
        {
          name: "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
          // 2 = the original full-suite run that failed + the ONE isolation run that passed.
          // Passing first time in isolation means no retry was spent.
          attempts: 2,
          outcome: "passed-on-rerun",
          via: "load-flake-isolation",
        },
        {
          name: "@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts",
          attempts: 2,
          outcome: "passed-on-rerun",
          via: "load-flake-isolation",
        },
      ]);
    });

    it("counts the RETRY: a file that fails once then passes reports 3 attempts, not 2", async () => {
      // The attempt count must be measured, not assumed — this is the case that separates
      // a real counter from a hardcoded 2.
      const seen = new Map<string, number>();
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        const n = (seen.get(file) ?? 0) + 1;
        seen.set(file, n);
        // Fail the first isolation attempt, pass the retry. Distinct case lists keep
        // isDeterministicFailureShape from short-circuiting the retry.
        return {
          workspace,
          file,
          passed: n > 1,
          failingCases: n > 1 ? [] : [`case-${n}`],
        };
      };
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        {
          sleep: async () => {},
          concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
        },
      );
      expect(out.absorbedToGreen).toBe(true);
      expect(out.retriedTests.map((t) => t.attempts)).toEqual([3, 3]);
      expect(
        out.retriedTests.every((t) => t.outcome === "passed-on-rerun"),
      ).toBe(true);
    });

    it("reports re-runs even when it DECLINES to absorb — a red that cost N re-runs is not a red that failed fast", async () => {
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: file.includes("runner-aggregate"),
      });
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.retriedTests).toHaveLength(2);
      expect(
        out.retriedTests.find((t) =>
          t.name.includes("scheduler-workspace-scope"),
        )?.outcome,
      ).toBe("still-failing");
      expect(
        out.retriedTests.find((t) => t.name.includes("runner-aggregate"))
          ?.outcome,
      ).toBe("passed-on-rerun");
    });

    it("an early exit that never re-ran anything reports NO retries (not a fabricated empty run)", async () => {
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: true,
      });
      // A build break: no parseable failing test files, so the absorber returns before the
      // isolation loop. Nothing was re-run, and it must not claim otherwise.
      const out = await attemptFlakeAbsorption(
        "=== SPA BUILD FAILED (@papercusp/operator-vite) ===",
        isolationRun,
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.retriedTests).toEqual([]);
    });
  });

  it("does NOT absorb when a file still fails in isolation (real break stays red)", async () => {
    const isolationRun = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => ({
      workspace,
      file,
      passed: file.includes("runner-aggregate"), // scheduler-workspace-scope STILL fails
    });
    // EI-18104902318285612: the still-failing file re-fails on every attempt, so this
    // exercises the ISOLATION_RETRY_MAX(=1) retry — inject a no-op sleep so the real
    // ISOLATION_RETRY_DELAY_MS (5s) setTimeout never fires (host-load-correlated flake).
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      isolationRun,
      undefined,
      { sleep: async () => {} },
    );
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  // EI-18673560248447615: the verdict note is what an agent reads to decide whether a red
  // is theirs. Before this, it named the FILE and (post-EI-18669336904251384) ruled out
  // load — but never said WHAT failed, so triage still meant opening a separate ~5000-line
  // full-suite log. Regression-guard both the retry line and the verdict note.
  describe("names the failing CASES so triage never needs the separate full-suite log", () => {
    const outWithCases = [
      "Affected workspaces (1): @papercusp/operator-core",
      "",
      ">>> @papercusp/operator-core :: npm run test",
      " ❯ lib/scout/scheduler-workspace-scope.test.ts (4 tests | 1 failed) 120ms",
      "     × schedules within the workspace scope 22ms",
      ">>> @papercusp/operator-core FAILED",
      "",
      "1 non-quarantined task(s) failed.",
    ].join("\n");

    it("puts the case name in the red VERDICT note", async () => {
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 22,
      });
      const out = await attemptFlakeAbsorption(
        outWithCases,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain("schedules within the workspace scope");
      expect(out.note).toContain("lib/scout/scheduler-workspace-scope.test.ts");
    });

    it("puts the case name on the retry line too, alongside the not-load attribution", async () => {
      const logs: string[] = [];
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 22, // < ISOLATION_LOAD_STARVATION_MIN_MS ⇒ "too fast to be load-starved"
      });
      await attemptFlakeAbsorption(
        outWithCases,
        isolationRun,
        (s) => logs.push(s),
        { sleep: async () => {} },
      );
      const retryLine = logs.find((l) =>
        l.includes("still failing after attempt"),
      );
      expect(retryLine).toBeDefined();
      expect(retryLine).toContain("too fast to be load-starved");
      expect(retryLine).toContain("schedules within the workspace scope");
    });

    it("still reads correctly when no case names are parseable (build break)", async () => {
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
      });
      // INCIDENT_OUTPUT has failing FILES but no `×` case rows.
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(out.note).toContain("STILL FAILED in isolation");
      expect(out.note).not.toContain("failed case(s)");
    });
  });

  it("a THROWING isolation runner defaults to red (uncertainty never flips to green)", async () => {
    const isolationRun = async (): Promise<IsolationResult> => {
      throw new Error("vitest spawn failed");
    };
    // EI-18104902318285612: throws on every attempt too — same retry path, same no-op
    // sleep seam to keep this a fast, deterministic unit test.
    const out = await attemptFlakeAbsorption(
      INCIDENT_OUTPUT,
      isolationRun,
      undefined,
      { sleep: async () => {} },
    );
    expect(out.absorbedToGreen).toBe(false);
  });

  it("a build break / non-vitest red (no parseable files) stays red — never re-runs", async () => {
    let called = false;
    const isolationRun = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption(
      "=== SPA BUILD FAILED (@papercusp/operator-vite) ===",
      isolationRun,
    );
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // nothing to re-run
  });

  it("a BROAD red (> ISOLATION_MAX_FILES files) is a real regression — never absorbed", async () => {
    const lines = [">>> @papercusp/operator-core :: npm run test"];
    for (let i = 0; i <= ISOLATION_MAX_FILES; i++)
      lines.push(` FAIL  lib/f${i}.test.ts > case`);
    let called = false;
    const isolationRun = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => {
      called = true;
      return { workspace, file, passed: true };
    };
    const out = await attemptFlakeAbsorption(lines.join("\n"), isolationRun);
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a broad red is never load-flake absorption
  });

  // isolation-retry-resilience-2026-07-19 (EI-15849): a single isolated re-run can ITSELF
  // be starved by AMBIENT host-wide load (other pots' suites, federation, concurrent SU
  // builds) — not just the checkpoint's own 8-fork contention, which single-concurrency
  // already neutralizes. The reproduced incident: an operator-core/endpoint-route cluster
  // failed the gate AND its first isolation attempt while loadavg sat at 99+/128 cores, but
  // reproduced clean once load had dropped. A bounded per-file retry is the recurrence
  // guard: it must absorb a file that fails once then passes on retry, and it must NEVER
  // absorb a file that keeps failing across every retry (no weakening of the fail-safe).
  describe("isolation retry hardening (ambient-load resilience, never weakens fail-safe)", () => {
    it("surfaces a measured failure-shape aggregate for final deterministic isolation failures", async () => {
      const out = await attemptFlakeAbsorption(
        [
          ">>> @papercusp/operator-core :: npm run test",
          " FAIL  lib/cell-access-parity.test.ts > registry parity",
          ">>> @papercusp/operator-core FAILED",
        ].join("\n"),
        async ({ workspace, file }) => ({
          workspace,
          file,
          passed: false,
          hasAssertionSignature: true,
          durationMs: 11_307,
        }),
        undefined,
        {
          retryMax: 0,
          loadPerCore: () => 0.4,
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.failureShape).toEqual({
        count: 1,
        deterministic: 1,
        timeout: 0,
        unclassified: 0,
        maxLoadavgPerCore: 0.4,
      });
    });

    it("a file that FAILS on attempt 1 but PASSES on retry is absorbed to green (transient ambient-load blip)", async () => {
      const attempts: Record<string, number> = {};
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        const key = `${workspace}::${file}`;
        attempts[key] = (attempts[key] ?? 0) + 1;
        // fails on the first attempt only, for EVERY originally-failing file
        return { workspace, file, passed: attempts[key] > 1 };
      };
      const sleeps: number[] = [];
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          // WI-6956: EI-15849 was genuine ambient load — once the box settled the files
          // pass CO-EXECUTED too, so the confirming pass must not block this absorption.
          concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
        },
      );
      expect(out.absorbedToGreen).toBe(true);
      expect(out.flakeSuspects).toEqual([
        "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts",
        "@papercusp/operator-core::lib/scout/scheduler-workspace-scope.test.ts",
      ]);
      // exactly one retry per originally-failing file (2 files ⇒ 2 delays)
      expect(sleeps).toHaveLength(2);
      expect(Object.values(attempts)).toEqual([2, 2]);
    });

    it("a file that STILL fails on every retry stays a real break — retries never manufacture a false green", async () => {
      const attempts: Record<string, number> = {};
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        const key = `${workspace}::${file}`;
        attempts[key] = (attempts[key] ?? 0) + 1;
        // 'runner-aggregate' is a genuine, deterministic break — fails on EVERY attempt
        return {
          workspace,
          file,
          passed:
            !file.includes("runner-aggregate") || attempts[key] > 1
              ? !file.includes("runner-aggregate")
              : false,
        };
      };
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        {
          sleep: async () => {},
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      // retried up to (1 + ISOLATION_RETRY_MAX) times before giving up
      expect(
        attempts[
          "@papercusp/operator-core::lib/llm-testing/__tests__/runner-aggregate.test.ts"
        ],
      ).toBe(1 + ISOLATION_RETRY_MAX);
    });

    it("respects the overall retry time budget — once exhausted, no further retries are attempted (bounded worst-case)", async () => {
      let calls = 0;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        calls++;
        return { workspace, file, passed: false }; // always fails
      };
      let elapsed = 0;
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        undefined,
        {
          sleep: async () => {},
          now: () => {
            elapsed += 1000;
            return elapsed;
          },
          retryBudgetMs: 500, // exhausted immediately — the very first budget check fails
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      // exactly one attempt per file — no retry once the budget is already spent
      expect(calls).toBe(2);
    });

    // EI-18669336904251384: the retry-loop log must not assert "ambient host load"
    // unconditionally — a MEASURED green-checkpoint incident (2026-07-25) showed the
    // message firing for failures that completed in 11-32ms on an UNSATURATED host, while
    // the real cause was a stale candidate whose fix had already landed at tip. Gate the
    // wording on the isolation attempt's own measured duration.
    it("a FAST failing attempt (< ISOLATION_LOAD_STARVATION_MIN_MS) is logged as NOT load-starved", async () => {
      const logs: string[] = [];
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: 23, // measured incident magnitude (11-32ms)
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        { sleep: async () => {} },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain("finished in 23ms");
        expect(line).toContain("too fast to be load-starved");
        expect(line).not.toContain(
          "ambient host load, not just the checkpoint",
        );
      }
    });

    it("a SLOW failing attempt on a SATURATED host is logged as consistent with ambient load", async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        {
          sleep: async () => {},
          // The box really was oversubscribed — 1.5 runnable tasks per core.
          loadPerCore: () => ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE + 0.5,
        },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain("consistent with ambient host load");
        expect(line).toContain("loadavg/core 1.50"); // the reader can check the claim
      }
    });

    // EI-19368177649203822 / EI-19367962245538796 — THE RECURRENCE GUARD. A duration-only
    // test blamed ambient load for 7 of 7 isolation failures in the 2026-08-02 18:02:14Z
    // verdict, because `durationMs` wraps the whole vitest spawn (boot + transform + import
    // = 5-25s) and so ALWAYS clears the 1s bound. That boilerplate read as a gate defect:
    // two agents filed contradictory bugs from it, and one proposed promoting the prose to a
    // CLASSIFICATION — which would have absorbed nearly every red into a false green. A slow
    // failure on an IDLE box must therefore never be attributed to load.
    it("a SLOW failing attempt on an UNSATURATED host is NOT blamed on ambient load", async () => {
      const logs: string[] = [];
      const slowMs = 19_137; // the measured adv-agent-detail.test.ts attempt from that verdict
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        {
          sleep: async () => {},
          loadPerCore: () => 0.1, // plenty of free cores — nothing was starving this run
        },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain("NOT a supported explanation");
        expect(line).toContain("loadavg/core 0.10");
        // The precise regression: the old duration-only rule emitted this for exactly this input.
        expect(line).not.toContain("consistent with ambient host load");
      }
    });

    // EI-19369790810564409: a deterministic AssertionError signature must win over the
    // load-based wording UNCONDITIONALLY — even on a genuinely SATURATED host, where the
    // pre-existing load-corroboration guard (EI-19368177649203822) would otherwise still
    // print "consistent with ambient host load" for a failure that is provably not
    // load-shaped (a saturated CPU can only make a comparison slower, never wrong).
    it("a SLOW failing attempt with an assertion signature is NOT blamed on ambient load, even on a saturated host", async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
        hasAssertionSignature: true,
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        {
          sleep: async () => {},
          // The box really is oversubscribed — if load alone drove the wording, this would
          // read "consistent with ambient host load". It must not.
          loadPerCore: () => ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE + 0.5,
        },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain(`took ${slowMs}ms`);
        expect(line).toContain("deterministic AssertionError, not a timeout");
        expect(line).toContain("NOT load-shaped however busy the host is");
        expect(line).not.toContain("consistent with ambient host load");
      }
    });

    it("a SLOW non-Vitest deterministic failure marker is NOT blamed on ambient load", async () => {
      const logs: string[] = [];
      const slowMs = ISOLATION_LOAD_STARVATION_MIN_MS + 5_000;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        durationMs: slowMs,
        hasDeterministicFailureSignature: true,
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        {
          sleep: async () => {},
          loadPerCore: () => ISOLATION_LOAD_STARVATION_MIN_LOAD_PER_CORE + 0.5,
        },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain("deterministic failure evidence, not a timeout");
        expect(line).toContain("NOT load-shaped however busy the host is");
        expect(line).not.toContain("consistent with ambient host load");
      }
    });

    it("a failing attempt with NO measured duration falls back to the unattributed wording", async () => {
      const logs: string[] = [];
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => ({
        workspace,
        file,
        passed: false,
        // durationMs omitted (e.g. a hand-built test double, or a future caller that
        // hasn't wired timing) — must not silently masquerade as load evidence.
      });
      await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        isolationRun,
        (s) => logs.push(s),
        { sleep: async () => {} },
      );
      const attributionLines = logs.filter((l) =>
        l.includes("still failing after attempt"),
      );
      expect(attributionLines.length).toBeGreaterThan(0);
      for (const line of attributionLines) {
        expect(line).toContain("duration not measured");
      }
    });
  });

  // WI-6969: the retry loop's "cheap first cut" — a static/structural assertion (compares
  // two in-process data structures, no I/O, no timing) reproduces byte-identically on
  // every attempt, so retrying it can never change the outcome. The observed incident
  // blamed "ambient host load" for three such assertions and burned a retry cycle on each
  // before giving up. This short-circuits the retry the moment an attempt's own failure
  // shape already proves determinism.
  describe("WI-6969: failure-shape short-circuit (skip a retry that is already proven doomed)", () => {
    const outWithMatchingCase = [
      "Affected workspaces (1): @papercusp/operator-core",
      "",
      ">>> @papercusp/operator-core :: npm run test",
      " ❯ lib/sync-resolver/resolver-backing-table-coverage.test.ts (1 tests | 1 failed) 14095ms",
      "     × every registry entry either declares backingTables or is in the baseline 14095ms",
      ">>> @papercusp/operator-core FAILED",
      "",
      "1 non-quarantined task(s) failed.",
    ].join("\n");

    const outWithTimeoutCase = [
      "Affected workspaces (1): @papercusp/operator-core",
      "",
      ">>> @papercusp/operator-core :: npm run test",
      " ❯ lib/scout/scheduler-workspace-scope.test.ts (12 tests | 1 failed) 21034ms",
      "     × schedules within the workspace scope 21034ms",
      ">>> @papercusp/operator-core FAILED",
      "",
      "1 non-quarantined task(s) failed.",
    ].join("\n");

    it("an attempt matching the ORIGINAL failure exactly (same case, no timing signature) skips the retry entirely", async () => {
      let calls = 0;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 14095,
          failingCases: [
            "every registry entry either declares backingTables or is in the baseline",
          ],
          hasTimingSignature: false,
        };
      };
      const logs: string[] = [];
      const out = await attemptFlakeAbsorption(
        outWithMatchingCase,
        isolationRun,
        (s) => logs.push(s),
        {
          // If the short-circuit fails to fire, this would sleep for real — fail loudly
          // instead of silently passing a slow test.
          sleep: async () => {
            throw new Error(
              "should not sleep — the retry must be skipped by the shape short-circuit",
            );
          },
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1); // no retry — abandoned after the first attempt
      const abandonLine = logs.find((l) =>
        l.includes("abandoning remaining retry budget"),
      );
      expect(abandonLine).toBeDefined();
      expect(abandonLine).toContain("IDENTICAL case list");
      expect(abandonLine).toContain(
        "every registry entry either declares backingTables or is in the baseline",
      );
      // never reached the load-attribution retry line — the short-circuit fires first
      expect(logs.some((l) => l.includes("still failing after attempt"))).toBe(
        false,
      );
    });

    it("a MATCHING case list but WITH a timing signature does NOT skip the retry (a load-sensitive timeout can reproduce identically)", async () => {
      let calls = 0;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 21034,
          failingCases: ["schedules within the workspace scope"],
          hasTimingSignature: true, // e.g. output containing "Test timed out in 20000ms"
        };
      };
      const out = await attemptFlakeAbsorption(
        outWithTimeoutCase,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX); // retried as before — unchanged behavior
    });

    it("a DIFFERENT case list does not trigger the short-circuit (unchanged retry behavior)", async () => {
      let calls = 0;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        calls++;
        return {
          workspace,
          file,
          passed: false,
          durationMs: 14095,
          failingCases: ["a wholly different case than the original failure"],
          hasTimingSignature: false,
        };
      };
      const out = await attemptFlakeAbsorption(
        outWithMatchingCase,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX); // retried as before — unchanged behavior
    });

    it("an attempt with NO failingCases (a hand-built fixture, or a build-break output) never short-circuits", async () => {
      // Regression guard: every pre-existing test in this file constructs IsolationResult
      // without failingCases/hasTimingSignature. The short-circuit must stay inert for them.
      let calls = 0;
      const isolationRun = async ({
        workspace,
        file,
      }: {
        workspace: string;
        file: string;
      }): Promise<IsolationResult> => {
        calls++;
        return { workspace, file, passed: false, durationMs: 14095 };
      };
      await attemptFlakeAbsorption(
        outWithMatchingCase,
        isolationRun,
        undefined,
        { sleep: async () => {} },
      );
      expect(calls).toBe(1 + ISOLATION_RETRY_MAX);
    });
  });

  describe("isDeterministicFailureShape / outputHasTimingSignature (WI-6969, pure)", () => {
    const attempt = (over: Partial<IsolationResult> = {}): IsolationResult => ({
      workspace: "@p/core",
      file: "a.test.ts",
      passed: false,
      ...over,
    });

    it("true: identical non-empty case sets (order-independent), no timing signature", () => {
      expect(
        isDeterministicFailureShape({
          originalCases: ["a", "b"],
          attempt: attempt({ failingCases: ["b", "a"] }),
        }),
      ).toBe(true);
    });

    it("false: original cases missing or empty (nothing to compare against)", () => {
      expect(
        isDeterministicFailureShape({
          originalCases: undefined,
          attempt: attempt({ failingCases: ["a"] }),
        }),
      ).toBe(false);
      expect(
        isDeterministicFailureShape({
          originalCases: [],
          attempt: attempt({ failingCases: ["a"] }),
        }),
      ).toBe(false);
    });

    it("false: the attempt has no failing cases parsed", () => {
      expect(
        isDeterministicFailureShape({
          originalCases: ["a"],
          attempt: attempt(),
        }),
      ).toBe(false);
    });

    it("false: the case sets differ", () => {
      expect(
        isDeterministicFailureShape({
          originalCases: ["a"],
          attempt: attempt({ failingCases: ["b"] }),
        }),
      ).toBe(false);
    });

    it("false: a timing signature is present even when the case list matches exactly (fail-safe)", () => {
      expect(
        isDeterministicFailureShape({
          originalCases: ["a"],
          attempt: attempt({ failingCases: ["a"], hasTimingSignature: true }),
        }),
      ).toBe(false);
    });

    it("outputHasTimingSignature detects waitFor / Timed out / Exceeded timeout, case-insensitively", () => {
      expect(
        outputHasTimingSignature("something using waitFor(...) internally"),
      ).toBe(true);
      expect(outputHasTimingSignature("Test timed out in 5000ms")).toBe(true);
      expect(
        outputHasTimingSignature("Exceeded timeout of 5000ms for a hook"),
      ).toBe(true);
      expect(
        outputHasTimingSignature("every registry entry is in the baseline"),
      ).toBe(false);
    });

    // EI-19369790810564409: outputHasAssertionSignature mirrors outputHasTimingSignature —
    // direct, positive evidence of a deterministic vitest assertion failure, independent of
    // the case-list comparison isDeterministicFailureShape needs.
    it('outputHasAssertionSignature detects AssertionError / "expected ... to ..." diffs, case-insensitively', () => {
      expect(
        outputHasAssertionSignature(
          "AssertionError: expected [ 'a', 'b' ] to deeply equal []",
        ),
      ).toBe(true);
      expect(
        outputHasAssertionSignature("assertionerror: something failed"),
      ).toBe(true);
      expect(outputHasAssertionSignature("expected 3 to equal 4")).toBe(true);
      expect(
        outputHasAssertionSignature("every registry entry is in the baseline"),
      ).toBe(false);
    });

    it("outputHasDeterministicFailureSignature recognizes shell selftest and probe-drift failures, but not timeouts", () => {
      expect(
        outputHasDeterministicFailureSignature(
          "FAIL — b9-attestation-precondition selftest: 2 check(s) failed",
        ),
      ).toBe(true);
      expect(
        outputHasDeterministicFailureSignature(
          "b3-revocation-kcut.selftest: FAIL (1)",
        ),
      ).toBe(true);
      expect(
        outputHasDeterministicFailureSignature("✗ static probe is missing"),
      ).toBe(true);
      expect(
        outputHasDeterministicFailureSignature(
          "Error: bench probe drift: packages/operator-core/lib/pty-bridge.ts:166 no longer contains 'managedSetInterval'",
        ),
      ).toBe(true);
      expect(
        outputHasDeterministicFailureSignature(
          "FAIL — suite failed\nTest timed out in 5000ms",
        ),
      ).toBe(false);
      expect(
        outputHasDeterministicFailureSignature(
          " FAIL  lib/example.test.ts > waits for the service",
        ),
      ).toBe(false);
    });
  });

  // WI-6956: the absorber's discriminator ("passes in isolation") IS the defining
  // property of a concurrency-dependent failure class, so for that class it was
  // structurally blind — and the only thing preventing a false green was
  // ISOLATION_MAX_FILES declining to look at a big red. That makes the bug fire on
  // PROGRESS: shrink such a class past the guard and the gate flips green on a broken
  // tree. These pin the confirming co-execution pass that closes it.
  describe("WI-6956 confirming co-execution pass (a concurrency-dependent class is never absorbed)", () => {
    /** Every file passes ALONE — the signature shared by genuine weather AND by the bug. */
    const passesAlone = async ({
      workspace,
      file,
    }: {
      workspace: string;
      file: string;
    }): Promise<IsolationResult> => ({
      workspace,
      file,
      passed: true,
    });

    it("THE RECURRENCE GUARD: files that all pass ALONE but REPRODUCE co-executed are NOT absorbed", async () => {
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        passesAlone,
        undefined,
        {
          // the no-real-PG rail's exact shape: clean alone, fails the moment they run together
          concurrentRun: async ({ workspace }) => ({
            workspace,
            passed: false,
          }),
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.flakeSuspects).toEqual([]);
      expect(out.note).toContain("REPRODUCED");
      expect(out.note).toContain("CONCURRENCY-DEPENDENT DEFECT");
    });

    it("passes the originally-failing files of each workspace to the confirming run, TOGETHER", async () => {
      const batches: { workspace: string; files: string[] }[] = [];
      await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone, undefined, {
        concurrentRun: async ({ workspace, files }) => {
          batches.push({ workspace, files });
          return { workspace, passed: true };
        },
      });
      // one co-executed batch for the single workspace, carrying BOTH failing files
      expect(batches).toHaveLength(1);
      expect(batches[0].workspace).toBe("@papercusp/operator-core");
      expect(batches[0].files).toEqual([
        "lib/llm-testing/__tests__/runner-aggregate.test.ts",
        "lib/scout/scheduler-workspace-scope.test.ts",
      ]);
    });

    it("an ABSENT confirming runner declines to absorb (fail-safe, never the old pass-alone criterion)", async () => {
      const out = await attemptFlakeAbsorption(INCIDENT_OUTPUT, passesAlone);
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain("NO confirming co-execution re-run");
    });

    it("a THROWING confirming runner is undetermined ⇒ stays red (uncertainty never flips green)", async () => {
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        passesAlone,
        undefined,
        {
          concurrentRun: async () => {
            throw new Error("vitest spawn failed");
          },
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain("UNDETERMINED");
    });

    it("an ERRORED confirming result is undetermined ⇒ stays red", async () => {
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        passesAlone,
        undefined,
        {
          concurrentRun: async ({ workspace }) => ({
            workspace,
            passed: false,
            errored: true,
          }),
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(out.note).toContain("UNDETERMINED");
    });

    it("EI-15849 stays absorbable: genuine weather passes co-executed once the box settles", async () => {
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        passesAlone,
        undefined,
        {
          concurrentRun: async ({ workspace }) => ({ workspace, passed: true }),
        },
      );
      expect(out.absorbedToGreen).toBe(true);
      expect(out.note).toContain("CO-EXECUTED");
    });

    it("the confirming pass never runs at all when isolation already found a real break", async () => {
      let confirmCalled = false;
      const out = await attemptFlakeAbsorption(
        INCIDENT_OUTPUT,
        async ({ workspace, file }) => ({ workspace, file, passed: false }),
        undefined,
        {
          sleep: async () => {},
          concurrentRun: async ({ workspace }) => {
            confirmCalled = true;
            return { workspace, passed: true };
          },
        },
      );
      expect(out.absorbedToGreen).toBe(false);
      expect(confirmCalled).toBe(false);
    });
  });

  describe("decideConcurrencyConfirmation (pure)", () => {
    const ff = (workspace: string, file: string) => ({ workspace, file });

    it("weather: every workspace passed co-executed", () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [
          ff("@p/core", "a.test.ts"),
          ff("@p/core", "b.test.ts"),
        ],
        concurrentResults: [{ workspace: "@p/core", passed: true }],
      });
      expect(d.verdict).toBe("weather");
    });

    it("reproduced: any workspace failing co-executed wins over an undetermined sibling", () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [
          ff("@p/core", "a.test.ts"),
          ff("@p/web", "b.test.ts"),
        ],
        concurrentResults: [
          { workspace: "@p/core", passed: false },
          { workspace: "@p/web", passed: false, errored: true },
        ],
      });
      expect(d.verdict).toBe("reproduced");
      expect(d.reproducedIn).toEqual(["@p/core"]);
      expect(d.undeterminedIn).toEqual(["@p/web"]);
    });

    it("undetermined: a workspace with NO confirming result is never assumed to have passed", () => {
      const d = decideConcurrencyConfirmation({
        originalFailing: [
          ff("@p/core", "a.test.ts"),
          ff("@p/web", "b.test.ts"),
        ],
        concurrentResults: [{ workspace: "@p/core", passed: true }], // nothing for @p/web
      });
      expect(d.verdict).toBe("undetermined");
      expect(d.undeterminedIn).toEqual(["@p/web"]);
    });

    it("undetermined: no originally-failing files (nothing was confirmed)", () => {
      expect(
        decideConcurrencyConfirmation({
          originalFailing: [],
          concurrentResults: [],
        }).verdict,
      ).toBe("undetermined");
    });
  });
});

// worker-pool-crash-absorption-2026-06-25 (WI-806): the SAFE worker-pool-crash absorber.
// The incident: @papercusp/operator-core's `vitest run --passWithNoTests` CRASHED a worker
// fork (ENOMEM/OOM-kill under the shared box's fleet load) — `[vitest-pool]: Worker forks
// emitted error` / `Worker exited unexpectedly` — with NO per-file `FAIL` rows. The
// existing per-file isolation absorber parsed ZERO files and fell through to a hard RED
// that wedged the release pipeline 5× in a row. These cover the pure classify + parse +
// orchestration without real vitest. The exact crash signature from the real checkpoint log:
const WORKER_CRASH_OUTPUT = [
  ">>> @papercusp/operator-core :: npm run test",
  "Error: [vitest-pool]: Worker forks emitted error.",
  "    ❯ EventEmitter.<anonymous> ../../node_modules/vitest/dist/chunks/cli-api.js:3446:22",
  "Caused by: Error: Worker exited unexpectedly",
  "    ❯ ChildProcess.emitUnexpectedExit ../../node_modules/vitest/dist/chunks/cli-api.js:3012:33",
  "",
  "npm error Lifecycle script `test` failed with error:",
  "npm error code 1",
  "npm error workspace @papercusp/operator-core@0.1.0",
  "npm error location /home/x/papercup-checkpoint/packages/operator-core",
  "npm error command sh -c vitest run --passWithNoTests",
  "",
  "1 non-quarantined task(s) failed.",
].join("\n");

describe("isWorkerPoolCrash + parseCrashedWorkspaces (WI-806)", () => {
  it("classifies the real worker-pool crash output as a pool crash", () => {
    expect(isWorkerPoolCrash(WORKER_CRASH_OUTPUT)).toBe(true);
    expect(isWorkerPoolCrash("Worker terminated")).toBe(true);
  });

  it("is NOT a pool crash for an ordinary test failure", () => {
    expect(
      isWorkerPoolCrash(
        " FAIL  lib/x.test.ts > case\nAssertionError: expected 1 to be 2",
      ),
    ).toBe(false);
  });

  it("harvests the crashed workspace from the `npm error workspace` footer (strips @version)", () => {
    expect(parseCrashedWorkspaces(WORKER_CRASH_OUTPUT)).toEqual([
      "@papercusp/operator-core",
    ]);
  });

  it("falls back to the `>>>` section header when no npm-error-workspace footer is present", () => {
    const out =
      ">>> @papercusp/agent-mcp :: npm run test\nError: [vitest-pool]: Worker forks emitted error.";
    expect(parseCrashedWorkspaces(out)).toEqual(["@papercusp/agent-mcp"]);
  });

  it("returns [] when no workspace is localizable", () => {
    expect(parseCrashedWorkspaces("Worker exited unexpectedly")).toEqual([]);
  });
});

describe("attemptWorkerCrashAbsorption (WI-806 — absorb-or-retry the no-signature crash)", () => {
  it("(a) crash + zero parseable files + passing re-run ⇒ green + flakeSuspect", async () => {
    const ran: string[] = [];
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => {
      ran.push(workspace);
      return { workspace, passed: true }; // passes cleanly at reduced concurrency
    };
    const out = await attemptWorkerCrashAbsorption(
      WORKER_CRASH_OUTPUT,
      workspaceRerun,
    );
    expect(out.absorbedToGreen).toBe(true);
    expect(out.flakeSuspects).toEqual([
      "@papercusp/operator-core (worker-pool crash)",
    ]);
    expect(ran).toEqual(["@papercusp/operator-core"]); // it actually re-ran the crashed ws
  });

  it("(b) crash + re-run STILL crashes ⇒ red (never blanket-green a crash)", async () => {
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      crashedAgain: true,
    });
    const out = await attemptWorkerCrashAbsorption(
      WORKER_CRASH_OUTPUT,
      workspaceRerun,
    );
    expect(out.absorbedToGreen).toBe(false);
    expect(out.flakeSuspects).toEqual([]);
  });

  it("(b2) crash + re-run reveals a REAL per-file failure ⇒ red", async () => {
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: false,
      realFailure: true,
    });
    expect(
      (await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun))
        .absorbedToGreen,
    ).toBe(false);
  });

  it("(b3) a THROWING re-run defaults to red (uncertainty never flips to green)", async () => {
    const workspaceRerun = async (): Promise<WorkspaceRerunResult> => {
      throw new Error("vitest spawn failed");
    };
    expect(
      (await attemptWorkerCrashAbsorption(WORKER_CRASH_OUTPUT, workspaceRerun))
        .absorbedToGreen,
    ).toBe(false);
  });

  it("(c) a REAL per-file failure is NEVER mistaken for a worker-crash flake (no re-run)", async () => {
    // Ordinary red WITH parseable per-file failures — not a pool crash. Even if it also
    // contained a pool marker, the parseable per-file failures route it to the isolation
    // absorber, never this workspace re-run.
    let called = false;
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(
      INCIDENT_OUTPUT,
      workspaceRerun,
    );
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false); // a genuine test failure is never re-run as a crash flake
  });

  it("(c2) a pool crash that STILL named per-file failures defers to the isolation absorber (no workspace re-run)", async () => {
    const withFiles =
      WORKER_CRASH_OUTPUT + "\n FAIL  lib/real.test.ts > a case";
    let called = false;
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    expect(
      (await attemptWorkerCrashAbsorption(withFiles, workspaceRerun))
        .absorbedToGreen,
    ).toBe(false);
    expect(called).toBe(false);
  });

  it("a BROAD multi-workspace crash (> WORKER_CRASH_MAX_WORKSPACES) is a real regression — never absorbed", async () => {
    const lines = ["Error: [vitest-pool]: Worker forks emitted error."];
    for (let i = 0; i <= WORKER_CRASH_MAX_WORKSPACES; i++)
      lines.push(`npm error workspace @p/ws${i}@1.0.0`);
    let called = false;
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => {
      called = true;
      return { workspace, passed: true };
    };
    const out = await attemptWorkerCrashAbsorption(
      lines.join("\n"),
      workspaceRerun,
    );
    expect(out.absorbedToGreen).toBe(false);
    expect(called).toBe(false);
  });

  it("one of two crashed workspaces still failing ⇒ red (all must pass to absorb)", async () => {
    const out2 = WORKER_CRASH_OUTPUT.replace(
      "npm error workspace @papercusp/operator-core@0.1.0",
      "npm error workspace @papercusp/operator-core@0.1.0\nnpm error workspace @papercusp/agent-mcp@0.1.0",
    );
    const workspaceRerun = async ({
      workspace,
    }: {
      workspace: string;
    }): Promise<WorkspaceRerunResult> => ({
      workspace,
      passed: workspace === "@papercusp/operator-core", // agent-mcp still fails
    });
    expect(
      (await attemptWorkerCrashAbsorption(out2, workspaceRerun))
        .absorbedToGreen,
    ).toBe(false);
  });
});

// P-016 (release-pipeline-resilience-2026-06-09 D-010): longest-green-PREFIX FF — a red
// batch TIP no longer holds the clean prefix hostage. The invariant under test: `main`
// only ever FFs to a commit that ITSELF ran green (the confirm-run), so a wrong prefix
// guess just holds (today's behavior), never deploys untested code. Env-armed (default-OFF).
describe("runGreenCheckpoint — longest-green-prefix (P-016)", () => {
  // Build a real commit chain c1(ready) → c2 → c3 → c4(candidate) so advanceReady /
  // isAncestor work; stub the NEW deps (commitsInRange / affectedWorkspacesForRange) and
  // the two runGreen calls (1 = candidate red, 2 = confirm on the chosen prefix).
  function partialDeps(opts: {
    candidateFailingTests?: string[];
    affected: Record<string, string[]>; // sha → affected workspace names for that prefix's range
    // WI-38218: sha → changed FILE paths for that prefix's range. `null` models "the diff
    // could not be computed". OMITTING the key entirely models a deps stub with no
    // changedFilesForRange at all, which must fall back to workspace granularity.
    changedFiles?: Record<string, string[] | null>;
    commits: string[]; // lastReady..candidate, OLDEST-FIRST full shas
    confirmGreen: boolean | boolean[];
    logPath?: string;
    /** Prefix refs whose setup/build should fail before the confirm suite starts. */
    setupFailures?: string[];
    /** WI-39841: wall-clock cost of EACH confirm suite. The salvage's budget check is a
     *  time measurement, so exercising it needs a confirm that actually costs time — the
     *  real one is tens of minutes. */
    confirmDelayMs?: number;
  }): {
    deps: CheckpointDeps;
    calls: string[];
    executions: Array<Parameters<CheckpointDeps["runGreen"]>[2]>;
  } {
    const calls: string[] = [];
    const executions: Array<Parameters<CheckpointDeps["runGreen"]>[2]> = [];
    let runGreenN = 0;
    const deps: CheckpointDeps = {
      setupTree: async (ref) => {
        calls.push(`setup:${ref.slice(0, 7)}`);
        if (opts.setupFailures?.includes(ref)) {
          calls.push(`setup-failed:${ref.slice(0, 7)}`);
          throw new Error(`pinned runtime build failed at ${ref.slice(0, 7)}`);
        }
      },
      runGreen: async (_tree, _base, execution) => {
        executions.push(execution);
        runGreenN++;
        if (runGreenN === 1) {
          calls.push("runGreen:candidate");
          return {
            green: false,
            summary: "red",
            failingTests: opts.candidateFailingTests,
            ...(opts.logPath ? { logPath: opts.logPath } : {}),
          };
        }
        calls.push("runGreen:confirm");
        if (opts.confirmDelayMs) {
          await new Promise((r) => setTimeout(r, opts.confirmDelayMs));
        }
        const confirmVerdicts = Array.isArray(opts.confirmGreen)
          ? opts.confirmGreen
          : [opts.confirmGreen];
        const green =
          confirmVerdicts[
            Math.min(runGreenN - 2, confirmVerdicts.length - 1)
          ] ?? false;
        return {
          green,
          summary: green ? "all pass" : "still red",
          ...(opts.logPath ? { logPath: opts.logPath } : {}),
        };
      },
      advance: (c) => {
        calls.push(`advance:${c.slice(0, 7)}`);
        return advanceReady(repo, c, "ready");
      },
      push: async () => {
        calls.push("push");
      },
      broadcast: async () => {
        calls.push("broadcast");
      },
      escalate: async () => {
        calls.push("escalate");
      },
      clearEscalation: async () => {
        calls.push("clearEscalation");
      },
      commitsInRange: async () => {
        calls.push("commitsInRange");
        return opts.commits;
      },
      affectedWorkspacesForRange: async (_from, to) => {
        calls.push(`affected:${to.slice(0, 7)}`);
        return opts.affected[to] ?? [];
      },
      ...(opts.changedFiles
        ? {
            changedFilesForRange: async (_from: string, to: string) => {
              calls.push(`files:${to.slice(0, 7)}`);
              const v = opts.changedFiles![to];
              return v === undefined ? [] : v; // undefined ⇒ "range touched nothing relevant"; null ⇒ "could not compute"
            },
          }
        : {}),
      log: () => {},
    };
    return { deps, calls, executions };
  }

  beforeEach(() => {
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE = "1";
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE;
  });

  async function chain() {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("b", "2", "c2"); // touches ws "other"
    const c3 = await commit("b", "3", "c3"); // touches ws "other"
    const c4 = await commit("c", "4", "c4"); // touches ws "failing" (the red tip)
    return { c1, c2, c3, c4 };
  }

  // WI-38218 (root cause WI-38216): the salvage used to locate ONLY at workspace
  // granularity, which is structurally blind when the failing workspace is a HUB —
  // @papercusp/operator-core is touched by essentially every commit, so the scan broke at
  // commit 1 and declined. Measured 2026-08-12: `main` pinned for ~22h / 16 red runs, and
  // only 4 of 258 persisted checkpoint logs ever emitted a `partial-green-gate:` line.
  describe("WI-38218: locate at FILE granularity", () => {
    const HUB = "@papercusp/operator-core";
    const FAILING = "packages/operator-core/lib/broken.test.ts";

    it("salvages a prefix for a HUB-package red, where workspace granularity is structurally blind", async () => {
      const { c2, c3, c4 } = await chain();
      const { deps, calls } = partialDeps({
        candidateFailingTests: [FAILING],
        // The hub sits in EVERY prefix's affected set — the real-world shape that froze main.
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: {
          [c2]: ["packages/operator-core/lib/unrelated-a.ts"],
          [c3]: ["packages/operator-core/lib/unrelated-b.ts"],
          [c4]: ["packages/operator-core/lib/unrelated-b.ts", FAILING], // the tip implicates
        },
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r).toMatchObject({
        advanced: true,
        reason: "advanced-prefix",
        advancedTo: c3,
      });
      expect(await revParse(repo, "ready")).toBe(c3);
      expect(calls).toContain(`files:${c2.slice(0, 7)}`); // located by FILE...
      expect(calls).not.toContain(`affected:${c2.slice(0, 7)}`); // ...not by workspace
    });

    it("WI-38298: recovers to a later green prefix after the first prefix confirm is red", async () => {
      const { c2, c3, c4 } = await chain();
      const { deps, calls, executions } = partialDeps({
        candidateFailingTests: [FAILING],
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: {
          [c2]: ["packages/operator-core/lib/unrelated-a.ts"],
          [c3]: [FAILING], // the later prefix repairs the failure the first prefix exposed
          [c4]: [FAILING],
        },
        commits: [c2, c3, c4],
        confirmGreen: [false, true],
      });

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({
        advanced: true,
        reason: "advanced-prefix",
        advancedTo: c3,
      });
      expect(await revParse(repo, "ready")).toBe(c3);
      expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(2);
      expect(calls).toContain(`setup:${c2.slice(0, 7)}`);
      expect(calls).toContain(`setup:${c3.slice(0, 7)}`);
      expect(executions[1]).toMatchObject({
        candidate: c2,
        headAtStart: c2,
      });
      expect(executions[2]).toMatchObject({
        candidate: c3,
        headAtStart: c3,
      });
    });

    it("classifies an unbuildable initial prefix and recovers to a later confirmed prefix", async () => {
      const { c2, c3, c4 } = await chain();
      const { deps, calls } = partialDeps({
        candidateFailingTests: [FAILING],
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: {
          [c2]: ["packages/operator-core/lib/unrelated-a.ts"],
          [c3]: [FAILING], // later prefix is the first buildable repair candidate
          [c4]: [FAILING],
        },
        setupFailures: [c2],
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const lines: string[] = [];
      deps.log = (line: string) => lines.push(line);

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({
        advanced: true,
        reason: "advanced-prefix",
        advancedTo: c3,
      });
      expect(await revParse(repo, "ready")).toBe(c3);
      expect(calls).toContain(`setup-failed:${c2.slice(0, 7)}`);
      expect(calls).toContain(`setup:${c3.slice(0, 7)}`);
      expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(1);
      expect(
        lines.some(
          (line) =>
            line.includes(
              `prefix ${c2.slice(0, 8)} unbuildable during setup/build`,
            ) && line.includes("bounded forward/bisect recovery"),
        ),
      ).toBe(true);
      expect(
        lines.some((line) =>
          line.includes(`recovered later green prefix ${c3.slice(0, 8)}`),
        ),
      ).toBe(true);
    });

    it("stops the prefix AT the commit touching the failing file — never extends past it", async () => {
      const { c1, c2, c3, c4 } = await chain();
      const { deps } = partialDeps({
        candidateFailingTests: [FAILING],
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: { [c2]: [FAILING], [c3]: [], [c4]: [] }, // the FIRST new commit implicates
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      expect(r.advanced).toBe(false);
      expect(await revParse(repo, "ready")).toBe(c1); // held — no partial advance
    });

    it('a diff that CANNOT be computed stops at the last clean prefix — null is never read as "nothing changed"', async () => {
      const { c2, c3, c4 } = await chain();
      const { deps } = partialDeps({
        candidateFailingTests: [FAILING],
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: { [c2]: ["x/unrelated.ts"], [c3]: null, [c4]: [] }, // c3's diff unavailable
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      // Stops at c2 (the last prefix it could actually verify) rather than treating the
      // unavailable c3 diff as clean and over-extending.
      expect(r).toMatchObject({ advanced: true, advancedTo: c2 });
      expect(await revParse(repo, "ready")).toBe(c2);
    });

    it("falls back to workspace granularity when changedFilesForRange is not wired", async () => {
      const { c1, c2, c3, c4 } = await chain();
      const { deps, calls } = partialDeps({
        candidateFailingTests: [FAILING],
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        // no `changedFiles` key ⇒ the dep is absent, exactly like an older stub
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      // A path-shaped signature localizes to no WORKSPACE, so the old behaviour declines.
      expect(r.advanced).toBe(false);
      expect(await revParse(repo, "ready")).toBe(c1);
      expect(calls.some((c) => c.startsWith("files:"))).toBe(false);
    });

    it("a GATE ID (lint:tsc) does NOT count as a file path — it must not vacuously authorise the maximal prefix", async () => {
      const { c1, c2, c3, c4 } = await chain();
      const { deps, calls } = partialDeps({
        candidateFailingTests: ["lint:tsc"], // not @-prefixed, but not a path either
        affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
        changedFiles: { [c2]: ["x/a.ts"], [c3]: ["x/b.ts"], [c4]: ["x/c.ts"] },
        commits: [c2, c3, c4],
        confirmGreen: true,
      });
      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
      // If `lint:tsc` were treated as a path it would match NO changed file, so every
      // commit would look clean and the scan would hand back the maximal prefix (c3) on
      // vacuous truth. It must fall back to workspace granularity and decline instead.
      expect(calls.some((c) => c.startsWith("files:"))).toBe(false);
      expect(r.advanced).toBe(false);
      expect(await revParse(repo, "ready")).toBe(c1);
    });

    // EI-20840168390311296 — the SAME vacuous-maximal-prefix hazard as the gate-id case
    // directly above, reached by a route the `includes('/')` filter cannot see: a
    // perfectly well-formed test path that NO commit in the range touches. It passes the
    // shape test, matches at no iteration, the scan never stops, and prefixTip is left at
    // the maximal prefix — one commit behind a KNOWN-RED candidate.
    //
    // Measured on the 2026-08-18T23:15Z cron run: 6 failing test files, ZERO commits
    // touching any of them across the 1683-commit batch (positive control on the same
    // range for packages/operator-core/lib: 1082 commits), salvage prefix exactly 1 commit
    // behind the candidate, ~22 minutes spent confirming it, and it failed on a SUPERSET
    // of the tip's own 6 files.
    describe("EI-20840168390311296: a failing path no commit touched must not authorise the maximal prefix", () => {
      it("THE DEFECT: falls back to workspace granularity and spends ZERO confirms when the scan matched nothing anywhere", async () => {
        const { c1, c2, c3, c4 } = await chain();
        const { deps, calls } = partialDeps({
          // Both shapes present, exactly like the measured run ("failing ws:
          // @papercusp/operator-core, @papercusp/web" alongside the failing files).
          candidateFailingTests: [FAILING, HUB],
          affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
          // FAILING appears in NO commit's diff — the break predates the whole batch.
          changedFiles: {
            [c2]: ["x/a.ts"],
            [c3]: ["x/b.ts"],
            [c4]: ["x/b.ts"],
          },
          commits: [c2, c3, c4],
          // Deliberately GREEN: before the guard, the maximal prefix c3 would confirm and
          // ADVANCE here. That is what makes this a real regression test — delete the
          // guard and this test fails loudly rather than passing for a new reason.
          confirmGreen: true,
        });

        const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

        expect(r.advanced).toBe(false);
        expect(await revParse(repo, "ready")).toBe(c1); // never FF'd to the vacuous prefix
        // The whole point: not one confirm suite was spent on a foregone red.
        expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(0);
        // It fell back to the workspace scan rather than simply giving up.
        expect(calls.some((c) => c.startsWith("affected:"))).toBe(true);
      });

      it("CALIBRATION: the guard does NOT fire when the excluded TIP commit implicates the failure — the legitimate salvage still advances", async () => {
        const { c2, c3, c4 } = await chain();
        const { deps, calls } = partialDeps({
          candidateFailingTests: [FAILING, HUB],
          affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
          // Identical to the case above EXCEPT that the tip — the one commit the walk
          // never examines — touches the failing file. This is the one-bad-tip-commit
          // case the salvage exists for.
          changedFiles: {
            [c2]: ["x/a.ts"],
            [c3]: ["x/b.ts"],
            [c4]: ["x/b.ts", FAILING],
          },
          commits: [c2, c3, c4],
          confirmGreen: true,
        });

        const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

        // Without this case the test above would also pass for a guard that simply always
        // declines, which would re-break WI-38218.
        expect(r).toMatchObject({
          advanced: true,
          reason: "advanced-prefix",
          advancedTo: c3,
        });
        expect(await revParse(repo, "ready")).toBe(c3);
        expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(1);
      });

      it("declines outright when the red localizes to neither a changed file nor a workspace", async () => {
        const { c1, c2, c3, c4 } = await chain();
        const { deps, calls } = partialDeps({
          candidateFailingTests: [FAILING], // no workspace entry ⇒ failingWs is empty
          affected: {
            [c2]: ["@ws/other"],
            [c3]: ["@ws/other"],
            [c4]: ["@ws/other"],
          },
          changedFiles: {
            [c2]: ["x/a.ts"],
            [c3]: ["x/b.ts"],
            [c4]: ["x/b.ts"],
          },
          commits: [c2, c3, c4],
          confirmGreen: true,
        });

        const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

        expect(r.advanced).toBe(false);
        expect(await revParse(repo, "ready")).toBe(c1);
        expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(0);
      });

      it('a tail diff that CANNOT be computed is treated as no signal, never as "the tip is clean"', async () => {
        const { c1, c2, c3, c4 } = await chain();
        const { deps, calls } = partialDeps({
          candidateFailingTests: [FAILING, HUB],
          affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
          // null ⇒ could not compute. Reading that as "the tip touched nothing" would be
          // the same null-as-empty confusion the per-prefix scan already guards against.
          changedFiles: { [c2]: ["x/a.ts"], [c3]: ["x/b.ts"], [c4]: null },
          commits: [c2, c3, c4],
          confirmGreen: true,
        });

        const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

        expect(r.advanced).toBe(false);
        expect(await revParse(repo, "ready")).toBe(c1);
        expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(0);
      });

      it("persists the NO SIGNAL narration into the candidate log, naming the granularity it fell back to", async () => {
        const { c2, c3, c4 } = await chain();
        const logPath = join(repo, "no-signal.log");
        writeFileSync(logPath, "CANDIDATE SUITE BODY\n");
        const { deps } = partialDeps({
          candidateFailingTests: [FAILING, HUB],
          affected: { [c2]: [HUB], [c3]: [HUB], [c4]: [HUB] },
          changedFiles: {
            [c2]: ["x/a.ts"],
            [c3]: ["x/b.ts"],
            [c4]: ["x/b.ts"],
          },
          commits: [c2, c3, c4],
          confirmGreen: true,
          logPath,
        });

        await runGreenCheckpoint(cfg(), deps, { noPush: true });

        const body = readFileSync(logPath, "utf8");
        expect(body).toContain(
          "partial-green-gate: NO SIGNAL at file granularity",
        );
        expect(body).toContain("MAXIMAL prefix by vacuous truth");
        expect(body).toContain("Falling back to workspace granularity");
        // WI-38218's decline line must name the scan that actually produced the verdict —
        // saying FILE here would send the next reader to the wrong scan.
        expect(body).toContain(
          "implicates the failure at workspace granularity",
        );
        expect(body).not.toContain("✅ partial-green-gate:");
      });
    });
  });

  it("advances `main` to the longest GREEN prefix and holds the red tip", async () => {
    const { c2, c3, c4 } = await chain();
    const { deps, calls, executions } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/other"],
        [c3]: ["@ws/other"],
        [c4]: ["@ws/failing", "@ws/other"],
      },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      reason: "advanced-prefix",
      candidate: c4,
      advancedTo: c3,
      green: false,
    });
    expect(r.failingTests).toEqual(["@ws/failing"]); // red tip's signature preserved for the fixer
    expect(await revParse(repo, "ready")).toBe(c3); // FF'd to the longest clean prefix, NOT the red tip
    expect(calls).toContain("runGreen:confirm");
    expect(calls).toContain("advance:" + c3.slice(0, 7));
    expect(executions[1]).toMatchObject({
      candidate: c3,
      headAtStart: c3,
    });
    // EI-19329608646178878: the confirm step (`runGreen:confirm`) checked out `prefixTip`
    // (c3) via setupTree — the checkpoint tree must be restored to the run's TRUE candidate
    // (c4) afterward, so a live probe of that checkout (candidateSource:'run-probe' on the
    // cron path) never reports the stale salvage prefix as "the candidate under judgment".
    const setupCalls = calls.filter((c) => c.startsWith("setup:"));
    expect(setupCalls[setupCalls.length - 1]).toBe(`setup:${c4.slice(0, 7)}`);
  });

  it("holds (no advance) when the confirm-run on the prefix is RED — never FFs to unconfirmed", async () => {
    const { c1, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: { [c4]: ["@ws/failing"] }, // c3 not listed ⇒ clean ⇒ chosen as the prefix to confirm
      commits: [c3, c4],
      confirmGreen: false, // the chosen prefix did NOT confirm green ⇒ must hold
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    expect(r.advanced).toBe(false);
    expect(await revParse(repo, "ready")).toBe(c1); // unchanged — no FF to an unconfirmed commit
    // EI-19329608646178878: even on a FAILED confirm, the checkout was left at the
    // unconfirmed prefix (c3) mid-function — it must still be restored to the real
    // candidate (c4) before this run's final hold-result is returned.
    const setupCalls = calls.filter((c) => c.startsWith("setup:"));
    expect(setupCalls[setupCalls.length - 1]).toBe(`setup:${c4.slice(0, 7)}`);
  });

  it("EI-20273247083807948: persists failed-confirm salvage narration in the parent candidate log", async () => {
    const { c3, c4 } = await chain();
    const logPath = join(repo, "candidate-red.log");
    writeFileSync(logPath, "CANDIDATE SUITE BODY\n");
    const { deps } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: { [c4]: ["@ws/failing"] }, // c3 is the clean prefix selected for confirmation
      commits: [c3, c4],
      confirmGreen: false,
      logPath,
    });

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const body = readFileSync(logPath, "utf8");
    expect(body).toContain("CANDIDATE SUITE BODY");
    expect(body).toContain(
      `partial-green-gate: candidate ${c4.slice(0, 8)} red`,
    );
    expect(body).toContain(
      `partial-green-gate: prefix ${c3.slice(0, 8)} did NOT confirm green`,
    );
    expect(body).not.toContain("✅ partial-green-gate:");
  });

  it("EI-20273247083807948: persists successful-confirm salvage narration in the parent candidate log", async () => {
    const { c3, c4 } = await chain();
    const logPath = join(repo, "candidate-red.log");
    writeFileSync(logPath, "CANDIDATE SUITE BODY\n");
    const { deps } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: { [c4]: ["@ws/failing"] }, // c3 is the clean prefix selected for confirmation
      commits: [c3, c4],
      confirmGreen: true,
      logPath,
    });

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const body = readFileSync(logPath, "utf8");
    expect(body).toContain("CANDIDATE SUITE BODY");
    expect(body).toContain(
      `partial-green-gate: candidate ${c4.slice(0, 8)} red`,
    );
    expect(body).toContain(`✅ partial-green-gate: ready advanced`);
    expect(body).toContain(`→ ${c3.slice(0, 8)}`);
  });

  // WI-39841 (Defect 3) — the recovery walk must be bounded by TIME, not only by COUNT.
  //
  // `maxRecoveryConfirms = 4` bounds how many extra full affected suites the salvage may
  // run; it says nothing about whether the run can afford them. The call-site pre-start
  // check (WI-39450, above) budgets for exactly ONE confirm, so it admits a salvage whose
  // worst case is 1 + 4 = FIVE of them, and nothing in between ever re-asks.
  //
  // Measured on the 2026-08-18T17:15:04Z cron run: admitted at ~23m elapsed with ~77m of
  // headroom (correct, for one confirm), then walked prefixes 17:37:57 → 18:54+ and was
  // still running when the run deadline SIGTERMed the process — destroying the verdict it
  // had already computed at 17:37:55 (`gate_health` recorded observedCandidate:null,
  // failingTests:[], and still incremented consecutiveReds).
  //
  // Both directions are pinned: the deadline must STOP the walk, and — the control — it
  // must be the ONLY thing that stops it, or a bug that disabled recovery outright would
  // pass the first test and look like a fix.
  describe("WI-39841: the recovery walk is bounded by the run budget, not just the attempt cap", () => {
    /** A chain long enough that the recovery walk has somewhere to go: the located prefix
     *  is c2, leaving c3 and c4 as probe targets ahead of the red tip c5. */
    async function chain5() {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const c2 = await commit("b", "2", "c2");
      const c3 = await commit("c", "3", "c3");
      const c4 = await commit("d", "4", "c4");
      const c5 = await commit("e", "5", "c5"); // the red tip
      return { c2, c3, c4, c5 };
    }

    const CONFIRM_COST_MS = 1500;

    it("STOPS the walk when the next confirm would overrun the budget", async () => {
      const { c2, c3, c4, c5 } = await chain5();
      const logPath = join(repo, "candidate-red.log");
      writeFileSync(logPath, "CANDIDATE SUITE BODY\n");
      const { deps, calls } = partialDeps({
        candidateFailingTests: ["@ws/failing"],
        // c2 is clean ⇒ located as the prefix; everything after implicates the failure.
        affected: {
          [c2]: ["@ws/other"],
          [c3]: ["@ws/failing"],
          [c4]: ["@ws/failing"],
          [c5]: ["@ws/failing"],
        },
        commits: [c2, c3, c4, c5],
        confirmGreen: false, // every confirm misses ⇒ the walk would run to its attempt cap
        confirmDelayMs: CONFIRM_COST_MS,
        logPath,
      });

      const r = await runGreenCheckpoint(cfg(), deps, {
        noPush: true,
        // Room for the FIRST confirm, but not for a second one after it is measured.
        salvageDeadlineMs: Date.now() + 2 * CONFIRM_COST_MS - 1000,
      });

      // Exactly ONE confirm — the initial one. The walk never started.
      expect(calls.filter((c) => c === "runGreen:confirm")).toHaveLength(1);
      // ...and it said so, rather than stopping silently (WI-38207's rule for this path).
      const body = readFileSync(logPath, "utf8");
      expect(body).toContain(
        "partial-green-gate: recovery STOPPED after 0 of 4",
      );
      // The whole point: the verdict still lands intact. This is what the SIGTERM destroyed.
      expect(r.green).toBe(false);
      expect(r.candidate).toBe(c5);
      expect(r.failingTests).toEqual(["@ws/failing"]);
      expect(r.advanced).toBe(false);
    });

    it("control: the SAME red with budget to spare still walks the recovery probes", async () => {
      const { c2, c3, c4, c5 } = await chain5();
      const { deps, calls } = partialDeps({
        candidateFailingTests: ["@ws/failing"],
        affected: {
          [c2]: ["@ws/other"],
          [c3]: ["@ws/failing"],
          [c4]: ["@ws/failing"],
          [c5]: ["@ws/failing"],
        },
        commits: [c2, c3, c4, c5],
        confirmGreen: false,
        confirmDelayMs: 0,
        logPath: undefined,
      });

      await runGreenCheckpoint(cfg(), deps, {
        noPush: true,
        salvageDeadlineMs: Date.now() + 60 * 60_000,
      });

      // Initial confirm + the forward probe + one bisect probe.
      expect(
        calls.filter((c) => c === "runGreen:confirm").length,
      ).toBeGreaterThan(1);
    });
  });

  it("holds when the FIRST new commit already implicates a failing workspace (no clean prefix)", async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/failing"],
        [c3]: ["@ws/failing"],
        [c4]: ["@ws/failing"],
      },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green");
    expect(await revParse(repo, "ready")).toBe(c1); // unchanged
    expect(calls).not.toContain("runGreen:confirm"); // no clean prefix ⇒ never even confirms
  });

  it("holds when the failure is not workspace-localizable (only file-path / build failures)", async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ["lib/foo.test.ts", "@papercusp/operator-vite"], // file path + build sentinel, no ws-name match
      affected: { [c4]: ["@ws/failing", "@ws/other"] },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green"); // failingWs ∩ affected = ∅ ⇒ decline, don't guess
    expect(await revParse(repo, "ready")).toBe(c1);
  });

  it("holds when there is only ONE new commit (the red tip itself — nothing behind it)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("c", "2", "c2"); // the single red commit
    const { deps, calls } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: { [c2]: ["@ws/failing"] },
      commits: [c2],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, {
      candidate: c2,
      noPush: true,
    });
    expect(r.reason).toBe("not-green");
    expect(calls).not.toContain("runGreen:confirm");
  });

  it("is ON by default — without PAPERCUSP_PARTIAL_GREEN_GATE set, a red tip still salvages the green prefix", async () => {
    delete process.env.PAPERCUSP_PARTIAL_GREEN_GATE; // no arming needed (default-on, 2026-07-01)
    const { c3, c2, c4 } = await chain();
    const { deps, executions } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/other"],
        [c3]: ["@ws/other"],
        [c4]: ["@ws/failing"],
      },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({
      advanced: true,
      reason: "advanced-prefix",
      advancedTo: c3,
    });
    expect(executions).toHaveLength(2);
    expect(executions[1]).toMatchObject({ candidate: c3, headAtStart: c3 });
  });

  it("opt-out: PAPERCUSP_PARTIAL_GREEN_GATE=0 holds a red candidate exactly as before (strict tip-only gating)", async () => {
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE = "0";
    const { c1, c2, c3, c4 } = await chain();
    const { deps, calls } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/other"],
        [c3]: ["@ws/other"],
        [c4]: ["@ws/failing"],
      },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r.reason).toBe("not-green"); // gate opted out ⇒ no salvage attempt
    expect(await revParse(repo, "ready")).toBe(c1);
    expect(calls).not.toContain("commitsInRange"); // the salvage path never ran
  });

  // WI-38207: the salvage path must STATE ITS DISPOSITION on every branch. Measured
  // 2026-08-12: `main` sat at one sha for 22h across 16 red runs, and not one log could say
  // whether this mechanism had run, because "never attempted" and "attempted, found nothing"
  // both emitted zero lines. These assert the log, not the promotion decision — an inert
  // safety net that cannot report itself is the failure being guarded against.
  it('WI-38207: logs "no salvageable green prefix" when the salvage RAN and found nothing', async () => {
    const { c1, c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/other"],
        [c3]: ["@ws/other"],
        [c4]: ["@ws/failing"],
      },
      commits: [c2, c3, c4],
      confirmGreen: false, // the confirm suite fails ⇒ tryLongestGreenPrefix returns null
    });
    const lines: string[] = [];
    deps.log = (s: string) => {
      lines.push(s);
    };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(await revParse(repo, "ready")).toBe(c1); // still held — behaviour unchanged
    const dispositions = lines.filter((l) => l.includes("partial-green-gate:"));
    expect(dispositions.length).toBeGreaterThan(0);
    expect(
      dispositions.some((l) => l.includes("no salvageable green prefix")),
    ).toBe(true);
    // and it must be distinguishable from the never-ran case
    expect(dispositions.some((l) => l.includes("skipped"))).toBe(false);
  });

  it('WI-38207: logs a distinct "skipped — disabled" disposition when opted out', async () => {
    process.env.PAPERCUSP_PARTIAL_GREEN_GATE = "0";
    const { c2, c3, c4 } = await chain();
    const { deps } = partialDeps({
      candidateFailingTests: ["@ws/failing"],
      affected: {
        [c2]: ["@ws/other"],
        [c3]: ["@ws/other"],
        [c4]: ["@ws/failing"],
      },
      commits: [c2, c3, c4],
      confirmGreen: true,
    });
    const lines: string[] = [];
    deps.log = (s: string) => {
      lines.push(s);
    };
    await runGreenCheckpoint(cfg(), deps, { noPush: true });
    const dispositions = lines.filter((l) => l.includes("partial-green-gate:"));
    expect(
      dispositions.some((l) =>
        l.includes("disabled by PAPERCUSP_PARTIAL_GREEN_GATE=0"),
      ),
    ).toBe(true);
    // the opted-out run must NOT claim it looked for a prefix
    expect(
      dispositions.some((l) => l.includes("no salvageable green prefix")),
    ).toBe(false);
  });
});

describe("quiet-cut — never judge a tip younger than the quiet window (2026-07-01)", () => {
  afterEach(() => {
    delete process.env.PAPERCUSP_QUIET_CUT;
    delete process.env.PAPERCUSP_QUIET_CUT_SEC;
    delete process.env.GIT_COMMITTER_DATE;
  });

  it("quietCutSecFromEnv: default 240, PAPERCUSP_QUIET_CUT=0 disables, _SEC tunes", () => {
    expect(quietCutSecFromEnv({})).toBe(240);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT: "0" })).toBe(0);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT_SEC: "60" })).toBe(60);
    expect(quietCutSecFromEnv({ PAPERCUSP_QUIET_CUT_SEC: "junk" })).toBe(240);
  });

  /**
   * EI-19458822909084210 — the anti-drift guard.
   *
   * This rule was defined TWICE: here (the AUTHORITY that drives real candidate selection)
   * and in release-checkpoint-launch.ts (the launch-side PREDICTOR of what this module will
   * pick). The copies had already drifted — only the predictor floored — so they disagreed
   * for a non-integer PAPERCUSP_QUIET_CUT_SEC. A predictor that can disagree with the
   * authority it predicts is the whole bug class.
   *
   * Referential identity is the guard rather than a behavioral re-assertion on purpose:
   * re-testing the VALUES would still pass if someone reintroduced a local copy that merely
   * happened to agree today, which is exactly how the first drift went unnoticed. Comparing
   * function identity fails the instant a second definition exists at all.
   */
  it("is the SINGLE shared definition — not a local copy that merely agrees today", async () => {
    const shared =
      await import("@papercusp/operator-core/lib/release/quiet-cut");
    expect(quietCutSecFromEnv).toBe(shared.quietCutSecFromEnv);

    // CONTROL (falsifiability): a re-implementation that agrees on every value the old
    // copies agreed on is still a DIFFERENT function. This proves the assertion above
    // discriminates by identity rather than passing trivially — i.e. that it really would
    // catch a reintroduced local copy, which is the only failure mode it exists to catch.
    const reintroducedLocalCopy = (
      env: NodeJS.ProcessEnv = process.env,
    ): number => {
      if (env.PAPERCUSP_QUIET_CUT === "0") return 0;
      const v = Number(env.PAPERCUSP_QUIET_CUT_SEC);
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 240;
    };
    // NODE_ENV is spelled out because Next's global augmentation (next-env.d.ts →
    // next/types/global.d.ts) makes it REQUIRED on ProcessEnv, so a bare {} does not
    // satisfy the parameter type. The older call sites in this file omit it and are
    // carried in apps/operator/.tsc-baseline.json; new ones should not add to that debt.
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    expect(reintroducedLocalCopy(env)).toBe(quietCutSecFromEnv(env)); // agrees behaviorally…
    expect(reintroducedLocalCopy).not.toBe(shared.quietCutSecFromEnv); // …and is still caught.
  });

  it("floors a non-integer window — the exact value the two copies used to disagree on", () => {
    // NODE_ENV: Next's global augmentation makes it REQUIRED on ProcessEnv (see above).
    const withSec = (sec: string): NodeJS.ProcessEnv => ({
      NODE_ENV: "test",
      PAPERCUSP_QUIET_CUT_SEC: sec,
    });
    // Pre-fix: the authority returned 90.7 while the predictor returned 90.
    expect(quietCutSecFromEnv(withSec("90.7"))).toBe(90);
    // A negative window is nonsense, not a disable — it must fall back, not return 0.
    expect(quietCutSecFromEnv(withSec("-5"))).toBe(240);
    // '0' via _SEC is a real 0-second window (only PAPERCUSP_QUIET_CUT=0 is the opt-out).
    expect(quietCutSecFromEnv(withSec("0"))).toBe(0);
  });

  /** Commit with a pinned committer date (rev-list --before + %ct read COMMITTER time). */
  async function datedCommit(
    file: string,
    msg: string,
    ageSec: number,
  ): Promise<string> {
    process.env.GIT_COMMITTER_DATE = new Date(
      Date.now() - ageSec * 1000,
    ).toISOString();
    try {
      return await commit(file, `${msg}\n`, msg);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
  }

  it("fresh tip steps back to the newest quiet-window-old commit; the tip waits for the next run", async () => {
    const c1 = await datedCommit("a.txt", "c1", 600); // 10 min old — the pin
    await git(repo, ["branch", "ready", c1]);
    const c2 = await datedCommit("b.txt", "c2", 300); // 5 min old — the quiet pick
    const c3 = await commit("c.txt", "now\n", "c3"); // seconds old — torn-risk tip
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true });
    expect(await revParse(repo, "ready")).toBe(c2); // advanced to the QUIET state, not the fresh tip
    expect(r.candidate).not.toBe(c3);
  });

  it("detects a source/test sibling whose newest half sits beyond the candidate", async () => {
    expect(sourceTestSiblingPaths("lib/holder-context.ts")).toEqual([
      "lib/holder-context.test.ts",
      "lib/holder-context.spec.ts",
    ]);
    expect(sourceTestSiblingPaths("lib/holder-context.test.ts")).toEqual([
      "lib/holder-context.ts",
    ]);

    const base = await datedCommit("README.md", "base", 600);
    const candidate = await datedCommit(
      "lib/holder-context.ts",
      "source-v2",
      300,
    );
    const tip = await commit(
      "lib/holder-context.test.ts",
      "test-v2\n",
      "test-v2",
    );

    await expect(
      detectSplitSourceTestPairs({ repo, base, candidate, tip }),
    ).resolves.toEqual([
      {
        candidatePath: "lib/holder-context.ts",
        siblingPath: "lib/holder-context.test.ts",
        siblingCommit: tip,
      },
    ]);
  });

  it("bounds the diagnostic on a wide change while judging the candidate normally", async () => {
    const base = await datedCommit("README.md", "base", 600);
    await git(repo, ["branch", "ready", base]);

    process.env.GIT_COMMITTER_DATE = new Date(
      Date.now() - 300 * 1000,
    ).toISOString();
    try {
      for (
        let i = 0;
        i < QUIET_CUT_SPLIT_PAIR_DIAGNOSTIC_MAX_CHANGED_FILES + 1;
        i += 1
      ) {
        const path = join(repo, "lib", `wide-${i}.ts`);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, `export const value${i} = ${i};\n`);
      }
      await git(repo, ["add", "-A"]);
      await git(repo, ["commit", "--no-verify", "-q", "-m", "wide candidate"]);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
    }
    const candidate = await revParse(repo, "HEAD");
    await commit("fresh-tip.txt", "tip\n", "fresh tip");

    const { deps } = stubDeps(true);
    const lines: string[] = [];
    deps.log = (line) => lines.push(line);
    deps.detectSplitSourceTestPairs = (input) =>
      detectSplitSourceTestPairs({ repo, ...input });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: true,
      candidate,
      green: true,
    });
    expect(
      lines.some((line) =>
        line.includes(
          `quiet-cut split-pair detector skipped (changed-file radius ${
            QUIET_CUT_SPLIT_PAIR_DIAGNOSTIC_MAX_CHANGED_FILES + 1
          } exceeds diagnostic cap ${QUIET_CUT_SPLIT_PAIR_DIAGNOSTIC_MAX_CHANGED_FILES}`,
        ),
      ),
    ).toBe(true);
  });

  it("stamps a quiet-cut red with the split pair so triage does not fix or quarantine the old test", async () => {
    const base = await datedCommit("README.md", "base", 600);
    await git(repo, ["branch", "ready", base]);
    const candidate = await datedCommit(
      "lib/holder-context.ts",
      "source-v2",
      300,
    );
    const tip = await commit(
      "lib/holder-context.test.ts",
      "test-v2\n",
      "test-v2",
    );
    const { deps } = stubDeps(false, ["lib/holder-context.test.ts"]);
    const lines: string[] = [];
    deps.log = (line) => lines.push(line);
    deps.detectSplitSourceTestPairs = (input) =>
      detectSplitSourceTestPairs({ repo, ...input });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      green: false,
      splitSourceTestPairs: [
        {
          candidatePath: "lib/holder-context.ts",
          siblingPath: "lib/holder-context.test.ts",
          siblingCommit: tip,
        },
      ],
    });
    expect(result.summary).toContain("SPLIT-PAIR SUSPECTED");
    expect(result.summary).toContain(
      "lib/holder-context.ts <> lib/holder-context.test.ts",
    );
    expect(
      lines.some((line) => line.includes("quiet-cut split-pair suspected")),
    ).toBe(true);
  });

  it("a pre-lock candidate hint freezes the observed tip without turning it into a quiet-cut-bypassing pin", async () => {
    const c1 = await datedCommit("a.txt", "c1", 600);
    await git(repo, ["branch", "ready", c1]);
    const c2 = await datedCommit("b.txt", "c2", 300);
    const c3 = await commit("c.txt", "now\n", "c3");
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, {
      noPush: true,
      candidateHint: c3,
    });
    expect(r).toMatchObject({ advanced: true, candidate: c2, green: true });
    expect(r.candidate).not.toBe(c3);
  });

  it("opt-out (PAPERCUSP_QUIET_CUT=0) judges the fresh tip exactly as before", async () => {
    const c1 = await datedCommit("a.txt", "c1", 600);
    await git(repo, ["branch", "ready", c1]);
    await datedCommit("b.txt", "c2", 300);
    const c3 = await commit("c.txt", "now\n", "c3");
    process.env.PAPERCUSP_QUIET_CUT = "0";
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c3 });
  });

  it("a whole-repo-fresh history has no aged pick — the tip is judged (no stall on young repos)", async () => {
    const c1 = await commit("a.txt", "x\n", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("b.txt", "y\n", "c2");
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(r).toMatchObject({ advanced: true, candidate: c2 });
  });

  it("an explicit opts.candidate pin bypasses the quiet cut", async () => {
    const c1 = await datedCommit("a.txt", "c1", 600);
    await git(repo, ["branch", "ready", c1]);
    await datedCommit("b.txt", "c2", 300);
    const c3 = await commit("c.txt", "now\n", "c3");
    const { deps } = stubDeps(true);
    const r = await runGreenCheckpoint(cfg(), deps, {
      noPush: true,
      candidate: c3,
    });
    expect(r).toMatchObject({ advanced: true, candidate: c3 });
  });

  // P-010 (green-main-cycle-time-2026-10-08, D-026/D-027): the first fresh cut after a retire
  // must hold the retired queue's admitted fixes; the quiet cut can step back past one.
  describe("P-010 carry of a retired frozen queue's fixes into the next fresh cut", () => {
    function pendingCarry(path: string, blob: string): FrozenRepairPendingCarry {
      return {
        schemaVersion: 1,
        fromCandidate: "c".repeat(40),
        fromRepairHead: "d".repeat(40),
        reason: "bounded-life",
        retiredAtMs: 1_800_000_000_000,
        admitted: [{ path, blob }],
        truncated: false,
      };
    }

    function withCarry(deps: CheckpointDeps, pending: FrozenRepairPendingCarry | Error, consumed = true) {
      const logs: string[] = [];
      const consume = vi.fn(async (_p: FrozenRepairPendingCarry, _r: FrozenRepairCarryRecord) => consumed);
      const read = vi.fn(async () => {
        if (pending instanceof Error) throw pending;
        return pending;
      });
      deps.readFrozenRepairPendingCarry = read;
      deps.consumeFrozenRepairCarry = consume;
      deps.log = (line: string) => logs.push(line);
      return { logs, consume, read };
    }

    it("judges the staging tip when the quiet cut lacks an admitted fix, and records the carry", async () => {
      const c1 = await datedCommit("a.txt", "c1", 600);
      await git(repo, ["branch", "ready", c1]);
      const c2 = await datedCommit("b.txt", "c2", 300); // the quiet pick — no fix yet
      const c3 = await commit("fix.ts", "fixed\n", "c3"); // the admitted fix, committed seconds ago
      const pending = pendingCarry("fix.ts", await git(repo, ["rev-parse", `${c3}:fix.ts`]));
      const { deps } = stubDeps(true);
      const { consume, logs } = withCarry(deps, pending);

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({ advanced: true, candidate: c3, green: true });
      expect(consume).toHaveBeenCalledTimes(1);
      const [consumedPending, record] = consume.mock.calls[0]!;
      expect(consumedPending).toBe(pending);
      expect(record).toMatchObject({
        initialCandidate: c2,
        initialMissing: ["fix.ts"],
        judgedCandidate: c3,
        advancedToTip: true,
        entries: [{ path: "fix.ts", status: "carried" }],
      });
      expect(logs.some((line) => line.includes("lacked 1 fix(es), judging the staging tip instead"))).toBe(true);
    });

    it("keeps the quiet cut when it already holds every admitted fix", async () => {
      const c1 = await datedCommit("a.txt", "c1", 600);
      await git(repo, ["branch", "ready", c1]);
      const c2 = await datedCommit("fix.ts", "c2", 300); // the fix landed before the quiet window
      await commit("c.txt", "now\n", "c3");
      const { deps } = stubDeps(true);
      const { consume } = withCarry(deps, pendingCarry("fix.ts", await git(repo, ["rev-parse", `${c2}:fix.ts`])));

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({ advanced: true, candidate: c2 });
      expect(consume.mock.calls[0]?.[1]).toMatchObject({
        initialCandidate: c2,
        judgedCandidate: c2,
        advancedToTip: false,
        entries: [{ path: "fix.ts", status: "carried" }],
      });
    });

    it("never reads or consumes the carry for an explicitly pinned candidate", async () => {
      const c1 = await datedCommit("a.txt", "c1", 600);
      await git(repo, ["branch", "ready", c1]);
      const c2 = await datedCommit("b.txt", "c2", 300);
      await commit("fix.ts", "fixed\n", "c3");
      const { deps } = stubDeps(true);
      const { read, consume } = withCarry(deps, pendingCarry("fix.ts", "0".repeat(40)));

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true, candidate: c2 });

      expect(r).toMatchObject({ candidate: c2 });
      expect(read).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    });

    it("an unreadable carry keeps the quiet cut and leaves the carry pending", async () => {
      const c1 = await datedCommit("a.txt", "c1", 600);
      await git(repo, ["branch", "ready", c1]);
      const c2 = await datedCommit("b.txt", "c2", 300);
      await commit("fix.ts", "fixed\n", "c3");
      const { deps } = stubDeps(true);
      const { consume, logs } = withCarry(deps, new Error("pg unavailable"));

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({ candidate: c2 });
      expect(consume).not.toHaveBeenCalled();
      expect(logs.some((line) => line.includes("P-010 pending carry unreadable"))).toBe(true);
    });

    it("a carry replaced before it is recorded still judges the tip, and says the next cut assesses the newer one", async () => {
      const c1 = await datedCommit("a.txt", "c1", 600);
      await git(repo, ["branch", "ready", c1]);
      await datedCommit("b.txt", "c2", 300);
      const c3 = await commit("fix.ts", "fixed\n", "c3");
      const { deps } = stubDeps(true);
      const { logs } = withCarry(deps, pendingCarry("fix.ts", await git(repo, ["rev-parse", `${c3}:fix.ts`])), false);

      const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(r).toMatchObject({ candidate: c3 });
      expect(logs.some((line) => line.includes("the next fresh cut assesses the newer carry"))).toBe(true);
    });
  });
});

describe("pipelineName (EI-7646 — the pipeline-scoped verdict-key segment)", () => {
  it("is the sanitized basename of the integration root", async () => {
    const { pipelineName } = await import("./green-checkpoint");
    expect(pipelineName("/home/x/papercupai-workspace/papercusp")).toBe(
      "papercusp",
    );
    expect(pipelineName("/home/x/papercupai-workspace/papercup/")).toBe(
      "papercup",
    );
    expect(pipelineName("/weird/dir with spaces!")).toBe("dir-with-spaces-");
  });
});

describe("EI-15925 — the advance broadcast is attributable to its pipeline", () => {
  // Every co-hosted pot broadcasts to the SAME audience `*`. An unlabelled
  // "`main` advanced to <sha>" is indistinguishable between pipelines, and on
  // 2026-07-18 oddsmith's real 439b4037 was read fleet-wide as a papercusp
  // PHANTOM sha mid-release-decision. The label is what makes a release
  // broadcast safe to resolve a cut target from.
  it("prefixes the summary with the pipeline name and labels the sender", async () => {
    const sent: Array<{ summary: string; label: string }> = [];
    vi.doMock(
      "@papercusp/operator-core/lib/agent-tools/coordination/messages",
      () => ({
        sendMessage: async (
          identity: { ownerLabel: string },
          msg: { summary: string },
        ) => {
          sent.push({ summary: msg.summary, label: identity.ownerLabel });
        },
      }),
    );
    const deps = realCheckpointDeps(cfg());
    await deps.broadcast(
      "🟩 green-checkpoint: `ready` advanced to 439b4037 (green, deployable)",
    );

    // `repo` is the mkdtemp integration root, so the pipeline is its basename.
    const pipeline = pipelineName(repo);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.summary).toBe(
      `[pipeline:${pipeline}] 🟩 green-checkpoint: \`ready\` advanced to 439b4037 (green, deployable)`,
    );
    expect(sent[0]!.label).toBe(`green-checkpoint[${pipeline}]`);
    vi.doUnmock(
      "@papercusp/operator-core/lib/agent-tools/coordination/messages",
    );
  });
});

describe("P-004/D-002 — the gate-verdict WAKE BANNER is attributable to its pipeline", () => {
  // EI-15925 (above) fixed this class for `broadcast` and judged the event path already
  // covered because the event PAYLOAD carries `pipeline`. It was not: an await's `summary`
  // is the wake banner an agent actually reads, and it stayed pipeline-blind — so the same
  // confusion recurred 15 days later on the same pipeline. `release:green:*` await 42194
  // woke a papercusp agent on ODDSMITH's advance of 9a8aa848 (papercusp had no
  // green_checkpoint row in that window) and it reported the gate green
  // (EI-19311522275272409). The GLOBAL key is emitted by every co-hosted pipeline, so it —
  // not the glob — is the widest carrier; both keys must carry the label.
  const captureSummaries = (
    green: boolean,
  ): { deps: CheckpointDeps; summaries: Record<string, string> } => {
    const summaries: Record<string, string> = {};
    return {
      summaries,
      deps: {
        setupTree: async () => {},
        runGreen: async () => ({
          green,
          summary: green ? "all pass" : "3 failed",
        }),
        advance: (candidate) => advanceReady(repo, candidate, "ready"),
        push: async () => {},
        broadcast: async () => {},
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async ({ key, summary }) => {
          summaries[key] = summary;
        },
        log: () => {},
      },
    };
  };

  it("labels the GREEN summary on BOTH the global and the pipeline-scoped key", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, summaries } = captureSummaries(true);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    // EI-22240267519750098: the REF inside the sentence is pipeline-qualified too
    // (`<pipeline>:ready`, not a bare `ready` the reader resolves against their own
    // checkout). Written out literally rather than through `pipelineRef` so this stays
    // an independent restatement of the wire format, not a tautology.
    const expected = `[pipeline:${pipeline}] ${pipeline}:ready advanced to ${c2.slice(0, 8)} (green, deployable)`;
    expect(summaries["release:green"]).toBe(expected);
    expect(summaries[`release:green:${pipeline}`]).toBe(expected);
    // The whole point: the banner alone must identify the pipeline, with no payload read.
    expect(summaries["release:green"]).toContain(pipeline);
  });

  it("labels the RED summary on BOTH keys too — a foreign red must not read as your gate", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, summaries } = captureSummaries(false);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    const expected = `[pipeline:${pipeline}] green-checkpoint: ${c2.slice(0, 8)} not green — ${pipeline}:ready held`;
    expect(summaries["green-checkpoint:red"]).toBe(expected);
    expect(summaries[`green-checkpoint:red:${pipeline}`]).toBe(expected);
  });
});

describe("EI-21949138739080608 — the pipeline tag must READ as an identifier", () => {
  // Third instance of one class. EI-15925 and P-004/D-002 (both above) each asked "is an
  // identifier PRESENT?" and stopped there. Neither asked whether a reader RECOGNISES it as
  // one — and on 2026-08-31 the `email` pipeline broadcast `[email] 🟩 green-checkpoint: ...`
  // to `*`, and an su who did the CORRECT verification (resolve the sha against your own
  // checkout, `git cat-file`) still read the bare `[email]` as a redaction/template artifact
  // rather than a pipeline name, and filed "names no hive" — quoting the tag they had missed.
  //
  // So the property under test is not "a tag exists" (the prior two suites cover that) but
  // "the tag is self-describing to a reader who has never seen the convention".

  it("⭐ tags a word-collision pipeline name unmistakably — the `[email]` case that was misread", () => {
    // The exact regression: `email` is a real co-hosted pipeline whose bare bracketed
    // basename is indistinguishable from a redaction/placeholder token.
    expect(pipelineTag("email")).toBe("[pipeline:email]");
    // The pre-fix rendering must NOT be what we emit — this is the falsifier: revert
    // pipelineTag to `[${p}]` and this line fails.
    expect(pipelineTag("email")).not.toBe("[email]");
    // ...and it still names the pipeline, so the EI-15925 property is not regressed.
    expect(pipelineTag("email")).toContain("email");
  });

  it("keeps the discriminator for every pipeline, not just word-collisions", () => {
    for (const p of [
      "papercusp",
      "papercup",
      "oddsmith",
      "hello-world-3-pot",
    ]) {
      expect(pipelineTag(p)).toBe(`[pipeline:${p}]`);
      expect(pipelineTag(p)).toContain(p);
    }
    // Neighbouring pipelines stay distinguishable (the papercusp/papercup hazard).
    expect(pipelineTag("papercusp")).not.toBe(pipelineTag("papercup"));
  });

  it("leads the green broadcast summary, so the tag is the first thing read", async () => {
    const sent: Array<{ summary: string }> = [];
    vi.doMock(
      "@papercusp/operator-core/lib/agent-tools/coordination/messages",
      () => ({
        sendMessage: async (_i: unknown, msg: { summary: string }) => {
          sent.push({ summary: msg.summary });
        },
      }),
    );
    const deps = realCheckpointDeps(cfg());
    await deps.broadcast(
      "🟩 green-checkpoint: `ready` advanced to 439b4037 (green, deployable)",
    );

    const pipeline = pipelineName(repo);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.summary.startsWith(pipelineTag(pipeline))).toBe(true);
    // The machine-readable identity is unchanged by this display fix; the tag is additive.
    expect(sent[0]!.summary).toContain("(green, deployable)");
    vi.doUnmock(
      "@papercusp/operator-core/lib/agent-tools/coordination/messages",
    );
  });
});

describe("EI-22240267519750098 — the CLAIM carries the pipeline, not just the prefix", () => {
  // FOURTH filed instance of one class, and the first whose fix is not "label one more
  // surface". EI-15925 prefixed the broadcast; P-004/D-002 prefixed the event banners;
  // EI-21949138739080608 made the prefix self-describing. Coverage is complete on every
  // emit site — and on 2026-09-03 an su blocked on a papercusp deploy still read
  //   [pipeline:email] 🟩 green-checkpoint: `main` advanced to ad49e48a (green, deployable)
  // as their OWN gate greening.
  //
  // So the property under test is not "a tag exists" and not "the tag is legible" (the
  // three suites above cover those) but: with the routing prefix REMOVED, is the sentence
  // still attributable? Readers parse the claim, and the claim's subject was `main` — a
  // ref name every reader resolves against their own checkout.

  const stripTag = (summary: string, pipeline: string): string =>
    summary.startsWith(pipelineTag(pipeline))
      ? summary.slice(pipelineTag(pipeline).length).trim()
      : summary;

  // A ref a reader resolves against their OWN tree: `ready` NOT already qualified by a
  // `<pipeline>:`. The `[^:\w-]` guard is what distinguishes `email:ready` from `` `ready` ``.
  const bareRef = (ref: string): RegExp => new RegExp(`(^|[^:\\w-])${ref}\\b`);

  const captureDelivered = (
    green: boolean,
  ): {
    deps: CheckpointDeps;
    events: Record<string, string>;
    broadcasts: string[];
  } => {
    const events: Record<string, string> = {};
    const broadcasts: string[] = [];
    return {
      events,
      broadcasts,
      deps: {
        setupTree: async () => {},
        runGreen: async () => ({
          green,
          summary: green ? "all pass" : "3 failed",
        }),
        advance: (candidate) => advanceReady(repo, candidate, "ready"),
        push: async () => {},
        // The real `broadcast` applies the tag; this stub does not, so what is captured
        // here is the bare HEADLINE — exactly the sentence a reader parses.
        broadcast: async (summary: string) => {
          broadcasts.push(summary);
        },
        escalate: async () => {},
        clearEscalation: async () => {},
        emitEvent: async ({ key, summary }) => {
          events[key] = summary;
        },
        log: () => {},
      },
    };
  };

  it("⭐ qualifies the ref in the GREEN headline and wake banner — a foreign green is not readable as your own", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const { deps, events, broadcasts } = captureDelivered(true);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    // CALIBRATION — the instrument below assumes the pipeline name does not itself
    // contain the ref; say so out loud rather than letting a collision read as a pass.
    expect(pipeline).not.toContain("ready");

    const headline = broadcasts.find((b) => b.includes("(green, deployable)"));
    expect(headline).toBeDefined();
    const banner = stripTag(events["release:green"]!, pipeline);

    for (const claim of [headline!, banner]) {
      // The ref names its pipeline INSIDE the sentence...
      expect(claim).toContain(`${pipeline}:ready`);
      // ...and nothing in the claim is still a bare ref. Removing the qualified ref must
      // leave none behind — this is the assertion the pre-fix rendering fails.
      expect(claim.split(`${pipeline}:ready`).join("«ref»")).not.toMatch(
        bareRef("ready"),
      );
    }
  });

  it("qualifies the ref in the RED headline and wake banner too", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    expect(c2).toBeTruthy();
    const { deps, events, broadcasts } = captureDelivered(false);
    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    const pipeline = pipelineName(repo);
    expect(pipeline).not.toContain("ready");

    const headline = broadcasts.find((b) => b.includes("not green"));
    expect(headline).toBeDefined();
    const banner = stripTag(events["green-checkpoint:red"]!, pipeline);

    for (const claim of [headline!, banner]) {
      expect(claim).toContain(`${pipeline}:ready`);
      expect(claim.split(`${pipeline}:ready`).join("«ref»")).not.toMatch(
        bareRef("ready"),
      );
    }
  });

  it("⭐ CONTROL — the weaker predicate the three prior fixes relied on cannot see this defect", () => {
    // Permanent deliberately-wrong control: no production code is mutated to prove the
    // guard falsifiable. Both strings are the real renderings, before and after.
    const pipeline = "email";
    const preFix = `${pipelineTag(pipeline)} 🟩 green-checkpoint: \`main\` advanced to ad49e48a (green, deployable)`;
    const postFix = `${pipelineTag(pipeline)} 🟩 green-checkpoint: \`${pipelineRef(pipeline, "main")}\` advanced to ad49e48a (green, deployable)`;

    // "Is the pipeline named anywhere?" — the question every prior fix answered — passes
    // on the EXACT string that caused the incident. That is why three fixes did not hold.
    expect(preFix).toContain(pipeline);
    expect(postFix).toContain(pipeline);

    // "Is the CLAIM attributable once the routing prefix is gone?" separates them.
    expect(stripTag(preFix, pipeline)).toMatch(bareRef("main"));
    expect(stripTag(postFix, pipeline)).not.toMatch(bareRef("main"));
  });

  it("keeps neighbouring pipelines' refs distinguishable, and never emits a bare ref", () => {
    expect(pipelineRef("email", "main")).toBe("email:main");
    expect(pipelineRef("email", "main")).not.toBe("main");
    // The papercusp/papercup hazard, at ref level.
    expect(pipelineRef("papercusp", "main")).not.toBe(
      pipelineRef("papercup", "main"),
    );
    for (const p of ["email", "papercusp", "oddsmith", "hello-world-3-pot"]) {
      expect(pipelineRef(p, "main")).not.toMatch(bareRef("main"));
      expect(pipelineRef(p, "main")).toContain(p);
    }
  });
});

/**
 * RECURRENCE GUARD — the post-suite legs must NOT inherit the per-FORK heap cap.
 *
 * `main` sat frozen ~11h behind an OOM caused by two locally-correct fixes cancelling
 * each other: the gate pins NODE_OPTIONS to GREEN_CHECKPOINT_FORK_HEAP_MB (4 GiB,
 * sized for EIGHT CONCURRENT vitest forks) and hands that same env to the post-suite
 * legs, which run SEQUENTIALLY; `tscChildEnv` (scripts/lib/tsc-baseline-gate.mjs) then
 * DEFERS to any pin the caller already set — deliberately, so a constrained box can pin
 * a smaller one and win — so its TSC_HEAP_MB=8192 could never apply inside the gate.
 * Candidate 28ad34252e5f died at `Scavenge 4069.4 (4092.1) MB`.
 *
 * This asserts the WIRING, not the constant. WI-37503's fix existed and was INERT
 * because nothing checked it reached the path the gate actually runs — precisely the
 * failure this guard must be able to catch.
 */
describe("post-suite legs get their own heap (WI-37510: fork cap OOM'd lint:tsc, froze main ~11h)", () => {
  it("the POST-SUITE ceiling must exceed the per-fork cap, or the whole fix is a no-op", () => {
    expect(GREEN_CHECKPOINT_POST_SUITE_HEAP_MB).toBeGreaterThan(
      GREEN_CHECKPOINT_FORK_HEAP_MB,
    );
  });

  it("spawns lint:tsc with the POST-SUITE heap, never the 4 GiB fork cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-heap-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: { "lint:tsc": "node scripts/lint-tsc.mjs" },
        }),
      );

      let lintTscNodeOptions: string | undefined;
      const exec = (async (
        _cmd: string,
        args: string[],
        opts?: { env?: NodeJS.ProcessEnv },
      ) => {
        if (args.includes("lint:tsc"))
          lintTscNodeOptions = opts?.env?.NODE_OPTIONS;
        return { code: 0, stdout: "", stderr: "" };
      }) as unknown as Parameters<typeof runPostSuiteLegs>[2];

      // The env EXACTLY as the gate builds it: the bg-host's 128 GiB stripped and
      // pinned to the per-fork cap. This is the input that caused the outage.
      const suiteEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        NODE_OPTIONS: sanitizeForkNodeOptions(
          "--expose-gc --max-old-space-size=131072",
        ),
      };
      // Precondition: prove the fixture reproduces the BAD input, so a passing
      // assertion below cannot come from an env that was never capped in the first place.
      expect(suiteEnv.NODE_OPTIONS).toContain(
        `--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`,
      );

      await runPostSuiteLegs(dir, suiteEnv, exec, "apps/operator");

      expect(lintTscNodeOptions).toBeDefined();
      expect(lintTscNodeOptions).toContain(
        `--max-old-space-size=${GREEN_CHECKPOINT_POST_SUITE_HEAP_MB}`,
      );
      expect(lintTscNodeOptions).not.toContain(
        `--max-old-space-size=${GREEN_CHECKPOINT_FORK_HEAP_MB}`,
      );
      // Exactly ONE ceiling: a second occurrence silently takes the LAST, which is how
      // an "append" fix looks correct in review and behaves unpredictably at runtime.
      expect(lintTscNodeOptions?.match(/--max-old-space-size/g)).toHaveLength(
        1,
      );
      // And it must not eat unrelated flags the gate set.
      expect(lintTscNodeOptions).toContain("--expose-gc");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("frozen candidate forward-compat review clock", () => {
  it("passes the persisted queue time only to the forward-compat lint subprocess", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-frozen-review-clock-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: {
            "lint:migrations": "node lint-migrations.mjs",
            "lint:migration-forward-compat": "node check-forward-compat.mjs",
          },
        }),
      );

      const calls: Array<{
        cmd: string;
        args: string[];
        env?: NodeJS.ProcessEnv;
      }> = [];
      const exec = (async (
        cmd: string,
        args: string[],
        opts?: { env?: NodeJS.ProcessEnv },
      ) => {
        calls.push({ cmd, args, env: opts?.env });
        return { code: cmd === "git" ? 1 : 0, stdout: "", stderr: "" };
      }) as unknown as Parameters<typeof runPostSuiteLegs>[2];
      const openedAtMs = Date.parse("2026-09-27T13:00:00.000Z");

      const result = await runPostSuiteLegs(
        dir,
        { NODE_ENV: "test" },
        exec,
        "apps/operator",
        { frozenCandidateOpenedAtMs: openedAtMs },
      );

      const forwardCompat = calls.find((call) =>
        call.args.includes("lint:migration-forward-compat"),
      );
      const migrations = calls.find((call) =>
        call.args.includes("lint:migrations"),
      );
      expect(result.lintMigrationForwardCompat.status).toBe("passed");
      expect(forwardCompat?.env?.PAPERCUSP_FROZEN_CANDIDATE_OPENED_AT_MS).toBe(
        String(openedAtMs),
      );
      expect(
        migrations?.env?.PAPERCUSP_FROZEN_CANDIDATE_OPENED_AT_MS,
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P-005: post-suite low-memory scheduling and timing evidence", () => {
  const lowMemoryScripts = [
    "lint:no-owner-name-tags",
    "lint:no-box-identity",
    "lint:no-identity-literals",
    "lint:design-primitives",
    "lint:no-control-bytes",
    "lint:guard-reachability",
    "lint:mock-cast-escape",
    "lint:timer-classification",
    "lint:no-raw-setinterval",
  ] as const;

  // WI-10006055: the plane lints census the LIVE plane, but the suite env is DSN-free by
  // design, so they resolved ~/.papercusp/embedded-pg.json — on 2026-10-10 the installed
  // Papercusp Server sidecar (522 rows) — and red-pinned the gate with `0/522`.
  it("hands ONLY the live-plane lints the gate's operator DSN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-plane-dsn-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            ["lint:tsc", "lint:migrations", "lint:plane-producers", "lint:plane-ratchet"].map(
              (script) => [script, `node ${script}.mjs`],
            ),
          ),
        }),
      );
      const seen = new Map<string, string | undefined>();
      const exec: CheckpointExec = async (cmd, args, opts) => {
        const runIndex = args.indexOf("run");
        const id = cmd === "npm" && runIndex >= 0 ? args[runIndex + 1]! : cmd;
        seen.set(id, opts?.env?.HARNESS_ADMIN_DATABASE_URL);
        return { code: 0, stdout: "", stderr: "" };
      };
      const operatorPgEnv = gateOperatorPgEnv({
        DATABASE_URL: "postgresql://op@localhost:5432/papercusp",
      });
      // Calibration: the helper must produce the variable pg-url.mjs ranks FIRST, or a
      // passing assertion below could come from a key no resolver reads.
      expect(operatorPgEnv).toEqual({
        HARNESS_ADMIN_DATABASE_URL: "postgresql://op@localhost:5432/papercusp",
      });

      await runPostSuiteLegs(dir, { NODE_ENV: "test" }, exec, "apps/operator", {
        operatorPgEnv,
      });

      expect(seen.get("lint:plane-producers")).toBe("postgresql://op@localhost:5432/papercusp");
      expect(seen.get("lint:plane-ratchet")).toBe("postgresql://op@localhost:5432/papercusp");
      // WI-6554700010009206: lint:migrations is a live-plane lint too (its PG leg reads the
      // reservation ledger from the operator DB), so it gets the DSN as well.
      expect(seen.get("lint:migrations")).toBe("postgresql://op@localhost:5432/papercusp");
      // Every other leg stays DSN-free: the candidate suite must never reach the host DB.
      expect(seen.has("lint:tsc")).toBe(true);
      expect(seen.get("lint:tsc")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gateOperatorPgEnv follows databaseEvidence's precedence and is empty without a DSN", () => {
    expect(
      gateOperatorPgEnv({ HARNESS_ADMIN_DATABASE_URL: "postgresql://a/x", DATABASE_URL: "postgresql://b/y" }),
    ).toEqual({ HARNESS_ADMIN_DATABASE_URL: "postgresql://a/x" });
    expect(gateOperatorPgEnv({ HARNESS_DATABASE_URL: "postgresql://h/z" })).toEqual({
      HARNESS_ADMIN_DATABASE_URL: "postgresql://h/z",
    });
    expect(gateOperatorPgEnv({})).toEqual({});
  });

  it("caps the measured lint group at two children and keeps sequential/downstream legs outside it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-budget-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            [
              "lint:tsc",
              "lint:migrations",
              ...lowMemoryScripts,
              "lint:plane-producers",
            ].map((script) => [script, `node ${script}.mjs`]),
          ),
        }),
      );

      const lowMemorySet = new Set<string>(lowMemoryScripts);
      const events: string[] = [];
      const lowMemoryNodeOptions: string[] = [];
      let activeLowMemory = 0;
      let peakLowMemory = 0;
      let clock = 100;
      const exec: CheckpointExec = async (cmd, args, opts) => {
        const runIndex = args.indexOf("run");
        const id = cmd === "npm" && runIndex >= 0 ? args[runIndex + 1]! : cmd;
        events.push(`start:${id}`);
        if (lowMemorySet.has(id)) {
          activeLowMemory++;
          peakLowMemory = Math.max(peakLowMemory, activeLowMemory);
          lowMemoryNodeOptions.push(opts?.env?.NODE_OPTIONS ?? "");
          // Both workers reach this yield before either completes. A third worker would
          // therefore raise peakLowMemory above the fixed two-child resource envelope.
          await Promise.resolve();
          clock += 7;
          activeLowMemory--;
        } else {
          clock += 3;
        }
        events.push(`end:${id}`);
        // `git grep` exit 1 means the candidate contains no conflict markers.
        return { code: cmd === "git" ? 1 : 0, stdout: "", stderr: "" };
      };

      const result = await runPostSuiteLegs(
        dir,
        { NODE_ENV: "test", NODE_OPTIONS: "--expose-gc" },
        exec,
        "@papercusp/operator-vite",
        { now: () => clock },
      );

      expect(GREEN_CHECKPOINT_LOW_MEMORY_LINT_BUDGET_MB).toBe(
        GREEN_CHECKPOINT_LOW_MEMORY_LINT_HEAP_MB *
          GREEN_CHECKPOINT_LOW_MEMORY_LINT_MAX_CONCURRENCY,
      );
      expect(peakLowMemory).toBe(
        GREEN_CHECKPOINT_LOW_MEMORY_LINT_MAX_CONCURRENCY,
      );
      expect(lowMemoryNodeOptions).toHaveLength(lowMemoryScripts.length);
      for (const nodeOptions of lowMemoryNodeOptions) {
        expect(nodeOptions).toContain(
          `--max-old-space-size=${GREEN_CHECKPOINT_LOW_MEMORY_LINT_HEAP_MB}`,
        );
        expect(nodeOptions).not.toContain(
          `--max-old-space-size=${GREEN_CHECKPOINT_POST_SUITE_HEAP_MB}`,
        );
      }

      const typecheckEnd = events.indexOf("end:lint:tsc");
      const migrationsEnd = events.indexOf("end:lint:migrations");
      const firstLowMemoryStart = Math.min(
        ...lowMemoryScripts.map((script) => events.indexOf(`start:${script}`)),
      );
      const lastLowMemoryEnd = Math.max(
        ...lowMemoryScripts.map((script) => events.indexOf(`end:${script}`)),
      );
      const planeStart = events.indexOf("start:lint:plane-producers");
      const buildStart = events.indexOf("start:build");
      expect(typecheckEnd).toBeLessThan(firstLowMemoryStart);
      expect(migrationsEnd).toBeLessThan(firstLowMemoryStart);
      expect(lastLowMemoryEnd).toBeLessThan(planeStart);
      expect(planeStart).toBeLessThan(buildStart);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a stable ordered record and wall timing for every logical post-suite leg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "green-postsuite-records-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: Object.fromEntries(
            lowMemoryScripts.map((script) => [script, `node ${script}.mjs`]),
          ),
        }),
      );

      let clock = 1_000;
      const exec: CheckpointExec = async (cmd) => {
        await Promise.resolve();
        clock += cmd === "git" ? 2 : 5;
        return { code: cmd === "git" ? 1 : 0, stdout: "", stderr: "" };
      };
      const result = await runPostSuiteLegs(
        dir,
        { NODE_ENV: "test" },
        exec,
        "@papercusp/operator-vite",
        { now: () => clock },
      );

      expect(result.records.map((record) => record.id)).toEqual([
        "lint:tsc",
        "lint:tsc:papercusp-libs",
        "lint:tsc:workspaces",
        "lint:tsc:operator",
        "lint:tsc:orchestrator",
        "lint:tsc:scripts",
        "lint:migrations",
        "lint:migration-forward-compat",
        "lint:identity-leak",
        "lint:design-primitives",
        "lint:no-control-bytes",
        "lint:guard-reachability",
        "lint:condition-rail",
        "lint:mock-cast-escape",
        "lint:timer-classification",
        "lint:no-raw-setinterval",
        "lint:plane-integrity",
        // WI-10004205 / D-099: runs once per candidate, after the plane probes.
        "lint:vacuous-negatives",
        "spa-build",
      ]);
      const executed = result.records.filter(
        (record) => record.status === "passed",
      );
      expect(executed.length).toBeGreaterThan(0);
      expect(executed.every((record) => record.durationMs > 0)).toBe(true);
      for (const record of result.records) {
        expect(result.output).toContain(
          `POST_SUITE_LEG id=${record.id} status=${record.status} durationMs=${record.durationMs}`,
        );
      }
      expect(result.output).toContain(
        `POST_SUITE_SCHEDULER lowMemoryMode=parallel maxConcurrency=${GREEN_CHECKPOINT_LOW_MEMORY_LINT_MAX_CONCURRENCY} memoryBudgetMb=${GREEN_CHECKPOINT_LOW_MEMORY_LINT_BUDGET_MB} workerHeapMb=${GREEN_CHECKPOINT_LOW_MEMORY_LINT_HEAP_MB}`,
      );
      expect(result.output).toMatch(
        /POST_SUITE_RESULT status=passed durationMs=\d+/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WI-10004205 / D-099: lint:vacuous-negatives skips a candidate that predates its ratchet", () => {
  // The gate code runs from the working tree, but a resumed frozen candidate can be an OLDER
  // tree whose script has no baseline. That script judges a corpus it was never made precise
  // for, so its red must not hold promotion: the leg skips when the baseline file is absent.
  const runVacuousLeg = async (opts: { baseline: boolean; code: number }) => {
    const dir = mkdtempSync(join(tmpdir(), "green-vacuous-leg-"));
    const calls: string[][] = [];
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: {
            "lint:vacuous-negatives":
              "node scripts/check-vacuous-negative-assertions.mjs",
          },
        }),
      );
      if (opts.baseline) {
        mkdirSync(join(dir, "scripts"), { recursive: true });
        writeFileSync(
          join(dir, VACUOUS_NEGATIVE_BASELINE_FILE),
          JSON.stringify({ entries: [] }),
        );
      }
      const exec = (async (_cmd: string, args: string[]) => {
        calls.push(args);
        return args.includes("lint:vacuous-negatives")
          ? { code: opts.code, stdout: "DRIFTED fixture\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" };
      }) as unknown as Parameters<typeof runPostSuiteLegs>[2];
      const result = await runPostSuiteLegs(
        dir,
        { NODE_ENV: "test" },
        exec,
        "apps/operator",
      );
      const ranScript = calls.some((a) => a.includes("lint:vacuous-negatives"));
      return { result, ranScript };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("no baseline file: the leg is skipped with the pre-ratchet reason, the script never runs, and a red script cannot hold promotion", async () => {
    const { result, ranScript } = await runVacuousLeg({ baseline: false, code: 1 });
    expect(result.lintVacuousNegatives).toEqual({
      status: "skipped",
      skipReason: VACUOUS_NEGATIVE_PRE_RATCHET_SKIP_REASON,
    });
    expect(ranScript).toBe(false);
    expect(result.failingSignatures).not.toContain("lint:vacuous-negatives");
    expect(result.output).toContain(
      `POST_SUITE_LEG id=lint:vacuous-negatives status=skipped`,
    );
  });

  it("calibration: WITH the baseline file the same red script runs and fails the leg", async () => {
    // Without this control the skip test above would also pass if the leg were deleted or
    // skipped unconditionally.
    const { result, ranScript } = await runVacuousLeg({ baseline: true, code: 1 });
    expect(ranScript).toBe(true);
    expect(result.lintVacuousNegatives).toEqual({ status: "failed" });
    expect(result.failingSignatures).toContain("lint:vacuous-negatives");
  });

  it("calibration: WITH the baseline file a clean script passes the leg", async () => {
    const { result, ranScript } = await runVacuousLeg({ baseline: true, code: 0 });
    expect(ranScript).toBe(true);
    expect(result.lintVacuousNegatives).toEqual({ status: "passed" });
  });
});

describe("targeted post-suite summary", () => {
  it("names executed leg records and excludes skipped legs", () => {
    expect(
      summarizeTargetedPostSuiteLegs({
        ok: true,
        records: [
          { id: "lint:tsc", status: "passed" },
          { id: "lint:migrations", status: "passed" },
          { id: "spa-build", status: "skipped" },
        ],
        failingSignatures: [],
      }),
    ).toBe("targeted post-suite gates passed (lint:tsc, lint:migrations)");
  });
});

describe("WI-37527: the typecheck banner must not out-claim its evidence", () => {
  // typecheckFailureBanner() has its own unit tests in gate-artifact-verdict-tail.
  // These assert the WIRING instead: that the banner the GATE actually emits comes from
  // that helper. WI-37503 is the reason the distinction matters — a correct, committed,
  // fully-tested fix sat INERT because nothing checked it reached the path the gate runs.
  const runLintTsc = async (code: number, stdout: string) => {
    const dir = mkdtempSync(join(tmpdir(), "green-tsc-banner-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: { "lint:tsc": "node scripts/lint-tsc.mjs" },
        }),
      );
      const exec = (async (_cmd: string, args: string[]) =>
        args.includes("lint:tsc")
          ? { code, stdout, stderr: "" }
          : { code: 0, stdout: "", stderr: "" }) as unknown as Parameters<
        typeof runPostSuiteLegs
      >[2];
      return await runPostSuiteLegs(
        dir,
        { NODE_ENV: "test" },
        exec,
        "apps/operator",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("a lint:tsc failure carrying NO type diagnostics must not announce type regressions", async () => {
    // The literal WI-37503 shape: non-zero exit, zero `error TS\d+`.
    const oom =
      "FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory\n";
    const res = await runLintTsc(134, oom);

    // Preconditions: the leg really failed and its output really reached the verdict, so
    // the assertions below cannot pass merely because no banner was ever emitted.
    expect(res.typecheck.status).toBe("failed");
    expect(res.output).toContain(oom);

    expect(res.output).not.toContain("type regressions block the release");
    expect(res.output).toContain("NO type diagnostics");
    expect(res.output).toContain("exit=134");
  });

  it("a REAL type regression still gets the regression banner", async () => {
    // Calibration: without this, the assertions above would also pass if the banner were
    // deleted outright, or if the helper were wired to always emit the honest wording.
    const res = await runLintTsc(
      1,
      "foo.ts(12,3): error TS2322: Type 'a' is not assignable.\n",
    );

    expect(res.typecheck.status).toBe("failed");
    expect(res.output).toContain("type regressions block the release");
    expect(res.output).not.toContain("NO type diagnostics");
  });

  it("CONTROL — the pre-fix hardcoded banner FAILS the property above (so the guard is falsifiable)", () => {
    // A guard that has never failed is a guard nobody has tested. Proving it here rather
    // than by mutating green-checkpoint.ts: this tree is edited concurrently by the whole
    // fleet and git-sync commits it every few minutes, so an in-tree mutation can be swept
    // into a real candidate mid-probe (that is a measured incident, not a hypothetical).
    //
    // This is the exact string the leg pushed before the wiring landed. It is a CONSTANT,
    // so it announces "type regressions" no matter what the run actually produced.
    const preFixBanner =
      "\n\n=== TYPECHECK FAILED (npm run lint:tsc) — operator-core type regressions block the release ===\n";
    const oom =
      "FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap out of memory\n";
    const preFixOutput = preFixBanner + oom;

    // The OOM case: the pre-fix output violates both halves of the property, so a revert
    // of the wiring reds the first test deterministically rather than silently passing.
    expect(preFixOutput).toContain("type regressions block the release");
    expect(preFixOutput).not.toContain("NO type diagnostics");

    // And the reason it is wrong is not the wording but the INDIFFERENCE to evidence:
    // the same constant is emitted for output carrying no tsc diagnostic at all.
    expect(/error TS\d+/.test(oom)).toBe(false);
  });
});

/**
 * EI-20014356905761236 — the verdict log must state whether its verdict COUNTED.
 *
 * The incident (2026-08-09 ~21:53Z): one question about one candidate (33cd2bfebec8) drew
 * three different answers from three authoritative surfaces — the persisted verdict log said
 * `green=true`, `release:deploy` said `skipped-locked`, and gate_health's `observedCandidate`
 * still named an older red. Reconciling them took six tool calls, and `main` had not moved.
 * The missing datum was never the VERDICT; it was whether the verdict PROMOTED.
 *
 * The header physically cannot carry it: it is written by the suite dep at suite-end, while
 * every promotion decision (held gates / fast-forward / prefix salvage / refire) is taken
 * afterwards by runGreenCheckpoint. Hence a trailer, stamped per disposition.
 *
 * These pin the BEHAVIOUR — "the log distinguishes promoted from merely green" — not the
 * wording of any one line. The third case is the falsifiability control.
 */
describe("EI-20014356905761236: the verdict log records whether its verdict promoted", () => {
  const trailer = (logPath: string): string =>
    (readFileSync(logPath, "utf8").match(/GATE_PROMOTION.*/g) ?? []).at(-1) ??
    "";

  /** stubDeps' runGreen reports no logPath; give the run a real file to stamp. */
  const withLog = (
    deps: CheckpointDeps,
    green: boolean,
    logPath: string,
  ): CheckpointDeps => {
    writeFileSync(
      logPath,
      `[green-checkpoint] candidate=... green=${green} promoted=see-GATE_PROMOTION\n`,
    );
    return {
      ...deps,
      runGreen: async () => ({
        green,
        summary: green ? "all pass" : "3 failed",
        logPath,
      }),
    };
  };

  it("⭐ a GREEN candidate that is HELD says promoted=false, with the reason that held it", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-held.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    deps.perfGate = async () => ({ action: "block", summary: "perf BLOCK" });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      green: true,
      advanced: false,
      reason: "perf-held",
    });
    expect(await revParse(repo, "ready")).toBe(c1); // the pin genuinely did not move
    // THE POINT: the log itself now separates the two, so `green=true` in the header can no
    // longer be read as "this became the pin".
    expect(trailer(logPath)).toContain("green=true");
    expect(trailer(logPath)).toContain("promoted=false");
    expect(trailer(logPath)).toContain("reason=perf-held");
    // ...and a held verdict points AT that log, or the trailer is unreachable from the tool
    // surface that reports the hold (a held result used to carry no logPath at all).
    expect(r.logPath).toBe(logPath);
  });

  it("EI-20689157831228179: a HELD verdict fires the global + pipeline-scoped held event — checkpoint:await must not sleep to its deadline on the single most actionable outcome the gate can produce", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-held-event.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    deps.perfGate = async () => ({ action: "block", summary: "perf BLOCK" });
    const emitted: {
      key: string;
      summary: string;
      payload: unknown;
      cancelSiblingKeysFor?: string[];
    }[] = [];
    deps.emitEvent = async ({
      key,
      summary,
      payload,
      cancelSiblingKeysFor,
    }) => {
      emitted.push({ key, summary, payload, cancelSiblingKeysFor });
    };

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      green: true,
      advanced: false,
      reason: "perf-held",
    });
    const pipeline = pipelineName(repo);
    const heldEvents = emitted.filter((e) =>
      e.key.startsWith("green-checkpoint:held"),
    );
    expect(heldEvents.map((e) => e.key)).toEqual([
      "green-checkpoint:held",
      `green-checkpoint:held:${pipeline}`,
    ]);
    for (const e of heldEvents) {
      expect(e.payload).toMatchObject({
        sha: r.candidate,
        pipeline,
        reason: "perf-held",
        summary: "perf BLOCK",
      });
      expect(e.summary).toContain("HELD");
      expect(e.summary).toContain("perf-held");
      // The three OTHER terminal outcomes are mutually exclusive with this one for the
      // same candidate — a held emit must retire any stale pending wait on them.
      expect(e.cancelSiblingKeysFor).toEqual(
        expect.arrayContaining([
          "release:green",
          `release:green:${pipeline}`,
          "green-checkpoint:red",
          `green-checkpoint:red:${pipeline}`,
          "green-checkpoint:inconclusive",
          `green-checkpoint:inconclusive:${pipeline}`,
        ]),
      );
    }
    // Neither of the other three families fired — held is mutually exclusive with them.
    expect(emitted.some((e) => e.key.startsWith("release:green"))).toBe(false);
    expect(emitted.some((e) => e.key.startsWith("green-checkpoint:red"))).toBe(
      false,
    );
  });

  it("a candidate that really did become the pin says promoted=true (the positive control)", async () => {
    // Without this, a stamp that never fired on the happy path would be indistinguishable
    // from a working one: every observed log would simply say promoted=false.
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    const c2 = await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-advanced.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      green: true,
      advanced: true,
      reason: "advanced",
    });
    expect(await revParse(repo, "ready")).toBe(c2);
    expect(trailer(logPath)).toContain("promoted=true");
    expect(trailer(logPath)).toContain(`advancedTo=${c2.slice(0, 12)}`);
  });

  it("⭐ promoted reflects the ACTUAL fast-forward — not `green`, and not `reason`", async () => {
    // THE FALSIFIABILITY CONTROL. green===true and reason==='advanced' while the advance
    // itself declined, so deriving `promoted` from either would report true here. That silent
    // "reason=advanced but main never moved" state is the class of confident-wrong reading
    // this trailer exists to kill — a re-derivation from green/reason reds THIS test while
    // still passing the two above.
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-declined.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    // The real decline: `advance` is FF-only, so a candidate that is not a descendant of
    // the current pin comes back advanced:false / not-fast-forward.
    deps.advance = async (candidate) => ({
      advanced: false,
      from: c1,
      to: candidate,
      reason: "not-fast-forward",
    });

    const r = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(r).toMatchObject({
      green: true,
      advanced: false,
      reason: "advanced",
    });
    expect(trailer(logPath)).toContain("green=true");
    expect(trailer(logPath)).toContain("reason=advanced");
    expect(trailer(logPath)).toContain("promoted=false");
    expect(trailer(logPath)).not.toContain("advancedTo=");
  });

  it("renders one greppable line, in the house GATE_HELD_BY / AFFECTED_TESTS_RESULT shape", () => {
    const line = formatGatePromotionTrailer({
      candidate: "a".repeat(40),
      green: true,
      promoted: true,
      reason: "advanced",
      advancedTo: "b".repeat(40),
    });
    // `grep -o 'GATE_PROMOTION.*'` must return the whole record, so it cannot wrap.
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(line.trim()).toBe(
      "GATE_PROMOTION candidate=aaaaaaaaaaaa green=true promoted=true reason=advanced advancedTo=bbbbbbbbbbbb",
    );
  });

  /**
   * WI-39450 / WI-39671: the verdict must be on disk BEFORE the optional post-verdict legs,
   * because those legs are where runs die. Two harnesses hit the same window from opposite
   * sides on 2026-08-17: papercusp's GENUINE red died mid-prefix-salvage (a second full affected
   * suite) and left no trailer, so the verdict was never recorded and `main` froze behind an
   * inflated streak; oddsmith's suite PASSED (4460 tests) and died before promotion, and the
   * ledger recorded a FALSE red. One missing datum, two opposite misreadings.
   *
   * These do NOT kill a process — they read the log from INSIDE a leg that runs in the death
   * window, which is the same observation a SIGTERM at that instant would leave behind, and is
   * deterministic. `trailer()` takes the LAST match, so it also proves the early stamp is
   * superseded rather than sticky.
   */
  it("⭐ stamps the suite verdict before the optional GREEN-path legs (oddsmith's window)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-pending-green.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    let onDiskDuringLeg = "";
    deps.perfGate = async () => {
      onDiskDuringLeg = trailer(logPath);
      return { action: "pass", summary: "perf ok" };
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // A run killed right here now says how its suite went, instead of saying nothing.
    expect(onDiskDuringLeg).toContain("green=true");
    expect(onDiskDuringLeg).toContain("reason=decision-pending");
    // ...and the real disposition supersedes it, so `tail -1` never reports pending afterwards.
    expect(trailer(logPath)).not.toContain("decision-pending");
  });

  it("⭐ records the known suite result before GREEN-path legs can kill the process", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const { deps } = stubDeps(true);
    deps.runId = "pending-run-1";
    const pending: unknown[] = [];
    deps.recordPendingVerdict = async (result) => {
      pending.push(result);
      return true;
    };
    deps.perfGate = async () => {
      // The optional leg is the kill window. The durable pending write must already
      // have observed the suite result and the run identity before this callback runs.
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        green: true,
        reason: "up-to-date",
        promotionPending: true,
        runId: "pending-run-1",
      });
      return { action: "pass", summary: "perf ok" };
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(pending).toHaveLength(1);
  });

  it("⭐ stamps the suite verdict before the optional RED-path legs (papercusp's window)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "verdict-pending-red.log");
    const deps = withLog(stubDeps(false).deps, false, logPath);
    let onDiskDuringLeg = "";
    deps.deployStaleness = async () => {
      onDiskDuringLeg = trailer(logPath);
      return null;
    };

    await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(onDiskDuringLeg).toContain("green=false");
    expect(onDiskDuringLeg).toContain("reason=decision-pending");
    expect(trailer(logPath)).toContain("reason=not-green");
    expect(trailer(logPath)).not.toContain("decision-pending");
  });

  it.each(["read", "broadcast", "escalate"] as const)(
    "finishes the known red when the optional deploy-staleness %s never settles",
    async (stalledLeg) => {
      const c1 = await commit("a", "1", "c1");
      await git(repo, ["branch", "ready", c1]);
      const candidate = await commit("a", "2", "c2");
      const logPath = join(repo, `red-advisory-${stalledLeg}.log`);
      const deps = withLog(stubDeps(false).deps, false, logPath);
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const pending = new Promise<void>((resolve) => { release = resolve; });
      let inStalenessTail = false;
      deps.deployStaleness = async () => {
        inStalenessTail = true;
        vi.useFakeTimers();
        enter();
        if (stalledLeg === "read") await pending;
        return { pinAgeMs: 365 * 24 * 60 * 60_000, commitsBehind: 10_000 };
      };
      deps.broadcast = async () => {
        if (inStalenessTail && stalledLeg === "broadcast") await pending;
      };
      deps.escalate = async () => {
        if (inStalenessTail && stalledLeg === "escalate") await pending;
      };
      const logs: string[] = [];
      deps.log = (message) => { logs.push(message); };
      let settled = false;
      const running = runGreenCheckpoint(cfg(), deps, { candidate, noPush: true })
        .then((result) => { settled = true; return result; });
      try {
        await entered;
        await vi.advanceTimersByTimeAsync(8_001);
        expect(settled, "optional notification must not own the gate run-lock").toBe(true);
        expect(await running).toMatchObject({ candidate, green: false, advanced: false, reason: "not-green" });
        expect(trailer(logPath)).toContain("reason=not-green");
        expect(logs.some((message) => message.includes("red-tail advisory"))).toBe(true);
      } finally {
        release();
        vi.useRealTimers();
        await running;
      }
    },
  );

  /**
   * The ADVANCE leg — the last window that could throw without stamping a disposition, because
   * the success trailer is written only after BOTH the push and the local fast-forward. A throw
   * here left `decision-pending` standing, which reads as "died in an OPTIONAL post-verdict leg"
   * and is precisely wrong: the gate decided green and died publishing it.
   *
   * Measured on oddsmith, where this is not an edge case but every run — it has no push
   * credential (`fatal: could not read Username`, 461 unpushed commits, WI-39549), so 4
   * consecutive greens (2026-08-17 09:19Z→12:19Z) stamped no promotion trailer at all while
   * `main` sat frozen and the gate's own log could not name the cause.
   *
   * Both assert the throw still PROPAGATES: it is load-bearing (it is what stops a failed push
   * being reported as a green advance), so this adds a record, it does not swallow.
   */
  it("⭐ stamps push-failed when publishing the green candidate throws (oddsmith's window)", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "push-failed.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    deps.push = async () => {
      throw new Error(
        "fatal: could not read Username for 'https://github.com'",
      );
    };

    await expect(runGreenCheckpoint(cfg(), deps)).rejects.toThrow(
      /could not read Username/,
    );

    // The gate's own log now names the real disposition instead of leaving the early
    // `decision-pending` line to be misread as a death in an optional leg.
    const t = trailer(logPath);
    expect(t).toContain("reason=push-failed");
    expect(t).toContain("green=true");
    expect(t).toContain("promoted=false");
    expect(t).not.toContain("decision-pending");
  });

  it("⭐ stamps advance-failed when the local fast-forward throws", async () => {
    const c1 = await commit("a", "1", "c1");
    await git(repo, ["branch", "ready", c1]);
    await commit("a", "2", "c2");
    const logPath = join(repo, "advance-failed.log");
    const deps = withLog(stubDeps(true).deps, true, logPath);
    deps.advance = async () => {
      throw new Error("fast-forward refused");
    };

    await expect(
      runGreenCheckpoint(cfg(), deps, { noPush: true }),
    ).rejects.toThrow(/fast-forward refused/);

    const t = trailer(logPath);
    expect(t).toContain("reason=advance-failed");
    expect(t).toContain("green=true");
    expect(t).toContain("promoted=false");
    expect(t).not.toContain("decision-pending");
  });
});

describe("WI-42350: a sha that already reached a RED verdict is not re-judged", () => {
  const readyAndCandidate = async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    return { ready, candidate };
  };

  it("skips materialization AND the suite when the candidate equals the last judged-red sha", async () => {
    const { ready, candidate } = await readyAndCandidate();
    const { deps, calls } = stubDeps(false);
    deps.lastJudgedRed = async () => candidate;

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({
      advanced: false,
      candidate,
      from: ready,
      reason: "unchanged-since-verdict",
    });
    // The whole point of the item: the tree is byte-identical by definition of the
    // sha, so re-running cannot produce new information. Nothing may be materialized
    // and no suite may run.
    expect(calls).not.toContain("runGreen");
    expect(calls.some((call) => call.startsWith("setup:"))).toBe(false);
    expect(calls).not.toContain("advance");
  });

  it("reports green:null and NOT false — a run that declined to judge must not inflate the red streak", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps } = stubDeps(false);
    deps.lastJudgedRed = async () => candidate;

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    // `green:false` asserts THIS RUN judged the candidate and found it red. This run
    // judged nothing. consecutiveReds counts `false`, so emitting it here would inflate
    // the streak with runs that executed zero tests — the exact false signal WI-42350
    // exists to stop. `toBeNull` alone would also pass for `false` under a loose read,
    // so the negative assertion is deliberate.
    expect(result.green).toBeNull();
    expect(result.green).not.toBe(false);
  });

  it("is sha-EXACT: a marker naming a different sha judges normally", async () => {
    const { ready, candidate } = await readyAndCandidate();
    const { deps, calls } = stubDeps(true);
    deps.lastJudgedRed = async () => ready; // some OTHER sha

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result.reason).not.toBe("unchanged-since-verdict");
    expect(calls).toContain("runGreen");
    expect(result).toMatchObject({ green: true, reason: "advanced" });
  });

  it("fails OPEN — an unreadable marker costs one redundant run and can never become a verdict", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps, calls } = stubDeps(true);
    deps.lastJudgedRed = async () => {
      throw new Error("not a git repository");
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(calls).toContain("runGreen");
    expect(result).toMatchObject({ green: true, reason: "advanced" });
  });

  it("degrades to always-re-judge for a dep that predates the marker", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps, calls } = stubDeps(true);

    // The optionality is the back-compat contract: every fake dep in this suite
    // predates the marker and must keep judging rather than throwing.
    expect(deps.lastJudgedRed).toBeUndefined();

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(calls).toContain("runGreen");
    expect(result).toMatchObject({ green: true, reason: "advanced" });
  });

  // EI-22430783328866306 — the marker and the frozen queue can disagree about a repair head.
  // The marker is stamped by a terminal red; the queue learns that red only if the same run
  // also reaches markFrozenRepairVerificationRed. A run killed between the two leaves a head
  // the marker calls judged and the queue calls unjudged; skipping on the marker alone then
  // starves the convergence forever (measured 2026-09-05: 20 verdictless runs in one day).
  const frozenQueueAt = (input: {
    ready: string;
    frozen: string;
    repairHead: string;
    judgedHeads: string[];
  }): FrozenCandidateRepairQueue => {
    const now = Date.now();
    return {
      schemaVersion: 3,
      phase: "ready-to-verify",
      candidate: input.frozen,
      base: input.ready,
      repairHead: input.repairHead,
      attempts: 1,
      openedAtMs: now - 2_000,
      updatedAtMs: now - 1_000,
      fixerSpawnId: null,
      failingTests: ["@papercusp/operator-vite"],
      // P-003: only a typed post-suite leg takes this orchestration fixture through runGreen;
      // lint/workspace/seed signatures now use their bounded repair-round runners.
      signature: postSuiteSignature(input.repairHead),
      convergenceRounds: input.judgedHeads.map((head, i) => ({
        round: i + 1,
        head,
        failingCount: 1,
        atMs: now - 2_000 + i,
      })),
    };
  };

  it("EI-22430783328866306: persists a first red when the fixer dispatcher is absent", async () => {
    // The queue WRITER is load-bearing on its own: a red must remain resumable even when
    // dispatch is unavailable, rather than silently skipping the frozen queue entirely.
    // (The P-005 sweep c076b0dd95 dropped the production dispatcher by accident, not by
    // design — WI-10000758 restored it; see green-checkpoint-frozen-repair-dispatcher-
    // wiring.test.ts. This case keeps exercising the dispatcher-ABSENT path on purpose.)
    vi.stubEnv("PAPERCUSP_QUIET_CUT", "0");
    try {
      const ready = await commit("a", "1", "ready");
      await git(repo, ["branch", "ready", ready]);
      const candidate = await commit("b", "2", "candidate");
      const { deps, calls } = stubDeps(false, ["lib/broken.test.ts"]);
      const writes: FrozenCandidateRepairQueue[] = [];
      deps.writeFrozenRepairQueue = async (next) => {
        if (next) writes.push(next);
      };

      // Deliberately leave dispatchFrozenRepairFixer, reserve, and finalize absent.
      const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

      expect(result).toMatchObject({
        advanced: false,
        candidate,
        green: false,
        reason: "not-green",
        repairQueue: {
          phase: "awaiting-fixer",
          candidate,
          repairHead: candidate,
        },
      });
      expect(writes).toHaveLength(2);
      expect(writes[0]).toMatchObject({
        phase: "ready-to-test",
        candidate,
        repairHead: candidate,
      });
      expect(writes[1]).toMatchObject({
        phase: "awaiting-fixer",
        candidate,
        repairHead: candidate,
        failingTests: ["lib/broken.test.ts"],
      });
      expect(calls).toContain("runGreen");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("EI-22430783328866306: a frozen repair head the QUEUE has not judged is judged even when the marker names it", async () => {
    const { ready, candidate: frozen } = await readyAndCandidate();
    const head = await commit("c", "3", "fix admitted onto the frozen lineage");
    const queue = frozenQueueAt({
      ready,
      frozen,
      repairHead: head,
      judgedHeads: [frozen],
    });
    const logs: string[] = [];
    const { deps, calls } = stubDeps(true);
    deps.log = (line: string) => {
      logs.push(line);
    };
    deps.readFrozenRepairQueue = async () => queue;
    // The run that stamped this marker died before the queue received its verdict.
    deps.lastJudgedRed = async () => head;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.reason).not.toBe("unchanged-since-verdict");
    expect(calls).toContain("runGreen");
    expect(logs.some((line) => line.includes("EI-22430783328866306"))).toBe(
      true,
    );
  });

  it("EI-22430783328866306: the skip still holds for a frozen repair head the queue DID record a verdict for", async () => {
    const { ready, candidate: frozen } = await readyAndCandidate();
    const head = await commit("c", "3", "fix admitted onto the frozen lineage");
    const queue = frozenQueueAt({
      ready,
      frozen,
      repairHead: head,
      judgedHeads: [frozen, head],
    });
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.lastJudgedRed = async () => head;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.reason).toBe("unchanged-since-verdict");
    expect(calls).not.toContain("runGreen");
  });
});

describe("WI-42350: the judged-red marker is stamped ONLY by a verdict that actually judged the code", () => {
  const stampingDeps = (green: boolean) => {
    const { deps, calls } = stubDeps(green);
    const stamped: string[] = [];
    deps.recordJudgedRed = async (_repo, sha) => {
      stamped.push(sha);
    };
    return { deps, calls, stamped };
  };

  const readyAndCandidate = async () => {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const candidate = await commit("b", "2", "candidate");
    return { ready, candidate };
  };

  it("DOES stamp on a genuine terminal red (the positive control)", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps, stamped } = stampingDeps(false);

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({ green: false, reason: "not-green" });
    // Without this control the two negative tests below would pass vacuously — a
    // marker write that never fires at all satisfies "does not stamp" perfectly.
    expect(stamped).toEqual([candidate]);
  });

  it("does NOT stamp when the red is an INFRA fault — the code was never judged", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps, calls, stamped } = stampingDeps(false);
    deps.runGreen = async () => {
      calls.push("runGreen");
      return {
        green: false,
        summary: "3 failed",
        infraFault: {
          kind: "vite-node-cache-vanished" as const,
          occurrences: 7,
          note: "the gate's own vite-node module cache was deleted mid-suite",
        },
      };
    };

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      noPush: true,
    });

    expect(result).toMatchObject({ green: null, reason: "infra-inconclusive" });
    expect(calls).toContain("runGreen");
    // THE GUARD THIS ITEM TURNS ON. An infra-fault red means the code was never
    // actually judged. Stamping here would make the next tick skip a candidate nobody
    // ever tested, converting a transient host fault into a permanently unexamined
    // sha — the one way this optimization could hide a real regression.
    expect(stamped).toEqual([]);
  });

  it("does NOT stamp on a pinned diagnostic run", async () => {
    const { candidate } = await readyAndCandidate();
    const { deps, stamped } = stampingDeps(false);

    const result = await runGreenCheckpoint(cfg(), deps, {
      candidate,
      candidateSource: "pinned",
      noPush: true,
    });

    // A diagnostic run is an investigation, not a verdict: it must not be able to
    // suppress a future real judgement of this sha.
    expect(result.green).toBe(false);
    expect(stamped).toEqual([]);
  });
});

describe("EI-22062873162576188: capacity preflight measures the credential the fixer actually uses", () => {
  // Synthetic, deliberately NOT under /home — a hardcoded home path in shipped source
  // reds the identity-lint leg and freezes main (EI-18759401203875869). The value only
  // has to round-trip through the credentialRef comparison.
  const LOCAL_HOME = "/fixture/codex-home";
  // The exact shape measured on 2026-09-02: six walled codex rows including the LOCAL CLI
  // credential the fixer authenticates as, plus one healthy GATEWAY pool account it can
  // never reach (launch-blueprint sets no account/gateway env, and the per-spawn
  // CODEX_HOME symlinks ~/.codex/auth.json).
  const mixedPool = [
    {
      id: "chatgpt-sub-cli",
      usageWalled: true,
      readingStatus: "fresh",
      credentialRef: `codex-cli:${LOCAL_HOME}`,
    },
    {
      id: "aviynw5_codex",
      usageWalled: false,
      readingStatus: "fresh",
      credentialRef: "codex-cli:/creds/aviynw5_codex.codex-cli",
    },
    {
      id: "aviynw6_codex",
      usageWalled: true,
      readingStatus: "fresh",
      credentialRef: "codex-cli:/creds/aviynw6_codex.codex-cli",
    },
  ];

  // THE REGRESSION. Before the fix this returned the whole pool, the caller found
  // aviynw5_codex not-walled, returned ok:true, and the dispatch died at turn 1 on the
  // walled local credential — burning a repair-queue attempt every hour.
  it("ignores a healthy gateway account the direct-egress fixer cannot reach", () => {
    const { measured, scope, narrowed } = selectFixerCapacityRows({
      rows: mixedPool,
      provider: "codex",
      gatewayRouted: false,
      localCodexHome: LOCAL_HOME,
    });

    expect(narrowed).toBe(true);
    expect(measured.map((r) => r.id)).toEqual(["chatgpt-sub-cli"]);
    // The healthy row must not be in the measured set at all — its presence is exactly
    // what produced the false "go".
    expect(measured.some((r) => !r.usageWalled)).toBe(false);
    expect(scope).toContain(LOCAL_HOME);
  });

  // Fail-OPEN on an unknown, same rule as the stale-reading branch: if we cannot identify
  // the fixer's own row we must measure the pool rather than invent a wall.
  it("falls back to the whole pool when the local credential has no matching row", () => {
    const { measured, narrowed, scope } = selectFixerCapacityRows({
      rows: mixedPool,
      provider: "codex",
      gatewayRouted: false,
      localCodexHome: "/fixture/other-codex-home",
    });

    expect(narrowed).toBe(false);
    expect(measured).toHaveLength(3);
    expect(scope).toBe("the codex pool");
  });

  // When the spawn IS gateway-routed the pool is the correct population — narrowing to the
  // local credential there would withhold on an account the fixer is not using.
  it("keeps the pool population when the spawn is gateway-routed", () => {
    const { measured, narrowed } = selectFixerCapacityRows({
      rows: mixedPool,
      provider: "codex",
      gatewayRouted: true,
      localCodexHome: LOCAL_HOME,
    });

    expect(narrowed).toBe(false);
    expect(measured).toHaveLength(3);
  });

  // The local-CLI credential story is codex-specific; another provider must be untouched.
  it("does not narrow for a non-codex provider", () => {
    const { narrowed } = selectFixerCapacityRows({
      rows: mixedPool,
      provider: "claude",
      gatewayRouted: false,
      localCodexHome: LOCAL_HOME,
    });

    expect(narrowed).toBe(false);
  });
});

describe("WI-2141736: the fixer's provider is DERIVED from agent-config, never hardcoded", () => {
  // THE REGRESSION. The preflight named "codex" as a literal. On 2026-09-02 the owner
  // moved release-fixer to claude-opus-5:xhigh on claude-code; the preflight went on
  // measuring the (weekly-exhausted) codex pool, withheld every dispatch, and retired the
  // frozen repair queue 20 times in one day — disabling freeze-and-converge fleet-wide
  // while the fixer's real provider had 34% headroom. A config-only switch was a no-op.
  const withConfig = async (
    cfg: Record<string, unknown>,
  ): Promise<string | undefined> => {
    vi.doMock("@papercusp/operator-core/lib/agent-config", () => ({
      readAgentConfig: async () => cfg,
    }));
    try {
      const mod = await import("./green-checkpoint");
      return await mod.resolveReleaseFixerProvider();
    } finally {
      vi.doUnmock("@papercusp/operator-core/lib/agent-config");
      vi.resetModules();
    }
  };

  it("follows the role backend to claude when release-fixer is pinned to claude-code", async () => {
    await expect(
      withConfig({
        backend: "codex",
        roleBackends: { "release-fixer": "claude-code" },
      }),
    ).resolves.toBe("claude");
  });

  it("still answers codex when the role is pinned to codex", async () => {
    await expect(
      withConfig({
        backend: "claude-code",
        roleBackends: { "release-fixer": "codex" },
      }),
    ).resolves.toBe("codex");
  });

  it("falls back to the GLOBAL backend when the role carries no override", async () => {
    await expect(
      withConfig({ backend: "claude-code", roleBackends: {} }),
    ).resolves.toBe("claude");
  });

  // Failing OPEN is the contract: an unknown must never masquerade as a measured wall,
  // so a backend with no account-pool provider yields undefined and the caller keeps its
  // named default rather than withholding a dispatch.
  it("returns undefined for a backend with no account-pool provider", async () => {
    await expect(
      withConfig({ backend: "omp", roleBackends: {} }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined rather than throwing when the config cannot be read", async () => {
    vi.doMock("@papercusp/operator-core/lib/agent-config", () => ({
      readAgentConfig: async () => {
        throw new Error("config unreadable");
      },
    }));
    try {
      const mod = await import("./green-checkpoint");
      await expect(mod.resolveReleaseFixerProvider()).resolves.toBeUndefined();
    } finally {
      vi.doUnmock("@papercusp/operator-core/lib/agent-config");
      vi.resetModules();
    }
  });
});

describe("WI-606293: release-fixer provider-capacity preflight", () => {
  // A wall that resets ~24h from NOW, minute-aligned so the ISO form below is stable within a
  // run. This was a fixed calendar timestamp (2026-09-03T16:24Z) and time-bombed the file: the
  // "OUTLASTS the stall window" falsifier below went red the moment the wall clock passed it,
  // reading a "wall reset an hour ago" as "wall reset in ~24h". A test about relative time
  // must anchor to the clock it runs under.
  const RESET_AT =
    Math.floor(Date.now() / 60_000) * 60_000 + 24 * 60 * 60 * 1_000;
  const RESET_AT_ISO = new Date(RESET_AT).toISOString();

  /** A queue that routes to decision.kind === "dispatch-fixer" (reason "unassigned"). */
  const unassignedQueue = (
    frozen: string,
    ready: string,
  ): FrozenCandidateRepairQueue => ({
    schemaVersion: 3,
    phase: "awaiting-fixer",
    candidate: frozen,
    base: ready,
    repairHead: frozen,
    attempts: 1,
    openedAtMs: Date.now() - 1_000,
    updatedAtMs: Date.now() - 500,
    fixerSpawnId: null,
    failingTests: ["lib/broken.test.ts"],
    signature: [],
  });

  /**
   * Drive a red against a pre-existing unassigned queue and report whether the fixer
   * actually launched. `capacity` is the preflight stub under test.
   */
  async function runWithCapacity(
    capacity: NonNullable<
      Parameters<typeof runGreenCheckpoint>[1]["checkFixerProviderCapacity"]
    >,
  ) {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    let queue: FrozenCandidateRepairQueue | null = unassignedQueue(
      frozen,
      ready,
    );
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    let dispatched = 0;
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      dispatched += 1;
      return { spawnId: "fixer", runId: "run" };
    };
    deps.checkFixerProviderCapacity = capacity;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    return { result, dispatched, queue };
  }

  // INSTRUMENT CHECK for the withhold assertions below. If this ever stops dispatching,
  // the branch is no longer reached and a `dispatched === 0` elsewhere would pass for the
  // wrong reason — the whole suite would go quietly vacuous.
  it("dispatches normally when the pool still has headroom", async () => {
    const { dispatched } = await runWithCapacity(async () => ({
      ok: true,
      summary: "3/5 codex account(s) have usage headroom",
    }));
    expect(dispatched).toBe(1);
  });

  it("withholds the dispatch when every account is usage-walled, spending no attempt", async () => {
    const { result, dispatched, queue } = await runWithCapacity(async () => ({
      ok: false,
      summary: "all 5 codex account(s) are usage-walled",
      retryAtMs: RESET_AT,
    }));

    expect(dispatched).toBe(0);
    // Refused BEFORE worktree preparation, so a walled pool costs no setup either.
    // A walled provider says nothing about the candidate: it must stay inconclusive
    // (green: null) so it cannot inflate the red streak.
    expect(result).toMatchObject({
      advanced: false,
      green: null,
      reason: "repair-in-progress",
    });
    expect(result.summary).toContain("WITHHELD");
    expect(result.summary).toContain("usage-walled");
    expect(result.summary).toContain(RESET_AT_ISO);
    // The attempt budget is the scarce resource this whole preflight protects.
    expect(queue?.attempts).toBe(1);
  });

  it("D-005: BLOCKS (dispatch-infeasible) a stalled zero-attempt queue on a short wall — escalates once, never falls through to the staging tip", async () => {
    // This branch used to RETIRE the queue and `revParse(integrationBranch)` — the one place
    // the resolver read the moving tip while a queue row existed, and the branch that fired
    // 20 times in one day with 0 resumes (2026-09-02). `movingTip` exists precisely so a
    // regression here has somewhere to go: the result must never name it.
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "current staging tip");
    const roundAtMs = Date.now() - 15 * 60 * 1_000;
    let queue: FrozenCandidateRepairQueue | null = {
      ...unassignedQueue(frozen, ready),
      attempts: 0,
      openedAtMs: Date.now() - 16 * 60 * 1_000,
      updatedAtMs: Date.now() - 15 * 60 * 1_000,
      convergenceRounds: [{ round: 1, head: frozen, failingCount: 1, atMs: roundAtMs }],
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
      calls.push(next === null ? "write:null" : `write:${next.phase}`);
    };
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("dispatch-infeasible queue must not launch a fixer");
    };
    const dispositions: Parameters<
      NonNullable<
        Parameters<typeof runGreenCheckpoint>[1]["recordFreezeDisposition"]
      >
    >[0][] = [];
    deps.recordFreezeDisposition = async (d) => {
      dispositions.push(d);
    };
    const retryAtMs = Date.now() + 1_000;
    deps.checkFixerProviderCapacity = async () => ({
      ok: false,
      summary: "all codex accounts are usage-walled",
      // A SHORT wall past the stall window: waiting would buy nothing, and under D-005 the
      // answer to "waiting buys nothing" is a BLOCK for admission, never a re-cut.
      retryAtMs,
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(calls).not.toContain("runGreen");
    expect(calls).not.toContain("write:null");
    expect(queue).toMatchObject({
      phase: "blocked",
      blockedReason: "dispatch-infeasible",
      candidate: frozen,
      repairHead: frozen,
      attempts: 0,
    });
    expect(result).toMatchObject({
      advanced: false,
      candidate: frozen,
      green: null,
      reason: "repair-in-progress",
    });
    expect(result.candidate).not.toBe(movingTip);
    expect(dispositions[0]?.repairProgress?.rounds).toEqual([
      { round: 1, head: frozen, atMs: roundAtMs },
    ]);
    expect(result.summary).toContain("held");
    expect(result.summary).toContain("op: 'admit'");
    expect(calls.filter((c) => c === "escalate")).toHaveLength(1);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      enabled: true,
      state: "held",
      candidate: frozen,
      capacityRetryAtMs: retryAtMs,
    });

    // The resumed tick re-reads the blocked row: same hold, no second page, still no suite.
    const resumed = await runGreenCheckpoint(cfg(), deps, { noPush: true });
    expect(calls.filter((c) => c === "escalate")).toHaveLength(1);
    expect(calls).not.toContain("runGreen");
    expect(resumed).toMatchObject({
      advanced: false,
      candidate: frozen,
      repairQueue: { phase: "blocked", blockedReason: "dispatch-infeasible" },
    });
  });

  it("WI-2141736 Layer 2: holds a FRESH unassigned zero-attempt queue instead of retiring on the first wall", async () => {
    // Falsifiability control for "retires an unassigned zero-attempt queue" above: the ONLY
    // difference is the queue's age (1 minute old here vs 16 minutes there, straddling the
    // FROZEN_REPAIR_ZERO_ATTEMPT_STALL_MS=15min gate) — a fresh queue must be held, not retired,
    // on its very first measured capacity wall.
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    let queue: FrozenCandidateRepairQueue | null = {
      ...unassignedQueue(frozen, ready),
      attempts: 0,
      openedAtMs: Date.now() - 60_000,
      updatedAtMs: Date.now() - 30_000,
    };
    const { deps } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error(
        "dispatch-infeasible-but-not-stalled queue must not launch a fixer",
      );
    };
    let routedCount = 0;
    deps.routeFrozenRepairToAgents = async () => {
      routedCount += 1;
    };
    deps.checkFixerProviderCapacity = async () => ({
      ok: false,
      summary: "all codex accounts are usage-walled",
      retryAtMs: RESET_AT,
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // The frozen candidate survives untouched: no worktree cleanup, no queue abandonment.
    // P-003 negative control: this hold resolves inside the 15-minute stall window, so no
    // work-item is minted. Routing ordinary pool churn to the fleet is how a useful alarm
    // becomes noise nobody claims.
    expect(routedCount).toBe(0);
    expect(queue).toMatchObject({ candidate: frozen, attempts: 0 });
    expect(result).toMatchObject({
      advanced: false,
      candidate: frozen,
      green: null,
      reason: "repair-in-progress",
    });
    expect(result.summary).toContain("not yet stalled");
  });

  it("WI-2141736 P-002: HOLDS a STALLED zero-attempt queue when the measured wall OUTLASTS the stall window", async () => {
    // The falsifier this whole plan exists for. It is the EXACT twin of "retires an
    // unassigned zero-attempt queue" above — same 16-minute-old queue, same moved staging
    // tip, same everything — except the wall's own reset time: seconds away there, ~24h away
    // here. Retiring is only correct when waiting could not help; a wall that outlasts the
    // stall window makes retiring a treadmill, because the re-cut queue meets the same wall.
    // Measured cost of the missing distinction: a six-day codex wall produced 20 retirements
    // and 0 resumes in one day, with freeze-and-converge silently off fleet-wide.
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    // Moving the integration branch matters: retiring would follow this tip, so asserting we
    // stay on `frozen` proves the hold rather than merely a no-op run.
    await commit("c", "3", "current staging tip");
    let queue: FrozenCandidateRepairQueue | null = {
      ...unassignedQueue(frozen, ready),
      attempts: 0,
      openedAtMs: Date.now() - 16 * 60 * 1_000,
      updatedAtMs: Date.now() - 15 * 60 * 1_000,
    };
    const { deps } = stubDeps(true);
    const routed: Parameters<
      NonNullable<
        Parameters<typeof runGreenCheckpoint>[1]["routeFrozenRepairToAgents"]
      >
    >[0][] = [];
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("a capacity-held queue must not launch a fixer");
    };
    deps.routeFrozenRepairToAgents = async (input) => {
      routed.push(input);
    };
    const dispositions: Parameters<
      NonNullable<
        Parameters<typeof runGreenCheckpoint>[1]["recordFreezeDisposition"]
      >
    >[0][] = [];
    deps.recordFreezeDisposition = async (d) => {
      dispositions.push(d);
    };
    deps.checkFixerProviderCapacity = async () => ({
      ok: false,
      summary: "all codex accounts are usage-walled",
      retryAtMs: RESET_AT,
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    // SURVIVES the run: no worktree cleanup, no abandonment, still pinned to the candidate
    // agents are converging on.
    // P-003: holding is only worth something if the repair reaches somebody. With no fixer
    // dispatchable, agents ARE the repair path, so the hold must route — naming the frozen
    // candidate (not tip) and the failing set to converge onto it.
    expect(routed).toHaveLength(1);
    expect(routed[0]).toMatchObject({
      candidate: frozen,
      repairHead: frozen,
      failingTests: ["lib/broken.test.ts"],
    });
    expect(queue).toMatchObject({ candidate: frozen, attempts: 0 });
    expect(result).toMatchObject({
      advanced: false,
      candidate: frozen,
      green: null,
      reason: "repair-in-progress",
    });
    // P-004: the REASON is on the returned summary, not only in the run log — a caller
    // reading the verdict can see why the candidate is held without log archaeology.
    expect(result.summary).toContain("Held for convergence");
    expect(result.summary).not.toContain("not yet stalled");
    // P-004: the hold is recorded as queryable STATE, with the deadline a reader would
    // otherwise have to reconstruct from a constant plus the queue's openedAtMs.
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      enabled: true,
      state: "held",
      candidate: frozen,
      capacityRetryAtMs: RESET_AT,
    });
    expect(dispositions[0]?.holdUntilMs).toBeGreaterThan(Date.now());
  });

  it("WI-2141736 P-002 / D-005: once the convergence hold elapses the queue BLOCKS (dispatch-infeasible) — the inconclusive wait ends, the freeze does not", async () => {
    // The other half of the falsifier: the inconclusive "held for convergence" state is
    // bounded by FROZEN_REPAIR_CONVERGENCE_HOLD_MS. Past it this used to retire and re-cut
    // at `movingTip`; under D-005 the bound moves the queue to a BLOCKED hold that only an
    // admission (or an owner retire) can move — the candidate itself stays frozen.
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const movingTip = await commit("c", "3", "current staging tip");
    const heldTooLongMs = FROZEN_REPAIR_CONVERGENCE_HOLD_MS + 60_000;
    let queue: FrozenCandidateRepairQueue | null = {
      ...unassignedQueue(frozen, ready),
      attempts: 0,
      openedAtMs: Date.now() - heldTooLongMs,
      updatedAtMs: Date.now() - heldTooLongMs,
    };
    const { deps, calls } = stubDeps(true);
    deps.readFrozenRepairQueue = async () => queue;
    deps.writeFrozenRepairQueue = async (next) => {
      queue = next;
    };
    deps.dispatchFrozenRepairFixer = async () => {
      throw new Error("a hold-expired queue must not launch a fixer");
    };
    const dispositions: Parameters<
      NonNullable<
        Parameters<typeof runGreenCheckpoint>[1]["recordFreezeDisposition"]
      >
    >[0][] = [];
    deps.recordFreezeDisposition = async (d) => {
      dispositions.push(d);
    };
    deps.checkFixerProviderCapacity = async () => ({
      ok: false,
      summary: "all codex accounts are usage-walled",
      retryAtMs: RESET_AT,
    });

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(calls).not.toContain("runGreen");
    expect(queue).toMatchObject({
      phase: "blocked",
      blockedReason: "dispatch-infeasible",
      candidate: frozen,
      repairHead: frozen,
    });
    expect(calls.filter((c) => c === "escalate")).toHaveLength(1);
    expect(dispositions).toHaveLength(1);
    expect(dispositions[0]).toMatchObject({
      enabled: true,
      state: "held",
      candidate: frozen,
      capacityRetryAtMs: RESET_AT,
    });
    expect(dispositions[0]?.reason).toContain(
      "provider-capacity infeasibility",
    );
    expect(result).toMatchObject({
      advanced: false,
      candidate: frozen,
      green: null,
      reason: "repair-in-progress",
    });
    expect(result.candidate).not.toBe(movingTip);
  });

  it("dispatches rather than freezing when the capacity probe itself throws", async () => {
    // Fail OPEN, unlike disk-headroom: an unmeasurable pool must never become a silent,
    // permanent freeze of the repair arm. Guessing wrong here costs one attempt.
    const { dispatched } = await runWithCapacity(async () => {
      throw new Error("pool read failed");
    });
    expect(dispatched).toBe(1);
  });

  it("summary names the wall, the retry time, and that nothing was spent", () => {
    const line = frozenRepairCapacityHoldSummary("abcdef1234567890", {
      summary: "all 5 codex account(s) are usage-walled",
      retryAtMs: RESET_AT,
    });
    expect(line).toContain("WITHHELD for abcdef12");
    expect(line).toContain("usage-walled");
    expect(line).toContain(RESET_AT_ISO);
    expect(line).toContain(
      "No repair attempt and no dispatch reservation were spent",
    );
  });

  it("omits a retry clause rather than inventing one when no window reset is known", () => {
    const line = frozenRepairCapacityHoldSummary("abcdef1234567890", {
      summary: "all 5 codex account(s) are usage-walled",
      retryAtMs: null,
    });
    expect(line).not.toContain("Retry after");
    expect(line).toContain("usage-walled");
  });
});

// green-main-cycle-time-2026-10-08 P-021 / D-023: a frozen queue's life is bounded. A queue that
// made no new failing-count low in 4 rounds, or is older than 24h, is retired (once per install
// per 24h) and the same pass re-cuts at the newest known-good commit or the staging tip, with the
// queue's admitted fixes carried and recorded.
describe("P-021: bounded frozen-queue life — retire, re-cut and carry", () => {
  const HOUR = 60 * 60 * 1_000;

  async function frozenLineage() {
    const ready = await commit("a", "1", "ready");
    await git(repo, ["branch", "ready", ready]);
    const frozen = await commit("b", "2", "frozen candidate");
    const knownGood = await commit("c", "3", "known-good point, before the fix");
    const tip = await commit("lib/fix.ts", "fixed", "the admitted fix");
    const fixBlob = (await git(repo, ["rev-parse", `${tip}:lib/fix.ts`])).trim();
    return { ready, frozen, knownGood, tip, fixBlob };
  }

  function queueWith(input: {
    frozen: string;
    ready: string;
    tip: string;
    fixBlob: string;
    failingCounts: number[];
    ageMs: number;
  }): FrozenCandidateRepairQueue {
    const now = Date.now();
    return {
      schemaVersion: 3,
      phase: "awaiting-fixer",
      candidate: input.frozen,
      base: input.ready,
      repairHead: input.frozen,
      attempts: 1,
      openedAtMs: now - input.ageMs,
      updatedAtMs: now - 1_000,
      fixerSpawnId: null,
      failingTests: ["lib/broken.test.ts"],
      signature: [],
      convergenceRounds: input.failingCounts.map((failingCount, index) => ({
        round: index + 1,
        head: input.frozen,
        failingCount,
        atMs: now - input.ageMs + index * 1_000,
      })),
      admissions: [
        {
          atMs: now - 2_000,
          actor: "su-test",
          source: { ref: "staging", sha: input.tip },
          fromRepairHead: input.frozen,
          toRepairHead: input.frozen,
          paths: ["lib/fix.ts"],
          unchanged: [],
          blobs: { "lib/fix.ts": input.fixBlob },
        },
      ],
    };
  }

  function boundedLifeDeps(queue: FrozenCandidateRepairQueue, state: FrozenRepairBoundedLifeState | null) {
    const { deps } = stubDeps(true);
    const retired: FrozenRepairBoundedLifeRecord[] = [];
    const escalations: string[] = [];
    deps.readFrozenRepairQueueState = async () => ({ status: "value", queue });
    deps.readFrozenRepairBoundedLifeState = async () => state;
    deps.retireFrozenRepairQueueForBoundedLife = vi.fn(async (_queue, record) => {
      retired.push(record);
      return { retired: true };
    });
    deps.recordFrozenRepairBoundedLifeEscalation = vi.fn(async () => undefined);
    deps.escalate = vi.fn(async (summary: string) => {
      escalations.push(summary);
    });
    deps.dispatchFrozenRepairFixer = async () => ({ spawnId: "fixer", runId: "run" });
    return { deps, retired, escalations };
  }

  it("retires a non-improving queue and re-cuts at the staging tip carrying the admitted fix", async () => {
    const lineage = await frozenLineage();
    // 3 -> 5 -> 8 -> 12 -> 28: four rounds since the low of 3 (the ad82b273 shape).
    const queue = queueWith({ ...lineage, failingCounts: [3, 5, 8, 12, 28], ageMs: 5 * HOUR });
    const { deps, retired, escalations } = boundedLifeDeps(queue, null);

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({
      trigger: "non-improving",
      roundsSinceLow: 4,
      lowestFailingCount: 3,
      latestFailingCount: 28,
      candidate: lineage.frozen,
      recutTarget: lineage.tip,
      recutTargetSource: "staging-tip",
      carriedPaths: [{ path: "lib/fix.ts", status: "contained" }],
      readmitPaths: [],
    });
    // The re-cut: this same pass judged the tip, not the frozen candidate.
    expect(result.candidate).toBe(lineage.tip);
    expect(result.green).toBe(true);
    expect(escalations.some((line) => line.includes("retired by the bounded-life rule (non-improving)"))).toBe(true);
  });

  it("retires an over-24h queue that is still improving, re-cutting at a known-good point and listing the fix to re-admit", async () => {
    const lineage = await frozenLineage();
    const queue = queueWith({ ...lineage, failingCounts: [10, 8, 6], ageMs: 25 * HOUR });
    const { deps, retired } = boundedLifeDeps(queue, null);
    deps.resolveKnownGoodRecutTarget = async () => lineage.knownGood;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({
      trigger: "age",
      roundsSinceLow: 0,
      recutTarget: lineage.knownGood,
      recutTargetSource: "known-good",
      // The known-good point predates the fix, so the carry names it for re-admission.
      carriedPaths: [{ path: "lib/fix.ts", status: "absent-at-target" }],
      readmitPaths: ["lib/fix.ts"],
    });
    expect(result.candidate).toBe(lineage.knownGood);
  });

  it("never retires while the failing count still makes new lows inside 24h", async () => {
    const lineage = await frozenLineage();
    const queue = queueWith({ ...lineage, failingCounts: [10, 8, 9, 9, 6], ageMs: 23 * HOUR });
    const { deps, retired } = boundedLifeDeps(queue, null);

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(deps.retireFrozenRepairQueueForBoundedLife).not.toHaveBeenCalled();
    expect(retired).toHaveLength(0);
    expect(result.candidate).not.toBe(lineage.tip);
  });

  it("keeps the frozen queue when the locked retire refuses (live fixer) — no re-cut", async () => {
    const lineage = await frozenLineage();
    const queue = queueWith({ ...lineage, failingCounts: [3, 5, 8, 12, 28], ageMs: 5 * HOUR });
    const { deps } = boundedLifeDeps(queue, null);
    deps.retireFrozenRepairQueueForBoundedLife = vi.fn(async () => ({ retired: false, refusal: "live-fixer" }));

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(deps.retireFrozenRepairQueueForBoundedLife).toHaveBeenCalledTimes(1);
    expect(result.candidate).not.toBe(lineage.tip);
  });

  it("escalates instead of retiring a second time inside the 24h window, once per candidate", async () => {
    const lineage = await frozenLineage();
    const queue = queueWith({ ...lineage, failingCounts: [3, 5, 8, 12, 28], ageMs: 5 * HOUR });
    const lastRetireAtMs = Date.now() - 2 * HOUR;
    const lastRetire = {
      schemaVersion: 1,
      trigger: "age",
      retiredAtMs: lastRetireAtMs,
      candidate: "0".repeat(40),
      repairHead: "0".repeat(40),
      openedAtMs: lastRetireAtMs - 30 * HOUR,
      ageMs: 30 * HOUR,
      roundsRecorded: 2,
      roundsSinceLow: 0,
      lowestFailingCount: 1,
      latestFailingCount: 1,
      recutTarget: lineage.frozen,
      recutTargetSource: "staging-tip",
      carriedPaths: [],
      readmitPaths: [],
      carryTruncated: false,
    } satisfies FrozenRepairBoundedLifeRecord;
    const state: FrozenRepairBoundedLifeState = {
      schemaVersion: 1,
      lastRetire,
      lastRateLimitedEscalation: null,
      history: [lastRetire],
    };
    const first = boundedLifeDeps(queue, state);

    await runGreenCheckpoint(cfg(), first.deps, { noPush: true });

    expect(first.deps.retireFrozenRepairQueueForBoundedLife).not.toHaveBeenCalled();
    expect(first.escalations.filter((line) => line.includes("bounded-life non-improving bound"))).toHaveLength(1);
    expect(first.deps.recordFrozenRepairBoundedLifeEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: lineage.frozen, lastRetireAtMs }),
    );

    const second = boundedLifeDeps(queue, {
      ...state,
      lastRateLimitedEscalation: {
        candidate: lineage.frozen,
        trigger: "non-improving",
        atMs: Date.now() - 1_000,
        lastRetireAtMs,
      },
    });
    await runGreenCheckpoint(cfg(), second.deps, { noPush: true });
    expect(second.deps.retireFrozenRepairQueueForBoundedLife).not.toHaveBeenCalled();
    expect(second.escalations.filter((line) => line.includes("bounded-life"))).toHaveLength(0);
  });
});

// green-main-cycle-time-2026-10-08 P-012: a fresh cut (no frozen queue) judges the newest staging
// commit the per-sync batch check passed, when that commit is on the tip's lineage and strictly
// ahead of the green pin. Every fresh candidate's verdict records where it came from (freezeCut)
// and which legs were red in its first round (redLegsAtR1).
describe("P-012: fresh cut from the newest known-good point", () => {
  async function knownGoodLineage() {
    const ready = await commit("a", "1", "green pin");
    await git(repo, ["branch", "ready", ready]);
    const knownGood = await commit("b", "2", "per-sync check passed here");
    const tip = await commit("c", "3", "unjudged by the per-sync check");
    return { ready, knownGood, tip };
  }

  it("judges the known-good commit instead of the bare tip and records the cut on the verdict", async () => {
    const lineage = await knownGoodLineage();
    const { deps } = stubDeps(true);
    deps.resolveKnownGoodRecutTarget = async () => lineage.knownGood;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.candidate).toBe(lineage.knownGood);
    expect(result.freezeCut).toEqual({
      source: "known-good",
      reason: "known-good-selected",
      candidate: lineage.knownGood,
      tip: lineage.tip,
      knownGood: lineage.knownGood,
    });
    expect(result.redLegsAtR1).toEqual({ candidate: lineage.knownGood, source: "known-good", legs: [] });
  });

  it("falls back to the tip when the known-good commit is the green pin (never re-judges main)", async () => {
    const lineage = await knownGoodLineage();
    const { deps } = stubDeps(true);
    deps.resolveKnownGoodRecutTarget = async () => lineage.ready;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.candidate).toBe(lineage.tip);
    expect(result.freezeCut).toMatchObject({
      source: "staging-tip",
      reason: "known-good-not-ahead-of-green",
      candidate: lineage.tip,
      knownGood: lineage.ready,
    });
  });

  it("judges the tip with the reason recorded when the known-good reader throws", async () => {
    const lineage = await knownGoodLineage();
    const { deps } = stubDeps(true);
    deps.resolveKnownGoodRecutTarget = async () => {
      throw new Error("routines row unreadable");
    };

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.candidate).toBe(lineage.tip);
    expect(result.freezeCut).toMatchObject({ source: "staging-tip", reason: "known-good-unreadable" });
  });

  it("records the red legs of a known-good candidate's first round", async () => {
    const lineage = await knownGoodLineage();
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    const suite = deps.runGreen;
    // The real runner maps each failing file to its workspace (`failingFiles`); that is what
    // makes the suite leg red rather than unattributed.
    deps.runGreen = async (...args) => ({
      ...(await suite(...args)),
      failingFiles: [{ workspace: "@papercusp/operator", file: "lib/broken.test.ts" }],
    });
    deps.resolveKnownGoodRecutTarget = async () => lineage.knownGood;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.green).toBe(false);
    expect(result.redLegsAtR1).toEqual({ candidate: lineage.knownGood, source: "known-good", legs: ["suite"] });
  });

  it("a red round that names no failing file and no failed leg is recorded as unattributed", async () => {
    const lineage = await knownGoodLineage();
    const { deps } = stubDeps(false, ["lib/broken.test.ts"]);
    deps.resolveKnownGoodRecutTarget = async () => lineage.knownGood;

    const result = await runGreenCheckpoint(cfg(), deps, { noPush: true });

    expect(result.redLegsAtR1?.legs).toEqual(["unattributed"]);
  });
});
