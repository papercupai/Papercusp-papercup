/**
 * The portable, replay-grade **benchmark report bundle** — ONE self-contained JSON per run,
 * rendered by the dependency-free viewer (`report-viewer.html`). Plan:
 * benchmark-report-portable-trace-2026-06-17.
 *
 * GOALS (owner-directed):
 *  1. EVERY benchmark run produces one (SWE-bench Pro/Verified, su-vs-queen, TheAgentCompany,
 *     PaperBench, AgentsNet, τ²-bench, GAIA, METR HCAST, …) — a SHARED core + a per-suite
 *     `suiteData` extension.
 *  2. A portable way to view it: a single self-contained HTML page using ONLY native
 *     JS/HTML/CSS (no React/D3/charting libs) — `report-builder.ts` injects this bundle as
 *     `window.__BENCH_REPORT__` into `report-viewer.html` → a double-clickable `report-<runId>.html`.
 *  3. SUBSTANTIVE ENOUGH TO THEORETICALLY REPLAY THE RUN: every config, exact model/harness
 *     version + git sha, env fingerprint, coordination message, spawn, agent tool-call
 *     (args+result), prompt/trajectory pointer, and grade. We do NOT build replay — we just
 *     carry enough that a third party COULD. Data sources already exist:
 *       - RolloutRecord / PreregRecord (reproducibility/schema.ts) — config snapshot, versions,
 *         env fingerprint, verbatim grader output, the graded submission, the trajectory pointer.
 *       - TaskRunResult (@papercusp/bench-metrics) — the scoreable per-(task×arm×seed) row.
 *       - coord events (the coordination trace) + the spawned_agents nursery (the spawn tree).
 *       - the defineTool call-log (full agent-call audit — landing as every agent call routes
 *         through defineTool; the `callLog` field is its projection into the bundle).
 *
 * Every field here is a PROJECTION of data the system already records — the builder maps, it does
 * not invent. Optional fields degrade gracefully in the viewer (a missing section just hides).
 */

import type { ArmContamination } from '../contamination';
import type { AttemptOutcomeCounts } from '@papercusp/bench-metrics';

/** A monotonic schema version so an old viewer can refuse / a new viewer can branch. */
export const BENCH_REPORT_SCHEMA_VERSION = 1;

/** One graded, costed, replay-grade per-(task × arm × seed) row — the RolloutRecord projection. */
export interface BenchReportRollout {
  rolloutId: string;
  taskId: string;
  arm: string;
  seed: number;
  // ── outcome ──
  resolved: boolean | null;
  /** Partial-credit / continuous score in [0,1] for rubric/checkpoint suites (TAC, PaperBench, AgentsNet). */
  score?: number | null;
  graderStatus: string;
  stopReason: string;
  /** Generation failure detail; the failed assignment remains in primary outcome. */
  generationError?: string | null;
  // ── cost / timing (coordination overhead INCLUDED — fairness #2) ──
  /** Null when accounting is incomplete; the retained subtotal is separate. */
  costUsd: number | null;
  costKnownSubtotalUsd?: number | null;
  costUsdMeasurementMissing?: boolean;
  costBasis?: string;
  /** Persisted execution/accounting evidence, including native lifetime timing. */
  armMeta?: Record<string, unknown> | null;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  wallMs: number;
  turns?: number;
  // ── replay fingerprint ──
  modelId: string;
  modelVersion?: string | null;
  harnessVersion: string;
  harnessGitSha?: string | null;
  /** Resolved per-run config incl. arm settings + model params. */
  configSnapshot?: Record<string, unknown> | null;
  /** os / node / docker image digests / grader image digest. */
  envFingerprint?: Record<string, unknown> | null;
  // ── the graded artifacts (verbatim) ──
  /** The exact submission graded — M1: the unified diff; M2: the env handle ref; suites: the answer/submission. */
  submission?: string | null;
  /** The benchmark's own grader output, VERBATIM. */
  rawGraderOutput?: string | null;
  failToPass?: Array<{ test: string; passed: boolean }> | null;
  passToPass?: Array<{ test: string; passed: boolean }> | null;
  /** Pointer to the full trajectory record (the replay artifact) + its kind. */
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
}

/** One coordination event (the inter-agent trace) — projected from coord events. */
export interface BenchReportCoordEvent {
  ts: string;
  /** message | handoff | spawn | claim | escalation | finding | … */
  kind: string;
  from?: string;
  to?: string[];
  summary?: string;
  body?: string;
  /** The task/feature this event pertained to, if any. */
  taskId?: string;
}

/** One node in the agent spawn tree — projected from the spawned_agents nursery. */
export interface BenchReportSpawnNode {
  spawnId: string;
  parentSpawnId?: string | null;
  role: string;
  harness?: string | null;
  taskId?: string;
  model?: string;
  status?: string;
  costUsd?: number;
  startedAt?: string;
  endedAt?: string;
}

/**
 * One agent tool-call — the replay-grade audit unit, projected from the defineTool call-log
 * (every agent call routing through defineTool). This is what makes a theoretical replay possible:
 * the exact tool, its inputs, its outputs, and the model/cost of the turn that issued it.
 */
export interface BenchReportCall {
  ts: string;
  /** Which spawned agent issued it (links to the spawn tree). */
  spawnId?: string;
  role?: string;
  /** The defineTool name, e.g. 'capability:edit', 'cup:spawn', 'coord:send'. */
  tool: string;
  args?: unknown;
  result?: unknown;
  ok?: boolean;
  durationMs?: number;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

/** Per-arm rollup (the headline comparison row). */
export interface BenchReportArmSummary {
  arm: string;
  /** Resolved and measured submission counts; these describe secondary quality. */
  resolved?: number;
  scored?: number;
  /** Secondary partial-credit score among officially measured submissions. */
  meanScore?: number | null;
  assignedTasks?: number;
  assignedAttempts?: number;
  attempts?: number;
  absentAttempts?: number;
  missingMeasurements?: number;
  /** Four-way outcome disclosure over observed attempts (plan benchmark-coverage-frontierswe-v2-2026-10-10
   *  D-008): invalid + graderError are the missing measurements, broken out so tampering is never hidden
   *  inside a generic grader-fault count. */
  outcomes?: AttemptOutcomeCounts;
  measurementComplete?: boolean;
  /** Task-weighted mean over assigned seeds, including failures and absent attempts. */
  primaryResolvedPct?: number | null;
  primaryMeanScore?: number | null;
  conditionalResolvedPct?: number | null;
  /** Observed rosters cannot establish that assignments were never attempted. */
  assignmentSource?: 'frozen' | 'observed';
  /** Attempts without a usable official measurement, including generation failure. */
  infraExcluded?: number;
  costUsd: number | null;
  costKnownSubtotalUsd?: number | null;
  costUsdMeasurementMissing?: boolean;
  costBasis?: string;
  tokensTotal: number;
  /** Complete spend divided by the frozen assigned task count, including all seeds. */
  costPerAssignedTaskUsd?: number | null;
  concurrency?: { avg: number; peak: number };
  /**
   * Freshness / contamination verdict for this arm's headline (P-009): its model's training-data cutoff vs
   * each assigned task's creation date, the label, and the post-cutoff / exposed / unknown subsets with
   * their own primary outcome. A headline claim should prefer `contamination.postCutoff`.
   */
  contamination?: ArmContamination;
  /** Suite-specific headline (e.g. METR: { horizon50Min, horizon50Ci }). */
  extra?: Record<string, unknown>;
}

/** Descriptive comparisons from the existing frozen outcome and cost projections. */
export interface BenchReportCostComparison {
  metric: 'assigned-mean-score' | 'assigned-resolved-rate';
  points: Array<{
    arm: string;
    value: number | null;
    costPerTaskUsd: number | null;
    /** Null when the accounting, grade or frozen assignment is unavailable. */
    onFrontier: boolean | null;
    excludedReasons: string[];
  }>;
  taskWinners: Array<{
    taskId: string;
    value: number | null;
    /** Missing grades make winner selection inconclusive across the entire matched task. */
    incompleteArms: string[];
    winners: Array<{ arm: string; costUsd: number | null; costBasis: string; tokensTotal: number }>;
  }>;
}

/** The full bundle — one per run. SHARED core + per-suite `suiteData`. */
export interface BenchReportBundle {
  schemaVersion: number;
  generatedAt: string;
  // ── run header (shared) ──
  run: {
    runId: string;
    suite: string;
    label?: string;
    createdAt: string;
    arms: string[];
    /** arm/role → exact model id, as resolved from the run's pinned model-registry snapshot. */
    models: Record<string, string>;
    prereg?: { hash: string; config?: Record<string, unknown>; gitCommitSha?: string | null };
    harnessGitSha?: string | null;
    envFingerprint?: Record<string, unknown> | null;
    totals: { tasks: number; costUsd: number | null; costKnownSubtotalUsd?: number | null;
      costUsdMeasurementMissing?: boolean; costBasis?: string; tokensIn: number; tokensOut: number; wallMs: number };
  };
  // ── shared sections (each optional → the viewer hides an absent one) ──
  arms: BenchReportArmSummary[];
  rollouts: BenchReportRollout[];
  /** Absent in historical exports; no historical frontier is inferred by the viewer. */
  costComparison?: BenchReportCostComparison;
  coordTrace?: BenchReportCoordEvent[];
  spawnTree?: BenchReportSpawnNode[];
  callLog?: BenchReportCall[];
  /** Per-arm concurrency-over-time samples (su-vs-queen actual-concurrency), if captured. */
  concurrencyTimeline?: Record<string, Array<{ tMs: number; live: number }>>;
  // ── per-suite extension ──
  /** The suite id (== run.suite) — the viewer keys its per-suite renderer on this. */
  suite: string;
  /**
   * Benchmark-specific data the shared sections don't cover, rendered by a small per-suite block in
   * the viewer. Examples: AgentsNet { graph, perNodeMessages, perTaskScore }; PaperBench { rubricTree,
   * replicationScoreBreakdown }; TheAgentCompany { checkpoints, npcConversations, serviceState };
   * METR { horizonFit, taskTimeVsSuccess }; SWE-bench needs none (covered by rollout failToPass).
   */
  suiteData?: Record<string, unknown>;
}
